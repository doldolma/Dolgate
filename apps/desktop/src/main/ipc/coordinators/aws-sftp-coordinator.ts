import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  getAwsEc2HostSftpDisabledReason,
  getAwsEc2HostSshPort,
  getAwsSftpDiagnosticMessage,
  inferAwsSftpDiagnosticReasonCode,
  isAwsEc2HostRecord,
} from "@shared";
import type {
  AwsSftpDiagnosticDetails,
  AwsSftpDiagnosticReasonCode,
  HostDraft,
  HostRecord,
} from "@shared";
import type { AwsService } from "../../aws-service";
import type { HostRepository } from "../../database";
import { createEd25519SshKeyPair } from "../../ssh-key-material";
import type {
  AwsConnectionProgressEmitter,
  AwsEc2HostRecord,
  AwsSftpProgressStage,
} from "../context";

type AwsSftpStageErrorOptions = {
  reasonCode?: AwsSftpDiagnosticReasonCode;
  diagnosticId?: string;
  details?: AwsSftpDiagnosticDetails;
};

type AwsSftpStageErrorDiagnostic = Required<
  Pick<AwsSftpStageErrorOptions, "reasonCode" | "diagnosticId">
> & {
  stage: AwsSftpProgressStage;
  message: string;
  details: AwsSftpDiagnosticDetails;
};

interface AwsSftpPreflightCacheEntry {
  endpointId: string;
  hostId: string;
  hydratedHost: AwsEc2HostRecord;
  createdAt: number;
}

const AWS_SFTP_PREFLIGHT_CACHE_TTL_MS = 2 * 60_000;

export interface AwsSftpCoordinator {
  emitConnectionFailureProgress: (input: {
    endpointId: string;
    host: AwsEc2HostRecord;
    stage: AwsSftpProgressStage;
    error: unknown;
    reasonCode?: AwsSftpDiagnosticReasonCode;
    details?: AwsSftpDiagnosticDetails;
    emitProgress?: AwsConnectionProgressEmitter;
  }) => Error;
  resolvePreflight: (input: {
    endpointId: string;
    host: AwsEc2HostRecord;
    allowBrowserLogin: boolean;
    emitProgress?: AwsConnectionProgressEmitter;
  }) => Promise<AwsEc2HostRecord>;
  storePreflight: (endpointId: string, hydratedHost: AwsEc2HostRecord) => void;
  clearPreflight: (endpointId: string) => void;
  consumePreflight: (
    endpointId: string,
    hostId: string,
  ) => AwsEc2HostRecord | null;
  loadHostSshMetadataRecord: (host: AwsEc2HostRecord) => Promise<AwsEc2HostRecord>;
  normalizeEcsExecPermissionError: (error: unknown) => Error;
  createEphemeralAwsSftpKeyPair: () => {
    privateKeyPem: string;
    publicKey: string;
  };
  reserveLoopbackPort: () => Promise<number>;
  formatSftpStageError: (
    stage: AwsSftpProgressStage,
    error: unknown,
    options?: AwsSftpStageErrorOptions,
  ) => Error;
  buildDiagnosticDetails: (
    host: AwsEc2HostRecord,
    extra?: AwsSftpDiagnosticDetails,
  ) => AwsSftpDiagnosticDetails;
}

