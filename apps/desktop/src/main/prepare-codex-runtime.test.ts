import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const prepareCodexRuntime = require('../../scripts/prepare-codex-runtime.cjs') as {
  pickPackageRootWithVersion: (candidates: Array<string | null>, expectedVersion: string) => string | null;
  resolvePlatformPackageRoot: (packageName: string) => string;
  specVersion: (spec: string) => string;
};

async function fakePackage(root: string, version: string | null): Promise<string> {
  await mkdir(root, { recursive: true });
  if (version !== null) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
  }
  return root;
}

describe('prepare-codex-runtime version pinning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the platform package version from the @openai/codex optional dependency spec', () => {
    expect(prepareCodexRuntime.specVersion('npm:@openai/codex@0.162.1-linux-x64')).toBe('0.162.1-linux-x64');
    expect(prepareCodexRuntime.specVersion('0.162.1-linux-x64')).toBe('0.162.1-linux-x64');
  });

  it('never reuses a cached platform package from an older Codex release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dolgate-codex-runtime-'));
    const installed = await fakePackage(join(root, 'installed'), '0.153.4-linux-x64');
    const staleCache = await fakePackage(join(root, 'cache-stale'), '0.144.4-linux-x64');
    const freshCache = await fakePackage(join(root, 'cache-fresh'), '0.162.1-linux-x64');
    const emptyCache = await fakePackage(join(root, 'cache-empty'), null);

    expect(prepareCodexRuntime.pickPackageRootWithVersion([installed, staleCache], '0.162.1-linux-x64')).toBeNull();
    expect(prepareCodexRuntime.pickPackageRootWithVersion([null, emptyCache], '0.162.1-linux-x64')).toBeNull();
    expect(prepareCodexRuntime.pickPackageRootWithVersion([installed, freshCache], '0.162.1-linux-x64')).toBe(
      freshCache,
    );
    expect(prepareCodexRuntime.pickPackageRootWithVersion([freshCache, staleCache], '0.162.1-linux-x64')).toBe(
      freshCache,
    );
  });

  // npm 이 이 머신용으로 설치한 패키지는 버전이 맞으므로 그대로 쓰고, 아무것도 받지 않는다.
  const repoNodeModules = join(dirname(fileURLToPath(import.meta.url)), '../../../../node_modules');
  const nativePackageName = `@openai/codex-${process.platform}-${process.arch}`;
  const nativeManifest = join(repoNodeModules, ...nativePackageName.split('/'), 'package.json');
  const codexManifest = join(repoNodeModules, '@openai/codex/package.json');
  const nativeMatchesSpec =
    existsSync(nativeManifest) &&
    existsSync(codexManifest) &&
    JSON.parse(readFileSync(codexManifest, 'utf8')).optionalDependencies?.[nativePackageName]?.endsWith(
      `@${JSON.parse(readFileSync(nativeManifest, 'utf8')).version}`,
    );

  it.runIf(nativeMatchesSpec)('uses the installed package for this machine without fetching', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(prepareCodexRuntime.resolvePlatformPackageRoot(nativePackageName)).toBe(dirname(nativeManifest));
    expect(log).not.toHaveBeenCalled();
  });
});
