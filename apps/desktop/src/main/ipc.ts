import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dialog, ipcMain, shell as electronShell } from 'electron';
import type {
  AuthState,
  AppSettings,
  DesktopConnectInput,
  DesktopSftpConnectInput,
  HostDraft,
  HostKeyProbeResult,
  HostSecretInput,
  KeychainSecretCloneInput,
  KeychainSecretUpdateInput,
  ManagedSecretPayload,
  KnownHostProbeInput,
  KnownHostTrustInput,
  PortForwardDraft,
  SftpDeleteInput,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  TransferStartInput
} from '@shared';
import { ipcChannels } from '../common/ipc-channels';
import {
  ActivityLogRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  SyncOutboxRepository
} from './database';
import { AuthService } from './auth-service';
import { CoreManager } from './core-manager';
import { LocalFileService } from './file-service';
import { SecretStore } from './secret-store';
import { isSyncAuthenticationError, SyncService } from './sync-service';
import { UpdateService } from './update-service';

async function persistSecret(
  secretStore: SecretStore,
  secretMetadata: SecretMetadataRepository,
  label: string,
  secrets?: HostSecretInput
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
      source: 'local_keychain',
      updatedAt
    } satisfies ManagedSecretPayload)
  );
  secretMetadata.upsert({
    secretRef,
    label,
    hasPassword: Boolean(secrets.password),
    hasPassphrase: Boolean(secrets.passphrase),
    hasManagedPrivateKey: Boolean(secrets.privateKeyPem),
    source: 'local_keychain'
  });
  return secretRef;
}

async function loadSecrets(secretStore: SecretStore, secretRef?: string | null): Promise<ManagedSecretPayload | HostSecretInput> {
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
    label: typeof parsed.label === 'string' ? parsed.label : secretRef,
    password: typeof parsed.password === 'string' ? parsed.password : undefined,
    passphrase: typeof parsed.passphrase === 'string' ? parsed.passphrase : undefined,
    privateKeyPem: typeof parsed.privateKeyPem === 'string' ? parsed.privateKeyPem : undefined,
    source: parsed.source === 'server_managed' ? 'server_managed' : 'local_keychain',
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()
  } satisfies ManagedSecretPayload;
}

function hasSecretValue(secrets: HostSecretInput): boolean {
  return Boolean(secrets.password || secrets.passphrase || secrets.privateKeyPem);
}

function mergeSecrets(current: HostSecretInput, patch: HostSecretInput): HostSecretInput {
  return {
    password: patch.password !== undefined ? patch.password : current.password,
    passphrase: patch.passphrase !== undefined ? patch.passphrase : current.passphrase,
    privateKeyPem: patch.privateKeyPem !== undefined ? patch.privateKeyPem : current.privateKeyPem
  };
}

