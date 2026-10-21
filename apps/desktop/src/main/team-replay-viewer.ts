import { gunzipSync } from "node:zlib";
import {
  base64ToBytes,
  deriveTeamReplayKey,
  isTeamCryptoError,
  openTeamReplayBytes,
  openTeamReplayJson,
  TEAM_HISTORY_FORMAT_VERSION,
  type SessionReplaySegment,
  type SessionReplaySegmentInfo,
  type TeamReplayPurpose,
} from "@shared";
import type { SessionReplayView, TeamReplayView } from "../shared/ipc";
import type { ReplayCommandBlock, ReplaySnapshot } from "../common/replay/replay-command-scan";
import { t } from "./i18n";
import {
  concatReplaySegments,
  groupedSegmentInfo,
  groupReplaySegments,
  type ReplaySegmentGroup,
} from "./replay-segment-groups";
import { decodeReplaySegment } from "./session-replay-events";
import { isTeamApiError, type RawTeamReplayDetail, type TeamApi, type TeamReplayExtraKind } from "./team-api";
import { CANONICAL_UUID, type TeamAccess } from "./team-history-service";
import type { TeamReplayCache, TeamReplayCacheName } from "./team-replay-cache";
import type {
  TeamReplayCommandsPiece,
  TeamReplayEndMeta,
  TeamReplaySegmentInfo,
  TeamReplaySnapshotPiece,
  TeamReplayStartMeta,
} from "./team-replay-uploads";

/*
 * 팀 녹화 보기. 녹화를 다 받지 않고 보는 만큼만 받는다.
 *
 * - 열 때 받는 것: 녹화 하나(메타·구간 정보·덧붙임 목록)와 구간별 명령 목록. 명령 목록은 녹화한 쪽 앱이 세션 동안
 *   만들어 올린 것을 이어 붙인다 — 재생 창은 훑지 않는다.
 * - 재생 창에 주는 구간은 작은 구간을 이어 붙인 묶음이다(replay-segment-groups). 스냅샷이 있는 구간에서 묶음을
 *   새로 시작한다. 묶음을 달라면 그 구간들을 캐시에서 찾고, 없는 것만 한 번에 묶어 받는다.
 * - 멀리 건너뛸 때 스냅샷 하나를 그때 받는다.
 * - 받은 것은 잠긴 채 캐시에 둔다(team-replay-cache).
 */

/** 한 번에 묶어 받는 상한(서버와 같다). */
const READ_BATCH_ITEMS = 256;
/** 열어 둔 녹화(풀린 메타·묶음)를 기억해 두는 수. 재생 창 하나가 녹화 하나다. */
const OPENED_LIMIT = 8;

export interface TeamReplayViewerOptions {
  api: Pick<TeamApi, "getTeamReplay" | "readTeamReplaySegments" | "readTeamReplayExtras">;
  openTeamAccess(teamId: string): TeamAccess | null;
  cache: TeamReplayCache;
}

interface OpenedReplay {
  teamId: string;
  recordingId: string;
  replayKey: Uint8Array;
  /** 서버 구간 정보(0 부터 빠짐없이). */
  infos: TeamReplaySegmentInfo[];
  /** 재생 창 구간 → 서버 구간들. */
  groups: ReplaySegmentGroup[];
  /** 스냅샷이 있는 서버 구간. */
  snapshotSegments: Set<number>;
}

function openedKey(teamId: string, recordingId: string): string {
  return `${teamId}/${recordingId}`;
}

/** 모르는 형식의 조각 — 업데이트하면 보인다. */
function isUnsupported(error: unknown): boolean {
  return isTeamCryptoError(error) && error.code === "unsupported-version";
}

/** 녹화 조각을 풀 수 없는 까닭을 사람 말로 바꾼다. */
function describeOpenFailure(error: unknown): Error {
  if (isUnsupported(error)) {
    return new Error(t("teamReplay.unsupported"));
  }
  if (isTeamCryptoError(error)) {
    return new Error(t("replaySvc.damaged"));
  }
  return error instanceof Error ? error : new Error(String(error));
}

function parsePiece<T extends { v: number }>(bytes: Uint8Array): T | "unsupported" {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  if (typeof parsed?.v !== "number") {
    throw new Error("malformed piece");
  }
  return parsed.v > TEAM_HISTORY_FORMAT_VERSION ? "unsupported" : parsed;
}

