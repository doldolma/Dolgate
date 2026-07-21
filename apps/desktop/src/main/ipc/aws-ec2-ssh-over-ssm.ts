import { randomUUID } from "node:crypto";
import { buildAwsSsmKnownHostIdentity, getAwsEc2HostSshPort } from "@shared";
import {
  buildAwsServerProxyStartMessage,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from "../aws-ws-proxy";
import type {
  AwsConnectionProgressStage,
  AwsEc2HostRecord,
  MainIpcContext,
} from "./context";
import { resolveLocalAgentEndpoint } from "./agent-endpoint";
import { retryAwsSsmSshOperation } from "./coordinators/aws-ssm-ssh-retry";

const AWS_EC2_SSH_PROGRESS_ENDPOINT_PREFIX = "aws-ec2-ssh:";

export interface AwsEc2OverSsmConnectOptions {
  cols: number;
  rows: number;
  title: string;
  command?: string;
  tmux?: boolean;
  tmuxVersion?: string;
  startupCommand?: string;
  awaitReady?: boolean;
}

/**
 * Connects to an EC2 instance over SSH-over-SSM and returns the new session id.
 *
 * The SSH layer (shell, tmux control mode, ...) is byte-for-byte identical to a
 * normal SSH host; only the transport differs:
 *   - server-proxy host: rides a WebSocket to sync-api, which opens the SSM tunnel
 *     and pushes the EC2 Instance Connect key on its allowlisted IP (bastion mode
 *     for IP-restricted VPCs). ssh-core never touches AWS on this path.
 *   - direct: ssh-core opens a local SSM tunnel and the desktop pushes the EIC key.
 *
 * Callers pass a tmux command + tmux:true to attach tmux control mode exactly like
 * a plain SSH host.
 */
export async function connectAwsEc2OverSsm(
  ctx: MainIpcContext,
  host: AwsEc2HostRecord,
  options: AwsEc2OverSsmConnectOptions,
): Promise<{ sessionId: string }> {
  const progressEndpointId = `${AWS_EC2_SSH_PROGRESS_ENDPOINT_PREFIX}${host.id}`;
  const emitProgress = (
    stage: AwsConnectionProgressStage,
    message: string,
    hostId = host.id,
  ) => {
    ctx.emitContainersConnectionProgress({
      endpointId: progressEndpointId,
      hostId,
      stage,
      message,
    });
  };

  // Hydrate SSH username / AZ / SSM readiness. This is the same AWS preflight as
  // SFTP, but the renderer maps the aws-ec2-ssh endpoint to the pending terminal tab.
  const hydratedHost = await ctx.resolveAwsSftpPreflight({
    endpointId: progressEndpointId,
    host,
    allowBrowserLogin: true,
    emitProgress: (event) => ctx.emitContainersConnectionProgress(event),
  });
  const profileName = ctx.awsService.requireManagedProfileName(
    hydratedHost.awsProfileId,
    hydratedHost.awsProfileName,
  );
  const sshPort = getAwsEc2HostSshPort(hydratedHost);
  emitProgress(
    "probing-host-key",
    `${hydratedHost.label} 호스트 키 신뢰 정보를 확인하는 중입니다.`,
    hydratedHost.id,
  );
  const trustedHostKeysBase64 = ctx.requireTrustedHostKeys({
    hostname: buildAwsSsmKnownHostIdentity({
      profileName,
      region: hydratedHost.awsRegion,
      instanceId: hydratedHost.awsInstanceId,
    }),
    port: sshPort,
  });
  const sshUsername = hydratedHost.awsSshUsername?.trim();
  if (!sshUsername) {
    throw new Error(
      hydratedHost.awsSshMetadataError ||
        "자동으로 SSH 사용자명을 확인하지 못했습니다.",
    );
  }
  const availabilityZone = hydratedHost.awsAvailabilityZone?.trim();
  if (!availabilityZone) {
    throw new Error("Availability Zone을 확인하지 못했습니다.");
  }
  emitProgress(
    "generating-key",
    "임시 SSH 키를 생성하는 중입니다.",
    hydratedHost.id,
  );
  const { privateKeyPem, publicKey } = ctx.createEphemeralAwsSftpKeyPair();

  // Agent forwarding은 SSH 채널 레벨 기능이라 전송(SSM 터널/서버프록시)과 무관하게 ssh-core가
  // 로컬 agent에 붙어 처리한다(EIC 임시키 인증과 별개로 진짜 로컬 agent를 인스턴스로 포워딩).
  // bastion에서 사설 호스트로 hop할 때 로컬 키를 그대로 쓰는 정석 유스케이스.
  const agentForwardingRequested = hydratedHost.agentForwarding === true;
  const agentForwardingEndpoint = agentForwardingRequested
    ? await resolveLocalAgentEndpoint()
    : null;

  const baseConnect = {
    username: sshUsername,
    authType: "privateKey" as const,
    privateKeyPem,
    trustedHostKeyBase64: trustedHostKeysBase64[0],
    trustedHostKeysBase64,
    cols: options.cols,
    rows: options.rows,
    command: options.command,
    hostId: hydratedHost.id,
    hostLabel: hydratedHost.label,
    title: options.title,
    transport: "ssh" as const,
    connectionKind: "aws-ssm" as const,
    connectionDetails: `${profileName} · ${hydratedHost.awsRegion} · ${hydratedHost.awsInstanceId}`,
    tmux: options.tmux,
    tmuxVersion: options.tmuxVersion,
    startupCommand: options.startupCommand,
    agentForwarding: agentForwardingRequested,
    agentForwardingEndpointKind: agentForwardingEndpoint?.kind,
    agentForwardingEndpoint: agentForwardingEndpoint?.endpoint,
  };

  if (hydratedHost.awsSsmServerProxyEnabled === true) {
    // Server-proxy: sync-api owns every AWS call. Send the resolved credentials +
    // ephemeral public key in the start message; ssh-core keeps the private key.
    emitProgress(
      "opening-tunnel",
      "서버 프록시로 EC2 공개 키 주입과 SSM 터널 생성을 준비하는 중입니다.",
      hydratedHost.id,
    );
    const startMessage = await buildAwsServerProxyStartMessage(ctx.awsService, {
      region: hydratedHost.awsRegion,
      profileName,
      instanceId: hydratedHost.awsInstanceId,
      availabilityZone,
      sshUsername,
      sshPort,
      publicKey,
    });
    return runWithAwsServerProxyAuthRetry(ctx.authService, (accessToken) => {
      emitProgress(
        "connecting-sftp",
        `${hydratedHost.label} SSH 세션을 시작하는 중입니다.`,
        hydratedHost.id,
      );
      const payload = {
        ...baseConnect,
        host: hydratedHost.awsInstanceId,
        port: sshPort,
        wsProxy: buildAwsWsProxyTarget({
          serverUrl: ctx.authService.getServerUrl(),
          accessToken,
          startMessage,
        }),
      };
      return options.awaitReady === true
        ? ctx.coreManager.connectAndAwaitReady(payload)
        : ctx.coreManager.connect(payload);
    });
  }

  // Direct: push the EIC key ourselves and open a local SSM tunnel to ride SSH over.
  emitProgress(
    "sending-public-key",
    "EC2 Instance Connect로 공개 키를 전송하는 중입니다.",
    hydratedHost.id,
  );
  await ctx.awsService.sendSshPublicKey({
    profileName,
    region: hydratedHost.awsRegion,
    instanceId: hydratedHost.awsInstanceId,
    availabilityZone,
    osUser: sshUsername,
    publicKey,
  });
  emitProgress(
    "opening-tunnel",
    "SSH 연결용 내부 SSM 터널을 여는 중입니다.",
    hydratedHost.id,
  );
  const bindPort = await ctx.reserveLoopbackPort();
  const tunnel = await ctx.awsSsmTunnelService.start({
    runtimeId: `aws-ec2-ssh:${hydratedHost.id}:${randomUUID()}`,
    profileName,
    region: hydratedHost.awsRegion,
    instanceId: hydratedHost.awsInstanceId,
    bindAddress: "127.0.0.1",
    bindPort,
    targetPort: sshPort,
  });
  try {
    emitProgress(
      "connecting-sftp",
      `${hydratedHost.label} SSH 세션을 시작하는 중입니다.`,
      hydratedHost.id,
    );
    const connection = await retryAwsSsmSshOperation(() => {
      const payload = {
        ...baseConnect,
        host: tunnel.bindAddress,
        port: tunnel.bindPort,
      };
      return options.awaitReady === true
        ? ctx.coreManager.connectAndAwaitReady(payload)
        : ctx.coreManager.connect(payload);
    });
    // Tear the tunnel down when the session closes (core-event-bridge stops it on
    // the generic "closed"/"error" session event, same as container shells).
    ctx.trackAwsContainerShellTunnelRuntime(
      connection.sessionId,
      tunnel.runtimeId,
    );
    return connection;
  } catch (error) {
    await ctx.awsSsmTunnelService.stop(tunnel.runtimeId).catch(() => undefined);
    throw error;
  }
}
