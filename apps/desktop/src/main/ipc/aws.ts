import type {
  AwsProfileCreateInput,
  AwsProfileRenameInput,
  AwsProfileRegionUpdateInput,
  AwsSsoProfilePrepareInput,
  AwsProfileUpdateInput,
} from "@shared";
import { isAwsEcsHostRecord } from "@shared";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { AwsEc2HostRecord, AwsEcsHostRecord, MainIpcContext } from "./context";
import { resolveListedVault } from "./listed-vault";
import { runWithIpcSessionOwner } from "./session-owner";
import { t } from '../i18n';
import type { AwsProfileVault } from "../aws-service";
import { PERSONAL_VAULT_ID, type VaultScope } from "../vault-catalog";

/**
 * 관리할 볼트. 없거나 개인이면 undefined — AWS 서비스와 호스트 갱신이 지금까지의 개인 경로를 그대로 탄다. 이 기기에
 * 없는 팀이면 던진다(화면이 막 빠진 팀을 들고 있을 수 있다).
 */
function resolveProfileVault(
  ctx: MainIpcContext,
  vaultId: string | null | undefined,
): { scope: VaultScope; vault: AwsProfileVault } | undefined {
  if (!vaultId || vaultId === PERSONAL_VAULT_ID) {
    return undefined;
  }
  const scope = ctx.vaults.getScope(vaultId);
  if (!scope) {
    throw new Error(t("teams.notOnDevice"));
  }
  return { scope, vault: { teamId: scope.id, profiles: scope.awsProfiles } };
}

/** 팀 볼트의 호스트가 기억하는 프로필 이름(표시용)을 그 팀 프로필 목록에 맞춘다. */
function refreshTeamHostProfileNames(scope: VaultScope): void {
  scope.hosts.refreshAwsProfileNameCaches(
    scope.awsProfiles.listMetadata().map(({ id, name }) => ({ id, name })),
  );
}

