const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const nodeAbi = require('node-abi');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const nodePtyRoot = path.join(desktopRoot, 'node_modules', 'node-pty');

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveElectronPackage() {
  const packageJsonPath = require.resolve('electron/package.json', {
    paths: [desktopRoot, repoRoot]
  });

  return {
    packageJsonPath,
    packageJson: require(packageJsonPath)
  };
}

function resolveElectronExecutable(packageJsonPath) {
  const electronDir = path.dirname(packageJsonPath);

  if (process.platform === 'darwin') {
    return path.join(electronDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }

  if (process.platform === 'win32') {
    return path.join(electronDir, 'dist', 'electron.exe');
  }

  return path.join(electronDir, 'dist', 'electron');
}

function resolveForgeMetaPath() {
  return path.join(nodePtyRoot, 'build', 'Release', '.forge-meta');
}

function resolveForgeMetaContent(electronVersion) {
  return `${process.arch}--${nodeAbi.getAbi(electronVersion, 'electron')}`;
}

function readForgeMeta(metaPath) {
  try {
    return fs.readFileSync(metaPath, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeForgeMeta(metaPath, metaContent) {
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, `${metaContent}\n`, 'utf8');
}

function runElectronProbe(electronExecutable) {
  const probeScript =
    `try { require(${JSON.stringify(nodePtyRoot)}); process.stdout.write('ok\\n'); process.exit(0); } ` +
    `catch (error) { process.stderr.write(String(error && (error.stack || error.message) || error) + '\\n'); process.exit(1); }`;

  const result = spawnSync(electronExecutable, ['-e', probeScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
  });

  if (result.error) {
    throw result.error;
  }

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function rebuildNodePty(electronVersion) {
  const cliPath = path.join(repoRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  const args = [
    cliPath,
    '--module-dir',
    desktopRoot,
    '--only',
    'node-pty',
    '--version',
    electronVersion
  ];

  if (process.platform === 'win32') {
    args.push('--sequential');
  }

  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`electron-rebuild failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function main() {
  if (!pathExists(nodePtyRoot)) {
    console.log('node-pty package not found; skipping Electron native prepare.');
    return;
  }

  const { packageJsonPath, packageJson } = resolveElectronPackage();
  const electronExecutable = resolveElectronExecutable(packageJsonPath);
  const metaPath = resolveForgeMetaPath();
  const metaContent = resolveForgeMetaContent(packageJson.version);

  if (!pathExists(electronExecutable)) {
    throw new Error(`Electron executable not found: ${electronExecutable}`);
  }

  const existingMeta = readForgeMeta(metaPath);
  if (existingMeta === metaContent) {
    const probe = runElectronProbe(electronExecutable);
    if (probe.ok) {
      console.log(`node-pty Electron native prepare already satisfied (${metaContent}).`);
      return;
    }

    console.log('node-pty forge metadata exists, but Electron probe failed. Rebuilding.');
  }

  const probe = runElectronProbe(electronExecutable);
  if (probe.ok) {
    writeForgeMeta(metaPath, metaContent);
    console.log(`node-pty Electron native prepare validated existing binary (${metaContent}).`);
    return;
  }

  console.log(`Rebuilding node-pty for Electron ${packageJson.version} (${metaContent})...`);
  rebuildNodePty(packageJson.version);

  const verifiedProbe = runElectronProbe(electronExecutable);
  if (!verifiedProbe.ok) {
    throw new Error(verifiedProbe.stderr.trim() || 'node-pty could not be loaded by Electron after rebuild.');
  }

  writeForgeMeta(metaPath, metaContent);
  console.log(`node-pty Electron native prepare completed (${metaContent}).`);
}

main();
