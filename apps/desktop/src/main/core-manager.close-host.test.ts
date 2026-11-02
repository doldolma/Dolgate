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
import { HostGoneError } from "./host-gone-error";

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
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    destroyed: false,
    write: vi.fn((chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(() => {
      child.stdin.writable = false;
    }),
  });
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

    // 코어는 붙는 중 연결을 접으며 취소 오류를 뒤늦게 보낸다(붙기 전 세션에는 '닫힘'을 보내지 않는다). 넘기면 화면의 까닭이 덮인다.
    fakeProcess.emitControl({
      type: "error",
      sessionId,
      payload: { message: "ssh handshake failed: host key trust prompt was cancelled: context canceled" },
    });
    expect(events.filter((event) => event.sessionId === sessionId).map((event) => event.type)).toEqual(["closed"]);
  });

  it("still passes failures of sessions the app did not close", async () => {
    const { fakeProcess, manager, events } = setup();
    const { sessionId } = await manager.connect({
      host: "mine.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "mine",
      hostId: "my-host",
      hostLabel: "mine",
      transport: "ssh",
    });

    manager.closeHostConnections(TEAM_HOSTS, NOTICE);
    fakeProcess.emitControl({ type: "error", sessionId, payload: { message: "dial tcp: connection refused" } });
    // 탭이 없는 상관 id(공개 키 설치)의 실패도 그대로 간다 — 그 대화상자가 이것으로 실패를 보인다.
    fakeProcess.emitControl({ type: "error", sessionId: "keyinstall:host-9", payload: { message: "permission denied" } });

    expect(
      events.filter((event) => event.type === "error").map((event) => [event.sessionId, event.payload.message]),
    ).toEqual([
      [sessionId, "dial tcp: connection refused"],
      ["keyinstall:host-9", "permission denied"],
    ]);
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

// 붙는 중에 팀에서 빠지면(8-6 결함 ②의 데스크톱 쪽). SFTP·컨테이너는 코어가 '붙었다'고 답한 뒤에야 끝점 표에 오르므로,
// 그 전(호스트 키 물음·느린 서버)에 빠지면 닫기가 닿지 않아 뒤늦게 붙었다.
describe("CoreManager.closeHostConnections for connections still connecting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function sftpConnecting(manager: CoreManager, endpointId: string, hostId: string) {
    const connecting = manager.sftpConnect({
      endpointId,
      host: `${hostId}.example.com`,
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "",
      hostId,
      title: hostId,
    });
    return connecting.then(
      () => "connected",
      (error: Error) => `failed: ${error.message}`,
    );
  }

  it("cuts an SFTP endpoint that is still connecting, and does not keep it when the core answers late", async () => {
    const { fakeProcess, manager, logs } = setup();
    const outcome = sftpConnecting(manager, "sftp-team", "team-host");
    await settle();
    const connectRequest = fakeProcess.requests().at(-1)!;
    const before = fakeProcess.writes.length;

    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(1);
    await settle();
    expect(fakeProcess.requests(before).map((request) => [request.type, request.endpointId])).toEqual([
      ["sftpDisconnect", "sftp-team"],
    ]);

    // 끊기가 닿기 전에 코어가 붙었다(사람이 남은 창에서 신뢰했거나 서버가 답했다) — 적지 않고 다시 끊는다.
    const beforeLate = fakeProcess.writes.length;
    fakeProcess.emitControl({ type: "sftpConnected", requestId: connectRequest.id, endpointId: "sftp-team", payload: { path: "/home" } });
    await settle();

    expect(await outcome).toBe(`failed: ${NOTICE}`);
    expect(fakeProcess.requests(beforeLate).map((request) => [request.type, request.endpointId])).toEqual([
      ["sftpDisconnect", "sftp-team"],
    ]);
    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(0);
    expect(logs.get("sftp:sftp-team")?.metadata).toMatchObject({ status: "closed", endReason: NOTICE });
  });

  // 코어는 끊기에 두 답을 따로 보낸다 — 붙는 요청의 취소 오류와 끊기의 '끊겼다'. 순서는 정해져 있지 않고, 사이에 앞의 답이
  // 다 처리된다(붙는 요청이 끝나 표에서 빠지거나, 끊기 요청이 끝나 끊김 까닭이 지워진 뒤 다음 답이 온다).
  it.each([
    ["the connect's error first", ["error", "disconnected"]],
    ["the cut's answer first", ["disconnected", "error"]],
  ] as const)("ends a cut SFTP connect with the reason when the core sends %s", async (_label, order) => {
    const { fakeProcess, manager, events } = setup();
    const outcome = sftpConnecting(manager, "sftp-team", "team-host");
    await settle();
    const connectRequest = fakeProcess.requests().at(-1)!;
    const before = fakeProcess.writes.length;

    manager.closeHostConnections(TEAM_HOSTS, NOTICE);
    await settle();
    const [cutRequest] = fakeProcess.requests(before);
    for (const answer of order) {
      fakeProcess.emitControl(
        answer === "error"
          ? { type: "sftpError", requestId: connectRequest.id, endpointId: "sftp-team", payload: { message: "context canceled" } }
          : { type: "sftpDisconnected", requestId: cutRequest.id, endpointId: "sftp-team", payload: {} },
      );
      await settle();
    }

    expect(await outcome).toBe(`failed: ${NOTICE}`);
    expect(
      events
        .filter((event) => event.type === "sftpError" || event.type === "sftpDisconnected")
        .map((event) => [event.type, event.payload]),
    ).toEqual(
      order.map((answer) => [
        answer === "error" ? "sftpError" : "sftpDisconnected",
        expect.objectContaining({ message: NOTICE, closedNotice: NOTICE }),
      ]),
    );
  });

  it("leaves another host's connecting SFTP alone", async () => {
    const { fakeProcess, manager } = setup();
    const outcome = sftpConnecting(manager, "sftp-mine", "my-host");
    await settle();
    const connectRequest = fakeProcess.requests().at(-1)!;
    const before = fakeProcess.writes.length;

    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(0);
    expect(fakeProcess.requests(before)).toEqual([]);
    fakeProcess.emitControl({ type: "sftpConnected", requestId: connectRequest.id, endpointId: "sftp-mine", payload: { path: "/home" } });

    expect(await outcome).toBe("connected");
  });

  it("cuts a containers endpoint that is still connecting, and does not keep it when the core answers late", async () => {
    const { fakeProcess, manager, logs, events } = setup();
    manager.beginContainerLifecycle({
      scopeId: "containers:team-host",
      hostId: "team-host",
      hostLabel: "team",
      workspaceKind: "host-runtime",
      transport: "ssh",
    });
    const outcome = manager
      .containersConnect({
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
      })
      .then(
        () => "connected",
        (error: Error) => `failed: ${error.message}`,
      );
    await settle();
    const connectRequest = fakeProcess.requests().at(-1)!;
    const before = fakeProcess.writes.length;

    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(1);
    await settle();
    expect(fakeProcess.requests(before).map((request) => [request.type, request.endpointId])).toEqual([
      ["containersDisconnect", "containers:team-host"],
    ]);

    // 코어가 붙는 요청의 취소 오류를 끊김보다 먼저 보냈다 — 실패가 아니라 그 까닭의 닫힘이다.
    fakeProcess.emitControl({
      type: "containersError",
      requestId: connectRequest.id,
      endpointId: "containers:team-host",
      payload: { message: "context canceled" },
    });
    await settle();

    expect(await outcome).toBe(`failed: ${NOTICE}`);
    expect(events.filter((event) => event.type === "containersError")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ message: NOTICE, closedNotice: NOTICE }) }),
    ]);
    const lifecycle = [...logs.values()].find((record) => record.kind === "container-lifecycle");
    expect(lifecycle?.metadata).toMatchObject({ status: "closed", endReason: NOTICE });
    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(0);
  });

  it("does not keep a containers endpoint whose connect the core finished before the cut", async () => {
    const { fakeProcess, manager } = setup();
    const outcome = manager
      .containersConnect({
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
      })
      .then(
        () => "connected",
        (error: Error) => `failed: ${error.message}`,
      );
    await settle();
    const connectRequest = fakeProcess.requests().at(-1)!;
    manager.closeHostConnections(TEAM_HOSTS, NOTICE);
    await settle();
    const beforeLate = fakeProcess.writes.length;

    fakeProcess.emitControl({
      type: "containersConnected",
      requestId: connectRequest.id,
      endpointId: "containers:team-host",
      payload: { runtime: "docker", runtimeCommand: "/usr/bin/docker", unsupportedReason: null },
    });
    await settle();

    expect(await outcome).toBe(`failed: ${NOTICE}`);
    expect(fakeProcess.requests(beforeLate).map((request) => [request.type, request.endpointId])).toEqual([
      ["containersDisconnect", "containers:team-host"],
    ]);
    expect(manager.closeHostConnections(TEAM_HOSTS, NOTICE)).toBe(0);
  });
});

