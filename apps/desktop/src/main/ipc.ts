import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell as electronShell,
} from "electron";
import {
  isDnsOverrideEligiblePortForwardRule,
  isLinkedDnsOverrideRecord,
  isStaticDnsOverrideRecord,
  getGroupLabel,
  getAwsEc2HostSftpDisabledReason,
  getAwsEc2HostSshPort,
  buildAwsSsmKnownHostIdentity,
  getParentGroupPath,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isWarpgateSshHostRecord,
  isSshHostDraft,
  isSshHostRecord,
  normalizeGroupPath,
} from "@shared";
import type {
  AuthState,
  AppSettings,
  DesktopConnectInput,
  HostContainerRuntime,
  DesktopLocalConnectInput,
  DnsOverrideDraft,
  OpenSshSnapshotFileInput,
  OpenSshImportSelectionInput,
  OpenSshImportWarning,
  XshellSnapshotFolderInput,
  XshellImportSelectionInput,
  XshellImportWarning,
  DesktopSftpConnectInput,
  HostRecord,
  HostDraft,
  HostKeyProbeResult,
  GroupRemoveMode,
  HostSecretInput,
  KeychainSecretCloneInput,
  KeychainSecretUpdateInput,
  KeyboardInteractiveRespondInput,
  ManagedSecretPayload,
  KnownHostProbeInput,
  KnownHostTrustInput,
  HostContainersLogsInput,
  HostContainersEphemeralTunnelInput,
  HostContainersSearchLogsInput,
  HostContainersStatsInput,
  PortForwardDraft,
  PortForwardRuntimeRecord,
  SessionShareInputToggleInput,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  SftpChmodInput,
  SftpDeleteInput,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  TermiusImportSelectionInput,
  TransferStartInput,
} from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import {
  ActivityLogRepository,
  DnsOverrideRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  SyncOutboxRepository,
} from "./database";
import { AuthService } from "./auth-service";
import { AwsSsmTunnelService } from "./aws-ssm-tunnel-service";
import { AwsService } from "./aws-service";
import { CoreManager } from "./core-manager";
import { resolveContainerTunnelTarget } from "./container-port-forward-target";
import { LocalFileService } from "./file-service";
import {
  collectActiveDnsOverrideEntries,
  HostsOverrideManager,
  resolveDnsOverrideRecords,
} from "./hosts-override-manager";
import { PortForwardLifecycleLogger } from "./port-forward-lifecycle-logger";
import { SecretStore } from "./secret-store";
import { SessionShareService } from "./session-share-service";
import { SessionReplayService } from "./session-replay-service";
import { isSyncAuthenticationError, SyncService } from "./sync-service";
import {
  OpenSshImportService,
  resolveOpenSshIdentityImport,
} from "./openssh-import-service";
import {
  buildTermiusGroupAncestorPaths,
  TermiusImportService,
} from "./termius-import-service";
import { importTermiusSelection } from "./termius-import-executor";
import { UpdateService } from "./update-service";
import { WarpgateService } from "./warpgate-service";
import {
  collectSelectedXshellGroupPaths,
  collectSelectedXshellHosts,
  XshellImportService,
} from "./xshell-import-service";
import {
  decryptXshellPassword,
  resolveCurrentXshellPasswordSecurityContext,
} from "./xshell-password-decryptor";

function normalizeEcsExecPermissionError(error: unknown): Error {
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
}

async function persistSecret(
  secretStore: SecretStore,
  secretMetadata: SecretMetadataRepository,
  label: string,
  secrets?: HostSecretInput,
): Promise<string | null> {
  // 비밀값이 없으면 키체인을 건드리지 않고 바로 빠져나간다.
  if (!secrets?.password && !secrets?.passphrase && !secrets?.privateKeyPem) {
    return null;
  }

  const secretRef = `secret:${randomUUID()}`;
  const updatedAt = new Date().toISOString();
  await secretStore.save(
    secretRef,
    JSON.stringify({
      secretRef,
      label,
      password: secrets.password,
      passphrase: secrets.passphrase,
      privateKeyPem: secrets.privateKeyPem,
      source: "local_keychain",
      updatedAt,
    } satisfies ManagedSecretPayload),
  );
  secretMetadata.upsert({
    secretRef,
    label,
    hasPassword: Boolean(secrets.password),
    hasPassphrase: Boolean(secrets.passphrase),
    hasManagedPrivateKey: Boolean(secrets.privateKeyPem),
    source: "local_keychain",
  });
  return secretRef;
}

async function loadSecrets(
  secretStore: SecretStore,
  secretRef?: string | null,
): Promise<ManagedSecretPayload | HostSecretInput> {
  if (!secretRef) {
    return {};
  }
  const secretJson = await secretStore.load(secretRef);
  if (!secretJson) {
    return {};
  }
  const parsed = JSON.parse(secretJson) as Record<string, unknown>;
  return {
    secretRef,
    label: typeof parsed.label === "string" ? parsed.label : secretRef,
    password: typeof parsed.password === "string" ? parsed.password : undefined,
    passphrase:
      typeof parsed.passphrase === "string" ? parsed.passphrase : undefined,
    privateKeyPem:
      typeof parsed.privateKeyPem === "string"
        ? parsed.privateKeyPem
        : undefined,
    source:
      parsed.source === "server_managed" ? "server_managed" : "local_keychain",
    updatedAt:
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
  } satisfies ManagedSecretPayload;
}

function hasSecretValue(secrets: HostSecretInput): boolean {
  return Boolean(
    secrets.password || secrets.passphrase || secrets.privateKeyPem,
  );
}

function mergeSecrets(
  current: HostSecretInput,
  patch: HostSecretInput,
): HostSecretInput {
  return {
    password: patch.password !== undefined ? patch.password : current.password,
    passphrase:
      patch.passphrase !== undefined ? patch.passphrase : current.passphrase,
    privateKeyPem:
      patch.privateKeyPem !== undefined
        ? patch.privateKeyPem
        : current.privateKeyPem,
  };
}

