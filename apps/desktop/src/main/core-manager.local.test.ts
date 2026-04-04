import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityLogRecord,
  CoreEvent,
  CoreRequest,
  SessionLifecycleLogMetadata,
} from "@shared";
import { encodeControlFrame } from "./core-framing";

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
    });

    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.type).toBe("localConnect");
    expect(connectRequest.sessionId).toBe(sessionId);
    expect(connectRequest.payload).toMatchObject({
      cols: 132,
      rows: 40,
      title: "Terminal",
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
      privateKeyPath: undefined,
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
      privateKeyPath: undefined,
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
      privateKeyPath: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 0,
      targetHost: "172.17.0.2",
      targetPort: 8080,
      transport: "container",
    });

    await Promise.resolve();

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
    await Promise.resolve();

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
      privateKeyPath: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
    });

    await Promise.resolve();
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

    await Promise.resolve();

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
      privateKeyPath: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      targetHost: "db.internal",
      targetPort: 5432,
    });

    await Promise.resolve();
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
    await Promise.resolve();
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
      privateKeyPath: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
      mode: "local",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      targetHost: "db.internal",
      targetPort: 5432,
    });

    await Promise.resolve();
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

    manager.attachRemoteSessionRecording(sessionId, "recording-1");

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
});