export class TeamReplayViewer {
  private readonly opened = new Map<string, OpenedReplay>();

  constructor(private readonly options: TeamReplayViewerOptions) {}

  activate(stateDirectoryPath: string): void {
    this.opened.clear();
    this.options.cache.activate(stateDirectoryPath);
  }

  deactivate(): void {
    this.opened.clear();
    this.options.cache.deactivate();
  }

  /** 팀을 잃었다 — 그 팀의 캐시를 지운다. */
  forgetTeam(teamId: string): void {
    for (const [key, opened] of this.opened) {
      if (opened.teamId === teamId) {
        this.opened.delete(key);
      }
    }
    this.options.cache.forgetTeam(teamId);
  }

  /** 계정을 지운다 — 캐시를 모두 지운다. */
  purgeAll(): void {
    this.opened.clear();
    this.options.cache.purgeAll();
  }

  /** 녹화를 연다: 메타·묶음 목록·명령 목록. 구간 내용은 readSegment 로 받는다. */
  async load(teamId: string, recordingId: string): Promise<SessionReplayView> {
    if (!CANONICAL_UUID.test(recordingId)) {
      // 녹화 ID 는 UUID 다 — 다른 값은 서버의 다른 경로가 되어 엉뚱한 응답을 "손상"으로 보였다.
      throw new Error(t("teams.api.replayNotFound"));
    }
    const access = this.requireAccess(teamId);
    let detail: RawTeamReplayDetail;
    try {
      detail = await this.options.api.getTeamReplay(access.lease, teamId, recordingId);
    } catch (error) {
      if (isTeamApiError(error, "team_replay_deleted") || isTeamApiError(error, "team_replay_not_found")) {
        this.options.cache.forgetRecording(teamId, recordingId);
      }
      throw error;
    }
    const replayKey = deriveTeamReplayKey(base64ToBytes(access.teamKeyBase64), teamId, recordingId);
    let start: TeamReplayStartMeta;
    let end: TeamReplayEndMeta | null;
    const infos: TeamReplaySegmentInfo[] = [];
    try {
      start = openTeamReplayJson<TeamReplayStartMeta>(replayKey, recordingId, "start", detail.startMeta);
      if (start.format !== "jsonl-gzip-v1") {
        throw new Error(t("teamReplay.unsupported"));
      }
      end = detail.endMeta ? openTeamReplayJson<TeamReplayEndMeta>(replayKey, recordingId, "end", detail.endMeta) : null;
      // 앞에서부터 빠짐없이 이어진 구간까지만 쓴다(올리기는 차례대로라 보통 다 이어진다).
      const segments = [...detail.segments].sort((left, right) => left.index - right.index);
      for (const segment of segments) {
        if (segment.index !== infos.length) {
          break;
        }
        infos.push(openTeamReplayJson<TeamReplaySegmentInfo>(replayKey, recordingId, `info:${segment.index}`, segment.info));
      }
    } catch (error) {
      throw describeOpenFailure(error);
    }

    const snapshotSegments = new Set(
      detail.extras
        .filter((extra) => extra.kind === "snapshot" && extra.index > 0 && extra.index < infos.length)
        .map((extra) => extra.index),
    );
    const groups = groupReplaySegments(infos, (index) => snapshotSegments.has(index));
    const opened: OpenedReplay = { teamId, recordingId, replayKey, infos, groups, snapshotSegments };
    this.remember(opened);

    const commandIndexes = detail.extras
      .filter((extra) => extra.kind === "commands" && extra.index < infos.length)
      .map((extra) => extra.index);
    const commands = await this.loadCommands(access, opened, commandIndexes);
    const groupOfSegment = new Map(groups.map((group, index) => [group.first, index]));
    const team: TeamReplayView = {
      teamId,
      authorEmail: detail.authorEmail,
      state: detail.state,
      commands,
      snapshots: [...snapshotSegments]
        .sort((left, right) => left - right)
        .map((segment) => ({ segment: groupOfSegment.get(segment) ?? -1, atMs: infos[segment - 1].endAtMs }))
        .filter((snapshot) => snapshot.segment > 0),
    };
    const lastEndAtMs = infos[infos.length - 1]?.endAtMs ?? 0;
    // 앞부분만 팀에 있는 녹화는 받은 데까지가 길이다 — 끝 메타의 길이(세션 전체)를 쓰면 재생 막대 뒤쪽이 빈다.
    const durationMs = detail.state === "truncated" ? lastEndAtMs : Math.max(end?.durationMs ?? 0, lastEndAtMs);
    return {
      recordingId,
      sessionId: start.sessionId,
      hostId: start.hostId,
      hostLabel: start.hostLabel,
      title: start.title,
      connectionDetails: start.connectionDetails,
      connectionKind: start.connectionKind as SessionReplayView["connectionKind"],
      connectedAt: start.connectedAt,
      disconnectedAt: end?.disconnectedAt ?? detail.lastActivityAt,
      durationMs,
      initialCols: start.initialCols,
      initialRows: start.initialRows,
      segments: groups.map((group): SessionReplaySegmentInfo => groupedSegmentInfo(infos, group)),
      team,
    };
  }

