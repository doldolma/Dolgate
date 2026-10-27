import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityLogRecord,
  ContainerLifecycleLogMetadata,
  CoreEvent,
  CoreRequest,
  PortForwardRuntimeEvent,
  SessionLifecycleLogMetadata,
  SftpLifecycleLogMetadata,
} from "@shared";
import { encodeControlFrame } from "./core-framing";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/dolssh",
    getPath: () => "/tmp/dolgate-test-user-data",
    isPackaged: false,
  },
  BrowserWindow: class {},
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { CoreManager } from "./core-manager";

const NOTICE = "팀에서 빠져 이 연결을 닫았습니다.";
const TEAM_HOSTS = new Set(["team-host"]);

function decodeControlFrame(buffer: Buffer): CoreRequest<Record<string, unknown>> {
  const metadataLength = buffer.readUInt32BE(1);
  return JSON.parse(buffer.subarray(9, 9 + metadataLength).toString("utf8")) as CoreRequest<
    Record<string, unknown>
  >;
}

function createFakeChildProcess() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();
  const writes: Buffer[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: { writable: boolean; destroyed: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdin = {
    writable: true,
    destroyed: false,
    write: vi.fn((chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(() => {
      child.stdin.writable = false;
    }),
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
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
    requests(from = 0) {
      return writes.slice(from).map((frame) => decodeControlFrame(frame));
    },
  };
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.resolve();
  }
}

function setup() {
  const fakeProcess = createFakeChildProcess();
  spawnMock.mockReturnValue(fakeProcess.child);
  const logs = new Map<string, ActivityLogRecord>();
  const manager = new CoreManager(undefined, (record) => {
    logs.set(record.id, record);
  });
  const events: Array<CoreEvent<Record<string, unknown>>> = [];
  manager.setTerminalEventHandler((event) => {
    events.push(event);
  });
  const forwards: PortForwardRuntimeEvent[] = [];
  manager.setPortForwardEventHandler((event) => {
    forwards.push(event);
  });
  return { fakeProcess, manager, logs, events, forwards };
}

async function connectSession(
  manager: CoreManager,
  fakeProcess: ReturnType<typeof createFakeChildProcess>,
  hostId: string,
): Promise<string> {
  const { sessionId } = await manager.connect({
    host: `${hostId}.example.com`,
    port: 22,
    username: "ubuntu",
    authType: "password",
    password: "secret",
    trustedHostKeyBase64: "trusted",
    cols: 120,
    rows: 32,
    title: hostId,
    hostId,
    hostLabel: hostId,
    transport: "ssh",
  });
  fakeProcess.emitControl({ type: "connected", sessionId, payload: { status: "connected" } });
  return sessionId;
}

describe("CoreManager.closeHostConnections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes only the given hosts' terminals and carries the notice to the closed event and the log", async () => {
    const { fakeProcess, manager, logs, events } = setup();
    const teamSession = await connectSession(manager, fakeProcess, "team-host");
    const mySession = await connectSession(manager, fakeProcess, "my-host");
    const before = fakeProcess.writes.length;

    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(1);

    const sent = fakeProcess.requests(before);
    expect(sent.map((request) => [request.type, request.sessionId])).toEqual([["disconnect", teamSession]]);

    // 코어가 닫았다고 알리면 그 닫힘에 까닭이 실린다.
    fakeProcess.emitControl({ type: "closed", sessionId: teamSession, payload: { message: "closed" } });
    const closed = events.filter((event) => event.type === "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ sessionId: teamSession, payload: { closedNotice: NOTICE, message: NOTICE } });
    expect(logs.get(`session:${teamSession}`)?.metadata).toMatchObject({
      status: "closed",
      disconnectReason: NOTICE,
    } satisfies Partial<SessionLifecycleLogMetadata>);
    expect(logs.get(`session:${mySession}`)?.metadata).toMatchObject({ status: "connected" });

    // 까닭은 그 한 번에만 쓴다 — 개인 세션이 나중에 닫혀도 실리지 않는다.
    fakeProcess.emitControl({ type: "closed", sessionId: mySession, payload: { message: "closed" } });
    const mine = events.filter((event) => event.type === "closed" && event.sessionId === mySession);
    expect(mine).toHaveLength(1);
    expect(mine[0].payload).not.toHaveProperty("closedNotice");
    expect(logs.get(`session:${mySession}`)?.metadata).toMatchObject({ status: "closed", disconnectReason: "closed" });
  });

  it("closes a connecting tab at once and says why", async () => {
    const { fakeProcess, manager, events } = setup();
    const { sessionId } = await manager.connect({
      host: "team.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "team",
      hostId: "team-host",
      hostLabel: "team",
      transport: "ssh",
    });

    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(1);

    expect(events.filter((event) => event.type === "closed")).toEqual([
      expect.objectContaining({ sessionId, payload: { message: NOTICE, closedNotice: NOTICE } }),
    ]);
    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(0);
  });

  it("closes the hosts' SFTP endpoints with the notice and leaves the others", async () => {
    const { fakeProcess, manager, logs, events } = setup();
    const open = async (endpointId: string, hostId: string) => {
      const connecting = manager.sftpConnect({
        endpointId,
        host: `${hostId}.example.com`,
        port: 22,
        username: "ubuntu",
        authType: "password",
        password: "secret",
        trustedHostKeyBase64: "trusted",
        hostId,
        title: hostId,
      });
      await settle();
      const request = fakeProcess.requests().at(-1)!;
      fakeProcess.emitControl({ type: "sftpConnected", requestId: request.id, endpointId, payload: { path: "/home" } });
      await connecting;
    };
    await open("sftp-team", "team-host");
    await open("sftp-mine", "my-host");
    const before = fakeProcess.writes.length;

    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(1);
    await settle();

    const sent = fakeProcess.requests(before);
    expect(sent.map((request) => [request.type, request.endpointId])).toEqual([["sftpDisconnect", "sftp-team"]]);
    fakeProcess.emitControl({ type: "sftpDisconnected", requestId: sent[0].id, endpointId: "sftp-team", payload: {} });
    await settle();

    expect(events.filter((event) => event.type === "sftpDisconnected")).toEqual([
      expect.objectContaining({ endpointId: "sftp-team", payload: { message: NOTICE, closedNotice: NOTICE } }),
    ]);
    expect(logs.get("sftp:sftp-team")?.metadata).toMatchObject({
      status: "closed",
      endReason: NOTICE,
    } satisfies Partial<SftpLifecycleLogMetadata>);
    expect(logs.get("sftp:sftp-mine")?.metadata).toMatchObject({ status: "connected" });
  });

  it("stops the hosts' running port forwards with the notice, once", async () => {
    const { fakeProcess, manager, forwards } = setup();
    const start = async () => {
      const starting = manager.startPortForward({
        ruleId: "rule-team",
        hostId: "team-host",
        host: "team.example.com",
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
        transport: "ssh",
      });
      await settle();
      const request = fakeProcess.requests().at(-1)!;
      fakeProcess.emitControl({
        type: "portForwardStarted",
        requestId: request.id,
        endpointId: "rule-team",
        payload: { transport: "ssh", mode: "local", bindAddress: "127.0.0.1", bindPort: 15432, status: "running" },
      });
      await starting;
    };
    const stopWithCore = async (stopping: Promise<unknown> | null) => {
      await settle();
      const request = fakeProcess.requests().at(-1)!;
      expect(request).toMatchObject({ type: "portForwardStop", endpointId: "rule-team" });
      fakeProcess.emitControl({ type: "portForwardStopped", requestId: request.id, endpointId: "rule-team", payload: {} });
      await stopping;
      await settle();
    };

    await start();
    expect(manager.closeHostConnections(new Set(["my-host"]), NOTICE)).toBe(0);
    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(1);
    await stopWithCore(null);
    const stopped = forwards.filter((event) => event.runtime.status === "stopped");
    expect(stopped.at(-1)?.runtime).toMatchObject({ ruleId: "rule-team", message: NOTICE });

    // 다음 멈춤에는 묻어나지 않는다.
    await start();
    await stopWithCore(manager.stopPortForward("rule-team"));
    const again = forwards.filter((event) => event.runtime.status === "stopped");
    expect(again.length).toBeGreaterThan(stopped.length);
    expect(again.at(-1)?.runtime.message).not.toBe(NOTICE);
  });

  it("closes the hosts' container endpoints with the notice", async () => {
    const { fakeProcess, manager, logs, events } = setup();
    manager.beginContainerLifecycle({
      scopeId: "containers:team-host",
      hostId: "team-host",
      hostLabel: "team",
      workspaceKind: "host-runtime",
      transport: "ssh",
    });
    const connecting = manager.containersConnect({
      endpointId: "containers:team-host",
      hostId: "team-host",
      host: "team.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      privateKeyPem: undefined,
      passphrase: "",
      trustedHostKeyBase64: "",
    });
    await settle();
    const connectRequest = fakeProcess.requests().at(-1)!;
    fakeProcess.emitControl({
      type: "containersConnected",
      requestId: connectRequest.id,
      endpointId: "containers:team-host",
      payload: { runtime: "docker", runtimeCommand: "/usr/bin/docker", unsupportedReason: null },
    });
    await connecting;
    const before = fakeProcess.writes.length;

    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(1);
    await settle();

    const sent = fakeProcess.requests(before);
    expect(sent.map((request) => [request.type, request.endpointId])).toEqual([
      ["containersDisconnect", "containers:team-host"],
    ]);
    fakeProcess.emitControl({
      type: "containersDisconnected",
      requestId: sent[0].id,
      endpointId: "containers:team-host",
      payload: {},
    });
    await settle();

    expect(events.filter((event) => event.type === "containersDisconnected")).toEqual([
      expect.objectContaining({ endpointId: "containers:team-host", payload: { message: NOTICE, closedNotice: NOTICE } }),
    ]);
    const lifecycle = [...logs.values()].find((record) => record.kind === "container-lifecycle");
    expect(lifecycle?.metadata).toMatchObject({
      status: "closed",
      endReason: NOTICE,
    } satisfies Partial<ContainerLifecycleLogMetadata>);
  });
});
