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
  type SftpReadFileInput,
  type SftpRenameInput,
  type SftpWriteFileInput,
  type TransferStartInput,
} from "@shared";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
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
import { runWithIpcSessionOwner } from "./session-owner";
import { t } from '../i18n';
import { logMessage } from "../activity-log-message";

function resolveOwnerWebContentsId(
  event: IpcMainInvokeEvent | null,
): number | undefined {
  return event?.sender?.id;
}

async function runWithSftpEndpointOwner<T>(
  ctx: MainIpcContext,
  event: IpcMainInvokeEvent | null,
  endpointId: string,
  action: () => Promise<T>,
): Promise<T> {
  const ownerWebContentsId = resolveOwnerWebContentsId(event);
  if (ownerWebContentsId === undefined) {
    return action();
  }
  ctx.coreManager.registerSftpEndpointOwner(
    endpointId,
    ownerWebContentsId,
  );
  try {
    return await ctx.coreManager.runWithSessionOwner(
      ownerWebContentsId,
      action,
    );
  } catch (error) {
    ctx.coreManager.releaseSftpEndpointOwner(endpointId, ownerWebContentsId);
    throw error;
  }
}

function assertSftpEndpointAccess(
  ctx: MainIpcContext,
  event: IpcMainInvokeEvent | null,
  endpointId: string,
): void {
  const ownerWebContentsId = resolveOwnerWebContentsId(event);
  if (ownerWebContentsId !== undefined) {
    ctx.coreManager.assertSftpEndpointOwner(endpointId, ownerWebContentsId);
  }
}

function assertSftpTransferAccess(
  ctx: MainIpcContext,
  event: IpcMainInvokeEvent | null,
  jobId: string,
): void {
  const ownerWebContentsId = resolveOwnerWebContentsId(event);
  if (ownerWebContentsId !== undefined) {
    ctx.coreManager.assertSftpTransferOwner(jobId, ownerWebContentsId);
  }
}

function assertTransferEndpointAccess(
  ctx: MainIpcContext,
  event: IpcMainInvokeEvent | null,
  input: TransferStartInput,
): void {
  if (input.source.kind === "remote") {
    assertSftpEndpointAccess(ctx, event, input.source.endpointId);
  }
  if (input.target.kind === "remote") {
    assertSftpEndpointAccess(ctx, event, input.target.endpointId);
  }
  if (input.retryOfJobId) {
    assertSftpTransferAccess(ctx, event, input.retryOfJobId);
  }
}

