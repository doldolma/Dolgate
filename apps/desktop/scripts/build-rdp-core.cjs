// rdp-core(services/rdp-core, Rust) 릴리스 빌드.
//
// build-ssh-core.cjs 와 같은 출력 규칙을 따른다: release/resources/<platform>/<arch>/bin/.
//
// Go 와 다른 점이 하나 있다. rdp-core 는 rustls 를 통해 aws-lc-sys(C 라이브러리)를 끌어오므로
// GOOS/GOARCH 같은 공짜 크로스컴파일이 안 된다. 대신 릴리스 워크플로가 이미 플랫폼별 네이티브
// 러너(macos/windows/ubuntu)에서 돌기 때문에 각자 자기 플랫폼만 빌드하면 된다.
//
// 유일한 예외가 macOS universal 이다. 두 아키텍처를 한 바이너리로 합쳐야 하는데, Apple 타깃은
// 같은 시스템 clang 으로 둘 다 빌드되므로 rustup 타깃만 추가하면 lipo 로 합칠 수 있다.

const { chmodSync, mkdirSync, rmSync, copyFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options
  });

  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(
      `${command} not found. Install the Rust toolchain (https://rustup.rs) to build rdp-core.`
    );
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function ensureRustTarget(target) {
  // 이미 설치돼 있으면 no-op 이다. 러너마다 사전 설치 상태가 달라 매번 확인하는 편이 싸다.
  run('rustup', ['target', 'add', target], { cwd: SERVICE_DIR });
}

function cargoBuild(target, env = {}) {
  run('cargo', ['build', '--release', '--locked', '--target', target], {
    cwd: SERVICE_DIR,
    env: { ...process.env, ...env }
  });
  return path.join(SERVICE_DIR, 'target', target, 'release', BINARY_NAME());
}

/**
 * x64 리눅스 호스트에서 arm64 리눅스를 빌드하기 위한 환경.
 *
 * ssh-core 는 GOARCH 만 바꾸면 되지만 rdp-core 는 aws-lc-sys(C)를 링크하므로 타깃용 C
 * 컴파일러와 링커가 필요하다. 러너에 gcc-aarch64-linux-gnu 가 설치돼 있어야 한다.
 */
function linuxArm64CrossEnv() {
  return {
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: 'aarch64-linux-gnu-gcc',
    CC_aarch64_unknown_linux_gnu: 'aarch64-linux-gnu-gcc',
    CXX_aarch64_unknown_linux_gnu: 'aarch64-linux-gnu-g++',
    AR_aarch64_unknown_linux_gnu: 'aarch64-linux-gnu-ar'
  };
}

function BINARY_NAME() {
  return process.platform === 'win32' ? 'rdp-core.exe' : 'rdp-core';
}

function ensureExecutable(targetPath) {
  if (process.platform !== 'win32') {
    chmodSync(targetPath, 0o755);
  }
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVICE_DIR = path.join(REPO_ROOT, 'services', 'rdp-core');

function buildDarwinUniversal(releaseRoot, targetRoot) {
  const tempRoot = path.join(releaseRoot, 'tmp', 'rdp-core', 'darwin');
  const outputPath = path.join(targetRoot, 'rdp-core');

  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  ensureRustTarget('x86_64-apple-darwin');
  ensureRustTarget('aarch64-apple-darwin');

  const amd64Path = cargoBuild('x86_64-apple-darwin');
  const arm64Path = cargoBuild('aarch64-apple-darwin');

  run('lipo', ['-create', '-output', outputPath, amd64Path, arm64Path]);
  ensureExecutable(outputPath);
}

function buildFor(targetRoot, expectedPlatform, target, env = {}) {
  if (process.platform !== expectedPlatform) {
    throw new Error(
      `rdp-core for ${expectedPlatform} must be built on a ${expectedPlatform} host; this one is ${process.platform}. ` +
        'It links aws-lc-sys, a C library, so it does not cross-compile the way ssh-core does.'
    );
  }

  ensureRustTarget(target);
  const builtPath = cargoBuild(target, env);

  const outputPath = path.join(targetRoot, BINARY_NAME());
  copyFileSync(builtPath, outputPath);
  ensureExecutable(outputPath);
}

function main() {
  const [platform, arch] = process.argv.slice(2);
  if (!platform || !arch) {
    throw new Error('Usage: node ./scripts/build-rdp-core.cjs <platform> <arch>');
  }

  const releaseRoot = path.join(REPO_ROOT, 'apps', 'desktop', 'release');
  const targetRoot = path.join(releaseRoot, 'resources', platform, arch, 'bin');

  mkdirSync(targetRoot, { recursive: true });

  if (platform === 'darwin' && arch === 'universal') {
    buildDarwinUniversal(releaseRoot, targetRoot);
    return;
  }

  if (platform === 'win32' && arch === 'x64') {
    buildFor(targetRoot, 'win32', 'x86_64-pc-windows-msvc');
    return;
  }

  if (platform === 'linux' && arch === 'x64') {
    buildFor(targetRoot, 'linux', 'x86_64-unknown-linux-gnu');
    return;
  }

  if (platform === 'linux' && arch === 'arm64') {
    // 호스트가 이미 arm64 면 크로스 환경이 필요 없다.
    const crossEnv = process.arch === 'arm64' ? {} : linuxArm64CrossEnv();
    buildFor(targetRoot, 'linux', 'aarch64-unknown-linux-gnu', crossEnv);
    return;
  }

  throw new Error(`Unsupported rdp-core release target: ${platform}/${arch}`);
}

main();
