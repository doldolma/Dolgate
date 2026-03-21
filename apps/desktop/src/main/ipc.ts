import { randomUUID } from 'node:crypto';
import { dialog, ipcMain, shell as electronShell } from 'electron';
import type {
  AppSettings,
  DesktopConnectInput,
  DesktopSftpConnectInput,
  HostDraft,
  HostKeyProbeResult,
  HostSecretInput,
  KnownHostProbeInput,
  KnownHostTrustInput,
  PortForwardDraft,
  SftpDeleteInput,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  TransferStartInput
} from '@dolssh/shared';
import { ipcChannels } from '../common/ipc-channels';
import {
  ActivityLogRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository
} from './database';
import { CoreManager } from './core-manager';
import { LocalFileService } from './file-service';
import { SecretStore } from './secret-store';
import { UpdateService } from './update-service';

async function persistSecret(
  secretStore: SecretStore,
  secretMetadata: SecretMetadataRepository,
  hostId: string,
  secrets?: HostSecretInput
): Promise<string | null> {
  // 비밀값이 없으면 키체인을 건드리지 않고 바로 빠져나간다.
  if (!secrets?.password && !secrets?.passphrase) {
    return null;
  }

  // host:<id> 규칙을 쓰면 나중에 키체인 항목을 찾고 정리하기 쉽다.
  const secretRef = `host:${hostId}`;
  await secretStore.save(secretRef, JSON.stringify(secrets));
  secretMetadata.upsert({
    hostId,
    secretRef,
    hasPassword: Boolean(secrets.password),
    hasPassphrase: Boolean(secrets.passphrase),
    hasManagedPrivateKey: false,
    source: 'local_keychain'
  });
  return secretRef;
}

async function loadSecrets(secretStore: SecretStore, secretRef?: string | null): Promise<HostSecretInput> {
  if (!secretRef) {
    return {};
  }
  const secretJson = await secretStore.load(secretRef);
  if (!secretJson) {
    return {};
  }
  return JSON.parse(secretJson) as HostSecretInput;
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
  secretStore: SecretStore,
  coreManager: CoreManager,
  updater: UpdateService
): void {
  const localFiles = new LocalFileService();

  // renderer는 preload를 통해서만 이 handler들에 접근한다.
  ipcMain.handle(ipcChannels.hosts.list, async () => hosts.list());

  ipcMain.handle(ipcChannels.hosts.create, async (_event, draft: HostDraft, secrets?: HostSecretInput) => {
    const hostId = randomUUID();
    const secretRef = await persistSecret(secretStore, secretMetadata, hostId, secrets);
    if (secretRef) {
      activityLogs.append('info', 'keychain', '호스트 secret이 로컬 키체인에 저장되었습니다.', {
        hostId,
        secretRef
      });
    }
    return hosts.create(hostId, draft, secretRef);
  });

  ipcMain.handle(ipcChannels.hosts.update, async (_event, id: string, draft: HostDraft, secrets?: HostSecretInput) => {
    const current = hosts.getById(id);
    if (!current) {
      throw new Error('Host not found');
    }
    let secretRef = current.secretRef ?? null;
    if (secrets?.password || secrets?.passphrase) {
      secretRef = await persistSecret(secretStore, secretMetadata, id, secrets);
      activityLogs.append('info', 'keychain', '호스트 secret이 갱신되었습니다.', {
        hostId: id,
        secretRef
      });
    }
    return hosts.update(id, draft, secretRef);
  });

  ipcMain.handle(ipcChannels.hosts.remove, async (_event, id: string) => {
    const current = hosts.getById(id);
    if (current?.secretRef) {
      await secretStore.remove(current.secretRef);
      secretMetadata.removeByHostId(id);
      activityLogs.append('info', 'keychain', '호스트 secret이 삭제되었습니다.', {
        hostId: id,
        secretRef: current.secretRef
      });
    }
    hosts.remove(id);
  });

  ipcMain.handle(ipcChannels.groups.list, async () => groups.list());

  ipcMain.handle(ipcChannels.groups.create, async (_event, name: string, parentPath?: string | null) => {
    return groups.create(randomUUID(), name, parentPath);
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
      privateKeyPath: host.privateKeyPath ?? undefined,
      passphrase: secrets.passphrase,
      trustedHostKeyBase64,
      cols: input.cols,
      rows: input.rows,
      hostId: host.id,
      title: host.label
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
    return portForwards.create(draft);
  });

  ipcMain.handle(ipcChannels.portForwards.update, async (_event, id: string, draft: PortForwardDraft) => {
    return portForwards.update(id, draft);
  });

  ipcMain.handle(ipcChannels.portForwards.remove, async (_event, id: string) => {
    await coreManager.stopPortForward(id).catch(() => undefined);
    portForwards.remove(id);
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
    activityLogs.append('info', 'known_hosts', '새 호스트 키를 신뢰 목록에 저장했습니다.', {
      host: input.host,
      port: input.port,
      fingerprintSha256: input.fingerprintSha256
    });
    return record;
  });

  ipcMain.handle(ipcChannels.knownHosts.replace, async (_event, input: KnownHostTrustInput) => {
    const record = knownHosts.trust(input);
    activityLogs.append('warn', 'known_hosts', '호스트 키를 교체했습니다.', {
      host: input.host,
      port: input.port,
      fingerprintSha256: input.fingerprintSha256
    });
    return record;
  });

  ipcMain.handle(ipcChannels.knownHosts.remove, async (_event, id: string) => {
    knownHosts.remove(id);
    activityLogs.append('info', 'known_hosts', '호스트 키를 신뢰 목록에서 제거했습니다.', {
      knownHostId: id
    });
  });

  ipcMain.handle(ipcChannels.logs.list, async () => activityLogs.list());

  ipcMain.handle(ipcChannels.logs.clear, async () => {
    activityLogs.clear();
  });

  ipcMain.handle(ipcChannels.keychain.list, async () => secretMetadata.list());

  ipcMain.handle(ipcChannels.keychain.removeForHost, async (_event, hostId: string) => {
    const host = hosts.getById(hostId);
    if (!host?.secretRef) {
      return;
    }
    await secretStore.remove(host.secretRef);
    secretMetadata.removeByHostId(hostId);
    hosts.updateSecretRef(hostId, null);
    activityLogs.append('info', 'keychain', '호스트 secret이 키체인에서 제거되었습니다.', {
      hostId,
      secretRef: host.secretRef
    });
  });

  ipcMain.handle(ipcChannels.shell.pickPrivateKey, async () => {
    // 개인키 인증은 MVP에서 파일 경로 선택 방식으로 단순화했다.
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