export function registerSftpIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.sftp.connect,
    async (event, input: DesktopSftpConnectInput) => runWithSftpEndpointOwner(ctx, event, input.endpointId, async () => {
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
        const profileName = ctx.awsService.requireManagedProfileName(
          hydratedHost.awsProfileId,
          hydratedHost.awsProfileName,
        );
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
                t('pfIpc.sshUsernameUnknown'),
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
            error: new Error(t('pfIpc.azUnknown')),
            reasonCode: "missing-availability-zone",
          });
        }

        ctx.emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "generating-key",
          message: t('sftpIpc.generatingTempKey'),
        });
        const { privateKeyPem, publicKey } = ctx.createEphemeralAwsSftpKeyPair();

        if (hydratedHost.awsSsmServerProxyEnabled === true) {
          // Server-proxy (bastion): sync-api opens the SSM tunnel and pushes the EIC
          // key on its allowlisted IP; ssh-core rides plain SFTP-over-SSH over a
          // WebSocket to it. No local tunnel and no desktop-side EIC — the server
          // owns every AWS call, which is the whole point for IP-restricted VPCs.
          ctx.emitSftpConnectionProgress({
            endpointId,
            hostId: hydratedHost.id,
            stage: "connecting-sftp",
            message: t('sftpIpc.proxyOpening'),
          });
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
          try {
            return await runWithAwsServerProxyAuthRetry(
              ctx.authService,
              (accessToken) =>
                ctx.coreManager.sftpConnect({
                  endpointId,
                  host: hydratedHost.awsInstanceId,
                  port: sshPort,
                  username: sshUsername,
                  authType: "privateKey",
                  privateKeyPem,
                  trustedHostKeyBase64: trustedHostKeysBase64[0],
                  trustedHostKeysBase64,
                  hostId: hydratedHost.id,
                  title: hydratedHost.label,
                  wsProxy: buildAwsWsProxyTarget({
                    serverUrl: ctx.authService.getServerUrl(),
                    accessToken,
                    startMessage,
                  }),
                }),
            );
          } catch (error) {
            if (error instanceof Error && /^\[/.test(error.message)) {
              throw error;
            }
            throw ctx.emitSftpConnectionFailureProgress({
              endpointId,
              host: hydratedHost,
              stage: "connecting-sftp",
              error,
            });
          }
        }

        ctx.emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "sending-public-key",
          message: t('sftpIpc.pushingKey'),
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
          message: t('sftpIpc.openingTunnel'),
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
            message: t('sftpIpc.startingSession'),
          });
          const endpoint = await retryAwsSsmSshOperation(() =>
            ctx.coreManager.sftpConnect({
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
            }),
          );
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
      const jump = await ctx.resolveJumpHostTarget(sshHost);
      const authAgentEndpoint =
        sshHost.authType === "agent" ? await resolveLocalAgentEndpoint() : null;

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
        jump,
        authAgentEndpointKind: authAgentEndpoint?.kind,
        authAgentEndpoint: authAgentEndpoint?.endpoint,
        hostId: sshHost.id,
        title: sshHost.label,
      });

      if (shouldPersistHostSecret) {
        await ctx.persistHostSpecificSecret(sshHost.id, sshHost.label, secrets);
      }

      return endpoint;
    }),
  );

  ipcMain.handle(
    ipcChannels.sftp.disconnect,
    async (event, endpointId: string) => {
      assertSftpEndpointAccess(ctx, event, endpointId);
      try {
        await ctx.coreManager.sftpDisconnect(endpointId);
      } finally {
        await ctx.stopAwsSftpTunnelForEndpoint(endpointId);
      }
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.list,
    async (event, input: SftpListInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      return ctx.coreManager.sftpList(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.mkdir,
    async (event, input: SftpMkdirInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      await ctx.coreManager.sftpMkdir(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.rename,
    async (event, input: SftpRenameInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      await ctx.coreManager.sftpRename(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.chmod,
    async (event, input: SftpChmodInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      await ctx.coreManager.sftpChmod(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.chown,
    async (event, input: SftpChownInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      await ctx.coreManager.sftpChown(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.listPrincipals,
    async (event, input: SftpListPrincipalsInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      return ctx.coreManager.sftpListPrincipals(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.delete,
    async (event, input: SftpDeleteInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      await ctx.coreManager.sftpDelete(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.readFile,
    async (event, input: SftpReadFileInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      return ctx.coreManager.sftpReadFile(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.writeFile,
    async (event, input: SftpWriteFileInput) => {
      assertSftpEndpointAccess(ctx, event, input.endpointId);
      await ctx.coreManager.sftpWriteFile(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.startTransfer,
    async (event, input: TransferStartInput) => {
      assertTransferEndpointAccess(ctx, event, input);
      return runWithIpcSessionOwner(ctx, event, () =>
        ctx.coreManager.startSftpTransfer(input),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.cancelTransfer,
    async (event, jobId: string) => {
      assertSftpTransferAccess(ctx, event, jobId);
      await ctx.coreManager.cancelSftpTransfer(jobId);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.pauseTransfer,
    async (event, jobId: string) => {
      assertSftpTransferAccess(ctx, event, jobId);
      await ctx.coreManager.pauseSftpTransfer(jobId);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.resumeTransfer,
    async (event, jobId: string) => {
      assertSftpTransferAccess(ctx, event, jobId);
      await ctx.coreManager.resumeSftpTransfer(jobId);
    },
  );
}
