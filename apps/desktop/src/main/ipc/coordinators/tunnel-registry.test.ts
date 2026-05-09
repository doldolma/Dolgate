import { describe, expect, it, vi } from "vitest";
import { createTunnelRegistry } from "./tunnel-registry";

describe("tunnel registry", () => {
  it("stops endpoint tunnels idempotently", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const registry = createTunnelRegistry({
      awsSsmTunnelService: { stop } as any,
    });

    registry.trackSftpTunnelRuntime("endpoint-1", "runtime-1");
    await registry.stopSftpTunnelForEndpoint("endpoint-1");
    await registry.stopSftpTunnelForEndpoint("endpoint-1");

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("runtime-1");
  });

  it("moves container tunnel ownership from a temporary endpoint to the rule id", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const registry = createTunnelRegistry({
      awsSsmTunnelService: { stop } as any,
    });
    const host = { id: "host-1", kind: "aws-ec2" } as any;

    registry.trackContainersTunnelRuntime("endpoint-1", "runtime-1", host);
    registry.moveContainersTunnelRuntime("endpoint-1", "rule-1");

    expect(registry.getContainersHydratedHost("endpoint-1")).toBeNull();
    expect(registry.getContainersHydratedHost("rule-1")).toBe(host);
    await registry.stopContainersTunnelForEndpoint("rule-1");
    expect(stop).toHaveBeenCalledWith("runtime-1");
  });

  it("stops all tracked tunnel kinds on core shutdown", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const registry = createTunnelRegistry({
      awsSsmTunnelService: { stop } as any,
    });

    registry.trackSftpTunnelRuntime("sftp-1", "runtime-sftp");
    registry.trackContainersTunnelRuntime(
      "containers-1",
      "runtime-containers",
      { id: "host-1", kind: "aws-ec2" } as any,
    );
    registry.trackContainerShellTunnelRuntime("session-1", "runtime-shell");

    await registry.stopAll();

    expect(stop).toHaveBeenCalledWith("runtime-sftp");
    expect(stop).toHaveBeenCalledWith("runtime-containers");
    expect(stop).toHaveBeenCalledWith("runtime-shell");
  });
});
