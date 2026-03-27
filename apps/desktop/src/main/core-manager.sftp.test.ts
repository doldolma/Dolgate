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

import { CoreManager } from "./core-manager";

function decodeControlFrame(
  buffer: Buffer,
): CoreRequest<Record<string, unknown>> {
  const metadataLength = buffer.readUInt32BE(1);
  return JSON.parse(
    buffer.subarray(9, 9 + metadataLength).toString("utf8"),
  ) as CoreRequest<Record<string, unknown>>;
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

describe("CoreManager SFTP sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the caller-provided endpoint id for sftpConnect", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const connectPromise = manager.sftpConnect({
      endpointId: "endpoint-123",
      host: "warpgate.example.com",
      port: 2222,
      username: "example.user:prod-db",
      authType: "keyboardInteractive",
      trustedHostKeyBase64: "AAAATEST",
      hostId: "host-1",
      title: "Warpgate Prod",
    });

    await Promise.resolve();

    const request = decodeControlFrame(fakeProcess.writes[0]);
    expect(request.type).toBe("sftpConnect");
    expect(request.endpointId).toBe("endpoint-123");
    expect(request.payload).toMatchObject({
      host: "warpgate.example.com",
      port: 2222,
      username: "example.user:prod-db",
      authType: "keyboardInteractive",
    });

    fakeProcess.emitControl({
      type: "sftpConnected",
      requestId: request.id,
      endpointId: "endpoint-123",
      payload: {
        path: "/home/example.user",
      },
    });

    await expect(connectPromise).resolves.toMatchObject({
      id: "endpoint-123",
      hostId: "host-1",
      title: "Warpgate Prod",
      path: "/home/example.user",
    });
  });

  it("broadcasts endpoint-scoped interactive auth events to renderer listeners", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    const events: CoreEvent<Record<string, unknown>>[] = [];
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    await manager.start();

    fakeProcess.emitControl({
      type: "keyboardInteractiveChallenge",
      endpointId: "endpoint-123",
      payload: {
        challengeId: "challenge-1",
        attempt: 1,
        instruction: "approve",
        prompts: [],
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "keyboardInteractiveChallenge",
        endpointId: "endpoint-123",
      }),
    );
    expect(fakeWindow.sent).toContainEqual(
      expect.objectContaining({
        channel: ipcChannels.ssh.event,
        payload: expect.objectContaining({
          type: "keyboardInteractiveChallenge",
          endpointId: "endpoint-123",
        }),
      }),
    );
  });

  it("routes endpoint-scoped keyboardInteractive responses through the endpoint id", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    await manager.respondKeyboardInteractive({
      endpointId: "endpoint-123",
      challengeId: "challenge-1",
      responses: ["ABCD-1234"],
    });

    const request = decodeControlFrame(fakeProcess.writes[0]);
    expect(request.type).toBe("keyboardInteractiveRespond");
    expect(request.endpointId).toBe("endpoint-123");
    expect(request.sessionId).toBeUndefined();
    expect(request.payload).toMatchObject({
      challengeId: "challenge-1",
      responses: ["ABCD-1234"],
    });
  });
});
