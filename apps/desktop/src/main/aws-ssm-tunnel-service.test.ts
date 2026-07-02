import { describe, expect, it, vi } from "vitest";
import { AwsSsmTunnelService } from "./aws-ssm-tunnel-service";

describe("AwsSsmTunnelService (in-process backend)", () => {
  const startInput = {
    runtimeId: "aws-sftp:endpoint-1",
    profileName: "default",
    region: "ap-northeast-2",
    instanceId: "i-123",
    bindAddress: null,
    bindPort: 0,
    targetPort: 22,
  };

  it("routes start/stop through the backend", async () => {
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

  it("fails clearly when no backend is available", async () => {
    const service = new AwsSsmTunnelService();
    await expect(service.start(startInput)).rejects.toThrow(
      /in-process SSM 터널만 지원/,
    );
  });

  it("fails clearly when the backend declines", async () => {
    const service = new AwsSsmTunnelService();
    const start = vi.fn();
    service.setInProcessBackend({
      shouldUse: () => false,
      start,
      stop: vi.fn(),
    });

    await expect(service.start(startInput)).rejects.toThrow(
      /in-process SSM 터널만 지원/,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("generates a runtime id when none is provided", async () => {
    const service = new AwsSsmTunnelService();
    const start = vi
      .fn()
      .mockResolvedValue({ bindAddress: "127.0.0.1", bindPort: 45002 });
    service.setInProcessBackend({
      shouldUse: () => true,
      start,
      stop: vi.fn(),
    });

    const handle = await service.start({ ...startInput, runtimeId: undefined });
    expect(handle.runtimeId).toBeTruthy();
    expect(handle.bindPort).toBe(45002);
  });

  it("stops in-process tunnels on shutdown", async () => {
    const service = new AwsSsmTunnelService();
    const stop = vi.fn().mockResolvedValue(undefined);
    service.setInProcessBackend({
      shouldUse: () => true,
      start: vi
        .fn()
        .mockResolvedValue({ bindAddress: "127.0.0.1", bindPort: 45003 }),
      stop,
    });

    await service.start(startInput);
    await service.shutdown();
    expect(stop).toHaveBeenCalledWith("aws-sftp:endpoint-1");
  });
});
