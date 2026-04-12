import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
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

export function registerContainersIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.containers.list,
    async (_event, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        return {
          runtime: null,
          unsupportedReason: runtimeInfo.unsupportedReason,
          containers: [],
        };
      }
      const listing = await ctx.coreManager.containersList(runtimeInfo.endpointId);
      return {
        runtime: listing.runtime,
        unsupportedReason: null,
        containers: listing.containers,
      };
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
      );
    },
  );

  ipcMain.handle(
    ipcChannels.containers.release,
    async (_event, hostId: string) => {
      const endpointId = ctx.buildContainersEndpointId(hostId);
      try {
        await ctx.coreManager.containersDisconnect(endpointId);
      } finally {
        await ctx.stopAwsContainersTunnelForEndpoint(endpointId);
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
        const profileName =
          ctx.awsService.resolveManagedProfileNameOrFallback(
            hydratedHost.awsProfileId,
            hydratedHost.awsProfileName,
          ) ?? hydratedHost.awsProfileName;
        const sshPort = getAwsEc2HostSshPort(hydratedHost);
        const trustedHostKeyBase64 = ctx.requireTrustedHostKey({
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
          const connection = await ctx.coreManager.connect({
            host: tunnel.bindAddress,
            port: tunnel.bindPort,
            username: sshUsername,
            authType: "privateKey",
            privateKeyPem,
            trustedHostKeyBase64,
            cols: 120,
            rows: 32,
            command,
            hostId: hydratedHost.id,
            hostLabel: hydratedHost.label,
            title,
            transport: "aws-ssm",
          });
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
        const trustedHostKeyBase64 = ctx.requireTrustedHostKey({
          hostname: typedHost.warpgateSshHost,
          port: typedHost.warpgateSshPort,
        });
        return ctx.coreManager.connect({
          host: typedHost.warpgateSshHost,
          port: typedHost.warpgateSshPort,
          username: `${typedHost.warpgateUsername}:${typedHost.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64,
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
      const trustedHostKeyBase64 = ctx.requireTrustedHostKey(sshHost);
      const username = ctx.requireConfiguredSshUsername(sshHost);
      const { secrets, shouldPersistHostSecret } =
        await ctx.resolveRuntimeSshSecrets(sshHost);
      await ctx.ensureCertificateAuthReady(sshHost, secrets);
      const connection = await ctx.coreManager.connect({
        host: sshHost.hostname,
        port: sshHost.port,
        username,
        authType: sshHost.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        certificateText: secrets.certificateText,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64,
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
