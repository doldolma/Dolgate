import {
  isLinkedDnsOverrideRecord,
  isStaticDnsOverrideRecord,
  type DnsOverrideDraft,
  type PortForwardDraft,
} from "@shared";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type {
  AwsEc2HostRecord,
  AwsEcsHostRecord,
  MainIpcContext,
  SftpCompatibleHostRecord,
  SshHostRecord,
} from "./context";

export function registerPortForwardAndDnsIpcHandlers(
  ctx: MainIpcContext,
): void {
  ipcMain.handle(ipcChannels.portForwards.list, async () =>
    ctx.listPortForwardSnapshot(),
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.list,
    async () => ctx.listResolvedDnsOverrides(),
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.create,
    async (_event, draft: DnsOverrideDraft) => {
      const record = ctx.dnsOverrides.create(draft, ctx.portForwards);
      try {
        await ctx.rewriteActiveDnsOverrides();
      } catch (error) {
        ctx.dnsOverrides.remove(record.id);
        throw error;
      }
      ctx.activityLogs.append("info", "audit", "DNS override를 생성했습니다.", {
        dnsOverrideId: record.id,
        type: record.type,
        hostname: record.hostname,
        ...(isLinkedDnsOverrideRecord(record)
          ? { portForwardRuleId: record.portForwardRuleId }
          : { address: record.address }),
      });
      ctx.queueSync();
      const resolved = ctx
        .listResolvedDnsOverrides()
        .find((entry) => entry.id === record.id);
      if (!resolved) {
        throw new Error("Resolved DNS override was not found after create");
      }
      return resolved;
    },
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.update,
    async (_event, id: string, draft: DnsOverrideDraft) => {
      const previous = ctx.dnsOverrides.list();
      const record = ctx.dnsOverrides.update(id, draft, ctx.portForwards);
      try {
        await ctx.rewriteActiveDnsOverrides();
      } catch (error) {
        ctx.dnsOverrides.replaceAll(previous);
        throw error;
      }
      ctx.activityLogs.append("info", "audit", "DNS override를 수정했습니다.", {
        dnsOverrideId: record.id,
        type: record.type,
        hostname: record.hostname,
        ...(isLinkedDnsOverrideRecord(record)
          ? { portForwardRuleId: record.portForwardRuleId }
          : { address: record.address }),
      });
      ctx.queueSync();
      const resolved = ctx
        .listResolvedDnsOverrides()
        .find((entry) => entry.id === record.id);
      if (!resolved) {
        throw new Error("Resolved DNS override was not found after update");
      }
      return resolved;
    },
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.setStaticActive,
    async (_event, id: string, active: boolean) => {
      const record = ctx.dnsOverrides.getById(id);
      if (!record || !isStaticDnsOverrideRecord(record)) {
        throw new Error("Static DNS override not found");
      }

      const previousActive =
        ctx.hostsOverrideManager.getActiveStaticOverrideIds().has(id);
      ctx.hostsOverrideManager.setStaticOverrideActive(id, active);
      try {
        await ctx.rewriteActiveDnsOverrides();
      } catch (error) {
        ctx.hostsOverrideManager.setStaticOverrideActive(id, previousActive);
        throw error;
      }

      ctx.activityLogs.append(
        "info",
        "audit",
        active
          ? "Static DNS override를 활성화했습니다."
          : "Static DNS override를 비활성화했습니다.",
        {
          dnsOverrideId: record.id,
          type: record.type,
          hostname: record.hostname,
          address: record.address,
          active,
        },
      );

      const resolved = ctx
        .listResolvedDnsOverrides()
        .find((entry) => entry.id === record.id);
      if (!resolved) {
        throw new Error("Resolved DNS override was not found after toggle");
      }
      return resolved;
    },
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.remove,
    async (_event, id: string) => {
      const previous = ctx.dnsOverrides.list();
      const current = ctx.dnsOverrides.getById(id);
      ctx.dnsOverrides.remove(id);
      try {
        await ctx.rewriteActiveDnsOverrides();
      } catch (error) {
        ctx.dnsOverrides.replaceAll(previous);
        throw error;
      }
      ctx.syncOutbox.upsertDeletion("dnsOverrides", id);
      if (current) {
        ctx.hostsOverrideManager.removeStaticOverrideState(current.id);
        ctx.activityLogs.append("warn", "audit", "DNS override를 삭제했습니다.", {
          dnsOverrideId: current.id,
          type: current.type,
          hostname: current.hostname,
          ...(isLinkedDnsOverrideRecord(current)
            ? { portForwardRuleId: current.portForwardRuleId }
            : { address: current.address }),
        });
      }
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.create,
    async (_event, draft: PortForwardDraft) => {
      const host = ctx.hosts.getById(draft.hostId);
      if (draft.transport === "aws-ssm") {
        ctx.assertAwsEc2Host(host);
      } else if (draft.transport === "ecs-task") {
        ctx.assertAwsEcsHost(host);
      } else if (draft.transport === "container") {
        ctx.assertSftpCompatibleHost(host);
      } else {
        ctx.assertSshHost(host);
      }
      const record = ctx.portForwards.create(draft);
      ctx.activityLogs.append("info", "audit", "포트 포워딩 규칙을 생성했습니다.", {
        ruleId: record.id,
        label: record.label,
        hostId: record.hostId,
        transport: record.transport,
        mode:
          record.transport === "ssh"
            ? record.mode
            : record.transport === "aws-ssm"
              ? record.targetKind
              : record.transport === "ecs-task"
                ? "ecs-task"
                : "container",
      });
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.update,
    async (_event, id: string, draft: PortForwardDraft) => {
      const host = ctx.hosts.getById(draft.hostId);
      if (draft.transport === "aws-ssm") {
        ctx.assertAwsEc2Host(host);
      } else if (draft.transport === "ecs-task") {
        ctx.assertAwsEcsHost(host);
      } else if (draft.transport === "container") {
        ctx.assertSftpCompatibleHost(host);
      } else {
        ctx.assertSshHost(host);
      }
      const record = ctx.portForwards.update(id, draft);
      ctx.activityLogs.append("info", "audit", "포트 포워딩 규칙을 수정했습니다.", {
        ruleId: record.id,
        label: record.label,
        hostId: record.hostId,
        transport: record.transport,
        mode:
          record.transport === "ssh"
            ? record.mode
            : record.transport === "aws-ssm"
              ? record.targetKind
              : record.transport === "ecs-task"
                ? "ecs-task"
                : "container",
      });
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.remove,
    async (_event, id: string) => {
      const current = ctx.portForwards.getById(id);
      if (current) {
        await ctx.stopPortForwardWithDnsOverrideCleanup(id).catch(() => undefined);
      }
      const linkedOverrides = ctx.dnsOverrides
        .list()
        .filter(
          (override) =>
            isLinkedDnsOverrideRecord(override) &&
            override.portForwardRuleId === id,
        );
      for (const override of linkedOverrides) {
        ctx.dnsOverrides.remove(override.id);
        ctx.syncOutbox.upsertDeletion("dnsOverrides", override.id);
      }
      ctx.syncOutbox.upsertDeletion("portForwards", id);
      ctx.portForwards.remove(id);
      if (current) {
        ctx.activityLogs.append("warn", "audit", "포트 포워딩 규칙을 삭제했습니다.", {
          ruleId: current.id,
          label: current.label,
          hostId: current.hostId,
          transport: current.transport,
          mode:
            current.transport === "ssh"
              ? current.mode
              : current.transport === "aws-ssm"
                ? current.targetKind
                : current.transport === "ecs-task"
                  ? "ecs-task"
                  : "container",
        });
      }
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.start,
    async (_event, ruleId: string) => {
      const rule = ctx.portForwards.getById(ruleId);
      if (!rule) {
        throw new Error("Port forward rule not found");
      }
      const host = ctx.hosts.getById(rule.hostId);
      if (rule.transport === "container") {
        ctx.assertSftpCompatibleHost(host);
        return ctx.startContainerTunnelRuntime({
          ruleId: rule.id,
          host: host as SftpCompatibleHostRecord,
          containerId: rule.containerId,
          networkName: rule.networkName,
          targetPort: rule.targetPort,
          bindAddress: "127.0.0.1",
          bindPort: rule.bindPort,
        });
      }
      if (rule.transport === "ecs-task") {
        ctx.assertAwsEcsHost(host);
        const ecsHost = host as AwsEcsHostRecord;
        const publishRuntime = (status: "starting" | "error", message?: string) =>
          ctx.coreManager.setPortForwardRuntime({
            ruleId: rule.id,
            hostId: ecsHost.id,
            transport: "ecs-task",
            mode: "local",
            bindAddress: "127.0.0.1",
            bindPort: rule.bindPort,
            status,
            updatedAt: new Date().toISOString(),
            message,
            startedAt:
              status === "starting"
                ? ctx.coreManager
                    .listPortForwardRuntimes()
                    .find((runtime) => runtime.ruleId === rule.id)?.startedAt
                : undefined,
          });

        try {
          publishRuntime("starting", "Checking AWS profile");
          let profileStatus = await ctx.awsService.getProfileStatus(
            ecsHost.awsProfileName,
          );
          if (!profileStatus.isAuthenticated) {
            if (!profileStatus.isSsoProfile) {
              throw new Error(
                profileStatus.errorMessage ||
                  "이 프로필은 AWS CLI 자격 증명이 필요합니다.",
              );
            }
            publishRuntime("starting", "Opening AWS SSO login");
            await ctx.awsService.login(ecsHost.awsProfileName);
            publishRuntime("starting", "Checking AWS profile");
            profileStatus = await ctx.awsService.getProfileStatus(
              ecsHost.awsProfileName,
            );
            if (!profileStatus.isAuthenticated) {
              throw new Error(
                profileStatus.errorMessage ||
                  "AWS SSO 로그인 결과를 확인하지 못했습니다.",
              );
            }
          }

          publishRuntime("starting", "Checking Session Manager plugin");
          await ctx.awsService.ensureSessionManagerPluginAvailable();

          publishRuntime("starting", "Resolving running ECS task");
          const targetId = await ctx.awsService.resolveEcsTaskTunnelTarget({
            profileName: ecsHost.awsProfileName,
            region: ecsHost.awsRegion,
            clusterArn: ecsHost.awsEcsClusterArn,
            serviceName: rule.serviceName,
            containerName: rule.containerName,
          });

          publishRuntime("starting", "Starting ECS task tunnel");
          return ctx.coreManager.startSsmPortForward({
            ruleId: rule.id,
            hostId: ecsHost.id,
            profileName: ecsHost.awsProfileName,
            region: ecsHost.awsRegion,
            targetType: "ecs-task",
            targetId,
            bindAddress: "127.0.0.1",
            bindPort: rule.bindPort,
            targetKind: "remote-host",
            targetPort: rule.targetPort,
            remoteHost: "127.0.0.1",
            transport: "ecs-task",
          });
        } catch (error) {
          publishRuntime(
            "error",
            error instanceof Error
              ? error.message
              : "ECS task tunnel을 시작하지 못했습니다.",
          );
          throw error;
        }
      }
      if (rule.transport === "aws-ssm") {
        ctx.assertAwsEc2Host(host);
        const awsHost = host as AwsEc2HostRecord;
        const publishRuntime = (status: "starting" | "error", message?: string) =>
          ctx.coreManager.setPortForwardRuntime({
            ruleId: rule.id,
            hostId: awsHost.id,
            transport: "aws-ssm",
            mode: "local",
            bindAddress: rule.bindAddress,
            bindPort: rule.bindPort,
            status,
            updatedAt: new Date().toISOString(),
            message,
            startedAt:
              status === "starting"
                ? ctx.coreManager
                    .listPortForwardRuntimes()
                    .find((runtime) => runtime.ruleId === rule.id)?.startedAt
                : undefined,
          });

        try {
          publishRuntime("starting", "Checking AWS profile");
          let profileStatus = await ctx.awsService.getProfileStatus(
            awsHost.awsProfileName,
          );
          if (!profileStatus.isAuthenticated) {
            if (!profileStatus.isSsoProfile) {
              throw new Error(
                profileStatus.errorMessage ||
                  "이 프로필은 AWS CLI 자격 증명이 필요합니다.",
              );
            }
            publishRuntime("starting", "Opening AWS SSO login");
            await ctx.awsService.login(awsHost.awsProfileName);
            publishRuntime("starting", "Checking AWS profile");
            profileStatus = await ctx.awsService.getProfileStatus(
              awsHost.awsProfileName,
            );
            if (!profileStatus.isAuthenticated) {
              throw new Error(
                profileStatus.errorMessage ||
                  "AWS SSO 로그인 결과를 확인하지 못했습니다.",
              );
            }
          }

          publishRuntime("starting", "Checking SSM managed instance");
          const isManaged = await ctx.awsService.isManagedInstance(
            awsHost.awsProfileName,
            awsHost.awsRegion,
            awsHost.awsInstanceId,
          );
          if (!isManaged) {
            throw new Error("SSM Agent 또는 managed instance 상태를 확인해 주세요.");
          }

          publishRuntime("starting", "Starting SSM port forward");
          const runtime = await ctx.coreManager.startSsmPortForward({
            ruleId: rule.id,
            hostId: awsHost.id,
            profileName: awsHost.awsProfileName,
            region: awsHost.awsRegion,
            targetType: "instance",
            targetId: awsHost.awsInstanceId,
            bindAddress: rule.bindAddress,
            bindPort: rule.bindPort,
            targetKind: rule.targetKind,
            targetPort: rule.targetPort,
            remoteHost:
              rule.targetKind === "remote-host"
                ? (rule.remoteHost ?? undefined)
                : undefined,
          });
          try {
            await ctx.rewriteActiveDnsOverrides();
          } catch (error) {
            await ctx.stopPortForwardWithDnsOverrideCleanup(rule.id).catch(() => undefined);
            publishRuntime(
              "error",
              error instanceof Error
                ? error.message
                : "hosts override를 적용하지 못했습니다.",
            );
            throw error;
          }
          return runtime;
        } catch (error) {
          publishRuntime(
            "error",
            error instanceof Error
              ? error.message
              : "AWS SSM port forward를 시작하지 못했습니다.",
          );
          throw error;
        }
      }

      ctx.assertSshHost(host);
      const sshHost = host as SshHostRecord;
      const trustedHostKeyBase64 = ctx.requireTrustedHostKey(sshHost);
      const username = ctx.requireConfiguredSshUsername(sshHost);
      const secrets = await ctx.loadSecrets(sshHost.secretRef);

      const runtime = await ctx.coreManager.startPortForward({
        ruleId: rule.id,
        hostId: sshHost.id,
        host: sshHost.hostname,
        port: sshHost.port,
        username,
        authType: sshHost.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        privateKeyPath: sshHost.privateKeyPath ?? undefined,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64,
        mode: rule.mode,
        bindAddress: rule.bindAddress,
        bindPort: rule.bindPort,
        targetHost: rule.targetHost ?? undefined,
        targetPort: rule.targetPort ?? undefined,
      });
      try {
        await ctx.rewriteActiveDnsOverrides();
      } catch (error) {
        await ctx.stopPortForwardWithDnsOverrideCleanup(rule.id).catch(() => undefined);
        ctx.coreManager.setPortForwardRuntime({
          ruleId: rule.id,
          hostId: sshHost.id,
          transport: "ssh",
          mode: rule.mode,
          bindAddress: rule.bindAddress,
          bindPort: rule.bindPort,
          status: "error",
          updatedAt: new Date().toISOString(),
          message:
            error instanceof Error
              ? error.message
              : "hosts override를 적용하지 못했습니다.",
        });
        throw error;
      }
      return runtime;
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.stop,
    async (_event, ruleId: string) => {
      await ctx.stopPortForwardWithDnsOverrideCleanup(ruleId);
    },
  );
}