  /** 재생 창 구간(묶음) 하나. */
  async readSegment(teamId: string, recordingId: string, segmentIndex: number): Promise<SessionReplaySegment> {
    const opened = await this.openedReplay(teamId, recordingId);
    const group = Number.isInteger(segmentIndex) ? opened.groups[segmentIndex] : undefined;
    if (!group) {
      throw new Error(`Replay segment ${segmentIndex} does not exist`);
    }
    const indexes: number[] = [];
    for (let index = group.first; index <= group.last; index += 1) {
      indexes.push(index);
    }
    const sealed = await this.fetchPieces(opened, "segment", indexes);
    const parts: SessionReplaySegment[] = [];
    for (const index of indexes) {
      const purpose: TeamReplayPurpose = `segment:${index}`;
      let plaintext: Uint8Array;
      try {
        plaintext = await this.openPiece(opened, "segment", index, purpose, sealed.get(index));
      } catch (error) {
        throw describeOpenFailure(error);
      }
      let text: string;
      try {
        text = gunzipSync(plaintext).toString("utf8");
      } catch {
        throw new Error(t("replaySvc.damaged"));
      }
      parts.push(decodeReplaySegment(text, opened.infos[index].startAtMs));
    }
    return concatReplaySegments(parts);
  }

  /** 재생 창 구간 segmentIndex 의 첫 항목부터 이어 그릴 화면. 없거나 모르는 형식이면 null — 처음부터 그린다. */
  async readSnapshot(teamId: string, recordingId: string, segmentIndex: number): Promise<ReplaySnapshot | null> {
    const opened = await this.openedReplay(teamId, recordingId);
    const group = opened.groups[segmentIndex];
    if (!group || !opened.snapshotSegments.has(group.first)) {
      return null;
    }
    const sealed = await this.fetchPieces(opened, "snapshot", [group.first]);
    try {
      const plaintext = await this.openPiece(opened, "snapshot", group.first, `snapshot:${group.first}`, sealed.get(group.first));
      const piece = parsePiece<TeamReplaySnapshotPiece>(gunzipSync(plaintext));
      if (piece === "unsupported") {
        return null;
      }
      return { ...piece.snapshot, segment: segmentIndex };
    } catch (error) {
      console.warn("[team-replay] could not open a snapshot — drawing from the start", error);
      return null;
    }
  }

  private requireAccess(teamId: string): TeamAccess {
    const access = this.options.openTeamAccess(teamId);
    if (!access) {
      throw new Error(t("teamReplay.teamNotOpen"));
    }
    return access;
  }

  private remember(opened: OpenedReplay): void {
    const key = openedKey(opened.teamId, opened.recordingId);
    this.opened.delete(key);
    this.opened.set(key, opened);
    while (this.opened.size > OPENED_LIMIT) {
      const oldest = this.opened.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.opened.delete(oldest);
    }
  }

  private async openedReplay(teamId: string, recordingId: string): Promise<OpenedReplay> {
    const opened = this.opened.get(openedKey(teamId, recordingId));
    if (opened) {
      return opened;
    }
    // 앱을 다시 켰거나 오래돼 잊었다 — 다시 연다.
    await this.load(teamId, recordingId);
    const reopened = this.opened.get(openedKey(teamId, recordingId));
    if (!reopened) {
      throw new Error(t("replaySvc.damaged"));
    }
    return reopened;
  }

