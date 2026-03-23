import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const syncRuntimeDeps = require('../../scripts/sync-runtime-deps.cjs') as {
  shouldIncludeRuntimePackage: (packageName: string, targetPlatform?: string | null) => boolean;
  resolveTargetPlatform: () => string | null;
};

describe('sync-runtime-deps target filtering', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('excludes node-pty from non-Windows targets and keeps other runtime packages', () => {
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('node-pty', 'darwin')).toBe(false);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('node-pty', 'linux')).toBe(false);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('node-pty', 'win32')).toBe(true);
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('react', 'darwin')).toBe(true);
  });

  it('reads the target platform from the environment when present', () => {
    vi.stubEnv('DOLSSH_TARGET_PLATFORM', 'darwin');

    expect(syncRuntimeDeps.resolveTargetPlatform()).toBe('darwin');
    expect(syncRuntimeDeps.shouldIncludeRuntimePackage('node-pty')).toBe(false);
  });
});
