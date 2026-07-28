import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  isLinkedDnsOverrideRecord,
  isStaticDnsOverrideRecord,
  type DnsOverrideDraft,
  type PortForwardDraft,
} from "@shared";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import {
  buildAwsServerProxyStartMessage,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from "../aws-ws-proxy";
import { describeHostsOverrideFailure as describeHostsOverrideManagerFailure } from "../hosts-override-manager";
import type {
  AwsEc2HostRecord,
  AwsEcsHostRecord,
  MainIpcContext,
  SftpCompatibleHostRecord,
  SshHostRecord,
} from "./context";
import { resolveLocalAgentEndpoint } from "./agent-endpoint";
import { t } from "../i18n";
import { logMessage } from "../activity-log-message";

export function registerPortForwardAndDnsIpcHandlers(
  ctx: MainIpcContext,
): void {
  const resolveHostProfileName = (host: {
    awsProfileId?: string | null;
    awsProfileName: string;
  }): string =>
    ctx.awsService.requireManagedProfileName(
      host.awsProfileId,
      host.awsProfileName,
    );

  const buildUserFacingDnsOverrideErrorMessage = (
    failure: ReturnType<typeof describeHostsOverrideManagerFailure>,
  ): string => {
    if (!failure.rawError) {
      return failure.message;
    }
    if (
      failure.stage === "helper-not-ready" ||
      failure.stage === "hosts-verification" ||
      failure.stage === "unknown"
    ) {
      return t("pfIpc.failureWithCause", { message: failure.message, cause: failure.rawError });
    }
    return failure.message;
  };

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
      ctx.activityLogs.append("info", "audit", logMessage("pfIpc.dnsCreated"), {
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
      ctx.activityLogs.append("info", "audit", logMessage("pfIpc.dnsUpdated"), {
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
        const failure = describeHostsOverrideManagerFailure(
          error,
          active
            ? t("pfIpc.dnsEnableFailed")
            : t("pfIpc.dnsDisableFailed"),
        );
        const userFacingMessage = buildUserFacingDnsOverrideErrorMessage(failure);
        ctx.activityLogs.append(
          "error",
          "audit",
          userFacingMessage,
          {
            dnsOverrideId: record.id,
            type: record.type,
            hostname: record.hostname,
            address: record.address,
            active,
            stage: failure.stage,
            rawError: failure.rawError,
          },
        );
        throw new Error(userFacingMessage);
      }

      ctx.activityLogs.append(
        "info",
        "audit",
        active
          ? t("pfIpc.dnsEnabled")
          : t("pfIpc.dnsDisabled"),
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
        ctx.activityLogs.append("warn", "audit", logMessage("pfIpc.dnsDeleted"), {
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
      ctx.activityLogs.append("info", "audit", logMessage("pfIpc.ruleCreated"), {
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
      ctx.activityLogs.append("info", "audit", logMessage("pfIpc.ruleUpdated"), {
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
        ctx.activityLogs.append("warn", "audit", logMessage("pfIpc.ruleDeleted"), {
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
          const profileName = resolveHostProfileName(ecsHost);
          let profileStatus = await ctx.awsService.getProfileStatus(
            profileName,
          );
          if (!profileStatus.isAuthenticated) {
            if (!profileStatus.isSsoProfile) {
              throw new Error(
                profileStatus.errorMessage ||
                  t("pfIpc.cliCredentialsNeeded"),
              );
            }
            publishRuntime("starting", "Opening AWS SSO login");
            await ctx.awsService.login(profileName);
            publishRuntime("starting", "Checking AWS profile");
            profileStatus = await ctx.awsService.getProfileStatus(
              profileName,
            );
            if (!profileStatus.isAuthenticated) {
              throw new Error(
                profileStatus.errorMessage ||
                  t("pfIpc.ssoResultUnknown"),
              );
            }
          }

          publishRuntime("starting", "Resolving running ECS task");
          const targetId = await ctx.awsService.resolveEcsTaskTunnelTarget({
            profileName,
            region: ecsHost.awsRegion,
            clusterArn: ecsHost.awsEcsClusterArn,
            serviceName: rule.serviceName,
            containerName: rule.containerName,
          });

          publishRuntime("starting", "Starting ECS task tunnel");
          return ctx.coreManager.startSsmPortForward({
            ruleId: rule.id,
            hostId: ecsHost.id,
            profileName,
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
              : t("pfIpc.ecsTunnelStartFailed"),
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
          const profileName = resolveHostProfileName(awsHost);
          let profileStatus = await ctx.awsService.getProfileStatus(
            profileName,
          );
          if (!profileStatus.isAuthenticated) {
            if (!profileStatus.isSsoProfile) {
              throw new Error(
                profileStatus.errorMessage ||
                  t("pfIpc.cliCredentialsNeeded"),
              );
            }
            publishRuntime("starting", "Opening AWS SSO login");
            await ctx.awsService.login(profileName);
            publishRuntime("starting", "Checking AWS profile");
            profileStatus = await ctx.awsService.getProfileStatus(
              profileName,
            );
            if (!profileStatus.isAuthenticated) {
              throw new Error(
                profileStatus.errorMessage ||
                  t("pfIpc.ssoResultUnknown"),
              );
            }
          }

          publishRuntime("starting", "Checking SSM managed instance");
          const isManaged = await ctx.awsService.isManagedInstance(
            profileName,
            awsHost.awsRegion,
            awsHost.awsInstanceId,
          );
          if (!isManaged) {
            throw new Error(t("pfIpc.checkSsmAgent"));
          }

          if (awsHost.awsSsmServerProxyEnabled === true) {
            // 서버 프록시(bastion): 네이티브 SSM 포워드 대신 sync-api WS 릴레이 위로 SSH를
            // 열고 그 SSH 연결에서 -L 포워딩한다(IP 제한 VPC에서 모든 AWS 접근을 서버 IP로).
            // 릴레이가 EIC 키를 서버에서 주입하므로 임시 키를 만들어 start message에 넣는다.
            // instance-port는 인스턴스 자신의 포트(localhost), remote-host는 인스턴스에서
            // 닿는 원격 호스트로 -L 매핑한다.
            publishRuntime("starting", "Resolving SSH access via server proxy");
            const hydratedHost = await ctx.resolveAwsSftpPreflight({
              endpointId: `aws-ssm-forward:${rule.id}`,
              host: awsHost,
              allowBrowserLogin: true,
            });
            const sshPort = getAwsEc2HostSshPort(hydratedHost);
            const proxyProfileName = resolveHostProfileName(hydratedHost);
            const trustedHostKeysBase64 = ctx.requireTrustedHostKeys({
              hostname: buildAwsSsmKnownHostIdentity({
                profileName: proxyProfileName,
                region: hydratedHost.awsRegion,
                instanceId: hydratedHost.awsInstanceId,
              }),
              port: sshPort,
            });
            const sshUsername = hydratedHost.awsSshUsername?.trim();
            if (!sshUsername) {
              throw new Error(
                hydratedHost.awsSshMetadataError ||
                  t("pfIpc.sshUsernameUnknown"),
              );
            }
            const availabilityZone = hydratedHost.awsAvailabilityZone?.trim();
            if (!availabilityZone) {
              throw new Error(t("pfIpc.azUnknown"));
            }
            const targetHost =
              rule.targetKind === "remote-host"
                ? (rule.remoteHost ?? "").trim()
                : "localhost";
            if (!targetHost) {
              throw new Error(t("pfIpc.remoteHostUnknown"));
            }
            const { privateKeyPem, publicKey } =
              ctx.createEphemeralAwsSftpKeyPair();
            const startMessage = await buildAwsServerProxyStartMessage(
              ctx.awsService,
              {
                region: hydratedHost.awsRegion,
                profileName: proxyProfileName,
                instanceId: hydratedHost.awsInstanceId,
                availabilityZone,
                sshUsername,
                sshPort,
                publicKey,
              },
            );
            publishRuntime("starting", "Starting port forward via server proxy");
            const runtime = await runWithAwsServerProxyAuthRetry(
              ctx.authService,
              (accessToken) =>
                ctx.coreManager.startPortForward({
                  ruleId: rule.id,
                  hostId: awsHost.id,
                  transport: "aws-ssm",
                  host: hydratedHost.awsInstanceId,
                  port: sshPort,
                  username: sshUsername,
                  authType: "privateKey",
                  privateKeyPem,
                  trustedHostKeyBase64: trustedHostKeysBase64[0],
                  trustedHostKeysBase64,
                  mode: "local",
                  bindAddress: rule.bindAddress,
                  bindPort: rule.bindPort,
                  targetHost,
                  targetPort: rule.targetPort,
                  wsProxy: buildAwsWsProxyTarget({
                    serverUrl: ctx.authService.getServerUrl(),
                    accessToken,
                    startMessage,
                  }),
                }),
            );
            try {
              await ctx.rewriteActiveDnsOverrides();
            } catch (error) {
              await ctx.stopPortForwardWithDnsOverrideCleanup(rule.id).catch(
                () => undefined,
              );
              publishRuntime(
                "error",
                error instanceof Error
                  ? error.message
                  : t("pfIpc.hostsOverrideFailed"),
              );
              throw error;
            }
            return runtime;
          }

          publishRuntime("starting", "Starting SSM port forward");
          const runtime = await ctx.coreManager.startSsmPortForward({
            ruleId: rule.id,
            hostId: awsHost.id,
            profileName,
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
                : t("pfIpc.hostsOverrideFailed"),
            );
            throw error;
          }
          return runtime;
        } catch (error) {
          publishRuntime(
            "error",
            error instanceof Error
              ? error.message
              : t("pfIpc.ssmForwardStartFailed"),
          );
          throw error;
        }
      }

      ctx.assertSshHost(host);
      const sshHost = host as SshHostRecord;
      const trustedHostKeysBase64 = ctx.requireTrustedHostKeys(sshHost);
      const username = ctx.requireConfiguredSshUsername(sshHost);
      const { secrets, shouldPersistHostSecret } =
        await ctx.resolveRuntimeSshSecrets(sshHost);
      await ctx.ensureCertificateAuthReady(sshHost, secrets);
      const jump = await ctx.resolveJumpHostTarget(sshHost);
      const authAgentEndpoint =
        sshHost.authType === "agent" ? await resolveLocalAgentEndpoint() : null;

      const runtime = await ctx.coreManager.startPortForward({
        ruleId: rule.id,
        hostId: sshHost.id,
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
        // 셸과 같은 경로를 타야 한다. 안 넘기면 tailnet 호스트의 포워딩이 일반 네트워크로 나간다.
        ...ctx.resolveTailnetRoute(sshHost),
        authAgentEndpointKind: authAgentEndpoint?.kind,
        authAgentEndpoint: authAgentEndpoint?.endpoint,
        mode: rule.mode,
        bindAddress: rule.bindAddress,
        bindPort: rule.bindPort,
        targetHost: rule.targetHost ?? undefined,
        targetPort: rule.targetPort ?? undefined,
      });
      if (shouldPersistHostSecret) {
        await ctx.persistHostSpecificSecret(sshHost.id, sshHost.label, secrets);
      }
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
              : t("pfIpc.hostsOverrideFailed"),
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