export function registerAwsIpcHandlers(ctx: MainIpcContext): void {
  const resolveHostProfileName = (host: {
    awsProfileId?: string | null;
    awsProfileName: string;
  }): string =>
    ctx.awsService.requireManagedProfileName(
      host.awsProfileId,
      host.awsProfileName,
    );

  const shouldRetryEcsExecSelectionError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : "";
    return (
      message === t('awsIpc.runningTaskNotFound') ||
      message === t('aws.ecs.containerNotInTask') ||
      message === t('awsIpc.execDisabledShell')
    );
  };

  // 설정 화면이 볼트를 골라 본다. 팀 프로필은 이름·id 만 — 정적 프로필의 키는 이 기기에만 있다.
  ipcMain.handle(ipcChannels.aws.listProfiles, async (_event, vaultId?: string | null) => {
    const vault = resolveListedVault(ctx.vaults, vaultId);
    if (vault === "personal") {
      return ctx.awsService.listProfiles();
    }
    return (vault?.awsProfiles.listMetadata() ?? []).map(({ id, name }) => ({ id, name }));
  });

  ipcMain.handle(ipcChannels.aws.listExternalProfiles, async () =>
    ctx.awsService.listExternalProfiles(),
  );

  ipcMain.handle(
    ipcChannels.aws.createProfile,
    async (_event, input: AwsProfileCreateInput) => {
      const target = resolveProfileVault(ctx, input.vaultId);
      await (target
        ? ctx.awsService.createProfile(input, target.vault)
        : ctx.awsService.createProfile(input));
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.prepareSsoProfile,
    async (_event, input: AwsSsoProfilePrepareInput) => {
      const target = resolveProfileVault(ctx, input.vaultId);
      return target
        ? ctx.awsService.prepareSsoProfile(input, target.vault)
        : ctx.awsService.prepareSsoProfile(input);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.getProfileDetails,
    async (_event, profileName: string, vaultId?: string | null) => {
      const target = resolveProfileVault(ctx, vaultId);
      return target
        ? ctx.awsService.getProfileDetails(profileName, target.vault)
        : ctx.awsService.getProfileDetails(profileName);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.getExternalProfileDetails,
    async (_event, profileName: string) =>
      ctx.awsService.getExternalProfileDetails(profileName),
  );

  ipcMain.handle(
    ipcChannels.aws.importExternalProfiles,
    async (_event, input: { profileNames: string[] }) => {
      const result = await ctx.awsService.importExternalProfiles(input);
      const updatedHosts = ctx.hosts.refreshAwsProfileNameCaches(
        (await ctx.awsService.listProfiles())
          .filter((profile) => profile.id)
          .map((profile) => ({ id: profile.id!, name: profile.name }))
      );
      if (result.importedProfileNames.length > 0 || updatedHosts.length > 0) {
        ctx.queueSync();
      }
      return result;
    },
  );

  ipcMain.handle(
    ipcChannels.aws.updateProfile,
    async (_event, input: AwsProfileUpdateInput) => {
      // 팀 정적 프로필이면 키는 내 칸으로 간다(팀 저장소가 나눈다).
      const target = resolveProfileVault(ctx, input.vaultId);
      await (target
        ? ctx.awsService.updateProfile(input, target.vault)
        : ctx.awsService.updateProfile(input));
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.updateProfileRegion,
    async (_event, input: AwsProfileRegionUpdateInput) => {
      const target = resolveProfileVault(ctx, input.vaultId);
      await (target
        ? ctx.awsService.updateProfileRegion(input, target.vault)
        : ctx.awsService.updateProfileRegion(input));
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.renameProfile,
    async (_event, input: AwsProfileRenameInput) => {
      const target = resolveProfileVault(ctx, input.vaultId);
      if (target) {
        // 팀 프로필의 이름이 바뀌면 그 팀 호스트가 보이는 프로필 이름도 따라간다.
        await ctx.awsService.renameProfile(input, target.vault);
        refreshTeamHostProfileNames(target.scope);
        ctx.queueSync();
        return;
      }
      await ctx.awsService.renameProfile(input);
      const details = await ctx.awsService.getProfileDetails(input.nextProfileName);
      if (details.id) {
        ctx.hosts.updateAwsProfileCache(details.id, input.nextProfileName);
      }
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.deleteProfile,
    async (_event, profileName: string, vaultId?: string | null) => {
      const target = resolveProfileVault(ctx, vaultId);
      if (target) {
        const id = target.scope.awsProfiles.getMetadataByName(profileName.trim())?.id ?? null;
        // 지움 기록을 먼저 남긴다. 지운 뒤(펼친 파일을 쓰는 동안) 팀 동기화가 한 바퀴 돌면, 기록 없이 빠진 레코드를
        // 서버 사본으로 되살린다 — 실제 앱 시험에서 잠깐 되살아났다. 못 지우면 기록도 거둔다.
        if (id) {
          target.scope.syncOutbox.upsertDeletion("awsProfiles", id);
        }
        try {
          await ctx.awsService.deleteProfile(profileName, target.vault);
        } catch (error) {
          if (id) {
            target.scope.syncOutbox.clear("awsProfiles", id);
          }
          throw error;
        }
        refreshTeamHostProfileNames(target.scope);
        ctx.queueSync();
        return;
      }
      const details = await ctx.awsService.getProfileDetails(profileName);
      await ctx.awsService.deleteProfile(profileName);
      ctx.hosts.refreshAwsProfileNameCaches(
        (await ctx.awsService.listProfiles())
          .filter((profile) => profile.id)
          .map((profile) => ({ id: profile.id!, name: profile.name })),
      );
      if (details.id) {
        ctx.syncOutbox.upsertDeletion("awsProfiles", details.id);
      }
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.getProfileStatus,
    async (_event, profileName: string, vaultId?: string | null) => {
      const target = resolveProfileVault(ctx, vaultId);
      return target
        ? ctx.awsService.getProfileStatus(profileName, target.vault)
        : ctx.awsService.getProfileStatus(profileName);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.getProfileStatusById,
    async (_event, profileId: string) =>
      ctx.awsService.getProfileStatus(
        ctx.awsService.requireManagedProfileName(profileId, null),
      ),
  );

  ipcMain.handle(ipcChannels.aws.login, async (_event, profileName: string, vaultId?: string | null) => {
    const target = resolveProfileVault(ctx, vaultId);
    if (target) {
      await ctx.awsService.login(profileName, target.vault);
      return;
    }
    await ctx.awsService.login(profileName);
  });

  ipcMain.handle(ipcChannels.aws.loginById, async (_event, profileId: string) => {
    await ctx.awsService.login(
      ctx.awsService.requireManagedProfileName(profileId, null),
    );
  });

  ipcMain.handle(
    ipcChannels.aws.listRegions,
    async (_event, profileName: string) =>
      ctx.awsService.listRegions(profileName),
  );

  ipcMain.handle(
    ipcChannels.aws.listEc2Instances,
    async (_event, profileName: string, region: string) => {
      return ctx.awsService.listEc2Instances(profileName, region);
    },
  );

  // 개인키가 렌더러에서 메인으로 한 번 건너온다. 복호화는 메인이 하고 결과 비밀번호만 돌려준다 —
  // 키를 저장하지도, 로그에 남기지도 않는다.
  ipcMain.handle(
    ipcChannels.aws.getWindowsPassword,
    async (
      _event,
      input: {
        profileName: string;
        region: string;
        instanceId: string;
        privateKeyPem: string;
      },
    ) => ctx.awsService.getWindowsPassword(input),
  );

  ipcMain.handle(
    ipcChannels.aws.listEcsClusters,
    async (_event, profileName: string, region: string) => {
      return ctx.awsService.listEcsClusters(profileName, region);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsClusterSnapshot,
    async (_event, hostId: string) => {
      const host = ctx.vaults.getHost(hostId);
      if (!host || !isAwsEcsHostRecord(host)) {
        throw new Error(t('awsIpc.ecsOnly'));
      }
      const scopeId = ctx.buildContainersEndpointId(host.id);
      const { lifecycleId } = ctx.coreManager.beginContainerLifecycle({
        scopeId,
        hostId: host.id,
        hostLabel: host.label,
        workspaceKind: "ecs-cluster",
        transport: "aws-ecs",
      });
      ctx.coreManager.noteContainerLifecycleLoadStarted(scopeId, lifecycleId);
      try {
        const snapshot = await ctx.awsService.describeEcsClusterSnapshot(
          resolveHostProfileName(host),
          host.awsRegion,
          host.awsEcsClusterArn,
        );
        ctx.coreManager.markContainerLifecycleConnected({
          scopeId,
          lifecycleId,
          resourceCount: snapshot.services.length,
        });
        return snapshot;
      } catch (error) {
        ctx.coreManager.reportContainerLifecycleError({
          lifecycleId,
          message:
            error instanceof Error
              ? error.message
              : t('containersStore.ecsLoadFailed'),
        });
        throw error;
      }
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsClusterUtilization,
    async (_event, hostId: string) => {
      const host = ctx.vaults.getHost(hostId);
      if (!host || !isAwsEcsHostRecord(host)) {
        throw new Error(t('awsIpc.ecsOnly'));
      }
      return ctx.awsService.describeEcsClusterUtilization(
        resolveHostProfileName(host),
        host.awsRegion,
        host.awsEcsClusterArn,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsServiceActionContext,
    async (_event, hostId: string, serviceName: string) => {
      const host = ctx.vaults.getHost(hostId);
      ctx.assertAwsEcsHost(host);
      const ecsHost = host as AwsEcsHostRecord;
      return ctx.awsService.describeEcsServiceActionContext(
        resolveHostProfileName(ecsHost),
        ecsHost.awsRegion,
        ecsHost.awsEcsClusterArn,
        serviceName,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsServiceLogs,
    async (_event, input: {
      hostId: string;
      serviceName: string;
      taskArn?: string | null;
      containerName?: string | null;
      followCursor?: string | null;
      startTime?: string | null;
      endTime?: string | null;
      limit?: number;
    }) => {
      const host = ctx.vaults.getHost(input.hostId);
      ctx.assertAwsEcsHost(host);
      const ecsHost = host as AwsEcsHostRecord;
      return ctx.awsService.loadEcsServiceLogs({
        profileName: resolveHostProfileName(ecsHost),
        region: ecsHost.awsRegion,
        clusterArn: ecsHost.awsEcsClusterArn,
        serviceName: input.serviceName,
        taskArn: input.taskArn ?? null,
        containerName: input.containerName ?? null,
        followCursor: input.followCursor ?? null,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        limit: input.limit,
      });
    },
  );

  ipcMain.handle(
    ipcChannels.aws.openEcsExecShell,
    async (event, input: {
      hostId: string;
      serviceName: string;
      taskArn: string;
      containerName: string;
      cols: number;
      rows: number;
      command?: string;
    }) => runWithIpcSessionOwner(ctx, event, async () => {
      try {
        const host = ctx.vaults.getHost(input.hostId);
        ctx.assertAwsEcsHost(host);
        const ecsHost = host as AwsEcsHostRecord;
        const profileName = resolveHostProfileName(ecsHost);
        const openShell = async () => {
          const actionContext = await ctx.awsService.describeEcsServiceActionContext(
            profileName,
            ecsHost.awsRegion,
            ecsHost.awsEcsClusterArn,
            input.serviceName,
          );
          const task = actionContext.runningTasks.find(
            (item) => item.taskArn === input.taskArn,
          );
          if (!task) {
            throw new Error(t('awsIpc.runningTaskNotFound'));
          }
          if (!task.enableExecuteCommand) {
            throw new Error(
              t('awsIpc.execDisabledShell'),
            );
          }
          const container = task.containers.find(
            (item) => item.containerName === input.containerName,
          );
          if (!container) {
            throw new Error(t('aws.ecs.containerNotInTask'));
          }
          const taskId =
            input.taskArn.split("/").filter(Boolean).at(-1) ?? input.taskArn;
          const title = `${ecsHost.label} · ${input.serviceName} · ${input.containerName}`;
          const connectionDetails = `${input.serviceName} · ${input.containerName} · ${taskId}`;
          const ssmSession = await ctx.awsService.startEcsExecSession({
            profileName,
            region: ecsHost.awsRegion,
            clusterArn: ecsHost.awsEcsClusterArn,
            taskArn: input.taskArn,
            containerName: input.containerName,
            command: "/bin/sh",
          });
          const connection = await ctx.coreManager.connectAwsSession({
            profileName,
            region: ecsHost.awsRegion,
            instanceId: input.taskArn,
            cols: input.cols,
            rows: input.rows,
            title,
            hostId: ecsHost.id,
            hostLabel: ecsHost.label,
            connectionKind: "aws-ecs-exec",
            connectionDetails,
            ssmSession,
          });
          ctx.sessionReplayService.noteSessionConfigured(
            connection.sessionId,
            input.cols,
            input.rows,
          );
          return connection;
        };

        try {
          return await openShell();
        } catch (error) {
          if (!shouldRetryEcsExecSelectionError(error)) {
            throw error;
          }
          ctx.awsService.invalidateEcsServiceActionContext(
            profileName,
            ecsHost.awsRegion,
            ecsHost.awsEcsClusterArn,
            input.serviceName,
          );
          return await openShell();
        }
      } catch (error) {
        throw ctx.normalizeEcsExecPermissionError(error);
      }
    }),
  );

  ipcMain.handle(
    ipcChannels.aws.startEcsServiceTunnel,
    async (_event, input: {
      hostId: string;
      serviceName: string;
      taskArn: string;
      containerName: string;
      targetPort: number;
      bindAddress: string;
      bindPort: number;
    }) => {
      const host = ctx.vaults.getHost(input.hostId);
      ctx.assertAwsEcsHost(host);
      const ecsHost = host as AwsEcsHostRecord;
      const profileName = resolveHostProfileName(ecsHost);
      const startTunnel = async () => {
        const targetId = await ctx.awsService.resolveEcsTaskTunnelTargetForTask({
          profileName,
          region: ecsHost.awsRegion,
          clusterArn: ecsHost.awsEcsClusterArn,
          taskArn: input.taskArn,
          containerName: input.containerName,
        });
        const runtimeId = `ecs-service-tunnel:${randomUUID()}`;
        return ctx.coreManager.startSsmPortForward({
          ruleId: runtimeId,
          hostId: ecsHost.id,
          transport: "ecs-task",
          profileName,
          region: ecsHost.awsRegion,
          targetType: "ecs-task",
          targetId,
          bindAddress: input.bindAddress,
          bindPort: input.bindPort,
          targetKind: "remote-host",
          targetPort: input.targetPort,
          remoteHost: "127.0.0.1",
        });
      };

      try {
        return await startTunnel();
      } catch (error) {
        ctx.awsService.invalidateEcsServiceActionContext(
          profileName,
          ecsHost.awsRegion,
          ecsHost.awsEcsClusterArn,
          input.serviceName,
        );
        return await startTunnel();
      }
    },
  );

  ipcMain.handle(
    ipcChannels.aws.stopEcsServiceTunnel,
    async (_event, runtimeId: string) => {
      await ctx.coreManager.stopPortForward(runtimeId);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.listEcsTaskTunnelServices,
    async (_event, hostId: string) => {
      const host = ctx.vaults.getHost(hostId);
      ctx.assertAwsEcsHost(host);
      const ecsHost = host as AwsEcsHostRecord;
      return ctx.awsService.listEcsTaskTunnelServices(
        resolveHostProfileName(ecsHost),
        ecsHost.awsRegion,
        ecsHost.awsEcsClusterArn,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsTaskTunnelService,
    async (_event, hostId: string, serviceName: string) => {
      const host = ctx.vaults.getHost(hostId);
      ctx.assertAwsEcsHost(host);
      const ecsHost = host as AwsEcsHostRecord;
      return ctx.awsService.describeEcsTaskTunnelService(
        resolveHostProfileName(ecsHost),
        ecsHost.awsRegion,
        ecsHost.awsEcsClusterArn,
        serviceName,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.inspectHostSshMetadata,
    async (
      _event,
      input: {
        profileName: string;
        region: string;
        instanceId: string;
        availabilityZone?: string | null;
      },
    ) => ctx.awsService.inspectHostSshMetadata(input),
  );

  ipcMain.handle(
    ipcChannels.aws.loadHostSshMetadata,
    async (_event, hostId: string) => {
      const host = ctx.vaults.getHost(hostId);
      ctx.assertAwsEc2Host(host);
      return ctx.loadAwsHostSshMetadataRecord(host as AwsEc2HostRecord);
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.testConnection,
    async (_event, baseUrl: string, token: string) => {
      return ctx.warpgateService.testConnection(baseUrl, token);
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.getConnectionInfo,
    async (_event, baseUrl: string, token: string) => {
      return ctx.warpgateService.getConnectionInfo(baseUrl, token);
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.listSshTargets,
    async (_event, baseUrl: string, token: string) => {
      return ctx.warpgateService.listSshTargets(baseUrl, token);
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.startBrowserImport,
    async (event, baseUrl: string) => {
      return ctx.warpgateService.startBrowserImport(
        baseUrl,
        ctx.resolveWindowFromSender(event.sender),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.cancelBrowserImport,
    async (_event, attemptId: string) => {
      await ctx.warpgateService.cancelBrowserImport(attemptId);
    },
  );
}
