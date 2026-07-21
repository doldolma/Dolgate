import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isWarpgateSshHostRecord,
  type HostContainersEphemeralTunnelInput,
  type HostContainersLogsInput,
  type HostContainersSearchLogsInput,
  type HostContainersStatsInput,
} from "@shared";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type {
  AwsEc2HostRecord,
  MainIpcContext,
  SftpCompatibleHostRecord,
  SshHostRecord,
} from "./context";
import { resolveLocalAgentEndpoint } from "./agent-endpoint";
import { retryAwsSsmSshOperation } from "./coordinators/aws-ssm-ssh-retry";
import {
  buildAwsServerProxyStartMessage,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from "../aws-ws-proxy";

function beginContainersLifecycle(
  ctx: MainIpcContext,
  host: NonNullable<ReturnType<MainIpcContext["hosts"]["getById"]>>,
) {
  return ctx.coreManager.beginContainerLifecycle({
    scopeId: ctx.buildContainersEndpointId(host.id),
    hostId: host.id,
    hostLabel: host.label,
    workspaceKind: isAwsEcsHostRecord(host) ? "ecs-cluster" : "host-runtime",
    transport: isAwsEcsHostRecord(host)
      ? "aws-ecs"
      : isAwsEc2HostRecord(host)
        ? "aws-ssm"
        : isWarpgateSshHostRecord(host)
          ? "warpgate"
          : "ssh",
  });
}

export function registerContainersIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.containers.beginLifecycle,
    async (_event, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      if (!host) {
        throw new Error("Containers host를 찾지 못했습니다.");
      }
      return beginContainersLifecycle(ctx, host);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.reportLifecycleError,
    async (
      _event,
      input: { lifecycleId: string; message: string },
    ) => {
      const lifecycleId = input.lifecycleId?.trim();
      if (!lifecycleId) {
        return;
      }
      ctx.coreManager.reportContainerLifecycleError({
        lifecycleId,
        message:
          input.message?.trim().slice(0, 4_000) ||
          "Containers 연결 오류가 발생했습니다.",
      });
    },
  );

  ipcMain.handle(
    ipcChannels.containers.list,
    async (_event, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const scopeId = ctx.buildContainersEndpointId(hostId);
      const { lifecycleId } = beginContainersLifecycle(ctx, typedHost);
      ctx.coreManager.noteContainerLifecycleLoadStarted(scopeId, lifecycleId);
      try {
        const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
        if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
          ctx.coreManager.markContainerLifecycleUnsupported({
            scopeId,
            lifecycleId,
            reason:
              runtimeInfo.unsupportedReason ||
              "docker/podman 런타임을 확인하지 못했습니다.",
          });
          return {
            runtime: null,
            unsupportedReason: runtimeInfo.unsupportedReason,
            containers: [],
          };
        }
        const listing = await ctx.coreManager.containersList(runtimeInfo.endpointId);
        ctx.coreManager.markContainerLifecycleConnected({
          scopeId,
          lifecycleId,
          runtime: listing.runtime,
          resourceCount: listing.containers.length,
        });
        return {
          runtime: listing.runtime,
          unsupportedReason: null,
          containers: listing.containers,
        };
      } catch (error) {
        ctx.coreManager.reportContainerLifecycleError({
          lifecycleId,
          message:
            error instanceof Error
              ? error.message
              : "컨테이너 목록을 불러오지 못했습니다.",
        });
        throw error;
      }
    },
  );

  ipcMain.handle(
    ipcChannels.containers.inspect,
    async (_event, hostId: string, containerId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return ctx.coreManager.containersInspect(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.logs,
    async (_event, input: HostContainersLogsInput) => {
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return ctx.coreManager.containersLogs(
        runtimeInfo.endpointId,
        input.containerId,
        input.tail,
        input.followCursor ?? null,
        input.startTime ?? null,
        input.endTime ?? null,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.containers.startTunnel,
    async (_event, input: HostContainersEphemeralTunnelInput) => {
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      return ctx.startContainerTunnelRuntime({
        ruleId: `container-service-tunnel:${randomUUID()}`,
        host: host as SftpCompatibleHostRecord,
        containerId: input.containerId,
        networkName: input.networkName,
        targetPort: input.targetPort,
        bindAddress: input.bindAddress,
        bindPort: input.bindPort,
      });
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stopTunnel,
    async (_event, runtimeId: string) => {
      await ctx.coreManager.stopPortForward(runtimeId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.start,
    async (_event, hostId: string, containerId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await ctx.coreManager.containersStart(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stop,
    async (_event, hostId: string, containerId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await ctx.coreManager.containersStop(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.restart,
    async (_event, hostId: string, containerId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await ctx.coreManager.containersRestart(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.remove,
    async (_event, hostId: string, containerId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await ctx.coreManager.containersRemove(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stats,
    async (_event, input: HostContainersStatsInput) => {
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return ctx.coreManager.containersStats(runtimeInfo.endpointId, input.containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.searchLogs,
    async (_event, input: HostContainersSearchLogsInput) => {
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return ctx.coreManager.containersSearchLogs(
        runtimeInfo.endpointId,
        input.containerId,
        input.tail,
        input.query,
        input.startTime ?? null,
        input.endTime ?? null,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.containers.release,
    async (_event, hostId: string, lifecycleId?: string) => {
      const host = ctx.hosts.getById(hostId);
      const endpointId = ctx.buildContainersEndpointId(hostId);
      try {
        if (!host || !isAwsEcsHostRecord(host)) {
          await ctx.coreManager.containersDisconnect(endpointId);
        }
      } finally {
        await ctx.stopAwsContainersTunnelForEndpoint(endpointId);
        ctx.coreManager.finalizeContainerLifecycleForScope(
          endpointId,
          lifecycleId,
        );
      }
    },
  );

  ipcMain.handle(
    ipcChannels.containers.openShell,
    async (_event, hostId: string, containerId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (!runtimeInfo.runtime || !runtimeInfo.runtimeCommand) {
        throw new Error("컨테이너 런타임을 먼저 확인해 주세요.");
      }
      const title = `${typedHost.label} · ${containerId}`;
      const command = ctx.buildContainerShellCommand(
        runtimeInfo.runtimeCommand,
        containerId,
      );

      if (isAwsEc2HostRecord(typedHost)) {
        const hydratedHost =
          runtimeInfo.hydratedHost ??
          ctx.consumeAwsSftpPreflight(runtimeInfo.endpointId, typedHost.id) ??
          (await ctx.resolveAwsSftpPreflight({
            endpointId: runtimeInfo.endpointId,
            host: typedHost as AwsEc2HostRecord,
            allowBrowserLogin: true,
          }));
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
        const availabilityZone = hydratedHost.awsAvailabilityZone?.trim();
        if (!sshUsername) {
          throw new Error(
            hydratedHost.awsSshMetadataError ||
              "자동으로 SSH 사용자명을 확인하지 못했습니다.",
          );
        }
        if (!availabilityZone) {
          throw new Error("Availability Zone을 확인하지 못했습니다.");
        }
        const { privateKeyPem, publicKey } = ctx.createEphemeralAwsSftpKeyPair();

        if (hydratedHost.awsSsmServerProxyEnabled === true) {
          // Server-proxy: sync-api opens the SSM tunnel + pushes the EIC key on its
          // allowlisted IP; ssh-core rides plain SSH-over-SSM over a WebSocket to run
          // the container shell command. No local tunnel, no desktop-side EIC.
          const startMessage = await buildAwsServerProxyStartMessage(
            ctx.awsService,
            {
              region: hydratedHost.awsRegion,
              profileName,
              instanceId: hydratedHost.awsInstanceId,
              availabilityZone,
              sshUsername,
              sshPort,
              publicKey,
            },
          );
          return runWithAwsServerProxyAuthRetry(ctx.authService, (accessToken) =>
            ctx.coreManager.connect({
              host: hydratedHost.awsInstanceId,
              port: sshPort,
              username: sshUsername,
              authType: "privateKey",
              privateKeyPem,
              trustedHostKeyBase64: trustedHostKeysBase64[0],
              trustedHostKeysBase64,
              cols: 120,
              rows: 32,
              command,
              hostId: hydratedHost.id,
              hostLabel: hydratedHost.label,
              title,
              transport: "ssh",
              connectionKind: "aws-ssm",
              connectionDetails: `${profileName} · ${hydratedHost.awsRegion} · ${hydratedHost.awsInstanceId}`,
              wsProxy: buildAwsWsProxyTarget({
                serverUrl: ctx.authService.getServerUrl(),
                accessToken,
                startMessage,
              }),
            }),
          );
        }

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
          runtimeId: `aws-container-shell:${typedHost.id}:${randomUUID()}`,
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
              host: tunnel.bindAddress,
              port: tunnel.bindPort,
              username: sshUsername,
              authType: "privateKey",
              privateKeyPem,
              trustedHostKeyBase64: trustedHostKeysBase64[0],
              trustedHostKeysBase64,
              cols: 120,
              rows: 32,
              command,
              hostId: hydratedHost.id,
              hostLabel: hydratedHost.label,
              title,
              transport: "ssh",
              connectionKind: "aws-ssm",
              connectionDetails: `${profileName} · ${hydratedHost.awsRegion} · ${hydratedHost.awsInstanceId}`,
            }),
          );
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

      if (isWarpgateSshHostRecord(typedHost)) {
        const trustedHostKeysBase64 = ctx.requireTrustedHostKeys({
          hostname: typedHost.warpgateSshHost,
          port: typedHost.warpgateSshPort,
        });
        return ctx.coreManager.connect({
          host: typedHost.warpgateSshHost,
          port: typedHost.warpgateSshPort,
          username: `${typedHost.warpgateUsername}:${typedHost.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64: trustedHostKeysBase64[0],
          trustedHostKeysBase64,
          cols: 120,
          rows: 32,
          command,
          hostId: typedHost.id,
          hostLabel: typedHost.label,
          title,
          transport: "warpgate",
        });
      }

      const sshHost = typedHost as SshHostRecord;
      const trustedHostKeysBase64 = ctx.requireTrustedHostKeys(sshHost);
      const username = ctx.requireConfiguredSshUsername(sshHost);
      const { secrets, shouldPersistHostSecret } =
        await ctx.resolveRuntimeSshSecrets(sshHost);
      await ctx.ensureCertificateAuthReady(sshHost, secrets);
      const jump = await ctx.resolveJumpHostTarget(sshHost);
      const authAgentEndpoint =
        sshHost.authType === "agent" ? await resolveLocalAgentEndpoint() : null;
      const connection = await ctx.coreManager.connect({
        host: sshHost.hostname,
        port: sshHost.port,
        username,
        authType: sshHost.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        certificateText: secrets.certificateText,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64: trustedHostKeysBase64[0],
        trustedHostKeysBase64,
        jump,
        authAgentEndpointKind: authAgentEndpoint?.kind,
        authAgentEndpoint: authAgentEndpoint?.endpoint,
        cols: 120,
        rows: 32,
        command,
        hostId: sshHost.id,
        hostLabel: sshHost.label,
        title,
        transport: "ssh",
      });
      if (shouldPersistHostSecret) {
        ctx.pendingSessionSecrets.set(connection.sessionId, {
          hostId: sshHost.id,
          label: title,
          secrets,
        });
      }
      return connection;
    },
  );
}
