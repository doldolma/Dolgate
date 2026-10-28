import { describe, expect, it, vi } from "vitest";
import { connectAwsEc2OverSsm } from "./aws-ec2-ssh-over-ssm";
import { HostGoneError } from "../host-gone-error";
import { PERSONAL_VAULT_ID } from "../vault-catalog";

vi.mock("./agent-endpoint", () => ({
  resolveLocalAgentEndpoint: vi.fn().mockResolvedValue({
    kind: "unix",
    endpoint: "/tmp/agent.sock",
  }),
}));

/**
 * 그 호스트가 든 볼트 — `gone()` 을 부르면 사라진다(팀에서 빠짐·지움). scopeId 는 처음에 든 볼트다(팀이면 팀 id).
 */
function vaultsWith(host: { id: string }, scopeId: string = PERSONAL_VAULT_ID) {
  let present = true;
  return {
    vaults: {
      getHost: vi.fn((hostId: string) => (present && hostId === host.id ? host : null)),
      scopeOfHost: vi.fn(() => ({ id: present ? scopeId : PERSONAL_VAULT_ID })),
    },
    gone: () => {
      present = false;
    },
  };
}

function createAwsHost() {
  return {
    id: "aws-host-1",
    kind: "aws-ec2" as const,
    label: "AWS Linux",
    awsProfileId: "profile-1",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-aws123",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "aws-linux",
    awsPlatform: "Linux/UNIX",
    awsPrivateIp: "10.0.0.20",
    awsState: "running",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
    awsSshMetadataStatus: "ready" as const,
    awsSshMetadataError: null,
    awsSsmServerProxyEnabled: false,
    groupName: "Servers",
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("connectAwsEc2OverSsm", () => {
  it("opens SSH-over-SSM sessions as SSH transport while preserving AWS SSM lifecycle metadata", async () => {
    const host = createAwsHost();
    const connectAndAwaitReady = vi.fn().mockResolvedValue({
      sessionId: "session-ssh-over-ssm",
    });
    const connect = vi.fn();
    const trackAwsContainerShellTunnelRuntime = vi.fn();
    const emitContainersConnectionProgress = vi.fn();
    const ctx = {
      ...vaultsWith(host),
      resolveAwsSftpPreflight: vi.fn().mockResolvedValue(host),
      awsService: {
        requireManagedProfileName: vi
          .fn()
          .mockReturnValue("managed-profile"),
        sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
      },
      requireTrustedHostKeys: vi.fn().mockReturnValue(["TRUSTED_KEY"]),
      resolveTrustedHostKeys: vi.fn().mockReturnValue(["TRUSTED_KEY"]),
      createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({
        privateKeyPem: "PRIVATE_KEY",
        publicKey: "PUBLIC_KEY",
      }),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      awsSsmTunnelService: {
        start: vi.fn().mockResolvedValue({
          runtimeId: "aws-ec2-ssh-runtime",
          bindAddress: "127.0.0.1",
          bindPort: 2222,
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      coreManager: {
        connect,
        connectAndAwaitReady,
      },
      emitContainersConnectionProgress,
      trackAwsContainerShellTunnelRuntime,
    };

    await expect(
      connectAwsEc2OverSsm(ctx as any, host as any, {
        cols: 120,
        rows: 32,
        title: "AWS Linux",
        awaitReady: true,
      }),
    ).resolves.toEqual({ sessionId: "session-ssh-over-ssm" });

    expect(connect).not.toHaveBeenCalled();
    expect(ctx.resolveAwsSftpPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "aws-ec2-ssh:aws-host-1",
        emitProgress: expect.any(Function),
      }),
    );
    expect(emitContainersConnectionProgress).toHaveBeenCalledWith({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "probing-host-key",
      message: "AWS Linux 호스트 키 신뢰 정보를 확인하는 중입니다.",
    });
    expect(emitContainersConnectionProgress).toHaveBeenCalledWith({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "generating-key",
      message: "임시 SSH 키를 생성하는 중입니다.",
    });
    expect(emitContainersConnectionProgress).toHaveBeenCalledWith({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "sending-public-key",
      message: "EC2 Instance Connect로 공개 키를 전송하는 중입니다.",
    });
    expect(emitContainersConnectionProgress).toHaveBeenCalledWith({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "opening-tunnel",
      message: "SSH 연결용 내부 SSM 터널을 여는 중입니다.",
    });
    expect(emitContainersConnectionProgress).toHaveBeenCalledWith({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "connecting-sftp",
      message: "AWS Linux SSH 세션을 시작하는 중입니다.",
    });
    expect(connectAndAwaitReady).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 2222,
        username: "ubuntu",
        transport: "ssh",
        connectionKind: "aws-ssm",
        connectionDetails: "managed-profile · ap-northeast-2 · i-aws123",
      }),
    );
    expect(trackAwsContainerShellTunnelRuntime).toHaveBeenCalledWith(
      "session-ssh-over-ssm",
      "aws-ec2-ssh-runtime",
    );
  });

  it("forwards the local agent when the host enables agent forwarding", async () => {
    const host = { ...createAwsHost(), agentForwarding: true };
    const connectAndAwaitReady = vi.fn().mockResolvedValue({
      sessionId: "session-agent-fwd",
    });
    const ctx = {
      ...vaultsWith(host),
      resolveAwsSftpPreflight: vi.fn().mockResolvedValue(host),
      awsService: {
        requireManagedProfileName: vi
          .fn()
          .mockReturnValue("managed-profile"),
        sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
      },
      requireTrustedHostKeys: vi.fn().mockReturnValue(["TRUSTED_KEY"]),
      resolveTrustedHostKeys: vi.fn().mockReturnValue(["TRUSTED_KEY"]),
      createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({
        privateKeyPem: "PRIVATE_KEY",
        publicKey: "PUBLIC_KEY",
      }),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      awsSsmTunnelService: {
        start: vi.fn().mockResolvedValue({
          runtimeId: "aws-ec2-ssh-runtime",
          bindAddress: "127.0.0.1",
          bindPort: 2222,
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      coreManager: {
        connect: vi.fn(),
        connectAndAwaitReady,
      },
      emitContainersConnectionProgress: vi.fn(),
      trackAwsContainerShellTunnelRuntime: vi.fn(),
    };

    await connectAwsEc2OverSsm(ctx as any, host as any, {
      cols: 80,
      rows: 24,
      title: "AWS Linux",
      awaitReady: true,
    });

    expect(connectAndAwaitReady).toHaveBeenCalledWith(
      expect.objectContaining({
        agentForwarding: true,
        agentForwardingEndpointKind: "unix",
        agentForwardingEndpoint: "/tmp/agent.sock",
      }),
    );
  });
});

// 붙는 사이 팀에서 빠지면(8-6 결함 ②의 데스크톱 쪽) — 아직 탭이 없어 메인의 닫기가 닿지 않는다. 기다림마다 뒤에서 호스트가
// 아직 볼트에 있는지 보고, 없으면 AWS 에 더 손대지 않고 붙지도 않는다.
describe("connectAwsEc2OverSsm when the host leaves its vault while connecting", () => {
  const NOTICE = "팀에서 빠져 이 연결을 닫았습니다.";

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function setup(options: { serverProxy?: boolean; scopeId?: string } = {}) {
    const host = { ...createAwsHost(), awsSsmServerProxyEnabled: options.serverProxy === true };
    const vault = vaultsWith(host, options.scopeId ?? "team-1");
    const ctx = {
      vaults: vault.vaults,
      resolveAwsSftpPreflight: vi.fn().mockResolvedValue(host),
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("managed-profile"),
        sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
        buildServerProxySessionEnvSpec: vi.fn().mockResolvedValue({ env: {}, unsetEnv: [] }),
      },
      authService: {
        getServerUrl: vi.fn(() => "https://sync.example.test"),
        getAccessToken: vi.fn(() => "token"),
        refreshSession: vi.fn().mockResolvedValue({ status: "authenticated" }),
      },
      requireTrustedHostKeys: vi.fn().mockReturnValue(["TRUSTED_KEY"]),
      resolveTrustedHostKeys: vi.fn().mockReturnValue(["TRUSTED_KEY"]),
      createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({ privateKeyPem: "PRIVATE_KEY", publicKey: "PUBLIC_KEY" }),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      awsSsmTunnelService: {
        start: vi.fn().mockResolvedValue({ runtimeId: "aws-ec2-ssh-runtime", bindAddress: "127.0.0.1", bindPort: 2222 }),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      coreManager: {
        connect: vi.fn().mockResolvedValue({ sessionId: "late-session" }),
        connectAndAwaitReady: vi.fn().mockResolvedValue({ sessionId: "late-session" }),
      },
      emitContainersConnectionProgress: vi.fn(),
      trackAwsContainerShellTunnelRuntime: vi.fn(),
    };
    const connect = () =>
      connectAwsEc2OverSsm(ctx as any, host as any, { cols: 80, rows: 24, title: "AWS Linux" });
    return { ctx, host, gone: vault.gone, connect };
  }

  it("does not push the EIC key when the team went during the preflight", async () => {
    const { ctx, gone, connect } = setup();
    const preflight = deferred<unknown>();
    ctx.resolveAwsSftpPreflight.mockReturnValueOnce(preflight.promise);

    const result = connect();
    gone();
    preflight.resolve(createAwsHost());

    await expect(result).rejects.toThrow(new HostGoneError(NOTICE));
    expect(ctx.awsService.sendSshPublicKey).not.toHaveBeenCalled();
    expect(ctx.coreManager.connect).not.toHaveBeenCalled();
  });

  it("does not open the tunnel when the team went during the key push", async () => {
    const { ctx, gone, connect } = setup();
    const keyPush = deferred<void>();
    ctx.awsService.sendSshPublicKey.mockReturnValueOnce(keyPush.promise);

    const result = connect();
    await vi.waitFor(() => expect(ctx.awsService.sendSshPublicKey).toHaveBeenCalled());
    gone();
    keyPush.resolve();

    await expect(result).rejects.toBeInstanceOf(HostGoneError);
    expect(ctx.awsSsmTunnelService.start).not.toHaveBeenCalled();
    expect(ctx.coreManager.connect).not.toHaveBeenCalled();
  });

  it("closes the tunnel without dialling when the team went while it opened", async () => {
    const { ctx, gone, connect } = setup();
    const opening = deferred<{ runtimeId: string; bindAddress: string; bindPort: number }>();
    ctx.awsSsmTunnelService.start.mockReturnValueOnce(opening.promise);

    const result = connect();
    await vi.waitFor(() => expect(ctx.awsSsmTunnelService.start).toHaveBeenCalled());
    gone();
    opening.resolve({ runtimeId: "aws-ec2-ssh-runtime", bindAddress: "127.0.0.1", bindPort: 2222 });

    await expect(result).rejects.toBeInstanceOf(HostGoneError);
    expect(ctx.coreManager.connect).not.toHaveBeenCalled();
    expect(ctx.awsSsmTunnelService.stop).toHaveBeenCalledWith("aws-ec2-ssh-runtime");
  });

  it("does not dial over the server proxy, nor refresh the login, when the team went while it prepared", async () => {
    const { ctx, gone, connect } = setup({ serverProxy: true });
    const envSpec = deferred<{ env: Record<string, string>; unsetEnv: string[] }>();
    ctx.awsService.buildServerProxySessionEnvSpec.mockReturnValueOnce(envSpec.promise);

    const result = connect();
    await vi.waitFor(() => expect(ctx.awsService.buildServerProxySessionEnvSpec).toHaveBeenCalled());
    gone();
    envSpec.resolve({ env: {}, unsetEnv: [] });

    await expect(result).rejects.toThrow(new HostGoneError(NOTICE));
    expect(ctx.coreManager.connect).not.toHaveBeenCalled();
    expect(ctx.authService.refreshSession).not.toHaveBeenCalled();
  });

  it("says 'Host not found' for a personal host deleted meanwhile", async () => {
    const { ctx, gone, connect } = setup({ scopeId: PERSONAL_VAULT_ID });
    const preflight = deferred<unknown>();
    ctx.resolveAwsSftpPreflight.mockReturnValueOnce(preflight.promise);

    const result = connect();
    gone();
    preflight.resolve(createAwsHost());

    await expect(result).rejects.toThrow(new HostGoneError("Host not found"));
  });
});
