const { execFileSync } = require('node:child_process');
const { chmodSync, cpSync, existsSync, mkdirSync, rmSync } = require('node:fs');
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
  ]
};

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function packageNameToPath(root, packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

function resolvePackageJson(packageName, roots = [repoRoot, desktopRoot, cacheRoot]) {
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

function materializeOptionalPackage(packageName) {
  const destination = packageNameToPath(cacheRoot, packageName);
  const manifestPath = path.join(destination, 'package.json');
  if (existsSync(manifestPath)) {
    return destination;
  }

  const spec = resolveCodexOptionalPackageSpec(packageName);
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

function resolvePlatformPackageRoot(packageName) {
  try {
    return path.dirname(resolvePackageJson(packageName));
  } catch {
    return materializeOptionalPackage(packageName);
  }
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

main();
