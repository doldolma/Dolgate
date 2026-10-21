import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import {
  base64ToBytes,
  deriveTeamReplayKey,
  sealTeamReplayBytes,
  sealTeamReplayJson,
  TEAM_HISTORY_FORMAT_VERSION,
  type SessionReplaySegment,
} from "@shared";
import type { ReplayCommandBlock, ReplaySnapshot } from "../common/replay/replay-command-scan";
import type { ReplayScanHost, ReplayScanSession } from "./replay-scan-host";
import {
  decodeReplaySegment,
  loadReplaySegments,
  readReplaySegment,
  type ReplaySegmentRecord,
} from "./session-replay-events";
import { isTeamApiError, type TeamApi } from "./team-api";
import type { TeamAccess, TeamHistoryLimits } from "./team-history-service";

/*
 * 팀 녹화 실시간 올리기.
 *
 * 팀 호스트 세션의 로컬 녹화는 구간을 짧게(5초 또는 압축 전 512KB) 끊는다. 구간이 끝날 때마다 그 gzip 덩어리를
 * 바이트 그대로 녹화 열쇠로 잠가 보낸다 — 서버의 구간을 차례로 풀어 이어 붙이면 로컬 녹화 파일과 바이트까지 같다.
 *
 * - 보낼 것은 로컬 녹화 파일 자체다. 녹화마다 "몇 번 구간까지 보냈는지"만 상태 파일에 적는다. 이번 실행에서 막 끝난
 *   구간은 메모리에 든 바이트를 쓰고(파일에 다 쓰이기 전일 수 있다), 다시 켠 뒤에는 파일에서 읽는다.
 * - 녹화마다 차례대로(시작 → 구간들 → 끝), 한 번에 요청 하나씩 보낸다 — 세션과 나눠 쓰는 대역폭이 요청 하나 몫이다.
 * - 같은 구간을 훑기에도 먹여(작업 스레드), 그 구간에서 잡힌 명령과 이따금 뜨는 스냅샷을 녹화 덧붙임으로 보낸다.
 *   보는 쪽은 녹화를 다 받지 않고 명령 목록을 보이고 멀리 건너뛴다.
 * - 앱이 죽어 끝을 알리지 못한 녹화는 다음 실행 때 파일에 남은 데까지 마저 보내고 "끊김"으로 끝낸다.
 * - 다 보내기 전에는 그 녹화를 보존 한도로 지우지 않는다(isPending).
 */

/** 팀 호스트 녹화의 구간 크기(압축 전). 압축이 안 되는 출력이어도 서버·앞단 프록시의 본문 한도(1MB) 아래다. */
export const TEAM_REPLAY_SEGMENT_BYTES = 512 * 1024;
/** 팀 호스트 녹화의 구간 길이. 이만큼 지나면(그사이 출력이 있었으면) 구간을 끊어 보낸다. */
export const TEAM_REPLAY_SEGMENT_MAX_AGE_MS = 5000;
/** 녹화 하나에 대해 메모리에 들고 있는 보낼 구간의 상한. 넘으면 파일에서 읽는다(오래 오프라인일 때). */
const LIVE_MEMORY_CAP_BYTES = 32 * 1024 * 1024;
const STATE_FILE = "replay-uploads.json";
const STATE_VERSION = 1;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** 팀 녹화 공간이 진행 중인 녹화로 찼을 때 다시 해 보는 간격. */
const QUOTA_RETRY_MS = 60_000;

/** 팀 녹화의 시작 메타(녹화 열쇠로 잠가 올린다). 로컬 메타 파일의 시작 쪽 정보와 같다. */
export interface TeamReplayStartMeta {
  v: number;
  /** 구간 형식 — 로컬 녹화 파일과 같은 gzip 멤버(JSON 줄). */
  format: "jsonl-gzip-v1";
  sessionId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails: string | null;
  connectionKind: string;
  connectedAt: string;
  initialCols: number;
  initialRows: number;
}

/** 팀 녹화의 끝 메타. */
export interface TeamReplayEndMeta {
  v: number;
  disconnectedAt: string;
  durationMs: number;
  lastSegment: number;
  /** 앱이 죽어 끝을 알리지 못했다(다음 실행 때 마저 보냄). */
  cut: boolean;
}

