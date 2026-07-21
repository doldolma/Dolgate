import { randomUUID } from "node:crypto";
import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  getAwsSftpDiagnosticMessage,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  normalizeJumpHostIds,
} from "@shared";
import type {
  AwsSftpDiagnosticDetails,
  AwsSftpDiagnosticReasonCode,
  HostDraft,
  HostKeyProbeResult,
  HostSecretInput,
  KnownHostProbeInput,
  ResolvedJumpHost,
  SshCertificateInfo,
} from "@shared";
import type { AwsService } from "../../aws-service";
import type { AuthService } from "../../auth-service";
import {
  buildAwsServerProxyStartMessage,
  buildAwsWsProxyTarget,
  runWithAwsServerProxyAuthRetry,
} from "../../aws-ws-proxy";
import type { AwsSsmTunnelService } from "../../aws-ssm-tunnel-service";
import type { CoreManager } from "../../core-manager";
import type { HostRepository, KnownHostRepository } from "../../database";
import type { AwsSftpCoordinator } from "./aws-sftp-coordinator";
import {
  isTransientAwsSsmSshError,
  retryAwsSsmSshOperation,
} from "./aws-ssm-ssh-retry";
import type {
  AwsConnectionProgressEmitter,
  AwsEc2HostRecord,
  AwsEcsHostRecord,
  AwsSftpProgressStage,
  SftpCompatibleHostRecord,
  SshHostRecord,
} from "../context";

export interface HostCoordinator {
  requireTrustedHostKey: (host: { hostname: string; port: number }) => string;
  requireTrustedHostKeys: (host: { hostname: string; port: number }) => string[];
  requireConfiguredSshUsername: (host: SshHostRecord) => string;
  buildKnownSshDuplicateKeys: () => Set<string>;
  assertSshHost: (host: ReturnType<HostRepository["getById"]>) => void;
  assertSftpCompatibleHost: (
    host: ReturnType<HostRepository["getById"]>,
  ) => void;
  assertAwsEc2Host: (host: ReturnType<HostRepository["getById"]>) => void;
  assertAwsEcsHost: (host: ReturnType<HostRepository["getById"]>) => void;
  describeHostLabel: (host: HostDraft | SftpCompatibleHostRecord | AwsEcsHostRecord) => string;
  describeHostTarget: (
    host: HostDraft | ReturnType<HostRepository["getById"]>,
  ) => string | null;
  buildHostKeyProbeResult: (
    emitProgress: AwsConnectionProgressEmitter,
    input: KnownHostProbeInput,
    jump?: ResolvedJumpHost,
  ) => Promise<HostKeyProbeResult>;
  resolveJumpHostTarget: (
    host: SshHostRecord,
  ) => Promise<ResolvedJumpHost | undefined>;
}

