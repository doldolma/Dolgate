import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityLogRecord,
  ContainerActionLogMetadata,
  ContainerLifecycleLogMetadata,
  CoreEvent,
  CoreRequest,
  SessionLifecycleLogMetadata,
} from "@shared";
import { encodeControlFrame, encodeStreamFrame } from "./core-framing";
import { ipcChannels } from "../common/ipc-channels";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/dolssh",
    isPackaged: false,
  },
  BrowserWindow: class {},
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { CoreManager } from "./core-manager";

function decodeControlFrame(
  buffer: Buffer,
): CoreRequest<Record<string, unknown>> {
  const metadataLength = buffer.readUInt32BE(1);
  return JSON.parse(
    buffer.subarray(9, 9 + metadataLength).toString("utf8"),
  ) as CoreRequest<Record<string, unknown>>;
}

function createFakeChildProcess() {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();

  const writes: Buffer[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };

  child.stdin = {
    write: vi.fn((chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(),
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = true;
    child.emit("exit", 0, signal ?? null);
    return true;
  });
  child.exitCode = null;
  child.killed = false;

  return {
    child,
    writes,
    emitControl(event: CoreEvent<Record<string, unknown>>) {
      child.stdout.emit("data", encodeControlFrame(event));
    },
  };
}

function createFakeWindow(webContentsId: number) {
  const window = new EventEmitter() as EventEmitter & {
    webContents: { id: number; send: ReturnType<typeof vi.fn> };
    isDestroyed: () => boolean;
  };
  window.webContents = { id: webContentsId, send: vi.fn() };
  window.isDestroyed = () => false;
  return window;
}

async function waitForWriteCount(
  writes: Buffer[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (writes.length >= expectedCount) {
      return;
    }
    await Promise.resolve();
  }
}

describe("CoreManager.isTmuxSession", () => {
  it("flags tmux: pane sessionIds as tmux; false for regular/undefined", () => {
    const manager = new CoreManager();
    // pane 가상 세션은 tmux: 프리픽스로 판정(세션 녹화 제외에 쓰임).
    expect(manager.isTmuxSession("tmux:ctl-1:0")).toBe(true);
    // 일반 SSH 세션(랜덤 UUID)·미정의는 false → 정상 녹화 대상.
    expect(manager.isTmuxSession("3f1c-regular-session")).toBe(false);
    expect(manager.isTmuxSession(undefined)).toBe(false);
    expect(manager.isTmuxSession(null)).toBe(false);
  });
});

describe("CoreManager window session ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes terminal events and output only to the owning window", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const firstWindow = createFakeWindow(101);
    const secondWindow = createFakeWindow(202);
    manager.registerWindow(firstWindow as never);
    manager.registerWindow(secondWindow as never);

    const { sessionId } = await manager.runWithSessionOwner(101, () =>
      manager.connectLocalSession({ cols: 120, rows: 32, title: "Terminal" }),
    );

    expect(manager.listTabs(101)).toHaveLength(1);
    expect(manager.listTabs(202)).toHaveLength(0);

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });
    fakeProcess.child.stdout.emit(
      "data",
      encodeStreamFrame(
        { type: "data", sessionId },
        Buffer.from("owner-only", "utf8"),
      ),
    );

    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      ipcChannels.ssh.event,
      expect.objectContaining({ type: "connected", sessionId }),
    );
    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      ipcChannels.ssh.data,
      expect.objectContaining({ sessionId }),
    );
    expect(secondWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("disconnects only sessions owned by a closed window", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const firstWindow = createFakeWindow(101);
    const secondWindow = createFakeWindow(202);
    manager.registerWindow(firstWindow as never);
    manager.registerWindow(secondWindow as never);

    const first = await manager.runWithSessionOwner(101, () =>
      manager.connectLocalSession({ cols: 120, rows: 32, title: "First" }),
    );
    const second = await manager.runWithSessionOwner(202, () =>
      manager.connectLocalSession({ cols: 120, rows: 32, title: "Second" }),
    );
    fakeProcess.emitControl({ type: "connected", sessionId: first.sessionId, payload: {} });
    fakeProcess.emitControl({ type: "connected", sessionId: second.sessionId, payload: {} });

    firstWindow.emit("closed");

    const lastRequest = decodeControlFrame(fakeProcess.writes.at(-1)!);
    expect(lastRequest).toMatchObject({
      type: "disconnect",
      sessionId: first.sessionId,
    });
    expect(manager.listTabs(202).map((tab) => tab.sessionId)).toEqual([
      second.sessionId,
    ]);
  });
});

