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
      requireManagedProfileName: vi.fn((_id, name) => name),
      sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
      buildServerProxySessionEnvSpec: vi.fn().mockResolvedValue({
        env: { AWS_ACCESS_KEY_ID: "AKIA" },
        unsetEnv: [],
      }),
    },
    authService: {
      getServerUrl: vi.fn(() => "https://sync.example.com"),
      getAccessToken: vi.fn(() => "token-1"),
      refreshSession: vi.fn().mockResolvedValue({ status: "authenticated" }),
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
      trackContainersHydratedHost: vi.fn(),
      moveContainersTunnelRuntime: vi.fn(),
      stopContainersTunnelForEndpoint: vi.fn().mockResolvedValue(undefined),
    },
    secretCoordinator: {
      resolveRuntimeSshSecrets: vi.fn(),
      persistHostSpecificSecret: vi.fn(),
    },
    hostCoordinator: {
      requireTrustedHostKeys: vi.fn(() => ["trusted"]),
      resolveTrustedHostKeys: vi.fn(() => ["trusted"]),
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

  it("shares one in-flight endpoint connection across windows", async () => {
    let resolveConnection:
      | ((value: {
          runtime: "docker";
          runtimeCommand: string;
          unsupportedReason: null;
        }) => void)
      | undefined;
    const containersConnect = vi.fn(
      () =>
        new Promise<{
          runtime: "docker";
          runtimeCommand: string;
          unsupportedReason: null;
        }>((resolve) => {
          resolveConnection = resolve;
        }),
    );
    const { deps, coordinator, host } = createCoordinator({
      coreManager: {
        getContainersEndpointRuntime: vi.fn(() => null),
        containersConnect,
        setPortForwardRuntime: vi.fn(),
        listPortForwardRuntimes: vi.fn(() => []),
        containersDisconnect: vi.fn().mockResolvedValue(undefined),
      },
    });

    const first = coordinator.ensureContainersEndpoint(host, "endpoint-shared");
    const second = coordinator.ensureContainersEndpoint(host, "endpoint-shared");
    await vi.waitFor(() => {
      expect(containersConnect).toHaveBeenCalledTimes(1);
    });
    resolveConnection?.({
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
      unsupportedReason: null,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ endpointId: "endpoint-shared" }),
      expect.objectContaining({ endpointId: "endpoint-shared" }),
    ]);
    expect(deps.awsSsmTunnelService.start).toHaveBeenCalledTimes(1);
  });

  it("routes AWS container runtime through the server proxy when enabled", async () => {
    const serverProxyHost = {
      ...createAwsHost(),
      awsSsmServerProxyEnabled: true,
    };
    const containersConnect = vi.fn().mockResolvedValue({
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
      unsupportedReason: null,
    });
    const { deps, coordinator } = createCoordinator({
      coreManager: {
        getContainersEndpointRuntime: vi.fn(() => null),
        containersConnect,
        setPortForwardRuntime: vi.fn(),
        listPortForwardRuntimes: vi.fn(() => []),
        containersDisconnect: vi.fn().mockResolvedValue(undefined),
      },
      awsSftpCoordinator: {
        consumePreflight: vi.fn(() => serverProxyHost),
        resolvePreflight: vi.fn(),
        clearPreflight: vi.fn(),
        createEphemeralAwsSftpKeyPair: vi.fn(() => ({
          privateKeyPem: "private",
          publicKey: "public",
        })),
        reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      },
    });

    await expect(
      coordinator.ensureContainersEndpoint(serverProxyHost, "endpoint-1"),
    ).resolves.toMatchObject({ endpointId: "endpoint-1", runtime: "docker" });

    // 서버 프록시 경로: WS 릴레이로 연결하고, 로컬 SSM 터널·EIC 푸시는 하지 않는다.
    expect(containersConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "i-123",
        port: 22,
        wsProxy: expect.objectContaining({
          url: expect.stringContaining("/api/aws-ssh-tunnel/ws"),
          authToken: "token-1",
        }),
      }),
    );
    expect(deps.awsSsmTunnelService.start).not.toHaveBeenCalled();
    expect(deps.awsService.sendSshPublicKey).not.toHaveBeenCalled();
    expect(deps.tunnelRegistry.trackContainersHydratedHost).toHaveBeenCalledWith(
      "endpoint-1",
      serverProxyHost,
    );
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

