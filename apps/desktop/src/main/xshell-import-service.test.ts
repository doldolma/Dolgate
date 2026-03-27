import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  collectSelectedXshellGroupPaths,
  collectSelectedXshellHosts,
  XshellImportService,
  type XshellSnapshot
} from './xshell-import-service';

async function createTempDir(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  return realpath(created);
}

async function writeSessionFile(
  baseDir: string,
  relativePath: string,
  values: {
    version?: string;
    protocol?: string;
    host?: string;
    port?: string | number;
    username?: string;
    password?: string;
    userKey?: string;
    useAuthProfile?: string;
    authProfile?: string;
  },
  options?: {
    encoding?: 'utf8' | 'utf16le-bom';
  }
) {
  const filePath = path.join(baseDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = [
    '[SessionInfo]',
    `Version=${values.version ?? '8.1'}`,
    '[CONNECTION]',
    `Protocol=${values.protocol ?? 'SSH'}`,
    `Host=${values.host ?? ''}`,
    `Port=${values.port ?? 22}`,
    '[CONNECTION:AUTHENTICATION]',
    `UserName=${values.username ?? ''}`,
    `Password=${values.password ?? ''}`,
    `UserKey=${values.userKey ?? ''}`,
    `UseAuthProfile=${values.useAuthProfile ?? '0'}`,
    `AuthProfile=${values.authProfile ?? ''}`,
    '',
  ].join('\n');

  if (options?.encoding === 'utf16le-bom') {
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(content, 'utf16le');
    await writeFile(filePath, Buffer.concat([bom, body]));
    return;
  }

  await writeFile(filePath, content, 'utf8');
}

async function writeMasterPasswordFile(documentsDir: string, version: string, enabled: boolean) {
  const filePath = path.join(documentsDir, 'NetSarang Computer', version, 'Common', 'MasterPassword.mpw');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      '[MasterPassword]',
      `EnblMasterPasswd=${enabled ? '1' : '0'}`,
      'HashMasterPasswd=',
      ''
    ].join('\n'),
    'utf8'
  );
}

function documentsDirectory(root: string): () => string {
  return () => root;
}

function getSnapshot(service: XshellImportService, snapshotId: string): XshellSnapshot {
  const snapshot = service.getSnapshot(snapshotId);
  if (!snapshot) {
    throw new Error(`Snapshot ${snapshotId} was not found`);
  }
  return snapshot;
}

