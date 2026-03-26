import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  OpenSshImportService,
  resolveOpenSshIdentityImport,
} from './openssh-import-service';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('OpenSSH import service', () => {
  it('probeDefault reads ~/.ssh/config, follows Include, and skips existing duplicates before showing hosts', async () => {
    const tempDir = await createTempDir('dolssh-openssh-default-');
    try {
      await mkdir(path.join(tempDir, '.ssh', 'conf.d'), { recursive: true });
      await mkdir(path.join(tempDir, '.ssh', 'keys'), { recursive: true });
      await writeFile(
        path.join(tempDir, '.ssh', 'config'),
        [
          'Include ./conf.d/*.conf',
          'Host app',
          '  HostName app.example.com',
          '  User ubuntu',
          '  Port 2200',
          '  IdentityFile ./keys/app.pem',
          '',
          'Host existing',
          '  HostName existing.example.com',
          '  User root',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(tempDir, '.ssh', 'conf.d', 'nested.conf'),
        ['Host nested', '  HostName nested.example.com', '  User root'].join(
          '\n',
        ),
        'utf8',
      );
      await writeFile(
        path.join(tempDir, '.ssh', 'keys', 'app.pem'),
        '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
        'utf8',
      );

      const service = new OpenSshImportService(tempDir);
      const result = await service.probeDefault(
        new Set(['existing.example.com\u000022\u0000root']),
      );

      expect(result.sources).toEqual([
        expect.objectContaining({
          origin: 'default-ssh-dir',
          label: '~/.ssh/config',
        }),
      ]);
      expect(result.hosts.map((host) => host.alias).sort()).toEqual([
        'app',
        'nested',
      ]);
      expect(
        result.hosts.find((host) => host.alias === 'app'),
      ).toMatchObject({
        hostname: 'app.example.com',
        port: 2200,
        username: 'ubuntu',
        authType: 'privateKey',
        identityFilePath: path.join(tempDir, '.ssh', 'keys', 'app.pem'),
      });
      expect(result.skippedExistingHostCount).toBe(1);
      expect(result.skippedDuplicateHostCount).toBe(0);

      expect(service.getSnapshot(result.snapshotId)).not.toBeNull();
      service.discardSnapshot(result.snapshotId);
      expect(service.getSnapshot(result.snapshotId)).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an empty but usable snapshot when ~/.ssh/config does not exist', async () => {
    const tempDir = await createTempDir('dolssh-openssh-empty-');
    try {
      const service = new OpenSshImportService(tempDir);
      const result = await service.probeDefault(new Set());

      expect(result.sources).toEqual([]);
      expect(result.hosts).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(service.getSnapshot(result.snapshotId)).not.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('adds manual files into an existing snapshot and skips repeated duplicate hosts', async () => {
    const tempDir = await createTempDir('dolssh-openssh-append-');
    try {
      await mkdir(path.join(tempDir, '.ssh'), { recursive: true });
      await writeFile(
        path.join(tempDir, '.ssh', 'config'),
        ['Host web', '  HostName web.example.com', '  User ubuntu'].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(tempDir, 'team.conf'),
        ['Host db', '  HostName db.example.com', '  User postgres'].join('\n'),
        'utf8',
      );

      const service = new OpenSshImportService(tempDir);
      const initial = await service.probeDefault(new Set());
      const appended = await service.addFileToSnapshot(
        {
          snapshotId: initial.snapshotId,
          filePath: path.join(tempDir, 'team.conf'),
        },
        new Set(),
      );
      const appendedAgain = await service.addFileToSnapshot(
        {
          snapshotId: initial.snapshotId,
          filePath: path.join(tempDir, 'team.conf'),
        },
        new Set(),
      );

      expect(appended.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '~/.ssh/config' }),
          expect.objectContaining({
            label: expect.stringContaining('team.conf'),
            origin: 'manual-file',
          }),
        ]),
      );
      expect(appended.hosts.map((host) => host.alias).sort()).toEqual([
        'db',
        'web',
      ]);
      expect(appended.skippedDuplicateHostCount).toBe(0);
      expect(appendedAgain.sources).toHaveLength(2);
      expect(appendedAgain.hosts.map((host) => host.alias).sort()).toEqual([
        'db',
        'web',
      ]);
      expect(appendedAgain.skippedDuplicateHostCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves parser warnings such as recursive Include cycles', async () => {
    const tempDir = await createTempDir('dolssh-openssh-cycle-');
    try {
      await mkdir(path.join(tempDir, '.ssh'), { recursive: true });
      await writeFile(
        path.join(tempDir, '.ssh', 'config'),
        ['Include ./b.conf', 'Host app', '  User ubuntu'].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(tempDir, '.ssh', 'b.conf'),
        ['Include ./config', 'Host nested', '  User root'].join('\n'),
        'utf8',
      );

      const service = new OpenSshImportService(tempDir);
      const result = await service.probeDefault(new Set());

      expect(result.hosts.map((host) => host.alias).sort()).toEqual([
        'app',
        'nested',
      ]);
      expect(
        result.warnings.some(
          (warning) =>
            warning.code === 'include-cycle' &&
            warning.message.includes('순환 Include를 건너뛰었습니다.'),
        ),
      ).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('imports supported private key material and falls back to key paths for unsupported files', async () => {
    const tempDir = await createTempDir('dolssh-openssh-identity-');
    try {
      const supportedKeyPath = path.join(tempDir, 'supported.pem');
      const unsupportedKeyPath = path.join(tempDir, 'unsupported.ppk');
      await writeFile(
        supportedKeyPath,
        '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
        'utf8',
      );
      await writeFile(
        unsupportedKeyPath,
        'PuTTY-User-Key-File-3: ssh-ed25519\n',
        'utf8',
      );

      await expect(resolveOpenSshIdentityImport(supportedKeyPath)).resolves.toEqual({
        kind: 'managed-key',
        privateKeyPem:
          '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      });
      await expect(
        resolveOpenSshIdentityImport(unsupportedKeyPath),
      ).resolves.toMatchObject({
        kind: 'path-fallback',
        warning: {
          code: 'unsupported-key-format',
          message: expect.stringContaining('경로만 가져왔습니다.'),
        },
      });
      await expect(
        resolveOpenSshIdentityImport(path.join(tempDir, 'missing.pem')),
      ).resolves.toMatchObject({
        kind: 'path-fallback',
        warning: {
          code: 'identity-read-failed',
          message: expect.stringContaining('키 파일을 읽지 못해'),
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