/** 구간 정보 — 재생 창이 구간을 받기 전에 시간축을 그린다. 로컬 색인 한 줄에서 파일 위치를 뺀 것이다. */
export interface TeamReplaySegmentInfo {
  v: number;
  startAtMs: number;
  endAtMs: number;
  entryCount: number;
  outputBytes: number;
}

/** 구간별 명령 목록 — 그 구간에서 새로 생기거나 끝난 명령. 같은 id 의 나중 것이 앞의 것을 대신한다. */
export interface TeamReplayCommandsPiece {
  v: number;
  blocks: ReplayCommandBlock[];
  shellIntegration: boolean;
}

/** 스냅샷 — 그 구간(snapshot.segment)의 첫 항목부터 이어 그릴 화면. gzip 으로 줄여 잠근다. */
export interface TeamReplaySnapshotPiece {
  v: number;
  snapshot: ReplaySnapshot;
}

interface UploadState {
  recordingId: string;
  teamId: string;
  replayDirectoryPath: string;
  startMeta: TeamReplayStartMeta;
  started: boolean;
  /** 서버가 받은 마지막 구간 번호(앞은 빠짐없이). 없으면 -1. */
  sentThrough: number;
  /** 명령 목록·스냅샷을 다 보낸 마지막 구간 번호. 없으면 -1. */
  indexedThrough: number;
  end: TeamReplayEndMeta | null;
  completed: boolean;
  /** 한 개 최대를 넘어 그 뒤로는 보내지 않는다(앞부분만 팀에). */
  truncated: boolean;
  /** 덧붙임이 한 개 최대를 넘어 더 보내지 않는다(구간은 다 갔다). */
  indexingStopped: boolean;
  createdAt: string;
}

interface StateFile {
  version: number;
  recordings: UploadState[];
}

interface LiveRecording {
  segments: Map<number, { record: ReplaySegmentRecord; data: Buffer }>;
  bytes: number;
}

export interface TeamReplayRecordingStart {
  recordingId: string;
  teamId: string;
  replayDirectoryPath: string;
  startMeta: Omit<TeamReplayStartMeta, "v" | "format">;
}

export interface TeamReplayUploadsOptions {
  api: Pick<TeamApi, "startTeamReplay" | "putTeamReplaySegment" | "putTeamReplayExtra" | "completeTeamReplay">;
  /** 서버의 팀 기록·녹화 한도(팀 기록 서비스가 서버마다 기억한다). 모르는 서버면 null. */
  getHistoryLimits(access: TeamAccess): Promise<TeamHistoryLimits | null>;
  openTeamAccess(teamId: string): TeamAccess | null;
  scanHost: ReplayScanHost;
  /** 그 녹화가 이 실행에서 아직 녹화 중인가. 아니고 끝을 모르면 앱이 죽었던 녹화다. */
  isRecordingActive(recordingId: string): boolean;
  /** 녹화가 한 개 최대를 넘어 앞부분만 팀에 남았다 — 팀 기록에 남긴다. */
  onTruncated(state: { recordingId: string; teamId: string; startMeta: TeamReplayStartMeta }): void;
  /** 시험용. */
  setTimer?: (callback: () => void, delayMs: number) => { cancel(): void };
  now?: () => Date;
}

type StepOutcome = "idle" | "retry" | "quota";

function eventsPathOf(state: UploadState): string {
  return path.join(state.replayDirectoryPath, `${state.recordingId}.events.jsonl.gz`);
}

function indexPathOf(state: UploadState): string {
  return path.join(state.replayDirectoryPath, `${state.recordingId}.index.jsonl`);
}

function legacyEventsPathOf(state: UploadState): string {
  return path.join(state.replayDirectoryPath, `${state.recordingId}.events.jsonl`);
}

function readRange(filePath: string, offset: number, length: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, offset + filled);
      if (read === 0) {
        return null;
      }
      filled += read;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