// 다이얼 직전 마지막 확인 — IPC 는 처음에 호스트를 찾고 시작하지만, AWS·키체인을 기다리는 사이 팀에서 빠지면 그 연결은 아직
// 어디에도 적히지 않아 닫기가 닿지 않는다. 연결을 여는 길은 모두 여기를 지난다.
describe("CoreManager dials only hosts that are still in a vault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [이름, 코어로 보내는 요청(서버 프록시는 메인이 직접 웹소켓을 연다 — 없음), 다이얼]
  const DIALS: Array<[string, string | null, (manager: CoreManager, hostId: string) => Promise<unknown>]> = [
    ["terminal", "connect", (manager, hostId) =>
      manager.connect({
        host: "h.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        password: "secret",
        trustedHostKeyBase64: "",
        cols: 80,
        rows: 24,
        title: hostId,
        hostId,
        hostLabel: hostId,
        transport: "ssh",
      })],
    ["SFTP", "sftpConnect", (manager, hostId) =>
      manager.sftpConnect({
        endpointId: "sftp-1",
        host: "h.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        password: "secret",
        trustedHostKeyBase64: "",
        hostId,
        title: hostId,
      })],
    ["containers", "containersConnect", (manager, hostId) =>
      manager.containersConnect({
        endpointId: `containers:${hostId}`,
        hostId,
        host: "h.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        password: "secret",
        privateKeyPem: undefined,
        passphrase: "",
        trustedHostKeyBase64: "",
      })],
    ["AWS SSM shell", "awsConnect", (manager, hostId) =>
      manager.connectAwsSession({
        profileName: "default",
        region: "ap-northeast-2",
        instanceId: "i-1",
        cols: 80,
        rows: 24,
        title: hostId,
        hostId,
        hostLabel: hostId,
      })],
    ["AWS server proxy", null, (manager, hostId) =>
      manager.connectAwsServerProxySession({
        serverUrl: "https://sync.example.test",
        accessToken: "token",
        profileName: "default",
        region: "ap-northeast-2",
        instanceId: "i-1",
        cols: 80,
        rows: 24,
        title: hostId,
        hostId,
        hostLabel: hostId,
      })],
    ["port forward", "portForwardStart", (manager, hostId) =>
      manager.startPortForward({
        ruleId: "rule-1",
        hostId,
        host: "h.example.com",
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
      })],
    ["SSM port forward", "ssmPortForwardStart", (manager, hostId) =>
      manager.startSsmPortForward({
        ruleId: "rule-ssm",
        hostId,
        profileName: "default",
        region: "ap-northeast-2",
        targetType: "instance",
        targetId: "i-1",
        bindAddress: "127.0.0.1",
        bindPort: 15433,
        targetKind: "remote-host",
        targetPort: 5432,
        remoteHost: "db.internal",
      })],
  ];

  it.each(DIALS)("does not dial a %s for a host that left with its team", async (_label, requestType, dial) => {
    const { fakeProcess, manager } = setup();
    manager.setHostPresence((hostId) => hostId !== "team-host");
    manager.closeHostConnections(TEAM_HOSTS, NOTICE);

    await expect(dial(manager, "team-host")).rejects.toThrow(new HostGoneError(NOTICE));
    await settle();
    if (requestType) {
      expect(fakeProcess.requests().filter((request) => request.type === requestType)).toEqual([]);
    }
  });

  it("says 'Host not found' for a host that was deleted rather than left with a team", async () => {
    const { manager } = setup();
    manager.setHostPresence(() => false);

    await expect(DIALS[0][2](manager, "deleted-host")).rejects.toThrow(new HostGoneError("Host not found"));
  });

  it("dials as before while the host is still in a vault", async () => {
    const { fakeProcess, manager } = setup();
    manager.setHostPresence(() => true);

    await DIALS[0][2](manager, "team-host");
    expect(fakeProcess.requests().map((request) => request.type)).toContain("connect");
  });
});
