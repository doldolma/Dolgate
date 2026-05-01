import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
  isWarpgateSshHostRecord,
  type DesktopSftpConnectInput,
  type SftpChmodInput,
  type SftpChownInput,
  type SftpDeleteInput,
  type SftpListPrincipalsInput,
  type SftpListInput,
  type SftpMkdirInput,
  type SftpRenameInput,
  type TransferStartInput,
} from "@shared";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type {
  AwsEc2HostRecord,
  MainIpcContext,
  SftpCompatibleHostRecord,
  SshHostRecord,
} from "./context";

export function registerSftpIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.sftp.connect,
    async (_event, input: DesktopSftpConnectInput) => {
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;

      if (isAwsEc2HostRecord(typedHost)) {
        const endpointId = input.endpointId;
        const hydratedHost =
          ctx.consumeAwsSftpPreflight(endpointId, typedHost.id) ??
          (await ctx.resolveAwsSftpPreflight({
            endpointId,
            host: typedHost as AwsEc2HostRecord,
            allowBrowserLogin: true,
          }));
        const sshPort = getAwsEc2HostSshPort(hydratedHost);
        const profileName =
          ctx.awsService.resolveManagedProfileNameOrFallback(
            hydratedHost.awsProfileId,
            hydratedHost.awsProfileName,
          ) ?? hydratedHost.awsProfileName;
        let trustedHostKeysBase64: string[];
        try {
          trustedHostKeysBase64 = ctx.requireTrustedHostKeys({
            hostname: buildAwsSsmKnownHostIdentity({
              profileName,
              region: hydratedHost.awsRegion,
              instanceId: hydratedHost.awsInstanceId,
            }),
            port: sshPort,
          });
        } catch (error) {
          throw ctx.emitSftpConnectionFailureProgress({
            endpointId,
            host: hydratedHost,
            stage: "probing-host-key",
            error,
            reasonCode: "host-key-missing",
          });
        }
        const sshUsername = hydratedHost.awsSshUsername?.trim();
        if (!sshUsername) {
          throw ctx.emitSftpConnectionFailureProgress({
            endpointId,
            host: hydratedHost,
            stage: "loading-instance-metadata",
            error: new Error(
              hydratedHost.awsSshMetadataError ||
                "자동으로 SSH 사용자명을 확인하지 못했습니다.",
            ),
            reasonCode: "missing-username",
          });
        }
        const availabilityZone = hydratedHost.awsAvailabilityZone?.trim();
        if (!availabilityZone) {
          throw ctx.emitSftpConnectionFailureProgress({
            endpointId,
            host: hydratedHost,
            stage: "checking-ssm",
            error: new Error("Availability Zone을 확인하지 못했습니다."),
            reasonCode: "missing-availability-zone",
          });
        }

        ctx.emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "generating-key",
          message: "임시 SSH 키를 생성하는 중입니다.",
        });
        const { privateKeyPem, publicKey } = ctx.createEphemeralAwsSftpKeyPair();

        ctx.emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "sending-public-key",
          message: "EC2 Instance Connect로 공개 키를 전송하는 중입니다.",
        });
        try {
          await ctx.awsService.sendSshPublicKey({
            profileName,
            region: hydratedHost.awsRegion,
            instanceId: hydratedHost.awsInstanceId,
            availabilityZone,
            osUser: sshUsername,
            publicKey,
          });
        } catch (error) {
          throw ctx.emitSftpConnectionFailureProgress({
            endpointId,
            host: hydratedHost,
            stage: "sending-public-key",
            error,
          });
        }

        ctx.emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "opening-tunnel",
          message: "SFTP 연결용 내부 터널을 여는 중입니다.",
        });
        const bindPort = await ctx.reserveLoopbackPort();
        let tunnelRuntimeId = "";
        try {
          const tunnel = await ctx.awsSsmTunnelService.start({
            runtimeId: `aws-sftp:${endpointId}`,
            profileName,
            region: hydratedHost.awsRegion,
            instanceId: hydratedHost.awsInstanceId,
            bindAddress: "127.0.0.1",
            bindPort,
            targetPort: sshPort,
          });
          tunnelRuntimeId = tunnel.runtimeId;

          ctx.emitSftpConnectionProgress({
            endpointId,
            hostId: hydratedHost.id,
            stage: "connecting-sftp",
            message: "SFTP 세션을 시작하는 중입니다.",
          });
          const endpoint = await ctx.coreManager.sftpConnect({
            endpointId,
            host: tunnel.bindAddress,
            port: tunnel.bindPort,
            username: sshUsername,
            authType: "privateKey",
            privateKeyPem,
            trustedHostKeyBase64: trustedHostKeysBase64[0],
            trustedHostKeysBase64,
            hostId: hydratedHost.id,
            title: hydratedHost.label,
          });
          ctx.trackAwsSftpTunnelRuntime(endpoint.id, tunnel.runtimeId);
          return endpoint;
        } catch (error) {
          ctx.clearAwsSftpPreflight(endpointId);
          if (tunnelRuntimeId) {
            await ctx.awsSsmTunnelService.stop(tunnelRuntimeId).catch(() => undefined);
          }
          if (error instanceof Error && /^\[/.test(error.message)) {
            throw error;
          }
          throw ctx.emitSftpConnectionFailureProgress({
            endpointId,
            host: hydratedHost,
            stage: tunnelRuntimeId ? "connecting-sftp" : "opening-tunnel",
            error,
          });
        }
      }

      if (isWarpgateSshHostRecord(typedHost)) {
        const trustedHostKeysBase64 = ctx.requireTrustedHostKeys({
          hostname: typedHost.warpgateSshHost,
          port: typedHost.warpgateSshPort,
        });
        return ctx.coreManager.sftpConnect({
          endpointId: input.endpointId,
          host: typedHost.warpgateSshHost,
          port: typedHost.warpgateSshPort,
          username: `${typedHost.warpgateUsername}:${typedHost.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64: trustedHostKeysBase64[0],
          trustedHostKeysBase64,
          hostId: typedHost.id,
          title: typedHost.label,
        });
      }

      const sshHost = typedHost as SshHostRecord;
      const trustedHostKeysBase64 = ctx.requireTrustedHostKeys(sshHost);
      const username = ctx.requireConfiguredSshUsername(sshHost);
      const { secrets, shouldPersistHostSecret } =
        await ctx.resolveRuntimeSshSecrets(sshHost, input.secrets);
      await ctx.ensureCertificateAuthReady(sshHost, secrets);

      const endpoint = await ctx.coreManager.sftpConnect({
        endpointId: input.endpointId,
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
        hostId: sshHost.id,
        title: sshHost.label,
      });

      if (shouldPersistHostSecret) {
        await ctx.persistHostSpecificSecret(sshHost.id, sshHost.label, secrets);
      }

      return endpoint;
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.disconnect,
    async (_event, endpointId: string) => {
      try {
        await ctx.coreManager.sftpDisconnect(endpointId);
      } finally {
        await ctx.stopAwsSftpTunnelForEndpoint(endpointId);
      }
    },
  );

  ipcMain.handle(ipcChannels.sftp.list, async (_event, input: SftpListInput) =>
    ctx.coreManager.sftpList(input),
  );

  ipcMain.handle(
    ipcChannels.sftp.mkdir,
    async (_event, input: SftpMkdirInput) => {
      await ctx.coreManager.sftpMkdir(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.rename,
    async (_event, input: SftpRenameInput) => {
      await ctx.coreManager.sftpRename(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.chmod,
    async (_event, input: SftpChmodInput) => {
      await ctx.coreManager.sftpChmod(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.chown,
    async (_event, input: SftpChownInput) => {
      await ctx.coreManager.sftpChown(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.listPrincipals,
    async (_event, input: SftpListPrincipalsInput) =>
      ctx.coreManager.sftpListPrincipals(input),
  );

  ipcMain.handle(
    ipcChannels.sftp.delete,
    async (_event, input: SftpDeleteInput) => {
      await ctx.coreManager.sftpDelete(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.startTransfer,
    async (_event, input: TransferStartInput) =>
      ctx.coreManager.startSftpTransfer(input),
  );

  ipcMain.handle(
    ipcChannels.sftp.cancelTransfer,
    async (_event, jobId: string) => {
      await ctx.coreManager.cancelSftpTransfer(jobId);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.pauseTransfer,
    async (_event, jobId: string) => {
      await ctx.coreManager.pauseSftpTransfer(jobId);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.resumeTransfer,
    async (_event, jobId: string) => {
      await ctx.coreManager.resumeSftpTransfer(jobId);
    },
  );
}
