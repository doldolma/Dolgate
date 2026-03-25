import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell as electronShell,
} from "electron";
import {
  getGroupLabel,
  getParentGroupPath,
  isAwsEc2HostRecord,
  isWarpgateSshHostRecord,
  isSshHostDraft,
  isSshHostRecord,
  normalizeGroupPath,
} from "@shared";
import type {
  AuthState,
  AppSettings,
  DesktopConnectInput,
  DesktopLocalConnectInput,
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
  PortForwardDraft,
  SessionShareInputToggleInput,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  SftpChmodInput,
  SftpDeleteInput,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  TermiusImportSelectionInput,
  TermiusImportWarning,
  TransferStartInput,
} from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import {
  ActivityLogRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  SyncOutboxRepository,
} from "./database";
import { AuthService } from "./auth-service";
import { AwsService } from "./aws-service";
import { CoreManager } from "./core-manager";
import { LocalFileService } from "./file-service";
import { SecretStore } from "./secret-store";
import { SessionShareService } from "./session-share-service";
import { isSyncAuthenticationError, SyncService } from "./sync-service";
import {
  buildTermiusEntityKey,
  buildTermiusGroupAncestorPaths,
  collectSelectedTermiusGroupPaths,
  collectSelectedTermiusHosts,
  resolveTermiusCredential,
  resolveTermiusHostPort,
  resolveTermiusHostUsername,
  TermiusImportService,
} from "./termius-import-service";
import { UpdateService } from "./update-service";
import { WarpgateService } from "./warpgate-service";

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
  input: KnownHostProbeInput,
): Promise<HostKeyProbeResult> {
  const host = hosts.getById(input.hostId);
  if (!host) {
    throw new Error("Host not found");
  }
  if (!isSshHostRecord(host) && !isWarpgateSshHostRecord(host)) {
    throw new Error("AWS EC2 host는 known_hosts 검증을 사용하지 않습니다.");
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

function describeHostLabel(host: HostDraft | HostRecord): string {
  if (host.kind === "aws-ec2") {
    return host.label || host.awsInstanceName || host.awsInstanceId;
  }
  if (host.kind === "warpgate-ssh") {
    return host.label || `${host.warpgateUsername}:${host.warpgateTargetName}`;
  }
  return host.label || `${host.username}@${host.hostname}`;
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

async function persistImportedTermiusSecret(
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
  knownHosts: KnownHostRepository,
  activityLogs: ActivityLogRepository,
  secretMetadata: SecretMetadataRepository,
  syncOutbox: SyncOutboxRepository,
  secretStore: SecretStore,
  awsService: AwsService,
  warpgateService: WarpgateService,
  coreManager: CoreManager,
  updater: UpdateService,
  authService: AuthService,
  syncService: SyncService,
  termiusImportService: TermiusImportService,
  sessionShareService: SessionShareService,
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

  coreManager.setTerminalEventHandler(async (event) => {
    sessionShareService.handleTerminalEvent(event);
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
    }
  });
  coreManager.setTerminalStreamHandler((sessionId, chunk) => {
    sessionShareService.handleTerminalStream(sessionId, chunk);
  });

  ipcMain.handle(ipcChannels.auth.getState, async () => authService.getState());
  ipcMain.handle(ipcChannels.auth.bootstrap, async () =>
    authService.bootstrap(),
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

  ipcMain.handle(ipcChannels.termius.probeLocal, async () => {
    return termiusImportService.probeLocal();
  });

  ipcMain.handle(
    ipcChannels.termius.discardSnapshot,
    async (_event, snapshotId: string) => {
      termiusImportService.discardSnapshot(snapshotId);
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

      const selectedHosts = collectSelectedTermiusHosts(snapshot, input);
      const selectedGroupPaths = collectSelectedTermiusGroupPaths(
        snapshot,
        input,
      );
      const existingGroupPaths = new Set(
        groups.list().map((group) => group.path),
      );
      const knownSshHosts = new Set(
        hosts
          .list()
          .filter(isSshHostRecord)
          .map((host) =>
            buildSshDuplicateKey(host.hostname, host.port, host.username),
          ),
      );
      const sharedSecretRefs = new Map<string, string>();
      const warnings: TermiusImportWarning[] = [
        ...(snapshot.bundle.meta?.warnings ?? []).map((message) => ({
          message,
        })),
      ];

      let createdGroupCount = 0;
      let createdHostCount = 0;
      let createdSecretCount = 0;
      let skippedHostCount = 0;

      for (const groupPath of selectedGroupPaths) {
        for (const candidatePath of buildTermiusGroupAncestorPaths(groupPath)) {
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
        const label =
          host.name?.trim() || host.address?.trim() || "Imported Host";
        const hostname = host.address?.trim();
        const port = resolveTermiusHostPort(host);
        const username = resolveTermiusHostUsername(host);
        const groupPath = normalizeGroupPath(host.groupPath);
        const hostKey = buildTermiusEntityKey(
          host.id,
          host.localId,
          `${label}|${host.address ?? ""}|${host.groupPath ?? ""}`,
        );

        if (!hostname || !port || !username) {
          warnings.push({
            code: "missing-required-fields",
            message: `${label}: address, port, username 중 일부가 없어 건너뛰었습니다.`,
          });
          skippedHostCount += 1;
          continue;
        }

        const duplicateKey = buildSshDuplicateKey(hostname, port, username);
        if (knownSshHosts.has(duplicateKey)) {
          warnings.push({
            code: "duplicate-host",
            message: `${label}: 동일한 SSH 호스트가 이미 있어 건너뛰었습니다.`,
          });
          skippedHostCount += 1;
          continue;
        }

        for (const candidatePath of buildTermiusGroupAncestorPaths(groupPath)) {
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

        const credential = resolveTermiusCredential(host);
        let secretRef: string | null = null;

        if (credential.hasCredential) {
          const sharedSecretKey =
            credential.sharedSecretKey ?? `host:${hostKey}`;
          const cachedSecretRef = sharedSecretRefs.get(sharedSecretKey);
          if (cachedSecretRef) {
            secretRef = cachedSecretRef;
          } else {
            secretRef = await persistImportedTermiusSecret(
              secretStore,
              secretMetadata,
              credential.sharedSecretLabel,
              credential.secrets,
            );
            if (secretRef) {
              sharedSecretRefs.set(sharedSecretKey, secretRef);
              createdSecretCount += 1;
            }
          }
        } else {
          warnings.push({
            code: "missing-credentials",
            message: `${label}: 저장 가능한 credential이 없어 비밀번호 없이 호스트만 가져왔습니다.`,
          });
        }

        hosts.create(
          randomUUID(),
          {
            kind: "ssh",
            label,
            groupName: groupPath,
            tags: [],
            terminalThemeId: null,
            hostname,
            port,
            username,
            authType: credential.authType,
            privateKeyPath: null,
          },
          secretRef,
        );
        knownSshHosts.add(duplicateKey);
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
          "Termius 로컬 데이터를 가져왔습니다.",
          {
            createdGroupCount,
            createdHostCount,
            createdSecretCount,
            skippedHostCount,
            termiusDataDir: snapshot.bundle.meta?.termiusDataDir ?? null,
          },
        );
        queueSync();
      }

      if (warnings.length > 0) {
        activityLogs.append(
          "warn",
          "audit",
          "Termius import 중 일부 항목을 건너뛰거나 경고가 발생했습니다.",
          {
            warningCount: warnings.length,
          },
        );
      }

      termiusImportService.discardSnapshot(input.snapshotId);
      return {
        createdGroupCount,
        createdHostCount,
        createdSecretCount,
        skippedHostCount,
        warnings,
      };
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.connect,
    async (_event, input: DesktopConnectInput) => {
      const host = hosts.getById(input.hostId);
      if (!host) {
        throw new Error("Host not found");
      }

      if (isAwsEc2HostRecord(host)) {
        return coreManager.connectAwsSession({
          profileName: host.awsProfileName,
          region: host.awsRegion,
          instanceId: host.awsInstanceId,
          cols: input.cols,
          rows: input.rows,
          hostId: host.id,
          title: input.title?.trim() || host.label,
        });
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
          hostId: host.id,
          title,
        });
        return connection;
      }

      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
      const secrets = mergeSecrets(
        await loadSecrets(secretStore, host.secretRef),
        input.secrets ?? {},
      );
      const title = input.title?.trim() || host.label;
      const connection = await coreManager.connect({
        host: host.hostname,
        port: host.port,
        username: host.username,
        authType: host.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        privateKeyPath: host.privateKeyPath ?? undefined,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64,
        cols: input.cols,
        rows: input.rows,
        hostId: host.id,
        title,
      });

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
    ipcChannels.sftp.connect,
    async (_event, input: DesktopSftpConnectInput) => {
      const host = hosts.getById(input.hostId);
      assertSshHost(host);

      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
      const secrets = mergeSecrets(
        await loadSecrets(secretStore, host.secretRef),
        input.secrets ?? {},
      );

      const endpoint = await coreManager.sftpConnect({
        host: host.hostname,
        port: host.port,
        username: host.username,
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
      await coreManager.sftpDisconnect(endpointId);
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
    ipcChannels.portForwards.create,
    async (_event, draft: PortForwardDraft) => {
      const host = hosts.getById(draft.hostId);
      if (draft.transport === "aws-ssm") {
        assertAwsEc2Host(host);
      } else {
        assertSshHost(host);
      }
      const record = portForwards.create(draft);
      activityLogs.append("info", "audit", "포트 포워딩 규칙을 생성했습니다.", {
        ruleId: record.id,
        label: record.label,
        hostId: record.hostId,
        transport: record.transport,
        mode: record.transport === "ssh" ? record.mode : record.targetKind,
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
      } else {
        assertSshHost(host);
      }
      const record = portForwards.update(id, draft);
      activityLogs.append("info", "audit", "포트 포워딩 규칙을 수정했습니다.", {
        ruleId: record.id,
        label: record.label,
        hostId: record.hostId,
        transport: record.transport,
        mode: record.transport === "ssh" ? record.mode : record.targetKind,
      });
      queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.remove,
    async (_event, id: string) => {
      const current = portForwards.getById(id);
      await coreManager.stopPortForward(id).catch(() => undefined);
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
            mode: current.transport === "ssh" ? current.mode : current.targetKind,
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
      if (rule.transport === "aws-ssm") {
        assertAwsEc2Host(host);
        const publishRuntime = (status: "starting" | "error", message?: string) =>
          coreManager.setPortForwardRuntime({
            ruleId: rule.id,
            hostId: host.id,
            transport: "aws-ssm",
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
          let profileStatus = await awsService.getProfileStatus(host.awsProfileName);
          if (!profileStatus.isAuthenticated) {
            if (!profileStatus.isSsoProfile) {
              throw new Error(profileStatus.errorMessage || "이 프로필은 AWS CLI 자격 증명이 필요합니다.");
            }
            publishRuntime("starting", "Opening AWS SSO login");
            await awsService.login(host.awsProfileName);
            publishRuntime("starting", "Checking AWS profile");
            profileStatus = await awsService.getProfileStatus(host.awsProfileName);
            if (!profileStatus.isAuthenticated) {
              throw new Error(profileStatus.errorMessage || "AWS SSO 로그인 결과를 확인하지 못했습니다.");
            }
          }

          publishRuntime("starting", "Checking SSM managed instance");
          const isManaged = await awsService.isManagedInstance(
            host.awsProfileName,
            host.awsRegion,
            host.awsInstanceId,
          );
          if (!isManaged) {
            throw new Error("SSM Agent 또는 managed instance 상태를 확인해 주세요.");
          }

          publishRuntime("starting", "Starting SSM port forward");
          return coreManager.startSsmPortForward({
            ruleId: rule.id,
            hostId: host.id,
            profileName: host.awsProfileName,
            region: host.awsRegion,
            instanceId: host.awsInstanceId,
            bindAddress: "127.0.0.1",
            bindPort: rule.bindPort,
            targetKind: rule.targetKind,
            targetPort: rule.targetPort,
            remoteHost: rule.targetKind === "remote-host" ? rule.remoteHost ?? undefined : undefined,
          });
        } catch (error) {
          publishRuntime(
            "error",
            error instanceof Error ? error.message : "AWS SSM port forward를 시작하지 못했습니다.",
          );
          throw error;
        }
      }

      assertSshHost(host);
      const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
      const secrets = await loadSecrets(secretStore, host.secretRef);

      return coreManager.startPortForward({
        ruleId: rule.id,
        hostId: host.id,
        host: host.hostname,
        port: host.port,
        username: host.username,
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
    },
  );

  ipcMain.handle(
    ipcChannels.portForwards.stop,
    async (_event, ruleId: string) => {
      await coreManager.stopPortForward(ruleId);
    },
  );

  ipcMain.handle(ipcChannels.knownHosts.list, async () => knownHosts.list());

  ipcMain.handle(
    ipcChannels.knownHosts.probeHost,
    async (_event, input: KnownHostProbeInput) => {
      return buildHostKeyProbeResult(hosts, knownHosts, coreManager, input);
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
    async (_event, input: Partial<AppSettings>) => settings.update(input),
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
