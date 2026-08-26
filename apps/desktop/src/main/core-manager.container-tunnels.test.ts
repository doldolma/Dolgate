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

describe("컨테이너 임시 터널의 주인", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("창이 닫히면 그 창이 연 터널만 정지시킨다", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const window = createFakeWindow(101);
    manager.registerWindow(window as never);
    const stop = vi
      .spyOn(manager, "stopPortForward")
      .mockResolvedValue(undefined as never);

    manager.registerContainerTunnelOwner("container-service-tunnel:a", {
      ownerWebContentsId: 101,
    });
    manager.registerContainerTunnelOwner("container-service-tunnel:b", {
      ownerWebContentsId: 202,
    });

    // 렌더러가 정리해 주기를 기다리지 않는다 — 창이 닫히면 메인이 회수한다.
    window.emit("closed");
    await Promise.resolve();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledWith("container-service-tunnel:a");
    expect(stop).not.toHaveBeenCalledWith("container-service-tunnel:b");
  });

  it("세션이 끝나면 그 세션이 연 터널을 정지시킨다", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const window = createFakeWindow(101);
    manager.registerWindow(window as never);
    const stop = vi
      .spyOn(manager, "stopPortForward")
      .mockResolvedValue(undefined as never);

    const { sessionId } = await manager.runWithSessionOwner(101, () =>
      manager.connectLocalSession({ cols: 120, rows: 32, title: "Terminal" }),
    );
    manager.registerContainerTunnelOwner("container-service-tunnel:s", {
      ownerWebContentsId: 101,
      sessionId,
    });
    manager.registerContainerTunnelOwner("container-service-tunnel:other", {
      ownerWebContentsId: 101,
      sessionId: "another-session",
    });

    // 탭을 닫든 원격이 끊든 코어는 closed 를 낸다 — 회수는 그 한 지점에 걸린다.
    fakeProcess.emitControl({
      type: "closed",
      sessionId,
      payload: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledWith("container-service-tunnel:s");
    expect(stop).not.toHaveBeenCalledWith("container-service-tunnel:other");
  });

  it("정지시킨 터널은 기록에서 지운다 — 나중에 창을 닫아도 다시 부르지 않는다", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const manager = new CoreManager();
    const window = createFakeWindow(101);
    manager.registerWindow(window as never);
    const stop = vi
      .spyOn(manager, "stopPortForward")
      .mockResolvedValue(undefined as never);

    manager.registerContainerTunnelOwner("container-service-tunnel:a", {
      ownerWebContentsId: 101,
    });
    manager.releaseContainerTunnelOwner("container-service-tunnel:a");

    window.emit("closed");
    await Promise.resolve();
    await Promise.resolve();

    expect(stop).not.toHaveBeenCalled();
  });
});
