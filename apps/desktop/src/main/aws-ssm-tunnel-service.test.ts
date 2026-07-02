import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAwsCliOutput } from "./aws-service";
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
  decodeAwsCliOutput: vi.fn((raw: Uint8Array) => Buffer.from(raw).toString("utf8")),
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
  getConnectionCount: () => number;
}> {
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount += 1;
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
    getConnectionCount: () => connectionCount,
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

describe("AwsSsmTunnelService in-process backend", () => {
  const startInput = {
    runtimeId: "aws-sftp:endpoint-1",
    profileName: "default",
    region: "ap-northeast-2",
    instanceId: "i-123",
    bindAddress: null,
    bindPort: 0,
    targetPort: 22,
  };

  it("routes start/stop through the backend when it opts in", async () => {
    const service = new AwsSsmTunnelService();
    const start = vi
      .fn()
      .mockResolvedValue({ bindAddress: "127.0.0.1", bindPort: 45001 });
    const stop = vi.fn().mockResolvedValue(undefined);
    service.setInProcessBackend({ shouldUse: () => true, start, stop });

    await expect(service.start(startInput)).resolves.toEqual({
      runtimeId: "aws-sftp:endpoint-1",
      bindAddress: "127.0.0.1",
      bindPort: 45001,
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "aws-sftp:endpoint-1",
        bindAddress: "127.0.0.1",
        instanceId: "i-123",
        targetPort: 22,
      }),
    );

    await expect(service.start(startInput)).rejects.toThrow(/already running/);

    await service.stop("aws-sftp:endpoint-1");
    expect(stop).toHaveBeenCalledWith("aws-sftp:endpoint-1");
    await service.stop("aws-sftp:endpoint-1");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the binary spawn path when the backend declines", async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error("binary path taken");
    });
    const service = new AwsSsmTunnelService({
      spawnProcess: spawnProcess as never,
    });
    const start = vi.fn();
    service.setInProcessBackend({
      shouldUse: () => false,
      start,
      stop: vi.fn(),
    });

    await expect(service.start(startInput)).rejects.toThrow("binary path taken");
    expect(start).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("stops in-process tunnels on shutdown", async () => {
    const service = new AwsSsmTunnelService();
    const stop = vi.fn().mockResolvedValue(undefined);
    service.setInProcessBackend({
      shouldUse: () => true,
      start: vi
        .fn()
        .mockResolvedValue({ bindAddress: "127.0.0.1", bindPort: 45002 }),
      stop,
    });

    await service.start(startInput);
    await service.shutdown();
    expect(stop).toHaveBeenCalledWith("aws-sftp:endpoint-1");
  });
});

