const { spawnSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const distDirectory = path.join(desktopRoot, 'release', 'dist');
const ARCHES = ['x64', 'arm64'];

// macOS의 ar(ranlib)는 mach-o가 아닌 아카이브 멤버(debian-binary 등)를 경고만 내고 버린 뒤
// exit 0을 반환해서, fpm 기반 deb가 96바이트짜리 빈 아카이브로 조용히 깨진다(fpm도 성공 처리).
// 그래서 deb는 리눅스 호스트(CI)에서만 빌드하고, 다른 호스트는 AppImage만 빌드한다.
function resolveLinuxTargets() {
  if (process.platform === 'linux') {
    return ['AppImage', 'deb'];
  }

  console.warn('[linux-dist] deb는 리눅스 호스트에서만 빌드할 수 있어 이 호스트에서는 AppImage만 생성합니다.');
  return ['AppImage'];
}

// electron-packager는 mkdtemp(0700)로 스테이징한 디렉터리를 out/으로 그대로 옮기므로
// prepackaged 디렉터리 최상위가 0700이 된다. fpm(deb)과 squashfs(AppImage)는 이 모드를
// 그대로 보존해서 /opt/Dolgate 가 일반 사용자에게 접근 불가가 되므로, 패킹 전에 정규화한다.
function normalizePrepackagedPermissions(arch) {
  const prepackagedDir = path.join(desktopRoot, 'out', `dolgate-linux-${arch}`);
  const result = spawnSync('chmod', ['-R', 'a+rX', prepackagedDir], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`prepackaged 디렉터리 권한 정규화에 실패했습니다: ${prepackagedDir}`);
  }
}

function runElectronBuilder(targets, arch) {
  const electronBuilderCli = path.join(
    path.dirname(require.resolve('electron-builder/package.json')),
    'cli.js',
  );
  const args = [
    electronBuilderCli,
    '--config',
    'electron-builder.config.cjs',
    '--linux',
    ...targets,
    `--${arch}`,
    '--publish',
    'never',
    '--prepackaged',
    path.join('out', `dolgate-linux-${arch}`),
  ];

  const result = spawnSync(process.execPath, args, {
    cwd: desktopRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`electron-builder --linux ${targets.join(' ')} (${arch}) 가 종료 코드 ${result.status}로 실패했습니다.`);
  }
}

function listDistFiles() {
  return readdirSync(distDirectory);
}

function requireDistFile(files, pattern) {
  if (!files.some((name) => pattern.test(name))) {
    throw new Error(`release/dist 에서 ${pattern} 에 해당하는 아티팩트를 찾지 못했습니다.`);
  }
}

// deb 안의 /opt/<App> 디렉터리가 일반 사용자도 접근 가능한 모드인지 확인한다(위 0700 문제의 회귀 방지).
// dpkg-deb 는 리눅스에만 있으므로 없으면 건너뛴다(deb 자체가 리눅스에서만 빌드됨).
function verifyDebDirectoryModes(fileName) {
  const result = spawnSync('dpkg-deb', ['-c', path.join(distDirectory, fileName)], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    return;
  }
  if (result.status !== 0) {
    throw new Error(`${fileName}: dpkg-deb 로 내용을 확인하지 못했습니다.`);
  }
  const optDirLine = result.stdout.split('\n').find((line) => /\s\.\/opt\/[^/]+\/$/.test(line));
  if (!optDirLine) {
    throw new Error(`${fileName}: deb 안에서 /opt 앱 디렉터리를 찾지 못했습니다.`);
  }
  if (!optDirLine.startsWith('drwxr-xr-x')) {
    throw new Error(
      `${fileName}: /opt 앱 디렉터리 권한이 잘못되었습니다(${optDirLine.slice(0, 10)}). ` +
        '일반 사용자가 접근할 수 없어 설치 후 앱이 실행되지 않습니다.',
    );
  }
}

function verifyDebArtifact(fileName) {
  const buffer = readFileSync(path.join(distDirectory, fileName));
  if (buffer.length < 1024 * 1024) {
    throw new Error(
      `${fileName}: deb 파일이 비정상적으로 작습니다(${buffer.length} bytes). ` +
        'ar가 아카이브 멤버를 버렸을 가능성이 큽니다. deb는 리눅스 호스트에서 빌드해 주세요.',
    );
  }
  if (!buffer.subarray(0, 8).equals(Buffer.from('!<arch>\n', 'ascii'))) {
    throw new Error(`${fileName}: deb 파일이 ar 아카이브 형식이 아닙니다.`);
  }
  if (!buffer.subarray(0, 4096).includes(Buffer.from('debian-binary', 'ascii'))) {
    throw new Error(`${fileName}: deb 아카이브에 debian-binary 멤버가 없습니다.`);
  }
}

function verifyArtifacts(expectDeb) {
  const files = listDistFiles();

  requireDistFile(files, /-linux-x86_64\.AppImage$/);
  requireDistFile(files, /-linux-arm64\.AppImage$/);
  requireDistFile(files, /^latest-linux\.yml$/);
  requireDistFile(files, /^latest-linux-arm64\.yml$/);

  const debFiles = files.filter((name) => name.endsWith('.deb'));
  if (expectDeb) {
    requireDistFile(files, /-linux-amd64\.deb$/);
    requireDistFile(files, /-linux-arm64\.deb$/);
  }
  for (const fileName of debFiles) {
    verifyDebArtifact(fileName);
    verifyDebDirectoryModes(fileName);
  }

  console.log(`[linux-dist] 아티팩트 검증 완료: ${files.sort((a, b) => a.localeCompare(b)).join(', ')}`);
}

function main() {
  const targets = resolveLinuxTargets();
  for (const arch of ARCHES) {
    normalizePrepackagedPermissions(arch);
    runElectronBuilder(targets, arch);
  }
  verifyArtifacts(targets.includes('deb'));
}

main();
