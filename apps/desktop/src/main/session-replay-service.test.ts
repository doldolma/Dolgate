import os from "node:os";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import { SessionReplayService } from "./session-replay-service";
import { resolveLocalHistoryScope } from "./local-history-scope";

const TEST_HISTORY_OWNER = {
  userId: "user-1",
  serverUrl: "https://ssh.doldolma.com",
};

function activateService(service: SessionReplayService): SessionReplayService {
  service.activate(TEST_HISTORY_OWNER);
  return service;
}

function createLifecycleState(
  overrides: Partial<{
    hostId: string;
    hostLabel: string;
    title: string;
    connectionDetails: string | null;
    connectionKind:
      | "local"
      | "ssh"
      | "aws-ssm"
      | "warpgate"
      | "aws-ecs-exec"
      | "serial";
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

  // 출력 조각마다 평문 파일을 열고-쓰고-닫으면 쏟아질 때 초당 수만 번이 메인 프로세스 시간의 대부분을
  // 먹었다. 녹화는 열어 둔 gzip 스트림 하나에 이어 쓰고, 끝난 직후에 열어도 끝까지 읽혀야 한다.
  it("streams a recording into one gzip file and reads all of it right after it ends", async () => {
    const coreManager = {
      getSessionLifecycleState: vi.fn(() => createLifecycleState()),
      attachSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = activateService(
      new SessionReplayService(settingsRepository as never, coreManager as never),
    );
    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];

    for (let index = 0; index < 500; index += 1) {
      service.handleTerminalStream("session-1", new Uint8Array(Buffer.from(`line ${index}\n`)));
    }
    service.handleTerminalResize("session-1", 100, 30);
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    const replay = await service.get(recordingId);
    expect(replay.entries).toHaveLength(501);
    const lastOutput = replay.entries[499];
    expect(
      lastOutput?.type === "output" ? Buffer.from(lastOutput.dataBase64, "base64").toString() : null,
    ).toBe("line 499\n");

    const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const files = readdirSync(replayDirectoryPath);
    expect(files).toContain(`${recordingId}.events.jsonl.gz`);
    expect(files).not.toContain(`${recordingId}.events.jsonl`);
    const raw = readFileSync(path.join(replayDirectoryPath, `${recordingId}.events.jsonl.gz`));
    expect([...raw.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  });

  // 녹화 중에도 주기적으로 압축기를 비워서, 그 사이 앱이 죽어도 비운 지점까지의 출력은 파일에 남는다.
  it("flushes an active recording so its output survives a crash", async () => {
    vi.useRealTimers();
    const coreManager = {
      getSessionLifecycleState: vi.fn(() => createLifecycleState()),
      attachSessionRecording: vi.fn(),
    };
    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
        coreManager as never,
      ),
    );
    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
    for (let index = 0; index < 10; index += 1) {
      service.handleTerminalStream("session-1", new Uint8Array(Buffer.from(`line ${index}\n`)));
    }

    // 끝내지 않은 채(마무리 없음) 파일만 읽는다 — 죽은 앱이 남긴 파일과 같다.
    const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const eventsPath = path.join(replayDirectoryPath, `${recordingId}.events.jsonl.gz`);
    await vi.waitFor(
      () => {
        const text = gunzipSync(readFileSync(eventsPath), {
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        }).toString();
        expect(text.split("\n").filter(Boolean)).toHaveLength(10);
      },
      { timeout: 3000, interval: 100 },
    );
    await service.shutdown();
  });

  // 앱이 비정상 종료되면 gzip 마무리(trailer)가 없다. 그래도 마지막으로 비운 지점까지는 읽혀야 한다.
  it("reads a gzip recording that was cut off before it was finished", async () => {
    const coreManager = {
      getSessionLifecycleState: vi.fn(() => null),
      attachSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = activateService(
      new SessionReplayService(settingsRepository as never, coreManager as never),
    );
    const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    mkdirSync(replayDirectoryPath, { recursive: true });
    const recordingId = "cut-off";
    writeFileSync(
      path.join(replayDirectoryPath, `${recordingId}.meta.json`),
      JSON.stringify({
        recordingId,
        sessionId: "session-1",
        hostId: "host-1",
        hostLabel: "nas",
        title: "NAS",
        connectionDetails: null,
        connectionKind: "ssh",
        connectedAt: "2026-03-29T00:00:00.000Z",
        disconnectedAt: "2026-03-29T00:00:05.000Z",
        durationMs: 5000,
        initialCols: 120,
        initialRows: 32,
      }),
    );
    const lines = Array.from({ length: 50 }, (_, index) =>
      JSON.stringify({ type: "output", atMs: index, dataBase64: Buffer.from(`l${index}`).toString("base64") }),
    ).join("\n");
    // 비운(sync flush) 지점에서 끝나고 마무리가 없는 스트림 — 비정상 종료한 녹화와 같다.
    writeFileSync(
      path.join(replayDirectoryPath, `${recordingId}.events.jsonl.gz`),
      gzipSync(`${lines}\n`, { finishFlush: zlibConstants.Z_SYNC_FLUSH }),
    );

    expect((await service.get(recordingId)).entries).toHaveLength(50);
  });

  it("records remote session output and resize events, then persists a replay on close", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = activateService(
      new SessionReplayService(settingsRepository as never, coreManager as never),
    );

    service.noteSessionConfigured("session-1", 132, 44);
    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);

    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
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

    const replay = await service.get(recordingId);
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

  it.each([
    ["local", "Local Terminal", "Terminal"],
    ["aws-ecs-exec", "prod", "prod · api · web"],
  ] as const)(
    "records %s process-backed terminal output with the shared replay flow",
    async (connectionKind, hostLabel, title) => {
      const lifecycleStates = new Map<
        string,
        ReturnType<typeof createLifecycleState>
      >([
        [
          "session-1",
          createLifecycleState({ connectionKind, hostLabel, title }),
        ],
      ]);
      const coreManager = {
        getSessionLifecycleState: vi.fn((sessionId: string) =>
          lifecycleStates.get(sessionId) ?? null,
        ),
        attachSessionRecording: vi.fn(),
      };
      const service = activateService(
        new SessionReplayService(
          { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
          coreManager as never,
        ),
      );

      service.noteSessionConfigured("session-1", 132, 44);
      service.handleTerminalEvent({
        type: "connected",
        sessionId: "session-1",
        payload: { status: "connected" },
      } as never);
      const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
      vi.setSystemTime(new Date("2026-03-29T00:00:00.500Z"));
      service.handleTerminalStream(
        "session-1",
        new Uint8Array(Buffer.from("output\n", "utf8")),
      );
      vi.setSystemTime(new Date("2026-03-29T00:00:01.000Z"));
      service.handleTerminalResize("session-1", 140, 48);
      service.handleTerminalEvent({
        type: "closed",
        sessionId: "session-1",
        payload: { message: "closed" },
      } as never);

      expect(await service.get(recordingId)).toMatchObject({
        recordingId,
        hostLabel,
        title,
        connectionKind,
        initialCols: 132,
        initialRows: 44,
        entries: [
          expect.objectContaining({ type: "output", atMs: 500 }),
          expect.objectContaining({ type: "resize", cols: 140, rows: 48 }),
        ],
      });
    },
  );

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
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 10 })),
    };
    const service = activateService(
      new SessionReplayService(settingsRepository as never, coreManager as never),
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
        coreManager.attachSessionRecording.mock.calls[index]?.[1],
      );
      vi.setSystemTime(new Date(`2026-03-29T00:${minute}:03.000Z`));
      service.handleTerminalEvent({
        type: "closed",
        sessionId,
        payload: { message: "closed" },
      } as never);
    }

    const replayDir = resolveLocalHistoryScope(TEST_HISTORY_OWNER).replayDirectoryPath;
    const firstRecordingId = recordingIds[0]!;
    const lastRecordingId = recordingIds[10]!;
    expect(existsSync(path.join(replayDir, `${firstRecordingId}.meta.json`))).toBe(false);
    expect(existsSync(path.join(replayDir, `${firstRecordingId}.events.jsonl.gz`))).toBe(false);
    expect(existsSync(path.join(replayDir, `${lastRecordingId}.meta.json`))).toBe(true);
    expect(existsSync(path.join(replayDir, `${lastRecordingId}.events.jsonl.gz`))).toBe(true);
  });

  it("opens a replay window with the session replay route and recording id in dev", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = activateService(
      new SessionReplayService(settingsRepository as never, coreManager as never),
    );

    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
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
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = activateService(
      new SessionReplayService(settingsRepository as never, coreManager as never),
    );

    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
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
    // 로케일은 메인이 정해 URL 로 넘긴다 — 렌더러가 첫 프레임부터 같은 언어로 그린다.
    expect(browserWindowInstances[0]?.loadedFileQuery).toEqual({
      window: "session-replay",
      recordingId,
      locale: "ko",
    });
  });

  it("finalizes active recordings during shutdown so replay can still open after app quit", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const settingsRepository = {
      get: vi.fn(() => ({ sessionReplayRetentionCount: 100 })),
    };
    const service = activateService(
      new SessionReplayService(settingsRepository as never, coreManager as never),
    );

    service.noteSessionConfigured("session-1", 132, 44);
    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);

    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
    expect(typeof recordingId).toBe("string");

    vi.setSystemTime(new Date("2026-03-29T00:00:01.000Z"));
    service.handleTerminalStream(
      "session-1",
      new Uint8Array(Buffer.from("hello\n", "utf8")),
    );

    service.shutdown();

    const replay = await service.get(recordingId);
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

  it("isolates replay access by account and keeps an active recording in its starting scope", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
        coreManager as never,
      ),
    );

    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];

    service.activate({
      userId: "user-2",
      serverUrl: TEST_HISTORY_OWNER.serverUrl,
    });
    vi.setSystemTime(new Date("2026-03-29T00:00:01.000Z"));
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    await expect(service.get(recordingId)).rejects.toThrow();
    service.activate(TEST_HISTORY_OWNER);
    expect(await service.get(recordingId)).toMatchObject({
      recordingId,
      sessionId: "session-1",
    });
  });

  it("migrates legacy replay files into the first activated account", async () => {
    const scope = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const recordingId = "legacy-recording";
    mkdirSync(scope.legacyReplayDirectoryPath, { recursive: true });
    writeFileSync(
      path.join(scope.legacyReplayDirectoryPath, `${recordingId}.meta.json`),
      JSON.stringify({
        recordingId,
        sessionId: "legacy-session",
        hostId: "legacy-host",
        hostLabel: "legacy",
        title: "Legacy",
        connectionDetails: null,
        connectionKind: "ssh",
        connectedAt: "2026-03-29T00:00:00.000Z",
        disconnectedAt: "2026-03-29T00:00:01.000Z",
        durationMs: 1000,
        initialCols: 120,
        initialRows: 32,
      }),
      "utf8",
    );
    writeFileSync(
      path.join(scope.legacyReplayDirectoryPath, `${recordingId}.events.jsonl`),
      `${JSON.stringify({
        type: "output",
        atMs: 100,
        dataBase64: Buffer.from("legacy").toString("base64"),
      })}\n`,
      "utf8",
    );

    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
        {
          getSessionLifecycleState: vi.fn(),
          attachSessionRecording: vi.fn(),
        } as never,
      ),
    );

    expect(await service.get(recordingId)).toMatchObject({
      recordingId,
      sessionId: "legacy-session",
      entries: [expect.objectContaining({ type: "output", atMs: 100 })],
    });
    expect(existsSync(scope.legacyReplayDirectoryPath)).toBe(false);
    expect(
      existsSync(path.join(scope.replayDirectoryPath, `${recordingId}.meta.json`)),
    ).toBe(true);
  });

  it("keeps scoped replay files when a partial legacy migration has matching files", async () => {
    const scope = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const recordingId = "partially-migrated-recording";
    const createMeta = (sessionId: string) => ({
      recordingId,
      sessionId,
      hostId: "host-1",
      hostLabel: "host",
      title: "Replay",
      connectionDetails: null,
      connectionKind: "ssh",
      connectedAt: "2026-03-29T00:00:00.000Z",
      disconnectedAt: "2026-03-29T00:00:01.000Z",
      durationMs: 1000,
      initialCols: 120,
      initialRows: 32,
    });
    mkdirSync(scope.legacyReplayDirectoryPath, { recursive: true });
    mkdirSync(scope.replayDirectoryPath, { recursive: true });
    writeFileSync(
      path.join(scope.legacyReplayDirectoryPath, `${recordingId}.meta.json`),
      JSON.stringify(createMeta("legacy-session")),
      "utf8",
    );
    writeFileSync(
      path.join(scope.replayDirectoryPath, `${recordingId}.meta.json`),
      JSON.stringify(createMeta("scoped-session")),
      "utf8",
    );

    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
        {
          getSessionLifecycleState: vi.fn(),
          attachSessionRecording: vi.fn(),
        } as never,
      ),
    );

    expect((await service.get(recordingId)).sessionId).toBe("scoped-session");
    expect(existsSync(scope.legacyReplayDirectoryPath)).toBe(false);
  });

  it("closes replay windows and blocks replay reads after deactivation", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
        coreManager as never,
      ),
    );
    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);
    await service.openReplayWindow(recordingId, {} as never);

    service.deactivate();

    expect(browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    await expect(service.get(recordingId)).rejects.toThrow(
      "로그인된 계정의 Replay만 열 수 있습니다.",
    );
  });

  it("purges every recording file on account deletion (purgeAllRecordings)", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState()],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) =>
        lifecycleStates.get(sessionId) ?? null,
      ),
      attachSessionRecording: vi.fn(),
    };
    const onRecordingsPruned = vi.fn();
    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
        coreManager as never,
      ),
    );
    service.setOnRecordingsPruned(onRecordingsPruned);

    service.handleTerminalEvent({
      type: "connected",
      sessionId: "session-1",
      payload: { status: "connected" },
    } as never);
    const recordingId = coreManager.attachSessionRecording.mock.calls[0]?.[1];
    service.handleTerminalStream(
      "session-1",
      new Uint8Array(Buffer.from("wipe-me\n", "utf8")),
    );
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);
    expect((await service.get(recordingId)).sessionId).toBe("session-1");

    const scope = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    await service.purgeAllRecordings();

    expect(readdirSync(scope.replayDirectoryPath)).toEqual([]);
    expect(service.listExistingRecordingIds().size).toBe(0);
    expect(onRecordingsPruned).toHaveBeenCalled();
    await expect(service.get(recordingId)).rejects.toThrow();
  });
});
