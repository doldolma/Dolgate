import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
  isWarpgateSshHostRecord,
} from "@shared";
import type {
  HostContainerRuntime,
  ResolvedJumpHost,
  SshHostRecord,
} from "@shared";
import type { AwsSsmTunnelService } from "../../aws-ssm-tunnel-service";
import type { AwsService } from "../../aws-service";
import type { CoreManager } from "../../core-manager";
import { resolveLocalAgentEndpoint } from "../agent-endpoint";
import { resolveContainerTunnelTarget } from "../../container-port-forward-target";
import type { KnownHostRepository } from "../../database";
import type { AwsSftpCoordinator } from "./aws-sftp-coordinator";
import { retryAwsSsmSshOperation } from "./aws-ssm-ssh-retry";
import type { HostCoordinator } from "./host-coordinator";
import type { SecretCoordinator } from "./secret-coordinator";
import type { TunnelRegistry } from "./tunnel-registry";
import type {
  AwsConnectionProgressEmitter,
  AwsEc2HostRecord,
  SftpCompatibleHostRecord,
} from "../context";

export interface ContainerRuntimeCoordinator {
  buildContainersEndpointId: (hostId: string) => string;
  buildContainerPortForwardEndpointId: (
    hostId: string,
    ruleId: string,
  ) => string;
  ensureContainersEndpoint: (
    host: SftpCompatibleHostRecord,
    endpointId?: string,
  ) => Promise<{
    endpointId: string;
    runtime: HostContainerRuntime | null;
    runtimeCommand: string | null;
    unsupportedReason: string | null;
    hydratedHost?: AwsEc2HostRecord | null;
  }>;
  startContainerTunnelRuntime: (input: {
    ruleId: string;
    host: SftpCompatibleHostRecord;
    containerId: string;
    networkName: string;
    targetPort: number;
    bindAddress: string;
    bindPort: number;
  }) => Promise<unknown>;
  buildContainerShellCommand: (
    runtimeCommand: string,
    containerId: string,
  ) => string;
}

