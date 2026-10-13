import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { constants as zlibConstants, createGzip, gunzip, type Gzip } from "node:zlib";
import { BrowserWindow } from "electron";
import type {
  CoreEvent,
  SessionReplayEntry,
  SessionReplayRecording,
  SessionReplayStorageUsage,
} from "@shared";
import {
  DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
  MAX_SESSION_REPLAY_RETENTION_COUNT,
  MIN_SESSION_REPLAY_RETENTION_COUNT,
} from "@shared";
import type { SettingsRepository } from "./database";
import type { CoreManager } from "./core-manager";
import {
  resolveLocalHistoryScope,
  type LocalHistoryOwner,
  type LocalHistoryScope,
} from "./local-history-scope";
import { getMainLocale, t } from './i18n';
import { APP_LOCALE_QUERY_PARAM } from "../common/i18n/locale";

const META_SUFFIX = ".meta.json";
// 옛 녹화. 새 녹화는 EVENTS_GZIP_SUFFIX 로 쓰고, 이것은 읽기만 한다.
const EVENTS_SUFFIX = ".events.jsonl";
const EVENTS_GZIP_SUFFIX = ".events.jsonl.gz";
/**
 * gzip 수준. 실제 녹화 226MB 를 수준 1로 압축하면 84.3MB·초당 160MB, 수준 6이면 80.0MB·초당 112MB 였다
 * (실측). 크기 차이는 5% 남짓이고 CPU 는 30% 덜 쓴다. 녹화로 들어오는 양은 흐름 제어로 초당 35MB 안팎이다.
 */
const EVENTS_GZIP_LEVEL = zlibConstants.Z_BEST_SPEED;
/**
 * 그 사이 쓴 것이 있으면 이만큼마다 압축기를 비운다. 비운 지점까지는 마무리 없이 끊긴 파일(비정상
 * 종료)에서도 읽히므로, 그때 잃는 것은 압축기 안에 남은 마지막 이만큼이다.
 */
const EVENTS_FLUSH_INTERVAL_MS = 1000;
/** 앱을 끌 때 녹화 스트림이 다 쓰이기를 기다리는 한도. 디스크가 막혀도 종료가 멈추지 않게 한다. */
const EVENTS_CLOSE_TIMEOUT_MS = 3000;
const gunzipAsync = promisify(gunzip);
const DEFAULT_REPLAY_COLS = 120;
const DEFAULT_REPLAY_ROWS = 32;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SessionReplayRecordingMeta
  extends Omit<SessionReplayRecording, "entries"> {}

interface ActiveRecording {
  recordingId: string;
  sessionId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails: string | null;
  connectionKind: SessionReplayRecording["connectionKind"];
  connectedAt: string;
  connectedAtMs: number;
  initialCols: number;
  initialRows: number;
  replayDirectoryPath: string;
  /**
   * 녹화가 끝날 때까지 열어 두고 이어 쓰는 gzip 스트림(EVENTS_GZIP_SUFFIX 파일).
   *
   * 예전에는 출력 조각마다 평문 파일을 열고-쓰고-닫아서, 쏟아지면 초당 4만 번이 메인 프로세스 시간의
   * 4분의 3을 먹었다(실측). 압축은 백그라운드 스레드에서 돌고, 모으는 것도 압축기가 안에서 한다. 쓰다가
   * 실패하면 null 이 되고 그 녹화는 더 쓰지 않는다.
   */
  events: Gzip | null;
  /** 마지막으로 압축기를 비운 뒤 쓴 것이 있는가(EVENTS_FLUSH_INTERVAL_MS). */
  eventsDirty: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampRetentionCount(value: number): number {
  return Math.min(
    MAX_SESSION_REPLAY_RETENTION_COUNT,
    Math.max(MIN_SESSION_REPLAY_RETENTION_COUNT, Math.round(value)),
  );
}

function parseRecordingId(fileName: string): string | null {
  if (!fileName.endsWith(META_SUFFIX)) {
    return null;
  }
  return fileName.slice(0, -META_SUFFIX.length).trim() || null;
}

function decodeRecordingEntries(content: string): SessionReplayEntry[] {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: SessionReplayEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SessionReplayEntry;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.atMs === "number" &&
        Number.isFinite(parsed.atMs)
      ) {
        if (
          parsed.type === "output" &&
          typeof parsed.dataBase64 === "string"
        ) {
          entries.push(parsed);
        }
        if (
          parsed.type === "resize" &&
          typeof parsed.cols === "number" &&
          typeof parsed.rows === "number"
        ) {
          entries.push(parsed);
        }
      }
    } catch {
      continue;
    }
  }
  entries.sort((left, right) => left.atMs - right.atMs);
  return entries;
}

