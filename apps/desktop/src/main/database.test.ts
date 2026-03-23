import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

type DatabaseModule = typeof import('./database');

async function loadRepositories(): Promise<{
  tempDir: string;
  HostRepository: DatabaseModule['HostRepository'];
  GroupRepository: DatabaseModule['GroupRepository'];
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
});
