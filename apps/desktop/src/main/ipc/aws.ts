import type {
  AwsProfileCreateInput,
  AwsProfileRenameInput,
  AwsSsoProfilePrepareInput,
  AwsProfileUpdateInput,
} from "@shared";
import { isAwsEcsHostRecord } from "@shared";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { AwsEc2HostRecord, AwsEcsHostRecord, MainIpcContext } from "./context";

export function registerAwsIpcHandlers(ctx: MainIpcContext): void {
  const resolveHostProfileName = (host: {
    awsProfileId?: string | null;
    awsProfileName: string;
  }): string =>
    ctx.awsService.resolveManagedProfileNameOrFallback(
      host.awsProfileId,
      host.awsProfileName,
    ) ?? host.awsProfileName;

  const shouldRetryEcsExecSelectionError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : "";
    return (
      message === "선택한 실행 중 task를 찾지 못했습니다." ||
      message === "선택한 컨테이너를 실행 중인 task에서 찾지 못했습니다." ||
      message === "이 task는 ECS Exec가 활성화되어 있지 않아 셸에 접속할 수 없습니다."
    );
  };

  ipcMain.handle(ipcChannels.aws.listProfiles, async () =>
    ctx.awsService.listProfiles(),
  );

  ipcMain.handle(ipcChannels.aws.listExternalProfiles, async () =>
    ctx.awsService.listExternalProfiles(),
  );

  ipcMain.handle(
    ipcChannels.aws.createProfile,
    async (_event, input: AwsProfileCreateInput) => {
      await ctx.awsService.createProfile(input);
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.prepareSsoProfile,
    async (_event, input: AwsSsoProfilePrepareInput) =>
      ctx.awsService.prepareSsoProfile(input),
  );

  ipcMain.handle(
    ipcChannels.aws.getProfileDetails,
    async (_event, profileName: string) =>
      ctx.awsService.getProfileDetails(profileName),
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
      const updatedHosts = ctx.hosts.backfillAwsProfileReferences(
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
      await ctx.awsService.updateProfile(input);
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.renameProfile,
    async (_event, input: AwsProfileRenameInput) => {
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
    async (_event, profileName: string) => {
      const details = await ctx.awsService.getProfileDetails(profileName);
      await ctx.awsService.deleteProfile(profileName);
      if (details.id) {
        ctx.syncOutbox.upsertDeletion("awsProfiles", details.id);
      }
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.aws.getProfileStatus,
    async (_event, profileName: string) =>
      ctx.awsService.getProfileStatus(profileName),
  );

  ipcMain.handle(ipcChannels.aws.login, async (_event, profileName: string) => {
    await ctx.awsService.login(profileName);
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

  ipcMain.handle(
    ipcChannels.aws.listEcsClusters,
    async (_event, profileName: string, region: string) => {
      return ctx.awsService.listEcsClusters(profileName, region);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsClusterSnapshot,
    async (_event, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      if (!host || !isAwsEcsHostRecord(host)) {
        throw new Error("이 기능은 ECS host에서만 사용할 수 있습니다.");
      }
      return ctx.awsService.describeEcsClusterSnapshot(
        resolveHostProfileName(host),
        host.awsRegion,
        host.awsEcsClusterArn,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsClusterUtilization,
    async (_event, hostId: string) => {
      const host = ctx.hosts.getById(hostId);
      if (!host || !isAwsEcsHostRecord(host)) {
        throw new Error("이 기능은 ECS host에서만 사용할 수 있습니다.");
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
      const host = ctx.hosts.getById(hostId);
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
      const host = ctx.hosts.getById(input.hostId);
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
    async (_event, input: {
      hostId: string;
      serviceName: string;
      taskArn: string;
      containerName: string;
      cols: number;
      rows: number;
      command?: string;
    }) => {
      try {
        const host = ctx.hosts.getById(input.hostId);
        ctx.assertAwsEcsHost(host);
        const ecsHost = host as AwsEcsHostRecord;
        const profileName = resolveHostProfileName(ecsHost);
        await ctx.awsService.ensureAwsCliAvailable();
        await ctx.awsService.ensureSessionManagerPluginAvailable();
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
            throw new Error("선택한 실행 중 task를 찾지 못했습니다.");
          }
          if (!task.enableExecuteCommand) {
            throw new Error(
              "이 task는 ECS Exec가 활성화되어 있지 않아 셸에 접속할 수 없습니다.",
            );
          }
          const container = task.containers.find(
            (item) => item.containerName === input.containerName,
          );
          if (!container) {
            throw new Error("선택한 컨테이너를 실행 중인 task에서 찾지 못했습니다.");
          }
          return ctx.coreManager.connectLocalSession({
            cols: input.cols,
            rows: input.rows,
            title: `${ecsHost.label} · ${input.serviceName} · ${input.containerName}`,
            shellKind: "aws-ecs-exec",
            executable: "aws",
            args: [
              "ecs",
              "execute-command",
              "--profile",
              profileName,
              "--region",
              ecsHost.awsRegion,
              "--cluster",
              ecsHost.awsEcsClusterArn,
              "--task",
              input.taskArn,
              "--container",
              input.containerName,
              "--interactive",
              "--command",
              "/bin/sh",
            ],
          });
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
    },
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
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertAwsEcsHost(host);
      const ecsHost = host as AwsEcsHostRecord;
      const profileName = resolveHostProfileName(ecsHost);
      await ctx.awsService.ensureAwsCliAvailable();
      await ctx.awsService.ensureSessionManagerPluginAvailable();
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
      const host = ctx.hosts.getById(hostId);
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
      const host = ctx.hosts.getById(hostId);
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
      const host = ctx.hosts.getById(hostId);
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