export function createHostCoordinator(deps: {
  hosts: HostRepository;
  knownHosts: KnownHostRepository;
  coreManager: CoreManager;
  awsService: AwsService;
  authService: AuthService;
  awsSsmTunnelService: AwsSsmTunnelService;
  awsSftpCoordinator: AwsSftpCoordinator;
  resolveRuntimeSshSecrets: (
    host: SshHostRecord,
    secrets?: HostSecretInput,
  ) => Promise<{ secrets: HostSecretInput; shouldPersistHostSecret: boolean }>;
  ensureCertificateAuthReady: (
    host: SshHostRecord,
    secrets: HostSecretInput,
  ) => Promise<SshCertificateInfo | null>;
}): HostCoordinator {
  const {
    hosts,
    knownHosts,
    coreManager,
    awsService,
    authService,
    awsSsmTunnelService,
    awsSftpCoordinator,
    resolveRuntimeSshSecrets,
    ensureCertificateAuthReady,
  } = deps;

  const requireTrustedHostKeys = (host: {
    hostname: string;
    port: number;
  }): string[] => {
    const trusted = knownHosts.listByHostPort(host.hostname, host.port);
    if (trusted.length === 0) {
      throw new Error("Host key is not trusted yet.");
    }
    knownHosts.touch(host.hostname, host.port);
    return trusted.map((record) => record.publicKeyBase64);
  };

  const requireConfiguredSshUsername = (host: SshHostRecord): string => {
    const username = host.username.trim();
    if (!username) {
      throw new Error("사용자명이 필요합니다.");
    }
    return username;
  };

  const assertSshHost = (
    host: ReturnType<HostRepository["getById"]>,
  ): asserts host is SshHostRecord => {
    if (!host) {
      throw new Error("Host not found");
    }
    if (!isSshHostRecord(host)) {
      throw new Error("이 기능은 SSH host에서만 사용할 수 있습니다.");
    }
  };

  const assertSftpCompatibleHost = (
    host: ReturnType<HostRepository["getById"]>,
  ): asserts host is SftpCompatibleHostRecord => {
    if (!host) {
      throw new Error("Host not found");
    }
    if (
      !isSshHostRecord(host) &&
      !isWarpgateSshHostRecord(host) &&
      !isAwsEc2HostRecord(host)
    ) {
      throw new Error(
        "이 기능은 SSH, AWS, Warpgate host에서만 사용할 수 있습니다.",
      );
    }
  };

  const assertAwsEc2Host = (
    host: ReturnType<HostRepository["getById"]>,
  ): asserts host is AwsEc2HostRecord => {
    if (!host) {
      throw new Error("Host not found");
    }
    if (!isAwsEc2HostRecord(host)) {
      throw new Error("이 기능은 AWS host에서만 사용할 수 있습니다.");
    }
  };

  const assertAwsEcsHost = (
    host: ReturnType<HostRepository["getById"]>,
  ): asserts host is AwsEcsHostRecord => {
    if (!host) {
      throw new Error("Host not found");
    }
    if (!isAwsEcsHostRecord(host)) {
      throw new Error("이 기능은 AWS ECS host에서만 사용할 수 있습니다.");
    }
  };

  const describeHostLabel = (
    host: HostDraft | SftpCompatibleHostRecord | AwsEcsHostRecord,
  ): string => {
    if (host.kind === "aws-ec2") {
      return host.label || host.awsInstanceName || host.awsInstanceId;
    }
    if (host.kind === "aws-ecs") {
      return host.label || host.awsEcsClusterName || host.awsEcsClusterArn;
    }
    if (host.kind === "warpgate-ssh") {
      return host.label || `${host.warpgateUsername}:${host.warpgateTargetName}`;
    }
    if (host.kind === "serial") {
      if (host.transport === "local") {
        return host.label || host.devicePath?.trim() || "Serial";
      }
      const targetHost = host.host?.trim() || "";
      const targetPort =
        typeof host.port === "number" && Number.isFinite(host.port)
          ? `:${host.port}`
          : "";
      return host.label || `${host.transport} ${targetHost}${targetPort}`.trim();
    }
    return host.label ||
      (host.username.trim() ? `${host.username}@${host.hostname}` : host.hostname);
  };

  const describeHostTarget = (
    host: HostDraft | ReturnType<HostRepository["getById"]>,
  ): string | null => {
    if (!host) {
      return null;
    }
    if (host.kind === "ssh") {
      return host.hostname;
    }
    if (host.kind === "aws-ec2") {
      return host.awsInstanceId;
    }
    if (host.kind === "aws-ecs") {
      return host.awsEcsClusterArn;
    }
    if (host.kind === "serial") {
      if (host.transport === "local") {
        return host.devicePath?.trim() || null;
      }
      const targetHost = host.host?.trim() || "";
      const targetPort =
        typeof host.port === "number" && Number.isFinite(host.port)
          ? `:${host.port}`
          : "";
      return `${host.transport} ${targetHost}${targetPort}`.trim() || null;
    }
    return host.warpgateTargetId;
  };

  const buildKnownSshDuplicateKeys = (): Set<string> =>
    new Set(
      hosts
        .list()
        .filter(isSshHostRecord)
        .map((host) => `${host.hostname}\u0000${host.port}\u0000${host.username}`),
    );

  const buildHostKeyProbeResult = async (
    emitConnectionProgress: AwsConnectionProgressEmitter,
    input: KnownHostProbeInput,
    // 점프(베스천) 호스트가 해석돼 넘어오면 그 경유로 타깃 키를 읽는다. 베스천 뒤의
    // 직접 닿지 않는 타깃도 지문을 확인/신뢰할 수 있게 한다(SSH 호스트에만 해당).
    jump?: ResolvedJumpHost,
  ): Promise<HostKeyProbeResult> => {
    const host = hosts.getById(input.hostId);
    if (!host) {
      throw new Error("Host not found");
    }
    if (isAwsEcsHostRecord(host)) {
      throw new Error("ECS 호스트는 SSH 호스트 키 확인을 지원하지 않습니다.");
    }

    if (isAwsEc2HostRecord(host)) {
      const endpointId = input.endpointId?.trim() || "";
      const emitStage = (
        stage: "opening-tunnel" | "probing-host-key",
        message: string,
        hostId: string,
      ) => {
        if (!endpointId) {
          return;
        }
        emitConnectionProgress({
          endpointId,
          hostId,
          stage,
          message,
        });
      };
      let currentStage:
        | "checking-profile"
        | "browser-login"
        | "checking-ssm"
        | "loading-instance-metadata"
        | "opening-tunnel"
        | "probing-host-key" = "checking-profile";
      try {
        const hydratedHost = await awsSftpCoordinator.resolvePreflight({
          endpointId,
          host,
          allowBrowserLogin: true,
          emitProgress: emitConnectionProgress,
        });

        const resolvedProfileName = awsService.requireManagedProfileName(
          hydratedHost.awsProfileId,
          hydratedHost.awsProfileName,
        );
        const knownHostPort = getAwsEc2HostSshPort(hydratedHost);

        let probed: HostKeyProbeResult;
        if (hydratedHost.awsSsmServerProxyEnabled === true) {
          // 서버 프록시(bastion): 직접 SSM 터널 대신 sync-api WS 릴레이 경유로 호스트 키를
          // 읽는다. 릴레이 start message는 EIC 주입에 sshUsername/AZ/공개키가 필요하므로
          // (probe는 인증하지 않지만 릴레이가 터널을 열려면 필요) 임시 키를 만들어 넣는다.
          const sshUsername = hydratedHost.awsSshUsername?.trim();
          if (!sshUsername) {
            throw new Error(
              hydratedHost.awsSshMetadataError ||
                "자동으로 SSH 사용자명을 확인하지 못했습니다.",
            );
          }
          const availabilityZone = hydratedHost.awsAvailabilityZone?.trim();
          if (!availabilityZone) {
            throw new Error("Availability Zone을 확인하지 못했습니다.");
          }
          const { publicKey } = awsSftpCoordinator.createEphemeralAwsSftpKeyPair();
          const startMessage = await buildAwsServerProxyStartMessage(awsService, {
            region: hydratedHost.awsRegion,
            profileName: resolvedProfileName,
            instanceId: hydratedHost.awsInstanceId,
            availabilityZone,
            sshUsername,
            sshPort: knownHostPort,
            publicKey,
          });
          currentStage = "probing-host-key";
          emitStage(
            "probing-host-key",
            "서버 프록시로 SSH 호스트 키를 확인하는 중입니다.",
            hydratedHost.id,
          );
          probed = await retryAwsSsmSshOperation(() =>
            runWithAwsServerProxyAuthRetry(authService, (accessToken) =>
              coreManager.probeHostKey({
                host: hydratedHost.awsInstanceId,
                port: knownHostPort,
                wsProxy: buildAwsWsProxyTarget({
                  serverUrl: authService.getServerUrl(),
                  accessToken,
                  startMessage,
                }),
              }),
            ),
          );
        } else {
          currentStage = "opening-tunnel";
          emitStage(
            "opening-tunnel",
            "SSH 호스트 키 확인을 위한 내부 터널을 여는 중입니다.",
            hydratedHost.id,
          );
          const bindPort = await awsSftpCoordinator.reserveLoopbackPort();
          const tunnel = await awsSsmTunnelService.start({
            runtimeId: `aws-sftp-probe:${endpointId || host.id}:${randomUUID()}`,
            profileName: resolvedProfileName,
            region: hydratedHost.awsRegion,
            instanceId: hydratedHost.awsInstanceId,
            bindAddress: "127.0.0.1",
            bindPort,
            targetPort: knownHostPort,
          });
          try {
            currentStage = "probing-host-key";
            emitStage(
              "probing-host-key",
              "SSH 호스트 키를 확인하는 중입니다.",
              hydratedHost.id,
            );
            probed = await retryAwsSsmSshOperation(() =>
              coreManager.probeHostKey({
                host: tunnel.bindAddress,
                port: tunnel.bindPort,
              }),
            );
          } finally {
            await awsSsmTunnelService.stop(tunnel.runtimeId).catch(() => undefined);
          }
        }

        const knownHost = buildAwsSsmKnownHostIdentity({
          profileName: resolvedProfileName,
          region: hydratedHost.awsRegion,
          instanceId: hydratedHost.awsInstanceId,
        });
        const existing = knownHosts.getByHostPortAlgorithm(
          knownHost,
          knownHostPort,
          probed.algorithm,
        );
        const status = !existing
          ? "untrusted"
          : existing.publicKeyBase64 === probed.publicKeyBase64
            ? "trusted"
            : "mismatch";

        if (status === "trusted") {
          knownHosts.touch(knownHost, knownHostPort, probed.algorithm);
        }
        if (endpointId) {
          awsSftpCoordinator.storePreflight(endpointId, hydratedHost);
        }

        return {
          hostId: hydratedHost.id,
          hostLabel: hydratedHost.label,
          host: knownHost,
          port: knownHostPort,
          targetDescription: `AWS SSM · ${hydratedHost.awsInstanceId}`,
          algorithm: probed.algorithm,
          publicKeyBase64: probed.publicKeyBase64,
          fingerprintSha256: probed.fingerprintSha256,
          status,
          existing,
        };
      } catch (error) {
        if (error instanceof Error && /^\[/.test(error.message)) {
          throw error;
        }
        const formatted = awsSftpCoordinator.formatSftpStageError(
          currentStage as AwsSftpProgressStage,
          error,
          {
            reasonCode:
              currentStage === "probing-host-key" &&
              isTransientAwsSsmSshError(error)
                ? "tunnel-open-failed"
                : currentStage === "opening-tunnel"
                  ? "tunnel-open-failed"
                  : undefined,
            details: awsSftpCoordinator.buildDiagnosticDetails(host),
          },
        );
        const diagnostic = (formatted as Error & {
          awsSftpDiagnostic?: {
            reasonCode?: AwsSftpDiagnosticReasonCode;
            diagnosticId?: string;
            details?: AwsSftpDiagnosticDetails;
          };
        }).awsSftpDiagnostic;
        if (endpointId) {
          emitConnectionProgress({
            endpointId,
            hostId: host.id,
            stage: currentStage,
            message: getAwsSftpDiagnosticMessage(diagnostic?.reasonCode),
            reasonCode: diagnostic?.reasonCode ?? "unknown",
            diagnosticId: diagnostic?.diagnosticId,
            details: diagnostic?.details,
          });
        }
        throw formatted;
      }
    }

    const probeHost = isWarpgateSshHostRecord(host)
      ? host.warpgateSshHost
      : isSshHostRecord(host)
        ? host.hostname
        : (() => {
            throw new Error(
              "이 기능은 SSH, AWS, Warpgate host에서만 사용할 수 있습니다.",
            );
          })();
    const probePort = isWarpgateSshHostRecord(host)
      ? host.warpgateSshPort
      : isSshHostRecord(host)
        ? host.port
        : (() => {
            throw new Error(
              "이 기능은 SSH, AWS, Warpgate host에서만 사용할 수 있습니다.",
            );
          })();

    // 다단 ProxyJump에선 하나의 베스천에 probe·터널·실연결이 짧은 시간에 몰려, 서버측
    // MaxStartups류 pre-auth 커넥션 제한에 걸려 리셋/EOF/핸드셰이크 실패가 날 수 있다.
    // 일시적 오류는 짧게 재시도한다(인증 실패·호스트 키 불일치 등 확정 오류는
    // isTransientAwsSsmSshError가 걸러 즉시 실패). AWS SSM 경로와 동일한 재시도 헬퍼 재사용.
    const probed = await retryAwsSsmSshOperation(() =>
      coreManager.probeHostKey({
        host: probeHost,
        port: probePort,
        // 점프는 SSH 호스트 타깃에만 적용된다(warpgate/aws는 jump 미전달).
        jump: isSshHostRecord(host) ? jump : undefined,
        // 프로브 홉 진행을 활성 오버레이에 매핑하기 위한 상관 ID(renderer가 넘긴 값 그대로).
        sessionId: input.sessionId ?? undefined,
        endpointId: input.endpointId ?? undefined,
      }),
    );
    const existing = knownHosts.getByHostPortAlgorithm(
      probeHost,
      probePort,
      probed.algorithm,
    );
    const status = !existing
      ? "untrusted"
      : existing.publicKeyBase64 === probed.publicKeyBase64
        ? "trusted"
        : "mismatch";

    if (status === "trusted") {
      knownHosts.touch(probeHost, probePort, probed.algorithm);
    }

    return {
      hostId: host.id,
      hostLabel: host.label,
      host: probeHost,
      port: probePort,
      targetDescription: null,
      algorithm: probed.algorithm,
      publicKeyBase64: probed.publicKeyBase64,
      fingerprintSha256: probed.fingerprintSha256,
      status,
      existing,
    };
  };

  // 점프(베스천) 호스트를 가리키는 SSH 호스트의 연결/probe 직전에, 그 점프 호스트의
  // 자격증명·신뢰키·인증서를 타깃과 동일한 헬퍼로 해석해 ResolvedJumpHost로 만든다.
  // (점프는 저장된 일반 SSH 호스트만 허용 → 기존 해석 경로를 그대로 재사용.)
  // jumpHostIds 체인(다단 ProxyJump)을 중첩 ResolvedJumpHost로 빌드한다. chain=[J1…Jn]에서
  // J1이 첫 홉(클라이언트에서 직접 연결), Jn이 타깃 바로 앞. DialClient는 가장 깊은 .jump부터
  // 직접 연결하므로 J1을 innermost로 두고 Jn까지 바깥으로 감싼다. 각 점프 호스트 자신의
  // jumpHostIds는 따르지 않는다(타깃의 체인이 권위 — 점프 호스트가 공유돼도 부작용 없음).
  const resolveJumpHostTarget = async (
    host: SshHostRecord,
  ): Promise<ResolvedJumpHost | undefined> => {
    const chain = normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId);
    if (chain.length === 0) {
      return undefined;
    }
    const maxChain = 8; // ProxyJump 다단 깊이 상한(안전장치)
    if (chain.length > maxChain) {
      throw new Error(`점프 호스트는 최대 ${maxChain}단까지 설정할 수 있습니다.`);
    }
    if (chain.includes(host.id)) {
      throw new Error("점프 호스트 체인에 자기 자신을 포함할 수 없습니다.");
    }

    let resolved: ResolvedJumpHost | undefined;
    for (const jumpHostId of chain) {
      const jumpHost = hosts.getById(jumpHostId);
      if (!jumpHost) {
        throw new Error(
          "점프 호스트를 찾을 수 없습니다. 호스트 설정에서 점프 호스트를 다시 선택해 주세요.",
        );
      }
      if (!isSshHostRecord(jumpHost)) {
        throw new Error("점프 호스트는 일반 SSH 호스트여야 합니다.");
      }
      const trustedHostKeysBase64 = requireTrustedHostKeys(jumpHost);
      const username = requireConfiguredSshUsername(jumpHost);
      const { secrets } = await resolveRuntimeSshSecrets(jumpHost);
      await ensureCertificateAuthReady(jumpHost, secrets);
      resolved = {
        host: jumpHost.hostname,
        port: jumpHost.port,
        username,
        authType: jumpHost.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        certificateText: secrets.certificateText,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64: trustedHostKeysBase64[0],
        trustedHostKeysBase64,
        jump: resolved,
      };
    }
    return resolved;
  };

  return {
    requireTrustedHostKey: (host) => requireTrustedHostKeys(host)[0],
    requireTrustedHostKeys,
    requireConfiguredSshUsername,
    buildKnownSshDuplicateKeys,
    assertSshHost,
    assertSftpCompatibleHost,
    assertAwsEc2Host,
    assertAwsEcsHost,
    describeHostLabel,
    describeHostTarget,
    buildHostKeyProbeResult,
    resolveJumpHostTarget,
  };
}