/** 풀어 둔 구간을 같은 형식(JSON 줄의 gzip 멤버)으로 다시 묶는다 — 앱이 죽어 색인에 못 오른 끝부분을 보낼 때. */
export function encodeReplaySegmentMember(segment: SessionReplaySegment): Buffer {
  const lines: string[] = [];
  for (let index = 0; index < segment.atMs.length; index += 1) {
    if (segment.cols[index] > 0) {
      lines.push(JSON.stringify({ type: "resize", atMs: segment.atMs[index], cols: segment.cols[index], rows: segment.rows[index] }));
      continue;
    }
    const start = index === 0 ? 0 : segment.dataEnd[index - 1];
    lines.push(
      JSON.stringify({
        type: "output",
        atMs: segment.atMs[index],
        dataBase64: Buffer.from(segment.data.subarray(start, segment.dataEnd[index])).toString("base64"),
      }),
    );
  }
  return gzipSync(`${lines.join("\n")}\n`, { level: zlibConstants.Z_BEST_SPEED });
}

function defaultTimer(callback: () => void, delayMs: number): { cancel(): void } {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

export class TeamReplayUploads {
  private directoryPath: string | null = null;
  private readonly states = new Map<string, UploadState>();
  private readonly live = new Map<string, LiveRecording>();
  private readonly scans = new Map<string, { session: ReplayScanSession; fedThrough: number }>();
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private timer: { cancel(): void } | null = null;
  private timerDueAt = 0;
  private retryDelayMs = RETRY_BASE_MS;
  private readonly setTimer: (callback: () => void, delayMs: number) => { cancel(): void };
  private readonly now: () => Date;

  constructor(private readonly options: TeamReplayUploadsOptions) {
    this.setTimer = options.setTimer ?? defaultTimer;
    this.now = options.now ?? (() => new Date());
  }

  /** 이 계정의 팀 기록 폴더를 연다. 남아 있던 올리기를 읽고 이어 보낸다. */
  activate(stateDirectoryPath: string): void {
    if (this.directoryPath === stateDirectoryPath) {
      return;
    }
    this.deactivate();
    this.directoryPath = stateDirectoryPath;
    for (const state of this.readStates()) {
      this.states.set(state.recordingId, state);
    }
    if (this.states.size > 0) {
      this.schedule(0);
    }
  }

  deactivate(): void {
    this.timer?.cancel();
    this.timer = null;
    for (const scan of this.scans.values()) {
      scan.session.close();
    }
    this.scans.clear();
    this.states.clear();
    this.live.clear();
    this.directoryPath = null;
  }

  /** 다 보내기 전이다 — 보존 한도로 지우지 않는다. */
  isPending(recordingId: string): boolean {
    return this.states.has(recordingId);
  }

  onRecordingStarted(input: TeamReplayRecordingStart): void {
    if (!this.directoryPath || this.states.has(input.recordingId)) {
      return;
    }
    this.states.set(input.recordingId, {
      recordingId: input.recordingId,
      teamId: input.teamId,
      replayDirectoryPath: input.replayDirectoryPath,
      startMeta: { v: TEAM_HISTORY_FORMAT_VERSION, format: "jsonl-gzip-v1", ...input.startMeta },
      started: false,
      sentThrough: -1,
      indexedThrough: -1,
      end: null,
      completed: false,
      truncated: false,
      indexingStopped: false,
      createdAt: this.now().toISOString(),
    });
    this.live.set(input.recordingId, { segments: new Map(), bytes: 0 });
    this.writeStates();
    this.schedule(0);
  }

  /** 녹화 쓰기가 구간 하나를 끝냈다(onSegment). */
  onSegment(recordingId: string, index: number, record: ReplaySegmentRecord, data: Buffer): void {
    const state = this.states.get(recordingId);
    if (!state || state.truncated) {
      return;
    }
    const live = this.live.get(recordingId) ?? { segments: new Map(), bytes: 0 };
    this.live.set(recordingId, live);
    // 오래 오프라인이면 메모리에 쌓지 않고, 보낼 차례에 파일에서 읽는다(그때는 파일에 다 쓰였다).
    if (live.bytes + data.length <= LIVE_MEMORY_CAP_BYTES) {
      live.segments.set(index, { record, data });
      live.bytes += data.length;
    }
    this.schedule(0);
  }

  onRecordingEnded(recordingId: string, end: { disconnectedAt: string; durationMs: number; lastSegment: number }): void {
    const state = this.states.get(recordingId);
    if (!state || state.end) {
      return;
    }
    state.end = { v: TEAM_HISTORY_FORMAT_VERSION, ...end, cut: false };
    this.writeStates();
    this.schedule(0);
  }

  /** 팀을 잃었다 — 그 팀의 녹화는 더 보내지 않는다(로컬 녹화는 평소 정리에 맡긴다). */
  forgetTeam(teamId: string): void {
    let changed = false;
    for (const state of [...this.states.values()]) {
      if (state.teamId === teamId) {
        this.finish(state.recordingId, false);
        changed = true;
      }
    }
    if (changed) {
      this.writeStates();
    }
  }

  /** 팀이 열렸을 수 있다 — 기다리던 것을 보내 본다. */
  kick(): void {
    if (this.states.size > 0) {
      this.retryDelayMs = RETRY_BASE_MS;
      this.schedule(0);
    }
  }

  /** 앱을 끌 때 — 남은 것을 timeoutMs 안에 보내 본다. 못 보낸 것은 다음 실행 때 간다. */
  async flushBeforeQuit(timeoutMs: number): Promise<void> {
    this.timer?.cancel();
    this.timer = null;
    if (this.states.size === 0) {
      return;
    }
    await Promise.race([
      this.pump(),
      new Promise<void>((resolve) => {
        this.setTimer(resolve, timeoutMs);
      }),
    ]);
  }

  private schedule(delayMs: number): void {
    const dueAt = Date.now() + delayMs;
    if (this.timer && this.timerDueAt <= dueAt) {
      return;
    }
    this.timer?.cancel();
    this.timerDueAt = dueAt;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.pump();
    }, delayMs);
  }

  /** 녹화마다 할 수 있는 만큼 보낸다. 이미 도는 중이면 끝난 뒤 한 번 더 돈다 — 그것까지 끝나야 돌아온다. */
  pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.runPump();
        } while (this.pumpAgain && this.directoryPath);
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  private async runPump(): Promise<void> {
    let retryAfter: number | null = null;
    const ordered = [...this.states.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const state of ordered) {
      if (!this.directoryPath || this.states.get(state.recordingId) !== state) {
        continue;
      }
      let outcome: StepOutcome;
      try {
        outcome = await this.advance(state);
      } catch (error) {
        if (isTeamApiError(error, "team_replay_quota_busy")) {
          // 팀 녹화 공간이 진행 중인 녹화로 차 있다 — 그 녹화들이 끝나면 지울 녹화가 생긴다.
          outcome = "quota";
        } else if (!this.handleRejection(state, error)) {
          console.warn("[team-replay] upload failed — retrying later", error);
          outcome = "retry";
        } else {
          outcome = "idle";
        }
      }
      if (outcome === "retry") {
        retryAfter = Math.min(retryAfter ?? Infinity, this.retryDelayMs);
      } else if (outcome === "quota") {
        retryAfter = Math.min(retryAfter ?? Infinity, QUOTA_RETRY_MS);
      }
    }
    if (retryAfter !== null) {
      this.retryDelayMs = Math.min(RETRY_MAX_MS, this.retryDelayMs * 2);
      this.schedule(retryAfter);
    } else {
      this.retryDelayMs = RETRY_BASE_MS;
    }
  }

  /** 서버가 이 녹화를 더 받을 수 없다고 답했으면 그에 맞게 바꾸고 true. 그 밖의 실패(네트워크 등)는 false. */
  private handleRejection(state: UploadState, error: unknown): boolean {
    if (isTeamApiError(error, "team_replay_too_large") || isTeamApiError(error, "team_request_too_large")) {
      // 녹화가 한 개 최대를 넘었다 — 앞부분만 팀에 남는다. 끝은 알려 길이를 남긴다.
      state.truncated = true;
      this.live.delete(state.recordingId);
      this.options.onTruncated({ recordingId: state.recordingId, teamId: state.teamId, startMeta: state.startMeta });
      this.writeStates();
      this.schedule(0);
      return true;
    }
    if (isTeamApiError(error, "team_replay_closed")) {
      state.completed = true;
      this.writeStates();
      return true;
    }
    if (
      isTeamApiError(error, "team_replay_deleted") ||
      isTeamApiError(error, "team_not_found") ||
      isTeamApiError(error, "team_replay_author_only") ||
      (isTeamApiError(error) && error.status === 400)
    ) {
      // 한도로 지워졌거나, 팀에서 빠졌거나, 받을 수 없는 녹화다 — 다시 보내도 같다.
      this.finish(state.recordingId, true);
      return true;
    }
    return false;
  }

  private async advance(state: UploadState): Promise<StepOutcome> {
    const access = this.options.openTeamAccess(state.teamId);
    if (!access) {
      // 팀을 아직 열지 못했다. 팀 목록이 바뀌면 kick 이 깨운다.
      return "idle";
    }
    if (!(await this.options.getHistoryLimits(access))) {
      // 팀 녹화를 모르는 서버 — 쌓아 두지 않는다.
      this.finish(state.recordingId, true);
      return "idle";
    }
    const { lease } = access;
    const replayKey = deriveTeamReplayKey(base64ToBytes(access.teamKeyBase64), state.teamId, state.recordingId);

    if (!state.end && !this.options.isRecordingActive(state.recordingId)) {
      // 앱이 죽어 끝을 알리지 못한 녹화 — 파일에 남은 데까지가 끝이다.
      state.end = await this.recoverEnd(state);
      this.writeStates();
    }

    if (!state.started) {
      const replay = await this.options.api.startTeamReplay(
        lease,
        state.teamId,
        state.recordingId,
        sealTeamReplayJson(replayKey, state.recordingId, "start", state.startMeta),
      );
      state.started = true;
      // 앞서 보낸 것이 서버에 있으면(응답을 못 받았다) 그다음부터 보낸다.
      if (replay.segmentCount === replay.lastSegment + 1) {
        state.sentThrough = Math.max(state.sentThrough, replay.lastSegment);
      }
      if (replay.state === "ended" || replay.state === "cut") {
        state.completed = true;
      } else if (replay.state === "truncated") {
        state.truncated = true;
      }
      this.writeStates();
    }

    while (!state.truncated) {
      const next = state.sentThrough + 1;
      if (state.end && next > state.end.lastSegment) {
        break;
      }
      const segment = await this.segmentBytes(state, next);
      if (!segment) {
        break;
      }
      const info: TeamReplaySegmentInfo = {
        v: TEAM_HISTORY_FORMAT_VERSION,
        startAtMs: segment.record.startAtMs,
        endAtMs: segment.record.endAtMs,
        entryCount: segment.record.entryCount,
        outputBytes: segment.record.outputBytes,
      };
      await this.options.api.putTeamReplaySegment(
        lease,
        state.teamId,
        state.recordingId,
        next,
        sealTeamReplayJson(replayKey, state.recordingId, `info:${next}`, info),
        sealTeamReplayBytes(replayKey, state.recordingId, `segment:${next}`, segment.data),
      );
      state.sentThrough = next;
      this.writeStates();
    }

    const indexed = await this.index(state, replayKey, access);
    if (indexed !== "idle") {
      return indexed;
    }

    const lastSegment = state.truncated ? state.sentThrough : state.end?.lastSegment;
    if (state.end && lastSegment !== undefined && state.sentThrough >= lastSegment && !state.completed) {
      const endMeta: TeamReplayEndMeta = { ...state.end, lastSegment };
      await this.options.api.completeTeamReplay(lease, state.teamId, state.recordingId, {
        endMeta: sealTeamReplayJson(replayKey, state.recordingId, "end", endMeta),
        lastSegment,
        cut: state.end.cut,
      });
      state.completed = true;
      this.writeStates();
    }
    if (state.completed && (state.indexingStopped || state.indexedThrough >= state.sentThrough)) {
      this.finish(state.recordingId, true);
    }
    return "idle";
  }

  /** 서버에 간 구간을 훑기에 먹여 그 구간의 명령 목록·스냅샷을 보낸다. */
  private async index(state: UploadState, replayKey: Uint8Array, access: TeamAccess): Promise<StepOutcome> {
    if (state.indexingStopped || state.indexedThrough >= state.sentThrough) {
      return "idle";
    }
    let scan = this.scans.get(state.recordingId);
    if (!scan) {
      // 새로 열면 처음부터 다시 먹여 훑기 상태를 만든다(앞서 보낸 덧붙임은 다시 보내지 않는다).
      scan = {
        session: this.options.scanHost.open({
          initialCols: state.startMeta.initialCols,
          initialRows: state.startMeta.initialRows,
          firstStartAtMs: null,
        }),
        fedThrough: -1,
      };
      this.scans.set(state.recordingId, scan);
    }
    for (let index = scan.fedThrough + 1; index <= state.sentThrough; index += 1) {
      const decoded = await this.decodedSegment(state, index);
      if (!decoded) {
        return "idle";
      }
      let result;
      try {
        result = await scan.session.feed(index, decoded);
      } catch (error) {
        // 훑기가 죽었다 — 다음에 새로 열어 처음부터 다시 먹인다.
        scan.session.close();
        this.scans.delete(state.recordingId);
        console.warn("[team-replay] the recording scan failed — retrying", error);
        return "retry";
      }
      scan.fedThrough = index;
      if (index <= state.indexedThrough) {
        continue;
      }
      try {
        if (result.step.changed.length > 0) {
          const piece: TeamReplayCommandsPiece = {
            v: TEAM_HISTORY_FORMAT_VERSION,
            blocks: result.step.changed,
            shellIntegration: result.shellIntegration,
          };
          await this.options.api.putTeamReplayExtra(
            access.lease,
            state.teamId,
            state.recordingId,
            "commands",
            index,
            sealTeamReplayBytes(replayKey, state.recordingId, `commands:${index}`, Buffer.from(JSON.stringify(piece), "utf8")),
          );
        }
        const snapshot = result.step.snapshot;
        if (snapshot) {
          const piece: TeamReplaySnapshotPiece = { v: TEAM_HISTORY_FORMAT_VERSION, snapshot };
          await this.options.api.putTeamReplayExtra(
            access.lease,
            state.teamId,
            state.recordingId,
            "snapshot",
            snapshot.segment,
            sealTeamReplayBytes(
              replayKey,
              state.recordingId,
              `snapshot:${snapshot.segment}`,
              gzipSync(JSON.stringify(piece), { level: zlibConstants.Z_BEST_SPEED }),
            ),
          );
        }
      } catch (error) {
        if (isTeamApiError(error, "team_replay_too_large") || isTeamApiError(error, "team_request_too_large")) {
          // 덧붙임이 한 개 최대를 넘었다 — 구간은 다 갔으니 덧붙임만 멈춘다.
          state.indexingStopped = true;
          this.closeScan(state.recordingId);
          this.writeStates();
          return "idle";
        }
        if (isTeamApiError(error, "team_replay_quota_busy")) {
          // 훑기는 이미 이 구간을 먹었다 — 다시 먹이면 상태가 어긋나므로 다음에 처음부터 다시 연다.
          this.closeScan(state.recordingId);
          return "quota";
        }
        this.closeScan(state.recordingId);
        throw error;
      }
      state.indexedThrough = index;
      this.writeStates();
      this.dropLiveSegment(state.recordingId, index);
    }
    const finalSegment = state.truncated ? state.sentThrough : state.end?.lastSegment;
    if (finalSegment !== undefined && state.indexedThrough >= finalSegment) {
      this.closeScan(state.recordingId);
    }
    return "idle";
  }

  private closeScan(recordingId: string): void {
    this.scans.get(recordingId)?.session.close();
    this.scans.delete(recordingId);
  }

  private dropLiveSegment(recordingId: string, index: number): void {
    const live = this.live.get(recordingId);
    const segment = live?.segments.get(index);
    if (live && segment) {
      live.segments.delete(index);
      live.bytes -= segment.data.length;
    }
  }

  /** 구간 바이트 — 이번 실행에서 막 끝난 것은 메모리에서, 아니면 파일에서. 아직 없으면 null. */
  private async segmentBytes(state: UploadState, index: number): Promise<{ record: ReplaySegmentRecord; data: Buffer } | null> {
    const fresh = this.live.get(state.recordingId)?.segments.get(index);
    if (fresh) {
      return fresh;
    }
    const recording = this.options.isRecordingActive(state.recordingId);
    const records = await this.fileRecords(state);
    const record = records[index];
    if (!record || (record.cutOff && recording)) {
      // 아직 끝나지 않은 구간이다.
      return null;
    }
    if (record.cutOff || record.plain) {
      // 앱이 죽어 색인에 못 오른 끝부분 — 읽을 수 있는 데까지 풀어 같은 형식으로 다시 묶는다.
      const decoded = await readReplaySegment(eventsPathOf(state), record).catch(() => null);
      return decoded ? { record, data: encodeReplaySegmentMember(decoded) } : null;
    }
    const data = readRange(eventsPathOf(state), record.offset, record.length);
    return data ? { record, data } : null;
  }

  private async decodedSegment(state: UploadState, index: number): Promise<SessionReplaySegment | null> {
    const segment = await this.segmentBytes(state, index);
    if (!segment) {
      return null;
    }
    try {
      return decodeReplaySegment(gunzipSync(segment.data).toString("utf8"), segment.record.startAtMs);
    } catch {
      return null;
    }
  }

  private async fileRecords(state: UploadState): Promise<ReplaySegmentRecord[]> {
    if (!existsSync(eventsPathOf(state)) && !existsSync(legacyEventsPathOf(state))) {
      return [];
    }
    try {
      return await loadReplaySegments({
        events: eventsPathOf(state),
        legacyEvents: legacyEventsPathOf(state),
        index: indexPathOf(state),
      });
    } catch {
      return [];
    }
  }

  /** 앱이 죽었던 녹화의 끝 — 파일에 남은 마지막 구간까지, 끊김으로. 파일이 없으면 보낸 데까지다. */
  private async recoverEnd(state: UploadState): Promise<TeamReplayEndMeta> {
    const records = await this.fileRecords(state);
    const last = records[records.length - 1];
    let disconnectedAt = this.now().toISOString();
    try {
      disconnectedAt = statSync(eventsPathOf(state)).mtime.toISOString();
    } catch {
      // 파일이 없다 — 지금 시각으로 둔다.
    }
    return {
      v: TEAM_HISTORY_FORMAT_VERSION,
      disconnectedAt,
      durationMs: last?.endAtMs ?? 0,
      lastSegment: Math.max(records.length - 1, state.sentThrough),
      cut: true,
    };
  }

  /** 이 녹화는 끝났다(다 보냈거나 더 보낼 수 없다) — 상태를 지워 로컬 정리가 다시 지울 수 있게 한다. */
  private finish(recordingId: string, persist: boolean): void {
    this.states.delete(recordingId);
    this.live.delete(recordingId);
    this.closeScan(recordingId);
    if (persist) {
      this.writeStates();
    }
  }

  private statePath(): string | null {
    return this.directoryPath ? path.join(this.directoryPath, STATE_FILE) : null;
  }

  private readStates(): UploadState[] {
    const filePath = this.statePath();
    if (!filePath || !existsSync(filePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StateFile>;
      return parsed.version === STATE_VERSION && Array.isArray(parsed.recordings) ? parsed.recordings : [];
    } catch {
      return [];
    }
  }

  private writeStates(): void {
    const filePath = this.statePath();
    if (!filePath) {
      return;
    }
    try {
      if (this.states.size === 0) {
        rmSync(filePath, { force: true });
        return;
      }
      mkdirSync(path.dirname(filePath), { recursive: true });
      const body: StateFile = { version: STATE_VERSION, recordings: [...this.states.values()] };
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(body), "utf8");
      renameSync(temporaryPath, filePath);
    } catch (error) {
      console.warn("[team-replay] could not save the upload state", error);
    }
  }
}