describe("AwsSsmTunnelService", () => {
  it("resolves start from the SSM port-open output without a local TCP probe", async () => {
    const child = new MockTunnelChild();
    const service = new AwsSsmTunnelService({
      spawnProcess: vi.fn(() => child as never),
      readyTimeoutMs: 10_000,
    });

    const startPromise = service.start({
      runtimeId: "runtime-output-ready",
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-abc",
      bindAddress: "127.0.0.1",
      bindPort: 2222,
      targetPort: 22,
    });
    await Promise.resolve();

    child.stdout.write("Port 2222 opened for sessionId session-abc.");

    await expect(startPromise).resolves.toEqual({
      runtimeId: "runtime-output-ready",
      bindAddress: "127.0.0.1",
      bindPort: 2222,
    });
  });

  it("resolves from local bind availability without connecting to the bind port", async () => {
    let connectionCount = 0;
    const listener = createServer((socket) => {
      connectionCount += 1;
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind loopback server");
    }

    const child = new MockTunnelChild();
    const service = new AwsSsmTunnelService({
      spawnProcess: vi.fn(() => child as never),
      portProbePollMs: 5,
    });

    await expect(
      service.start({
        runtimeId: "runtime-no-probe",
        profileName: "default",
        region: "ap-northeast-2",
        instanceId: "i-abc",
        bindAddress: "127.0.0.1",
        bindPort: address.port,
        targetPort: 22,
      }),
    ).resolves.toEqual({
      runtimeId: "runtime-no-probe",
      bindAddress: "127.0.0.1",
      bindPort: address.port,
    });
    expect(connectionCount).toBe(0);

    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("rejects when output is missing and the local bind port stays free", async () => {
    const listener = await listenLoopback();
    const freePort = listener.port;
    await listener.close();
    const child = new MockTunnelChild();
    const killProcessTree = vi.fn(async () => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    });
    const service = new AwsSsmTunnelService({
      spawnProcess: vi.fn(() => child as never),
      killProcessTree,
      readyTimeoutMs: 25,
      portProbePollMs: 5,
    });

    await expect(
      service.start({
        runtimeId: "runtime-grace",
        profileName: "default",
        region: "ap-northeast-2",
        instanceId: "i-abc",
        bindPort: freePort,
        targetPort: 22,
      }),
    ).rejects.toThrow(`AWS SSM tunnel on local port ${freePort} readiness timed out.`);
    expect(killProcessTree).toHaveBeenCalledTimes(1);
  });

  it("rejects start when the process exits before startup grace", async () => {
    const child = new MockTunnelChild();
    const spawnProcess = vi.fn(() => child as never);
    const service = new AwsSsmTunnelService({
      spawnProcess,
      readyTimeoutMs: 250,
      portProbePollMs: 5,
    });

    const startPromise = service.start({
      runtimeId: "runtime-early-exit",
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-abc",
      bindPort: 49124,
      targetPort: 22,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));

    child.stderr.write("session failed immediately");
    child.exitCode = 255;
    child.emit("exit", 255, null);

    await expect(startPromise).rejects.toThrow("session failed immediately");
  });

  it("rejects start when the tunnel process cannot be spawned", async () => {
    const child = new MockTunnelChild();
    const spawnProcess = vi.fn(() => child as never);
    const service = new AwsSsmTunnelService({
      spawnProcess,
      readyTimeoutMs: 250,
      portProbePollMs: 5,
    });

    const startPromise = service.start({
      runtimeId: "runtime-spawn-error",
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-abc",
      bindPort: 49125,
      targetPort: 22,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));

    child.emit("error", new Error("spawn aws ENOENT"));

    await expect(startPromise).rejects.toThrow("spawn aws ENOENT");
  });

  it("waits for process exit and local port release before stop resolves", async () => {
    const listener = await listenLoopback();
    const child = new MockTunnelChild();
    const spawnProcess = vi.fn(() => child as never);
    const killProcessTree = vi.fn(async () => undefined);
    const service = new AwsSsmTunnelService({
      spawnProcess,
      killProcessTree,
      portProbePollMs: 5,
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
    expect(listener.getConnectionCount()).toBe(0);
  });

  it("fails stop when the runtime does not exit in time", async () => {
    const listener = await listenLoopback();
    const child = new MockTunnelChild();
    const service = new AwsSsmTunnelService({
      spawnProcess: vi.fn(() => child as never),
      killProcessTree: vi.fn(async () => undefined),
      portProbePollMs: 5,
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
      portProbePollMs: 5,
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

  it("uses the shared AWS CLI decoder for tunnel output messages", async () => {
    const listener = await listenLoopback();
    const child = new MockTunnelChild();
    const onRuntimeTerminated = vi.fn();
    vi.mocked(decodeAwsCliOutput).mockReturnValue("세션 종료");
    const service = new AwsSsmTunnelService({
      spawnProcess: vi.fn(() => child as never),
      onRuntimeTerminated,
      portProbePollMs: 5,
    });

    await service.start({
      runtimeId: "runtime-3",
      profileName: "default",
      region: "ap-northeast-2",
      instanceId: "i-abc",
      bindPort: listener.port,
      targetPort: 22,
    });

    child.stderr.write(Buffer.from([0x80]));
    child.exitCode = 255;
    child.emit("exit", 255, null);

    expect(decodeAwsCliOutput).toHaveBeenCalledWith(expect.any(Buffer), {
      platform: process.platform,
      allowWindowsLegacyFallback: true,
    });
    expect(onRuntimeTerminated).toHaveBeenCalledWith("runtime-3", "세션 종료");

    await listener.close();
  });
});