export function createContainerRuntimeCoordinator(deps: {
  coreManager: CoreManager;
  knownHosts: KnownHostRepository;
  awsService: AwsService;
  awsSsmTunnelService: AwsSsmTunnelService;
  awsSftpCoordinator: AwsSftpCoordinator;
  tunnelRegistry: TunnelRegistry;
  secretCoordinator: SecretCoordinator;
  hostCoordinator: HostCoordinator;
  resolveJumpHostTarget: (
    host: SshHostRecord,
  ) => Promise<ResolvedJumpHost | undefined>;
  emitContainersConnectionProgress: AwsConnectionProgressEmitter;
}): ContainerRuntimeCoordinator {
  const {
    coreManager,
    knownHosts,
    awsService,
    awsSsmTunnelService,
    awsSftpCoordinator,
    tunnelRegistry,
    secretCoordinator,
    hostCoordinator,
    resolveJumpHostTarget,
    emitContainersConnectionProgress,
  } = deps;

  const quotePosix = (value: string): string =>
    `'${value.replace(/'/g, `'\"'\"'`)}'`;

  const buildContainerShellCommand = (
    runtimeCommand: string,
    containerId: string,
  ): string => {
    const quotedContainerId = quotePosix(containerId);
    const quotedRuntimeCommand = quotePosix(runtimeCommand);
    const shellCommand = `${quotedRuntimeCommand} exec -it ${quotedContainerId} /bin/sh || ${quotedRuntimeCommand} exec -it ${quotedContainerId} /bin/bash`;
    return `sh -lc ${quotePosix(shellCommand)}`;
  };

  const buildContainersEndpointId = (hostId: string) => `containers:${hostId}`;
  const buildContainerPortForwardEndpointId = (hostId: string, ruleId: string) =>
    `containers:${hostId}:forward:${ruleId}`;

  const ensureContainersEndpoint = async (
    host: SftpCompatibleHostRecord,
    endpointId = buildContainersEndpointId(host.id),
  ): Promise<{
    endpointId: string;
    runtime: HostContainerRuntime | null;
    runtimeCommand: string | null;
    unsupportedReason: string | null;
    hydratedHost?: AwsEc2HostRecord | null;
  }> => {
    const existingRuntime =
      coreManager.getContainersEndpointRuntime(endpointId);
    if (existingRuntime) {
      return {
        endpointId,
        runtime: existingRuntime.runtime,
        runtimeCommand: existingRuntime.runtimeCommand,
        unsupportedReason: existingRuntime.unsupportedReason,
        hydratedHost: isAwsEc2HostRecord(host)
          ? tunnelRegistry.getContainersHydratedHost(endpointId)
          : null,
      };
    }

    emitContainersConnectionProgress({
      endpointId,
      hostId: host.id,
      stage: "connecting-containers",
      message: `${host.label} 컨테이너 런타임 연결을 준비하는 중입니다.`,
    });

    if (isAwsEc2HostRecord(host)) {
      const hydratedHost =
        awsSftpCoordinator.consumePreflight(endpointId, host.id) ??
        (await awsSftpCoordinator.resolvePreflight({
          endpointId,
          host,
          allowBrowserLogin: true,
          emitProgress: emitContainersConnectionProgress,
        }));
      const sshPort = getAwsEc2HostSshPort(hydratedHost);
      const trustedHostKeysBase64 = hostCoordinator.requireTrustedHostKeys({
        hostname: buildAwsSsmKnownHostIdentity({
          profileName:
            awsService.resolveManagedProfileNameOrFallback(
              hydratedHost.awsProfileId,
              hydratedHost.awsProfileName,
            ) ?? hydratedHost.awsProfileName,
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

      const { privateKeyPem, publicKey } =
        awsSftpCoordinator.createEphemeralAwsSftpKeyPair();
      await awsService.sendSshPublicKey({
        profileName:
          awsService.resolveManagedProfileNameOrFallback(
            hydratedHost.awsProfileId,
            hydratedHost.awsProfileName,
          ) ?? hydratedHost.awsProfileName,
        region: hydratedHost.awsRegion,
        instanceId: hydratedHost.awsInstanceId,
        availabilityZone,
        osUser: sshUsername,
        publicKey,
      });
      const bindPort = await awsSftpCoordinator.reserveLoopbackPort();
      let runtimeId = "";
      try {
        const tunnel = await awsSsmTunnelService.start({
          runtimeId: `aws-containers:${endpointId}`,
          profileName:
            awsService.resolveManagedProfileNameOrFallback(
              hydratedHost.awsProfileId,
              hydratedHost.awsProfileName,
            ) ?? hydratedHost.awsProfileName,
          region: hydratedHost.awsRegion,
          instanceId: hydratedHost.awsInstanceId,
          bindAddress: "127.0.0.1",
          bindPort,
          targetPort: sshPort,
        });
        runtimeId = tunnel.runtimeId;
        emitContainersConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "opening-tunnel",
          message: "컨테이너 런타임 확인을 위한 내부 터널을 여는 중입니다.",
        });
        const result = await retryAwsSsmSshOperation(() =>
          coreManager.containersConnect({
            endpointId,
            host: tunnel.bindAddress,
            port: tunnel.bindPort,
            username: sshUsername,
            authType: "privateKey",
            privateKeyPem,
            trustedHostKeyBase64: trustedHostKeysBase64[0],
            trustedHostKeysBase64,
            hostId: hydratedHost.id,
          }),
        );
        if (result.runtime) {
          tunnelRegistry.trackContainersTunnelRuntime(
            endpointId,
            tunnel.runtimeId,
            hydratedHost,
          );
        } else {
          await awsSsmTunnelService
            .stop(tunnel.runtimeId)
            .catch(() => undefined);
        }
        return {
          endpointId,
          runtime: result.runtime,
          runtimeCommand: result.runtimeCommand,
          unsupportedReason: result.unsupportedReason,
          hydratedHost,
        };
      } catch (error) {
        awsSftpCoordinator.clearPreflight(endpointId);
        if (runtimeId) {
          await awsSsmTunnelService.stop(runtimeId).catch(() => undefined);
        }
        throw error;
      }
    }

    if (isWarpgateSshHostRecord(host)) {
      const trustedHostKeysBase64 = hostCoordinator.requireTrustedHostKeys({
        hostname: host.warpgateSshHost,
        port: host.warpgateSshPort,
      });
      const result = await coreManager.containersConnect({
        endpointId,
        host: host.warpgateSshHost,
        port: host.warpgateSshPort,
        username: `${host.warpgateUsername}:${host.warpgateTargetName}`,
        authType: "keyboardInteractive",
        trustedHostKeyBase64: trustedHostKeysBase64[0],
        trustedHostKeysBase64,
        hostId: host.id,
      });
      return {
        endpointId,
        runtime: result.runtime,
        runtimeCommand: result.runtimeCommand,
        unsupportedReason: result.unsupportedReason,
        hydratedHost: null,
      };
    }

    const trustedHostKeysBase64 = hostCoordinator.requireTrustedHostKeys(host);
    const username = hostCoordinator.requireConfiguredSshUsername(host);
    const { secrets, shouldPersistHostSecret } =
      await secretCoordinator.resolveRuntimeSshSecrets(host);
    const jump = await resolveJumpHostTarget(host);
    const authAgentEndpoint =
      host.authType === "agent" ? await resolveLocalAgentEndpoint() : null;
    const result = await coreManager.containersConnect({
      endpointId,
      host: host.hostname,
      port: host.port,
      username,
      authType: host.authType,
      password: secrets.password,
      privateKeyPem: secrets.privateKeyPem,
      certificateText: secrets.certificateText,
      passphrase: secrets.passphrase,
      trustedHostKeyBase64: trustedHostKeysBase64[0],
      trustedHostKeysBase64,
      jump,
      authAgentEndpointKind: authAgentEndpoint?.kind,
      authAgentEndpoint: authAgentEndpoint?.endpoint,
      hostId: host.id,
    });
    if (shouldPersistHostSecret) {
      await secretCoordinator.persistHostSpecificSecret(host.id, host.label, secrets);
    }
    return {
      endpointId,
      runtime: result.runtime,
      runtimeCommand: result.runtimeCommand,
      unsupportedReason: result.unsupportedReason,
      hydratedHost: null,
    };
  };

  const startContainerTunnelRuntime = async (input: {
    ruleId: string;
    host: SftpCompatibleHostRecord;
    containerId: string;
    networkName: string;
    targetPort: number;
    bindAddress: string;
    bindPort: number;
  }) => {
    const {
      ruleId,
      host,
      containerId,
      networkName,
      targetPort,
      bindAddress,
      bindPort,
    } = input;
    const endpointId = buildContainerPortForwardEndpointId(host.id, ruleId);
    const publishRuntime = (status: "starting" | "error", message?: string) =>
      coreManager.setPortForwardRuntime({
        ruleId,
        hostId: host.id,
        transport: "container",
        mode: "local",
        bindAddress,
        bindPort,
        status,
        updatedAt: new Date().toISOString(),
        message,
        startedAt:
          status === "starting"
            ? coreManager
                .listPortForwardRuntimes()
                .find((runtime) => runtime.ruleId === ruleId)?.startedAt
            : undefined,
      });

    const cleanupTemporaryEndpoint = async () => {
      await coreManager.containersDisconnect(endpointId).catch(() => undefined);
      await tunnelRegistry.stopContainersTunnelForEndpoint(endpointId);
    };

    try {
      publishRuntime("starting", "Checking container runtime");
      const runtimeInfo = await ensureContainersEndpoint(host, endpointId);
      if (!runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "docker/podman 런타임을 확인하지 못했습니다.",
        );
      }

      publishRuntime("starting", "Inspecting container");
      const details = await coreManager.containersInspect(
        runtimeInfo.endpointId,
        containerId,
      );
      const normalizedStatus = details.status.trim().toLowerCase();
      if (normalizedStatus !== "running") {
        throw new Error(
          `${details.name} 컨테이너가 실행 중이 아닙니다. 현재 상태: ${details.status}`,
        );
      }

      const target = resolveContainerTunnelTarget(
        details,
        networkName,
        targetPort,
      );
      const targetHost = target.host;
      const resolvedTargetPort = target.port;

      if (host.kind === "aws-ec2") {
        tunnelRegistry.moveContainersTunnelRuntime(endpointId, ruleId);
        publishRuntime("starting", "Starting container tunnel");
        return coreManager.startPortForward({
          ruleId,
          hostId: host.id,
          host: "",
          port: 0,
          username: "",
          authType: "password",
          trustedHostKeyBase64: "",
          bindAddress,
          bindPort,
          mode: "local",
          targetHost,
          targetPort: resolvedTargetPort,
          transport: "container",
          sourceEndpointId: endpointId,
        });
      }

      if (host.kind === "warpgate-ssh") {
        publishRuntime("starting", "Starting container tunnel");
        return coreManager.startPortForward({
          ruleId,
          hostId: host.id,
          host: host.warpgateSshHost,
          port: host.warpgateSshPort,
          username: `${host.warpgateUsername}:${host.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64: "",
          mode: "local",
          bindAddress,
          bindPort,
          targetHost,
          targetPort: resolvedTargetPort,
          transport: "container",
          sourceEndpointId: endpointId,
        });
      }

      publishRuntime("starting", "Starting container tunnel");
      const username = hostCoordinator.requireConfiguredSshUsername(host);
      return coreManager.startPortForward({
        ruleId,
        hostId: host.id,
        host: host.hostname,
        port: host.port,
        username,
        authType: host.authType,
        trustedHostKeyBase64: "",
        mode: "local",
        bindAddress,
        bindPort,
        targetHost,
        targetPort: resolvedTargetPort,
        transport: "container",
        sourceEndpointId: endpointId,
      });
    } catch (error) {
      await tunnelRegistry.stopContainersTunnelForEndpoint(ruleId);
      publishRuntime(
        "error",
        error instanceof Error
          ? error.message
          : "Container tunnel을 시작하지 못했습니다.",
      );
      throw error;
    } finally {
      await cleanupTemporaryEndpoint();
    }
  };

  return {
    buildContainersEndpointId,
    buildContainerPortForwardEndpointId,
    ensureContainersEndpoint,
    startContainerTunnelRuntime,
    buildContainerShellCommand,
  };
}
