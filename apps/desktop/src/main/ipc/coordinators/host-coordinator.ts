import { randomUUID } from "node:crypto";
import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  getAwsSftpDiagnosticMessage,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from "@shared";
import type {
  AwsSftpDiagnosticDetails,
  AwsSftpDiagnosticReasonCode,
  HostDraft,
  HostKeyProbeResult,
  KnownHostProbeInput,
} from "@shared";
import type { AwsService } from "../../aws-service";
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
  ) => Promise<HostKeyProbeResult>;
}

export function createHostCoordinator(deps: {
  hosts: HostRepository;
  knownHosts: KnownHostRepository;
  coreManager: CoreManager;
  awsService: AwsService;
  awsSsmTunnelService: AwsSsmTunnelService;
  awsSftpCoordinator: AwsSftpCoordinator;
}): HostCoordinator {
  const {
    hosts,
    knownHosts,
    coreManager,
    awsService,
    awsSsmTunnelService,
    awsSftpCoordinator,
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

        currentStage = "opening-tunnel";
        emitStage(
          "opening-tunnel",
          "SSH 호스트 키 확인을 위한 내부 터널을 여는 중입니다.",
          hydratedHost.id,
        );
        const bindPort = await awsSftpCoordinator.reserveLoopbackPort();
        const tunnel = await awsSsmTunnelService.start({
          runtimeId: `aws-sftp-probe:${endpointId || host.id}:${randomUUID()}`,
          profileName:
            awsService.resolveManagedProfileNameOrFallback(
              hydratedHost.awsProfileId,
              hydratedHost.awsProfileName,
            ) ?? hydratedHost.awsProfileName,
          region: hydratedHost.awsRegion,
          instanceId: hydratedHost.awsInstanceId,
          bindAddress: "127.0.0.1",
          bindPort,
          targetPort: getAwsEc2HostSshPort(hydratedHost),
        });

        try {
          currentStage = "probing-host-key";
          emitStage(
            "probing-host-key",
            "SSH 호스트 키를 확인하는 중입니다.",
            hydratedHost.id,
          );
          const probed = await retryAwsSsmSshOperation(() =>
            coreManager.probeHostKey({
              host: tunnel.bindAddress,
              port: tunnel.bindPort,
            }),
          );
          const knownHost = buildAwsSsmKnownHostIdentity({
            profileName:
              awsService.resolveManagedProfileNameOrFallback(
                hydratedHost.awsProfileId,
                hydratedHost.awsProfileName,
              ) ?? hydratedHost.awsProfileName,
            region: hydratedHost.awsRegion,
            instanceId: hydratedHost.awsInstanceId,
          });
          const knownHostPort = getAwsEc2HostSshPort(hydratedHost);
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
        } finally {
          await awsSsmTunnelService.stop(tunnel.runtimeId).catch(() => undefined);
        }
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

    const probed = await coreManager.probeHostKey({
      host: probeHost,
      port: probePort,
    });
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
  };
}
