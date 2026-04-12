import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { browserWindowInstances } = vi.hoisted(() => ({
  browserWindowInstances: [] as Array<{
    loadedUrl: string | null;
    loadedFile: string | null;
    loadedFileQuery: Record<string, string> | null;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    isMinimized: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
  }>,
}));

let packaged = false;
vi.stubGlobal("MAIN_WINDOW_VITE_DEV_SERVER_URL", "http://localhost:5173/");
vi.stubGlobal("MAIN_WINDOW_VITE_NAME", "main_window");

vi.mock("electron", () => {
  class MockBrowserWindow {
    loadedUrl: string | null = null;
    loadedFile: string | null = null;
    loadedFileQuery: Record<string, string> | null = null;
    show = vi.fn();
    focus = vi.fn();
    close = vi.fn(() => {
      this.emit("closed");
    });
    isDestroyed = vi.fn(() => false);
    isMinimized = vi.fn(() => false);
    restore = vi.fn();
    private readonly listeners = new Map<string, Array<() => void>>();

    constructor() {
      browserWindowInstances.push(this);
    }

    on(event: string, listener: () => void) {
      const current = this.listeners.get(event) ?? [];
      current.push(listener);
      this.listeners.set(event, current);
      return this;
    }

    once(event: string, listener: () => void) {
      const wrapped = () => {
        this.off(event, wrapped);
        listener();
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: () => void) {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        current.filter((entry) => entry !== listener),
      );
      return this;
    }

    emit(event: string) {
      const current = this.listeners.get(event) ?? [];
      for (const listener of current) {
        listener();
      }
      return current.length > 0;
    }

    async loadURL(url: string) {
      this.loadedUrl = url;
    }

    async loadFile(file: string, options?: { query?: Record<string, string> }) {
      this.loadedFile = file;
      this.loadedFileQuery = options?.query ?? null;
    }
  }

  return {
    app: {
      get isPackaged() {
        return packaged;
      },
      getPath: () => "/tmp/dolssh-user-data",
    },
    BrowserWindow: MockBrowserWindow,
  };
});

import { SessionReplayService } from "./session-replay-service";

function createLifecycleState(
  overrides: Partial<{
    hostId: string;
    hostLabel: string;
    title: string;
    connectionDetails: string | null;
    connectionKind: "ssh" | "aws-ssm" | "warpgate" | "serial";
    connectedAt: string;
  }> = {},
) {
  return {
    hostId: overrides.hostId ?? "host-1",
    hostLabel: overrides.hostLabel ?? "nas",
    title: overrides.title ?? "NAS",
    connectionDetails:
      overrides.connectionDetails ?? "doldolma.com · 22 · doyoung",
    connectionKind: overrides.connectionKind ?? "ssh",
    connectedAt:
      overrides.connectedAt ?? "2026-03-29T00:00:00.000Z",
    status: "connected",
    recordingId: null,
    hasReplay: false,
  };
}