describe("CoreManager Container window subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares endpoint events with subscribers and hands interactive auth to one window", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const firstWindow = createFakeWindow(101);
    const secondWindow = createFakeWindow(202);
    manager.registerWindow(firstWindow as never);
    manager.registerWindow(secondWindow as never);
    manager.registerContainerSubscriber("containers:host-1", 101);
    manager.registerContainerSubscriber("containers:host-1", 202);
    await manager.start();

    manager.sendContainersConnectionProgressToSubscribers(
      "containers:host-1",
      {
        endpointId: "containers:host-1",
        hostId: "host-1",
        stage: "connecting-containers",
        message: "connecting",
      },
    );
    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      ipcChannels.containers.connectionProgress,
      expect.objectContaining({ endpointId: "containers:host-1" }),
    );
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      ipcChannels.containers.connectionProgress,
      expect.objectContaining({ endpointId: "containers:host-1" }),
    );

    firstWindow.webContents.send.mockClear();
    secondWindow.webContents.send.mockClear();
    fakeProcess.emitControl({
      type: "keyboardInteractiveChallenge",
      endpointId: "containers:host-1",
      payload: {
        challengeId: "challenge-1",
        attempt: 1,
        instruction: "approve",
        prompts: [],
      },
    });
    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      ipcChannels.ssh.event,
      expect.objectContaining({ type: "keyboardInteractiveChallenge" }),
    );
    expect(secondWindow.webContents.send).not.toHaveBeenCalled();

    firstWindow.webContents.send.mockClear();
    const released = manager.releaseContainerSubscriber(
      "containers:host-1",
      101,
    );
    expect(released).toEqual({ released: true, remainingSubscribers: 1 });
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      ipcChannels.ssh.event,
      expect.objectContaining({ type: "keyboardInteractiveChallenge" }),
    );
    expect(() =>
      manager.assertContainerSubscriber("containers:host-1", 202),
    ).not.toThrow();

    firstWindow.webContents.send.mockClear();
    secondWindow.webContents.send.mockClear();
    fakeProcess.emitControl({
      type: "containersConnected",
      endpointId: "containers:host-1",
      payload: { runtime: "docker" },
    });
    expect(firstWindow.webContents.send).not.toHaveBeenCalled();
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      ipcChannels.ssh.event,
      expect.objectContaining({ type: "containersConnected" }),
    );

    manager.releaseContainerSubscriber("containers:host-1", 202);
    firstWindow.webContents.send.mockClear();
    secondWindow.webContents.send.mockClear();
    fakeProcess.emitControl({
      type: "containersError",
      endpointId: "containers:host-1",
      payload: { message: "closed" },
    });
    expect(firstWindow.webContents.send).not.toHaveBeenCalled();
    expect(secondWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("disconnects a shared endpoint only when its last window closes", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const firstWindow = createFakeWindow(101);
    const secondWindow = createFakeWindow(202);
    manager.registerWindow(firstWindow as never);
    manager.registerWindow(secondWindow as never);
    manager.registerContainerSubscriber("containers:host-1", 101);
    manager.registerContainerSubscriber("containers:host-1", 202);

    const connect = manager.containersConnect({
      endpointId: "containers:host-1",
      hostId: "host-1",
      host: "host.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "AAAATEST",
    });
    await waitForWriteCount(fakeProcess.writes, 1);
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    fakeProcess.emitControl({
      type: "containersConnected",
      requestId: connectRequest.id,
      endpointId: "containers:host-1",
      payload: {
        runtime: "docker",
        runtimeCommand: "/usr/bin/docker",
      },
    });
    await connect;

    firstWindow.emit("closed");
    await Promise.resolve();
    expect(fakeProcess.writes).toHaveLength(1);
    expect(() =>
      manager.assertContainerSubscriber("containers:host-1", 202),
    ).not.toThrow();

    secondWindow.emit("closed");
    await waitForWriteCount(fakeProcess.writes, 2);
    const disconnectRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(disconnectRequest).toMatchObject({
      type: "containersDisconnect",
      endpointId: "containers:host-1",
    });
    fakeProcess.emitControl({
      type: "containersDisconnected",
      requestId: disconnectRequest.id,
      endpointId: "containers:host-1",
      payload: {},
    });
  });
});

