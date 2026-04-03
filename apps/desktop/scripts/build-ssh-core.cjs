const { chmodSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const desktopPackage = require(path.resolve(__dirname, '..', 'package.json'));

const DNS_HELPER_ENTRYPOINT = './cmd/hosts-helper';
const DNS_HELPER_BINARY_NAME = 'dolgate-dns-helper';

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

function buildHostsHelperBinary(serviceDir, outputPath, goos, goarch) {
  buildGoCommand(serviceDir, outputPath, goos, goarch, DNS_HELPER_ENTRYPOINT);
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

function parseVersion(version) {
  const [major = '0', minor = '0', patch = '0'] = String(version).split('.');
  return {
    major: Number.parseInt(major, 10) || 0,
    minor: Number.parseInt(minor, 10) || 0,
    patch: Number.parseInt(patch, 10) || 0,
    raw: `${major}.${minor}.${patch}`
  };
}

function buildWindowsDnsHelperVersionInfo(serviceDir, repoRoot) {
  const helperDir = path.join(serviceDir, 'cmd', 'hosts-helper');
  const sysoPath = path.join(helperDir, 'zz_dolgate_dns_helper.syso');
  const versionInfoPath = path.join(helperDir, 'zz_dolgate_dns_helper_versioninfo.json');
  const iconPath = path.join(repoRoot, 'apps', 'desktop', 'build', 'icons', 'dolssh.ico');
  const version = parseVersion(desktopPackage.version);

  rmSync(sysoPath, { force: true });
  rmSync(versionInfoPath, { force: true });
  writeFileSync(
    versionInfoPath,
    JSON.stringify(
      {
        FixedFileInfo: {
          FileVersion: {
            Major: version.major,
            Minor: version.minor,
            Patch: version.patch,
            Build: 0
          },
          ProductVersion: {
            Major: version.major,
            Minor: version.minor,
            Patch: version.patch,
            Build: 0
          },
          FileFlagsMask: '3f',
          'FileFlags ': '00',
          FileOS: '040004',
          FileType: '01',
          FileSubType: '00'
        },
        StringFileInfo: {
          Comments: '',
          CompanyName: 'doldolma',
          FileDescription: 'Dolgate DNS Helper',
          FileVersion: `${version.raw}.0`,
          InternalName: DNS_HELPER_BINARY_NAME,
          LegalCopyright: '',
          LegalTrademarks: '',
          OriginalFilename: `${DNS_HELPER_BINARY_NAME}.exe`,
          PrivateBuild: '',
          ProductName: 'Dolgate',
          ProductVersion: `${version.raw}.0`,
          SpecialBuild: ''
        },
        VarFileInfo: {
          Translation: {
            LangID: '0409',
            CharsetID: '04B0'
          }
        }
      },
      null,
      2
    )
  );
  run(
    'go',
    [
      'run',
      'github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.5.0',
      '-64',
      '-o',
      sysoPath,
      '-icon',
      iconPath,
      versionInfoPath
    ],
    {
      cwd: helperDir
    }
  );

  return { sysoPath, versionInfoPath };
}

function buildDarwinUniversal(serviceDir, releaseRoot, targetRoot) {
  const tempRoot = path.join(releaseRoot, 'tmp', 'ssh-core', 'darwin');
  const amd64Path = path.join(tempRoot, 'ssh-core-amd64');
  const arm64Path = path.join(tempRoot, 'ssh-core-arm64');
  const hostsHelperAmd64Path = path.join(tempRoot, `${DNS_HELPER_BINARY_NAME}-amd64`);
  const hostsHelperArm64Path = path.join(tempRoot, `${DNS_HELPER_BINARY_NAME}-arm64`);
  const outputPath = path.join(targetRoot, 'ssh-core');
  const hostsHelperOutputPath = path.join(targetRoot, DNS_HELPER_BINARY_NAME);

  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  buildGoBinary(serviceDir, amd64Path, 'darwin', 'amd64');
  buildGoBinary(serviceDir, arm64Path, 'darwin', 'arm64');
  buildHostsHelperBinary(serviceDir, hostsHelperAmd64Path, 'darwin', 'amd64');
  buildHostsHelperBinary(serviceDir, hostsHelperArm64Path, 'darwin', 'arm64');
  run('lipo', ['-create', '-output', outputPath, amd64Path, arm64Path]);
  run('lipo', ['-create', '-output', hostsHelperOutputPath, hostsHelperAmd64Path, hostsHelperArm64Path]);
  ensureExecutable(outputPath);
  ensureExecutable(hostsHelperOutputPath);
}

function buildWindowsX64(serviceDir, targetRoot) {
  buildGoBinary(serviceDir, path.join(targetRoot, 'ssh-core.exe'), 'windows', 'amd64');
  const repoRoot = path.resolve(__dirname, '../../..');
  const { sysoPath, versionInfoPath } = buildWindowsDnsHelperVersionInfo(serviceDir, repoRoot);
  try {
    buildHostsHelperBinary(serviceDir, path.join(targetRoot, `${DNS_HELPER_BINARY_NAME}.exe`), 'windows', 'amd64');
  } finally {
    rmSync(sysoPath, { force: true });
    rmSync(versionInfoPath, { force: true });
  }
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
