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
import type { AuthService } from "../../auth-service";
import {
  buildAwsServerProxyStartMessage,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from "../../aws-ws-proxy";
import type { CoreManager } from "../../core-manager";
import { resolveLocalAgentEndpoint } from "../agent-endpoint";
import { pickContainerTunnelHost, resolveContainerTunnelTarget } from "../../container-port-forward-target";
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
import { t } from '../../i18n';
import { logMessage } from "../../activity-log-message";

interface ResolvedContainersEndpoint {
  endpointId: string;
  runtime: HostContainerRuntime | null;
  runtimeCommand: string | null;
  unsupportedReason: string | null;
  hydratedHost?: AwsEc2HostRecord | null;
}

export interface ContainerRuntimeCoordinator {
  buildContainersEndpointId: (hostId: string) => string;
  buildContainerPortForwardEndpointId: (
    hostId: string,
    ruleId: string,
  ) => string;
  ensureContainersEndpoint: (
    host: SftpCompatibleHostRecord,
    endpointId?: string,
  ) => Promise<ResolvedContainersEndpoint>;
  startContainerTunnelRuntime: (input: {
    ruleId: string;
    host: SftpCompatibleHostRecord;
    containerId: string;
    /** 활동 로그 표시용 컨테이너 이름(패널이 이미 읽은 값). */
    containerName?: string | null;
    networkName: string;
    targetPort: number;
    bindAddress: string;
    bindPort: number;
    /** 패널이 이미 아는 네트워크. 있으면 코어의 검사를 건너뛴다. */
    networks?: readonly { name: string; ipAddress: string }[];
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
  authService: AuthService;
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
    authService,
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
  const pendingEndpointConnections = new Map<
    string,
    Promise<ResolvedContainersEndpoint>
  >();

  const connectContainersEndpoint = async (
    host: SftpCompatibleHostRecord,
    endpointId = buildContainersEndpointId(host.id),
  ): Promise<ResolvedContainersEndpoint> => {
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
      message: t('runtimeCoord.preparing', { label: host.label }),
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
          profileName: awsService.requireManagedProfileName(
            hydratedHost.awsProfileId,
            hydratedHost.awsProfileName,
          ),
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

      const { privateKeyPem, publicKey } =
        awsSftpCoordinator.createEphemeralAwsSftpKeyPair();

      if (hydratedHost.awsSsmServerProxyEnabled === true) {
        // 서버 프록시(bastion): sync-api가 서버(허용된) IP에서 SSM 터널을 열고 EIC 키를
        // 주입하며, ssh-core는 그 위로 WebSocket을 타고 컨테이너 런타임에 SSH로 붙는다.
        // 데스크톱은 로컬 터널도 EIC 푸시도 하지 않는다(IP 제한 VPC용). SFTP/컨테이너 셸과 동일.
        const proxyProfileName = awsService.requireManagedProfileName(
          hydratedHost.awsProfileId,
          hydratedHost.awsProfileName,
        );
        emitContainersConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "connecting-containers",
          message: t('runtimeCoord.preparingProxy'),
        });
        const startMessage = await buildAwsServerProxyStartMessage(awsService, {
          region: hydratedHost.awsRegion,
          profileName: proxyProfileName,
          instanceId: hydratedHost.awsInstanceId,
          availabilityZone,
          sshUsername,
          sshPort,
          publicKey,
        });
        try {
          const result = await runWithAwsServerProxyAuthRetry(
            authService,
            (accessToken) =>
              coreManager.containersConnect({
                endpointId,
                host: hydratedHost.awsInstanceId,
                port: sshPort,
                username: sshUsername,
                authType: "privateKey",
                privateKeyPem,
                trustedHostKeyBase64: trustedHostKeysBase64[0],
                trustedHostKeysBase64,
                hostId: hydratedHost.id,
                wsProxy: buildAwsWsProxyTarget({
                  serverUrl: authService.getServerUrl(),
                  accessToken,
                  startMessage,
                }),
              }),
          );
          if (result.runtime) {
            tunnelRegistry.trackContainersHydratedHost(endpointId, hydratedHost);
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
          throw error;
        }
      }

      await awsService.sendSshPublicKey({
        profileName: awsService.requireManagedProfileName(
          hydratedHost.awsProfileId,
          hydratedHost.awsProfileName,
        ),
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
          profileName: awsService.requireManagedProfileName(
            hydratedHost.awsProfileId,
            hydratedHost.awsProfileName,
          ),
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
          message: t('runtimeCoord.openingTunnel'),
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
      const trustedHostKeysBase64 = hostCoordinator.resolveTrustedHostKeys({
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

    const trustedHostKeysBase64 = hostCoordinator.resolveTrustedHostKeys(host);
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
      // 셸과 같은 경로를 타야 한다. 안 넘기면 tailnet 호스트의 컨테이너가 일반 네트워크로 나간다.
      ...hostCoordinator.resolveTailnetRoute(host),
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

  const ensureContainersEndpoint = async (
    host: SftpCompatibleHostRecord,
    endpointId = buildContainersEndpointId(host.id),
  ): Promise<ResolvedContainersEndpoint> => {
    const existingRuntime = coreManager.getContainersEndpointRuntime(endpointId);
    if (existingRuntime) {
      return connectContainersEndpoint(host, endpointId);
    }
    const pendingConnection = pendingEndpointConnections.get(endpointId);
    if (pendingConnection) {
      return pendingConnection;
    }
    const connection = connectContainersEndpoint(host, endpointId);
    pendingEndpointConnections.set(endpointId, connection);
    try {
      return await connection;
    } finally {
      if (pendingEndpointConnections.get(endpointId) === connection) {
        pendingEndpointConnections.delete(endpointId);
      }
    }
  };

  const startContainerTunnelRuntime = async (input: {
    ruleId: string;
    host: SftpCompatibleHostRecord;
    containerId: string;
    containerName?: string | null;
    networkName: string;
    targetPort: number;
    bindAddress: string;
    bindPort: number;
    networks?: readonly { name: string; ipAddress: string }[];
  }) => {
    const {
      ruleId,
      host,
      containerId,
      containerName,
      networkName,
      targetPort,
      bindAddress,
      bindPort,
      networks,
    } = input;
    const endpointId = buildContainerPortForwardEndpointId(host.id, ruleId);
    // 감사 로그(Recent Activity)에 ruleId(UUID) 대신 보여 줄 라벨.
    //
    // **첫 발행 전에 세운다.** 아래 publishRuntime 은 이 변수를 클로저로 읽는데, inspect 뒤로
    // 미루면 그 앞의 "starting" 과 런타임 점검 실패(도커가 없거나 sudo 가 필요한 호스트)가
    // 라벨 없이 나가고, 그 실패 기록은 갱신될 기회가 없어 UUID 로 남는다 — 이 라벨이 없애려던
    // 바로 그 화면이다. 패널이 이름을 줬으면 그것으로 시작하고, 못 줬으면 inspect 로 알아낸
    // 이름과 실제 포트로 아래에서 다듬는다.
    let tunnelContainerName = containerName?.trim() || undefined;
    let tunnelLabel = tunnelContainerName
      ? `${tunnelContainerName}:${targetPort}`
      : undefined;
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
        label: tunnelLabel,
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
            t('containersIpc.runtimeCheckFailed'),
        );
      }

      // 패널이 이미 알아낸 네트워크가 있으면 그것으로 정한다 — 코어가 도커에 다시 묻지 않는다.
      // sudo 가 필요한 호스트에서는 이 길만 통한다: 패널은 그 세션의 sudo 로 읽지만 코어의
      // 컨테이너 연결은 같은 비밀번호를 갖고 있지 않다.
      const supplied =
        networks && networks.length > 0
          ? pickContainerTunnelHost(networks, networkName)
          : null;
      let targetHost: string;
      let resolvedTargetPort = targetPort;
      if (supplied) {
        targetHost = supplied.host;
      } else {
        publishRuntime("starting", "Inspecting container");
        const details = await coreManager.containersInspect(
          runtimeInfo.endpointId,
          containerId,
        );
        const normalizedStatus = details.status.trim().toLowerCase();
        if (normalizedStatus !== "running") {
          throw new Error(
            t('runtimeCoord.notRunning', { name: details.name, status: details.status }),
          );
        }

        const target = resolveContainerTunnelTarget(details, networkName, targetPort);
        targetHost = target.host;
        resolvedTargetPort = target.port;
        tunnelContainerName =
          tunnelContainerName || details.name.trim() || undefined;
      }
      // "이름:포트"라 같은 컨테이너의 여러 터널도 구분된다. 이름을 모르면 라벨을
      // 두지 않아 로거가 종전 폴백(ruleId)을 따른다.
      tunnelLabel = tunnelContainerName
        ? `${tunnelContainerName}:${resolvedTargetPort}`
        : undefined;

      if (host.kind === "aws-ec2") {
        tunnelRegistry.moveContainersTunnelRuntime(endpointId, ruleId);
        publishRuntime("starting", "Starting container tunnel");
        return await coreManager.startPortForward({
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
        return await coreManager.startPortForward({
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
      // **await 없이 돌려주면 안 된다.** try/finally 에서 `return promise` 는 finally 를
      // 곧바로 실행한다 — 그 finally 가 컨테이너 엔드포인트를 끊어 버려서, 코어가 그 연결을
      // 가져가려는 순간(sourceEndpointId → TakeClient) 이미 사라진 상태가 됐다. 실기기에서
      // "containers endpoint … not found" 로 터진 원인이다. 끝난 뒤에 정리해야 한다.
      return await coreManager.startPortForward({
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
          : t('runtimeCoord.tunnelStartFailed'),
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
