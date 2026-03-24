const { chmodSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function buildGoBinary(serviceDir, outputPath, goos, goarch) {
  buildGoCommand(serviceDir, outputPath, goos, goarch, './cmd/ssh-core');
}

function buildGoCommand(serviceDir, outputPath, goos, goarch, entrypoint) {
  run('go', ['build', '-trimpath', '-o', outputPath, entrypoint], {
    cwd: serviceDir,
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOOS: goos,
      GOARCH: goarch
    }
  });
}

function ensureExecutable(targetPath) {
  if (process.platform !== 'win32') {
    chmodSync(targetPath, 0o755);
  }
}

function buildDarwinUniversal(serviceDir, releaseRoot, targetRoot) {
  const tempRoot = path.join(releaseRoot, 'tmp', 'ssh-core', 'darwin');
  const amd64Path = path.join(tempRoot, 'ssh-core-amd64');
  const arm64Path = path.join(tempRoot, 'ssh-core-arm64');
  const outputPath = path.join(targetRoot, 'ssh-core');

  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  buildGoBinary(serviceDir, amd64Path, 'darwin', 'amd64');
  buildGoBinary(serviceDir, arm64Path, 'darwin', 'arm64');
  run('lipo', ['-create', '-output', outputPath, amd64Path, arm64Path]);
  ensureExecutable(outputPath);
}

function buildWindowsX64(serviceDir, targetRoot) {
  buildGoBinary(serviceDir, path.join(targetRoot, 'ssh-core.exe'), 'windows', 'amd64');
  buildGoCommand(
    serviceDir,
    path.join(targetRoot, 'aws-conpty-wrapper.exe'),
    'windows',
    'amd64',
    './cmd/aws-conpty-wrapper'
  );
}

function main() {
  const [platform, arch] = process.argv.slice(2);
  if (!platform || !arch) {
    throw new Error('Usage: node ./scripts/build-ssh-core.cjs <platform> <arch>');
  }

  const repoRoot = path.resolve(__dirname, '../../..');
  const serviceDir = path.join(repoRoot, 'services', 'ssh-core');
  const releaseRoot = path.join(repoRoot, 'apps', 'desktop', 'release');
  const targetRoot = path.join(releaseRoot, 'resources', platform, arch, 'bin');

  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });

  if (platform === 'darwin' && arch === 'universal') {
    buildDarwinUniversal(serviceDir, releaseRoot, targetRoot);
    return;
  }

  if (platform === 'win32' && arch === 'x64') {
    buildWindowsX64(serviceDir, targetRoot);
    return;
  }

  throw new Error(`Unsupported ssh-core release target: ${platform}/${arch}`);
}

main();
