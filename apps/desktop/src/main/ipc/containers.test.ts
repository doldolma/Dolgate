import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";
import { registerContainersIpcHandlers } from "./containers";

const electronSpies = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronSpies.ipcMainHandle,
  },
}));

function createAwsHost() {
  return {
    id: "aws-host-1",
    kind: "aws-ec2" as const,
    label: "AWS Linux",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-aws",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "aws-linux",
    awsPlatform: "Linux/UNIX",
    awsPrivateIp: "10.0.0.20",
    awsState: "running",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
    awsSshMetadataStatus: "ready" as const,
    awsSshMetadataError: null,
    groupName: "Servers",
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("registerContainersIpcHandlers", () => {
  beforeEach(() => {
    electronSpies.ipcMainHandle.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers each window as a subscriber when opening a Container tab", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    const registerContainerSubscriber = vi.fn();
    const beginContainerLifecycle = vi.fn().mockReturnValue({
      lifecycleId: "lifecycle-1",
    });

    registerContainersIpcHandlers({
      hosts: {
        getById: vi.fn().mockReturnValue({
          id: "host-1",
          label: "Prod",
          kind: "ssh",
        }),
      },
      buildContainersEndpointId: vi.fn(() => "containers:host-1"),
      coreManager: {
        registerContainerSubscriber,
        beginContainerLifecycle,
      },
    } as any);

    await handlers
      .get(ipcChannels.containers.beginLifecycle)?.(
        { sender: { id: 91 } },
        "host-1",
      );

    expect(registerContainerSubscriber).toHaveBeenCalledWith(
      "containers:host-1",
      91,
    );
    expect(beginContainerLifecycle).toHaveBeenCalledTimes(1);
  });

  it("disconnects a shared Container endpoint only after the last window releases it", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    const releaseContainerSubscriber = vi
      .fn()
      .mockReturnValueOnce({ released: true, remainingSubscribers: 1 })
      .mockReturnValueOnce({ released: true, remainingSubscribers: 0 });
    const containersDisconnect = vi.fn().mockResolvedValue(undefined);
    const stopAwsContainersTunnelForEndpoint = vi
      .fn()
      .mockResolvedValue(undefined);
    const finalizeContainerLifecycleForScope = vi.fn();

    registerContainersIpcHandlers({
      hosts: {
        getById: vi.fn().mockReturnValue({ id: "host-1", kind: "ssh" }),
      },
      buildContainersEndpointId: vi.fn(() => "containers:host-1"),
      coreManager: {
        releaseContainerSubscriber,
        containersDisconnect,
        finalizeContainerLifecycleForScope,
      },
      stopAwsContainersTunnelForEndpoint,
    } as any);

    const release = handlers.get(ipcChannels.containers.release);
    await release?.({ sender: { id: 91 } }, "host-1", "lifecycle-1");
    expect(containersDisconnect).not.toHaveBeenCalled();
    expect(stopAwsContainersTunnelForEndpoint).not.toHaveBeenCalled();

    await release?.({ sender: { id: 92 } }, "host-1", "lifecycle-1");
    expect(containersDisconnect).toHaveBeenCalledWith("containers:host-1");
    expect(stopAwsContainersTunnelForEndpoint).toHaveBeenCalledWith(
      "containers:host-1",
    );
    expect(finalizeContainerLifecycleForScope).toHaveBeenCalledWith(
      "containers:host-1",
      "lifecycle-1",
    );
  });

  it("reuses hydrated AWS host metadata returned by ensureContainersEndpoint when opening a container shell", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const host = createAwsHost();
    const ensureContainersEndpoint = vi.fn().mockResolvedValue({
      endpointId: "containers:aws-host-1",
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
      unsupportedReason: null,
      hydratedHost: host,
    });
    const consumeAwsSftpPreflight = vi.fn();
    const resolveAwsSftpPreflight = vi.fn();
    const sendSshPublicKey = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({
      runtimeId: "aws-container-shell-runtime",
      bindAddress: "127.0.0.1",
      bindPort: 2222,
    });
    const connect = vi.fn().mockResolvedValue({ sessionId: "session-1" });
    const trackAwsContainerShellTunnelRuntime = vi.fn();
    const runWithSessionOwner = vi.fn(
      (_ownerWebContentsId: number, action: () => Promise<unknown>) => action(),
    );

    registerContainersIpcHandlers({
      hosts: {
        getById: vi.fn().mockReturnValue(host),
      },
      assertSftpCompatibleHost: vi.fn(),
      buildContainersEndpointId: vi.fn(
        (hostId: string) => `containers:${hostId}`,
      ),
      ensureContainersEndpoint,
      buildContainerShellCommand: vi
        .fn()
        .mockReturnValue("/usr/bin/docker exec -it container-1 /bin/sh"),
      consumeAwsSftpPreflight,
      resolveAwsSftpPreflight,
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
        sendSshPublicKey,
      },
      requireTrustedHostKey: vi.fn().mockReturnValue("AAAATEST"),
      requireTrustedHostKeys: vi.fn().mockReturnValue(["AAAATEST"]),
      resolveTrustedHostKeys: vi.fn().mockReturnValue(["AAAATEST"]),
      createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({
        privateKeyPem: "PRIVATE KEY",
        publicKey: "PUBLIC KEY",
      }),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      awsSsmTunnelService: {
        start,
        stop: vi.fn().mockResolvedValue(undefined),
      },
      coreManager: {
        connect,
        runWithSessionOwner,
        assertContainerSubscriber: vi.fn(),
      },
      trackAwsContainerShellTunnelRuntime,
    } as any);

    const handler = handlers.get(ipcChannels.containers.openShell);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected containers.openShell handler to be registered");
    }

    await expect(
      handler({ sender: { id: 91 } }, "aws-host-1", "container-1"),
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(runWithSessionOwner).toHaveBeenCalledWith(91, expect.any(Function));
    expect(ensureContainersEndpoint).toHaveBeenCalledWith(host);
    expect(consumeAwsSftpPreflight).not.toHaveBeenCalled();
    expect(resolveAwsSftpPreflight).not.toHaveBeenCalled();
    expect(sendSshPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "default",
        instanceId: "i-aws",
        osUser: "ubuntu",
      }),
    );
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 2222,
        username: "ubuntu",
        transport: "ssh",
        connectionKind: "aws-ssm",
      }),
    );
    expect(trackAwsContainerShellTunnelRuntime).toHaveBeenCalledWith(
      "session-1",
      "aws-container-shell-runtime",
    );
  });

  it("falls back to resolveAwsSftpPreflight when ensureContainersEndpoint does not return a hydrated host", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const host = createAwsHost();
    const ensureContainersEndpoint = vi.fn().mockResolvedValue({
      endpointId: "containers:aws-host-1",
      runtime: "docker",
      runtimeCommand: "/usr/bin/docker",
      unsupportedReason: null,
      hydratedHost: null,
    });
    const consumeAwsSftpPreflight = vi.fn().mockReturnValue(null);
    const resolveAwsSftpPreflight = vi.fn().mockResolvedValue(host);
    const connect = vi.fn().mockResolvedValue({ sessionId: "session-1" });

    registerContainersIpcHandlers({
      hosts: {
        getById: vi.fn().mockReturnValue(host),
      },
      assertSftpCompatibleHost: vi.fn(),
      ensureContainersEndpoint,
      buildContainerShellCommand: vi
        .fn()
        .mockReturnValue("/usr/bin/docker exec -it container-1 /bin/sh"),
      consumeAwsSftpPreflight,
      resolveAwsSftpPreflight,
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
        sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
      },
      requireTrustedHostKey: vi.fn().mockReturnValue("AAAATEST"),
      requireTrustedHostKeys: vi.fn().mockReturnValue(["AAAATEST"]),
      resolveTrustedHostKeys: vi.fn().mockReturnValue(["AAAATEST"]),
      createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({
        privateKeyPem: "PRIVATE KEY",
        publicKey: "PUBLIC KEY",
      }),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      awsSsmTunnelService: {
        start: vi.fn().mockResolvedValue({
          runtimeId: "aws-container-shell-runtime",
          bindAddress: "127.0.0.1",
          bindPort: 2222,
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      coreManager: {
        connect,
      },
      trackAwsContainerShellTunnelRuntime: vi.fn(),
    } as any);

    const handler = handlers.get(ipcChannels.containers.openShell);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected containers.openShell handler to be registered");
    }

    await handler({}, "aws-host-1", "container-1");

    expect(consumeAwsSftpPreflight).toHaveBeenCalledWith(
      "containers:aws-host-1",
      "aws-host-1",
    );
    expect(resolveAwsSftpPreflight).toHaveBeenCalledWith({
      endpointId: "containers:aws-host-1",
      host,
      allowBrowserLogin: true,
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("retries AWS container shell connect once after a transient SSH handshake failure", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const host = createAwsHost();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ssh handshake failed: EOF"))
      .mockResolvedValueOnce({ sessionId: "session-1" });

    registerContainersIpcHandlers({
      hosts: {
        getById: vi.fn().mockReturnValue(host),
      },
      assertSftpCompatibleHost: vi.fn(),
      ensureContainersEndpoint: vi.fn().mockResolvedValue({
        endpointId: "containers:aws-host-1",
        runtime: "docker",
        runtimeCommand: "/usr/bin/docker",
        unsupportedReason: null,
        hydratedHost: host,
      }),
      buildContainerShellCommand: vi
        .fn()
        .mockReturnValue("/usr/bin/docker exec -it container-1 /bin/sh"),
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
        sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
      },
      requireTrustedHostKeys: vi.fn().mockReturnValue(["AAAATEST"]),
      resolveTrustedHostKeys: vi.fn().mockReturnValue(["AAAATEST"]),
      createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({
        privateKeyPem: "PRIVATE KEY",
        publicKey: "PUBLIC KEY",
      }),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      awsSsmTunnelService: {
        start: vi.fn().mockResolvedValue({
          runtimeId: "aws-container-shell-runtime",
          bindAddress: "127.0.0.1",
          bindPort: 2222,
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      coreManager: {
        connect,
      },
      trackAwsContainerShellTunnelRuntime: vi.fn(),
    } as any);

    const handler = handlers.get(ipcChannels.containers.openShell);
    const shellPromise = handler?.({}, "aws-host-1", "container-1");
    await vi.advanceTimersByTimeAsync(500);

    await expect(shellPromise).resolves.toEqual({ sessionId: "session-1" });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("starts AWS container lifecycle logging with the SSM transport", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    const host = createAwsHost();
    const beginContainerLifecycle = vi
      .fn()
      .mockReturnValue({ lifecycleId: "lifecycle-1" });

    registerContainersIpcHandlers({
      hosts: { getById: vi.fn(() => host) },
      coreManager: { beginContainerLifecycle },
      buildContainersEndpointId: vi.fn(() => "containers:host-1"),
    } as any);

    const handler = handlers.get(ipcChannels.containers.beginLifecycle);
    await expect(handler?.({}, "host-1")).resolves.toEqual({
      lifecycleId: "lifecycle-1",
    });
    expect(beginContainerLifecycle).toHaveBeenCalledWith({
      scopeId: "containers:host-1",
      hostId: "aws-host-1",
      hostLabel: "AWS Linux",
      workspaceKind: "host-runtime",
      transport: "aws-ssm",
    });
  });

  it("keeps release cleanup wired through containersDisconnect and AWS tunnel stop", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const containersDisconnect = vi.fn().mockResolvedValue(undefined);
    const stopAwsContainersTunnelForEndpoint = vi.fn().mockResolvedValue(undefined);

    registerContainersIpcHandlers({
      hosts: {
        getById: vi.fn(() => ({ id: "aws-host-1", kind: "ssh" })),
      },
      coreManager: {
        containersDisconnect,
        finalizeContainerLifecycleForScope: vi.fn(),
      },
      buildContainersEndpointId: vi
        .fn()
        .mockImplementation((hostId: string) => `containers:${hostId}`),
      stopAwsContainersTunnelForEndpoint,
    } as any);

    const handler = handlers.get(ipcChannels.containers.release);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected containers.release handler to be registered");
    }

    await handler({}, "aws-host-1");

    expect(containersDisconnect).toHaveBeenCalledWith("containers:aws-host-1");
    expect(stopAwsContainersTunnelForEndpoint).toHaveBeenCalledWith(
      "containers:aws-host-1",
    );
  });

  // 컨테이너 목록·로그는 tailnet 을 타는데 셸만 안 타던 시절이 있었다. 밖에서 보면 목록이
  // 잘 뜨니 tailnet 은 멀쩡해 보이고, 셸만 "연결할 수 없음" 으로 끝나거나(tailnet 안에만 있는
  // 호스트) 조용히 공개망으로 나갔다(이름이 밖에서도 풀리는 호스트).
  it("routes a plain SSH container shell through the host's tailnet", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const host = {
      id: "host-1",
      kind: "ssh" as const,
      label: "Prod",
      hostname: "prod.example.ts.net",
      port: 22,
      username: "deploy",
      authType: "password" as const,
      tailnetId: "net-a",
    };
    const connect = vi.fn().mockResolvedValue({ sessionId: "session-1" });
    const resolveTailnetRoute = vi.fn().mockReturnValue({
      tailnetId: "net-a",
      tailnetName: "example.ts.net",
    });
    const resolveTrustedHostKeys = vi.fn().mockReturnValue(["AAAATEST"]);

    registerContainersIpcHandlers({
      hosts: { getById: vi.fn().mockReturnValue(host) },
      assertSftpCompatibleHost: vi.fn(),
      buildContainersEndpointId: vi.fn(
        (hostId: string) => `containers:${hostId}`,
      ),
      ensureContainersEndpoint: vi.fn().mockResolvedValue({
        endpointId: "containers:host-1",
        runtime: "docker",
        runtimeCommand: "/usr/bin/docker",
        unsupportedReason: null,
        hydratedHost: null,
      }),
      buildContainerShellCommand: vi
        .fn()
        .mockReturnValue("/usr/bin/docker exec -it container-1 /bin/sh"),
      resolveTrustedHostKeys,
      requireConfiguredSshUsername: vi.fn().mockReturnValue("deploy"),
      resolveRuntimeSshSecrets: vi.fn().mockResolvedValue({
        secrets: { password: "pw" },
        shouldPersistHostSecret: false,
      }),
      ensureCertificateAuthReady: vi.fn().mockResolvedValue(null),
      resolveJumpHostTarget: vi.fn().mockResolvedValue(undefined),
      resolveTailnetRoute,
      coreManager: {
        connect,
        runWithSessionOwner: vi.fn(
          (_ownerWebContentsId: number, action: () => Promise<unknown>) =>
            action(),
        ),
        assertContainerSubscriber: vi.fn(),
      },
      pendingSessionSecrets: new Map(),
    } as any);

    const handler = handlers.get(ipcChannels.containers.openShell);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected containers.openShell handler to be registered");
    }

    await expect(
      handler({ sender: { id: 91 } }, "host-1", "container-1"),
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "prod.example.ts.net",
        command: "/usr/bin/docker exec -it container-1 /bin/sh",
        transport: "ssh",
        tailnetId: "net-a",
        tailnetName: "example.ts.net",
      }),
    );
    // dial 경로와 신뢰 범위가 같은 호스트 레코드에서 나와야 한다. 한쪽만 tailnet 을 타면
    // 공개망에서 받은 키가 tailnet 범위에 저장되고, 그 뒤로는 진짜 tailnet 연결이 그것을
    // 신뢰한다.
    expect(resolveTailnetRoute).toHaveBeenCalledWith(host);
    expect(resolveTrustedHostKeys).toHaveBeenCalledWith(host);
  });
});