export class SessionReplayService {
  private readonly activeRecordings = new Map<string, ActiveRecording>();
  private readonly initialSizeBySession = new Map<
    string,
    { cols: number; rows: number }
  >();
  private readonly replayWindows = new Map<string, BrowserWindow>();
  /**
   * 녹화별 gzip 스트림이 파일에 다 쓰였을 때 풀리는 약속. 녹화가 끝나도 압축기에 남은 것이 파일에 닿기까지
   * 잠깐 걸리므로, 막 끝난 녹화를 열거나(get) 앱을 끌 때(shutdown) 이것을 기다린다.
   */
  private readonly eventStreamsDone = new Map<string, Promise<void>>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private activeScope: LocalHistoryScope | null = null;
  private onRecordingsPruned: (() => void) | null = null;

  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly coreManager: CoreManager,
  ) {}

  activate(owner: LocalHistoryOwner): void {
    const scope = resolveLocalHistoryScope(owner);
    if (this.activeScope?.id === scope.id) {
      return;
    }
    this.closeReplayWindows();
    this.migrateLegacyRecordings(scope);
    this.activeScope = scope;
    this.prune();
  }

  deactivate(): void {
    void this.shutdown();
    this.closeReplayWindows();
    this.activeScope = null;
    this.initialSizeBySession.clear();
  }

  // 회원 탈퇴 — 현재 scope의 녹화 파일(meta/events)을 전부 삭제한다. 진행 중 녹화와
  // 열린 리플레이 창도 정리한다. deactivate() 이전(scope가 살아 있을 때) 호출해야 한다.
  // 녹화 스트림이 다 쓰인 뒤에 지운다 — 먼저 지우면 아직 열리는 중이던 스트림이 파일을 다시 만든다.
  async purgeAllRecordings(): Promise<void> {
    const scope = this.activeScope;
    if (!scope) {
      return;
    }
    await this.shutdown();
    this.closeReplayWindows();
    if (existsSync(scope.replayDirectoryPath)) {
      for (const fileName of readdirSync(scope.replayDirectoryPath)) {
        if (
          fileName.endsWith(META_SUFFIX) ||
          fileName.endsWith(EVENTS_SUFFIX) ||
          fileName.endsWith(EVENTS_GZIP_SUFFIX)
        ) {
          rmSync(path.join(scope.replayDirectoryPath, fileName), {
            force: true,
          });
        }
      }
    }
    this.onRecordingsPruned?.();
  }

  noteSessionConfigured(sessionId: string, cols: number, rows: number): void {
    this.initialSizeBySession.set(sessionId, { cols, rows });
  }

  handleTerminalResize(sessionId: string, cols: number, rows: number): void {
    this.initialSizeBySession.set(sessionId, { cols, rows });
    const active = this.activeRecordings.get(sessionId);
    if (!active) {
      return;
    }
    this.appendEntry(active, {
      type: "resize",
      atMs: Math.max(0, Date.now() - active.connectedAtMs),
      cols,
      rows,
    });
  }

  handleTerminalStream(sessionId: string, chunk: Uint8Array): void {
    const active = this.activeRecordings.get(sessionId);
    if (!active) {
      return;
    }
    this.appendEntry(active, {
      type: "output",
      atMs: Math.max(0, Date.now() - active.connectedAtMs),
      dataBase64: Buffer.from(chunk).toString("base64"),
    });
  }

  handleTerminalEvent(event: CoreEvent<Record<string, unknown>>): void {
    const sessionId = event.sessionId;
    if (!sessionId) {
      return;
    }

    if (event.type === "connected") {
      this.startRecording(sessionId);
      return;
    }

    if (event.type === "closed" || event.type === "error") {
      this.finalizeRecording(
        sessionId,
        typeof event.payload.message === "string" ? event.payload.message : null,
      );
    }
  }

  /**
   * 진행 중인 녹화를 모두 끝낸다. 돌려주는 약속은 녹화 파일이 다 쓰였을 때(최대
   * EVENTS_CLOSE_TIMEOUT_MS) 풀린다 — 앱을 끌 때 기다리지 않으면 압축기에 남은 끝부분을 잃는다.
   */
  shutdown(): Promise<void> {
    for (const sessionId of Array.from(this.activeRecordings.keys())) {
      this.finalizeRecording(
        sessionId,
        t('core.shutdownSession'),
      );
    }
    const pending = Array.from(this.eventStreamsDone.values());
    if (pending.length === 0) {
      return Promise.resolve();
    }
    return Promise.race([
      Promise.all(pending).then(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, EVENTS_CLOSE_TIMEOUT_MS).unref?.();
      }),
    ]);
  }

  async openReplayWindow(
    recordingId: string,
    _sourceWindow: BrowserWindow,
  ): Promise<void> {
    const scope = this.requireActiveScope();
    const existingWindow = this.replayWindows.get(recordingId);
    if (existingWindow && !existingWindow.isDestroyed()) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
      return;
    }

    // 창 제목만 필요하다. 출력 전체를 풀어 읽지 않는다.
    const recording = this.loadRecordingMeta(recordingId, scope.replayDirectoryPath);
    const replayWindow = new BrowserWindow({
      width: 1040,
      height: 760,
      minWidth: 900,
      minHeight: 620,
      show: false,
      // macOS 는 비활성 창의 첫 클릭을 창 활성화에만 쓰고 내용에는 주지 않는다. RDP 세션에서는
      // 그것이 "한 번은 포커스, 한 번은 실제 클릭" 이라는 두 번 클릭으로 나타난다. 창 단위
      // 옵션이라 캔버스만 골라 켤 수 없어서 창 전체에 켠다 — 비활성 상태의 첫 클릭이 버튼에도
      // 그대로 먹는다는 뜻이다(그래서 기본값이 false 다). Windows·Linux 에서는 무시된다.
      acceptFirstMouse: true,
      autoHideMenuBar: true,
      backgroundColor: "#0d141a",
      title: this.buildReplayWindowTitle(recording.title),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.replayWindows.set(recordingId, replayWindow);
    replayWindow.on("closed", () => {
      if (this.replayWindows.get(recordingId) === replayWindow) {
        this.replayWindows.delete(recordingId);
      }
    });
    replayWindow.once("ready-to-show", () => {
      replayWindow.show();
      replayWindow.focus();
    });

    try {
      await this.loadReplayWindow(replayWindow, recordingId);
    } catch (error) {
      this.replayWindows.delete(recordingId);
      if (!replayWindow.isDestroyed()) {
        replayWindow.close();
      }
      throw error;
    }
  }

  async get(recordingId: string): Promise<SessionReplayRecording> {
    const scope = this.requireActiveScope();
    const meta = this.loadRecordingMeta(recordingId, scope.replayDirectoryPath);
    // 방금 끝난 녹화면 압축기에 남은 끝부분이 파일에 닿을 때까지 기다린다.
    await this.eventStreamsDone.get(recordingId);
    return {
      ...meta,
      entries: await this.readEntries(recordingId, scope.replayDirectoryPath),
    };
  }

  private async readEntries(
    recordingId: string,
    replayDirectoryPath: string,
  ): Promise<SessionReplayEntry[]> {
    const gzipPath = this.getEventsGzipPath(recordingId, replayDirectoryPath);
    if (existsSync(gzipPath)) {
      try {
        // 비정상 종료로 마무리 없이 끊긴 파일도 마지막으로 비운 지점까지는 읽는다.
        const content = await gunzipAsync(readFileSync(gzipPath), {
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        });
        return decodeRecordingEntries(content.toString("utf8"));
      } catch (error) {
        console.warn("[session-replay] could not read a recording", error);
        return [];
      }
    }
    const eventsPath = this.getEventsPath(recordingId, replayDirectoryPath);
    return existsSync(eventsPath)
      ? decodeRecordingEntries(readFileSync(eventsPath, "utf8"))
      : [];
  }

  prune(): void {
    const scope = this.activeScope;
    if (!scope) {
      return;
    }
    this.pruneDirectory(scope.replayDirectoryPath);
  }

  private pruneDirectory(replayDirectoryPath: string): void {
    const retentionCount = this.resolveRetentionCount();
    const recordings = this.listRecordingMeta(replayDirectoryPath).sort(
      (left, right) => {
        const leftKey = left.disconnectedAt || left.connectedAt;
        const rightKey = right.disconnectedAt || right.connectedAt;
        return rightKey.localeCompare(leftKey);
      },
    );

    for (const stale of recordings.slice(retentionCount)) {
      rmSync(this.getMetaPath(stale.recordingId, replayDirectoryPath), {
        force: true,
      });
      rmSync(this.getEventsPath(stale.recordingId, replayDirectoryPath), {
        force: true,
      });
      rmSync(this.getEventsGzipPath(stale.recordingId, replayDirectoryPath), {
        force: true,
      });
    }
    // 녹화가 사라졌으니(또는 활성화 시 재조정 시점) 활동 로그의 hasReplay를 실제 파일 기준으로
    // 맞춰, 더 이상 없는 녹화에 Replay 버튼이 남지 않게 한다.
    this.onRecordingsPruned?.();
  }

  // 현재 scope에 실제로 존재하는(재생 가능한) 녹화 id 집합. 진행 중 녹화는 아직 메타 파일이
  // 없으므로(종료 시 기록됨) 별도로 포함해 hasReplay가 성급히 꺼지지 않게 한다.
  listExistingRecordingIds(): Set<string> {
    const ids = new Set<string>();
    const scope = this.activeScope;
    if (scope && existsSync(scope.replayDirectoryPath)) {
      for (const fileName of readdirSync(scope.replayDirectoryPath)) {
        if (fileName.endsWith(META_SUFFIX)) {
          ids.add(fileName.slice(0, -META_SUFFIX.length));
        }
      }
    }
    for (const active of this.activeRecordings.values()) {
      ids.add(active.recordingId);
    }
    return ids;
  }

  setOnRecordingsPruned(handler: () => void): void {
    this.onRecordingsPruned = handler;
  }

  // 현재 scope의 리플레이 디렉토리가 디스크에서 차지하는 용량(설정 화면 표시용).
  // meta/events 파일 합산이며, 프루닝과 경합해 파일이 사라질 수 있어 stat 실패는 건너뛴다.
  getStorageUsage(): SessionReplayStorageUsage {
    const scope = this.activeScope;
    if (!scope || !existsSync(scope.replayDirectoryPath)) {
      return { totalBytes: 0, recordingCount: 0 };
    }
    let totalBytes = 0;
    for (const fileName of readdirSync(scope.replayDirectoryPath)) {
      if (
        !fileName.endsWith(META_SUFFIX) &&
        !fileName.endsWith(EVENTS_SUFFIX) &&
        !fileName.endsWith(EVENTS_GZIP_SUFFIX)
      ) {
        continue;
      }
      try {
        totalBytes += statSync(
          path.join(scope.replayDirectoryPath, fileName),
        ).size;
      } catch {
        continue;
      }
    }
    return {
      totalBytes,
      recordingCount: this.listExistingRecordingIds().size,
    };
  }

  private startRecording(sessionId: string): void {
    const scope = this.activeScope;
    if (!scope || this.activeRecordings.has(sessionId)) {
      return;
    }

    const lifecycle = this.coreManager.getSessionLifecycleState(sessionId);
    if (!lifecycle?.connectedAt || !lifecycle.connectionKind) {
      return;
    }

    const recordingId = randomUUID();
    const initialSize = this.initialSizeBySession.get(sessionId) ?? {
      cols: DEFAULT_REPLAY_COLS,
      rows: DEFAULT_REPLAY_ROWS,
    };

    this.ensureReplayDirectory(scope.replayDirectoryPath);

    const active: ActiveRecording = {
      recordingId,
      sessionId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      title: lifecycle.title,
      connectionDetails: lifecycle.connectionDetails,
      connectionKind: lifecycle.connectionKind,
      connectedAt: lifecycle.connectedAt,
      connectedAtMs: new Date(lifecycle.connectedAt).getTime(),
      initialCols: initialSize.cols,
      initialRows: initialSize.rows,
      replayDirectoryPath: scope.replayDirectoryPath,
      events: null,
      eventsDirty: false,
    };
    active.events = this.openEventsStream(active);

    this.activeRecordings.set(sessionId, active);
    this.coreManager.attachSessionRecording(sessionId, recordingId);
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushEventStreams(), EVENTS_FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  private openEventsStream(active: ActiveRecording): Gzip {
    const events = createGzip({ level: EVENTS_GZIP_LEVEL });
    // 파일은 지금 연다. 스트림에 경로만 주면 다음 틱에야 열려서, 녹화가 시작된 직후에는 파일이 없고 그
    // 사이 폴더가 지워지면 늦게 실패한다.
    const eventsPath = this.getEventsGzipPath(active.recordingId, active.replayDirectoryPath);
    const file = createWriteStream(eventsPath, { fd: openSync(eventsPath, "w") });
    const done = new Promise<void>((resolve) => {
      pipeline(events, file, (error) => {
        if (error) {
          // 디스크가 가득 찼거나 파일을 쓸 수 없다. 출력 경로로 예외를 올리지 않고 이 녹화만 멈춘다.
          console.warn("[session-replay] stopped recording after a write failure", error);
          if (active.events === events) {
            active.events = null;
          }
        }
        if (this.eventStreamsDone.get(active.recordingId) === done) {
          this.eventStreamsDone.delete(active.recordingId);
        }
        resolve();
      });
    });
    this.eventStreamsDone.set(active.recordingId, done);
    return events;
  }

  private flushEventStreams(): void {
    for (const active of this.activeRecordings.values()) {
      if (active.eventsDirty && active.events && !active.events.destroyed) {
        active.eventsDirty = false;
        active.events.flush(zlibConstants.Z_SYNC_FLUSH);
      }
    }
    if (this.activeRecordings.size === 0 && this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private finalizeRecording(
    sessionId: string,
    _disconnectReason: string | null,
  ): void {
    const active = this.activeRecordings.get(sessionId);
    if (!active) {
      this.initialSizeBySession.delete(sessionId);
      return;
    }

    const disconnectedAt = nowIso();
    const durationMs = Math.max(
      0,
      new Date(disconnectedAt).getTime() - active.connectedAtMs,
    );

    const meta: SessionReplayRecordingMeta = {
      recordingId: active.recordingId,
      sessionId: active.sessionId,
      hostId: active.hostId,
      hostLabel: active.hostLabel,
      title: active.title,
      connectionDetails: active.connectionDetails,
      connectionKind: active.connectionKind,
      connectedAt: active.connectedAt,
      disconnectedAt,
      durationMs,
      initialCols: active.initialCols,
      initialRows: active.initialRows,
    };

    this.closeEventsStream(active);
    writeFileSync(
      this.getMetaPath(active.recordingId, active.replayDirectoryPath),
      JSON.stringify(meta, null, 2),
      "utf8",
    );

    this.activeRecordings.delete(sessionId);
    this.initialSizeBySession.delete(sessionId);
    this.pruneDirectory(active.replayDirectoryPath);
  }

  private appendEntry(active: ActiveRecording, entry: SessionReplayEntry): void {
    const events = active.events;
    if (!events || events.destroyed || events.writableEnded) {
      return;
    }
    events.write(`${JSON.stringify(entry)}\n`);
    active.eventsDirty = true;
  }

  // 남은 것을 압축해 파일에 쓰고 닫는다. 다 쓰이면 eventStreamsDone 의 약속이 풀린다.
  private closeEventsStream(active: ActiveRecording): void {
    const events = active.events;
    active.events = null;
    if (events && !events.destroyed && !events.writableEnded) {
      events.end();
    }
  }

  private listRecordingMeta(
    replayDirectoryPath: string,
  ): SessionReplayRecordingMeta[] {
    this.ensureReplayDirectory(replayDirectoryPath);
    return readdirSync(replayDirectoryPath)
      .map((fileName) => parseRecordingId(fileName))
      .filter((recordingId): recordingId is string => Boolean(recordingId))
      .map((recordingId) => {
        try {
          return this.loadRecordingMeta(recordingId, replayDirectoryPath);
        } catch {
          return null;
        }
      })
      .filter(
        (recording): recording is SessionReplayRecordingMeta =>
          recording !== null,
      );
  }

  private loadRecordingMeta(
    recordingId: string,
    replayDirectoryPath: string,
  ): SessionReplayRecordingMeta {
    const raw = JSON.parse(
      readFileSync(this.getMetaPath(recordingId, replayDirectoryPath), "utf8"),
    ) as SessionReplayRecordingMeta;
    return raw;
  }

  private resolveRetentionCount(): number {
    return clampRetentionCount(
      this.settingsRepository.get().sessionReplayRetentionCount ??
        DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
    );
  }

  private ensureReplayDirectory(replayDirectoryPath: string): void {
    mkdirSync(replayDirectoryPath, { recursive: true });
  }

  private requireActiveScope(): LocalHistoryScope {
    if (!this.activeScope) {
      throw new Error(t('replaySvc.ownerOnly'));
    }
    return this.activeScope;
  }

  private getMetaPath(
    recordingId: string,
    replayDirectoryPath: string,
  ): string {
    return path.join(replayDirectoryPath, `${recordingId}${META_SUFFIX}`);
  }

  private getEventsPath(
    recordingId: string,
    replayDirectoryPath: string,
  ): string {
    return path.join(
      replayDirectoryPath,
      `${recordingId}${EVENTS_SUFFIX}`,
    );
  }

  private getEventsGzipPath(
    recordingId: string,
    replayDirectoryPath: string,
  ): string {
    return path.join(
      replayDirectoryPath,
      `${recordingId}${EVENTS_GZIP_SUFFIX}`,
    );
  }

  private migrateLegacyRecordings(scope: LocalHistoryScope): void {
    if (!existsSync(scope.legacyReplayDirectoryPath)) {
      return;
    }

    this.ensureReplayDirectory(scope.replayDirectoryPath);
    for (const fileName of readdirSync(scope.legacyReplayDirectoryPath)) {
      if (!fileName.endsWith(META_SUFFIX) && !fileName.endsWith(EVENTS_SUFFIX)) {
        continue;
      }
      const sourcePath = path.join(scope.legacyReplayDirectoryPath, fileName);
      const targetPath = path.join(scope.replayDirectoryPath, fileName);
      if (existsSync(targetPath)) {
        rmSync(sourcePath, { force: true });
        continue;
      }
      renameSync(sourcePath, targetPath);
    }

    if (readdirSync(scope.legacyReplayDirectoryPath).length === 0) {
      rmdirSync(scope.legacyReplayDirectoryPath);
    }
  }

  private closeReplayWindows(): void {
    for (const replayWindow of this.replayWindows.values()) {
      if (!replayWindow.isDestroyed()) {
        replayWindow.close();
      }
    }
    this.replayWindows.clear();
  }

  private buildReplayWindowTitle(title: string): string {
    const normalized = title.trim();
    return normalized ? t('replaySvc.titleWith', { title: normalized }) : t('replaySvc.title');
  }

  private async loadReplayWindow(
    replayWindow: BrowserWindow,
    recordingId: string,
  ): Promise<void> {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const targetUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      targetUrl.searchParams.set("window", "session-replay");
      targetUrl.searchParams.set(APP_LOCALE_QUERY_PARAM, getMainLocale());
      targetUrl.searchParams.set("recordingId", recordingId);
      await replayWindow.loadURL(targetUrl.toString());
      return;
    }

    await replayWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      {
        query: {
          window: "session-replay",
          recordingId,
          [APP_LOCALE_QUERY_PARAM]: getMainLocale(),
        },
      },
    );
  }
}
