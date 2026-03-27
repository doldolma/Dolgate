import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } from '@shared';

type DatabaseModule = typeof import('./database');

async function loadRepositories(): Promise<{
  tempDir: string;
  HostRepository: DatabaseModule['HostRepository'];
  GroupRepository: DatabaseModule['GroupRepository'];
  PortForwardRepository: DatabaseModule['PortForwardRepository'];
  SettingsRepository: DatabaseModule['SettingsRepository'];
}> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolssh-desktop-db-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();

  const stateStorageModule = await import('./state-storage');
  stateStorageModule.resetDesktopStateStorageForTests();
  const databaseModule = await import('./database');

  return {
    tempDir,
    HostRepository: databaseModule.HostRepository,
    GroupRepository: databaseModule.GroupRepository,
    PortForwardRepository: databaseModule.PortForwardRepository,
    SettingsRepository: databaseModule.SettingsRepository
  };
}

async function loadRepositoriesWithStateFile(stateFile: unknown): Promise<{
  tempDir: string;
  SettingsRepository: DatabaseModule['SettingsRepository'];
}> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolssh-desktop-db-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  mkdirSync(path.join(tempDir, 'storage'), { recursive: true });
  writeFileSync(path.join(tempDir, 'storage', 'state.json'), JSON.stringify(stateFile), 'utf8');
  vi.resetModules();

  const stateStorageModule = await import('./state-storage');
  stateStorageModule.resetDesktopStateStorageForTests();
  const databaseModule = await import('./database');

  return {
    tempDir,
    SettingsRepository: databaseModule.SettingsRepository
  };
}

