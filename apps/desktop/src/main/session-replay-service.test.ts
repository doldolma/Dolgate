import os from "node:os";
import path from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
import type { SessionReplayEntry } from "@shared";
import { SessionReplayService } from "./session-replay-service";
import { resolveLocalHistoryScope } from "./local-history-scope";

/** 녹화를 재생 창처럼 읽는다: 구간 목록을 받고, 구간마다 항목을 녹화 파일의 꼴로 되돌린다. */
async function readRecording(service: SessionReplayService, recordingId: string) {
  const index = await service.load(recordingId);
  const entries: SessionReplayEntry[] = [];
  for (let segmentIndex = 0; segmentIndex < index.segments.length; segmentIndex += 1) {
    const segment = await service.readSegment(recordingId, segmentIndex);
    for (let entry = 0; entry < segment.atMs.length; entry += 1) {
      if (segment.cols[entry]! > 0) {
        entries.push({
          type: "resize",
          atMs: segment.atMs[entry]!,
          cols: segment.cols[entry]!,
          rows: segment.rows[entry]!,
        });
        continue;
      }
      const start = entry === 0 ? 0 : segment.dataEnd[entry - 1]!;
      entries.push({
        type: "output",
        atMs: segment.atMs[entry]!,
        dataBase64: Buffer.from(segment.data.subarray(start, segment.dataEnd[entry]!)).toString("base64"),
      });
    }
  }
  return { ...index, entries };
}

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

    const replay = await readRecording(service, recordingId);
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

    expect((await readRecording(service, recordingId)).entries).toHaveLength(50);
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

    const replay = await readRecording(service, recordingId);
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

      expect(await readRecording(service, recordingId)).toMatchObject({
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

    const replay = await readRecording(service, recordingId);
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

    await expect(readRecording(service, recordingId)).rejects.toThrow();
    service.activate(TEST_HISTORY_OWNER);
    expect(await readRecording(service, recordingId)).toMatchObject({
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

    expect(await readRecording(service, recordingId)).toMatchObject({
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

    expect((await readRecording(service, recordingId)).sessionId).toBe("scoped-session");
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
    await expect(readRecording(service, recordingId)).rejects.toThrow(
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
    expect((await readRecording(service, recordingId)).sessionId).toBe("session-1");

    const scope = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    await service.purgeAllRecordings();

    expect(readdirSync(scope.replayDirectoryPath)).toEqual([]);
    expect(service.listExistingRecordingIds().size).toBe(0);
    expect(onRecordingsPruned).toHaveBeenCalled();
    await expect(readRecording(service, recordingId)).rejects.toThrow();
  });
  // 재생 창은 녹화를 통째로 받지 않고 구간 단위로 받는다. 출력이 많으면 구간 여럿으로 나뉘어 따로 읽혀야 한다.
  it("splits a long recording into segments the replay window reads one at a time", async () => {
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
    const chunk = new Uint8Array(64 * 1024).map((_, index) => 32 + (index % 90));
    for (let index = 0; index < 48; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 2, 29, 0, 0, 0, index * 10)));
      service.handleTerminalStream("session-1", chunk);
    }
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    const index = await service.load(recordingId);
    expect(index).not.toHaveProperty("entries");
    expect(index.segments.length).toBeGreaterThanOrEqual(3);
    expect(index.segments.reduce((sum, segment) => sum + segment.outputBytes, 0)).toBe(
      48 * chunk.length,
    );
    const second = await service.readSegment(recordingId, 1);
    expect(second.data.length).toBe(index.segments[1]!.outputBytes);
    expect(second.atMs[0]).toBe(index.segments[1]!.startAtMs);
    expect(Array.from(second.data.subarray(0, 4))).toEqual(Array.from(chunk.subarray(0, 4)));
    await expect(service.readSegment(recordingId, index.segments.length)).rejects.toThrow();
    await expect(service.readSegment(recordingId, 0.5)).rejects.toThrow();
  });

  // 녹화 중 시스템 시계가 뒤로 가도 항목 시각은 줄지 않는다(재생은 시각 순서를 믿는다).
  it("keeps entry times in order when the system clock moves back", async () => {
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
    for (const [time, text] of [
      ["2026-03-29T00:00:05.000Z", "a"],
      ["2026-03-29T00:00:02.000Z", "b"],
      ["2026-03-29T00:00:06.000Z", "c"],
    ] as const) {
      vi.setSystemTime(new Date(time));
      service.handleTerminalStream("session-1", new Uint8Array(Buffer.from(text)));
    }
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    const replay = await readRecording(service, recordingId);
    expect(replay.entries.map((entry) => entry.atMs)).toEqual([5000, 5000, 6000]);
  });

  it("counts and removes the segment index together with the rest of a recording", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState({ connectedAt: "2026-03-29T00:00:00.000Z" })],
      ["session-2", createLifecycleState({ connectedAt: "2026-03-29T00:01:00.000Z" })],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) => lifecycleStates.get(sessionId) ?? null),
      attachSessionRecording: vi.fn(),
    };
    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 1 }) } as never,
        coreManager as never,
      ),
    );
    const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const recordingIds: string[] = [];
    for (const [sessionId, minute] of [
      ["session-1", "00"],
      ["session-2", "01"],
    ] as const) {
      vi.setSystemTime(new Date(`2026-03-29T00:${minute}:00.000Z`));
      service.handleTerminalEvent({
        type: "connected",
        sessionId,
        payload: { status: "connected" },
      } as never);
      recordingIds.push(coreManager.attachSessionRecording.mock.calls.at(-1)?.[1]);
      service.handleTerminalStream(sessionId, new Uint8Array(Buffer.from(`${sessionId}\n`)));
      vi.setSystemTime(new Date(`2026-03-29T00:${minute}:03.000Z`));
      service.handleTerminalEvent({
        type: "closed",
        sessionId,
        payload: { message: "closed" },
      } as never);
      // 색인은 녹화 파일이 다 쓰인 뒤에 마지막 줄이 붙는다.
      await service.load(recordingIds.at(-1)!);
    }

    const [first, second] = recordingIds;
    expect(existsSync(path.join(replayDirectoryPath, `${first}.index.jsonl`))).toBe(false);
    expect(existsSync(path.join(replayDirectoryPath, `${second}.index.jsonl`))).toBe(true);
    const expectedBytes = [".meta.json", ".events.jsonl.gz", ".index.jsonl"]
      .map((suffix) => statSync(path.join(replayDirectoryPath, `${second}${suffix}`)).size)
      .reduce((sum, size) => sum + size, 0);
    expect(service.getStorageUsage()).toEqual({ totalBytes: expectedBytes, recordingCount: 1 });
  });

  // 녹화 중 시계가 뒤로 가고 그 시간이 다 지나기 전에 세션이 끝나면, 벽시계로 잰 길이가 마지막 항목보다
  // 짧았다. 재생은 길이 너머를 그리지 않아 끝부분이 안 보였다(시계가 세션 길이보다 많이 가면 길이 0 —
  // 녹화 전체가 빈 화면). 쓸 때도 읽을 때도 마지막 항목까지를 길이로 본다.
  it("plays up to the last entry when the clock moved back before the session ended", async () => {
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
    vi.setSystemTime(new Date("2026-03-29T00:00:05.000Z"));
    service.handleTerminalStream("session-1", new Uint8Array(Buffer.from("a")));
    vi.setSystemTime(new Date("2026-03-29T00:00:02.000Z"));
    service.handleTerminalStream("session-1", new Uint8Array(Buffer.from("b")));
    vi.setSystemTime(new Date("2026-03-29T00:00:03.000Z"));
    service.handleTerminalEvent({
      type: "closed",
      sessionId: "session-1",
      payload: { message: "closed" },
    } as never);

    expect((await service.load(recordingId)).durationMs).toBe(5000);

    // 이 수정 전에 만든 녹화(메타의 길이가 짧은 것)도 읽을 때 맞춘다.
    const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const metaPath = path.join(replayDirectoryPath, `${recordingId}.meta.json`);
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), durationMs: 0 }));
    expect((await service.load(recordingId)).durationMs).toBe(5000);
  });

  // 재생기는 구간을 그때그때 읽는다. 재생 창을 연 채 보존 한도 밖으로 밀린 녹화를 지우면 그 창이 엉뚱한
  // 화면에서 멈췄다(실측). 창이 열려 있는 동안은 남기고, 창을 닫으면 지운다.
  it("keeps a recording open in a replay window out of pruning until the window closes", async () => {
    const lifecycleStates = new Map<string, ReturnType<typeof createLifecycleState>>([
      ["session-1", createLifecycleState({ connectedAt: "2026-03-29T00:00:00.000Z" })],
      ["session-2", createLifecycleState({ connectedAt: "2026-03-29T00:01:00.000Z" })],
    ]);
    const coreManager = {
      getSessionLifecycleState: vi.fn((sessionId: string) => lifecycleStates.get(sessionId) ?? null),
      attachSessionRecording: vi.fn(),
    };
    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 1 }) } as never,
        coreManager as never,
      ),
    );
    const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const record = (sessionId: string, minute: string) => {
      vi.setSystemTime(new Date(`2026-03-29T00:${minute}:00.000Z`));
      service.handleTerminalEvent({
        type: "connected",
        sessionId,
        payload: { status: "connected" },
      } as never);
      const recordingId = coreManager.attachSessionRecording.mock.calls.at(-1)?.[1] as string;
      service.handleTerminalStream(sessionId, new Uint8Array(Buffer.from(`${sessionId}\n`)));
      vi.setSystemTime(new Date(`2026-03-29T00:${minute}:03.000Z`));
      service.handleTerminalEvent({
        type: "closed",
        sessionId,
        payload: { message: "closed" },
      } as never);
      return recordingId;
    };

    const first = record("session-1", "00");
    await service.openReplayWindow(first, {} as never);
    record("session-2", "01");
    const firstMeta = path.join(replayDirectoryPath, `${first}.meta.json`);
    expect(existsSync(firstMeta)).toBe(true);
    expect((await readRecording(service, first)).entries).toHaveLength(1);

    browserWindowInstances[0]!.close();
    expect(existsSync(firstMeta)).toBe(false);
    expect(existsSync(path.join(replayDirectoryPath, `${first}.events.jsonl.gz`))).toBe(false);
  });

  // 옛 녹화를 바꿔 쓰는 동안 로그아웃했다 다시 들어와 같은 녹화를 열면, 두 번째 변환이 같은 임시 파일로
  // 시작해 하나가 "ENOENT … rename" 으로 실패했다(실측). 진행 중인 변환을 기다려야 한다.
  it("waits for an old recording's rewrite across logout and login instead of starting a second one", async () => {
    const service = activateService(
      new SessionReplayService(
        { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
        { getSessionLifecycleState: vi.fn(), attachSessionRecording: vi.fn() } as never,
      ),
    );
    const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const recordingId = "00000000-0000-4000-8000-000000000001";
    writeLegacyRecording(
      replayDirectoryPath,
      recordingId,
      Array.from({ length: 4000 }, (_, index) => ({
        type: "output",
        atMs: index,
        dataBase64: Buffer.from(`${index} `.repeat(200)).toString("base64"),
      })),
    );

    const first = service.load(recordingId);
    // 첫 load 가 변환을 시작할 때까지(색인을 기다리는 await 하나를 넘긴다).
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve();
    }
    service.deactivate();
    service.activate(TEST_HISTORY_OWNER);
    const second = service.load(recordingId);

    const [firstIndex, secondIndex] = await Promise.all([first, second]);
    expect(secondIndex.segments).toEqual(firstIndex.segments);
    expect(readdirSync(replayDirectoryPath).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(path.join(replayDirectoryPath, `${recordingId}.events.jsonl`))).toBe(false);
    expect((await readRecording(service, recordingId)).entries).toHaveLength(4000);
  });

  // 폴더에 쓸 수 없으면 옛 녹화를 바꿔 쓰지 못한다. 그래도 원래 파일에서 읽어 연다 — 서비스가 그 구간을
  // 옛 파일에서 읽는지(경로 고르기)까지 본다.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "opens an old recording in place when its folder cannot be written",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const service = activateService(
        new SessionReplayService(
          { get: () => ({ sessionReplayRetentionCount: 100 }) } as never,
          { getSessionLifecycleState: vi.fn(), attachSessionRecording: vi.fn() } as never,
        ),
      );
      const { replayDirectoryPath } = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
      const recordingId = "00000000-0000-4000-8000-000000000002";
      writeLegacyRecording(replayDirectoryPath, recordingId, [
        { type: "output", atMs: 5, dataBase64: Buffer.from("legacy").toString("base64") },
        { type: "resize", atMs: 7, cols: 90, rows: 20 },
      ]);
      chmodSync(replayDirectoryPath, 0o555);
      try {
        const replay = await readRecording(service, recordingId);
        expect(replay.entries).toEqual([
          { type: "output", atMs: 5, dataBase64: Buffer.from("legacy").toString("base64") },
          { type: "resize", atMs: 7, cols: 90, rows: 20 },
        ]);
      } finally {
        chmodSync(replayDirectoryPath, 0o755);
      }
      expect(existsSync(path.join(replayDirectoryPath, `${recordingId}.events.jsonl`))).toBe(true);
      expect(readdirSync(replayDirectoryPath).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );
});

/** 이 형식 전의 녹화(.events.jsonl, 압축·색인 없음)를 만든다. */
function writeLegacyRecording(
  replayDirectoryPath: string,
  recordingId: string,
  entries: SessionReplayEntry[],
): void {
  mkdirSync(replayDirectoryPath, { recursive: true });
  writeFileSync(
    path.join(replayDirectoryPath, `${recordingId}.events.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  writeFileSync(
    path.join(replayDirectoryPath, `${recordingId}.meta.json`),
    JSON.stringify({
      recordingId,
      sessionId: "session-legacy",
      hostId: "host-1",
      hostLabel: "nas",
      title: "NAS",
      connectionDetails: null,
      connectionKind: "ssh",
      connectedAt: "2026-03-28T00:00:00.000Z",
      disconnectedAt: "2026-03-28T00:01:00.000Z",
      durationMs: 60_000,
      initialCols: 120,
      initialRows: 32,
    }),
  );
}
