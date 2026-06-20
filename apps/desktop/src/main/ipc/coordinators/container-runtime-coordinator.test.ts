import { afterEach, describe, expect, it, vi } from "vitest";
import { createContainerRuntimeCoordinator } from "./container-runtime-coordinator";

function createAwsHost() {
  return {
    id: "host-1",
    kind: "aws-ec2",
    label: "Prod EC2",
    awsProfileId: null,
    awsProfileName: "prod",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-123",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "prod",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
  } as any;
}

function createCoordinator(overrides: Record<string, unknown> = {}) {
  const host = createAwsHost();
  const deps = {
    coreManager: {
      getContainersEndpointRuntime: vi.fn(() => null),
      containersConnect: vi.fn().mockResolvedValue({
        runtime: null,
        runtimeCommand: null,
        unsupportedReason: "runtime missing",
      }),
      setPortForwardRuntime: vi.fn(),
      listPortForwardRuntimes: vi.fn(() => []),
      containersDisconnect: vi.fn().mockResolvedValue(undefined),
    },
    knownHosts: {},
    awsService: {
      resolveManagedProfileNameOrFallback: vi.fn((_id, name) => name),
      sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
    },
    awsSsmTunnelService: {
      start: vi.fn().mockResolvedValue({
        runtimeId: "runtime-1",
        bindAddress: "127.0.0.1",
        bindPort: 2222,
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    awsSftpCoordinator: {
      consumePreflight: vi.fn(() => host),
      resolvePreflight: vi.fn(),
      clearPreflight: vi.fn(),
      createEphemeralAwsSftpKeyPair: vi.fn(() => ({
        privateKeyPem: "private",
        publicKey: "public",
      })),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
    },
    tunnelRegistry: {
      getContainersHydratedHost: vi.fn(() => null),
      trackContainersTunnelRuntime: vi.fn(),
      moveContainersTunnelRuntime: vi.fn(),
      stopContainersTunnelForEndpoint: vi.fn().mockResolvedValue(undefined),
    },
    secretCoordinator: {
      resolveRuntimeSshSecrets: vi.fn(),
      persistHostSpecificSecret: vi.fn(),
    },
    hostCoordinator: {
      requireTrustedHostKeys: vi.fn(() => ["trusted"]),
      requireConfiguredSshUsername: vi.fn(() => "ubuntu"),
    },
    resolveJumpHostTarget: vi.fn().mockResolvedValue(undefined),
    emitContainersConnectionProgress: vi.fn(),
    ...overrides,
  } as any;

  return {
    deps,
    host,
    coordinator: createContainerRuntimeCoordinator(deps),
  };
}

describe("container runtime coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops temporary AWS tunnels when no container runtime is available", async () => {
    const { deps, coordinator, host } = createCoordinator();

    await expect(
      coordinator.ensureContainersEndpoint(host, "endpoint-1"),
    ).resolves.toMatchObject({
      endpointId: "endpoint-1",
      runtime: null,
      unsupportedReason: "runtime missing",
    });

    expect(deps.awsSsmTunnelService.stop).toHaveBeenCalledWith("runtime-1");
    expect(deps.tunnelRegistry.trackContainersTunnelRuntime).not.toHaveBeenCalled();
  });

  it("publishes an error runtime if container tunnel startup fails", async () => {
    const { deps, coordinator, host } = createCoordinator({
      coreManager: {
        getContainersEndpointRuntime: vi.fn(() => null),
        containersConnect: vi.fn().mockResolvedValue({
          runtime: null,
          runtimeCommand: null,
          unsupportedReason: "runtime missing",
        }),
        setPortForwardRuntime: vi.fn(),
        listPortForwardRuntimes: vi.fn(() => []),
        containersDisconnect: vi.fn().mockResolvedValue(undefined),
      },
    });

    await expect(
      coordinator.startContainerTunnelRuntime({
        ruleId: "rule-1",
        host,
        containerId: "container-1",
        networkName: "bridge",
        targetPort: 8080,
        bindAddress: "127.0.0.1",
        bindPort: 18080,
      }),
    ).rejects.toThrow("runtime missing");

    expect(deps.coreManager.setPortForwardRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ruleId: "rule-1",
        status: "error",
        message: "runtime missing",
      }),
    );
  });

  it("retries AWS container runtime connect once after a transient SSH handshake failure", async () => {
    vi.useFakeTimers();
    const containersConnect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ssh handshake failed: EOF"))
      .mockResolvedValueOnce({
        runtime: "docker",
        runtimeCommand: "/usr/bin/docker",
        unsupportedReason: null,
      });
    const { deps, coordinator, host } = createCoordinator({
      coreManager: {
        getContainersEndpointRuntime: vi.fn(() => null),
        containersConnect,
        setPortForwardRuntime: vi.fn(),
        listPortForwardRuntimes: vi.fn(() => []),
        containersDisconnect: vi.fn().mockResolvedValue(undefined),
      },
    });

    const connectPromise = coordinator.ensureContainersEndpoint(host, "endpoint-1");
    await vi.advanceTimersByTimeAsync(500);

    await expect(connectPromise).resolves.toMatchObject({
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
    });
    expect(containersConnect).toHaveBeenCalledTimes(2);
    expect(deps.tunnelRegistry.trackContainersTunnelRuntime).toHaveBeenCalledWith(
      "endpoint-1",
      "runtime-1",
      host,
    );
  });
});
