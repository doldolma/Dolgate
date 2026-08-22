import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityLogRecord,
  CoreEvent,
  CoreRequest,
  SessionLifecycleLogMetadata,
} from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import {
  CoreFrameParser,
  encodeControlFrame,
  encodeStreamFrame,
} from "./core-framing";

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

import { buildCoreChildEnv, CoreManager } from "./core-manager";

function createFakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    window: {
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        }),
      },
    },
  };
}

function decodeControlFrame(
  buffer: Buffer,
): CoreRequest<Record<string, unknown>> {
  const metadataLength = buffer.readUInt32BE(1);
  return JSON.parse(
    buffer.subarray(9, 9 + metadataLength).toString("utf8"),
  ) as CoreRequest<Record<string, unknown>>;
}

function decodeSingleFrame(buffer: Buffer) {
  const frames = new CoreFrameParser().push(buffer);
  expect(frames).toHaveLength(1);
  return frames[0]!;
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
    stdin: {
      writable: boolean;
      destroyed: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };

  // 실제 stdin 과 같은 성질을 준다 — 종료는 stdin 을 먼저 닫고, 코어 매니저는 그것을 보고
  // 프레임 보내기를 멈춘다(writableCoreStdin).
  child.stdin = {
    writable: true,
    destroyed: false,
    write: vi.fn((chunk: Uint8Array) => {
      // 닫힌 뒤의 쓰기는 실제 스트림처럼 던진다. 조용히 받아 주면 "종료 중에는 안 보낸다" 를
      // 테스트가 통과시켜 버린다(실기기에서 터진 그 오류를 못 잡는다).
      if (!child.stdin.writable) {
        const error = new Error("write after end") as Error & { code?: string };
        error.code = "ERR_STREAM_WRITE_AFTER_END";
        throw error;
      }
      writes.push(Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(() => {
      child.stdin.writable = false;
    }),
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
    emitData(sessionId: string, text: string) {
      child.stdout.emit(
        "data",
        encodeStreamFrame({ type: "data", sessionId }, Buffer.from(text, "utf8")),
      );
    },
  };
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("CoreManager AWS SSM sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prepends standard Unix tool directories for packaged ssh-core child envs", () => {
    const env = buildCoreChildEnv(
      {
        PATH: "/Users/heodoyeong/.local/bin:/usr/bin",
      },
      {
        platform: "darwin",
        isPackaged: true,
      },
    );

    expect(env.PATH?.split(":")).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/Users/heodoyeong/.local/bin",
    ]);
  });

  it("keeps the original PATH in dev mode", () => {
    const env = buildCoreChildEnv(
      {
        PATH: "/Users/heodoyeong/.local/bin:/usr/bin",
      },
      {
        platform: "darwin",
        isPackaged: false,
      },
    );

    expect(env.PATH).toBe("/Users/heodoyeong/.local/bin:/usr/bin");
  });

  it("seeds packaged Windows ssh-core child envs with cmd and system paths", () => {
    const env = buildCoreChildEnv(
      {
        PATH: "C:\\Users\\heodoyeong\\bin;C:\\Tools",
        SystemRoot: "C:\\Windows",
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
      },
      {
        platform: "win32",
        isPackaged: true,
      },
    );

    expect(env.PATH?.split(";")).toEqual([
      "C:\\Windows\\System32",
      "C:\\Windows",
      "C:\\Windows\\System32\\Wbem",
      "C:\\Program Files\\PowerShell\\7",
      "C:\\Program Files (x86)\\PowerShell\\7",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      "C:\\Users\\heodoyeong\\bin",
      "C:\\Tools",
    ]);
    expect(env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(env.windir).toBe("C:\\Windows");
    expect(env.SystemRoot).toBe("C:\\Windows");
  });

  it("sends awsConnect to ssh-core and routes terminal writes through framed IO", async () => {
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
    const fakeWindow = createFakeWindow();
    const events: CoreEvent<Record<string, unknown>>[] = [];
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    const { sessionId } = await manager.connectAwsSession({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-1234567890",
      cols: 180,
      rows: 48,
      title: "AWS Host",
      hostId: "host-1",
      hostLabel: "AWS Host Label",
    });

    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.type).toBe("awsConnect");
    expect(connectRequest.sessionId).toBe(sessionId);
    expect(connectRequest.payload).toMatchObject({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-1234567890",
      cols: 180,
      rows: 48,
    });
    expect(connectRequest.payload).not.toHaveProperty("env");
    expect(connectRequest.payload).not.toHaveProperty("unsetEnv");

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    manager.write(sessionId, "ls -al\r");
    manager.resize(sessionId, 200, 60);
    manager.disconnect(sessionId);

    const resizeRequest = decodeControlFrame(fakeProcess.writes[2]);
    const disconnectRequest = decodeControlFrame(fakeProcess.writes[3]);

    expect(decodeControlFrame(fakeProcess.writes[0]).type).toBe("awsConnect");
    expect(resizeRequest.type).toBe("resize");
    expect(resizeRequest.payload).toMatchObject({ cols: 200, rows: 60 });
    expect(disconnectRequest.type).toBe("disconnect");
    expect(
      events.some(
        (event) => event.type === "connected" && event.sessionId === sessionId,
      ),
    ).toBe(true);
    expect(logs).toHaveLength(1);
    const lifecycle = logs[0];
    const metadata = lifecycle.metadata as unknown as SessionLifecycleLogMetadata;
    expect(lifecycle.kind).toBe("session-lifecycle");
    expect(metadata.hostLabel).toBe("AWS Host Label");
    expect(metadata.connectionDetails).toBe(
      "default · ap-northeast-2 · i-1234567890",
    );
    expect(metadata.connectionKind).toBe("aws-ssm");
    expect(metadata.status).toBe("connected");
  });

  it("sends an AWS startup command once the prompt appears, not during the MOTD gap", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const events: string[] = [];
    manager.setTerminalEventHandler((event) => {
      events.push(event.type);
    });

    const { sessionId } = await manager.connectAwsSession({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-startup",
      cols: 120,
      rows: 32,
      title: "AWS Startup",
      hostId: "host-startup",
      hostLabel: "AWS Startup",
      startupCommand: "cd /srv/app\r\n",
    });

    vi.useFakeTimers();

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });
    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });

    // connected만으로는 셸 프롬프트가 아직 안 그려졌을 수 있어 보내지 않는다.
    expect(fakeProcess.writes).toHaveLength(1);

    // MOTD/Last login만 오고 출력이 멈춰도(=rc sourcing 공백) 프롬프트가 아니므로 보내지 않는다.
    fakeProcess.emitData(
      sessionId,
      "Welcome to Ubuntu\r\nLast login: Sat from 192.168.100.4\r\n",
    );
    vi.advanceTimersByTime(300);
    expect(fakeProcess.writes).toHaveLength(1);

    // 진짜 프롬프트가 뜬 뒤 출력이 멈추면 그때 정확히 한 번만 보낸다.
    fakeProcess.emitData(sessionId, "acme@lime-dev:~$ ");
    expect(fakeProcess.writes).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(fakeProcess.writes).toHaveLength(2);

    const frame = decodeSingleFrame(fakeProcess.writes[1]!);
    expect(frame.kind).toBe("stream");
    if (frame.kind === "stream") {
      expect(frame.metadata).toMatchObject({ type: "write", sessionId });
      expect(Buffer.from(frame.payload).toString("utf8")).toBe("cd /srv/app\r");
    }
    expect(events).toEqual(["connected", "connected"]);
  });

  it("sends an AWS startup command after the max-wait even if no prompt is recognized", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();

    const { sessionId } = await manager.connectAwsSession({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-startup-exotic",
      cols: 120,
      rows: 32,
      title: "AWS Startup Exotic",
      hostId: "host-startup-exotic",
      hostLabel: "AWS Startup Exotic",
      startupCommand: "cd /srv/app",
    });

    vi.useFakeTimers();

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: { status: "connected" },
    });

    // 프롬프트로 인식 안 되는 특이한 출력만 와도(quiet는 지나도) 발사하지 않는다.
    fakeProcess.emitData(sessionId, "exotic-prompt ");
    vi.advanceTimersByTime(300);
    expect(fakeProcess.writes).toHaveLength(1);

    // 다만 상한 시간(maxWait)이 지나면 안전망으로 한 번 보낸다.
    vi.advanceTimersByTime(2500);
    expect(fakeProcess.writes).toHaveLength(2);
    const frame = decodeSingleFrame(fakeProcess.writes[1]!);
    if (frame.kind === "stream") {
      expect(Buffer.from(frame.payload).toString("utf8")).toBe("cd /srv/app\r");
    }
  });

  it("sends a server-proxy startup command once the prompt appears", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const manager = new CoreManager();
    const connectPromise = manager.connectAwsServerProxySession({
      serverUrl: "https://sync.example.com",
      accessToken: "access-token",
      profileName: "managed-prod",
      region: "ap-southeast-2",
      instanceId: "i-startup",
      cols: 120,
      rows: 32,
      title: "AWS Proxy Startup",
      hostId: "host-proxy-startup",
      hostLabel: "AWS Proxy Startup",
      startupCommand: "sudo -i",
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await connectPromise;

    vi.useFakeTimers();

    socket.receive({ type: "ready" });
    socket.receive({ type: "ready" });

    // ready(=connected)만으로는 보내지 않고 첫 출력을 기다린다.
    expect(socket.sent).toHaveLength(1);

    socket.receive({
      type: "output",
      dataBase64: Buffer.from("acme@lime-dev:~$ ", "utf8").toString("base64"),
    });
    expect(socket.sent).toHaveLength(1);

    vi.advanceTimersByTime(300);

    expect(socket.sent.slice(1).map((value) => JSON.parse(value))).toEqual([
      {
        type: "input",
        dataBase64: Buffer.from("sudo -i\r", "utf8").toString("base64"),
      },
    ]);
  });

  it("routes AWS server proxy sessions through websocket IO and terminal events", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    const events: CoreEvent<Record<string, unknown>>[] = [];
    const streamChunks: Uint8Array[] = [];
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });
    manager.setTerminalStreamHandler((_sessionId, chunk) => {
      streamChunks.push(chunk);
    });

    const connectPromise = manager.connectAwsServerProxySession({
      serverUrl: "https://sync.example.com",
      accessToken: "access-token",
      profileName: "managed-prod",
      region: "ap-southeast-2",
      instanceId: "i-1234567890",
      cols: 132,
      rows: 44,
      title: "AWS Proxy Host",
      hostId: "host-proxy",
      hostLabel: "AWS Proxy Host",
      env: {
        AWS_ACCESS_KEY_ID: "AKIATEST",
      },
      unsetEnv: ["AWS_PROFILE"],
    });

    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe(
      "wss://sync.example.com/api/aws-sessions/ws?access_token=access-token",
    );
    socket.open();
    const { sessionId } = await connectPromise;

    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "start",
      payload: {
        hostId: "host-proxy",
        label: "AWS Proxy Host",
        profileName: "",
        region: "ap-southeast-2",
        instanceId: "i-1234567890",
        cols: 132,
        rows: 44,
        env: {
          AWS_ACCESS_KEY_ID: "AKIATEST",
        },
        unsetEnv: ["AWS_PROFILE"],
      },
    });

    socket.receive({ type: "ready" });
    manager.write(sessionId, "ls\r");
    manager.resize(sessionId, 140, 40);
    manager.sendControlSignal(sessionId, "interrupt");
    socket.receive({
      type: "output",
      dataBase64: Buffer.from("hello\r\n").toString("base64"),
    });
    socket.receive({ type: "exit", message: "done" });

    expect(socket.sent.slice(1).map((message) => JSON.parse(message))).toEqual([
      {
        type: "input",
        dataBase64: Buffer.from("ls\r", "utf8").toString("base64"),
      },
      {
        type: "resize",
        cols: 140,
        rows: 40,
      },
      {
        type: "controlSignal",
        signal: "interrupt",
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(["connected", "closed"]);
    expect(Buffer.from(streamChunks[0] ?? []).toString("utf8")).toBe("hello\r\n");
    expect(fakeWindow.sent.some((entry) => entry.channel === ipcChannels.ssh.data)).toBe(true);
  });

  // X 닫기(사용자 요청)는 reason="client"로 종료돼야 렌더러 자동 재연결이
  // 이를 드롭으로 오인해 세션을 되살리지 않는다.
  it("closes AWS server proxy sessions with reason client on user disconnect", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    const events: CoreEvent<Record<string, unknown>>[] = [];
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    const connectPromise = manager.connectAwsServerProxySession({
      serverUrl: "https://sync.example.com",
      accessToken: "access-token",
      profileName: "managed-prod",
      region: "ap-southeast-2",
      instanceId: "i-1234567890",
      cols: 132,
      rows: 44,
      title: "AWS Proxy Host",
      hostId: "host-proxy",
      hostLabel: "AWS Proxy Host",
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const { sessionId } = await connectPromise;
    socket.receive({ type: "ready" });

    manager.disconnect(sessionId);

    // 프록시에 close를 알리고 소켓을 닫는다.
    expect(
      socket.sent.map((message) => JSON.parse(message)),
    ).toContainEqual({ type: "close" });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    const closedEvent = events.find((event) => event.type === "closed");
    expect(closedEvent?.payload).toMatchObject({
      message: "client requested disconnect",
      reason: "client",
    });
  });

  it("marks unexpected AWS server proxy socket drops with reason transport", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    const events: CoreEvent<Record<string, unknown>>[] = [];
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    const connectPromise = manager.connectAwsServerProxySession({
      serverUrl: "https://sync.example.com",
      accessToken: "access-token",
      profileName: "managed-prod",
      region: "ap-southeast-2",
      instanceId: "i-1234567890",
      cols: 132,
      rows: 44,
      title: "AWS Proxy Host",
      hostId: "host-proxy",
      hostLabel: "AWS Proxy Host",
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await connectPromise;
    socket.receive({ type: "ready" });

    // 서버/네트워크 쪽에서 소켓이 갑자기 닫힌 상황.
    socket.close();

    const closedEvent = events.find((event) => event.type === "closed");
    expect(closedEvent?.payload).toMatchObject({ reason: "transport" });
  });

  it("includes session-scoped AWS env overrides when provided", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    await manager.connectAwsSession({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-override",
      cols: 160,
      rows: 40,
      title: "AWS Host",
      hostId: "host-env",
      hostLabel: "AWS Host Env",
      env: {
        HOME: "/tmp/dolssh-aws-home",
        USERPROFILE: "/tmp/dolssh-aws-home",
        AWS_CONFIG_FILE: "/tmp/dolssh-aws-home/.aws/config",
        AWS_SHARED_CREDENTIALS_FILE: "/tmp/dolssh-aws-home/.aws/credentials",
      },
      unsetEnv: [
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
      ],
    });

    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.payload).toMatchObject({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-override",
      cols: 160,
      rows: 40,
      env: {
        HOME: "/tmp/dolssh-aws-home",
        USERPROFILE: "/tmp/dolssh-aws-home",
        AWS_CONFIG_FILE: "/tmp/dolssh-aws-home/.aws/config",
        AWS_SHARED_CREDENTIALS_FILE: "/tmp/dolssh-aws-home/.aws/credentials",
      },
      unsetEnv: [
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
      ],
    });
  });

  it("keeps AWS-specific logs and terminal events when ssh-core emits error and closed", async () => {
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
    const fakeWindow = createFakeWindow();
    const events: CoreEvent<Record<string, unknown>>[] = [];
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    const { sessionId } = await manager.connectAwsSession({
      profileName: "default",
      region: "us-east-1",
      instanceId: "i-abcd",
      cols: 120,
      rows: 32,
      title: "Broken Host",
      hostId: "host-2",
      hostLabel: "Broken Host Label",
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });
    fakeProcess.child.stdout.emit(
      "data",
      Buffer.concat([
        encodeControlFrame({
          type: "error",
          sessionId,
          payload: {
            message: "opening SSM data channel: websocket: bad handshake",
          },
        }),
        encodeControlFrame({
          type: "closed",
          sessionId,
          payload: {
            message: "AWS SSM session exited with code 1",
          },
        }),
      ]),
    );

    expect(
      events.some(
        (event) => event.type === "error" && event.sessionId === sessionId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "closed" && event.sessionId === sessionId,
      ),
    ).toBe(true);
    expect(logs).toHaveLength(1);
    const lifecycle = logs[0];
    const metadata = lifecycle.metadata as unknown as SessionLifecycleLogMetadata;
    expect(lifecycle.kind).toBe("session-lifecycle");
    expect(lifecycle.level).toBe("error");
    expect(metadata.hostLabel).toBe("Broken Host Label");
    expect(metadata.connectionDetails).toBe("default · us-east-1 · i-abcd");
    expect(metadata.connectionKind).toBe("aws-ssm");
    expect(metadata.status).toBe("error");
    expect(metadata.disconnectReason).toBe("opening SSM data channel: websocket: bad handshake");
    expect(metadata.durationMs).toBeTypeOf("number");
    expect(manager.listTabs()).toEqual([]);

    const dataEvent = fakeWindow.sent.find(
      (entry) => entry.channel === ipcChannels.ssh.event,
    );
    expect(dataEvent).toBeTruthy();
  });

  it("caches resize requests while connecting and flushes the latest size once the session connects", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const { sessionId } = await manager.connectAwsSession({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-resize",
      cols: 120,
      rows: 32,
      title: "Resize Host",
      hostId: "host-3",
      hostLabel: "Resize Host Label",
    });

    manager.resize(sessionId, 180, 52);
    manager.resize(sessionId, 200, 60);

    expect(fakeProcess.writes).toHaveLength(1);
    expect(decodeControlFrame(fakeProcess.writes[0]).type).toBe("awsConnect");

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    expect(fakeProcess.writes).toHaveLength(2);
    const resizeRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(resizeRequest.type).toBe("resize");
    expect(resizeRequest.payload).toMatchObject({ cols: 200, rows: 60 });

    manager.resize(sessionId, 200, 60);
    expect(fakeProcess.writes).toHaveLength(2);
  });

  it("sends controlSignal frames only for connected AWS sessions", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const { sessionId } = await manager.connectAwsSession({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-control",
      cols: 120,
      rows: 32,
      title: "Control Host",
      hostId: "host-4",
      hostLabel: "Control Host Label",
    });

    manager.sendControlSignal(sessionId, "interrupt");
    expect(fakeProcess.writes).toHaveLength(1);

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    manager.sendControlSignal(sessionId, "interrupt");

    expect(fakeProcess.writes).toHaveLength(2);
    const request = decodeControlFrame(fakeProcess.writes[1]);
    expect(request.type).toBe("controlSignal");
    expect(request.payload).toMatchObject({ signal: "interrupt" });
  });

  it.each([
    ["interrupt", "\u0003"],
    ["suspend", "\u001a"],
    ["quit", "\u001c"],
  ] as const)(
    "reroutes connected AWS text control byte %s through controlSignal",
    async (signal, input) => {
      const fakeProcess = createFakeChildProcess();
      spawnMock.mockReturnValue(fakeProcess.child);

      const manager = new CoreManager();
      const { sessionId } = await manager.connectAwsSession({
        profileName: "default",
        region: "ap-northeast-2",
        instanceId: "i-control-text",
        cols: 120,
        rows: 32,
        title: "Control Host",
        hostId: "host-5",
        hostLabel: "Control Host Label",
      });

      fakeProcess.emitControl({
        type: "connected",
        sessionId,
        payload: {
          status: "connected",
        },
      });

      manager.write(sessionId, input);

      expect(fakeProcess.writes).toHaveLength(2);
      const frame = decodeSingleFrame(fakeProcess.writes[1]);
      expect(frame.kind).toBe("control");
      if (frame.kind !== "control") {
        return;
      }
      expect(frame.metadata.type).toBe("controlSignal");
      expect(frame.metadata.payload).toMatchObject({ signal });
    },
  );

  it.each([
    ["interrupt", 0x03],
    ["suspend", 0x1a],
    ["quit", 0x1c],
  ] as const)(
    "reroutes connected AWS binary control byte %s through controlSignal",
    async (signal, byte) => {
      const fakeProcess = createFakeChildProcess();
      spawnMock.mockReturnValue(fakeProcess.child);

      const manager = new CoreManager();
      const { sessionId } = await manager.connectAwsSession({
        profileName: "default",
        region: "ap-northeast-2",
        instanceId: "i-control-binary",
        cols: 120,
        rows: 32,
        title: "Control Host",
        hostId: "host-6",
        hostLabel: "Control Host Label",
      });

      fakeProcess.emitControl({
        type: "connected",
        sessionId,
        payload: {
          status: "connected",
        },
      });

      manager.writeBinary(sessionId, Uint8Array.of(byte));

      expect(fakeProcess.writes).toHaveLength(2);
      const frame = decodeSingleFrame(fakeProcess.writes[1]);
      expect(frame.kind).toBe("control");
      if (frame.kind !== "control") {
        return;
      }
      expect(frame.metadata.type).toBe("controlSignal");
      expect(frame.metadata.payload).toMatchObject({ signal });
    },
  );

  it("keeps single-byte control input as raw write frames for SSH and local sessions", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const { sessionId: sshSessionId } = await manager.connect({
      host: "ssh.internal",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "SSH Host",
      hostId: "ssh-host-1",
      hostLabel: "SSH Host Label",
      transport: "ssh",
    });
    const { sessionId: localSessionId } = await manager.connectLocalSession({
      cols: 120,
      rows: 32,
      title: "Local",
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId: sshSessionId,
      payload: {
        status: "connected",
      },
    });
    fakeProcess.emitControl({
      type: "connected",
      sessionId: localSessionId,
      payload: {
        status: "connected",
      },
    });

    manager.write(sshSessionId, "\u0003");
    manager.writeBinary(sshSessionId, Uint8Array.of(0x03));
    manager.write(localSessionId, "\u0003");
    manager.writeBinary(localSessionId, Uint8Array.of(0x03));

    expect(fakeProcess.writes).toHaveLength(6);
    for (const frameBuffer of fakeProcess.writes.slice(2)) {
      const frame = decodeSingleFrame(frameBuffer);
      expect(frame.kind).toBe("stream");
      if (frame.kind !== "stream") {
        return;
      }
      expect(frame.metadata.type).toBe("write");
      expect([...frame.payload]).toEqual([0x03]);
    }
  });

  it("keeps SSH-over-SSM control input on the raw SSH stream while preserving AWS lifecycle metadata", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const { sessionId } = await manager.connect({
      host: "127.0.0.1",
      port: 2222,
      username: "ubuntu",
      authType: "privateKey",
      privateKeyPem: "PRIVATE",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "AWS SSH-over-SSM",
      hostId: "aws-host-ssh-1",
      hostLabel: "AWS Host",
      transport: "ssh",
      connectionKind: "aws-ssm",
      connectionDetails: "default · ap-northeast-2 · i-ssh-over-ssm",
    });
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.payload).not.toHaveProperty("connectionKind");
    expect(connectRequest.payload).not.toHaveProperty("connectionDetails");

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    manager.write(sessionId, "\u0003");
    manager.writeBinary(sessionId, Uint8Array.of(0x03));

    expect(fakeProcess.writes).toHaveLength(3);
    for (const frameBuffer of fakeProcess.writes.slice(1)) {
      const frame = decodeSingleFrame(frameBuffer);
      expect(frame.kind).toBe("stream");
      if (frame.kind !== "stream") {
        return;
      }
      expect(frame.metadata.type).toBe("write");
      expect([...frame.payload]).toEqual([0x03]);
    }
    expect(manager.getSessionLifecycleState(sessionId)).toMatchObject({
      connectionKind: "aws-ssm",
      connectionDetails: "default · ap-northeast-2 · i-ssh-over-ssm",
      status: "connected",
    });
  });

  it("connectAndAwaitReady resolves after the first connected event", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const connectPromise = manager.connectAndAwaitReady({
      host: "ssh.internal",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "SSH Host",
      hostId: "ssh-host-1",
      hostLabel: "SSH Host Label",
      transport: "ssh",
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(connectRequest.type).toBe("connect");

    fakeProcess.emitControl({
      type: "connected",
      sessionId: connectRequest.sessionId,
      payload: { status: "connected" },
    });

    await expect(connectPromise).resolves.toEqual({
      sessionId: connectRequest.sessionId,
    });
  });

  it("connectAndAwaitReady replays connected after resolving so renderer can catch up", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const events: CoreEvent<Record<string, unknown>>[] = [];
    const manager = new CoreManager();
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });
    const connectPromise = manager.connectAndAwaitReady({
      host: "ssh.internal",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "SSH Host",
      hostId: "ssh-host-1",
      hostLabel: "SSH Host Label",
      transport: "ssh",
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);

    fakeProcess.emitControl({
      type: "connected",
      sessionId: connectRequest.sessionId,
      payload: { status: "connected" },
    });

    await connectPromise;
    await delay(40);

    expect(
      events.filter(
        (event) =>
          event.type === "connected" &&
          event.sessionId === connectRequest.sessionId,
      ),
    ).toHaveLength(2);
  });

  it("connectAndAwaitReady rejects pre-ready errors and suppresses the speculative tab event", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    manager.registerWindow(fakeWindow.window as never);

    const connectPromise = manager.connectAndAwaitReady({
      host: "ssh.internal",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "SSH Host",
      hostId: "ssh-host-1",
      hostLabel: "SSH Host Label",
      transport: "ssh",
      startupCommand: "echo ready",
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);

    fakeProcess.emitControl({
      type: "error",
      sessionId: connectRequest.sessionId,
      payload: { message: "connection refused" },
    });

    await expect(connectPromise).rejects.toThrow("connection refused");
    expect(fakeWindow.sent).toEqual([]);

    fakeProcess.emitControl({
      type: "closed",
      sessionId: connectRequest.sessionId,
      payload: { message: "closed after error" },
    });
    expect(fakeWindow.sent).toEqual([]);

    manager.disconnect(connectRequest.sessionId ?? "");
    expect(fakeWindow.sent).toEqual([]);
  });

  it("connectAndAwaitReady rejects pre-ready closed events", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const connectPromise = manager.connectAndAwaitReady({
      host: "ssh.internal",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "secret",
      trustedHostKeyBase64: "trusted",
      cols: 120,
      rows: 32,
      title: "SSH Host",
      hostId: "ssh-host-1",
      hostLabel: "SSH Host Label",
      transport: "ssh",
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);

    fakeProcess.emitControl({
      type: "closed",
      sessionId: connectRequest.sessionId,
      payload: { message: "connection closed" },
    });

    await expect(connectPromise).rejects.toThrow("connection closed");
  });

  it("connect returns immediately without waiting for a connected event", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    await expect(
      manager.connect({
        host: "ssh.internal",
        port: 22,
        username: "ubuntu",
        authType: "password",
        password: "secret",
        trustedHostKeyBase64: "trusted",
        cols: 120,
        rows: 32,
        title: "SSH Host",
        hostId: "ssh-host-1",
        hostLabel: "SSH Host Label",
        transport: "ssh",
      }),
    ).resolves.toEqual({ sessionId: expect.any(String) });
    expect(fakeProcess.writes).toHaveLength(1);
  });

  it("keeps multi-byte AWS payloads as raw write frames", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const { sessionId } = await manager.connectAwsSession({
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-control-multi",
      cols: 120,
      rows: 32,
      title: "Control Host",
      hostId: "host-7",
      hostLabel: "Control Host Label",
    });

    fakeProcess.emitControl({
      type: "connected",
      sessionId,
      payload: {
        status: "connected",
      },
    });

    manager.write(sessionId, "\u0003\u0003");
    manager.writeBinary(sessionId, Uint8Array.of(0x03, 0x03));

    expect(fakeProcess.writes).toHaveLength(3);

    const textFrame = decodeSingleFrame(fakeProcess.writes[1]);
    expect(textFrame.kind).toBe("stream");
    if (textFrame.kind === "stream") {
      expect(textFrame.metadata.type).toBe("write");
      expect([...textFrame.payload]).toEqual([0x03, 0x03]);
    }

    const binaryFrame = decodeSingleFrame(fakeProcess.writes[2]);
    expect(binaryFrame.kind).toBe("stream");
    if (binaryFrame.kind === "stream") {
      expect(binaryFrame.metadata.type).toBe("write");
      expect([...binaryFrame.payload]).toEqual([0x03, 0x03]);
    }
  });

  it("uses dedicated SSM port forward commands for AWS forwarding runtimes", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const startPromise = manager.startSsmPortForward({
      ruleId: "rule-ssm-1",
      hostId: "aws-host-1",
      profileName: "default",
      region: "ap-northeast-2",
      targetType: "instance",
      targetId: "i-ssm",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      targetKind: "remote-host",
      targetPort: 5432,
      remoteHost: "db.internal",
    });

    await waitForWriteCount(fakeProcess.writes, 1);

    const startRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(startRequest.type).toBe("ssmPortForwardStart");
    expect(startRequest.endpointId).toBe("rule-ssm-1");

    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "rule-ssm-1",
      payload: {
        transport: "aws-ssm",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        status: "running",
      },
    });

    await startPromise;
    const stopPromise = manager.stopPortForward("rule-ssm-1");
    await waitForWriteCount(fakeProcess.writes, 2);

    const stopRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(stopRequest.type).toBe("ssmPortForwardStop");
    expect(stopRequest.endpointId).toBe("rule-ssm-1");

    fakeProcess.emitControl({
      type: "portForwardStopped",
      requestId: stopRequest.id,
      endpointId: "rule-ssm-1",
      payload: {
        message: "stopped",
      },
    });

    await stopPromise;
  });

  // 앱을 끄는 동안 도착한 정리 요청은 조용히 끝나야 한다.
  //
  // 종료는 stdin 을 먼저 닫고 exit 이벤트까지 기다린다. 그 사이에도 this.process 는 남아 있어서,
  // 예전에는 닫힌 stdin 에 프레임을 써서 ERR_STREAM_WRITE_AFTER_END 가 메인 프로세스의 예외 창으로
  // 올라왔다 — RDP 세션을 켠 채 앱을 끄면 세션 종료 이벤트가 SSM 터널 정리를 부른다. 창이 좁아서
  // macOS 에서는 잘 드러나지 않고 Windows 에서만 매번 터졌다(실기기).
  it("종료 중에 들어온 SSM 터널 정리는 닫힌 stdin 에 쓰지 않는다", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    await manager.start();

    // 실기기의 그 창을 그대로 만든다: stdin 은 닫혔고 프로세스는 아직 살아 있다.
    //
     // shutdown() 을 태우지 않는 이유는 이 하네스의 kill 이 exit 을 곧바로 알려서 프로세스 참조가
    // 즉시 비기 때문이다 — Windows 에서는 exit 이 다음 tick 에 오고, 그 사이가 문제의 창이었다.
    fakeProcess.child.stdin.end();
    const writesBefore = fakeProcess.child.stdin.write.mock.calls.length;

    await expect(manager.stopSsmTunnel("rdp:sess-1")).resolves.toBeUndefined();
    expect(fakeProcess.child.stdin.write.mock.calls.length).toBe(writesBefore);
  });

  it("runs endpoint-scoped SSM tunnels without registering port-forward runtimes", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    manager.setSsmPortForwardTokenIssuer(async () => ({
      sessionId: "ssm-sess-tunnel",
      streamUrl: "wss://ssmmessages.example/v1/data-channel/ssm-sess-tunnel",
      tokenValue: "token-tunnel",
    }));

    const startPromise = manager.startSsmTunnel({
      ruleId: "aws-sftp:endpoint-1",
      profileName: "default",
      region: "ap-northeast-2",
      targetType: "instance",
      targetId: "i-ssm",
      bindAddress: "127.0.0.1",
      bindPort: 0,
      targetKind: "instance-port",
      targetPort: 22,
    });

    await waitForWriteCount(fakeProcess.writes, 1);

    const startRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(startRequest.type).toBe("ssmPortForwardStart");
    expect(startRequest.endpointId).toBe("aws-sftp:endpoint-1");
    expect(startRequest.payload).toMatchObject({
      targetId: "i-ssm",
      targetPort: 22,
      streamUrl: "wss://ssmmessages.example/v1/data-channel/ssm-sess-tunnel",
      tokenValue: "token-tunnel",
      ssmSessionId: "ssm-sess-tunnel",
    });

    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "aws-sftp:endpoint-1",
      payload: {
        transport: "aws-ssm",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 45111,
        status: "running",
      },
    });

    await expect(startPromise).resolves.toEqual({
      bindAddress: "127.0.0.1",
      bindPort: 45111,
    });
    // startSsmTunnel itself never registers a definition; the runtime entry (if
    // any) comes from the shared async event routing, same as ECS tunnels.
    expect(
      manager.listPortForwardRuntimes().filter((runtime) => runtime.hostId),
    ).toEqual([]);

    const stopPromise = manager.stopSsmTunnel("aws-sftp:endpoint-1");
    await waitForWriteCount(fakeProcess.writes, 2);

    const stopRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(stopRequest.type).toBe("ssmPortForwardStop");
    expect(stopRequest.endpointId).toBe("aws-sftp:endpoint-1");

    fakeProcess.emitControl({
      type: "portForwardStopped",
      requestId: stopRequest.id,
      endpointId: "aws-sftp:endpoint-1",
      payload: { message: "stopped" },
    });

    await stopPromise;
  });

  it("preserves visible container transport while using AWS remote-host forwarding backend", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const startPromise = manager.startSsmPortForward({
      ruleId: "rule-container-aws-1",
      hostId: "aws-host-1",
      profileName: "default",
      region: "ap-northeast-2",
      targetType: "instance",
      targetId: "i-ssm",
      bindAddress: "127.0.0.1",
      bindPort: 0,
      targetKind: "remote-host",
      targetPort: 5432,
      remoteHost: "172.17.0.2",
      transport: "container",
    });

    await waitForWriteCount(fakeProcess.writes, 1);

    const startRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(startRequest.type).toBe("ssmPortForwardStart");
    expect(startRequest.endpointId).toBe("rule-container-aws-1");

    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "rule-container-aws-1",
      payload: {
        transport: "aws-ssm",
        mode: "local",
        method: "ssm-remote-host",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        status: "running",
      },
    });

    const runtime = await startPromise;
    expect(runtime.transport).toBe("container");
    expect(runtime.method).toBe("ssm-remote-host");
    expect(runtime.bindPort).toBe(15432);

    const stopPromise = manager.stopPortForward("rule-container-aws-1");
    await waitForWriteCount(fakeProcess.writes, 2);

    const stopRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(stopRequest.type).toBe("ssmPortForwardStop");
    expect(stopRequest.endpointId).toBe("rule-container-aws-1");

    fakeProcess.emitControl({
      type: "portForwardStopped",
      requestId: stopRequest.id,
      endpointId: "rule-container-aws-1",
      payload: {
        message: "stopped",
      },
    });

    await stopPromise;
  });

  it("preserves visible ecs-task transport while using AWS remote-host forwarding backend", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();

    const startPromise = manager.startSsmPortForward({
      ruleId: "rule-ecs-task-1",
      hostId: "ecs-host-1",
      profileName: "default",
      region: "ap-northeast-2",
      targetType: "ecs-task",
      targetId: "ecs:demo-cluster_task-123_runtime-456",
      bindAddress: "127.0.0.1",
      bindPort: 0,
      targetKind: "remote-host",
      targetPort: 8080,
      remoteHost: "127.0.0.1",
      transport: "ecs-task",
    });

    await waitForWriteCount(fakeProcess.writes, 1);

    const startRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(startRequest.type).toBe("ssmPortForwardStart");
    expect(startRequest.endpointId).toBe("rule-ecs-task-1");

    fakeProcess.emitControl({
      type: "portForwardStarted",
      requestId: startRequest.id,
      endpointId: "rule-ecs-task-1",
      payload: {
        transport: "aws-ssm",
        mode: "local",
        method: "ssm-remote-host",
        bindAddress: "127.0.0.1",
        bindPort: 18080,
        status: "running",
      },
    });

    const runtime = await startPromise;
    expect(runtime.transport).toBe("ecs-task");
    expect(runtime.method).toBe("ssm-remote-host");
    expect(runtime.bindPort).toBe(18080);
  });
});
