import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const syncRuntimeDeps = require('../../scripts/sync-runtime-deps.cjs') as {
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
});
