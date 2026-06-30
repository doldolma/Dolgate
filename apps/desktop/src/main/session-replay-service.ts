import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow } from "electron";
import type {
  CoreEvent,
  SessionReplayEntry,
  SessionReplayRecording,
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

const META_SUFFIX = ".meta.json";
const EVENTS_SUFFIX = ".events.jsonl";
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
    this.shutdown();
    this.closeReplayWindows();
    this.activeScope = null;
    this.initialSizeBySession.clear();
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

  shutdown(): void {
    for (const sessionId of Array.from(this.activeRecordings.keys())) {
      this.finalizeRecording(
        sessionId,
        "앱 종료로 세션이 정리되었습니다.",
      );
    }
  }

  async openReplayWindow(
    recordingId: string,
    _sourceWindow: BrowserWindow,
  ): Promise<void> {
    this.requireActiveScope();
    const existingWindow = this.replayWindows.get(recordingId);
    if (existingWindow && !existingWindow.isDestroyed()) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
      return;
    }

    const recording = this.get(recordingId);
    const replayWindow = new BrowserWindow({
      width: 1040,
      height: 760,
      minWidth: 900,
      minHeight: 620,
      show: false,
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

  get(recordingId: string): SessionReplayRecording {
    const scope = this.requireActiveScope();
    const meta = this.loadRecordingMeta(recordingId, scope.replayDirectoryPath);
    const eventsPath = this.getEventsPath(
      recordingId,
      scope.replayDirectoryPath,
    );
    const entries = existsSync(eventsPath)
      ? decodeRecordingEntries(readFileSync(eventsPath, "utf8"))
      : [];
    return {
      ...meta,
      entries,
    };
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
    writeFileSync(
      this.getEventsPath(recordingId, scope.replayDirectoryPath),
      "",
      "utf8",
    );

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
    };

    this.activeRecordings.set(sessionId, active);
    this.coreManager.attachSessionRecording(sessionId, recordingId);
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
    appendFileSync(
      this.getEventsPath(active.recordingId, active.replayDirectoryPath),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
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
      throw new Error("로그인된 계정의 Replay만 열 수 있습니다.");
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
    return normalized ? `세션 Replay · ${normalized}` : "세션 Replay";
  }

  private async loadReplayWindow(
    replayWindow: BrowserWindow,
    recordingId: string,
  ): Promise<void> {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const targetUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      targetUrl.searchParams.set("window", "session-replay");
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
        },
      },
    );
  }
}
