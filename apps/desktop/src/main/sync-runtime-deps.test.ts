import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const syncRuntimeDeps = require('../../scripts/sync-runtime-deps.cjs') as {
  removePath: (targetPath: string) => Promise<void>;
  resolveInstalledPackageJson: (packageName: string) => string;
  shouldIncludeRuntimePackage: (packageName: string, targetPlatform?: string | null) => boolean;
  resolveTargetPlatform: () => string | null;
};

describe('sync-runtime-deps target filtering', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps runtime packages regardless of target platform', () => {
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('react', 'darwin')).toBe(true);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('react', 'win32')).toBe(true);
  });

  it('reads the target platform from the environment when present', () => {
    vi.stubEnv('DOLSSH_TARGET_PLATFORM', 'darwin');

    expect(syncRuntimeDeps.resolveTargetPlatform()).toBe('darwin');
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('react')).toBe(true);
  });

  it('resolves package manifests even when the package root has no default export entry', () => {
    expect(syncRuntimeDeps.resolveInstalledPackageJson('@aws-sdk/nested-clients')).toMatch(
      /@aws-sdk[\\/]nested-clients[\\/]package\.json$/,
    );
  });

  it('removes read-only nested dependency trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dolgate-runtime-deps-'));
    const nested = join(root, 'vendor', 'resources');
    const file = join(nested, 'codex-resource.txt');
    await mkdir(nested, { recursive: true });
    await writeFile(file, 'resource');
    await chmod(file, 0o400);
    await chmod(nested, 0o500);

    await syncRuntimeDeps.removePath(root);

    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
