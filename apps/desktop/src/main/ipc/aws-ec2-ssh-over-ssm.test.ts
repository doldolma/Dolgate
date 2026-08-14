import { describe, expect, it, vi } from "vitest";
import { connectAwsEc2OverSsm } from "./aws-ec2-ssh-over-ssm";

vi.mock("./agent-endpoint", () => ({
  resolveLocalAgentEndpoint: vi.fn().mockResolvedValue({
    kind: "unix",
    endpoint: "/tmp/agent.sock",
  }),
}));

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
