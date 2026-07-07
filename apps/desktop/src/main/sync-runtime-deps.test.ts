import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const syncRuntimeDeps = require('../../scripts/sync-runtime-deps.cjs') as {
  collectRuntimeDependencyGraph: () => Promise<Array<{ name: string; sourceDirectory: string }>>;
  removePath: (targetPath: string) => Promise<void>;
  resolveInstalledPackageJson: (packageName: string) => string;
  shouldIncludeRuntimePackage: (packageName: string, targetPlatform?: string | null, targetArch?: string | null) => boolean;
  resolveTargetPlatform: () => string | null;
};

function currentCodexPlatformPackage(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return '@openai/codex-darwin-arm64';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return '@openai/codex-darwin-x64';
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return '@openai/codex-linux-arm64';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return '@openai/codex-linux-x64';
  }
  if (process.platform === 'win32' && process.arch === 'arm64') {
    return '@openai/codex-win32-arm64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return '@openai/codex-win32-x64';
  }
  return null;
}

describe('sync-runtime-deps target filtering', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps runtime packages regardless of target platform', () => {
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('react', 'darwin')).toBe(true);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('react', 'win32')).toBe(true);
  });

  it('keeps only the Codex native package for the target platform and architecture', () => {
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('@openai/codex-win32-x64', 'win32', 'x64')).toBe(true);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('@openai/codex-darwin-arm64', 'win32', 'x64')).toBe(false);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('@openai/codex-darwin-arm64', 'darwin', 'universal')).toBe(true);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('@openai/codex-darwin-x64', 'darwin', 'universal')).toBe(true);
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

  it('keeps the Codex wrapper package separate from the installed platform package alias', async () => {
    const packages = await syncRuntimeDeps.collectRuntimeDependencyGraph();
    const packageNames = packages.map((runtimePackage) => runtimePackage.name);
    const platformPackage = currentCodexPlatformPackage();

    expect(packageNames).toContain('@openai/codex');
    if (platformPackage) {
      expect(packageNames).toContain(platformPackage);
    }
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
