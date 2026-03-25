import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, CoreRequest } from "@shared";
import { ipcChannels } from "../common/ipc-channels";
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
