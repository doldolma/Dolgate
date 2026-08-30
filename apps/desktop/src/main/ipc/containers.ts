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

function resolveOwnerWebContentsId(
  event: IpcMainInvokeEvent | null,
): number | undefined {
  return event?.sender?.id;
}

function registerContainerSubscriber(
  ctx: MainIpcContext,
  event: IpcMainInvokeEvent | null,
  hostId: string,
): void {
  const ownerWebContentsId = resolveOwnerWebContentsId(event);
  if (ownerWebContentsId !== undefined) {
    ctx.coreManager.registerContainerSubscriber(
      ctx.buildContainersEndpointId(hostId),
      ownerWebContentsId,
    );
  }
}

function assertContainerSubscriber(
  ctx: MainIpcContext,
  event: IpcMainInvokeEvent | null,
  hostId: string,
): void {
  const ownerWebContentsId = resolveOwnerWebContentsId(event);
  if (ownerWebContentsId !== undefined) {
    ctx.coreManager.assertContainerSubscriber(
      ctx.buildContainersEndpointId(hostId),
      ownerWebContentsId,
    );
  }
}

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
    async (event, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      if (!host) {
        throw new Error(t('containersIpc.hostNotFound'));
      }
      registerContainerSubscriber(ctx, event, hostId);
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
          t('containersIpc.connectionError'),
      });
    },
  );

  ipcMain.handle(
    ipcChannels.containers.list,
    async (event, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      registerContainerSubscriber(ctx, event, hostId);
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
              t('containersIpc.runtimeCheckFailed'),
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
              : t('containersIpc.listFailed'),
        });
        throw error;
      }
    },
  );

  ipcMain.handle(
    ipcChannels.containers.inspect,
    async (event, hostId: string, containerId: string) => {
      assertContainerSubscriber(ctx, event, hostId);
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
        );
      }
      return ctx.coreManager.containersInspect(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.logs,
    async (event, input: HostContainersLogsInput) => {
      assertContainerSubscriber(ctx, event, input.hostId);
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
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
    async (event, input: HostContainersEphemeralTunnelInput) => {
      // **컨테이너 탭 구독을 요구하지 않는다.** 세션 패널의 도커 섹션에서도 열기 때문이다 —
      // 그 화면에는 컨테이너 탭이 없다. 터널은 자기 전용 엔드포인트를 새로 만들므로(ruleId 로
      // 키를 잡는다) 남의 구독을 건드리지도 않는다. 대신 아래에서 주인을 등록해 창·세션이
      // 끝날 때 메인이 회수한다.
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const ruleId = `container-service-tunnel:${randomUUID()}`;
      // 주인을 먼저 적는다 — 시작 도중에 창이 닫혀도 회수 대상에 들어 있어야 한다.
      // 창은 언제나, 세션은 세션 패널에서 연 것만.
      ctx.coreManager.registerContainerTunnelOwner(ruleId, {
        ownerWebContentsId: event.sender.id,
        sessionId: input.ownerSessionId ?? null,
      });
      try {
        return await ctx.startContainerTunnelRuntime({
          ruleId,
          host: host as SftpCompatibleHostRecord,
          containerId: input.containerId,
          containerName: input.containerName ?? null,
          networkName: input.networkName,
          targetPort: input.targetPort,
          bindAddress: input.bindAddress,
          bindPort: input.bindPort,
          networks: input.networks,
        });
      } catch (error) {
        ctx.coreManager.releaseContainerTunnelOwner(ruleId);
        throw error;
      }
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stopTunnel,
    async (event, runtimeId: string) => {
      // **이 통로는 임시 컨테이너 터널만 다룬다.** `stopPortForward` 는 모든 포워딩의 공용
      // 정지 함수라, 확인 없이 부르면 홈에서 켜 둔 SSH 규칙이 여기로 꺼질 수 있다. 등록에
      // 없으면 이미 끝난 것이거나 우리 것이 아니므로 조용히 끝낸다(오류로 만들 일이 아니다).
      const owner = ctx.coreManager.getContainerTunnelOwner(runtimeId);
      if (!owner) {
        return;
      }
      // 연 창만 닫는다. 지금은 각 창의 스토어에 자기 것만 들어 있어 남의 id 를 넘길 경로가
      // 없지만, 그 전제가 깨지면 여기서 막힌다(주인을 모르는 옛 기록은 그대로 통과시킨다).
      if (
        owner.ownerWebContentsId !== null &&
        owner.ownerWebContentsId !== event.sender.id
      ) {
        return;
      }
      ctx.coreManager.releaseContainerTunnelOwner(runtimeId);
      await ctx.coreManager.stopPortForward(runtimeId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.start,
    async (event, hostId: string, containerId: string) => {
      assertContainerSubscriber(ctx, event, hostId);
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
        );
      }
      await ctx.coreManager.containersStart(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stop,
    async (event, hostId: string, containerId: string) => {
      assertContainerSubscriber(ctx, event, hostId);
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
        );
      }
      await ctx.coreManager.containersStop(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.restart,
    async (event, hostId: string, containerId: string) => {
      assertContainerSubscriber(ctx, event, hostId);
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
        );
      }
      await ctx.coreManager.containersRestart(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.remove,
    async (event, hostId: string, containerId: string) => {
      assertContainerSubscriber(ctx, event, hostId);
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
        );
      }
      await ctx.coreManager.containersRemove(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stats,
    async (event, input: HostContainersStatsInput) => {
      assertContainerSubscriber(ctx, event, input.hostId);
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
        );
      }
      return ctx.coreManager.containersStats(runtimeInfo.endpointId, input.containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.searchLogs,
    async (event, input: HostContainersSearchLogsInput) => {
      assertContainerSubscriber(ctx, event, input.hostId);
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            t('containersIpc.runtimeUnavailable'),
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
    async (event, hostId: string, lifecycleId?: string) => {
      const host = ctx.hosts.getById(hostId);
      const endpointId = ctx.buildContainersEndpointId(hostId);
      const ownerWebContentsId = resolveOwnerWebContentsId(event);
      if (ownerWebContentsId !== undefined) {
        const subscription = ctx.coreManager.releaseContainerSubscriber(
          endpointId,
          ownerWebContentsId,
        );
        if (!subscription.released || subscription.remainingSubscribers > 0) {
          return;
        }
      }
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
    async (event, hostId: string, containerId: string) =>
      runWithIpcSessionOwner(ctx, event, async () => {
      assertContainerSubscriber(ctx, event, hostId);
      const host = ctx.hosts.getById(hostId);
      ctx.assertSftpCompatibleHost(host);
      const typedHost = host as SftpCompatibleHostRecord;
      const runtimeInfo = await ctx.ensureContainersEndpoint(typedHost);
      if (!runtimeInfo.runtime || !runtimeInfo.runtimeCommand) {
        throw new Error(t('containersIpc.checkRuntimeFirst'));
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
              t('pfIpc.sshUsernameUnknown'),
          );
        }
        if (!availabilityZone) {
          throw new Error(t('pfIpc.azUnknown'));
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
        const trustedHostKeysBase64 = ctx.resolveTrustedHostKeys({
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
      const trustedHostKeysBase64 = ctx.resolveTrustedHostKeys(sshHost);
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
        // 셸도 목록·로그와 같은 경로를 타야 한다. 안 넘기면 tailnet 호스트의 셸이 일반
        // 네트워크로 나가는데, 그건 실패가 아니라 성공으로 보인다. 게다가 위의
        // resolveTrustedHostKeys 는 이미 tailnet 범위로 읽으므로, 공개망에서 TOFU 로 받은
        // 키가 그 tailnet 범위에 저장된다.
        ...ctx.resolveTailnetRoute(sshHost),
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
      }),
  );
}
