import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, CoreRequest } from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import { CoreFrameParser, encodeControlFrame } from "./core-framing";

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

interface ActivityLogEntry {
  level: "info" | "warn" | "error";
  category: "session" | "audit";
  message: string;
  metadata?: Record<string, unknown> | null;
}

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

describe("CoreManager AWS SSM sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const logs: ActivityLogEntry[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager((entry) => {
      logs.push(entry);
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
    expect(
      logs.some((entry) => entry.message === "AWS SSM 세션이 연결되었습니다."),
    ).toBe(true);
  });

  it("keeps AWS-specific logs and terminal events when ssh-core emits error and closed", async () => {
    const logs: ActivityLogEntry[] = [];
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager((entry) => {
      logs.push(entry);
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
            message: "session-manager-plugin failed",
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
    expect(
      logs.some(
        (entry) => entry.message === "AWS SSM 세션 오류가 발생했습니다.",
      ),
    ).toBe(true);
    expect(
      logs.some((entry) => entry.message === "AWS SSM 세션이 종료되었습니다."),
    ).toBe(true);
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
      instanceId: "i-ssm",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      targetKind: "remote-host",
      targetPort: 5432,
      remoteHost: "db.internal",
    });

    await Promise.resolve();

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
    await Promise.resolve();

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
});