describe("임시 컨테이너 터널 정지", () => {
  function setup(owner: { ownerWebContentsId: number | null; sessionId: string | null } | null) {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockReset();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    const stopPortForward = vi.fn().mockResolvedValue(undefined);
    const releaseContainerTunnelOwner = vi.fn();
    registerContainersIpcHandlers({
      hosts: { getById: vi.fn() },
      buildContainersEndpointId: vi.fn(() => "containers:host-1"),
      coreManager: {
        getContainerTunnelOwner: vi.fn(() => owner),
        releaseContainerTunnelOwner,
        stopPortForward,
      },
    } as any);
    return {
      stop: handlers.get(ipcChannels.containers.stopTunnel),
      stopPortForward,
      releaseContainerTunnelOwner,
    };
  }

  it("등록된 터널은 멈추고 기록도 지운다", async () => {
    const { stop, stopPortForward, releaseContainerTunnelOwner } = setup({
      ownerWebContentsId: 91,
      sessionId: "session-1",
    });

    await stop?.({ sender: { id: 91 } }, "container-service-tunnel:1");

    expect(stopPortForward).toHaveBeenCalledWith("container-service-tunnel:1");
    expect(releaseContainerTunnelOwner).toHaveBeenCalledWith("container-service-tunnel:1");
  });

  it("등록에 없는 id 는 건드리지 않는다 — 저장해 둔 SSH 규칙이 이 통로로 꺼지지 않게", async () => {
    // `stopPortForward` 는 모든 포워딩의 공용 정지 함수다. 확인 없이 부르면 홈에서 켜 둔
    // 규칙 id 를 넣어 그것을 끌 수 있다.
    const { stop, stopPortForward } = setup(null);

    await stop?.({ sender: { id: 91 } }, "rule-saved-ssh-forward");

    expect(stopPortForward).not.toHaveBeenCalled();
  });

  it("연 창이 아니면 멈추지 않는다", async () => {
    const { stop, stopPortForward } = setup({
      ownerWebContentsId: 91,
      sessionId: "session-1",
    });

    await stop?.({ sender: { id: 92 } }, "container-service-tunnel:1");

    expect(stopPortForward).not.toHaveBeenCalled();
  });

  it("주인을 모르는 옛 기록은 그대로 통과시킨다", async () => {
    const { stop, stopPortForward } = setup({ ownerWebContentsId: null, sessionId: null });

    await stop?.({ sender: { id: 92 } }, "container-service-tunnel:1");

    expect(stopPortForward).toHaveBeenCalledWith("container-service-tunnel:1");
  });
});
