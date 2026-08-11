import { randomUUID } from "node:crypto";
import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
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
import type {
  HostRepository,
  KnownHostRepository,
  TailnetRepository,
} from "../../database";
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
import { t } from "../../i18n";
import { getAwsSftpDiagnosticMessage } from "../../../common/aws-diagnostics";

export interface HostCoordinator {
  requireTrustedHostKey: (host: { hostname: string; port: number }) => string;
  requireTrustedHostKeys: (host: {
    hostname: string;
    port: number;
    tailnetId?: string | null;
  }) => string[];
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
  resolveTailnetRoute: (host: { tailnetId?: string | null }) => {
    tailnetId?: string;
    tailnetName?: string;
  };
}

export function createHostCoordinator(deps: {
  hosts: HostRepository;
  knownHosts: KnownHostRepository;
  coreManager: CoreManager;
  awsService: AwsService;
  authService: AuthService;
  awsSsmTunnelService: AwsSsmTunnelService;
  awsSftpCoordinator: AwsSftpCoordinator;
  tailnets: TailnetRepository;
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
    tailnets,
    resolveRuntimeSshSecrets,
    ensureCertificateAuthReady,
  } = deps;

  const requireTrustedHostKeys = (host: {
    hostname: string;
    port: number;
    // 신뢰는 tailnet 범위 안에서만 유효하다. 이것을 안 넘기면 다른 tailnet(또는 일반
    // 네트워크)의 같은 이름 호스트 키를 신뢰한 것으로 착각한다.
    tailnetId?: string | null;
  }): string[] => {
    const tailnetId = host.tailnetId ?? undefined;
    const trusted = knownHosts.listByHostPort(host.hostname, host.port, tailnetId);
    if (trusted.length === 0) {
      throw new Error("Host key is not trusted yet.");
    }
    knownHosts.touch(host.hostname, host.port, undefined, tailnetId);
    return trusted.map((record) => record.publicKeyBase64);
  };

  /**
   * 호스트를 어느 tailnet 으로 보낼지 해석한다.
   *
   * 기대 이름을 함께 돌려주는 것이 핵심이다 — 코어가 실제로 붙은 tailnet 과 대조해 다르면
   * 연결을 거부한다. 그 이름은 tailnet 설정에만 있으므로 여기서 붙여 준다.
   *
   * tailnet 을 지정했는데 그 설정이 없으면 연결 자체를 거부한다. 경로만 비워서 넘기면 일반
   * 네트워크로 나가는데, 그건 실패가 아니라 **성공**이다 — 사용자는 tailnet 안에 있다고 믿는
   * 트래픽이 공개망으로 나간다. 게다가 신뢰 범위는 여전히 호스트 레코드의 tailnetId 라서,
   * 일반 네트워크에서 TOFU 로 받은 키가 그 tailnet 범위에 저장된다.
   *
   * 설정이 사라지는 경로는 여전히 있다: 예전 버전에서 삭제한 레코드, 다른 기기에서 내려온
   * 불완전한 스냅샷, 호스트 전송 번들 가져오기(번들은 tailnets 를 담지 않는다).
   */
  const resolveTailnetRoute = (host: {
    tailnetId?: string | null;
  }): { tailnetId?: string; tailnetName?: string } => {
    const tailnetId = host.tailnetId?.trim();
    if (!tailnetId) {
      return {};
    }
    const record = tailnets.list().find((entry) => entry.id === tailnetId);
    if (!record) {
      throw new Error(t("hostIpc.tailnetMissing"));
    }
    return { tailnetId, tailnetName: record.tailnetName };
  };

  const requireConfiguredSshUsername = (host: SshHostRecord): string => {
    const username = host.username.trim();
    if (!username) {
      throw new Error(t("hostIpc.usernameRequired"));
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
      throw new Error(t("hostIpc.sshOnly"));
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
        t("hostIpc.sshAwsWarpgateOnly"),
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
      throw new Error(t("hostIpc.awsOnly"));
    }
  };

  const assertAwsEcsHost = (
    host: ReturnType<HostRepository["getById"]>,
  ): asserts host is AwsEcsHostRecord => {
    if (!host) {
      throw new Error("Host not found");
    }
    if (!isAwsEcsHostRecord(host)) {
      throw new Error(t("hostIpc.awsEcsOnly"));
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
    // RDP 는 계정이 자격증명에 있어 레코드에 사용자 이름이 없다. 그럴 때는 호스트 이름만 쓴다.
    const account = 'username' in host ? host.username : undefined;
    return host.label || (account?.trim() ? `${account}@${host.hostname}` : host.hostname);
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
    if (host.kind === "rdp" || host.kind === "vnc") {
      return host.hostname;
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
      throw new Error(t("hostIpc.ecsNoHostKey"));
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
                t("pfIpc.sshUsernameUnknown"),
            );
          }
          const availabilityZone = hydratedHost.awsAvailabilityZone?.trim();
          if (!availabilityZone) {
            throw new Error(t("pfIpc.azUnknown"));
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
            t("hostIpc.probingViaProxy"),
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
            t("hostIpc.openingTunnel"),
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
              t("hostIpc.probingHostKey"),
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
              t("hostIpc.sshAwsWarpgateOnly"),
            );
          })();
    const probePort = isWarpgateSshHostRecord(host)
      ? host.warpgateSshPort
      : isSshHostRecord(host)
        ? host.port
        : (() => {
            throw new Error(
              t("hostIpc.sshAwsWarpgateOnly"),
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
        // 프로브도 실연결과 같은 tailnet 을 타야 한다. 다른 통로로 읽으면 tailnet 밖의
        // 동명 호스트 키를 이 호스트의 것으로 저장하게 된다.
        ...resolveTailnetRoute(isSshHostRecord(host) ? host : {}),
      }),
    );
    // 신뢰 조회는 이 호스트가 속한 tailnet 안에서만 해야 한다. 범위를 빼면 다른 tailnet 의
    // 같은 이름 호스트 키를 이 호스트의 것으로 읽는다.
    const probeTailnetId = isSshHostRecord(host)
      ? (host.tailnetId ?? undefined)
      : undefined;
    const existing = knownHosts.getByHostPortAlgorithm(
      probeHost,
      probePort,
      probed.algorithm,
      probeTailnetId,
    );
    const status = !existing
      ? "untrusted"
      : existing.publicKeyBase64 === probed.publicKeyBase64
        ? "trusted"
        : "mismatch";

    if (status === "trusted") {
      knownHosts.touch(probeHost, probePort, probed.algorithm, probeTailnetId);
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
      throw new Error(t("hostIpc.jumpChainTooDeep", { max: maxChain }));
    }
    if (chain.includes(host.id)) {
      throw new Error(t("hostIpc.jumpChainSelf"));
    }

    let resolved: ResolvedJumpHost | undefined;
    for (const jumpHostId of chain) {
      const jumpHost = hosts.getById(jumpHostId);
      if (!jumpHost) {
        throw new Error(
          t("hostIpc.jumpHostMissing"),
        );
      }
      if (!isSshHostRecord(jumpHost)) {
        throw new Error(t("hostIpc.jumpHostMustBeSsh"));
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
    resolveTailnetRoute,
  };
}
