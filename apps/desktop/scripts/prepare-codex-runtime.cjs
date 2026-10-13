const { execFileSync } = require('node:child_process');
const { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const cacheRoot = path.join(desktopRoot, '.runtime-deps-cache', 'codex');

const TARGETS = {
  'darwin/universal': [
    {
      packageName: '@openai/codex-darwin-arm64',
      triple: 'aarch64-apple-darwin'
    },
    {
      packageName: '@openai/codex-darwin-x64',
      triple: 'x86_64-apple-darwin'
    }
  ],
  'win32/x64': [
    {
      packageName: '@openai/codex-win32-x64',
      triple: 'x86_64-pc-windows-msvc'
    }
  ],
  'linux/x64': [
    {
      packageName: '@openai/codex-linux-x64',
      triple: 'x86_64-unknown-linux-musl'
    }
  ],
  'linux/arm64': [
    {
      packageName: '@openai/codex-linux-arm64',
      triple: 'aarch64-unknown-linux-musl'
    }
  ]
};

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function packageNameToPath(root, packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

function resolvePackageJson(packageName, roots) {
  for (const root of roots) {
    const candidate = path.join(packageNameToPath(root, packageName), 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return require.resolve(`${packageName}/package.json`, {
    paths: roots
  });
}

function resolveCodexOptionalPackageSpec(packageName) {
  const codexManifestPath = resolvePackageJson('@openai/codex', [repoRoot, desktopRoot]);
  const codexManifest = require(codexManifestPath);
  const spec = codexManifest.optionalDependencies?.[packageName];
  if (typeof spec !== 'string') {
    throw new Error(`@openai/codex optional dependency not found: ${packageName}`);
  }
  return spec;
}

function specVersion(spec) {
  return spec.startsWith('npm:') ? spec.slice(spec.lastIndexOf('@') + 1) : spec;
}

function readPackageVersion(packageRoot) {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function pickPackageRootWithVersion(candidates, expectedVersion) {
  return candidates.find((root) => root && readPackageVersion(root) === expectedVersion) ?? null;
}

function findInstalledPackageRoot(packageName) {
  try {
    return path.dirname(resolvePackageJson(packageName, [repoRoot, desktopRoot]));
  } catch {
    return null;
  }
}

function materializeOptionalPackage(packageName, spec) {
  const destination = packageNameToPath(cacheRoot, packageName);
  const tempDir = path.join(cacheRoot, 'tmp', packageName.replaceAll('/', '__'));
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(path.dirname(destination), { recursive: true });

  execFileSync(npmCommand(), ['pack', spec, '--pack-destination', tempDir], {
    cwd: repoRoot,
    stdio: 'ignore'
  });

  const tarball = require('node:fs').readdirSync(tempDir).find((entry) => entry.endsWith('.tgz'));
  if (!tarball) {
    throw new Error(`${packageName} package tarball not found.`);
  }

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tempDir, tarball), '-C', destination, '--strip-components', '1'], {
    stdio: 'ignore'
  });
  rmSync(tempDir, { recursive: true, force: true });
  return destination;
}

// 다른 플랫폼용 패키지는 npm 이 설치하지 않아 캐시에 받아 둔다. 설치본이든 캐시든
// @openai/codex 가 요구하는 버전일 때만 쓴다 — 버전을 안 보면 codex 를 올려도 캐시에 남은
// 이전 버전이 패키징된다(유니버설 mac 은 arm64 는 새 버전, x64 는 캐시의 옛 버전으로 섞인다).
function resolvePlatformPackageRoot(packageName) {
  const spec = resolveCodexOptionalPackageSpec(packageName);
  const expectedVersion = specVersion(spec);
  const cachedRoot = packageNameToPath(cacheRoot, packageName);
  const usableRoot = pickPackageRootWithVersion(
    [findInstalledPackageRoot(packageName), cachedRoot],
    expectedVersion
  );
  if (usableRoot) {
    return usableRoot;
  }

  const cachedVersion = readPackageVersion(cachedRoot);
  console.log(`Fetching ${packageName}@${expectedVersion}${cachedVersion ? ` (cached ${cachedVersion} is stale)` : ''}`);
  const destination = materializeOptionalPackage(packageName, spec);
  const fetchedVersion = readPackageVersion(destination);
  if (fetchedVersion !== expectedVersion) {
    throw new Error(`${packageName} version mismatch: expected ${expectedVersion}, got ${fetchedVersion}`);
  }
  return destination;
}

function ensureExecutable(targetPath) {
  if (process.platform !== 'win32' && existsSync(targetPath)) {
    chmodSync(targetPath, 0o755);
  }
}

function copyCodexTarget({ packageName, triple }, outputRoot) {
  const packageRoot = resolvePlatformPackageRoot(packageName);
  const sourceRoot = path.join(packageRoot, 'vendor', triple);
  if (!existsSync(sourceRoot)) {
    throw new Error(`Codex vendor directory not found: ${sourceRoot}`);
  }

  const destinationRoot = path.join(outputRoot, 'vendor', triple);
  rmSync(destinationRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(destinationRoot), { recursive: true });
  cpSync(sourceRoot, destinationRoot, { recursive: true, dereference: true });

  ensureExecutable(path.join(destinationRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
  ensureExecutable(path.join(destinationRoot, 'codex-path', process.platform === 'win32' ? 'rg.exe' : 'rg'));
  ensureExecutable(path.join(destinationRoot, 'codex-resources', 'zsh', 'bin', 'zsh'));
}

function copyCodexWrapper(outputRoot) {
  const wrapperRoot = path.dirname(resolvePackageJson('@openai/codex', [repoRoot, desktopRoot]));
  for (const entry of ['package.json', 'README.md', 'bin']) {
    const source = path.join(wrapperRoot, entry);
    if (existsSync(source)) {
      cpSync(source, path.join(outputRoot, entry), { recursive: true, dereference: true });
    }
  }
}

function main() {
  const [platform, arch] = process.argv.slice(2);
  const targetKey = `${platform}/${arch}`;
  const targets = TARGETS[targetKey];
  if (!targets) {
    throw new Error(`Unsupported Codex runtime target: ${targetKey}`);
  }

  const outputRoot = path.join(desktopRoot, 'release', 'resources', platform, arch, 'codex-cli');
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  copyCodexWrapper(outputRoot);
  for (const target of targets) {
    copyCodexTarget(target, outputRoot);
  }

  console.log(`Codex runtime prepared: ${targetKey}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  pickPackageRootWithVersion,
  resolvePlatformPackageRoot,
  specVersion
};
