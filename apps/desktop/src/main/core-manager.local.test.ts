import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, CoreRequest } from "@shared";
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
});