describe("SessionReplayService", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "dolsh-session-replay-"));
    process.env.DOLSSH_USER_DATA_DIR = tempDir;
    packaged = false;
    vi.stubGlobal("MAIN_WINDOW_VITE_DEV_SERVER_URL", "http://localhost:5173/");
    vi.stubGlobal("MAIN_WINDOW_VITE_NAME", "main_window");
    browserWindowInstances.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DOLSSH_USER_DATA_DIR;
    rmSync(tempDir, { recursive: true, force: true });
    browserWindowInstances.length = 0;
  });

  it("records remote session output and resize events, then persists a replay on close", () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getRemoteSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachRemoteSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = new SessionReplayService(
      settingsRepository as never,
      coreManager as never,
    );

    service.noteSessionConfigured("session-1", 132, 44);
    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);

    const recordingId = coreManager.attachRemoteSessionRecording.mock.calls[0]?.[1];
    expect(typeof recordingId).toBe("string");

    vi.setSystemTime(new Date("2026-03-29T00:00:00.500Z"));
    service.handleTerminalStream(
      "session-1",
      new Uint8Array(Buffer.from("hello\n", "utf8")),
    );
    vi.setSystemTime(new Date("2026-03-29T00:00:01.000Z"));
    service.handleTerminalResize("session-1", 140, 48);
    vi.setSystemTime(new Date("2026-03-29T00:00:01.500Z"));
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    const replay = service.get(recordingId);
    expect(replay).toMatchObject({
      recordingId,
      sessionId: "session-1",
      hostLabel: "nas",
      connectionKind: "ssh",
      initialCols: 132,
      initialRows: 44,
      durationMs: 1500,
    });
    expect(replay.entries).toHaveLength(2);
    expect(replay.entries[0]).toMatchObject({
      type: "output",
      atMs: 500,
    });
    expect(replay.entries[1]).toMatchObject({
      type: "resize",
      atMs: 1000,
      cols: 140,
      rows: 48,
    });
  });

  it("prunes old recordings using the configured retention count", () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>();
    for (let index = 0; index < 11; index += 1) {
      lifecycleStates.set(
        `session-${index + 1}`,
        createLifecycleState({
          connectedAt: `2026-03-29T00:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }
    const coreManager = {
      getRemoteSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachRemoteSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 10 })),
    };
    const service = new SessionReplayService(
      settingsRepository as never,
      coreManager as never,
    );

    const recordingIds: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const sessionId = `session-${index + 1}`;
      const minute = String(index).padStart(2, "0");
      vi.setSystemTime(new Date(`2026-03-29T00:${minute}:00.000Z`));
      service.handleTerminalEvent({
        type: "connected",
        sessionId,
        payload: { status: "connected" },
      } as never);
      recordingIds.push(
        coreManager.attachRemoteSessionRecording.mock.calls[index]?.[1],
      );
      vi.setSystemTime(new Date(`2026-03-29T00:${minute}:03.000Z`));
      service.handleTerminalEvent({
        type: "closed",
        sessionId,
        payload: { message: "closed" },
      } as never);
    }

    const replayDir = path.join(tempDir, "storage", "session-replays");
    const firstRecordingId = recordingIds[0]!;
    const lastRecordingId = recordingIds[10]!;
    expect(existsSync(path.join(replayDir, `${firstRecordingId}.meta.json`))).toBe(false);
    expect(existsSync(path.join(replayDir, `${firstRecordingId}.events.jsonl`))).toBe(false);
    expect(existsSync(path.join(replayDir, `${lastRecordingId}.meta.json`))).toBe(true);
    expect(existsSync(path.join(replayDir, `${lastRecordingId}.events.jsonl`))).toBe(true);
  });

  it("opens a replay window with the session replay route and recording id in dev", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getRemoteSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachRemoteSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = new SessionReplayService(
      settingsRepository as never,
      coreManager as never,
    );

    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachRemoteSessionRecording.mock.calls[0]?.[1];
    vi.setSystemTime(new Date("2026-03-29T00:00:02.000Z"));
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    const sourceWindow = {
      webContents: {
        getURL: () => "http://localhost:5173/?window=main",
      },
    };

    await service.openReplayWindow(recordingId, sourceWindow as never);

    expect(browserWindowInstances).toHaveLength(1);
    expect(browserWindowInstances[0]?.loadedUrl).toContain("window=session-replay");
    expect(browserWindowInstances[0]?.loadedUrl).toContain(
      `recordingId=${recordingId}`,
    );
  });

  it("loads the bundled renderer file with query params in packaged mode", async () => {
    packaged = true;
    vi.stubGlobal("MAIN_WINDOW_VITE_DEV_SERVER_URL", undefined);

    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getRemoteSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachRemoteSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = new SessionReplayService(
      settingsRepository as never,
      coreManager as never,
    );

    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachRemoteSessionRecording.mock.calls[0]?.[1];
    vi.setSystemTime(new Date("2026-03-29T00:00:02.000Z"));
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    await service.openReplayWindow(recordingId, {} as never);

    expect(browserWindowInstances).toHaveLength(1);
    expect(browserWindowInstances[0]?.loadedUrl).toBeNull();
    expect(browserWindowInstances[0]?.loadedFile).toContain(
      path.join("renderer", "main_window", "index.html"),
    );
    expect(browserWindowInstances[0]?.loadedFileQuery).toEqual({
      window: "session-replay",
      recordingId,
    });
  });

  it("finalizes active recordings during shutdown so replay can still open after app quit", () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getRemoteSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachRemoteSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = new SessionReplayService(
      settingsRepository as never,
      coreManager as never,
    );

    service.noteSessionConfigured("session-1", 132, 44);
    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);

    const recordingId = coreManager.attachRemoteSessionRecording.mock.calls[0]?.[1];
    expect(typeof recordingId).toBe("string");

    vi.setSystemTime(new Date("2026-03-29T00:00:01.000Z"));
    service.handleTerminalStream(
      "session-1",
      new Uint8Array(Buffer.from("hello\n", "utf8")),
    );

    service.shutdown();

    const replay = service.get(recordingId);
    expect(replay).toMatchObject({
      recordingId,
      sessionId: "session-1",
      durationMs: 1000,
    });
    expect(replay.entries).toHaveLength(1);
    expect(replay.entries[0]).toMatchObject({
      type: "output",
      atMs: 1000,
    });
  });
});
