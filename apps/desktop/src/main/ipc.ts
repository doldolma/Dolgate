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
  DesktopBootstrapSnapshot,
  DesktopConnectInput,
  DesktopSyncedWorkspaceSnapshot,
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
import { registerAuthIpcHandlers } from "./ipc/auth";
import { registerAwsIpcHandlers } from "./ipc/aws";
import { registerContainersIpcHandlers } from "./ipc/containers";
import type { MainIpcContext } from "./ipc/context";
import { registerHostsGroupsIpcHandlers } from "./ipc/hosts-groups";
import { registerImportIpcHandlers } from "./ipc/imports";
import { registerKnownHostsLogsKeychainIpcHandlers } from "./ipc/known-hosts-logs-keychain";
import { registerPortForwardAndDnsIpcHandlers } from "./ipc/port-forwards-dns";
import { registerSessionShareIpcHandlers } from "./ipc/session-shares";
import { registerSftpIpcHandlers } from "./ipc/sftp";
import { registerSshIpcHandlers } from "./ipc/ssh";
import { registerSyncIpcHandlers } from "./ipc/sync";
import { registerWindowUpdaterSettingsFilesIpcHandlers } from "./ipc/window-updater-settings-files";

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
  stage: AwsSftpProgressStage | "connecting-containers";
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
  awsService: AwsService,
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
        const probed = await coreManager.probeHostKey({
          host: tunnel.bindAddress,
          port: tunnel.bindPort,
        });
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
  const listPortForwardSnapshot = () => ({
    rules: portForwards.list(),
    runtimes: coreManager.listPortForwardRuntimes(),
  });
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
  const awsContainersHydratedHostByEndpoint = new Map<
    string,
    Extract<HostRecord, { kind: "aws-ec2" }>
  >();
  const awsContainerShellTunnelRuntimeBySessionId = new Map<string, string>();
  const awsSftpPreflightByEndpointId = new Map<
    string,
    AwsSftpPreflightCacheEntry
  >();
  const listResolvedDnsOverrides = () => {
    const overrides = dnsOverrides.list();
    const portForwardSnapshot = listPortForwardSnapshot();
    hostsOverrideManager.pruneStaticOverrideStates(
      overrides.filter(isStaticDnsOverrideRecord).map((record) => record.id),
    );
    return resolveDnsOverrideRecords(
      overrides,
      portForwardSnapshot.rules,
      portForwardSnapshot.runtimes,
      hostsOverrideManager.getActiveStaticOverrideIds(),
    );
  };
  const getInitialBootstrapSnapshot =
    async (): Promise<DesktopBootstrapSnapshot> => {
      const [
        nextHosts,
        nextGroups,
        tabs,
        nextSettings,
        localHomePath,
        portForwardSnapshot,
        resolvedDnsOverrides,
        nextKnownHosts,
        nextActivityLogs,
        nextKeychainEntries,
      ] = await Promise.all([
        hosts.list(),
        groups.list(),
        coreManager.listTabs(),
        settings.get(),
        localFiles.getHomeDirectory(),
        Promise.resolve(listPortForwardSnapshot()),
        Promise.resolve(listResolvedDnsOverrides()),
        knownHosts.list(),
        activityLogs.list(),
        secretMetadata.list(),
      ]);
      const localHomeListing = await localFiles.list(localHomePath);
      return {
        hosts: nextHosts,
        groups: nextGroups,
        tabs,
        settings: nextSettings,
        localHomePath,
        localHomeListing,
        portForwardSnapshot,
        dnsOverrides: resolvedDnsOverrides,
        knownHosts: nextKnownHosts,
        activityLogs: nextActivityLogs,
        keychainEntries: nextKeychainEntries,
      };
    };
  const getSyncedWorkspaceSnapshot =
    async (): Promise<DesktopSyncedWorkspaceSnapshot> => ({
      hosts: hosts.list(),
      groups: groups.list(),
      settings: settings.get(),
      portForwardSnapshot: listPortForwardSnapshot(),
      dnsOverrides: listResolvedDnsOverrides(),
      knownHosts: knownHosts.list(),
      keychainEntries: secretMetadata.list(),
    });

  const sendToAllWindows = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  };
  const emitSftpConnectionProgress: AwsConnectionProgressEmitter = (event) => {
    sendToAllWindows(ipcChannels.sftp.connectionProgress, event);
  };

  const emitContainersConnectionProgress = (event: {
    endpointId: string;
    hostId: string;
    stage: AwsSftpProgressStage | "connecting-containers";
    message: string;
  }) => {
    sendToAllWindows(ipcChannels.containers.connectionProgress, event);
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
    awsContainersHydratedHostByEndpoint.delete(endpointId);
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
      await awsService.ensureSessionManagerPluginAvailable();
      const refreshedHost = await hydrateAwsHostForSftp(
        hosts,
        awsService,
        host,
        queueSync,
      );
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
    hydratedHost?: Extract<HostRecord, { kind: "aws-ec2" }> | null;
  }> {
    const existingRuntime =
      coreManager.getContainersEndpointRuntime(endpointId);
    if (existingRuntime) {
      return {
        endpointId,
        runtime: existingRuntime.runtime,
        runtimeCommand: existingRuntime.runtimeCommand,
        unsupportedReason: existingRuntime.unsupportedReason,
        hydratedHost: isAwsEc2HostRecord(host)
          ? (awsContainersHydratedHostByEndpoint.get(endpointId) ?? null)
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

      const { privateKeyPem, publicKey } = createEphemeralAwsSftpKeyPair();
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
      const bindPort = await reserveLoopbackPort();
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
          awsContainersHydratedHostByEndpoint.set(endpointId, hydratedHost);
        } else {
          awsContainersHydratedHostByEndpoint.delete(endpointId);
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
        awsContainersHydratedHostByEndpoint.delete(endpointId);
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
        hydratedHost: null,
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
      hydratedHost: null,
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
  const ctx: MainIpcContext = {
    hosts,
    groups,
    settings,
    portForwards,
    dnsOverrides,
    knownHosts,
    activityLogs,
    secretMetadata,
    syncOutbox,
    secretStore,
    awsService,
    awsSsmTunnelService,
    warpgateService,
    coreManager,
    hostsOverrideManager,
    updater,
    authService,
    syncService,
    termiusImportService,
    opensshImportService,
    xshellImportService,
    sessionShareService,
    sessionReplayService,
    localFiles,
    portForwardLifecycleLogger,
    queueSync,
    getInitialBootstrapSnapshot,
    getSyncedWorkspaceSnapshot,
    listPortForwardSnapshot,
    listResolvedDnsOverrides,
    emitSftpConnectionProgress,
    emitContainersConnectionProgress,
    pendingSessionSecrets,
    trackAwsSftpTunnelRuntime: (endpointId, runtimeId) => {
      awsSftpTunnelRuntimeByEndpoint.set(endpointId, runtimeId);
    },
    trackAwsContainerShellTunnelRuntime: (sessionId, runtimeId) => {
      awsContainerShellTunnelRuntimeBySessionId.set(sessionId, runtimeId);
    },
    stopAwsSftpTunnelForEndpoint,
    buildContainersEndpointId,
    buildContainerPortForwardEndpointId,
    stopAwsContainersTunnelForEndpoint,
    moveAwsContainersTunnelRuntime,
    stopAwsContainerShellTunnelForSession,
    storeAwsSftpPreflight,
    clearAwsSftpPreflight,
    consumeAwsSftpPreflight,
    rewriteActiveDnsOverrides,
    stopPortForwardWithDnsOverrideCleanup,
    persistHostSpecificSecret,
    resolveAwsSftpPreflight,
    ensureContainersEndpoint,
    startContainerTunnelRuntime,
    resolveWindowFromSender,
    buildWindowState,
    persistSecret: (label, secrets) =>
      persistSecret(secretStore, secretMetadata, label, secrets),
    persistImportedSecret: (label, secrets) =>
      persistImportedSecret(secretStore, secretMetadata, label, secrets),
    loadSecrets: (secretRef) =>
      loadSecrets(secretStore, secretRef) as Promise<HostSecretInput>,
    hasSecretValue,
    mergeSecrets,
    resolveManagedPrivateKeyPem: (draft, currentSecretRef) =>
      resolveManagedPrivateKeyPem(draft, currentSecretRef, secretStore),
    requireTrustedHostKey: (host) => requireTrustedHostKey(knownHosts, host),
    requireConfiguredSshUsername,
    buildKnownSshDuplicateKeys: () => buildKnownSshDuplicateKeys(hosts),
    assertSshHost,
    assertSftpCompatibleHost,
    assertAwsEc2Host,
    assertAwsEcsHost,
    describeHostLabel,
    describeHostTarget,
    buildHostKeyProbeResult: (emitProgress, input) =>
      buildHostKeyProbeResult(
        hosts,
        knownHosts,
        coreManager,
        awsService,
        awsSsmTunnelService,
        emitProgress,
        resolveAwsSftpPreflight,
        storeAwsSftpPreflight,
        input,
      ),
    loadAwsHostSshMetadataRecord: (host) =>
      loadAwsHostSshMetadataRecord(hosts, awsService, host, queueSync),
    normalizeEcsExecPermissionError,
    createEphemeralAwsSftpKeyPair,
    reserveLoopbackPort,
    buildContainerShellCommand,
    formatSftpStageError,
  };

  registerAuthIpcHandlers(ctx);
  registerSyncIpcHandlers(ctx);
  registerSessionShareIpcHandlers(ctx);
  registerHostsGroupsIpcHandlers(ctx);
  registerAwsIpcHandlers(ctx);
  registerImportIpcHandlers(ctx);
  registerSshIpcHandlers(ctx);
  registerContainersIpcHandlers(ctx);
  registerSftpIpcHandlers(ctx);
  registerPortForwardAndDnsIpcHandlers(ctx);
  registerKnownHostsLogsKeychainIpcHandlers(ctx);
  registerWindowUpdaterSettingsFilesIpcHandlers(ctx);
}