  /** 구간별 명령 목록을 받아 이어 붙인다. 모르는 형식이 섞였으면 null. */
  private async loadCommands(
    access: TeamAccess,
    opened: OpenedReplay,
    indexes: number[],
  ): Promise<TeamReplayView["commands"]> {
    const sealed = await this.fetchPieces(opened, "commands", indexes, access);
    const byId = new Map<number, ReplayCommandBlock>();
    let shellIntegrationDetected = false;
    for (const index of [...indexes].sort((left, right) => left - right)) {
      let piece: TeamReplayCommandsPiece | "unsupported";
      try {
        piece = parsePiece<TeamReplayCommandsPiece>(
          await this.openPiece(opened, "commands", index, `commands:${index}`, sealed.get(index)),
        );
      } catch (error) {
        if (isUnsupported(error)) {
          return null;
        }
        // 한 조각을 못 풀어도 나머지 명령은 보인다.
        console.warn("[team-replay] could not open a command list piece", index, error);
        continue;
      }
      if (piece === "unsupported") {
        return null;
      }
      for (const block of piece.blocks) {
        byId.set(block.id, block);
      }
      shellIntegrationDetected ||= piece.shellIntegration;
    }
    return {
      blocks: [...byId.values()].sort((left, right) => left.id - right.id),
      shellIntegrationDetected,
    };
  }

  /** 조각을 푼다. 캐시에서 온 것이 풀리지 않으면 지우고 다시 받아 한 번 더 해 본다. */
  private async openPiece(
    opened: OpenedReplay,
    kind: "segment" | TeamReplayExtraKind,
    index: number,
    purpose: TeamReplayPurpose,
    sealed: { data: Uint8Array; cached: boolean } | undefined,
  ): Promise<Uint8Array> {
    if (!sealed) {
      throw new Error(t("replaySvc.damaged"));
    }
    try {
      return openTeamReplayBytes(opened.replayKey, opened.recordingId, purpose, sealed.data);
    } catch (error) {
      if (!sealed.cached || isUnsupported(error)) {
        throw error;
      }
      const name = `${kind}-${index}` as TeamReplayCacheName;
      this.options.cache.remove(opened.teamId, opened.recordingId, name);
      const fresh = await this.fetchPieces(opened, kind, [index]);
      const retry = fresh.get(index);
      if (!retry) {
        throw error;
      }
      return openTeamReplayBytes(opened.replayKey, opened.recordingId, purpose, retry.data);
    }
  }

  /** 조각들을 캐시에서 찾고, 없는 것만 서버에서 묶어 받아 캐시에 둔다. */
  private async fetchPieces(
    opened: OpenedReplay,
    kind: "segment" | TeamReplayExtraKind,
    indexes: number[],
    access?: TeamAccess,
  ): Promise<Map<number, { data: Uint8Array; cached: boolean }>> {
    const { cache } = this.options;
    const found = new Map<number, { data: Uint8Array; cached: boolean }>();
    const missing: number[] = [];
    for (const index of indexes) {
      const data = cache.read(opened.teamId, opened.recordingId, `${kind}-${index}` as TeamReplayCacheName);
      if (data) {
        found.set(index, { data, cached: true });
      } else {
        missing.push(index);
      }
    }
    if (missing.length === 0) {
      return found;
    }
    const { lease } = access ?? this.requireAccess(opened.teamId);
    missing.sort((left, right) => left - right);
    const wanted = new Set(missing);
    let cursor = 0;
    while (cursor < missing.length) {
      const from = missing[cursor];
      const span = missing[missing.length - 1] - from + 1;
      const frames =
        kind === "segment"
          ? await this.options.api.readTeamReplaySegments(lease, opened.teamId, opened.recordingId, from, Math.min(READ_BATCH_ITEMS, span))
          : await this.options.api.readTeamReplayExtras(lease, opened.teamId, opened.recordingId, kind, from, Math.min(READ_BATCH_ITEMS, span));
      if (frames.length === 0) {
        break;
      }
      let last = from;
      for (const frame of frames) {
        last = Math.max(last, frame.index);
        if (wanted.has(frame.index) && !found.has(frame.index)) {
          found.set(frame.index, { data: frame.data, cached: false });
          cache.write(opened.teamId, opened.recordingId, `${kind}-${frame.index}` as TeamReplayCacheName, frame.data);
        }
      }
      while (cursor < missing.length && missing[cursor] <= last) {
        cursor += 1;
      }
    }
    return found;
  }
}
