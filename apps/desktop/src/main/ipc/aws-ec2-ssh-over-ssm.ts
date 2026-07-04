import { randomUUID } from "node:crypto";
import { buildAwsSsmKnownHostIdentity, getAwsEc2HostSshPort } from "@shared";
import {
  buildAwsServerProxyStartMessage,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from "../aws-ws-proxy";
import type { AwsEc2HostRecord, MainIpcContext } from "./context";
import { retryAwsSsmSshOperation } from "./coordinators/aws-ssm-ssh-retry";

export interface AwsEc2OverSsmConnectOptions {
  cols: number;
  rows: number;
  title: string;
  command?: string;
  tmux?: boolean;
  tmuxVersion?: string;
  startupCommand?: string;
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
  // Hydrate SSH username / AZ / SSM readiness. Progress is suppressed: this is a
  // terminal session, not an SFTP pane, so the tab's own connecting state suffices.
  const hydratedHost = await ctx.resolveAwsSftpPreflight({
    endpointId: `aws-ec2-ssh:${randomUUID()}`,
    host,
    allowBrowserLogin: true,
    emitProgress: () => undefined,
  });
  const profileName =
    ctx.awsService.resolveManagedProfileNameOrFallback(
      hydratedHost.awsProfileId,
      hydratedHost.awsProfileName,
    ) ?? hydratedHost.awsProfileName;
  const sshPort = getAwsEc2HostSshPort(hydratedHost);
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
  const { privateKeyPem, publicKey } = ctx.createEphemeralAwsSftpKeyPair();

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
    transport: "aws-ssm" as const,
    tmux: options.tmux,
    tmuxVersion: options.tmuxVersion,
    startupCommand: options.startupCommand,
  };

  if (hydratedHost.awsSsmServerProxyEnabled === true) {
    // Server-proxy: sync-api owns every AWS call. Send the resolved credentials +
    // ephemeral public key in the start message; ssh-core keeps the private key.
    const startMessage = await buildAwsServerProxyStartMessage(ctx.awsService, {
      region: hydratedHost.awsRegion,
      profileName,
      instanceId: hydratedHost.awsInstanceId,
      availabilityZone,
      sshUsername,
      sshPort,
      publicKey,
    });
    return runWithAwsServerProxyAuthRetry(ctx.authService, (accessToken) =>
      ctx.coreManager.connect({
        ...baseConnect,
        host: hydratedHost.awsInstanceId,
        port: sshPort,
        wsProxy: buildAwsWsProxyTarget({
          serverUrl: ctx.authService.getServerUrl(),
          accessToken,
          startMessage,
        }),
      }),
    );
  }

  // Direct: push the EIC key ourselves and open a local SSM tunnel to ride SSH over.
  await ctx.awsService.sendSshPublicKey({
    profileName,
    region: hydratedHost.awsRegion,
    instanceId: hydratedHost.awsInstanceId,
    availabilityZone,
    osUser: sshUsername,
    publicKey,
  });
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
    const connection = await retryAwsSsmSshOperation(() =>
      ctx.coreManager.connect({
        ...baseConnect,
        host: tunnel.bindAddress,
        port: tunnel.bindPort,
      }),
    );
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