describe("CoreManager local shell sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends localConnect to ssh-core and reuses write/resize/disconnect flow", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const { sessionId } = await manager.connectLocalSession({
      cols: 132,
      rows: 40,
      title: "Terminal",
      env: {
        AWS_CONFIG_FILE: "/tmp/dolgate/.aws/config",
      },
      unsetEnv: ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"],
    });

    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.type).toBe("localConnect");
    expect(connectRequest.sessionId).toBe(sessionId);
    expect(connectRequest.payload).toMatchObject({
      cols: 132,
      rows: 40,
      title: "Terminal",
      env: {
        AWS_CONFIG_FILE: "/tmp/dolgate/.aws/config",
      },
      unsetEnv: ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"],
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    manager.write(sessionId, "pwd\r");
    manager.resize(sessionId, 150, 55);
    manager.disconnect(sessionId);

    expect(decodeControlFrame(fakeProcess.writes[2]).type).toBe("resize");
    expect(decodeControlFrame(fakeProcess.writes[2]).payload).toMatchObject({
      cols: 150,
      rows: 55,
    });
    expect(decodeControlFrame(fakeProcess.writes[3]).type).toBe("disconnect");
  });

  it("records a local terminal as one lifecycle row with replay metadata", async () => {
    const logs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager(undefined, (record) => {
      const currentIndex = logs.findIndex((entry) => entry.id === record.id);
      if (currentIndex >= 0) {
        logs[currentIndex] = record;
        return;
      }
      logs.push(record);
    });

    const { sessionId } = await manager.connectLocalSession({
      cols: 132,
      rows: 40,
      title: "Terminal 2",
      lifecycle: {
        hostId: "local-terminal",
        hostLabel: "Local Terminal",
        connectionKind: "local",
      },
    });
    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected", shellKind: "shell" },
    });
    manager.attachSessionRecording(sessionId, "recording-local-1");
    fakeProcess.emitControl({
      type: "closed",
      sessionId,
      payload: { message: "client requested disconnect" },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: `session:${sessionId}`,
      kind: "session-lifecycle",
      message: "Local 세션",
      metadata: {
        hostId: "local-terminal",
        hostLabel: "Local Terminal",
        title: "Terminal 2",
        connectionKind: "local",
        status: "closed",
        disconnectReason: "client requested disconnect",
        recordingId: "recording-local-1",
        hasReplay: true,
      },
    });
    expect(
      (logs[0]?.metadata as unknown as SessionLifecycleLogMetadata).durationMs,
    ).toBeTypeOf("number");
  });

  it("keeps a connected local terminal error and close in one lifecycle row", async () => {
    const logs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager(undefined, (record) => {
      const currentIndex = logs.findIndex((entry) => entry.id === record.id);
      if (currentIndex >= 0) {
        logs[currentIndex] = record;
        return;
      }
      logs.push(record);
    });

    const { sessionId } = await manager.connectLocalSession({
      cols: 120,
      rows: 32,
      title: "Terminal",
      lifecycle: {
        hostId: "local-terminal",
        hostLabel: "Local Terminal",
        connectionKind: "local",
      },
    });
    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });
    fakeProcess.emitControl({
      type: "error",
      sessionId,
      payload: { message: "shell exited with code 1" },
    });
    fakeProcess.emitControl({
      type: "closed",
      sessionId,
      payload: { message: "shell exited with code 1" },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toMatchObject({
      connectionKind: "local",
      status: "error",
      disconnectReason: "shell exited with code 1",
    });
  });

  it("records ECS Exec lifecycle metadata and finalizes it during shutdown", async () => {
    const logs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager(undefined, (record) => {
      const currentIndex = logs.findIndex((entry) => entry.id === record.id);
      if (currentIndex >= 0) {
        logs[currentIndex] = record;
        return;
      }
      logs.push(record);
    });

    const { sessionId } = await manager.connectLocalSession({
      cols: 120,
      rows: 40,
      title: "prod · api · web",
      shellKind: "aws-ecs-exec",
      executable: "aws",
      lifecycle: {
        hostId: "ecs-host-1",
        hostLabel: "prod",
        connectionDetails: "api · web · task-1",
        connectionKind: "aws-ecs-exec",
      },
    });
    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected", shellKind: "aws-ecs-exec" },
    });

    await manager.shutdown();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toMatchObject({
      hostId: "ecs-host-1",
      hostLabel: "prod",
      connectionDetails: "api · web · task-1",
      connectionKind: "aws-ecs-exec",
      status: "closed",
      disconnectReason: "앱 종료로 세션이 정리되었습니다.",
    });
  });

  it("keeps a pre-connect local failure as one generic error without replay lifecycle", async () => {
    const genericLogs: Array<{ level: string; message: unknown }> = [];
    const lifecycleLogs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager(
      (entry) => genericLogs.push(entry),
      (record) => lifecycleLogs.push(record),
    );

    const { sessionId } = await manager.connectLocalSession({
      cols: 120,
      rows: 32,
      title: "Terminal",
      lifecycle: {
        hostId: "local-terminal",
        hostLabel: "Local Terminal",
        connectionKind: "local",
      },
    });
    fakeProcess.emitControl({
      type: "error",
      sessionId,
      payload: { message: "unable to start shell" },
    });
    fakeProcess.emitControl({
      type: "closed",
      sessionId,
      payload: { message: "unable to start shell" },
    });

    // 로그는 번역 키를 함께 싣는다 — 화면은 키로 현재 언어에 맞춰 다시 그리고,
    // message 는 키가 없는 예전 기록용 폴백이다.
    expect(genericLogs).toEqual([
      expect.objectContaining({
        level: "error",
        message: "Local 세션 오류가 발생했습니다.",
        messageKey: "core.sessionErrorLog",
        messageParams: { kind: "Local" },
      }),
    ]);
    expect(lifecycleLogs).toEqual([]);
  });

  it("sends serialConnect through ssh-core and reuses terminal lifecycle flow", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const { sessionId } = await manager.connectSerialSession({
      title: "Console",
      hostId: "serial-1",
      hostLabel: "Console",
      cols: 120,
      rows: 32,
      transport: "local",
      devicePath: "/dev/tty.usbserial-0001",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      transmitLineEnding: "none",
      localEcho: false,
      localLineEditing: false,
    });

    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.type).toBe("serialConnect");
    expect(connectRequest.sessionId).toBe(sessionId);
    expect(connectRequest.payload).toMatchObject({
      transport: "local",
      devicePath: "/dev/tty.usbserial-0001",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      transmitLineEnding: "none",
      localEcho: false,
      localLineEditing: false,
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    manager.write(sessionId, "status\r");
    manager.resize(sessionId, 140, 36);
    manager.disconnect(sessionId);

    expect(decodeControlFrame(fakeProcess.writes[2]).type).toBe("resize");
    expect(decodeControlFrame(fakeProcess.writes[2]).payload).toMatchObject({
      cols: 140,
      rows: 36,
    });
    expect(decodeControlFrame(fakeProcess.writes[3]).type).toBe("disconnect");
  });

  it("lists serial ports through ssh-core", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const listPromise = manager.listSerialPorts();
    await waitForWriteCount(fakeProcess.writes, 1);

    const request = decodeControlFrame(fakeProcess.writes[0]);
    expect(request.type).toBe("serialListPorts");

    fakeProcess.emitControl({
      type: "serialPortsListed",
      requestId: request.id,
      payload: {
        ports: [
          {
            path: "/dev/tty.usbserial-0001",
            displayName: "/dev/tty.usbserial-0001 (USB Serial)",
            manufacturer: "FTDI",
          },
        ],
      },
    });

    await expect(listPromise).resolves.toEqual([
      {
        path: "/dev/tty.usbserial-0001",
        displayName: "/dev/tty.usbserial-0001 (USB Serial)",
        manufacturer: "FTDI",
      },
    ]);
  });

  it("sends serialControl through ssh-core", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const { sessionId } = await manager.connectSerialSession({
      title: "Console",
      hostId: "serial-1",
      hostLabel: "Console",
      cols: 120,
      rows: 32,
      transport: "local",
      devicePath: "/dev/tty.usbserial-0001",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      transmitLineEnding: "none",
      localEcho: false,
      localLineEditing: false,
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    const controlPromise = manager.controlSerialSession(sessionId, {
      action: "set-dtr",
      enabled: true,
    });
    await waitForWriteCount(fakeProcess.writes, 2);

    const request = decodeControlFrame(fakeProcess.writes[1]);
    expect(request.type).toBe("serialControl");
    expect(request.payload).toMatchObject({
      action: "set-dtr",
      enabled: true,
    });

    fakeProcess.emitControl({
      type: "serialControlCompleted",
      requestId: request.id,
      sessionId,
      payload: {
        action: "set-dtr",
        enabled: true,
      },
    });

    await expect(controlPromise).resolves.toEqual({
      action: "set-dtr",
      enabled: true,
    });
  });

  it("uses an extended timeout for containersConnect", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const requestResponseSpy = vi.spyOn(
      manager as unknown as {
        requestResponse: (
          request: CoreRequest<Record<string, unknown>>,
          expectedTypes: string[],
          options?: { timeoutMs?: number },
        ) => Promise<Record<string, unknown>>;
      },
      "requestResponse",
    );
    requestResponseSpy.mockResolvedValue({
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
      unsupportedReason: null,
    });

    await manager.containersConnect({
      endpointId: "containers:host-1",
      hostId: "host-1",
      host: "example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      privateKeyPem: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
    });

    expect(requestResponseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "containersConnect",
        endpointId: "containers:host-1",
      }),
      ["containersConnected"],
      { timeoutMs: 120000 },
    );
  });

  it("sends containersDisconnect and clears cached endpoint runtime", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const requestResponseSpy = vi.spyOn(
      manager as unknown as {
        requestResponse: (
          request: CoreRequest<Record<string, unknown>>,
          expectedTypes: string[],
          options?: { timeoutMs?: number },
        ) => Promise<Record<string, unknown>>;
      },
      "requestResponse",
    );
    requestResponseSpy
      .mockResolvedValueOnce({
        runtime: "docker",
        runtimeCommand: "/usr/bin/docker",
        unsupportedReason: null,
      })
      .mockResolvedValueOnce({});

    await manager.containersConnect({
      endpointId: "containers:host-1",
      hostId: "host-1",
      host: "example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      privateKeyPem: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
    });

    expect(
      manager.getContainersEndpointRuntime("containers:host-1"),
    ).toMatchObject({
      hostId: "host-1",
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
    });

    await manager.containersDisconnect("containers:host-1");

    expect(requestResponseSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "containersDisconnect",
        endpointId: "containers:host-1",
      }),
      ["containersDisconnected"],
    );
    expect(manager.getContainersEndpointRuntime("containers:host-1")).toBeNull();
  });

  it("preserves visible container transport while using SSH port forwarding backend", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const startPromise = manager.startPortForward({
      ruleId: "rule-container-1",
      hostId: "host-1",
      host: "example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      privateKeyPem: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 0,
      targetHost: "172.17.0.2",
      targetPort: 8080,
      transport: "container",
    });

    await waitForWriteCount(fakeProcess.writes, 1);

    const startRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(startRequest.type).toBe("portForwardStart");
    expect(startRequest.endpointId).toBe("rule-container-1");

    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "rule-container-1",
      payload: {
        transport: "ssh",
        mode: "local",
        method: "ssh-session-proxy",
        bindAddress: "127.0.0.1",
        bindPort: 49152,
        status: "running",
      },
    });

    const runtime = await startPromise;
    expect(runtime.transport).toBe("container");
    expect(runtime.method).toBe("ssh-session-proxy");
    expect(runtime.bindPort).toBe(49152);

    const stopPromise = manager.stopPortForward("rule-container-1");
    await waitForWriteCount(fakeProcess.writes, 2);

    const stopRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(stopRequest.type).toBe("portForwardStop");
    expect(stopRequest.endpointId).toBe("rule-container-1");

    fakeProcess.emitControl({
      type: "portForwardStopped",
      requestId: stopRequest.id,
      endpointId: "rule-container-1",
      payload: {
        message: "stopped",
      },
    });

    await stopPromise;
  });

  it("can start a port forward from an existing containers endpoint and clears the temporary endpoint runtime", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const connectPromise = manager.containersConnect({
      endpointId: "containers:host-1:forward:rule-1",
      hostId: "host-1",
      host: "example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      privateKeyPem: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.type).toBe("containersConnect");

    fakeProcess.emitControl({
      type: "containersConnected",
      requestId: connectRequest.id,
      endpointId: "containers:host-1:forward:rule-1",
      payload: {
        runtime: "docker",
        runtimeCommand: "/usr/bin/docker",
      },
    });

    await connectPromise;
    expect(
      manager.getContainersEndpointRuntime("containers:host-1:forward:rule-1"),
    ).toMatchObject({
      hostId: "host-1",
      runtime: "docker",
    });

    const startPromise = manager.startPortForward({
      ruleId: "rule-1",
      hostId: "host-1",
      host: "",
      port: 0,
      username: "",
      authType: "password",
      trustedHostKeyBase64: "",
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 0,
      targetHost: "172.17.0.5",
      targetPort: 3306,
      transport: "container",
      sourceEndpointId: "containers:host-1:forward:rule-1",
    });

    await waitForWriteCount(fakeProcess.writes, 2);

    const startRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(startRequest.type).toBe("portForwardStart");
    expect(startRequest.payload).toMatchObject({
      sourceEndpointId: "containers:host-1:forward:rule-1",
      targetHost: "172.17.0.5",
      targetPort: 3306,
    });

    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "rule-1",
      payload: {
        transport: "ssh",
        mode: "local",
        method: "ssh-native",
        bindAddress: "127.0.0.1",
        bindPort: 49153,
        status: "running",
      },
    });

    await startPromise;
    expect(
      manager.getContainersEndpointRuntime("containers:host-1:forward:rule-1"),
    ).toBeNull();
  });

  it("emits starting, running, and stopped port forward runtime events to the handler", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const statuses: string[] = [];
    manager.setPortForwardEventHandler((event) => {
      statuses.push(event.runtime.status);
    });

    const startPromise = manager.startPortForward({
      ruleId: "rule-handler-1",
      hostId: "host-1",
      host: "example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      privateKeyPem: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      targetHost: "db.internal",
      targetPort: 5432,
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    expect(statuses).toEqual(["starting"]);

    const startRequest = decodeControlFrame(fakeProcess.writes[0]);
    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "rule-handler-1",
      payload: {
        transport: "ssh",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        status: "running",
      },
    });

    await startPromise;

    const stopPromise = manager.stopPortForward("rule-handler-1");
    await waitForWriteCount(fakeProcess.writes, 2);
    const stopRequest = decodeControlFrame(fakeProcess.writes[1]);
    fakeProcess.emitControl({
      type: "portForwardStopped",
      requestId: stopRequest.id,
      endpointId: "rule-handler-1",
      payload: {
        message: "stopped",
      },
    });

    await stopPromise;
    expect(statuses).toEqual(["starting", "running", "stopped"]);
  });

  it("finalizes active port forwards as stopped during shutdown when requested", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const statuses: string[] = [];
    manager.setPortForwardEventHandler((event) => {
      statuses.push(event.runtime.status);
    });

    const startPromise = manager.startPortForward({
      ruleId: "rule-shutdown-1",
      hostId: "host-1",
      host: "example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      privateKeyPem: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      targetHost: "db.internal",
      targetPort: 5432,
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const startRequest = decodeControlFrame(fakeProcess.writes[0]);
    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "rule-shutdown-1",
      payload: {
        transport: "ssh",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        status: "running",
      },
    });

    await startPromise;
    await manager.shutdown({ finalizePortForwardsAsStopped: true });

    expect(statuses).toEqual(["starting", "running", "stopped"]);
    expect(manager.listPortForwardRuntimes()).toEqual([]);
  });

  it("rejects malformed container log responses instead of treating them as empty", async () => {
    const manager = new CoreManager();
    vi.spyOn(
      manager as unknown as { start: () => Promise<void> },
      "start",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as {
        requestResponse: (
          request: CoreRequest<Record<string, unknown>>,
          expectedTypes: string[],
          options?: { timeoutMs?: number },
        ) => Promise<Record<string, unknown>>;
      },
      "requestResponse",
    ).mockResolvedValue({
      runtime: "docker",
      containerId: "container-1",
      lines: "not-an-array",
      cursor: null,
    });

    await expect(
      manager.containersLogs("containers:host-1", "container-1", 200),
    ).rejects.toThrow("Invalid containersLogs response: lines must be string[]");
  });

  it("sends start/stop/restart/remove container actions through ssh-core", async () => {
    const manager = new CoreManager();
    vi.spyOn(
      manager as unknown as { start: () => Promise<void> },
      "start",
    ).mockResolvedValue(undefined);
    const requestResponseSpy = vi.spyOn(
      manager as unknown as {
        requestResponse: (
          request: CoreRequest<Record<string, unknown>>,
          expectedTypes: string[],
          options?: { timeoutMs?: number },
        ) => Promise<Record<string, unknown>>;
      },
      "requestResponse",
    ).mockResolvedValue({});

    await manager.containersStart("containers:host-1", "container-1");
    await manager.containersStop("containers:host-1", "container-1");
    await manager.containersRestart("containers:host-1", "container-1");
    await manager.containersRemove("containers:host-1", "container-1");

    expect(
      requestResponseSpy.mock.calls.map(([request]) => request.type),
    ).toEqual([
      "containersStart",
      "containersStop",
      "containersRestart",
      "containersRemove",
    ]);
    for (const [, expectedTypes, options] of requestResponseSpy.mock.calls) {
      expect(expectedTypes).toEqual(["containersActionCompleted"]);
      expect(options).toEqual({ timeoutMs: 25000 });
    }
  });

  it("keeps one container lifecycle row across refresh errors and close", () => {
    const logs: ActivityLogRecord[] = [];
    const manager = new CoreManager(undefined, (record) => {
      const index = logs.findIndex((entry) => entry.id === record.id);
      if (index >= 0) {
        logs[index] = record;
      } else {
        logs.push(record);
      }
    });

    const { lifecycleId } = manager.beginContainerLifecycle({
      scopeId: "containers:host-1",
      hostId: "host-1",
      hostLabel: "Prod",
      workspaceKind: "host-runtime",
      transport: "ssh",
    });
    manager.markContainerLifecycleConnected({
      scopeId: "containers:host-1",
      lifecycleId,
      runtime: "docker",
      resourceCount: 3,
    });
    manager.noteContainerLifecycleLoadStarted("containers:host-1", lifecycleId);
    manager.reportContainerLifecycleError({
      lifecycleId,
      message: "refresh failed",
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toMatchObject({
      status: "connected",
      runtime: "docker",
      resourceCount: 3,
      refreshCount: 1,
      errorCount: 1,
      lastError: "refresh failed",
    });

    manager.finalizeContainerLifecycleForScope(
      "containers:host-1",
      lifecycleId,
    );
    const metadata = logs[0]?.metadata as unknown as ContainerLifecycleLogMetadata;
    expect(metadata.status).toBe("closed");
    expect(metadata.endedAt).toBeTypeOf("string");
    expect(metadata.durationMs).toBeTypeOf("number");
  });

  it("starts a new container lifecycle after an initial failure", () => {
    const logs: ActivityLogRecord[] = [];
    const manager = new CoreManager(undefined, (record) => {
      const index = logs.findIndex((entry) => entry.id === record.id);
      if (index >= 0) logs[index] = record;
      else logs.push(record);
    });
    const input = {
      scopeId: "containers:ecs-1",
      hostId: "ecs-1",
      hostLabel: "Prod ECS",
      workspaceKind: "ecs-cluster" as const,
      transport: "aws-ecs" as const,
    };

    const first = manager.beginContainerLifecycle(input);
    manager.reportContainerLifecycleError({
      lifecycleId: first.lifecycleId,
      message: "access denied",
    });
    const second = manager.beginContainerLifecycle(input);

    expect(second.lifecycleId).not.toBe(first.lifecycleId);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.metadata).toMatchObject({
      status: "error",
      errorCount: 1,
    });
    expect(logs[1]?.metadata).toMatchObject({ status: "connecting" });
  });

  it("records unsupported runtimes and closes active container lifecycles on shutdown", async () => {
    const logs: ActivityLogRecord[] = [];
    const manager = new CoreManager(undefined, (record) => {
      const index = logs.findIndex((entry) => entry.id === record.id);
      if (index >= 0) logs[index] = record;
      else logs.push(record);
    });

    const unsupported = manager.beginContainerLifecycle({
      scopeId: "containers:host-1",
      hostId: "host-1",
      hostLabel: "No runtime",
      workspaceKind: "host-runtime",
      transport: "ssh",
    });
    manager.markContainerLifecycleUnsupported({
      scopeId: "containers:host-1",
      lifecycleId: unsupported.lifecycleId,
      reason: "docker/podman not found",
    });
    const active = manager.beginContainerLifecycle({
      scopeId: "containers:ecs-1",
      hostId: "ecs-1",
      hostLabel: "Prod ECS",
      workspaceKind: "ecs-cluster",
      transport: "aws-ecs",
    });
    manager.markContainerLifecycleConnected({
      scopeId: "containers:ecs-1",
      lifecycleId: active.lifecycleId,
      resourceCount: 2,
    });

    await manager.shutdown();

    expect(logs.find((record) => record.id === `container:${unsupported.lifecycleId}`)).toMatchObject({
      level: "warn",
      metadata: expect.objectContaining({ status: "unsupported" }),
    });
    expect(logs.find((record) => record.id === `container:${active.lifecycleId}`)?.metadata).toMatchObject({
      status: "closed",
      endReason: "앱 종료로 Containers 연결이 정리되었습니다.",
    });
  });

  it("records container actions without storing command output or credentials", async () => {
    const logs: ActivityLogRecord[] = [];
    const manager = new CoreManager(undefined, (record) => logs.push(record));
    manager.beginContainerLifecycle({
      scopeId: "containers:host-1",
      hostId: "host-1",
      hostLabel: "Prod",
      workspaceKind: "host-runtime",
      transport: "ssh",
    });
    const internals = manager as unknown as {
      containerEndpoints: Map<string, unknown>;
      containerNamesByEndpointId: Map<string, Map<string, string>>;
      start: () => Promise<void>;
      requestResponse: () => Promise<Record<string, unknown>>;
    };
    internals.containerEndpoints.set("containers:host-1", {
      hostId: "host-1",
      runtime: "podman",
      runtimeCommand: "/usr/bin/podman",
      unsupportedReason: null,
    });
    internals.containerNamesByEndpointId.set(
      "containers:host-1",
      new Map([["container-1", "api"]]),
    );
    vi.spyOn(internals, "start").mockResolvedValue(undefined);
    vi.spyOn(internals, "requestResponse").mockResolvedValue({});

    await manager.containersRemove("containers:host-1", "container-1");

    const actionLog = logs.find((record) => record.kind === "container-action");
    const metadata = actionLog?.metadata as unknown as ContainerActionLogMetadata;
    expect(actionLog?.level).toBe("warn");
    expect(metadata).toMatchObject({
      hostLabel: "Prod",
      containerId: "container-1",
      containerName: "api",
      runtime: "podman",
      action: "remove",
      status: "success",
    });
    expect(JSON.stringify(metadata)).not.toContain("password");
    expect(JSON.stringify(metadata)).not.toContain("privateKey");
  });

  it("records failed container actions as errors", async () => {
    const logs: ActivityLogRecord[] = [];
    const manager = new CoreManager(undefined, (record) => logs.push(record));
    manager.beginContainerLifecycle({
      scopeId: "containers:host-1",
      hostId: "host-1",
      hostLabel: "Prod",
      workspaceKind: "host-runtime",
      transport: "aws-ssm",
    });
    const internals = manager as unknown as {
      start: () => Promise<void>;
      requestResponse: () => Promise<Record<string, unknown>>;
    };
    vi.spyOn(internals, "start").mockResolvedValue(undefined);
    vi.spyOn(internals, "requestResponse").mockRejectedValue(
      new Error("permission denied"),
    );

    await expect(
      manager.containersRestart("containers:host-1", "container-1"),
    ).rejects.toThrow("permission denied");

    const actionLog = logs.find((record) => record.kind === "container-action");
    expect(actionLog?.level).toBe("error");
    expect(actionLog?.metadata).toMatchObject({
      action: "restart",
      status: "error",
      errorMessage: "permission denied",
    });
  });

  it("parses container stats responses and validates remote log search payloads", async () => {
    const manager = new CoreManager();
    vi.spyOn(
      manager as unknown as { start: () => Promise<void> },
      "start",
    ).mockResolvedValue(undefined);
    (
      manager as unknown as {
        containerEndpoints: Map<
          string,
          { hostId: string; runtime: "docker"; runtimeCommand: string }
        >;
      }
    ).containerEndpoints.set("containers:host-1", {
      hostId: "host-1",
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
    });
    const requestResponseSpy = vi.spyOn(
      manager as unknown as {
        requestResponse: (
          request: CoreRequest<Record<string, unknown>>,
          expectedTypes: string[],
          options?: { timeoutMs?: number },
        ) => Promise<Record<string, unknown>>;
      },
      "requestResponse",
    );
    requestResponseSpy
      .mockResolvedValueOnce({
        runtime: "docker",
        containerId: "container-1",
        recordedAt: "2025-01-01T00:00:00.000Z",
        cpuPercent: 12.5,
        memoryUsedBytes: 1024,
        memoryLimitBytes: 2048,
        memoryPercent: 50,
        networkRxBytes: 100,
        networkTxBytes: 200,
        blockReadBytes: 300,
        blockWriteBytes: 400,
      })
      .mockResolvedValueOnce({
        runtime: "docker",
        containerId: "container-1",
        query: "error",
        lines: ["2025-01-01T00:00:00.000000000Z error"],
        matchCount: 1,
      })
      .mockResolvedValueOnce({
        runtime: "docker",
        containerId: "container-1",
        query: "error",
        lines: "not-an-array",
      });

    await expect(
      manager.containersStats("containers:host-1", "container-1"),
    ).resolves.toMatchObject({
      hostId: "host-1",
      containerId: "container-1",
      cpuPercent: 12.5,
      memoryPercent: 50,
    });

    await expect(
      manager.containersSearchLogs(
        "containers:host-1",
        "container-1",
        1200,
        "error",
      ),
    ).resolves.toMatchObject({
      hostId: "host-1",
      containerId: "container-1",
      query: "error",
      matchCount: 1,
    });

    await expect(
      manager.containersSearchLogs(
        "containers:host-1",
        "container-1",
        1200,
        "error",
      ),
    ).rejects.toThrow(
      "Invalid containersSearchLogs response: lines must be string[]",
    );
  });

  it("records Warpgate remote sessions as a single lifecycle row", async () => {
    const logs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager(undefined, (record) => {
      const currentIndex = logs.findIndex((entry) => entry.id === record.id);
      if (currentIndex >= 0) {
        logs[currentIndex] = record;
        return;
      }
      logs.push(record);
    });

    const { sessionId } = await manager.connect({
      host: "warp.example.com",
      port: 2222,
      username: "alice",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "Warpgate Host",
      hostId: "warp-host-1",
      hostLabel: "Warpgate NAS",
      transport: "warpgate",
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });
    fakeProcess.emitControl({
      type: "closed",
      sessionId,
      payload: { message: "closed" },
    });

    expect(logs).toHaveLength(1);
    const lifecycle = logs[0];
    const metadata = lifecycle.metadata as unknown as SessionLifecycleLogMetadata;
    expect(lifecycle.kind).toBe("session-lifecycle");
    expect(metadata.hostLabel).toBe("Warpgate NAS");
    expect(metadata.connectionDetails).toBe("warp.example.com · 2222 · alice");
    expect(metadata.connectionKind).toBe("warpgate");
    expect(metadata.status).toBe("closed");
    expect(metadata.durationMs).toBeTypeOf("number");
  });

  it("updates an existing remote lifecycle row when a replay recording is attached", async () => {
    const logs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager(undefined, (record) => {
      const currentIndex = logs.findIndex((entry) => entry.id === record.id);
      if (currentIndex >= 0) {
        logs[currentIndex] = record;
        return;
      }
      logs.push(record);
    });

    const { sessionId } = await manager.connect({
      host: "nas.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "NAS",
      hostId: "host-1",
      hostLabel: "nas",
      transport: "ssh",
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });

    manager.attachSessionRecording(sessionId, "recording-1");

    expect(logs).toHaveLength(1);
    expect(logs[0]?.kind).toBe("session-lifecycle");
    expect(logs[0]?.metadata).toMatchObject({
      recordingId: "recording-1",
      hasReplay: true,
    });
  });

  it("finalizes connected remote lifecycle rows during shutdown", async () => {
    const logs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager(undefined, (record) => {
      const currentIndex = logs.findIndex((entry) => entry.id === record.id);
      if (currentIndex >= 0) {
        logs[currentIndex] = record;
        return;
      }
      logs.push(record);
    });

    const { sessionId } = await manager.connect({
      host: "nas.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "NAS",
      hostId: "host-1",
      hostLabel: "nas",
      transport: "ssh",
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });

    await manager.shutdown();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.kind).toBe("session-lifecycle");
    expect(logs[0]?.metadata).toMatchObject({
      sessionId,
      status: "closed",
      disconnectReason: "앱 종료로 세션이 정리되었습니다.",
    });
    const metadata = logs[0]?.metadata as unknown as SessionLifecycleLogMetadata;
    expect(metadata.connectedAt).toBeTypeOf("string");
    expect(metadata.disconnectedAt).toBeTypeOf("string");
  });

  it("records a pre-connect SSH host failure as an error lifecycle log", async () => {
    const logs: ActivityLogRecord[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager(undefined, (record) => {
      const currentIndex = logs.findIndex((entry) => entry.id === record.id);
      if (currentIndex >= 0) {
        logs[currentIndex] = record;
        return;
      }
      logs.push(record);
    });

    const { sessionId } = await manager.connect({
      host: "10.0.0.9",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "Unreachable",
      hostId: "host-unreachable",
      hostLabel: "Unreachable",
      transport: "ssh",
    });

    // 연결 성공(connected) 없이 곧바로 실패: error → closed.
    fakeProcess.emitControl({
      type: "error",
      sessionId,
      payload: { message: "dial tcp 10.0.0.9:22: connect: connection refused" },
    });
    fakeProcess.emitControl({
      type: "closed",
      sessionId,
      payload: { message: "ssh-core exited" },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.kind).toBe("session-lifecycle");
    expect(logs[0]?.level).toBe("error");
    const metadata = logs[0]?.metadata as unknown as SessionLifecycleLogMetadata;
    expect(metadata.hostId).toBe("host-unreachable");
    expect(metadata.status).toBe("error");
    expect(metadata.disconnectReason).toBe(
      "dial tcp 10.0.0.9:22: connect: connection refused",
    );
  });
});