export function createAwsSftpCoordinator(deps: {
  hosts: HostRepository;
  awsService: AwsService;
  queueSync: () => void;
  emitSftpConnectionProgress: AwsConnectionProgressEmitter;
}): AwsSftpCoordinator {
  const { hosts, awsService, queueSync, emitSftpConnectionProgress } = deps;
  const awsSftpPreflightByEndpointId = new Map<
    string,
    AwsSftpPreflightCacheEntry
  >();

  const toAwsHostDraft = (
    host: AwsEc2HostRecord,
    overrides: Partial<Extract<HostDraft, { kind: "aws-ec2" }>> = {},
  ): Extract<HostDraft, { kind: "aws-ec2" }> => ({
    kind: "aws-ec2",
    label: host.label,
    groupName: host.groupName ?? "",
    tags: host.tags ?? [],
    terminalThemeId: host.terminalThemeId ?? null,
    awsProfileId: host.awsProfileId ?? null,
    awsProfileName: host.awsProfileName,
    awsRegion: host.awsRegion,
    awsInstanceId: host.awsInstanceId,
    awsAvailabilityZone: host.awsAvailabilityZone ?? null,
    awsInstanceName: host.awsInstanceName ?? null,
    awsPlatform: host.awsPlatform ?? null,
    awsPrivateIp: host.awsPrivateIp ?? null,
    awsState: host.awsState ?? null,
    awsSshUsername: host.awsSshUsername ?? null,
    awsSshPort: host.awsSshPort ?? null,
    awsSshMetadataStatus: host.awsSshMetadataStatus ?? null,
    awsSshMetadataError: host.awsSshMetadataError ?? null,
    ...overrides,
  });

  const normalizeEcsExecPermissionError = (error: unknown): Error => {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "ECS Exec 셸을 열지 못했습니다.";
    const normalized = message.trim();

    if (normalized.includes("cloudshell:ApproveCommand")) {
      return new Error(
        "AWS Console에서 CloudShell로 ECS Exec를 테스트하려면 `cloudshell:ApproveCommand` 권한이 필요합니다. Dolgate 앱 자체에는 필수 권한이 아니며, 앱에서 계속 실패하면 `ecs:ExecuteCommand`와 `ecs:DescribeTasks` 권한도 함께 확인해 주세요.",
      );
    }
    if (normalized.includes("ecs:ExecuteCommand")) {
      return new Error(
        `ECS Exec 권한이 없습니다. 사용자/역할에 \`ecs:ExecuteCommand\`와 보통 \`ecs:DescribeTasks\` 권한이 필요합니다. 원본 오류: ${normalized}`,
      );
    }
    if (normalized.includes("ecs:DescribeTasks")) {
      return new Error(
        `ECS task 조회 권한이 없습니다. 사용자/역할에 \`ecs:DescribeTasks\` 권한이 필요합니다. 원본 오류: ${normalized}`,
      );
    }
    if (normalized.includes("ssm:StartSession")) {
      return new Error(
        `Session Manager 권한이 없습니다. 사용자/역할에 \`ssm:StartSession\` 권한이 필요한지 확인해 주세요. 원본 오류: ${normalized}`,
      );
    }
    return new Error(normalized);
  };

  const createEphemeralAwsSftpKeyPair = () => {
    const keyPair = createEd25519SshKeyPair();
    return {
      privateKeyPem: keyPair.privateKeyPem,
      publicKey: keyPair.publicKey,
    };
  };

  const reserveLoopbackPort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() =>
            reject(new Error("로컬 포트를 예약하지 못했습니다.")),
          );
          return;
        }
        const port = address.port;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
      });
    });

  const getSftpStageLabel = (stage: AwsSftpProgressStage): string => {
    switch (stage) {
      case "loading-instance-metadata":
        return "SSH 설정 확인";
      case "checking-profile":
        return "프로필 확인";
      case "browser-login":
        return "AWS 로그인";
      case "checking-ssm":
        return "SSM 확인";
      case "probing-host-key":
        return "호스트 키 확인";
      case "generating-key":
        return "임시 키 생성";
      case "sending-public-key":
        return "공개 키 전송";
      case "opening-tunnel":
        return "터널 연결";
      case "connecting-sftp":
        return "SFTP 연결";
      default:
        return "AWS SFTP";
    }
  };

  const sanitizeDiagnosticDetails = (
    details: AwsSftpDiagnosticDetails = {},
  ): AwsSftpDiagnosticDetails => {
    const sanitized: AwsSftpDiagnosticDetails = {};
    for (const [key, value] of Object.entries(details)) {
      if (/password|passphrase|secret|token|credential|privatekey|private_key/i.test(key)) {
        continue;
      }
      if (
        typeof value === "string" &&
        /-----BEGIN|aws_secret_access_key|sessionToken|accessToken/i.test(value)
      ) {
        continue;
      }
      sanitized[key] = value;
    }
    return sanitized;
  };

  const errorMessageOf = (error: unknown): string =>
    error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";

  const formatSftpStageError = (
    stage: AwsSftpProgressStage,
    error: unknown,
    options: AwsSftpStageErrorOptions = {},
  ): Error => {
    const message = errorMessageOf(error);
    const reasonCode =
      options.reasonCode ?? inferAwsSftpDiagnosticReasonCode(stage, message);
    const diagnosticId = options.diagnosticId ?? `aws-sftp-${randomUUID()}`;
    const details = sanitizeDiagnosticDetails(options.details);
    const formatted = new Error(`[${getSftpStageLabel(stage)}] ${message}`);
    Object.assign(formatted, {
      awsSftpDiagnostic: {
        stage,
        reasonCode,
        diagnosticId,
        message,
        details,
      } satisfies AwsSftpStageErrorDiagnostic,
    });
    return formatted;
  };

  const buildDiagnosticDetails = (
    host: AwsEc2HostRecord,
    extra: AwsSftpDiagnosticDetails = {},
  ): AwsSftpDiagnosticDetails =>
    sanitizeDiagnosticDetails({
      hostId: host.id,
      hostLabel: host.label,
      profileName:
        awsService.resolveManagedProfileNameOrFallback(
          host.awsProfileId,
          host.awsProfileName,
        ) ?? host.awsProfileName,
      region: host.awsRegion,
      instanceId: host.awsInstanceId,
      availabilityZone: host.awsAvailabilityZone ?? null,
      sshUsername: host.awsSshUsername ?? null,
      sshPort: getAwsEc2HostSshPort(host),
      ...extra,
    });

  const emitConnectionFailureProgress = (input: {
    endpointId: string;
    host: AwsEc2HostRecord;
    stage: AwsSftpProgressStage;
    error: unknown;
    reasonCode?: AwsSftpDiagnosticReasonCode;
    details?: AwsSftpDiagnosticDetails;
    emitProgress?: AwsConnectionProgressEmitter;
  }): Error => {
    const formatted = formatSftpStageError(input.stage, input.error, {
      reasonCode: input.reasonCode,
      details: buildDiagnosticDetails(input.host, input.details),
    });
    const diagnostic = (formatted as Error & {
      awsSftpDiagnostic?: AwsSftpStageErrorDiagnostic;
    }).awsSftpDiagnostic;
    const emitProgress = input.emitProgress ?? emitSftpConnectionProgress;
    emitProgress({
      endpointId: input.endpointId,
      hostId: input.host.id,
      stage: input.stage,
      message: getAwsSftpDiagnosticMessage(diagnostic?.reasonCode),
      reasonCode: diagnostic?.reasonCode ?? "unknown",
      diagnosticId: diagnostic?.diagnosticId,
      details: diagnostic?.details,
    });
    return formatted;
  };

  const hydrateHostForSftp = async (
    host: AwsEc2HostRecord,
  ): Promise<AwsEc2HostRecord> => {
    const needsRefresh =
      !host.awsAvailabilityZone ||
      !host.awsPlatform ||
      !host.awsPrivateIp ||
      !host.awsState;
    if (!needsRefresh) {
      return host;
    }

    const summary = await awsService.describeEc2Instance(
      awsService.resolveManagedProfileNameOrFallback(
        host.awsProfileId,
        host.awsProfileName,
      ) ?? host.awsProfileName,
      host.awsRegion,
      host.awsInstanceId,
    );
    if (!summary) {
      return host;
    }

    const nextHost = hosts.update(
      host.id,
      toAwsHostDraft(host, {
        awsAvailabilityZone:
          summary.availabilityZone ?? host.awsAvailabilityZone ?? null,
        awsInstanceName:
          summary.name || host.awsInstanceName || host.awsInstanceId,
        awsPlatform: summary.platform ?? host.awsPlatform ?? null,
        awsPrivateIp: summary.privateIp ?? host.awsPrivateIp ?? null,
        awsState: summary.state ?? host.awsState ?? null,
      }),
    );
    queueSync();
    return nextHost as AwsEc2HostRecord;
  };

  const shouldLoadAwsHostSshMetadata = (host: AwsEc2HostRecord): boolean =>
    !host.awsSshUsername?.trim() ||
    !Number.isInteger(host.awsSshPort) ||
    (host.awsSshPort ?? 0) < 1 ||
    (host.awsSshPort ?? 0) > 65535 ||
    host.awsSshMetadataStatus === "loading" ||
    host.awsSshMetadataStatus === "idle";

  const loadHostSshMetadataRecord = async (
    host: AwsEc2HostRecord,
  ): Promise<AwsEc2HostRecord> => {
    const currentHost = shouldLoadAwsHostSshMetadata(host)
      ? (hosts.update(
          host.id,
          toAwsHostDraft(host, {
            awsSshMetadataStatus: "loading",
            awsSshMetadataError: null,
          }),
        ) as AwsEc2HostRecord)
      : host;
    queueSync();

    try {
      const hydratedHost = await hydrateHostForSftp(currentHost);
      const metadata = await awsService.loadHostSshMetadata({
        profileName:
          awsService.resolveManagedProfileNameOrFallback(
            hydratedHost.awsProfileId,
            hydratedHost.awsProfileName,
          ) ?? hydratedHost.awsProfileName,
        region: hydratedHost.awsRegion,
        instanceId: hydratedHost.awsInstanceId,
      });
      const nextUsername =
        metadata.recommendedUsername?.trim() ||
        hydratedHost.awsSshUsername?.trim() ||
        null;
      const nextStatus = nextUsername ? "ready" : "error";
      const nextError = nextUsername
        ? null
        : "SSH 로그인 사용자 후보를 찾지 못했습니다.";
      const nextHost = hosts.update(
        hydratedHost.id,
        toAwsHostDraft(hydratedHost, {
          awsSshUsername: nextUsername,
          awsSshPort: metadata.sshPort,
          awsSshMetadataStatus: nextStatus,
          awsSshMetadataError: nextError,
        }),
      ) as AwsEc2HostRecord;
      queueSync();
      return nextHost;
    } catch (error) {
      const latestHost = hosts.getById(host.id);
      if (!latestHost || !isAwsEc2HostRecord(latestHost)) {
        throw new Error("Host not found");
      }
      const nextHost = hosts.update(
        latestHost.id,
        toAwsHostDraft(latestHost, {
          awsSshMetadataStatus: "error",
          awsSshMetadataError:
            error instanceof Error
              ? error.message
              : "SSH 설정을 자동으로 확인하지 못했습니다.",
        }),
      ) as AwsEc2HostRecord;
      queueSync();
      return nextHost;
    }
  };

  const prunePreflightCache = () => {
    const now = Date.now();
    for (const [endpointId, entry] of awsSftpPreflightByEndpointId.entries()) {
      if (now - entry.createdAt > AWS_SFTP_PREFLIGHT_CACHE_TTL_MS) {
        awsSftpPreflightByEndpointId.delete(endpointId);
      }
    }
  };

  const storePreflight = (
    endpointId: string,
    hydratedHost: AwsEc2HostRecord,
  ) => {
    const normalizedEndpointId = endpointId.trim();
    if (!normalizedEndpointId) {
      return;
    }
    prunePreflightCache();
    awsSftpPreflightByEndpointId.set(normalizedEndpointId, {
      endpointId: normalizedEndpointId,
      hostId: hydratedHost.id,
      hydratedHost,
      createdAt: Date.now(),
    });
  };

  const clearPreflight = (endpointId: string) => {
    const normalizedEndpointId = endpointId.trim();
    if (!normalizedEndpointId) {
      return;
    }
    awsSftpPreflightByEndpointId.delete(normalizedEndpointId);
  };

  const consumePreflight = (
    endpointId: string,
    hostId: string,
  ): AwsEc2HostRecord | null => {
    const normalizedEndpointId = endpointId.trim();
    if (!normalizedEndpointId) {
      return null;
    }
    prunePreflightCache();
    const cached = awsSftpPreflightByEndpointId.get(normalizedEndpointId);
    if (!cached || cached.hostId !== hostId) {
      return null;
    }
    awsSftpPreflightByEndpointId.delete(normalizedEndpointId);
    return cached.hydratedHost;
  };

  const resolvePreflight = async (input: {
    endpointId: string;
    host: AwsEc2HostRecord;
    allowBrowserLogin: boolean;
    emitProgress?: AwsConnectionProgressEmitter;
  }): Promise<AwsEc2HostRecord> => {
    const {
      endpointId,
      host,
      allowBrowserLogin,
      emitProgress = emitSftpConnectionProgress,
    } = input;
    let currentStage: AwsSftpProgressStage = "checking-profile";

    try {
      const resolvedProfileName =
        awsService.resolveManagedProfileNameOrFallback(
          host.awsProfileId,
          host.awsProfileName,
        ) ?? host.awsProfileName;
      emitProgress({
        endpointId,
        hostId: host.id,
        stage: "checking-profile",
        message: `${resolvedProfileName} 프로필 인증 상태를 확인하는 중입니다.`,
      });
      let status = await awsService.getProfileStatus(resolvedProfileName);
      if (!status.isAuthenticated) {
        if (!status.isSsoProfile || !allowBrowserLogin) {
          throw new Error(
            status.errorMessage ||
              `${resolvedProfileName} 프로필에 AWS CLI 인증이 필요합니다.`,
          );
        }

        currentStage = "browser-login";
        emitProgress({
          endpointId,
          hostId: host.id,
          stage: "browser-login",
          message: `브라우저에서 ${resolvedProfileName} AWS 로그인을 진행하는 중입니다.`,
        });
        await awsService.login(resolvedProfileName);

        currentStage = "checking-profile";
        emitProgress({
          endpointId,
          hostId: host.id,
          stage: "checking-profile",
          message: `${resolvedProfileName} 프로필 로그인 결과를 확인하는 중입니다.`,
        });
        status = await awsService.getProfileStatus(resolvedProfileName);
        if (!status.isAuthenticated) {
          throw new Error(
            status.errorMessage ||
              "AWS SSO 로그인 후에도 인증이 확인되지 않았습니다.",
          );
        }
      }

      currentStage = "checking-ssm";
      emitProgress({
        endpointId,
        hostId: host.id,
        stage: "checking-ssm",
        message: `${host.label} 인스턴스의 SSM 연결 상태를 확인하는 중입니다.`,
      });
      if (!awsService.shouldUseInProcessSsm()) {
        await awsService.ensureSessionManagerPluginAvailable();
      }
      const refreshedHost = await hydrateHostForSftp(host);
      const isManaged = await awsService.isManagedInstance(
        awsService.resolveManagedProfileNameOrFallback(
          refreshedHost.awsProfileId,
          refreshedHost.awsProfileName,
        ) ?? refreshedHost.awsProfileName,
        refreshedHost.awsRegion,
        refreshedHost.awsInstanceId,
      );
      if (!isManaged) {
        throw new Error("이 인스턴스는 현재 SSM managed instance가 아닙니다.");
      }

      currentStage = "loading-instance-metadata";
      emitProgress({
        endpointId,
        hostId: refreshedHost.id,
        stage: "loading-instance-metadata",
        message: "SSH 설정을 자동으로 확인하는 중입니다.",
      });
      const hydratedHost = await loadHostSshMetadataRecord(refreshedHost);
      const disabledReason = getAwsEc2HostSftpDisabledReason(hydratedHost);
      if (disabledReason) {
        throw new Error(disabledReason);
      }

      return hydratedHost;
    } catch (error) {
      if (error instanceof Error && /^\[/.test(error.message)) {
        throw error;
      }
      throw emitConnectionFailureProgress({
        endpointId,
        host,
        stage: currentStage,
        error,
        emitProgress,
      });
    }
  };

  return {
    emitConnectionFailureProgress,
    resolvePreflight,
    storePreflight,
    clearPreflight,
    consumePreflight,
    loadHostSshMetadataRecord,
    normalizeEcsExecPermissionError,
    createEphemeralAwsSftpKeyPair,
    reserveLoopbackPort,
    formatSftpStageError,
    buildDiagnosticDetails,
  };
}
