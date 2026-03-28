import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app } from "electron";
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

const STORAGE_DIRNAME = "storage";
const SESSION_REPLAYS_DIRNAME = "session-replays";
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

function resolveUserDataPath(): string {
  const override = process.env.DOLSSH_USER_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  if (app?.getPath) {
    return app.getPath("userData");
  }
  return path.join(process.cwd(), ".tmp", `dolssh-desktop-storage-${process.pid}`);
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

  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly coreManager: CoreManager,
  ) {}

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

  async openReplayWindow(
    recordingId: string,
    sourceWindow: BrowserWindow,
  ): Promise<void> {
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
      const targetUrl = this.buildReplayWindowUrl(sourceWindow, recordingId);
      await replayWindow.loadURL(targetUrl);
    } catch (error) {
      this.replayWindows.delete(recordingId);
      if (!replayWindow.isDestroyed()) {
        replayWindow.close();
      }
      throw error;
    }
  }

  get(recordingId: string): SessionReplayRecording {
    const meta = this.loadRecordingMeta(recordingId);
    const eventsPath = this.getEventsPath(recordingId);
    const entries = existsSync(eventsPath)
      ? decodeRecordingEntries(readFileSync(eventsPath, "utf8"))
      : [];
    return {
      ...meta,
      entries,
    };
  }

  prune(): void {
    const retentionCount = this.resolveRetentionCount();
    const recordings = this.listRecordingMeta().sort((left, right) => {
      const leftKey = left.disconnectedAt || left.connectedAt;
      const rightKey = right.disconnectedAt || right.connectedAt;
      return rightKey.localeCompare(leftKey);
    });

    for (const stale of recordings.slice(retentionCount)) {
      rmSync(this.getMetaPath(stale.recordingId), { force: true });
      rmSync(this.getEventsPath(stale.recordingId), { force: true });
    }
  }

  private startRecording(sessionId: string): void {
    if (this.activeRecordings.has(sessionId)) {
      return;
    }

    const lifecycle = this.coreManager.getRemoteSessionLifecycleState(sessionId);
    if (!lifecycle?.connectedAt || !lifecycle.connectionKind) {
      return;
    }

    const recordingId = randomUUID();
    const initialSize = this.initialSizeBySession.get(sessionId) ?? {
      cols: DEFAULT_REPLAY_COLS,
      rows: DEFAULT_REPLAY_ROWS,
    };

    this.ensureReplayDirectory();
    writeFileSync(this.getEventsPath(recordingId), "", "utf8");

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
    };

    this.activeRecordings.set(sessionId, active);
    this.coreManager.attachRemoteSessionRecording(sessionId, recordingId);
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
      this.getMetaPath(active.recordingId),
      JSON.stringify(meta, null, 2),
      "utf8",
    );

    this.activeRecordings.delete(sessionId);
    this.initialSizeBySession.delete(sessionId);
    this.prune();
  }

  private appendEntry(active: ActiveRecording, entry: SessionReplayEntry): void {
    appendFileSync(
      this.getEventsPath(active.recordingId),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  }

  private listRecordingMeta(): SessionReplayRecordingMeta[] {
    this.ensureReplayDirectory();
    return readdirSync(this.replayDirectoryPath())
      .map((fileName) => parseRecordingId(fileName))
      .filter((recordingId): recordingId is string => Boolean(recordingId))
      .map((recordingId) => {
        try {
          return this.loadRecordingMeta(recordingId);
        } catch {
          return null;
        }
      })
      .filter(
        (recording): recording is SessionReplayRecordingMeta =>
          recording !== null,
      );
  }

  private loadRecordingMeta(recordingId: string): SessionReplayRecordingMeta {
    const raw = JSON.parse(
      readFileSync(this.getMetaPath(recordingId), "utf8"),
    ) as SessionReplayRecordingMeta;
    return raw;
  }

  private resolveRetentionCount(): number {
    return clampRetentionCount(
      this.settingsRepository.get().sessionReplayRetentionCount ??
        DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
    );
  }

  private ensureReplayDirectory(): void {
    mkdirSync(this.replayDirectoryPath(), { recursive: true });
  }

  private replayDirectoryPath(): string {
    return path.join(
      resolveUserDataPath(),
      STORAGE_DIRNAME,
      SESSION_REPLAYS_DIRNAME,
    );
  }

  private getMetaPath(recordingId: string): string {
    return path.join(this.replayDirectoryPath(), `${recordingId}${META_SUFFIX}`);
  }

  private getEventsPath(recordingId: string): string {
    return path.join(
      this.replayDirectoryPath(),
      `${recordingId}${EVENTS_SUFFIX}`,
    );
  }

  private buildReplayWindowTitle(title: string): string {
    const normalized = title.trim();
    return normalized ? `세션 Replay · ${normalized}` : "세션 Replay";
  }

  private buildReplayWindowUrl(
    sourceWindow: BrowserWindow,
    recordingId: string,
  ): string {
    const sourceUrl = sourceWindow.webContents.getURL();
    if (!sourceUrl) {
      throw new Error("Replay 창을 열 기준 URL을 찾지 못했습니다.");
    }

    const targetUrl = new URL(sourceUrl);
    targetUrl.searchParams.set("window", "session-replay");
    targetUrl.searchParams.set("recordingId", recordingId);
    return targetUrl.toString();
  }
}
