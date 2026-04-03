import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AwsSsmTunnelService,
  buildAwsSsmTunnelArgs,
} from "./aws-ssm-tunnel-service";

vi.mock("./aws-service", () => ({
  resolveAwsExecutable: vi.fn(async (command: "aws" | "session-manager-plugin") =>
    command === "aws" ? "aws" : "session-manager-plugin",
  ),
  buildAwsCommandEnv: vi.fn(async () => ({
    PATH: process.env.PATH ?? "",
  })),
}));

class MockTunnelChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  pid = 12345;
}

async function listenLoopback(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((socket) => {
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind loopback server");
  }
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildAwsSsmTunnelArgs", () => {
  it("builds a start-session command for port forwarding", () => {
    expect(
      buildAwsSsmTunnelArgs({
        profileName: "default",
        region: "ap-northeast-2",
        instanceId: "i-abc",
        bindPort: 2222,
        targetPort: 22,
      }),
    ).toEqual([
      "ssm",
      "start-session",
      "--target",
      "i-abc",
      "--document-name",
      "AWS-StartPortForwardingSession",
      "--parameters",
      '{"portNumber":["22"],"localPortNumber":["2222"]}',
      "--profile",
      "default",
      "--region",
      "ap-northeast-2",
    ]);
  });
});

describe("AwsSsmTunnelService", () => {
  it("waits for process exit and local port release before stop resolves", async () => {
    const listener = await listenLoopback();
    const child = new MockTunnelChild();
    const spawnProcess = vi.fn(() => child as never);
    const killProcessTree = vi.fn(async () => undefined);
    const service = new AwsSsmTunnelService({
      spawnProcess,
      killProcessTree,
      stopTimeoutMs: 250,
      portReleaseTimeoutMs: 250,
    });

    const handle = await service.start({
      runtimeId: "runtime-1",
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-abc",
      bindAddress: "127.0.0.1",
      bindPort: listener.port,
      targetPort: 22,
    });

    expect(handle).toEqual({
      runtimeId: "runtime-1",
      bindAddress: "127.0.0.1",
      bindPort: listener.port,
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    let stopResolved = false;
    const stopPromise = service.stop("runtime-1").then(() => {
      stopResolved = true;
    });
    await Promise.resolve();

    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(stopResolved).toBe(false);

    child.exitCode = 1;
    child.emit("exit", 1, null);
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    await listener.close();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it("fails stop when the runtime does not exit in time", async () => {
    const listener = await listenLoopback();
    const child = new MockTunnelChild();
    const service = new AwsSsmTunnelService({
      spawnProcess: vi.fn(() => child as never),
      killProcessTree: vi.fn(async () => undefined),
      stopTimeoutMs: 25,
      portReleaseTimeoutMs: 25,
    });

    await service.start({
      runtimeId: "runtime-timeout",
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-abc",
      bindPort: listener.port,
      targetPort: 22,
    });

    await expect(service.stop("runtime-timeout")).rejects.toThrow(
      "Timed out waiting for AWS SSM tunnel runtime-timeout to stop.",
    );

    await listener.close();
  });

  it("notifies when a runtime exits unexpectedly", async () => {
    const listener = await listenLoopback();
    const child = new MockTunnelChild();
    const onRuntimeTerminated = vi.fn();
    const service = new AwsSsmTunnelService({
      spawnProcess: vi.fn(() => child as never),
      onRuntimeTerminated,
    });

    await service.start({
      runtimeId: "runtime-2",
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-abc",
      bindPort: listener.port,
      targetPort: 22,
    });

    child.stderr.write("session ended unexpectedly");
    child.exitCode = 255;
    child.emit("exit", 255, null);

    expect(onRuntimeTerminated).toHaveBeenCalledWith(
      "runtime-2",
      "session ended unexpectedly",
    );

    await listener.close();
  });
});