afterEach(() => {
  const tempDir = process.env.DOLSSH_USER_DATA_DIR;
  delete process.env.DOLSSH_USER_DATA_DIR;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe('HostRepository', () => {
  it('persists AWS SFTP metadata on create and update', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const created = hosts.create('aws-host-1', {
      kind: 'aws-ec2',
      label: 'AWS Prod',
      groupName: 'Production',
      tags: ['prod'],
      terminalThemeId: null,
      awsProfileName: 'default',
      awsRegion: 'ap-northeast-2',
      awsInstanceId: 'i-abc',
      awsAvailabilityZone: 'ap-northeast-2a',
      awsInstanceName: 'web-1',
      awsPlatform: 'Linux/UNIX',
      awsPrivateIp: '10.0.0.10',
      awsState: 'running',
      awsSshUsername: 'ubuntu',
      awsSshPort: 2222,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null
    });

    expect(created).toMatchObject({
      kind: 'aws-ec2',
      awsAvailabilityZone: 'ap-northeast-2a',
      awsSshUsername: 'ubuntu',
      awsSshPort: 2222,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null
    });

    const updated = hosts.update('aws-host-1', {
      kind: 'aws-ec2',
      label: 'AWS Prod',
      groupName: 'Production',
      tags: ['prod'],
      terminalThemeId: null,
      awsProfileName: 'default',
      awsRegion: 'ap-northeast-2',
      awsInstanceId: 'i-abc',
      awsAvailabilityZone: 'ap-northeast-2c',
      awsInstanceName: 'web-1',
      awsPlatform: 'Linux/UNIX',
      awsPrivateIp: '10.0.0.10',
      awsState: 'running',
      awsSshUsername: 'ec2-user',
      awsSshPort: 22,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null
    });

    expect(updated).toMatchObject({
      kind: 'aws-ec2',
      awsAvailabilityZone: 'ap-northeast-2c',
      awsSshUsername: 'ec2-user',
      awsSshPort: 22,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null
    });
    expect(hosts.getById('aws-host-1')).toMatchObject({
      kind: 'aws-ec2',
      awsAvailabilityZone: 'ap-northeast-2c',
      awsSshUsername: 'ec2-user',
      awsSshPort: 22,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null
    });
  });
});

describe('GroupRepository.remove', () => {
  it('reparents descendant groups and hosts while preserving existing target paths', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    groups.create('group-branch', 'branch', 'root');
    groups.create('group-branch-leaf', 'leaf', 'root/branch');
    groups.create('group-root-leaf', 'leaf', 'root');

    hosts.create('host-direct', {
      kind: 'ssh',
      label: 'Direct',
      hostname: 'direct.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch',
      tags: [],
      terminalThemeId: null
    });
    hosts.create('host-nested', {
      kind: 'ssh',
      label: 'Nested',
      hostname: 'nested.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch/leaf',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.remove('root/branch', 'reparent-descendants');

    expect(result.groups.map((group) => group.path)).toEqual(['root', 'root/leaf']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([
      ['host-direct', 'root'],
      ['host-nested', 'root/leaf']
    ]);
    expect(result.removedGroupIds).toEqual(['group-branch', 'group-branch-leaf']);
    expect(result.removedHostIds).toEqual([]);
  });

  it('deletes an entire subtree and returns removed host and group ids', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    groups.create('group-branch', 'branch', 'root');
    groups.create('group-branch-leaf', 'leaf', 'root/branch');

    hosts.create('host-root', {
      kind: 'ssh',
      label: 'Root',
      hostname: 'root.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root',
      tags: [],
      terminalThemeId: null
    });
    hosts.create('host-branch', {
      kind: 'ssh',
      label: 'Branch',
      hostname: 'branch.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch',
      tags: [],
      terminalThemeId: null
    });
    hosts.create('host-leaf', {
      kind: 'ssh',
      label: 'Leaf',
      hostname: 'leaf.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch/leaf',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.remove('root/branch', 'delete-subtree');

    expect(result.groups.map((group) => group.path)).toEqual(['root']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-root', 'root']]);
    expect(result.removedGroupIds).toEqual(['group-branch', 'group-branch-leaf']);
    expect(result.removedHostIds).toEqual(['host-branch', 'host-leaf']);
  });

  it('supports deleting an implicit group path that only exists on hosts', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    hosts.create('host-implicit', {
      kind: 'ssh',
      label: 'Implicit',
      hostname: 'implicit.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/implicit',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.remove('root/implicit', 'reparent-descendants');

    expect(result.groups.map((group) => group.path)).toEqual(['root']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-implicit', 'root']]);
    expect(result.removedGroupIds).toEqual([]);
    expect(result.removedHostIds).toEqual([]);
  });
});

describe('SettingsRepository', () => {
  it('persists a login server override and resolves the effective server URL', async () => {
    const { SettingsRepository } = await loadRepositories();
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolssh-desktop',
          redirectUri: 'dolssh://auth/callback'
        }
      })
    } as never);

    expect(settings.get().serverUrl).toBe('https://bundled.example.com');
    expect(settings.get().serverUrlOverride).toBeNull();
    expect(settings.get().terminalScrollbackLines).toBe(5000);
    expect(settings.get().terminalWebglEnabled).toBe(true);

    const updated = settings.update({
      serverUrlOverride: 'https://custom.example.com',
      terminalScrollbackLines: 99999,
      terminalLineHeight: 2.5,
      terminalLetterSpacing: -10,
      terminalMinimumContrastRatio: 99,
      terminalAltIsMeta: true,
      terminalWebglEnabled: false
    });

    expect(updated.serverUrl).toBe('https://custom.example.com');
    expect(updated.serverUrlOverride).toBe('https://custom.example.com');
    expect(updated.terminalScrollbackLines).toBe(25000);
    expect(updated.terminalLineHeight).toBe(2);
    expect(updated.terminalLetterSpacing).toBe(0);
    expect(updated.terminalMinimumContrastRatio).toBe(21);
    expect(updated.terminalAltIsMeta).toBe(true);
    expect(updated.terminalWebglEnabled).toBe(false);

    const reset = settings.update({
      serverUrlOverride: null,
      terminalScrollbackLines: 800,
      terminalLineHeight: 0.5,
      terminalLetterSpacing: 99,
      terminalMinimumContrastRatio: 0,
      terminalAltIsMeta: false,
      terminalWebglEnabled: true
    });

    expect(reset.serverUrl).toBe('https://bundled.example.com');
    expect(reset.serverUrlOverride).toBeNull();
    expect(reset.terminalScrollbackLines).toBe(1000);
    expect(reset.terminalLineHeight).toBe(1);
    expect(reset.terminalLetterSpacing).toBe(2);
    expect(reset.terminalMinimumContrastRatio).toBe(1);
    expect(reset.terminalAltIsMeta).toBe(false);
    expect(reset.terminalWebglEnabled).toBe(true);
  });

  it('stores and syncs the global terminal system theme mode', async () => {
    const { SettingsRepository } = await loadRepositories();
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolssh-desktop',
          redirectUri: 'dolssh://auth/callback'
        }
      })
    } as never);

    const updated = settings.update({
      globalTerminalThemeId: 'system'
    });

    expect(updated.globalTerminalThemeId).toBe('system');
    expect(settings.getSyncedTerminalPreferences()).toEqual({
      id: 'global-terminal',
      globalTerminalThemeId: 'system',
      updatedAt: expect.any(String)
    });

    settings.replaceSyncedTerminalPreferences({
      id: 'global-terminal',
      globalTerminalThemeId: 'system',
      updatedAt: '2026-03-26T00:00:00.000Z'
    });

    expect(settings.get().globalTerminalThemeId).toBe('system');
  });

  it('persists shared SFTP browser column widths and clamps them to minimums', async () => {
    const { SettingsRepository } = await loadRepositories();
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolssh-desktop',
          redirectUri: 'dolssh://auth/callback'
        }
      })
    } as never);

    const updated = settings.update({
      sftpBrowserColumnWidths: {
        name: 420,
        dateModified: 120,
        size: 70,
        kind: 140
      }
    });

    expect(updated.sftpBrowserColumnWidths).toEqual({
      name: 420,
      dateModified: 140,
      size: 72,
      kind: 140
    });
    expect(settings.get().sftpBrowserColumnWidths).toEqual({
      name: 420,
      dateModified: 140,
      size: 72,
      kind: 140
    });
  });

  it('restores missing or invalid SFTP browser widths from the stored state file', async () => {
    const { SettingsRepository } = await loadRepositoriesWithStateFile({
      schemaVersion: 1,
      settings: {
        theme: 'system',
        sftpBrowserColumnWidths: {
          name: 512,
          dateModified: 'bad',
          size: null,
          kind: 48
        },
        serverUrlOverride: null,
        updatedAt: '2026-03-26T00:00:00.000Z'
      }
    });
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolssh-desktop',
          redirectUri: 'dolssh://auth/callback'
        }
      })
    } as never);

    expect(settings.get().sftpBrowserColumnWidths).toEqual({
      ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
      name: 512,
      kind: 72
    });
  });
});

describe('PortForwardRepository', () => {
  it('stores AWS SSM port forward rules with a fixed localhost bind address', async () => {
    const { PortForwardRepository } = await loadRepositories();
    const forwards = new PortForwardRepository();

    const record = forwards.create({
      transport: 'aws-ssm',
      label: 'RDS via bastion',
      hostId: 'aws-host-1',
      bindAddress: '0.0.0.0',
      bindPort: 15432,
      targetKind: 'remote-host',
      targetPort: 5432,
      remoteHost: 'db.internal'
    });

    expect(record).toMatchObject({
      transport: 'aws-ssm',
      bindAddress: '127.0.0.1',
      bindPort: 15432,
      targetKind: 'remote-host',
      targetPort: 5432,
      remoteHost: 'db.internal'
    });
  });
});