describe('Xshell import service', () => {
  it('returns an empty snapshot when no default Sessions directory exists', async () => {
    const documentsDir = await createTempDir('dolssh-xshell-empty-');
    try {
      const service = new XshellImportService(documentsDirectory(documentsDir));
      const result = await service.probeDefault(new Set());

      expect(result.sources).toEqual([]);
      expect(result.groups).toEqual([]);
      expect(result.hosts).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(service.getSnapshot(result.snapshotId)).not.toBeNull();
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });

  it('probes the highest Xshell version, keeps empty groups, ignores non-xsh files, and skips existing duplicates', async () => {
    const documentsDir = await createTempDir('dolssh-xshell-default-');
    try {
      const sessionsV7 = path.join(documentsDir, 'NetSarang Computer', '7', 'Xshell', 'Sessions');
      const sessionsV8 = path.join(documentsDir, 'NetSarang Computer', '8', 'Xshell', 'Sessions');
      const keyPath = path.join(documentsDir, 'keys', 'app.pem');

      await mkdir(path.join(sessionsV7, 'Legacy'), { recursive: true });
      await mkdir(path.join(sessionsV8, 'Servers', 'Nested'), { recursive: true });
      await mkdir(path.join(sessionsV8, 'Servers', 'Empty'), { recursive: true });
      await mkdir(path.dirname(keyPath), { recursive: true });
      await writeFile(path.join(sessionsV8, 'default.xshf'), '[CONNECTION]\nProtocol=SSH\n', 'utf8');
      await writeFile(path.join(sessionsV8, 'folder.cnf'), '[State]\nExpanded=1\n', 'utf8');
      await writeFile(keyPath, 'PRIVATE KEY', 'utf8');

      await writeSessionFile(sessionsV7, 'Legacy/old.xsh', {
        host: 'old.example.com',
        username: 'legacy'
      });
      await writeSessionFile(sessionsV8, 'root-host.xsh', {
        host: 'root.example.com',
        username: 'root'
      });
      await writeSessionFile(sessionsV8, 'Servers/app.xsh', {
        host: 'app.example.com',
        username: 'ubuntu',
        userKey: keyPath
      });
      await writeSessionFile(sessionsV8, 'Servers/Nested/db.xsh', {
        host: 'db.example.com',
        username: 'postgres',
        password: 'encrypted-value',
        useAuthProfile: '1',
        authProfile: 'ops'
      });
      await writeSessionFile(sessionsV8, 'Servers/Nested/telnet.xsh', {
        protocol: 'TELNET',
        host: 'telnet.example.com',
        username: 'root'
      });

      const service = new XshellImportService(documentsDirectory(documentsDir));
      const result = await service.probeDefault(new Set(['db.example.com\u000022\u0000postgres']));

      expect(result.sources).toEqual([
        expect.objectContaining({
          origin: 'default-session-dir',
          folderPath: sessionsV8
        })
      ]);
      expect(result.groups).toEqual([
        {
          path: 'Servers',
          name: 'Servers',
          parentPath: null,
          hostCount: 1
        },
        {
          path: 'Servers/Empty',
          name: 'Empty',
          parentPath: 'Servers',
          hostCount: 0
        },
        {
          path: 'Servers/Nested',
          name: 'Nested',
          parentPath: 'Servers',
          hostCount: 0
        }
      ]);
      expect(result.hosts).toEqual([
        expect.objectContaining({
          label: 'root-host',
          hostname: 'root.example.com',
          username: 'root',
          groupPath: null
        }),
        expect.objectContaining({
          label: 'app',
          hostname: 'app.example.com',
          username: 'ubuntu',
          authType: 'privateKey',
          privateKeyPath: keyPath
        })
      ]);
      expect(result.skippedExistingHostCount).toBe(1);
      expect(result.skippedDuplicateHostCount).toBe(0);
      expect(result.warnings.some((warning) => warning.code === 'password-not-imported')).toBe(false);
      expect(result.warnings.some((warning) => warning.code === 'auth-profile-not-imported')).toBe(true);
      expect(result.warnings.some((warning) => warning.code === 'unsupported-protocol')).toBe(true);
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });

  it('warns when a source uses Xshell master password and keeps the saved password metadata', async () => {
    const documentsDir = await createTempDir('dolssh-xshell-master-password-');
    try {
      const sessionsDir = path.join(documentsDir, 'NetSarang Computer', '8', 'Xshell', 'Sessions');
      await writeMasterPasswordFile(documentsDir, '8', true);
      await writeSessionFile(sessionsDir, 'Servers/app.xsh', {
        host: 'app.example.com',
        username: 'ubuntu',
        password: 'encrypted-value'
      });

      const service = new XshellImportService(documentsDirectory(documentsDir));
      const result = await service.probeDefault(new Set());

      expect(result.hosts).toEqual([
        expect.objectContaining({
          label: 'app',
          authType: 'password',
          hasPasswordHint: true
        })
      ]);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'master-password-enabled'
          })
        ])
      );
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });

  it('parses UTF-16 LE BOM session files without misreporting missing Host', async () => {
    const documentsDir = await createTempDir('dolssh-xshell-utf16-');
    try {
      const sessionsDir = path.join(documentsDir, 'NetSarang Computer', '8', 'Xshell', 'Sessions');
      await writeSessionFile(
        sessionsDir,
        'Servers/app.xsh',
        {
          host: 'app.example.com',
          username: 'ubuntu'
        },
        {
          encoding: 'utf16le-bom'
        }
      );

      const service = new XshellImportService(documentsDirectory(documentsDir));
      const result = await service.probeDefault(new Set());

      expect(result.hosts).toEqual([
        expect.objectContaining({
          label: 'app',
          hostname: 'app.example.com',
          username: 'ubuntu'
        })
      ]);
      expect(result.warnings.some((warning) => warning.code === 'missing-host')).toBe(false);
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });

  it('appends manual folders to an existing snapshot and records duplicate hosts while preserving empty groups', async () => {
    const documentsDir = await createTempDir('dolssh-xshell-append-');
    try {
      const sessionsDir = path.join(documentsDir, 'NetSarang Computer', '8', 'Xshell', 'Sessions');
      const manualDir = path.join(documentsDir, 'manual-sessions');
      await mkdir(path.join(manualDir, 'Lab', 'Empty'), { recursive: true });
      await writeSessionFile(sessionsDir, 'Servers/web.xsh', {
        host: 'web.example.com',
        username: 'ubuntu'
      });
      await writeSessionFile(manualDir, 'Lab/db.xsh', {
        host: 'db.example.com',
        username: 'postgres'
      });

      const service = new XshellImportService(documentsDirectory(documentsDir));
      const initial = await service.probeDefault(new Set());
      const appended = await service.addFolderToSnapshot(
        {
          snapshotId: initial.snapshotId,
          folderPath: manualDir
        },
        new Set()
      );
      const appendedAgain = await service.addFolderToSnapshot(
        {
          snapshotId: initial.snapshotId,
          folderPath: manualDir
        },
        new Set()
      );

      expect(appended.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ origin: 'default-session-dir' }),
          expect.objectContaining({ origin: 'manual-folder', folderPath: manualDir })
        ])
      );
      expect(appended.groups.map((group) => group.path)).toEqual(['Lab', 'Lab/Empty', 'Servers']);
      expect(appended.hosts.map((host) => host.label)).toEqual(['db', 'web']);
      expect(appended.skippedDuplicateHostCount).toBe(0);
      expect(appendedAgain.sources).toHaveLength(2);
      expect(appendedAgain.skippedDuplicateHostCount).toBe(1);
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });

  it('collects selected hosts from explicit checks and selected group subtrees, including empty descendants', async () => {
    const documentsDir = await createTempDir('dolssh-xshell-select-');
    try {
      const sessionsDir = path.join(documentsDir, 'NetSarang Computer', '8', 'Xshell', 'Sessions');
      await mkdir(path.join(sessionsDir, 'Servers', 'Empty'), { recursive: true });
      await writeSessionFile(sessionsDir, 'root-host.xsh', {
        host: 'root.example.com',
        username: 'root'
      });
      await writeSessionFile(sessionsDir, 'Servers/app.xsh', {
        host: 'app.example.com',
        username: 'ubuntu'
      });
      await writeSessionFile(sessionsDir, 'Servers/Nested/db.xsh', {
        host: 'db.example.com',
        username: 'postgres'
      });

      const service = new XshellImportService(documentsDirectory(documentsDir));
      const result = await service.probeDefault(new Set());
      const snapshot = getSnapshot(service, result.snapshotId);
      const rootHost = result.hosts.find((host) => host.label === 'root-host');
      if (!rootHost) {
        throw new Error('Root host was not found');
      }

      expect(
        collectSelectedXshellHosts(snapshot, {
          snapshotId: result.snapshotId,
          selectedGroupPaths: ['Servers'],
          selectedHostKeys: []
        }).map((host) => host.label)
      ).toEqual(['app', 'db']);

      expect(
        collectSelectedXshellGroupPaths(snapshot, {
          snapshotId: result.snapshotId,
          selectedGroupPaths: ['Servers'],
          selectedHostKeys: []
        })
      ).toEqual(['Servers', 'Servers/Empty', 'Servers/Nested']);

      expect(
        collectSelectedXshellGroupPaths(snapshot, {
          snapshotId: result.snapshotId,
          selectedGroupPaths: [],
          selectedHostKeys: [rootHost.key]
        })
      ).toEqual([]);
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });

  it('keeps private-key sessions importable even when the UserKey cannot be resolved', async () => {
    const documentsDir = await createTempDir('dolssh-xshell-key-');
    try {
      const sessionsDir = path.join(documentsDir, 'NetSarang Computer', '8', 'Xshell', 'Sessions');
      await writeSessionFile(sessionsDir, 'Ops/bastion.xsh', {
        host: 'bastion.example.com',
        username: 'root',
        userKey: 'missing.pem'
      });

      const service = new XshellImportService(documentsDirectory(documentsDir));
      const result = await service.probeDefault(new Set());

      expect(result.hosts).toEqual([
        expect.objectContaining({
          label: 'bastion',
          authType: 'privateKey',
          privateKeyPath: null
        })
      ]);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'unresolved-user-key'
          })
        ])
      );
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });
});