async function resolveManagedPrivateKeyPem(draft: HostDraft, currentSecretRef: string | null, secretStore: SecretStore): Promise<string | undefined> {
  if (draft.authType !== 'privateKey') {
    return undefined;
  }

  if (draft.privateKeyPath) {
    const pem = await readFile(draft.privateKeyPath, 'utf8');
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

function requireTrustedHostKey(knownHosts: KnownHostRepository, host: { hostname: string; port: number }): string {
  const trusted = knownHosts.getByHostPort(host.hostname, host.port);
  if (!trusted) {
    throw new Error('Host key is not trusted yet.');
  }
  knownHosts.touch(host.hostname, host.port);
  return trusted.publicKeyBase64;
}

async function buildHostKeyProbeResult(
  hosts: HostRepository,
  knownHosts: KnownHostRepository,
  coreManager: CoreManager,
  input: KnownHostProbeInput
): Promise<HostKeyProbeResult> {
  const host = hosts.getById(input.hostId);
  if (!host) {
    throw new Error('Host not found');
  }

  const probed = await coreManager.probeHostKey({
    host: host.hostname,
    port: host.port
  });
  const existing = knownHosts.getByHostPort(host.hostname, host.port);
  const status =
    !existing
      ? 'untrusted'
      : existing.publicKeyBase64 === probed.publicKeyBase64
        ? 'trusted'
        : 'mismatch';

  if (status === 'trusted') {
    knownHosts.touch(host.hostname, host.port);
  }

  return {
    hostId: host.id,
    hostLabel: host.label,
    host: host.hostname,
    port: host.port,
    algorithm: probed.algorithm,
    publicKeyBase64: probed.publicKeyBase64,
    fingerprintSha256: probed.fingerprintSha256,
    status,
    existing
  };
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
  coreManager: CoreManager,
  updater: UpdateService,
  authService: AuthService,
  syncService: SyncService
): void {
  const localFiles = new LocalFileService();
  const queueSync = () => {
    void syncService.pushDirty().catch(() => undefined);
  };

  ipcMain.handle(ipcChannels.auth.getState, async () => authService.getState());
  ipcMain.handle(ipcChannels.auth.bootstrap, async () => authService.bootstrap());
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
      if (isSyncAuthenticationError(error) && authService.getState().status === 'authenticated') {
        await authService.forceUnauthenticated('세션이 만료되었습니다. 다시 로그인해 주세요.');
      }
      throw error;
    }
  });
  ipcMain.handle(ipcChannels.sync.pushDirty, async () => {
    try {
      return await syncService.pushDirty();
    } catch (error) {
      if (isSyncAuthenticationError(error) && authService.getState().status === 'authenticated') {
        await authService.forceUnauthenticated('세션이 만료되었습니다. 다시 로그인해 주세요.');
      }
      throw error;
    }
  });
  ipcMain.handle(ipcChannels.sync.status, async () => syncService.getState());
  ipcMain.handle(ipcChannels.sync.exportDecryptedSnapshot, async () => syncService.exportDecryptedSnapshot());

  // renderer는 preload를 통해서만 이 handler들에 접근한다.
  ipcMain.handle(ipcChannels.hosts.list, async () => hosts.list());

  ipcMain.handle(ipcChannels.hosts.create, async (_event, draft: HostDraft, secrets?: HostSecretInput) => {
    const hostId = randomUUID();
    const resolvedSecrets: HostSecretInput = {
      ...secrets,
      privateKeyPem: await resolveManagedPrivateKeyPem(draft, null, secretStore)
    };
    const secretRef = await persistSecret(secretStore, secretMetadata, draft.label || `${draft.username}@${draft.hostname}`, resolvedSecrets);
    if (secretRef) {
      activityLogs.append('info', 'audit', '호스트 secret이 저장되었습니다.', {
        hostId,
        secretRef
      });
    }
    const record = hosts.create(hostId, draft, secretRef);
    activityLogs.append('info', 'audit', '호스트를 생성했습니다.', {
      hostId: record.id,
      label: record.label,
      hostname: record.hostname,
      groupName: record.groupName ?? null
    });
    queueSync();
    return record;
  });

  ipcMain.handle(ipcChannels.hosts.update, async (_event, id: string, draft: HostDraft, secrets?: HostSecretInput) => {
    const current = hosts.getById(id);
    if (!current) {
      throw new Error('Host not found');
    }
    // draft.secretRef가 명시적으로 null이면 기존 연결을 끊으려는 의도로 해석한다.
    let secretRef = draft.secretRef !== undefined ? draft.secretRef : current.secretRef ?? null;
    const resolvedSecrets: HostSecretInput = {
      ...secrets,
      privateKeyPem: await resolveManagedPrivateKeyPem(draft, current.secretRef ?? null, secretStore)
    };
    if (resolvedSecrets.password || resolvedSecrets.passphrase || resolvedSecrets.privateKeyPem) {
      secretRef = await persistSecret(secretStore, secretMetadata, draft.label || `${draft.username}@${draft.hostname}`, resolvedSecrets);
      activityLogs.append('info', 'audit', '호스트 secret이 갱신되었습니다.', {
        hostId: id,
        secretRef
      });
    } else if (secrets) {
      // "새 키체인" 모드에서 값을 비워 저장한 경우는 기존 secret을 유지한다.
      // 반대로 secrets가 undefined이고 draft.secretRef가 null이면, 사용자가 명시적으로 연결을 해제한 것이다.
      secretRef = current.secretRef ?? null;
    }
    const record = hosts.update(id, draft, secretRef);
    activityLogs.append('info', 'audit', '호스트를 수정했습니다.', {
      hostId: record.id,
      label: record.label,
      hostname: record.hostname,
      groupName: record.groupName ?? null
    });
    queueSync();
    return record;
  });

  ipcMain.handle(ipcChannels.hosts.remove, async (_event, id: string) => {
    const current = hosts.getById(id);
    syncOutbox.upsertDeletion('hosts', id);
    hosts.remove(id);
    if (current) {
      activityLogs.append('warn', 'audit', '호스트를 삭제했습니다.', {
        hostId: current.id,
        label: current.label,
        hostname: current.hostname
      });
    }
    queueSync();
  });

  ipcMain.handle(ipcChannels.groups.list, async () => groups.list());

  ipcMain.handle(ipcChannels.groups.create, async (_event, name: string, parentPath?: string | null) => {
    const group = groups.create(randomUUID(), name, parentPath);
    activityLogs.append('info', 'audit', '그룹을 생성했습니다.', {
      groupId: group.id,
      name: group.name,
      path: group.path,
      parentPath: group.parentPath ?? null
    });
    queueSync();
    return group;
  });

  ipcMain.handle(ipcChannels.ssh.connect, async (_event, input: DesktopConnectInput) => {
    const host = hosts.getById(input.hostId);
    if (!host) {
      throw new Error('Host not found');
    }

    const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
    const secrets = await loadSecrets(secretStore, host.secretRef);

    return coreManager.connect({
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
      title: input.title?.trim() || host.label
    });
  });

  ipcMain.handle(ipcChannels.ssh.write, async (_event, sessionId: string, data: string) => {
    coreManager.write(sessionId, data);
  });

  ipcMain.handle(ipcChannels.ssh.writeBinary, async (_event, sessionId: string, data: Uint8Array) => {
    coreManager.writeBinary(sessionId, data);
  });

  ipcMain.handle(ipcChannels.ssh.resize, async (_event, sessionId: string, cols: number, rows: number) => {
    coreManager.resize(sessionId, cols, rows);
  });

  ipcMain.handle(ipcChannels.ssh.disconnect, async (_event, sessionId: string) => {
    coreManager.disconnect(sessionId);
  });

  ipcMain.handle(ipcChannels.shell.openExternal, async (_event, url: string) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error('외부 링크는 http 또는 https만 열 수 있습니다.');
    }
    await electronShell.openExternal(target.toString());
  });

  ipcMain.handle(ipcChannels.sftp.connect, async (_event, input: DesktopSftpConnectInput) => {
    const host = hosts.getById(input.hostId);
    if (!host) {
      throw new Error('Host not found');
    }

    const trustedHostKeyBase64 = requireTrustedHostKey(knownHosts, host);
    const secrets = await loadSecrets(secretStore, host.secretRef);

    return coreManager.sftpConnect({
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
      title: host.label
    });
  });

  ipcMain.handle(ipcChannels.sftp.disconnect, async (_event, endpointId: string) => {
    await coreManager.sftpDisconnect(endpointId);
  });

  ipcMain.handle(ipcChannels.sftp.list, async (_event, input: SftpListInput) => coreManager.sftpList(input));

  ipcMain.handle(ipcChannels.sftp.mkdir, async (_event, input: SftpMkdirInput) => {
    await coreManager.sftpMkdir(input);
  });

  ipcMain.handle(ipcChannels.sftp.rename, async (_event, input: SftpRenameInput) => {
    await coreManager.sftpRename(input);
  });

  ipcMain.handle(ipcChannels.sftp.delete, async (_event, input: SftpDeleteInput) => {
    await coreManager.sftpDelete(input);
  });

  ipcMain.handle(ipcChannels.sftp.startTransfer, async (_event, input: TransferStartInput) => coreManager.startSftpTransfer(input));

  ipcMain.handle(ipcChannels.sftp.cancelTransfer, async (_event, jobId: string) => {
    await coreManager.cancelSftpTransfer(jobId);
  });

  ipcMain.handle(ipcChannels.portForwards.list, async () => ({
    rules: portForwards.list(),
    runtimes: coreManager.listPortForwardRuntimes()
  }));

  ipcMain.handle(ipcChannels.portForwards.create, async (_event, draft: PortForwardDraft) => {
    const record = portForwards.create(draft);
    activityLogs.append('info', 'audit', '포트 포워딩 규칙을 생성했습니다.', {
      ruleId: record.id,
      label: record.label,
      hostId: record.hostId,
      mode: record.mode
    });
    queueSync();
    return record;
  });

  ipcMain.handle(ipcChannels.portForwards.update, async (_event, id: string, draft: PortForwardDraft) => {
    const record = portForwards.update(id, draft);
    activityLogs.append('info', 'audit', '포트 포워딩 규칙을 수정했습니다.', {
      ruleId: record.id,
      label: record.label,
      hostId: record.hostId,
      mode: record.mode
    });
    queueSync();
    return record;
  });

  ipcMain.handle(ipcChannels.portForwards.remove, async (_event, id: string) => {
    const current = portForwards.getById(id);
    await coreManager.stopPortForward(id).catch(() => undefined);
    syncOutbox.upsertDeletion('portForwards', id);
    portForwards.remove(id);
    if (current) {
      activityLogs.append('warn', 'audit', '포트 포워딩 규칙을 삭제했습니다.', {
        ruleId: current.id,
        label: current.label,
        hostId: current.hostId,
        mode: current.mode
      });
    }
    queueSync();
  });

  ipcMain.handle(ipcChannels.portForwards.start, async (_event, ruleId: string) => {
    const rule = portForwards.getById(ruleId);
    if (!rule) {
      throw new Error('Port forward rule not found');
    }
    const host = hosts.getById(rule.hostId);
    if (!host) {
      throw new Error('Host not found');
    }

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
      targetPort: rule.targetPort ?? undefined
    });
  });

  ipcMain.handle(ipcChannels.portForwards.stop, async (_event, ruleId: string) => {
    await coreManager.stopPortForward(ruleId);
  });

  ipcMain.handle(ipcChannels.knownHosts.list, async () => knownHosts.list());

  ipcMain.handle(ipcChannels.knownHosts.probeHost, async (_event, input: KnownHostProbeInput) => {
    return buildHostKeyProbeResult(hosts, knownHosts, coreManager, input);
  });

  ipcMain.handle(ipcChannels.knownHosts.trust, async (_event, input: KnownHostTrustInput) => {
    const record = knownHosts.trust(input);
    activityLogs.append('info', 'audit', '새 호스트 키를 신뢰 목록에 저장했습니다.', {
      host: input.host,
      port: input.port,
      fingerprintSha256: input.fingerprintSha256
    });
    queueSync();
    return record;
  });

  ipcMain.handle(ipcChannels.knownHosts.replace, async (_event, input: KnownHostTrustInput) => {
    const record = knownHosts.trust(input);
    activityLogs.append('warn', 'audit', '호스트 키를 교체했습니다.', {
      host: input.host,
      port: input.port,
      fingerprintSha256: input.fingerprintSha256
    });
    queueSync();
    return record;
  });

  ipcMain.handle(ipcChannels.knownHosts.remove, async (_event, id: string) => {
    syncOutbox.upsertDeletion('knownHosts', id);
    knownHosts.remove(id);
    activityLogs.append('info', 'audit', '호스트 키를 신뢰 목록에서 제거했습니다.', {
      knownHostId: id
    });
    queueSync();
  });

  ipcMain.handle(ipcChannels.logs.list, async () => activityLogs.list());

  ipcMain.handle(ipcChannels.logs.clear, async () => {
    activityLogs.clear();
  });

  ipcMain.handle(ipcChannels.keychain.list, async () => secretMetadata.list());

  ipcMain.handle(ipcChannels.keychain.load, async (_event, secretRef: string) => {
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
      updatedAt: payload.updatedAt ?? metadata.updatedAt
    } satisfies ManagedSecretPayload;
  });

  ipcMain.handle(ipcChannels.keychain.remove, async (_event, secretRef: string) => {
    await secretStore.remove(secretRef);
    secretMetadata.remove(secretRef);
    hosts.clearSecretRef(secretRef);
    syncOutbox.upsertDeletion('secrets', secretRef);
    activityLogs.append('warn', 'audit', '호스트 secret을 제거했습니다.', {
      secretRef
    });
    queueSync();
  });

  ipcMain.handle(ipcChannels.keychain.update, async (_event, input: KeychainSecretUpdateInput) => {
    const currentMetadata = secretMetadata.getBySecretRef(input.secretRef);
    if (!currentMetadata) {
      throw new Error('Keychain secret not found');
    }

    const currentSecrets = await loadSecrets(secretStore, input.secretRef);
    const mergedSecrets = mergeSecrets(currentSecrets, input.secrets);
    if (!hasSecretValue(mergedSecrets)) {
      throw new Error('업데이트할 secret 값이 없습니다.');
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
        updatedAt: new Date().toISOString()
      } satisfies ManagedSecretPayload)
    );
    secretMetadata.upsert({
      secretRef: input.secretRef,
      label: currentMetadata.label,
      hasPassword: Boolean(mergedSecrets.password),
      hasPassphrase: Boolean(mergedSecrets.passphrase),
      hasManagedPrivateKey: Boolean(mergedSecrets.privateKeyPem) || currentMetadata.hasManagedPrivateKey,
      source: currentMetadata.source
    });

    activityLogs.append('info', 'audit', '공유 secret을 갱신했습니다.', {
      secretRef: input.secretRef
    });
    queueSync();
  });

  ipcMain.handle(ipcChannels.keychain.cloneForHost, async (_event, input: KeychainSecretCloneInput) => {
    const host = hosts.getById(input.hostId);
    if (!host) {
      throw new Error('Host not found');
    }
    if (!host.secretRef || host.secretRef !== input.sourceSecretRef) {
      throw new Error('Host is not linked to the selected keychain secret');
    }

    const currentSecrets = await loadSecrets(secretStore, input.sourceSecretRef);
    const mergedSecrets = mergeSecrets(currentSecrets, input.secrets);
    if (!hasSecretValue(mergedSecrets)) {
      throw new Error('복제할 secret 값이 없습니다.');
    }

    const nextSecretRef = await persistSecret(secretStore, secretMetadata, host.label || `${host.username}@${host.hostname}`, mergedSecrets);
    if (!nextSecretRef) {
      throw new Error('새 secret을 생성하지 못했습니다.');
    }

    hosts.updateSecretRef(host.id, nextSecretRef);
    activityLogs.append('info', 'audit', '호스트 전용 secret을 새로 생성했습니다.', {
      hostId: host.id,
      sourceSecretRef: input.sourceSecretRef,
      nextSecretRef
    });
    queueSync();
  });

  ipcMain.handle(ipcChannels.shell.pickPrivateKey, async () => {
    // 사용자가 선택한 개인키 파일을 읽어 managed PEM secret으로 가져오기 위한 선택기다.
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Private keys', extensions: ['pem', 'key', 'ppk'] },
        { name: 'All files', extensions: ['*'] }
      ]
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

  ipcMain.handle(ipcChannels.updater.dismissAvailable, async (_event, version: string) => {
    await updater.dismissAvailable(version);
  });

  ipcMain.handle(ipcChannels.settings.get, async () => settings.get());

  ipcMain.handle(ipcChannels.settings.update, async (_event, input: Partial<AppSettings>) => settings.update(input));

  ipcMain.handle(ipcChannels.files.getHomeDirectory, async () => localFiles.getHomeDirectory());

  ipcMain.handle(ipcChannels.files.list, async (_event, targetPath: string) => localFiles.list(targetPath));

  ipcMain.handle(ipcChannels.files.mkdir, async (_event, targetPath: string, name: string) => {
    await localFiles.mkdir(targetPath, name);
  });

  ipcMain.handle(ipcChannels.files.rename, async (_event, targetPath: string, nextName: string) => {
    await localFiles.rename(targetPath, nextName);
  });

  ipcMain.handle(ipcChannels.files.delete, async (_event, paths: string[]) => {
    await localFiles.delete(paths);
  });
}
