import { randomUUID } from 'node:crypto';
import { dialog, ipcMain } from 'electron';
import type {
  AppSettings,
  DesktopConnectInput,
  DesktopSftpConnectInput,
  HostDraft,
  HostSecretInput,
  SftpDeleteInput,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  TransferStartInput
} from '@keyterm/shared';
import { ipcChannels } from '../common/ipc-channels';
import { GroupRepository, HostRepository, SettingsRepository } from './database';
import { CoreManager } from './core-manager';
import { LocalFileService } from './file-service';
import { SecretStore } from './secret-store';

async function persistSecret(secretStore: SecretStore, hostId: string, secrets?: HostSecretInput): Promise<string | null> {
  // 비밀값이 없으면 키체인을 건드리지 않고 바로 빠져나간다.
  if (!secrets?.password && !secrets?.passphrase) {
    return null;
  }

  // host:<id> 규칙을 쓰면 나중에 키체인 항목을 찾고 정리하기 쉽다.
  const secretRef = `host:${hostId}`;
  await secretStore.save(secretRef, JSON.stringify(secrets));
  return secretRef;
}

export function registerIpcHandlers(
  hosts: HostRepository,
  groups: GroupRepository,
  settings: SettingsRepository,
  secretStore: SecretStore,
  coreManager: CoreManager
): void {
  const localFiles = new LocalFileService();

  // renderer는 preload를 통해서만 이 handler들에 접근한다.
  ipcMain.handle(ipcChannels.hosts.list, async () => hosts.list());

  ipcMain.handle(ipcChannels.hosts.create, async (_event, draft: HostDraft, secrets?: HostSecretInput) => {
    const hostId = randomUUID();
    const secretRef = await persistSecret(secretStore, hostId, secrets);
    return hosts.create(hostId, draft, secretRef);
  });

  ipcMain.handle(ipcChannels.hosts.update, async (_event, id: string, draft: HostDraft, secrets?: HostSecretInput) => {
    const current = hosts.getById(id);
    if (!current) {
      throw new Error('Host not found');
    }
    let secretRef = current.secretRef ?? null;
    if (secrets?.password || secrets?.passphrase) {
      secretRef = await persistSecret(secretStore, id, secrets);
    }
    return hosts.update(id, draft, secretRef);
  });

  ipcMain.handle(ipcChannels.hosts.remove, async (_event, id: string) => {
    const current = hosts.getById(id);
    if (current?.secretRef) {
      await secretStore.remove(current.secretRef);
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

    // renderer에는 비밀 참조만 두고, 실제 비밀값 해석은 main 프로세스에서 수행한다.
    let password: string | undefined;
    let passphrase: string | undefined;
    if (host.secretRef) {
      const secretJson = await secretStore.load(host.secretRef);
      if (secretJson) {
        const parsed = JSON.parse(secretJson) as HostSecretInput;
        password = parsed.password;
        passphrase = parsed.passphrase;
      }
    }

    return coreManager.connect({
      host: host.hostname,
      port: host.port,
      username: host.username,
      authType: host.authType,
      password,
      privateKeyPath: host.privateKeyPath ?? undefined,
      passphrase,
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

  ipcMain.handle(ipcChannels.sftp.connect, async (_event, input: DesktopSftpConnectInput) => {
    const host = hosts.getById(input.hostId);
    if (!host) {
      throw new Error('Host not found');
    }

    let password: string | undefined;
    let passphrase: string | undefined;
    if (host.secretRef) {
      const secretJson = await secretStore.load(host.secretRef);
      if (secretJson) {
        const parsed = JSON.parse(secretJson) as HostSecretInput;
        password = parsed.password;
        passphrase = parsed.passphrase;
      }
    }

    return coreManager.sftpConnect({
      host: host.hostname,
      port: host.port,
      username: host.username,
      authType: host.authType,
      password,
      privateKeyPath: host.privateKeyPath ?? undefined,
      passphrase,
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