async function resolveManagedPrivateKeyPem(
  draft: HostDraft,
  currentSecretRef: string | null,
  secretStore: SecretStore,
): Promise<string | undefined> {
  if (!isSshHostDraft(draft) || draft.authType !== "privateKey") {
    return undefined;
  }

  if (draft.privateKeyPath) {
    const pem = await readFile(draft.privateKeyPath, "utf8");
    return pem;
  }

  if (currentSecretRef) {
    const currentSecrets = await loadSecrets(secretStore, currentSecretRef);
    if (currentSecrets.privateKeyPem) {
      return currentSecrets.privateKeyPem;
    }
  }

  return undefined;
}

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function encodeSshWireValue(value: string | Buffer): Buffer {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

function createEphemeralAwsSftpKeyPair(): {
  privateKeyPem: string;
  publicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const x = typeof jwk.x === "string" ? jwk.x : "";
  if (!x) {
    throw new Error("임시 SSH 공개 키를 생성하지 못했습니다.");
  }
  const rawPublicKey = base64UrlToBuffer(x);
  const encodedPublicKey = Buffer.concat([
    encodeSshWireValue("ssh-ed25519"),
    encodeSshWireValue(rawPublicKey),
  ]).toString("base64");

  return {
    privateKeyPem: privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string,
    publicKey: `ssh-ed25519 ${encodedPublicKey}`,
  };
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildContainerShellCommand(
  runtimeCommand: string,
  containerId: string,
): string {
  const quotedContainerId = quotePosix(containerId);
  const quotedRuntimeCommand = quotePosix(runtimeCommand);
  const shellCommand = `${quotedRuntimeCommand} exec -it ${quotedContainerId} /bin/sh || ${quotedRuntimeCommand} exec -it ${quotedContainerId} /bin/bash`;
  return `sh -lc ${quotePosix(shellCommand)}`;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
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
}

function toAwsHostDraft(
  host: Extract<HostRecord, { kind: "aws-ec2" }>,
  overrides: Partial<Extract<HostDraft, { kind: "aws-ec2" }>> = {},
): Extract<HostDraft, { kind: "aws-ec2" }> {
  return {
    kind: "aws-ec2",
    label: host.label,
    groupName: host.groupName ?? "",
    tags: host.tags ?? [],
    terminalThemeId: host.terminalThemeId ?? null,
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
  };
}

type AwsSftpProgressStage =
  | "loading-instance-metadata"
  | "checking-profile"
  | "browser-login"
  | "checking-ssm"
  | "probing-host-key"
  | "generating-key"
  | "sending-public-key"
  | "opening-tunnel"
  | "connecting-sftp";

type AwsConnectionProgressEvent = {
  endpointId: string;
  hostId: string;
  stage: AwsSftpProgressStage;
  message: string;
};

type AwsConnectionProgressEmitter = (
  event: AwsConnectionProgressEvent,
) => void;

function getSftpStageLabel(stage: AwsSftpProgressStage): string {
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
}

function formatSftpStageError(
  stage: AwsSftpProgressStage,
  error: unknown,
): Error {
  const message =
    error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  return new Error(`[${getSftpStageLabel(stage)}] ${message}`);
}

const AWS_SFTP_PREFLIGHT_CACHE_TTL_MS = 2 * 60_000;

interface AwsSftpPreflightCacheEntry {
  endpointId: string;
  hostId: string;
  hydratedHost: Extract<HostRecord, { kind: "aws-ec2" }>;
  createdAt: number;
}

async function hydrateAwsHostForSftp(
  hosts: HostRepository,
  awsService: AwsService,
  host: Extract<HostRecord, { kind: "aws-ec2" }>,
  onPersist?: () => void,
): Promise<Extract<HostRecord, { kind: "aws-ec2" }>> {
  const needsRefresh =
    !host.awsAvailabilityZone ||
    !host.awsPlatform ||
    !host.awsPrivateIp ||
    !host.awsState;
  if (!needsRefresh) {
    return host;
  }

  const summary = await awsService.describeEc2Instance(
    host.awsProfileName,
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
  onPersist?.();
  return nextHost as Extract<HostRecord, { kind: "aws-ec2" }>;
}

function shouldLoadAwsHostSshMetadata(
  host: Extract<HostRecord, { kind: "aws-ec2" }>,
): boolean {
  return (
    !host.awsSshUsername?.trim() ||
    !Number.isInteger(host.awsSshPort) ||
    (host.awsSshPort ?? 0) < 1 ||
    (host.awsSshPort ?? 0) > 65535 ||
    host.awsSshMetadataStatus === "loading" ||
    host.awsSshMetadataStatus === "idle"
  );
}

async function loadAwsHostSshMetadataRecord(
  hosts: HostRepository,
  awsService: AwsService,
  host: Extract<HostRecord, { kind: "aws-ec2" }>,
  onPersist?: () => void,
): Promise<Extract<HostRecord, { kind: "aws-ec2" }>> {
  const currentHost = shouldLoadAwsHostSshMetadata(host)
    ? (hosts.update(
        host.id,
        toAwsHostDraft(host, {
          awsSshMetadataStatus: "loading",
          awsSshMetadataError: null,
        }),
      ) as Extract<HostRecord, { kind: "aws-ec2" }>)
    : host;
  onPersist?.();

  try {
    const hydratedHost = await hydrateAwsHostForSftp(
      hosts,
      awsService,
      currentHost,
      onPersist,
    );
    const metadata = await awsService.loadHostSshMetadata({
      profileName: hydratedHost.awsProfileName,
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
    ) as Extract<HostRecord, { kind: "aws-ec2" }>;
    onPersist?.();
    return nextHost;
  } catch (error) {
    const latestHost = hosts.getById(host.id);
    assertAwsEc2Host(latestHost);
    const nextHost = hosts.update(
      latestHost.id,
      toAwsHostDraft(latestHost, {
        awsSshMetadataStatus: "error",
        awsSshMetadataError:
          error instanceof Error
            ? error.message
            : "SSH 설정을 자동으로 확인하지 못했습니다.",
      }),
    ) as Extract<HostRecord, { kind: "aws-ec2" }>;
    onPersist?.();
    return nextHost;
  }
}

function requireTrustedHostKey(
  knownHosts: KnownHostRepository,
  host: { hostname: string; port: number },
): string {
  const trusted = knownHosts.getByHostPort(host.hostname, host.port);
  if (!trusted) {
    throw new Error("Host key is not trusted yet.");
  }
  knownHosts.touch(host.hostname, host.port);
  return trusted.publicKeyBase64;
}

async function buildHostKeyProbeResult(
  hosts: HostRepository,
  knownHosts: KnownHostRepository,
  coreManager: CoreManager,
  awsSsmTunnelService: AwsSsmTunnelService,
  emitConnectionProgress: AwsConnectionProgressEmitter,
  resolveAwsSftpPreflight: (input: {
    endpointId: string;
    host: Extract<HostRecord, { kind: "aws-ec2" }>;
    allowBrowserLogin: boolean;
    emitProgress?: AwsConnectionProgressEmitter;
  }) => Promise<Extract<HostRecord, { kind: "aws-ec2" }>>,
  storeAwsSftpPreflight: (
    endpointId: string,
    hydratedHost: Extract<HostRecord, { kind: "aws-ec2" }>,
  ) => void,
  input: KnownHostProbeInput,
): Promise<HostKeyProbeResult> {
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
      const hydratedHost = await resolveAwsSftpPreflight({
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
      const bindPort = await reserveLoopbackPort();
      const tunnel = await awsSsmTunnelService.start({
        runtimeId: `aws-sftp-probe:${endpointId || host.id}:${randomUUID()}`,
        profileName: hydratedHost.awsProfileName,
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
        const probed = await coreManager.probeHostKey({
          host: tunnel.bindAddress,
          port: tunnel.bindPort,
        });
        const knownHost = buildAwsSsmKnownHostIdentity({
          profileName: hydratedHost.awsProfileName,
          region: hydratedHost.awsRegion,
          instanceId: hydratedHost.awsInstanceId,
        });
        const knownHostPort = getAwsEc2HostSshPort(hydratedHost);
        const existing = knownHosts.getByHostPort(knownHost, knownHostPort);
        const status = !existing
          ? "untrusted"
          : existing.publicKeyBase64 === probed.publicKeyBase64
            ? "trusted"
            : "mismatch";

        if (status === "trusted") {
          knownHosts.touch(knownHost, knownHostPort);
        }
        if (endpointId) {
          storeAwsSftpPreflight(endpointId, hydratedHost);
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
      throw formatSftpStageError(currentStage, error);
    }
  }

  const probeHost = isWarpgateSshHostRecord(host)
    ? host.warpgateSshHost
    : host.hostname;
  const probePort = isWarpgateSshHostRecord(host)
    ? host.warpgateSshPort
    : host.port;

  const probed = await coreManager.probeHostKey({
    host: probeHost,
    port: probePort,
  });
  const existing = knownHosts.getByHostPort(probeHost, probePort);
  const status = !existing
    ? "untrusted"
    : existing.publicKeyBase64 === probed.publicKeyBase64
      ? "trusted"
      : "mismatch";

  if (status === "trusted") {
    knownHosts.touch(probeHost, probePort);
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
}

function assertSshHost(
  host: ReturnType<HostRepository["getById"]>,
): asserts host is Extract<
  NonNullable<ReturnType<HostRepository["getById"]>>,
  { kind: "ssh" }
> {
  if (!host) {
    throw new Error("Host not found");
  }
  if (!isSshHostRecord(host)) {
    throw new Error("이 기능은 SSH host에서만 사용할 수 있습니다.");
  }
}

function requireConfiguredSshUsername(
  host: Extract<
    NonNullable<ReturnType<HostRepository["getById"]>>,
    { kind: "ssh" }
  >,
): string {
  const username = host.username.trim();
  if (!username) {
    throw new Error("사용자명이 필요합니다.");
  }
  return username;
}

function assertSftpCompatibleHost(
  host: ReturnType<HostRepository["getById"]>,
): asserts host is Extract<
  NonNullable<ReturnType<HostRepository["getById"]>>,
  { kind: "ssh" | "warpgate-ssh" | "aws-ec2" }
> {
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
}

function assertAwsEc2Host(
  host: ReturnType<HostRepository["getById"]>,
): asserts host is Extract<
  NonNullable<ReturnType<HostRepository["getById"]>>,
  { kind: "aws-ec2" }
> {
  if (!host) {
    throw new Error("Host not found");
  }
  if (!isAwsEc2HostRecord(host)) {
    throw new Error("이 기능은 AWS host에서만 사용할 수 있습니다.");
  }
}

function assertAwsEcsHost(
  host: ReturnType<HostRepository["getById"]>,
): asserts host is Extract<
  NonNullable<ReturnType<HostRepository["getById"]>>,
  { kind: "aws-ecs" }
> {
  if (!host) {
    throw new Error("Host not found");
  }
  if (!isAwsEcsHostRecord(host)) {
    throw new Error("이 기능은 AWS ECS host에서만 사용할 수 있습니다.");
  }
}

function describeHostLabel(host: HostDraft | HostRecord): string {
  if (host.kind === "aws-ec2") {
    return host.label || host.awsInstanceName || host.awsInstanceId;
  }
  if (host.kind === "aws-ecs") {
    return host.label || host.awsEcsClusterName || host.awsEcsClusterArn;
  }
  if (host.kind === "warpgate-ssh") {
    return host.label || `${host.warpgateUsername}:${host.warpgateTargetName}`;
  }
  return host.label || (host.username.trim() ? `${host.username}@${host.hostname}` : host.hostname);
}

function describeHostTarget(
  host: HostDraft | ReturnType<HostRepository["getById"]>,
): string | null {
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
  return host.warpgateTargetId;
}

function resolveWindowFromSender(sender: Electron.WebContents): BrowserWindow {
  const window = BrowserWindow.fromWebContents(sender);
  if (!window) {
    throw new Error("호출한 브라우저 윈도우를 찾을 수 없습니다.");
  }
  return window;
}

function buildWindowState(window: BrowserWindow) {
  return {
    isMaximized: window.isMaximized(),
  };
}

function buildSshDuplicateKey(
  hostname: string,
  port: number,
  username: string,
): string {
  return `${hostname}\u0000${port}\u0000${username}`;
}

function buildKnownSshDuplicateKeys(hosts: HostRepository): Set<string> {
  return new Set(
    hosts
      .list()
      .filter(isSshHostRecord)
      .map((host) =>
        buildSshDuplicateKey(host.hostname, host.port, host.username),
      ),
  );
}

async function persistImportedSecret(
  secretStore: SecretStore,
  secretMetadata: SecretMetadataRepository,
  label: string,
  secrets: HostSecretInput,
): Promise<string | null> {
  if (!hasSecretValue(secrets)) {
    return null;
  }
  return persistSecret(secretStore, secretMetadata, label, secrets);
}

export function registerIpcHandlers(
  hosts: HostRepository,
  groups: GroupRepository,
  settings: SettingsRepository,
  portForwards: PortForwardRepository,
  dnsOverrides: DnsOverrideRepository,
  knownHosts: KnownHostRepository,
  activityLogs: ActivityLogRepository,
  secretMetadata: SecretMetadataRepository,
  syncOutbox: SyncOutboxRepository,
  secretStore: SecretStore,
  awsService: AwsService,
  awsSsmTunnelService: AwsSsmTunnelService,
  warpgateService: WarpgateService,
  coreManager: CoreManager,
  hostsOverrideManager: HostsOverrideManager,
  updater: UpdateService,
  authService: AuthService,
  syncService: SyncService,
  termiusImportService: TermiusImportService,
  opensshImportService: OpenSshImportService,
  xshellImportService: XshellImportService,
  sessionShareService: SessionShareService,
  sessionReplayService: SessionReplayService,
): void {
  const localFiles = new LocalFileService();
  const queueSync = () => {
    void syncService.pushDirty().catch(() => undefined);
  };
  const pendingSessionSecrets = new Map<
    string,
    {
      hostId: string;
      label: string;
      secrets: HostSecretInput;
    }
  >();
  const awsSftpTunnelRuntimeByEndpoint = new Map<string, string>();
  const awsContainersTunnelRuntimeByEndpoint = new Map<string, string>();
  const awsContainerShellTunnelRuntimeBySessionId = new Map<string, string>();
  const awsSftpPreflightByEndpointId = new Map<
    string,
    AwsSftpPreflightCacheEntry
  >();
  const listResolvedDnsOverrides = () => {
    const overrides = dnsOverrides.list();
    hostsOverrideManager.pruneStaticOverrideStates(
      overrides.filter(isStaticDnsOverrideRecord).map((record) => record.id),
    );
    return resolveDnsOverrideRecords(
      overrides,
      portForwards.list(),
      coreManager.listPortForwardRuntimes(),
      hostsOverrideManager.getActiveStaticOverrideIds(),
    );
  };

  const emitSftpConnectionProgress: AwsConnectionProgressEmitter = (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.sftp.connectionProgress, event);
      }
    }
  };

  const emitContainersConnectionProgress = (event: {
    endpointId: string;
    hostId: string;
    stage: AwsSftpProgressStage | "connecting-containers";
    message: string;
  }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(
          ipcChannels.containers.connectionProgress,
          event,
        );
      }
    }
  };

  const stopAwsSftpTunnelForEndpoint = async (endpointId: string) => {
    const runtimeId = awsSftpTunnelRuntimeByEndpoint.get(endpointId);
    if (!runtimeId) {
      return;
    }
    awsSftpTunnelRuntimeByEndpoint.delete(endpointId);
    await awsSsmTunnelService.stop(runtimeId).catch(() => undefined);
  };

  const buildContainersEndpointId = (hostId: string) => `containers:${hostId}`;
  const buildContainerPortForwardEndpointId = (hostId: string, ruleId: string) =>
    `containers:${hostId}:forward:${ruleId}`;

  const stopAwsContainersTunnelForEndpoint = async (endpointId: string) => {
    const runtimeId = awsContainersTunnelRuntimeByEndpoint.get(endpointId);
    if (!runtimeId) {
      return;
    }
    awsContainersTunnelRuntimeByEndpoint.delete(endpointId);
    await awsSsmTunnelService.stop(runtimeId).catch(() => undefined);
  };

  const moveAwsContainersTunnelRuntime = (
    sourceKey: string,
    nextKey: string,
  ) => {
    const runtimeId = awsContainersTunnelRuntimeByEndpoint.get(sourceKey);
    if (!runtimeId) {
      return;
    }
    awsContainersTunnelRuntimeByEndpoint.delete(sourceKey);
    awsContainersTunnelRuntimeByEndpoint.set(nextKey, runtimeId);
  };

  const stopAwsContainerShellTunnelForSession = async (sessionId: string) => {
    const runtimeId = awsContainerShellTunnelRuntimeBySessionId.get(sessionId);
    if (!runtimeId) {
      return;
    }
    awsContainerShellTunnelRuntimeBySessionId.delete(sessionId);
    await awsSsmTunnelService.stop(runtimeId).catch(() => undefined);
  };

  const pruneAwsSftpPreflightCache = () => {
    const now = Date.now();
    for (const [endpointId, entry] of awsSftpPreflightByEndpointId.entries()) {
      if (now - entry.createdAt > AWS_SFTP_PREFLIGHT_CACHE_TTL_MS) {
        awsSftpPreflightByEndpointId.delete(endpointId);
      }
    }
  };

  const storeAwsSftpPreflight = (
    endpointId: string,
    hydratedHost: Extract<HostRecord, { kind: "aws-ec2" }>,
  ) => {
    const normalizedEndpointId = endpointId.trim();
    if (!normalizedEndpointId) {
      return;
    }
    pruneAwsSftpPreflightCache();
    awsSftpPreflightByEndpointId.set(normalizedEndpointId, {
      endpointId: normalizedEndpointId,
      hostId: hydratedHost.id,
      hydratedHost,
      createdAt: Date.now(),
    });
  };

  const clearAwsSftpPreflight = (endpointId: string) => {
    const normalizedEndpointId = endpointId.trim();
    if (!normalizedEndpointId) {
      return;
    }
    awsSftpPreflightByEndpointId.delete(normalizedEndpointId);
  };

  const consumeAwsSftpPreflight = (
    endpointId: string,
    hostId: string,
  ): Extract<HostRecord, { kind: "aws-ec2" }> | null => {
    const normalizedEndpointId = endpointId.trim();
    if (!normalizedEndpointId) {
      return null;
    }
    pruneAwsSftpPreflightCache();
    const cached = awsSftpPreflightByEndpointId.get(normalizedEndpointId);
    if (!cached || cached.hostId !== hostId) {
      return null;
    }
    awsSftpPreflightByEndpointId.delete(normalizedEndpointId);
    return cached.hydratedHost;
  };

  async function rewriteActiveDnsOverrides(
    runtimeOverride?: PortForwardRuntimeRecord[],
  ): Promise<void> {
    const overrides = dnsOverrides.list();
    hostsOverrideManager.pruneStaticOverrideStates(
      overrides.filter(isStaticDnsOverrideRecord).map((record) => record.id),
    );
    const runtimes = runtimeOverride ?? coreManager.listPortForwardRuntimes();
    await hostsOverrideManager.rewrite(
      collectActiveDnsOverrideEntries(
        overrides,
        portForwards.list(),
        runtimes,
        hostsOverrideManager.getActiveStaticOverrideIds(),
      ),
    );
  }

  async function stopPortForwardWithDnsOverrideCleanup(
    ruleId: string,
  ): Promise<void> {
    const remainingRuntimes = coreManager
      .listPortForwardRuntimes()
      .filter((runtime) => runtime.ruleId !== ruleId);

    await rewriteActiveDnsOverrides(remainingRuntimes);
    try {
      await coreManager.stopPortForward(ruleId);
    } catch (error) {
      await rewriteActiveDnsOverrides().catch(() => undefined);
      throw error;
    }
  }

  const portForwardLifecycleLogger = new PortForwardLifecycleLogger(
    activityLogs,
    portForwards,
    hosts,
  );

  async function persistHostSpecificSecret(
    hostId: string,
    label: string,
    secrets: HostSecretInput,
  ): Promise<string | null> {
    if (!hasSecretValue(secrets)) {
      return null;
    }

    const secretRef = await persistSecret(
      secretStore,
      secretMetadata,
      label,
      secrets,
    );
    if (!secretRef) {
      return null;
    }

    hosts.updateSecretRef(hostId, secretRef);
    activityLogs.append(
      "info",
      "audit",
      "호스트 전용 인증 정보를 저장했습니다.",
      {
        hostId,
        secretRef,
      },
    );
    queueSync();
    return secretRef;
  }

  async function resolveAwsSftpPreflight(input: {
    endpointId: string;
    host: Extract<HostRecord, { kind: "aws-ec2" }>;
    allowBrowserLogin: boolean;
    emitProgress?: AwsConnectionProgressEmitter;
  }): Promise<Extract<HostRecord, { kind: "aws-ec2" }>> {
    const {
      endpointId,
      host,
      allowBrowserLogin,
      emitProgress = emitSftpConnectionProgress,
    } = input;
    let currentStage: AwsSftpProgressStage = "checking-profile";

    try {
      emitProgress({
        endpointId,
        hostId: host.id,
        stage: "checking-profile",
        message: `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`,
      });
      let status = await awsService.getProfileStatus(host.awsProfileName);
      if (!status.isAuthenticated) {
        if (!status.isSsoProfile || !allowBrowserLogin) {
          throw new Error(
            status.errorMessage ||
              `${host.awsProfileName} 프로필에 AWS CLI 인증이 필요합니다.`,
          );
        }

        currentStage = "browser-login";
        emitProgress({
          endpointId,
          hostId: host.id,
          stage: "browser-login",
          message: `브라우저에서 ${host.awsProfileName} AWS 로그인을 진행하는 중입니다.`,
        });
        await awsService.login(host.awsProfileName);

        currentStage = "checking-profile";
        emitProgress({
          endpointId,
          hostId: host.id,
          stage: "checking-profile",
          message: `${host.awsProfileName} 프로필 로그인 결과를 확인하는 중입니다.`,
        });
        status = await awsService.getProfileStatus(host.awsProfileName);
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
      await awsService.ensureSessionManagerPluginAvailable();
      const refreshedHost = await hydrateAwsHostForSftp(
        hosts,
        awsService,
        host,
        queueSync,
      );
      const isManaged = await awsService.isManagedInstance(
        refreshedHost.awsProfileName,
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
      const hydratedHost = await loadAwsHostSshMetadataRecord(
        hosts,
        awsService,
        refreshedHost,
        queueSync,
      );
      const disabledReason = getAwsEc2HostSftpDisabledReason(hydratedHost);
      if (disabledReason) {
        throw new Error(disabledReason);
      }

      return hydratedHost;
    } catch (error) {
      if (error instanceof Error && /^\[/.test(error.message)) {
        throw error;
      }
      throw formatSftpStageError(currentStage, error);
    }
  }

  async function ensureContainersEndpoint(
    host: Extract<HostRecord, { kind: "ssh" | "warpgate-ssh" | "aws-ec2" }>,
    endpointId = buildContainersEndpointId(host.id),
  ): Promise<{
    endpointId: string;
    runtime: HostContainerRuntime | null;
    runtimeCommand: string | null;
    unsupportedReason: string | null;
  }> {
    const existingRuntime =
      coreManager.getContainersEndpointRuntime(endpointId);
    if (existingRuntime) {
      return {
        endpointId,
        runtime: existingRuntime.runtime,
        runtimeCommand: existingRuntime.runtimeCommand,
        unsupportedReason: existingRuntime.unsupportedReason,
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
        consumeAwsSftpPreflight(endpointId, host.id) ??
        (await resolveAwsSftpPreflight({
          endpointId,
          host,
          allowBrowserLogin: true,
          emitProgress: emitContainersConnectionProgress,
        }));
      const sshPort = getAwsEc2HostSshPort(hydratedHost);
      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, {
        hostname: buildAwsSsmKnownHostIdentity({
          profileName: hydratedHost.awsProfileName,
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

      const { privateKeyPem, publicKey } = createEphemeralAwsSftpKeyPair();
      await awsService.sendSshPublicKey({
        profileName: hydratedHost.awsProfileName,
        region: hydratedHost.awsRegion,
        instanceId: hydratedHost.awsInstanceId,
        availabilityZone,
        osUser: sshUsername,
        publicKey,
      });
      const bindPort = await reserveLoopbackPort();
      let runtimeId = "";
      try {
        const tunnel = await awsSsmTunnelService.start({
          runtimeId: `aws-containers:${endpointId}`,
          profileName: hydratedHost.awsProfileName,
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
        const result = await coreManager.containersConnect({
          endpointId,
          host: tunnel.bindAddress,
          port: tunnel.bindPort,
          username: sshUsername,
          authType: "privateKey",
          privateKeyPem,
          trustedHostKeyBase64,
          hostId: hydratedHost.id,
        });
        if (result.runtime) {
          awsContainersTunnelRuntimeByEndpoint.set(
            endpointId,
            tunnel.runtimeId,
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
        };
      } catch (error) {
        clearAwsSftpPreflight(endpointId);
        if (runtimeId) {
          await awsSsmTunnelService.stop(runtimeId).catch(() => undefined);
        }
        throw error;
      }
    }

    if (isWarpgateSshHostRecord(host)) {
      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, {
        hostname: host.warpgateSshHost,
        port: host.warpgateSshPort,
      });
      const result = await coreManager.containersConnect({
        endpointId,
        host: host.warpgateSshHost,
        port: host.warpgateSshPort,
        username: `${host.warpgateUsername}:${host.warpgateTargetName}`,
        authType: "keyboardInteractive",
        trustedHostKeyBase64,
        hostId: host.id,
      });
      return {
        endpointId,
        runtime: result.runtime,
        runtimeCommand: result.runtimeCommand,
        unsupportedReason: result.unsupportedReason,
      };
    }

    const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
    const username = requireConfiguredSshUsername(host);
    const secrets = await loadSecrets(secretStore, host.secretRef);
    const result = await coreManager.containersConnect({
      endpointId,
      host: host.hostname,
      port: host.port,
      username,
      authType: host.authType,
      password: secrets.password,
      privateKeyPem: secrets.privateKeyPem,
      privateKeyPath: host.privateKeyPath ?? undefined,
      passphrase: secrets.passphrase,
      trustedHostKeyBase64,
      hostId: host.id,
    });
    return {
      endpointId,
      runtime: result.runtime,
      runtimeCommand: result.runtimeCommand,
      unsupportedReason: result.unsupportedReason,
    };
  }

  async function startContainerTunnelRuntime(input: {
    ruleId: string;
    host: Extract<HostRecord, { kind: "ssh" | "warpgate-ssh" | "aws-ec2" }>;
    containerId: string;
    networkName: string;
    targetPort: number;
    bindAddress: string;
    bindPort: number;
  }) {
    const { ruleId, host, containerId, networkName, targetPort, bindAddress, bindPort } =
      input;
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
      await stopAwsContainersTunnelForEndpoint(endpointId);
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
        moveAwsContainersTunnelRuntime(endpointId, ruleId);
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
      const username = requireConfiguredSshUsername(host);
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
      await stopAwsContainersTunnelForEndpoint(ruleId);
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
  }

  coreManager.setTerminalEventHandler(async (event) => {
    sessionShareService.handleTerminalEvent(event);
    sessionReplayService.handleTerminalEvent(event);
    if (event.endpointId) {
      if (event.type === "sftpDisconnected" || event.type === "sftpError") {
        clearAwsSftpPreflight(event.endpointId);
        await stopAwsSftpTunnelForEndpoint(event.endpointId);
      }
      if (
        event.type === "containersDisconnected" ||
        event.type === "containersError"
      ) {
        clearAwsSftpPreflight(event.endpointId);
        await stopAwsContainersTunnelForEndpoint(event.endpointId);
      }
      return;
    }
    if (!event.sessionId) {
      return;
    }

    if (event.type === "connected") {
      const pending = pendingSessionSecrets.get(event.sessionId);
      if (!pending) {
        return;
      }
      pendingSessionSecrets.delete(event.sessionId);
      await persistHostSpecificSecret(
        pending.hostId,
        pending.label,
        pending.secrets,
      );
      return;
    }

    if (event.type === "closed" || event.type === "error") {
      pendingSessionSecrets.delete(event.sessionId);
      await stopAwsContainerShellTunnelForSession(event.sessionId);
    }
    if (
      event.type === "status" &&
      String(event.payload.status ?? "") === "stopped"
    ) {
      await Promise.all(
        Array.from(awsSftpTunnelRuntimeByEndpoint.keys()).map((endpointId) =>
          stopAwsSftpTunnelForEndpoint(endpointId),
        ),
      );
      await Promise.all(
        Array.from(awsContainersTunnelRuntimeByEndpoint.keys()).map(
          (endpointId) => stopAwsContainersTunnelForEndpoint(endpointId),
        ),
      );
      await Promise.all(
        Array.from(awsContainerShellTunnelRuntimeBySessionId.keys()).map(
          (sessionId) => stopAwsContainerShellTunnelForSession(sessionId),
        ),
      );
    }
  });
  coreManager.setPortForwardEventHandler(async (event) => {
    portForwardLifecycleLogger.handleEvent(event);
    if (
      event.runtime.status === "stopped" ||
      event.runtime.status === "error"
    ) {
      await stopAwsContainersTunnelForEndpoint(event.runtime.ruleId);
    }
  });
  coreManager.setTerminalStreamHandler((sessionId, chunk) => {
    sessionShareService.handleTerminalStream(sessionId, chunk);
    sessionReplayService.handleTerminalStream(sessionId, chunk);
  });

  ipcMain.handle(ipcChannels.auth.getState, async () => authService.getState());
  ipcMain.handle(ipcChannels.auth.bootstrap, async () =>
    authService.bootstrap(),
  );
  ipcMain.handle(ipcChannels.auth.retryOnline, async () =>
    authService.retryOnline(),
  );
  ipcMain.handle(ipcChannels.auth.beginBrowserLogin, async () => {
    await authService.beginBrowserLogin();
  });
  ipcMain.handle(ipcChannels.auth.logout, async () => {
    await authService.logout();
  });

  ipcMain.handle(ipcChannels.sync.bootstrap, async () => {
    try {
      return await syncService.bootstrap();
    } catch (error) {
      if (
        isSyncAuthenticationError(error) &&
        authService.getState().status === "authenticated"
      ) {
        await authService.forceUnauthenticated(
          "세션이 만료되었습니다. 다시 로그인해 주세요.",
        );
      }
      throw error;
    }
  });
  ipcMain.handle(ipcChannels.sync.pushDirty, async () => {
    try {
      return await syncService.pushDirty();
    } catch (error) {
      if (
        isSyncAuthenticationError(error) &&
        authService.getState().status === "authenticated"
      ) {
        await authService.forceUnauthenticated(
          "세션이 만료되었습니다. 다시 로그인해 주세요.",
        );
      }
      throw error;
    }
  });
  ipcMain.handle(ipcChannels.sync.status, async () => syncService.getState());
  ipcMain.handle(ipcChannels.sync.exportDecryptedSnapshot, async () =>
    syncService.exportDecryptedSnapshot(),
  );

  ipcMain.handle(
    ipcChannels.sessionShares.start,
    async (_event, input: SessionShareStartInput) =>
      sessionShareService.start(input),
  );
  ipcMain.handle(
    ipcChannels.sessionShares.updateSnapshot,
    async (_event, input: SessionShareSnapshotInput) => {
      await sessionShareService.updateSnapshot(input);
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.setInputEnabled,
    async (_event, input: SessionShareInputToggleInput) =>
      sessionShareService.setInputEnabled(input),
  );
  ipcMain.handle(
    ipcChannels.sessionShares.stop,
    async (_event, sessionId: string) => {
      await sessionShareService.stop(sessionId);
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.openOwnerChatWindow,
    async (event, sessionId: string) => {
      await sessionShareService.openOwnerChatWindow(
        sessionId,
        resolveWindowFromSender(event.sender),
      );
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.sendOwnerChatMessage,
    async (_event, sessionId: string, text: string) => {
      await sessionShareService.sendOwnerChatMessage(sessionId, text);
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.getOwnerChatSnapshot,
    async (_event, sessionId: string) =>
      sessionShareService.getOwnerChatSnapshot(sessionId),
  );

  // renderer는 preload를 통해서만 이 handler들에 접근한다.
  ipcMain.handle(ipcChannels.hosts.list, async () => hosts.list());

  ipcMain.handle(
    ipcChannels.hosts.create,
    async (_event, draft: HostDraft, secrets?: HostSecretInput) => {
      const hostId = randomUUID();
      const resolvedSecrets: HostSecretInput = isSshHostDraft(draft)
        ? {
            ...secrets,
            privateKeyPem: await resolveManagedPrivateKeyPem(
              draft,
              null,
              secretStore,
            ),
          }
        : {};
      const secretRef = isSshHostDraft(draft)
        ? await persistSecret(
            secretStore,
            secretMetadata,
            describeHostLabel(draft),
            resolvedSecrets,
          )
        : null;
      if (secretRef) {
        activityLogs.append(
          "info",
          "audit",
          "호스트 secret이 저장되었습니다.",
          {
            hostId,
            secretRef,
          },
        );
      }
      const record = hosts.create(hostId, draft, secretRef);
      activityLogs.append("info", "audit", "호스트를 생성했습니다.", {
        hostId: record.id,
        label: record.label,
        kind: record.kind,
        target: describeHostTarget(record),
        groupName: record.groupName ?? null,
      });
      queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.hosts.update,
    async (_event, id: string, draft: HostDraft, secrets?: HostSecretInput) => {
      const current = hosts.getById(id);
      if (!current) {
        throw new Error("Host not found");
      }
      // draft.secretRef가 명시적으로 null이면 기존 연결을 끊으려는 의도로 해석한다.
      let secretRef =
        isSshHostDraft(draft) && isSshHostRecord(current)
          ? draft.secretRef !== undefined
            ? draft.secretRef
            : (current.secretRef ?? null)
          : null;
      const resolvedSecrets: HostSecretInput = isSshHostDraft(draft)
        ? {
            ...secrets,
            privateKeyPem: await resolveManagedPrivateKeyPem(
              draft,
              isSshHostRecord(current) ? (current.secretRef ?? null) : null,
              secretStore,
            ),
          }
        : {};
      if (
        isSshHostDraft(draft) &&
        (resolvedSecrets.password ||
          resolvedSecrets.passphrase ||
          resolvedSecrets.privateKeyPem)
      ) {
        secretRef = await persistSecret(
          secretStore,
          secretMetadata,
          describeHostLabel(draft),
          resolvedSecrets,
        );
        activityLogs.append(
          "info",
          "audit",
          "호스트 secret이 갱신되었습니다.",
          {
            hostId: id,
            secretRef,
          },
        );
      } else if (isSshHostDraft(draft) && secrets) {
        secretRef = isSshHostRecord(current)
          ? (current.secretRef ?? null)
          : null;
      }
      const record = hosts.update(id, draft, secretRef);
      activityLogs.append("info", "audit", "호스트를 수정했습니다.", {
        hostId: record.id,
        label: record.label,
        kind: record.kind,
        target: describeHostTarget(record),
        groupName: record.groupName ?? null,
      });
      queueSync();
      return record;
    },
  );

  ipcMain.handle(ipcChannels.hosts.remove, async (_event, id: string) => {
    const current = hosts.getById(id);
    syncOutbox.upsertDeletion("hosts", id);
    hosts.remove(id);
    if (current) {
      activityLogs.append("warn", "audit", "호스트를 삭제했습니다.", {
        hostId: current.id,
        label: current.label,
        kind: current.kind,
        target: describeHostTarget(current),
      });
    }
    queueSync();
  });

  ipcMain.handle(ipcChannels.groups.list, async () => groups.list());

  ipcMain.handle(
    ipcChannels.groups.create,
    async (_event, name: string, parentPath?: string | null) => {
      const group = groups.create(randomUUID(), name, parentPath);
      activityLogs.append("info", "audit", "그룹을 생성했습니다.", {
        groupId: group.id,
        name: group.name,
        path: group.path,
        parentPath: group.parentPath ?? null,
      });
      queueSync();
      return group;
    },
  );

  ipcMain.handle(
    ipcChannels.groups.remove,
    async (_event, path: string, mode: GroupRemoveMode) => {
      const result = groups.remove(path, mode);
      for (const groupId of result.removedGroupIds) {
        syncOutbox.upsertDeletion("groups", groupId);
      }
      for (const hostId of result.removedHostIds) {
        syncOutbox.upsertDeletion("hosts", hostId);
      }
      activityLogs.append("warn", "audit", "그룹을 삭제했습니다.", {
        path,
        mode,
        removedGroupCount: result.removedGroupIds.length,
        removedHostCount: result.removedHostIds.length,
      });
      queueSync();
      return {
        groups: result.groups,
        hosts: result.hosts,
      };
    },
  );

  ipcMain.handle(ipcChannels.aws.listProfiles, async () =>
    awsService.listProfiles(),
  );

  ipcMain.handle(
    ipcChannels.aws.getProfileStatus,
    async (_event, profileName: string) =>
      awsService.getProfileStatus(profileName),
  );

  ipcMain.handle(ipcChannels.aws.login, async (_event, profileName: string) => {
    await awsService.login(profileName);
  });

  ipcMain.handle(
    ipcChannels.aws.listRegions,
    async (_event, profileName: string) => awsService.listRegions(profileName),
  );

  ipcMain.handle(
    ipcChannels.aws.listEc2Instances,
    async (_event, profileName: string, region: string) => {
      return awsService.listEc2Instances(profileName, region);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.listEcsClusters,
    async (_event, profileName: string, region: string) => {
      return awsService.listEcsClusters(profileName, region);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsClusterSnapshot,
    async (_event, hostId: string) => {
      const host = hosts.getById(hostId);
      if (!host || !isAwsEcsHostRecord(host)) {
        throw new Error("이 기능은 ECS host에서만 사용할 수 있습니다.");
      }
      return awsService.describeEcsClusterSnapshot(
        host.awsProfileName,
        host.awsRegion,
        host.awsEcsClusterArn,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsClusterUtilization,
    async (_event, hostId: string) => {
      const host = hosts.getById(hostId);
      if (!host || !isAwsEcsHostRecord(host)) {
        throw new Error("이 기능은 ECS host에서만 사용할 수 있습니다.");
      }
      return awsService.describeEcsClusterUtilization(
        host.awsProfileName,
        host.awsRegion,
        host.awsEcsClusterArn,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsServiceActionContext,
    async (_event, hostId: string, serviceName: string) => {
      const host = hosts.getById(hostId);
      assertAwsEcsHost(host);
      return awsService.describeEcsServiceActionContext(
        host.awsProfileName,
        host.awsRegion,
        host.awsEcsClusterArn,
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
      const host = hosts.getById(input.hostId);
      assertAwsEcsHost(host);
      return awsService.loadEcsServiceLogs({
        profileName: host.awsProfileName,
        region: host.awsRegion,
        clusterArn: host.awsEcsClusterArn,
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
        const host = hosts.getById(input.hostId);
        assertAwsEcsHost(host);
        await awsService.ensureAwsCliAvailable();
        await awsService.ensureSessionManagerPluginAvailable();
        const actionContext = await awsService.describeEcsServiceActionContext(
          host.awsProfileName,
          host.awsRegion,
          host.awsEcsClusterArn,
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
        return coreManager.connectLocalSession({
          cols: input.cols,
          rows: input.rows,
          title: `${host.label} · ${input.serviceName} · ${input.containerName}`,
          shellKind: "aws-ecs-exec",
          executable: "aws",
          args: [
            "ecs",
            "execute-command",
            "--profile",
            host.awsProfileName,
            "--region",
            host.awsRegion,
            "--cluster",
            host.awsEcsClusterArn,
            "--task",
            input.taskArn,
            "--container",
            input.containerName,
            "--interactive",
            "--command",
            "/bin/sh",
          ],
        });
      } catch (error) {
        throw normalizeEcsExecPermissionError(error);
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
      const host = hosts.getById(input.hostId);
      assertAwsEcsHost(host);
      await awsService.ensureAwsCliAvailable();
      await awsService.ensureSessionManagerPluginAvailable();
      const targetId = await awsService.resolveEcsTaskTunnelTargetForTask({
        profileName: host.awsProfileName,
        region: host.awsRegion,
        clusterArn: host.awsEcsClusterArn,
        taskArn: input.taskArn,
        containerName: input.containerName,
      });
      const runtimeId = `ecs-service-tunnel:${randomUUID()}`;
      return coreManager.startSsmPortForward({
        ruleId: runtimeId,
        hostId: host.id,
        transport: "ecs-task",
        profileName: host.awsProfileName,
        region: host.awsRegion,
        targetType: "ecs-task",
        targetId,
        bindAddress: input.bindAddress,
        bindPort: input.bindPort,
        targetKind: "remote-host",
        targetPort: input.targetPort,
        remoteHost: "127.0.0.1",
      });
    },
  );

  ipcMain.handle(
    ipcChannels.aws.stopEcsServiceTunnel,
    async (_event, runtimeId: string) => {
      await coreManager.stopPortForward(runtimeId);
    },
  );

  ipcMain.handle(
    ipcChannels.aws.listEcsTaskTunnelServices,
    async (_event, hostId: string) => {
      const host = hosts.getById(hostId);
      assertAwsEcsHost(host);
      return awsService.listEcsTaskTunnelServices(
        host.awsProfileName,
        host.awsRegion,
        host.awsEcsClusterArn,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.aws.loadEcsTaskTunnelService,
    async (_event, hostId: string, serviceName: string) => {
      const host = hosts.getById(hostId);
      assertAwsEcsHost(host);
      return awsService.describeEcsTaskTunnelService(
        host.awsProfileName,
        host.awsRegion,
        host.awsEcsClusterArn,
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
    ) => awsService.inspectHostSshMetadata(input),
  );

  ipcMain.handle(
    ipcChannels.aws.loadHostSshMetadata,
    async (_event, hostId: string) => {
      const host = hosts.getById(hostId);
      assertAwsEc2Host(host);
      const nextHost = await loadAwsHostSshMetadataRecord(
        hosts,
        awsService,
        host,
        queueSync,
      );
      return nextHost;
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.testConnection,
    async (_event, baseUrl: string, token: string) => {
      return warpgateService.testConnection(baseUrl, token);
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.getConnectionInfo,
    async (_event, baseUrl: string, token: string) => {
      return warpgateService.getConnectionInfo(baseUrl, token);
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.listSshTargets,
    async (_event, baseUrl: string, token: string) => {
      return warpgateService.listSshTargets(baseUrl, token);
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.startBrowserImport,
    async (event, baseUrl: string) => {
      return warpgateService.startBrowserImport(
        baseUrl,
        BrowserWindow.fromWebContents(event.sender),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.warpgate.cancelBrowserImport,
    async (_event, attemptId: string) => {
      await warpgateService.cancelBrowserImport(attemptId);
    },
  );

  ipcMain.handle(ipcChannels.termius.probeLocal, async () => {
    return termiusImportService.probeLocal();
  });

  ipcMain.handle(ipcChannels.openssh.probeDefault, async () => {
    return opensshImportService.probeDefault(buildKnownSshDuplicateKeys(hosts));
  });

  ipcMain.handle(ipcChannels.xshell.probeDefault, async () => {
    return xshellImportService.probeDefault(buildKnownSshDuplicateKeys(hosts));
  });

  ipcMain.handle(
    ipcChannels.openssh.addFileToSnapshot,
    async (_event, input: OpenSshSnapshotFileInput) => {
      return opensshImportService.addFileToSnapshot(
        input,
        buildKnownSshDuplicateKeys(hosts),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.xshell.addFolderToSnapshot,
    async (_event, input: XshellSnapshotFolderInput) => {
      return xshellImportService.addFolderToSnapshot(
        input,
        buildKnownSshDuplicateKeys(hosts),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.termius.discardSnapshot,
    async (_event, snapshotId: string) => {
      termiusImportService.discardSnapshot(snapshotId);
    },
  );

  ipcMain.handle(
    ipcChannels.xshell.discardSnapshot,
    async (_event, snapshotId: string) => {
      xshellImportService.discardSnapshot(snapshotId);
    },
  );

  ipcMain.handle(
    ipcChannels.openssh.discardSnapshot,
    async (_event, snapshotId: string) => {
      opensshImportService.discardSnapshot(snapshotId);
    },
  );

  ipcMain.handle(
    ipcChannels.termius.importSelection,
    async (_event, input: TermiusImportSelectionInput) => {
      const snapshot = termiusImportService.getSnapshot(input.snapshotId);
      if (!snapshot) {
        throw new Error(
          "Termius import snapshot을 찾지 못했습니다. 목록을 다시 불러와 주세요.",
        );
      }

      const result = await importTermiusSelection(snapshot, input, {
        groups,
        hosts,
        activityLogs,
        secretMetadata,
        persistSecret: async (label, secrets) =>
          persistImportedSecret(secretStore, secretMetadata, label, secrets),
        queueSync,
      });

      if (result.warnings.length > 0) {
        activityLogs.append(
          "warn",
          "audit",
          "Termius import 중 일부 항목을 건너뛰거나 경고가 발생했습니다.",
          {
            warningCount: result.warnings.length,
          },
        );
      }

      termiusImportService.discardSnapshot(input.snapshotId);
      return result;
    },
  );

  ipcMain.handle(
    ipcChannels.openssh.importSelection,
    async (_event, input: OpenSshImportSelectionInput) => {
      const snapshot = opensshImportService.getSnapshot(input.snapshotId);
      if (!snapshot) {
        throw new Error(
          "OpenSSH 가져오기 상태를 찾을 수 없습니다. 다시 파일을 선택해 주세요.",
        );
      }

      try {
        const selectedHostKeys = new Set(input.selectedHostKeys);
        const selectedHosts = [...snapshot.hostsByKey.values()].filter((host) =>
          selectedHostKeys.has(host.key),
        );
        const targetGroupPath = normalizeGroupPath(input.groupPath);
        const existingGroupPaths = new Set(
          groups.list().map((group) => group.path),
        );
        const secretRefsByIdentityPath = new Map<string, string>();
        const warnings: OpenSshImportWarning[] = [...snapshot.warnings];

        let createdGroupCount = 0;
        let createdHostCount = 0;
        let createdSecretCount = 0;
        let skippedHostCount = 0;

        for (const candidatePath of buildTermiusGroupAncestorPaths(
          targetGroupPath,
        )) {
          if (existingGroupPaths.has(candidatePath)) {
            continue;
          }
          const group = groups.create(
            randomUUID(),
            getGroupLabel(candidatePath),
            getParentGroupPath(candidatePath),
          );
          existingGroupPaths.add(group.path);
          createdGroupCount += 1;
        }

        for (const host of selectedHosts) {
          let secretRef: string | null = null;
          let privateKeyPath: string | null = null;

          if (host.authType === "privateKey" && host.identityFilePath) {
            const cachedSecretRef = secretRefsByIdentityPath.get(
              host.identityFilePath,
            );
            if (cachedSecretRef) {
              secretRef = cachedSecretRef;
            } else {
              const identityImport = await resolveOpenSshIdentityImport(
                host.identityFilePath,
              );
              if (identityImport.kind === "managed-key") {
                secretRef = await persistImportedSecret(
                  secretStore,
                  secretMetadata,
                  `OpenSSH ${host.alias}`,
                  {
                    privateKeyPem: identityImport.privateKeyPem,
                  },
                );
                if (secretRef) {
                  secretRefsByIdentityPath.set(
                    host.identityFilePath,
                    secretRef,
                  );
                  createdSecretCount += 1;
                }
              } else {
                privateKeyPath = host.identityFilePath;
                warnings.push(identityImport.warning);
              }
            }

            if (!secretRef && !privateKeyPath) {
              privateKeyPath = host.identityFilePath;
            }
          }

          hosts.create(
            randomUUID(),
            {
              kind: "ssh",
              label: host.alias,
              groupName: targetGroupPath,
              tags: [],
              terminalThemeId: null,
              hostname: host.hostname,
              port: host.port,
              username: host.username,
              authType: host.authType,
              privateKeyPath,
            },
            secretRef,
          );
          createdHostCount += 1;
        }

        if (
          createdGroupCount > 0 ||
          createdHostCount > 0 ||
          createdSecretCount > 0
        ) {
          activityLogs.append(
            "info",
            "audit",
            "OpenSSH 소스에서 호스트를 가져왔습니다.",
            {
              sourceCount: snapshot.sources.length,
              targetGroupPath,
              createdGroupCount,
              createdHostCount,
              createdSecretCount,
              skippedHostCount,
            },
          );
          queueSync();
        }

        if (warnings.length > 0) {
          activityLogs.append(
            "warn",
            "audit",
            "OpenSSH 가져오기가 경고와 함께 완료되었습니다.",
            {
              sourceCount: snapshot.sources.length,
              warningCount: warnings.length,
            },
          );
        }

        return {
          createdHostCount,
          createdSecretCount,
          skippedHostCount,
          warnings,
        };
      } finally {
        opensshImportService.discardSnapshot(input.snapshotId);
      }
    },
  );

  ipcMain.handle(
    ipcChannels.xshell.importSelection,
    async (_event, input: XshellImportSelectionInput) => {
      const snapshot = xshellImportService.getSnapshot(input.snapshotId);
      if (!snapshot) {
        throw new Error(
          "Xshell 가져오기 상태를 찾지 못했습니다. 대화상자를 다시 열어주세요.",
        );
      }

      try {
        const selectedHosts = collectSelectedXshellHosts(snapshot, input);
        const selectedGroupPaths = collectSelectedXshellGroupPaths(
          snapshot,
          input,
        );
        const existingGroupPaths = new Set(
          groups.list().map((group) => group.path),
        );
        const passwordSecurityContext =
          await resolveCurrentXshellPasswordSecurityContext();
        const warnings: XshellImportWarning[] = [...snapshot.warnings];
        let createdGroupCount = 0;
        let createdHostCount = 0;
        let createdSecretCount = 0;
        let skippedHostCount = 0;

        for (const groupPath of selectedGroupPaths) {
          for (const candidatePath of buildTermiusGroupAncestorPaths(
            groupPath,
          )) {
            if (existingGroupPaths.has(candidatePath)) {
              continue;
            }
            const group = groups.create(
              randomUUID(),
              getGroupLabel(candidatePath),
              getParentGroupPath(candidatePath),
            );
            existingGroupPaths.add(group.path);
            createdGroupCount += 1;
          }
        }

        for (const host of selectedHosts) {
          const groupPath = normalizeGroupPath(host.groupPath);
          for (const candidatePath of buildTermiusGroupAncestorPaths(
            groupPath,
          )) {
            if (existingGroupPaths.has(candidatePath)) {
              continue;
            }
            groups.create(
              randomUUID(),
              getGroupLabel(candidatePath),
              getParentGroupPath(candidatePath),
            );
            existingGroupPaths.add(candidatePath);
            createdGroupCount += 1;
          }

          let secretRef: string | null = null;
          if (
            host.authType === "password" &&
            host.encryptedPassword &&
            !host.masterPasswordEnabled
          ) {
            const decryptedPassword = decryptXshellPassword({
              encryptedPassword: host.encryptedPassword,
              sessionFileVersion: host.sessionFileVersion,
              masterPasswordEnabled: host.masterPasswordEnabled,
              securityContext: passwordSecurityContext,
            });

            if (decryptedPassword.ok) {
              secretRef = await persistImportedSecret(
                secretStore,
                secretMetadata,
                `Xshell • ${host.label}`,
                {
                  password: decryptedPassword.password,
                },
              );
              if (secretRef) {
                createdSecretCount += 1;
              }
            } else {
              const warningCode =
                decryptedPassword.reason === "missing-security-context" ||
                decryptedPassword.reason === "invalid-version"
                  ? "password-import-unsupported"
                  : "password-decrypt-failed";
              warnings.push({
                code: warningCode,
                message:
                  warningCode === "password-import-unsupported"
                    ? `${host.label}: 이 Windows 사용자 환경에서는 저장된 Xshell 비밀번호를 자동으로 가져올 수 없습니다.`
                    : `${host.label}: 저장된 Xshell 비밀번호를 복호화하지 못해 호스트만 가져왔습니다.`,
                filePath: host.sourceFilePath,
              });
            }
          }

          hosts.create(
            randomUUID(),
            {
              kind: "ssh",
              label: host.label,
              groupName: groupPath,
              tags: [],
              terminalThemeId: null,
              hostname: host.hostname,
              port: host.port,
              username: host.username,
              authType: host.authType,
              privateKeyPath: host.privateKeyPath,
            },
            secretRef,
          );
          createdHostCount += 1;
        }

        if (
          createdGroupCount > 0 ||
          createdHostCount > 0 ||
          createdSecretCount > 0
        ) {
          activityLogs.append(
            "info",
            "audit",
            "Xshell 세션에서 호스트를 가져왔습니다.",
            {
              sourceCount: snapshot.sources.length,
              createdGroupCount,
              createdHostCount,
              createdSecretCount,
              skippedHostCount,
            },
          );
          queueSync();
        }

        if (warnings.length > 0) {
          activityLogs.append(
            "warn",
            "audit",
            "Xshell 가져오기가 경고와 함께 완료되었습니다.",
            {
              sourceCount: snapshot.sources.length,
              warningCount: warnings.length,
            },
          );
        }

        return {
          createdGroupCount,
          createdHostCount,
          createdSecretCount,
          skippedHostCount,
          warnings,
        };
      } finally {
        xshellImportService.discardSnapshot(input.snapshotId);
      }
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.connect,
    async (_event, input: DesktopConnectInput) => {
      const host = hosts.getById(input.hostId);
      if (!host) {
        throw new Error("Host not found");
      }
      if (isAwsEcsHostRecord(host)) {
        throw new Error("ECS 호스트는 세션 연결 대신 Containers 화면에서 엽니다.");
      }

      if (isAwsEc2HostRecord(host)) {
        const connection = await coreManager.connectAwsSession({
          profileName: host.awsProfileName,
          region: host.awsRegion,
          instanceId: host.awsInstanceId,
          cols: input.cols,
          rows: input.rows,
          hostId: host.id,
          hostLabel: host.label,
          title: input.title?.trim() || host.label,
        });
        sessionReplayService.noteSessionConfigured(
          connection.sessionId,
          input.cols,
          input.rows,
        );
        return connection;
      }

      if (isWarpgateSshHostRecord(host)) {
        const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, {
          hostname: host.warpgateSshHost,
          port: host.warpgateSshPort,
        });
        const title = input.title?.trim() || host.label;
        const connection = await coreManager.connect({
          host: host.warpgateSshHost,
          port: host.warpgateSshPort,
          username: `${host.warpgateUsername}:${host.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64,
          cols: input.cols,
          rows: input.rows,
          command: input.command?.trim() || undefined,
          hostId: host.id,
          hostLabel: host.label,
          title,
          transport: "warpgate",
        });
        sessionReplayService.noteSessionConfigured(
          connection.sessionId,
          input.cols,
          input.rows,
        );
        return connection;
      }

      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
      const username = requireConfiguredSshUsername(host);
      const secrets = mergeSecrets(
        await loadSecrets(secretStore, host.secretRef),
        input.secrets ?? {},
      );
      const title = input.title?.trim() || host.label;
      const connection = await coreManager.connect({
        host: host.hostname,
        port: host.port,
        username,
        authType: host.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        privateKeyPath: host.privateKeyPath ?? undefined,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64,
        cols: input.cols,
        rows: input.rows,
        command: input.command?.trim() || undefined,
        hostId: host.id,
        hostLabel: host.label,
        title,
        transport: "ssh",
      });
      sessionReplayService.noteSessionConfigured(
        connection.sessionId,
        input.cols,
        input.rows,
      );

      if (input.secrets && hasSecretValue(input.secrets)) {
        pendingSessionSecrets.set(connection.sessionId, {
          hostId: host.id,
          label: title,
          secrets,
        });
      }

      return connection;
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.connectLocal,
    async (_event, input: DesktopLocalConnectInput) => {
      return coreManager.connectLocalSession({
        cols: input.cols,
        rows: input.rows,
        title: input.title?.trim() || "Terminal",
        shellKind: input.shellKind?.trim() || undefined,
        executable: input.executable?.trim() || undefined,
        args: input.args?.filter((value) => value.trim().length > 0),
        env: input.env,
        workingDirectory: input.workingDirectory?.trim() || undefined,
      });
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.write,
    async (_event, sessionId: string, data: string) => {
      coreManager.write(sessionId, data);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.writeBinary,
    async (_event, sessionId: string, data: Uint8Array) => {
      coreManager.writeBinary(sessionId, data);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.resize,
    async (_event, sessionId: string, cols: number, rows: number) => {
      sessionReplayService.handleTerminalResize(sessionId, cols, rows);
      coreManager.resize(sessionId, cols, rows);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.disconnect,
    async (_event, sessionId: string) => {
      coreManager.disconnect(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.respondKeyboardInteractive,
    async (_event, input: KeyboardInteractiveRespondInput) => {
      await coreManager.respondKeyboardInteractive(input);
    },
  );

  ipcMain.handle(
    ipcChannels.shell.openExternal,
    async (_event, url: string) => {
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error("외부 링크는 http 또는 https만 열 수 있습니다.");
      }
      await electronShell.openExternal(target.toString());
    },
  );

  ipcMain.handle(ipcChannels.window.getState, async (event) =>
    buildWindowState(resolveWindowFromSender(event.sender)),
  );

  ipcMain.handle(ipcChannels.window.minimize, async (event) => {
    resolveWindowFromSender(event.sender).minimize();
  });

  ipcMain.handle(ipcChannels.window.maximize, async (event) => {
    resolveWindowFromSender(event.sender).maximize();
  });

  ipcMain.handle(ipcChannels.window.restore, async (event) => {
    resolveWindowFromSender(event.sender).restore();
  });

  ipcMain.handle(ipcChannels.window.close, async (event) => {
    resolveWindowFromSender(event.sender).close();
  });

  ipcMain.handle(
    ipcChannels.containers.list,
    async (_event, hostId: string) => {
      const host = hosts.getById(hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        return {
          runtime: null,
          unsupportedReason: runtimeInfo.unsupportedReason,
          containers: [],
        };
      }
      const listing = await coreManager.containersList(runtimeInfo.endpointId);
      return {
        runtime: listing.runtime,
        unsupportedReason: null,
        containers: listing.containers,
      };
    },
  );

  ipcMain.handle(
    ipcChannels.containers.inspect,
    async (_event, hostId: string, containerId: string) => {
      const host = hosts.getById(hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return coreManager.containersInspect(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.logs,
    async (_event, input: HostContainersLogsInput) => {
      const host = hosts.getById(input.hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return coreManager.containersLogs(
        runtimeInfo.endpointId,
        input.containerId,
        input.tail,
        input.followCursor ?? null,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.containers.startTunnel,
    async (_event, input: HostContainersEphemeralTunnelInput) => {
      const host = hosts.getById(input.hostId);
      assertSftpCompatibleHost(host);
      return startContainerTunnelRuntime({
        ruleId: `container-service-tunnel:${randomUUID()}`,
        host,
        containerId: input.containerId,
        networkName: input.networkName,
        targetPort: input.targetPort,
        bindAddress: input.bindAddress,
        bindPort: input.bindPort,
      });
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stopTunnel,
    async (_event, runtimeId: string) => {
      await coreManager.stopPortForward(runtimeId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.start,
    async (_event, hostId: string, containerId: string) => {
      const host = hosts.getById(hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await coreManager.containersStart(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stop,
    async (_event, hostId: string, containerId: string) => {
      const host = hosts.getById(hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await coreManager.containersStop(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.restart,
    async (_event, hostId: string, containerId: string) => {
      const host = hosts.getById(hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await coreManager.containersRestart(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.remove,
    async (_event, hostId: string, containerId: string) => {
      const host = hosts.getById(hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      await coreManager.containersRemove(runtimeInfo.endpointId, containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.stats,
    async (_event, input: HostContainersStatsInput) => {
      const host = hosts.getById(input.hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return coreManager.containersStats(runtimeInfo.endpointId, input.containerId);
    },
  );

  ipcMain.handle(
    ipcChannels.containers.searchLogs,
    async (_event, input: HostContainersSearchLogsInput) => {
      const host = hosts.getById(input.hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (runtimeInfo.unsupportedReason || !runtimeInfo.runtime) {
        throw new Error(
          runtimeInfo.unsupportedReason ||
            "이 host에서는 docker/podman을 사용할 수 없습니다.",
        );
      }
      return coreManager.containersSearchLogs(
        runtimeInfo.endpointId,
        input.containerId,
        input.tail,
        input.query,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.containers.release,
    async (_event, hostId: string) => {
      const endpointId = buildContainersEndpointId(hostId);
      try {
        await coreManager.containersDisconnect(endpointId);
      } finally {
        await stopAwsContainersTunnelForEndpoint(endpointId);
      }
    },
  );

  ipcMain.handle(
    ipcChannels.containers.openShell,
    async (_event, hostId: string, containerId: string) => {
      const host = hosts.getById(hostId);
      assertSftpCompatibleHost(host);
      const runtimeInfo = await ensureContainersEndpoint(host);
      if (!runtimeInfo.runtime || !runtimeInfo.runtimeCommand) {
        throw new Error("컨테이너 런타임을 먼저 확인해 주세요.");
      }
      const title = `${host.label} · ${containerId}`;
      const command = buildContainerShellCommand(
        runtimeInfo.runtimeCommand,
        containerId,
      );

      if (isAwsEc2HostRecord(host)) {
        const hydratedHost =
          consumeAwsSftpPreflight(runtimeInfo.endpointId, host.id) ??
          (await resolveAwsSftpPreflight({
            endpointId: runtimeInfo.endpointId,
            host,
            allowBrowserLogin: true,
          }));
        const sshPort = getAwsEc2HostSshPort(hydratedHost);
        const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, {
          hostname: buildAwsSsmKnownHostIdentity({
            profileName: hydratedHost.awsProfileName,
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
        const { privateKeyPem, publicKey } = createEphemeralAwsSftpKeyPair();
        await awsService.sendSshPublicKey({
          profileName: hydratedHost.awsProfileName,
          region: hydratedHost.awsRegion,
          instanceId: hydratedHost.awsInstanceId,
          availabilityZone,
          osUser: sshUsername,
          publicKey,
        });
        const bindPort = await reserveLoopbackPort();
        const tunnel = await awsSsmTunnelService.start({
          runtimeId: `aws-container-shell:${host.id}:${randomUUID()}`,
          profileName: hydratedHost.awsProfileName,
          region: hydratedHost.awsRegion,
          instanceId: hydratedHost.awsInstanceId,
          bindAddress: "127.0.0.1",
          bindPort,
          targetPort: sshPort,
        });
        try {
          const connection = await coreManager.connect({
            host: tunnel.bindAddress,
            port: tunnel.bindPort,
            username: sshUsername,
            authType: "privateKey",
            privateKeyPem,
            trustedHostKeyBase64,
            cols: 120,
            rows: 32,
            command,
            hostId: hydratedHost.id,
            hostLabel: hydratedHost.label,
            title,
            transport: "aws-ssm",
          });
          awsContainerShellTunnelRuntimeBySessionId.set(
            connection.sessionId,
            tunnel.runtimeId,
          );
          return connection;
        } catch (error) {
          await awsSsmTunnelService
            .stop(tunnel.runtimeId)
            .catch(() => undefined);
          throw error;
        }
      }

      if (isWarpgateSshHostRecord(host)) {
        const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, {
          hostname: host.warpgateSshHost,
          port: host.warpgateSshPort,
        });
        return coreManager.connect({
          host: host.warpgateSshHost,
          port: host.warpgateSshPort,
          username: `${host.warpgateUsername}:${host.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64,
          cols: 120,
          rows: 32,
          command,
          hostId: host.id,
          hostLabel: host.label,
          title,
          transport: "warpgate",
        });
      }

      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
      const username = requireConfiguredSshUsername(host);
      const secrets = await loadSecrets(secretStore, host.secretRef);
      return coreManager.connect({
        host: host.hostname,
        port: host.port,
        username,
        authType: host.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        privateKeyPath: host.privateKeyPath ?? undefined,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64,
        cols: 120,
        rows: 32,
        command,
        hostId: host.id,
        hostLabel: host.label,
        title,
        transport: "ssh",
      });
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.connect,
    async (_event, input: DesktopSftpConnectInput) => {
      const host = hosts.getById(input.hostId);
      assertSftpCompatibleHost(host);

      if (isAwsEc2HostRecord(host)) {
        const endpointId = input.endpointId;
        const hydratedHost =
          consumeAwsSftpPreflight(endpointId, host.id) ??
          (await resolveAwsSftpPreflight({
            endpointId,
            host,
            allowBrowserLogin: true,
          }));
        const sshPort = getAwsEc2HostSshPort(hydratedHost);
        const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, {
          hostname: buildAwsSsmKnownHostIdentity({
            profileName: hydratedHost.awsProfileName,
            region: hydratedHost.awsRegion,
            instanceId: hydratedHost.awsInstanceId,
          }),
          port: sshPort,
        });
        const sshUsername = hydratedHost.awsSshUsername?.trim();
        if (!sshUsername) {
          throw formatSftpStageError(
            "loading-instance-metadata",
            new Error(
              hydratedHost.awsSshMetadataError ||
                "자동으로 SSH 사용자명을 확인하지 못했습니다.",
            ),
          );
        }
        const availabilityZone = hydratedHost.awsAvailabilityZone?.trim();
        if (!availabilityZone) {
          throw formatSftpStageError(
            "checking-ssm",
            new Error("Availability Zone을 확인하지 못했습니다."),
          );
        }

        emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "generating-key",
          message: "임시 SSH 키를 생성하는 중입니다.",
        });
        const { privateKeyPem, publicKey } = createEphemeralAwsSftpKeyPair();

        emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "sending-public-key",
          message: "EC2 Instance Connect로 공개 키를 전송하는 중입니다.",
        });
        try {
          await awsService.sendSshPublicKey({
            profileName: hydratedHost.awsProfileName,
            region: hydratedHost.awsRegion,
            instanceId: hydratedHost.awsInstanceId,
            availabilityZone,
            osUser: sshUsername,
            publicKey,
          });
        } catch (error) {
          throw formatSftpStageError("sending-public-key", error);
        }

        emitSftpConnectionProgress({
          endpointId,
          hostId: hydratedHost.id,
          stage: "opening-tunnel",
          message: "SFTP 연결용 내부 터널을 여는 중입니다.",
        });
        const bindPort = await reserveLoopbackPort();
        let tunnelRuntimeId = "";
        try {
          const tunnel = await awsSsmTunnelService.start({
            runtimeId: `aws-sftp:${endpointId}`,
            profileName: hydratedHost.awsProfileName,
            region: hydratedHost.awsRegion,
            instanceId: hydratedHost.awsInstanceId,
            bindAddress: "127.0.0.1",
            bindPort,
            targetPort: sshPort,
          });
          tunnelRuntimeId = tunnel.runtimeId;

          emitSftpConnectionProgress({
            endpointId,
            hostId: hydratedHost.id,
            stage: "connecting-sftp",
            message: "SFTP 세션을 시작하는 중입니다.",
          });
          const endpoint = await coreManager.sftpConnect({
            endpointId,
            host: tunnel.bindAddress,
            port: tunnel.bindPort,
            username: sshUsername,
            authType: "privateKey",
            privateKeyPem,
            trustedHostKeyBase64,
            hostId: hydratedHost.id,
            title: hydratedHost.label,
          });
          awsSftpTunnelRuntimeByEndpoint.set(endpoint.id, tunnel.runtimeId);
          return endpoint;
        } catch (error) {
          clearAwsSftpPreflight(endpointId);
          if (tunnelRuntimeId) {
            await awsSsmTunnelService
              .stop(tunnelRuntimeId)
              .catch(() => undefined);
          }
          if (error instanceof Error && /^\[/.test(error.message)) {
            throw error;
          }
          throw formatSftpStageError("connecting-sftp", error);
        }
      }

      if (isWarpgateSshHostRecord(host)) {
        const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, {
          hostname: host.warpgateSshHost,
          port: host.warpgateSshPort,
        });
        return coreManager.sftpConnect({
          endpointId: input.endpointId,
          host: host.warpgateSshHost,
          port: host.warpgateSshPort,
          username: `${host.warpgateUsername}:${host.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64,
          hostId: host.id,
          title: host.label,
        });
      }

      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
      const username = requireConfiguredSshUsername(host);
      const secrets = mergeSecrets(
        await loadSecrets(secretStore, host.secretRef),
        input.secrets ?? {},
      );

      const endpoint = await coreManager.sftpConnect({
        endpointId: input.endpointId,
        host: host.hostname,
        port: host.port,
        username,
        authType: host.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        privateKeyPath: host.privateKeyPath ?? undefined,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64,
        hostId: host.id,
        title: host.label,
      });

      if (input.secrets && hasSecretValue(input.secrets)) {
        await persistHostSpecificSecret(host.id, host.label, secrets);
      }

      return endpoint;
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.disconnect,
    async (_event, endpointId: string) => {
      try {
        await coreManager.sftpDisconnect(endpointId);
      } finally {
        await stopAwsSftpTunnelForEndpoint(endpointId);
      }
    },
  );

  ipcMain.handle(ipcChannels.sftp.list, async (_event, input: SftpListInput) =>
    coreManager.sftpList(input),
  );

  ipcMain.handle(
    ipcChannels.sftp.mkdir,
    async (_event, input: SftpMkdirInput) => {
      await coreManager.sftpMkdir(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.rename,
    async (_event, input: SftpRenameInput) => {
      await coreManager.sftpRename(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.chmod,
    async (_event, input: SftpChmodInput) => {
      await coreManager.sftpChmod(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.delete,
    async (_event, input: SftpDeleteInput) => {
      await coreManager.sftpDelete(input);
    },
  );

  ipcMain.handle(
    ipcChannels.sftp.startTransfer,
    async (_event, input: TransferStartInput) =>
      coreManager.startSftpTransfer(input),
  );

  ipcMain.handle(
    ipcChannels.sftp.cancelTransfer,
    async (_event, jobId: string) => {
      await coreManager.cancelSftpTransfer(jobId);
    },
  );

  ipcMain.handle(ipcChannels.portForwards.list, async () => ({
    rules: portForwards.list(),
    runtimes: coreManager.listPortForwardRuntimes(),
  }));

  ipcMain.handle(
    ipcChannels.dnsOverrides.list,
    async () => listResolvedDnsOverrides(),
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.create,
    async (_event, draft: DnsOverrideDraft) => {
      const record = dnsOverrides.create(draft, portForwards);
      try {
        await rewriteActiveDnsOverrides();
      } catch (error) {
        dnsOverrides.remove(record.id);
        throw error;
      }
      activityLogs.append("info", "audit", "DNS override를 생성했습니다.", {
        dnsOverrideId: record.id,
        type: record.type,
        hostname: record.hostname,
        ...(isLinkedDnsOverrideRecord(record)
          ? { portForwardRuleId: record.portForwardRuleId }
          : { address: record.address }),
      });
      queueSync();
      const resolved = listResolvedDnsOverrides().find((entry) => entry.id === record.id);
      if (!resolved) {
        throw new Error("Resolved DNS override was not found after create");
      }
      return resolved;
    },
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.update,
    async (_event, id: string, draft: DnsOverrideDraft) => {
      const previous = dnsOverrides.list();
      const record = dnsOverrides.update(id, draft, portForwards);
      try {
        await rewriteActiveDnsOverrides();
      } catch (error) {
        dnsOverrides.replaceAll(previous);
        throw error;
      }
      activityLogs.append("info", "audit", "DNS override를 수정했습니다.", {
        dnsOverrideId: record.id,
        type: record.type,
        hostname: record.hostname,
        ...(isLinkedDnsOverrideRecord(record)
          ? { portForwardRuleId: record.portForwardRuleId }
          : { address: record.address }),
      });
      queueSync();
      const resolved = listResolvedDnsOverrides().find((entry) => entry.id === record.id);
      if (!resolved) {
        throw new Error("Resolved DNS override was not found after update");
      }
      return resolved;
    },
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.setStaticActive,
    async (_event, id: string, active: boolean) => {
      const record = dnsOverrides.getById(id);
      if (!record || !isStaticDnsOverrideRecord(record)) {
        throw new Error("Static DNS override not found");
      }

      const previousActive = hostsOverrideManager.getActiveStaticOverrideIds().has(id);
      hostsOverrideManager.setStaticOverrideActive(id, active);
      try {
        await rewriteActiveDnsOverrides();
      } catch (error) {
        hostsOverrideManager.setStaticOverrideActive(id, previousActive);
        throw error;
      }

      activityLogs.append(
        "info",
        "audit",
        active ? "Static DNS override를 활성화했습니다." : "Static DNS override를 비활성화했습니다.",
        {
          dnsOverrideId: record.id,
          type: record.type,
          hostname: record.hostname,
          address: record.address,
          active,
        },
      );

      const resolved = listResolvedDnsOverrides().find((entry) => entry.id === record.id);
      if (!resolved) {
        throw new Error("Resolved DNS override was not found after toggle");
      }
      return resolved;
    },
  );

  ipcMain.handle(
    ipcChannels.dnsOverrides.remove,
    async (_event, id: string) => {
      const previous = dnsOverrides.list();
      const current = dnsOverrides.getById(id);
      dnsOverrides.remove(id);
      try {
        await rewriteActiveDnsOverrides();
      } catch (error) {
        dnsOverrides.replaceAll(previous);
        throw error;
      }
      syncOutbox.upsertDeletion("dnsOverrides", id);
      if (current) {
        hostsOverrideManager.removeStaticOverrideState(current.id);
        activityLogs.append("warn", "audit", "DNS override를 삭제했습니다.", {
          dnsOverrideId: current.id,
          type: current.type,
          hostname: current.hostname,
          ...(isLinkedDnsOverrideRecord(current)
            ? { portForwardRuleId: current.portForwardRuleId }
            : { address: current.address }),
        });
      }
      queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.create,
    async (_event, draft: PortForwardDraft) => {
      const host = hosts.getById(draft.hostId);
      if (draft.transport === "aws-ssm") {
        assertAwsEc2Host(host);
      } else if (draft.transport === "ecs-task") {
        assertAwsEcsHost(host);
      } else if (draft.transport === "container") {
        assertSftpCompatibleHost(host);
      } else {
        assertSshHost(host);
      }
      const record = portForwards.create(draft);
      activityLogs.append("info", "audit", "포트 포워딩 규칙을 생성했습니다.", {
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
      queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.update,
    async (_event, id: string, draft: PortForwardDraft) => {
      const host = hosts.getById(draft.hostId);
      if (draft.transport === "aws-ssm") {
        assertAwsEc2Host(host);
      } else if (draft.transport === "ecs-task") {
        assertAwsEcsHost(host);
      } else if (draft.transport === "container") {
        assertSftpCompatibleHost(host);
      } else {
        assertSshHost(host);
      }
      const record = portForwards.update(id, draft);
      activityLogs.append("info", "audit", "포트 포워딩 규칙을 수정했습니다.", {
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
      queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.remove,
    async (_event, id: string) => {
      const current = portForwards.getById(id);
      if (current) {
        await stopPortForwardWithDnsOverrideCleanup(id).catch(() => undefined);
      }
      const linkedOverrides = dnsOverrides
        .list()
        .filter(
          (override) =>
            isLinkedDnsOverrideRecord(override) &&
            override.portForwardRuleId === id,
        );
      for (const override of linkedOverrides) {
        dnsOverrides.remove(override.id);
        syncOutbox.upsertDeletion("dnsOverrides", override.id);
      }
      syncOutbox.upsertDeletion("portForwards", id);
      portForwards.remove(id);
      if (current) {
        activityLogs.append(
          "warn",
          "audit",
          "포트 포워딩 규칙을 삭제했습니다.",
          {
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
          },
        );
      }
      queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.start,
    async (_event, ruleId: string) => {
      const rule = portForwards.getById(ruleId);
      if (!rule) {
        throw new Error("Port forward rule not found");
      }
      const host = hosts.getById(rule.hostId);
      if (rule.transport === "container") {
        assertSftpCompatibleHost(host);
        return startContainerTunnelRuntime({
          ruleId: rule.id,
          host,
          containerId: rule.containerId,
          networkName: rule.networkName,
          targetPort: rule.targetPort,
          bindAddress: "127.0.0.1",
          bindPort: rule.bindPort,
        });
      }
      if (rule.transport === "ecs-task") {
        assertAwsEcsHost(host);
        const publishRuntime = (
          status: "starting" | "error",
          message?: string,
        ) =>
          coreManager.setPortForwardRuntime({
            ruleId: rule.id,
            hostId: host.id,
            transport: "ecs-task",
            mode: "local",
            bindAddress: "127.0.0.1",
            bindPort: rule.bindPort,
            status,
            updatedAt: new Date().toISOString(),
            message,
            startedAt:
              status === "starting"
                ? coreManager
                    .listPortForwardRuntimes()
                    .find((runtime) => runtime.ruleId === rule.id)?.startedAt
                : undefined,
          });

        try {
          publishRuntime("starting", "Checking AWS profile");
          let profileStatus = await awsService.getProfileStatus(
            host.awsProfileName,
          );
          if (!profileStatus.isAuthenticated) {
            if (!profileStatus.isSsoProfile) {
              throw new Error(
                profileStatus.errorMessage ||
                  "이 프로필은 AWS CLI 자격 증명이 필요합니다.",
              );
            }
            publishRuntime("starting", "Opening AWS SSO login");
            await awsService.login(host.awsProfileName);
            publishRuntime("starting", "Checking AWS profile");
            profileStatus = await awsService.getProfileStatus(
              host.awsProfileName,
            );
            if (!profileStatus.isAuthenticated) {
              throw new Error(
                profileStatus.errorMessage ||
                  "AWS SSO 로그인 결과를 확인하지 못했습니다.",
              );
            }
          }

          publishRuntime("starting", "Checking Session Manager plugin");
          await awsService.ensureSessionManagerPluginAvailable();

          publishRuntime("starting", "Resolving running ECS task");
          const targetId = await awsService.resolveEcsTaskTunnelTarget({
            profileName: host.awsProfileName,
            region: host.awsRegion,
            clusterArn: host.awsEcsClusterArn,
            serviceName: rule.serviceName,
            containerName: rule.containerName,
          });

          publishRuntime("starting", "Starting ECS task tunnel");
          return coreManager.startSsmPortForward({
            ruleId: rule.id,
            hostId: host.id,
            profileName: host.awsProfileName,
            region: host.awsRegion,
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
        assertAwsEc2Host(host);
        const publishRuntime = (
          status: "starting" | "error",
          message?: string,
        ) =>
          coreManager.setPortForwardRuntime({
            ruleId: rule.id,
            hostId: host.id,
            transport: "aws-ssm",
            mode: "local",
            bindAddress: rule.bindAddress,
            bindPort: rule.bindPort,
            status,
            updatedAt: new Date().toISOString(),
            message,
            startedAt:
              status === "starting"
                ? coreManager
                    .listPortForwardRuntimes()
                    .find((runtime) => runtime.ruleId === rule.id)?.startedAt
                : undefined,
          });

        try {
          publishRuntime("starting", "Checking AWS profile");
          let profileStatus = await awsService.getProfileStatus(
            host.awsProfileName,
          );
          if (!profileStatus.isAuthenticated) {
            if (!profileStatus.isSsoProfile) {
              throw new Error(
                profileStatus.errorMessage ||
                  "이 프로필은 AWS CLI 자격 증명이 필요합니다.",
              );
            }
            publishRuntime("starting", "Opening AWS SSO login");
            await awsService.login(host.awsProfileName);
            publishRuntime("starting", "Checking AWS profile");
            profileStatus = await awsService.getProfileStatus(
              host.awsProfileName,
            );
            if (!profileStatus.isAuthenticated) {
              throw new Error(
                profileStatus.errorMessage ||
                  "AWS SSO 로그인 결과를 확인하지 못했습니다.",
              );
            }
          }

          publishRuntime("starting", "Checking SSM managed instance");
          const isManaged = await awsService.isManagedInstance(
            host.awsProfileName,
            host.awsRegion,
            host.awsInstanceId,
          );
          if (!isManaged) {
            throw new Error(
              "SSM Agent 또는 managed instance 상태를 확인해 주세요.",
            );
          }

          publishRuntime("starting", "Starting SSM port forward");
          const runtime = await coreManager.startSsmPortForward({
            ruleId: rule.id,
            hostId: host.id,
            profileName: host.awsProfileName,
            region: host.awsRegion,
            targetType: "instance",
            targetId: host.awsInstanceId,
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
            await rewriteActiveDnsOverrides();
          } catch (error) {
            await stopPortForwardWithDnsOverrideCleanup(rule.id).catch(() => undefined);
            publishRuntime(
              "error",
              error instanceof Error ? error.message : "hosts override를 적용하지 못했습니다.",
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

      assertSshHost(host);
      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
      const username = requireConfiguredSshUsername(host);
      const secrets = await loadSecrets(secretStore, host.secretRef);

      const runtime = await coreManager.startPortForward({
        ruleId: rule.id,
        hostId: host.id,
        host: host.hostname,
        port: host.port,
        username,
        authType: host.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        privateKeyPath: host.privateKeyPath ?? undefined,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64,
        mode: rule.mode,
        bindAddress: rule.bindAddress,
        bindPort: rule.bindPort,
        targetHost: rule.targetHost ?? undefined,
        targetPort: rule.targetPort ?? undefined,
      });
      try {
        await rewriteActiveDnsOverrides();
      } catch (error) {
        await stopPortForwardWithDnsOverrideCleanup(rule.id).catch(() => undefined);
        coreManager.setPortForwardRuntime({
          ruleId: rule.id,
          hostId: host.id,
          transport: "ssh",
          mode: rule.mode,
          bindAddress: rule.bindAddress,
          bindPort: rule.bindPort,
          status: "error",
          updatedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : "hosts override를 적용하지 못했습니다.",
        });
        throw error;
      }
      return runtime;
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.stop,
    async (_event, ruleId: string) => {
      await stopPortForwardWithDnsOverrideCleanup(ruleId);
    },
  );

  ipcMain.handle(ipcChannels.knownHosts.list, async () => knownHosts.list());

  ipcMain.handle(
    ipcChannels.knownHosts.probeHost,
    async (_event, input: KnownHostProbeInput) => {
      const emitProgress =
        input.endpointId?.startsWith("containers:")
          ? emitContainersConnectionProgress
          : emitSftpConnectionProgress;
      return buildHostKeyProbeResult(
        hosts,
        knownHosts,
        coreManager,
        awsSsmTunnelService,
        emitProgress,
        resolveAwsSftpPreflight,
        storeAwsSftpPreflight,
        input,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.knownHosts.trust,
    async (_event, input: KnownHostTrustInput) => {
      const record = knownHosts.trust(input);
      activityLogs.append(
        "info",
        "audit",
        "새 호스트 키를 신뢰 목록에 저장했습니다.",
        {
          host: input.host,
          port: input.port,
          fingerprintSha256: input.fingerprintSha256,
        },
      );
      queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.knownHosts.replace,
    async (_event, input: KnownHostTrustInput) => {
      const record = knownHosts.trust(input);
      activityLogs.append("warn", "audit", "호스트 키를 교체했습니다.", {
        host: input.host,
        port: input.port,
        fingerprintSha256: input.fingerprintSha256,
      });
      queueSync();
      return record;
    },
  );

  ipcMain.handle(ipcChannels.knownHosts.remove, async (_event, id: string) => {
    syncOutbox.upsertDeletion("knownHosts", id);
    knownHosts.remove(id);
    activityLogs.append(
      "info",
      "audit",
      "호스트 키를 신뢰 목록에서 제거했습니다.",
      {
        knownHostId: id,
      },
    );
    queueSync();
  });

  ipcMain.handle(ipcChannels.logs.list, async () => activityLogs.list());

  ipcMain.handle(ipcChannels.logs.clear, async () => {
    activityLogs.clear();
  });

  ipcMain.handle(
    ipcChannels.sessionReplays.open,
    async (event, recordingId: string) => {
      await sessionReplayService.openReplayWindow(
        recordingId,
        resolveWindowFromSender(event.sender),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.sessionReplays.get,
    async (_event, recordingId: string) =>
      sessionReplayService.get(recordingId),
  );

  ipcMain.handle(ipcChannels.keychain.list, async () => secretMetadata.list());

  ipcMain.handle(
    ipcChannels.keychain.load,
    async (_event, secretRef: string) => {
      const metadata = secretMetadata.getBySecretRef(secretRef);
      if (!metadata) {
        return null;
      }
      const raw = await secretStore.load(secretRef);
      if (!raw) {
        return null;
      }
      const payload = JSON.parse(raw) as ManagedSecretPayload;
      return {
        ...payload,
        secretRef,
        label: metadata.label,
        source: metadata.source,
        updatedAt: payload.updatedAt ?? metadata.updatedAt,
      } satisfies ManagedSecretPayload;
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.remove,
    async (_event, secretRef: string) => {
      await secretStore.remove(secretRef);
      secretMetadata.remove(secretRef);
      hosts.clearSecretRef(secretRef);
      syncOutbox.upsertDeletion("secrets", secretRef);
      activityLogs.append("warn", "audit", "호스트 secret을 제거했습니다.", {
        secretRef,
      });
      queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.update,
    async (_event, input: KeychainSecretUpdateInput) => {
      const currentMetadata = secretMetadata.getBySecretRef(input.secretRef);
      if (!currentMetadata) {
        throw new Error("Keychain secret not found");
      }

      const currentSecrets = await loadSecrets(secretStore, input.secretRef);
      const mergedSecrets = mergeSecrets(currentSecrets, input.secrets);
      if (!hasSecretValue(mergedSecrets)) {
        throw new Error("업데이트할 secret 값이 없습니다.");
      }

      await secretStore.save(
        input.secretRef,
        JSON.stringify({
          secretRef: input.secretRef,
          label: currentMetadata.label,
          password: mergedSecrets.password,
          passphrase: mergedSecrets.passphrase,
          privateKeyPem: mergedSecrets.privateKeyPem,
          source: currentMetadata.source,
          updatedAt: new Date().toISOString(),
        } satisfies ManagedSecretPayload),
      );
      secretMetadata.upsert({
        secretRef: input.secretRef,
        label: currentMetadata.label,
        hasPassword: Boolean(mergedSecrets.password),
        hasPassphrase: Boolean(mergedSecrets.passphrase),
        hasManagedPrivateKey:
          Boolean(mergedSecrets.privateKeyPem) ||
          currentMetadata.hasManagedPrivateKey,
        source: currentMetadata.source,
      });

      activityLogs.append("info", "audit", "공유 secret을 갱신했습니다.", {
        secretRef: input.secretRef,
      });
      queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.cloneForHost,
    async (_event, input: KeychainSecretCloneInput) => {
      const host = hosts.getById(input.hostId);
      assertSshHost(host);
      if (!host.secretRef || host.secretRef !== input.sourceSecretRef) {
        throw new Error("Host is not linked to the selected keychain secret");
      }

      const currentSecrets = await loadSecrets(
        secretStore,
        input.sourceSecretRef,
      );
      const mergedSecrets = mergeSecrets(currentSecrets, input.secrets);
      if (!hasSecretValue(mergedSecrets)) {
        throw new Error("복제할 secret 값이 없습니다.");
      }

      const nextSecretRef = await persistSecret(
        secretStore,
        secretMetadata,
        describeHostLabel(host),
        mergedSecrets,
      );
      if (!nextSecretRef) {
        throw new Error("새 secret을 생성하지 못했습니다.");
      }

      hosts.updateSecretRef(host.id, nextSecretRef);
      activityLogs.append(
        "info",
        "audit",
        "호스트 전용 secret을 새로 생성했습니다.",
        {
          hostId: host.id,
          sourceSecretRef: input.sourceSecretRef,
          nextSecretRef,
        },
      );
      queueSync();
    },
  );

  ipcMain.handle(ipcChannels.shell.pickPrivateKey, async () => {
    // 사용자가 선택한 개인키 파일을 읽어 managed PEM secret으로 가져오기 위한 선택기다.
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Private keys", extensions: ["pem", "key", "ppk"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.shell.pickOpenSshConfig, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
      filters: [
        { name: "OpenSSH config", extensions: ["config", "conf"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.shell.pickXshellSessionFolder, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: await xshellImportService.getPickerDefaultPath(),
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.tabs.list, async () => coreManager.listTabs());

  ipcMain.handle(ipcChannels.updater.getState, async () => updater.getState());

  ipcMain.handle(ipcChannels.updater.check, async () => {
    await updater.check();
  });

  ipcMain.handle(ipcChannels.updater.download, async () => {
    await updater.download();
  });

  ipcMain.handle(ipcChannels.updater.installAndRestart, async () => {
    await updater.installAndRestart();
  });

  ipcMain.handle(
    ipcChannels.updater.dismissAvailable,
    async (_event, version: string) => {
      await updater.dismissAvailable(version);
    },
  );

  ipcMain.handle(ipcChannels.settings.get, async () => settings.get());

  ipcMain.handle(
    ipcChannels.settings.update,
    async (_event, input: Partial<AppSettings>) => {
      const nextSettings = settings.update(input);
      if (
        Object.prototype.hasOwnProperty.call(
          input,
          "sessionReplayRetentionCount",
        )
      ) {
        sessionReplayService.prune();
      }
      return nextSettings;
    },
  );

  ipcMain.handle(ipcChannels.files.getHomeDirectory, async () =>
    localFiles.getHomeDirectory(),
  );
  ipcMain.handle(ipcChannels.files.getDownloadsDirectory, async () =>
    localFiles.getDownloadsDirectory(),
  );
  ipcMain.handle(
    ipcChannels.files.getParentPath,
    async (_event, targetPath: string) => localFiles.getParentPath(targetPath),
  );

  ipcMain.handle(ipcChannels.files.list, async (_event, targetPath: string) =>
    localFiles.list(targetPath),
  );

  ipcMain.handle(
    ipcChannels.files.mkdir,
    async (_event, targetPath: string, name: string) => {
      await localFiles.mkdir(targetPath, name);
    },
  );

  ipcMain.handle(
    ipcChannels.files.rename,
    async (_event, targetPath: string, nextName: string) => {
      await localFiles.rename(targetPath, nextName);
    },
  );

  ipcMain.handle(
    ipcChannels.files.chmod,
    async (_event, targetPath: string, mode: number) => {
      await localFiles.chmod(targetPath, mode);
    },
  );

  ipcMain.handle(ipcChannels.files.delete, async (_event, paths: string[]) => {
    await localFiles.delete(paths);
  });
}
