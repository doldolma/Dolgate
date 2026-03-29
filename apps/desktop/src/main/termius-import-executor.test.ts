import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TermiusImportSelectionInput } from '@shared';
import type { TermiusExportBundle, TermiusExportHost, TermiusSnapshot } from './termius-import-service';
import { buildTermiusEntityKey } from './termius-import-service';
import { importTermiusSelection } from './termius-import-executor';

type DatabaseModule = typeof import('./database');

async function loadRepositories(): Promise<{
  tempDir: string;
  HostRepository: DatabaseModule['HostRepository'];
  GroupRepository: DatabaseModule['GroupRepository'];
  ActivityLogRepository: DatabaseModule['ActivityLogRepository'];
  SecretMetadataRepository: DatabaseModule['SecretMetadataRepository'];
}> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-termius-import-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();

  const stateStorageModule = await import('./state-storage');
  stateStorageModule.resetDesktopStateStorageForTests();
  const databaseModule = await import('./database');

  return {
    tempDir,
    HostRepository: databaseModule.HostRepository,
    GroupRepository: databaseModule.GroupRepository,
    ActivityLogRepository: databaseModule.ActivityLogRepository,
    SecretMetadataRepository: databaseModule.SecretMetadataRepository,
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

function createSnapshot(hosts: TermiusExportHost[]): TermiusSnapshot {
  const bundle: TermiusExportBundle = {
    meta: {
      termiusDataDir: '/tmp/Termius',
    },
    groups: [],
    hosts,
  };

  return {
    bundle,
    hostsByKey: new Map(
      hosts.map((host) => [
        buildTermiusEntityKey(host.id, host.localId, `${host.name ?? ''}|${host.address ?? ''}|${host.groupPath ?? ''}`),
        host,
      ]),
    ),
  };
}

describe('importTermiusSelection', () => {
  it('imports identical SSH hosts even when one already exists locally', async () => {
    const { HostRepository, GroupRepository, ActivityLogRepository, SecretMetadataRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();
    const activityLogs = new ActivityLogRepository();
    const secretMetadata = new SecretMetadataRepository();
    const queueSync = vi.fn();

    hosts.create('existing-host', {
      kind: 'ssh',
      label: 'Existing',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: 'nas.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
    });

    const snapshot = createSnapshot([
      {
        id: 11,
        localId: 11,
        name: 'Imported NAS',
        address: 'nas.example.com',
        sshConfig: {
          port: 22,
        },
        identity: {
          localId: 100,
          username: 'ubuntu',
          password: 'secret',
        },
      },
    ]);
    const input: TermiusImportSelectionInput = {
      snapshotId: 'snapshot-1',
      selectedGroupPaths: [],
      selectedHostKeys: [buildTermiusEntityKey(11, 11, 'Imported NAS|nas.example.com|')],
    };

    const result = await importTermiusSelection(snapshot, input, {
      groups,
      hosts,
      activityLogs,
      secretMetadata,
      persistSecret: vi.fn().mockResolvedValue(null),
      queueSync,
    });

    const importedHosts = hosts
      .list()
      .filter(
        (host) =>
          host.kind === 'ssh' &&
          host.hostname === 'nas.example.com' &&
          host.port === 22 &&
          host.username === 'ubuntu',
      );

    expect(result.createdHostCount).toBe(1);
    expect(result.skippedHostCount).toBe(0);
    expect(result.warnings.some((warning) => warning.code === 'duplicate-host')).toBe(false);
    expect(importedHosts).toHaveLength(2);
    expect(queueSync).toHaveBeenCalledTimes(1);
  });
});