/**
 * 세션 패널의 도커 섹션이 여는 길. 화면에서 두 번 터진 그 경로를 여기서 실제로 돌린다 —
 * 네트워크 이름을 안 고르고(우리가 정한다), 로컬 포트도 0 으로 보낸다(코어가 빈 포트를 잡는다).
 */
describe("세션 패널이 여는 컨테이너 터널", () => {
  function createSshCoordinator() {
    const host = {
      id: "host-ssh",
      kind: "ssh",
      label: "lime-dev",
      hostname: "10.0.1.24",
      port: 22,
      username: "ubuntu",
      authType: "password",
    } as any;
    const startPortForward = vi.fn().mockResolvedValue({ ruleId: "rule-1" });
    const { deps, coordinator } = createCoordinator({
      coreManager: {
        getContainersEndpointRuntime: vi.fn(() => ({
          runtime: "docker",
          runtimeCommand: "docker",
        })),
        containersConnect: vi.fn().mockResolvedValue({
          runtime: "docker",
          runtimeCommand: "docker",
          unsupportedReason: null,
        }),
        containersInspect: vi.fn().mockResolvedValue({
          id: "abc123",
          name: "dolgate-sync-api-dev",
          runtime: "docker",
          image: "app:1",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          command: "node",
          entrypoint: "",
          ports: [
            // 공개되지 않은 포트. 코어의 inspect 는 Config.Exposed 까지 담는다.
            { containerPort: 8080, protocol: "tcp", publishedBindings: [] },
          ],
          networks: [
            { name: "none", ipAddress: "", aliases: [] },
            { name: "dolgate-dev_default", ipAddress: "172.19.0.4", aliases: [] },
          ],
          mounts: [],
          labels: {},
        }),
        setPortForwardRuntime: vi.fn(),
        listPortForwardRuntimes: vi.fn(() => []),
        containersDisconnect: vi.fn().mockResolvedValue(undefined),
        startPortForward,
      },
    });
    return { deps, coordinator, host, startPortForward };
  }

  it("네트워크를 안 고르면 IP 가 있는 네트워크로 스스로 붙는다", async () => {
    const { coordinator, host, startPortForward } = createSshCoordinator();

    await coordinator.startContainerTunnelRuntime({
      ruleId: "container-service-tunnel:1",
      host,
      containerId: "abc123",
      networkName: "",
      targetPort: 8080,
      bindAddress: "127.0.0.1",
      bindPort: 0,
    });

    expect(startPortForward).toHaveBeenCalledTimes(1);
    expect(startPortForward.mock.calls[0][0]).toMatchObject({
      ruleId: "container-service-tunnel:1",
      hostId: "host-ssh",
      // IP 가 빈 네트워크는 건너뛴다.
      targetHost: "172.19.0.4",
      targetPort: 8080,
      // 로컬 포트는 코어가 고른다.
      bindPort: 0,
      transport: "container",
    });
  });

  it("패널이 네트워크를 실어 보내면 코어에 다시 묻지 않는다", async () => {
    // sudo 가 필요한 호스트에서는 이 길만 통한다 — 패널은 그 세션의 sudo 로 도커를 읽지만
    // 코어의 컨테이너 연결은 같은 비밀번호를 갖고 있지 않다(그래서 inspect 가 권한 오류로 죽었다).
    const { coordinator, host, startPortForward, deps } = createSshCoordinator();

    await coordinator.startContainerTunnelRuntime({
      ruleId: "container-service-tunnel:supplied",
      host,
      containerId: "abc123",
      networkName: "",
      targetPort: 8080,
      bindAddress: "127.0.0.1",
      bindPort: 0,
      networks: [
        { name: "none", ipAddress: "" },
        { name: "dolgate-dev_default", ipAddress: "172.19.0.4" },
      ],
    });

    expect(deps.coreManager.containersInspect).not.toHaveBeenCalled();
    expect(startPortForward.mock.calls[0][0]).toMatchObject({
      targetHost: "172.19.0.4",
      targetPort: 8080,
    });
  });

  it("실어 온 것이 host 네트워킹이면 그 호스트의 루프백으로 간다", async () => {
    const { coordinator, host, startPortForward, deps } = createSshCoordinator();

    await coordinator.startContainerTunnelRuntime({
      ruleId: "container-service-tunnel:hostnet",
      host,
      containerId: "abc123",
      networkName: "",
      targetPort: 80,
      bindAddress: "127.0.0.1",
      bindPort: 0,
      networks: [{ name: "host", ipAddress: "" }],
    });

    expect(deps.coreManager.containersInspect).not.toHaveBeenCalled();
    expect(startPortForward.mock.calls[0][0]).toMatchObject({
      targetHost: "127.0.0.1",
      targetPort: 80,
    });
  });

  it("실어 온 네트워크로 정할 수 없으면 코어에 물어본다", async () => {
    // 빈 배열이나 정할 수 없는 목록은 "모른다" 는 뜻이다 — 예전 길로 떨어진다.
    const { coordinator, host, startPortForward, deps } = createSshCoordinator();

    await coordinator.startContainerTunnelRuntime({
      ruleId: "container-service-tunnel:fallback",
      host,
      containerId: "abc123",
      networkName: "",
      targetPort: 8080,
      bindAddress: "127.0.0.1",
      bindPort: 0,
      networks: [{ name: "none", ipAddress: "" }],
    });

    expect(deps.coreManager.containersInspect).toHaveBeenCalledTimes(1);
    expect(startPortForward.mock.calls[0][0]).toMatchObject({ targetHost: "172.19.0.4" });
  });

  it("돌지 않는 컨테이너는 이유를 들고 실패한다", async () => {
    const { coordinator, host, deps } = createSshCoordinator();
    deps.coreManager.containersInspect.mockResolvedValue({
      id: "abc123",
      name: "dolgate-sync-api-dev",
      runtime: "docker",
      image: "app:1",
      status: "exited",
      createdAt: "2026-01-01T00:00:00.000Z",
      command: "node",
      entrypoint: "",
      ports: [],
      networks: [],
      mounts: [],
      labels: {},
    });

    await expect(
      coordinator.startContainerTunnelRuntime({
        ruleId: "container-service-tunnel:2",
        host,
        containerId: "abc123",
        networkName: "",
        targetPort: 8080,
        bindAddress: "127.0.0.1",
        bindPort: 0,
      }),
    ).rejects.toThrow();
  });

  it("시작이 끝나기 전에 컨테이너 엔드포인트를 끊지 않는다", async () => {
    // try/finally 에서 `return promise` 로 두면 finally 가 곧바로 돌아 엔드포인트를 끊는다.
    // 그러면 코어가 그 연결을 가져가려는 순간(sourceEndpointId → TakeClient) 이미 없다 —
    // 실기기에서 "containers endpoint … not found" 로 터진 경합이다.
    const { coordinator, host, deps } = createSshCoordinator();
    let disconnectedBeforeStart = false;
    let started = false;
    deps.coreManager.startPortForward.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      started = true;
      return { ruleId: "rule-1" };
    });
    deps.coreManager.containersDisconnect.mockImplementation(async () => {
      if (!started) {
        disconnectedBeforeStart = true;
      }
    });

    await coordinator.startContainerTunnelRuntime({
      ruleId: "container-service-tunnel:3",
      host,
      containerId: "abc123",
      networkName: "",
      targetPort: 8080,
      bindAddress: "127.0.0.1",
      bindPort: 0,
    });

    expect(started).toBe(true);
    expect(disconnectedBeforeStart).toBe(false);
  });
});
