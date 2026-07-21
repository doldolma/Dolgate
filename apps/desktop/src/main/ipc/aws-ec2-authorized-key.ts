import { randomUUID } from "node:crypto";
import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
} from "@shared";
import type {
  ResolvedAuthorizedKeyInstallResult,
  SshKeyInstallHostResult,
  SshKeyInstallInput,
  SshKeyInstallResult,
} from "@shared";
import {
  buildAwsServerProxyStartMessage,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from "../aws-ws-proxy";
import type { AwsEc2HostRecord, MainIpcContext } from "./context";
import { retryAwsSsmSshOperation } from "./coordinators/aws-ssm-ssh-retry";

/**
 * Installs a persistent public key into an EC2 instance's authorized_keys over
 * SSH-over-SSM — byte-for-byte the same transport used to open a terminal:
 *   - server-proxy host: rides the sync-api WS relay, which opens the SSM tunnel
 *     and pushes the EC2 Instance Connect key on its allowlisted IP (bastion mode).
 *   - direct: the desktop pushes an ephemeral EIC key + opens a local SSM tunnel,
 *     installs, then tears the tunnel down (one-shot; no session to track).
 *
 * The install itself is transport-agnostic (ssh-core just appends to
 * authorized_keys); only the dial differs. If SSH-over-SSM can't be established
 * the call fails — there is no SSM-shell fallback.
 */
export async function installAwsEc2AuthorizedKeyOverSsm(
  ctx: MainIpcContext,
  host: AwsEc2HostRecord,
  publicKey: string,
): Promise<ResolvedAuthorizedKeyInstallResult> {
  const hydratedHost = await ctx.resolveAwsSftpPreflight({
    endpointId: `aws-ec2-install-key:${host.id}`,
    host,
    allowBrowserLogin: true,
  });
  const profileName = ctx.awsService.requireManagedProfileName(
    hydratedHost.awsProfileId,
    hydratedHost.awsProfileName,
  );
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
  const { privateKeyPem, publicKey: ephemeralPublicKey } =
    ctx.createEphemeralAwsSftpKeyPair();

  const basePayload = {
    username: sshUsername,
    authType: "privateKey" as const,
    privateKeyPem,
    trustedHostKeyBase64: trustedHostKeysBase64[0],
    trustedHostKeysBase64,
    cols: 0,
    rows: 0,
    publicKey,
  };

  if (hydratedHost.awsSsmServerProxyEnabled === true) {
    // Server-proxy (bastion): sync-api owns the SSM tunnel + EIC key push. Send
    // the resolved credentials + ephemeral public key in the start message and
    // let ssh-core keep the private key.
    const startMessage = await buildAwsServerProxyStartMessage(ctx.awsService, {
      region: hydratedHost.awsRegion,
      profileName,
      instanceId: hydratedHost.awsInstanceId,
      availabilityZone,
      sshUsername,
      sshPort,
      publicKey: ephemeralPublicKey,
    });
    return retryAwsSsmSshOperation(() =>
      runWithAwsServerProxyAuthRetry(ctx.authService, (accessToken) =>
        ctx.coreManager.installAuthorizedKey({
          ...basePayload,
          host: hydratedHost.awsInstanceId,
          port: sshPort,
          wsProxy: buildAwsWsProxyTarget({
            serverUrl: ctx.authService.getServerUrl(),
            accessToken,
            startMessage,
          }),
        }),
      ),
    );
  }

  // Direct: push the EIC key ourselves and open a local SSM tunnel to ride over.
  await ctx.awsService.sendSshPublicKey({
    profileName,
    region: hydratedHost.awsRegion,
    instanceId: hydratedHost.awsInstanceId,
    availabilityZone,
    osUser: sshUsername,
    publicKey: ephemeralPublicKey,
  });
  const bindPort = await ctx.reserveLoopbackPort();
  const tunnel = await ctx.awsSsmTunnelService.start({
    runtimeId: `aws-ec2-install-key:${hydratedHost.id}:${randomUUID()}`,
    profileName,
    region: hydratedHost.awsRegion,
    instanceId: hydratedHost.awsInstanceId,
    bindAddress: "127.0.0.1",
    bindPort,
    targetPort: sshPort,
  });
  try {
    return await retryAwsSsmSshOperation(() =>
      ctx.coreManager.installAuthorizedKey({
        ...basePayload,
        host: tunnel.bindAddress,
        port: tunnel.bindPort,
      }),
    );
  } finally {
    await ctx.awsSsmTunnelService.stop(tunnel.runtimeId).catch(() => undefined);
  }
}

/**
 * installSshPublicKey with AWS EC2 support. Plain SSH hosts go through the shared
 * ssh-key coordinator unchanged; aws-ec2 hosts install over SSH-over-SSM. Mixed
 * selections are handled per host and merged back into the requested order.
 */
export async function installSshPublicKeyWithAwsSupport(
  ctx: MainIpcContext,
  input: SshKeyInstallInput,
): Promise<SshKeyInstallResult> {
  const hostIds = [...new Set(input.hostIds.filter(Boolean))];
  const isEc2 = (id: string) => {
    const host = ctx.hosts.getById(id);
    return host ? isAwsEc2HostRecord(host) : false;
  };
  const ec2Ids = hostIds.filter(isEc2);
  if (ec2Ids.length === 0) {
    // Fast path: no EC2 hosts selected — behaves exactly as before.
    return ctx.installSshPublicKey(input);
  }

  const mode: SshKeyInstallResult["mode"] =
    input.mode === "installAndUse" ? "installAndUse" : "installOnly";
  const resultsById = new Map<string, SshKeyInstallHostResult>();

  const sshIds = hostIds.filter((id) => !ec2Ids.includes(id));
  if (sshIds.length > 0) {
    const sshResult = await ctx.installSshPublicKey({
      ...input,
      hostIds: sshIds,
    });
    for (const entry of sshResult.results) {
      resultsById.set(entry.hostId, entry);
    }
  }

  // EC2 is install-only (connections always use an ephemeral EIC key, so there is
  // no auth to "switch to"): resolve the public key once and append it to each
  // instance's authorized_keys over SSH-over-SSM.
  const keyMaterial = await ctx.resolveSshPublicKey(
    input.secretRef,
    input.passphraseOverride,
  );
  for (const hostId of ec2Ids) {
    const host = ctx.hosts.getById(hostId);
    if (!host || !isAwsEc2HostRecord(host)) {
      resultsById.set(hostId, {
        hostId,
        hostLabel: host?.label ?? hostId,
        status: "failed",
        message: "EC2 host가 아닙니다.",
      });
      continue;
    }
    try {
      const installed = await installAwsEc2AuthorizedKeyOverSsm(
        ctx,
        host,
        keyMaterial.publicKey,
      );
      resultsById.set(hostId, {
        hostId,
        hostLabel: host.label,
        status:
          installed.status === "already-present"
            ? "already-present"
            : "installed",
      });
    } catch (error) {
      resultsById.set(hostId, {
        hostId,
        hostLabel: host.label,
        status: "failed",
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "SSH 공개 키를 설치하지 못했습니다.",
      });
    }
  }

  return {
    secretRef: input.secretRef,
    mode,
    results: hostIds.map(
      (id) =>
        resultsById.get(id) ?? {
          hostId: id,
          hostLabel: id,
          status: "failed" as const,
          message: "SSH 공개 키를 설치하지 못했습니다.",
        },
    ),
  };
}
