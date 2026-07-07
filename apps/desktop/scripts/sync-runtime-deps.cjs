const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { builtinModules } = require('node:module');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const desktopPackage = require(path.join(desktopRoot, 'package.json'));

const targetNodeModules = path.join(desktopRoot, 'node_modules');
const cacheNodeModules = path.join(desktopRoot, '.runtime-deps-cache', 'node_modules');
const markerPath = path.join(targetNodeModules, '.dolssh-runtime-deps.json');
const REMOVE_RETRY_DELAY_MS = 150;

function isWorkspacePackage(packageName) {
  return packageName.startsWith('@dolssh/');
}

function isBuiltinDependency(packageName) {
  return builtinModules.includes(packageName) || builtinModules.includes(`node:${packageName}`);
}

function packageNameToPath(packageName) {
  return path.join(targetNodeModules, ...packageName.split('/'));
}

function cachePackageNameToPath(packageName) {
  return path.join(cacheNodeModules, ...packageName.split('/'));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeWritable(targetPath) {
  try {
    await fs.chmod(targetPath, 0o700);
  } catch {
    // Best effort: the path may not exist or the platform may ignore chmod.
  }
}

async function makeTreeWritable(targetPath) {
  await makeWritable(targetPath);
  let entries;
  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const childPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        await makeTreeWritable(childPath);
      } else {
        await makeWritable(childPath);
      }
    })
  );
}

async function removePath(targetPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: REMOVE_RETRY_DELAY_MS });
      return;
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) {
        throw error;
      }
      await makeTreeWritable(targetPath);
      await sleep(REMOVE_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: REMOVE_RETRY_DELAY_MS });
}

function resolveTargetPlatform() {
  return process.env.DOLSSH_TARGET_PLATFORM || null;
}

function resolveTargetArch() {
  return process.env.DOLSSH_TARGET_ARCH || null;
}

function isCodexPlatformPackage(packageName) {
  return /^@openai\/codex-(darwin|linux|win32)-/.test(packageName);
}

function shouldIncludeRuntimePackage(
  packageName,
  targetPlatform = resolveTargetPlatform(),
  targetArch = resolveTargetArch()
) {
  if (isCodexPlatformPackage(packageName)) {
    return codexPlatformPackageTargets(
      targetPlatform || process.platform,
      targetArch || process.arch
    ).includes(packageName);
  }
  return true;
}

function codexPlatformPackageTargets(
  targetPlatform = resolveTargetPlatform() || process.platform,
  targetArch = resolveTargetArch() || process.arch
) {
  if (targetPlatform === 'darwin' && targetArch === 'universal') {
    return ['@openai/codex-darwin-arm64', '@openai/codex-darwin-x64'];
  }
  if (targetPlatform === 'darwin' && targetArch === 'arm64') {
    return ['@openai/codex-darwin-arm64'];
  }
  if (targetPlatform === 'darwin' && targetArch === 'x64') {
    return ['@openai/codex-darwin-x64'];
  }
  if (targetPlatform === 'win32' && targetArch === 'arm64') {
    return ['@openai/codex-win32-arm64'];
  }
  if (targetPlatform === 'win32' && targetArch === 'x64') {
    return ['@openai/codex-win32-x64'];
  }
  if (targetPlatform === 'linux' && targetArch === 'arm64') {
    return ['@openai/codex-linux-arm64'];
  }
  if (targetPlatform === 'linux' && targetArch === 'x64') {
    return ['@openai/codex-linux-x64'];
  }
  return [];
}

function shouldMaterializeOptionalPackage(packageName) {
  return codexPlatformPackageTargets().includes(packageName);
}

async function readMarker() {
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.packages) ? parsed.packages : [];
  } catch {
    return [];
  }
}

async function removePreviouslyCopiedPackages() {
  const previousPackages = await readMarker();
  await Promise.all(
    previousPackages.map(async (packageName) => {
      await removePath(packageNameToPath(packageName));
    })
  );
}

function resolveInstalledPackageJson(packageName) {
  const searchPaths = [repoRoot, desktopRoot, path.dirname(path.dirname(cacheNodeModules))];
  const cacheManifestCandidate = path.join(cachePackageNameToPath(packageName), 'package.json');
  if (existsSync(cacheManifestCandidate)) {
    return cacheManifestCandidate;
  }

  for (const searchRoot of searchPaths) {
    const manifestCandidate = path.join(
      searchRoot,
      'node_modules',
      ...packageName.split('/'),
      'package.json'
    );
    if (existsSync(manifestCandidate)) {
      return manifestCandidate;
    }
  }

  let entryPath;
  try {
    entryPath = require.resolve(`${packageName}/package.json`, {
      paths: searchPaths
    });
  } catch {
    entryPath = require.resolve(packageName, {
      paths: searchPaths
    });
  }

  let currentDirectory = path.dirname(entryPath);
  while (true) {
    const manifestPath = path.join(currentDirectory, 'package.json');
    try {
      require(manifestPath);
      return manifestPath;
    } catch {
      const parentDirectory = path.dirname(currentDirectory);
      if (parentDirectory === currentDirectory) {
        throw new Error(`${packageName} 패키지의 package.json을 찾을 수 없습니다.`);
      }
      currentDirectory = parentDirectory;
    }
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveCodexOptionalPackageSpec(packageName) {
  let codexManifestPath;
  try {
    codexManifestPath = resolveInstalledPackageJson('@openai/codex');
  } catch {
    return null;
  }

  const codexManifest = require(codexManifestPath);
  const spec = codexManifest.optionalDependencies?.[packageName];
  return typeof spec === 'string' ? spec : null;
}

async function materializeOptionalPackage(packageName) {
  if (!shouldMaterializeOptionalPackage(packageName)) {
    return null;
  }

  const destination = cachePackageNameToPath(packageName);
  const manifestPath = path.join(destination, 'package.json');
  if (existsSync(manifestPath)) {
    return manifestPath;
  }

  const spec = resolveCodexOptionalPackageSpec(packageName);
  if (!spec) {
    return null;
  }

  const tempRoot = path.join(desktopRoot, '.runtime-deps-cache', 'tmp');
  const tempDir = path.join(tempRoot, packageName.replaceAll('/', '__'));
  await removePath(tempDir);
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  execFileSync(npmCommand(), ['pack', spec, '--pack-destination', tempDir], {
    cwd: repoRoot,
    stdio: 'ignore'
  });
  const tarball = (await fs.readdir(tempDir)).find((entry) => entry.endsWith('.tgz'));
  if (!tarball) {
    throw new Error(`${packageName} 패키지 tarball을 찾을 수 없습니다.`);
  }
  await removePath(destination);
  await fs.mkdir(destination, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tempDir, tarball), '-C', destination, '--strip-components', '1'], {
    stdio: 'ignore'
  });
  await removePath(tempDir);
  return manifestPath;
}

async function collectRuntimeDependencyGraph() {
  const targetPlatform = resolveTargetPlatform();
  const queue = Object.keys(desktopPackage.dependencies || {})
    .filter(
      (packageName) => !isWorkspacePackage(packageName) && shouldIncludeRuntimePackage(packageName, targetPlatform)
    )
    .map((packageName) => ({ name: packageName, optional: false }));
  const visited = new Set();
  const packages = [];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry || visited.has(entry.name) || isWorkspacePackage(entry.name)) {
      continue;
    }

    // optionalDependencies 는 npm 의미론상 미설치일 수 있다(예: @openai/codex 의
    // 타 플랫폼 바이너리 패키지). resolve 실패 시 optional 이면 조용히 스킵한다.
    let manifestPath;
    try {
      manifestPath = resolveInstalledPackageJson(entry.name);
    } catch (error) {
      if (entry.optional) {
        manifestPath = await materializeOptionalPackage(entry.name);
        if (!manifestPath) {
          continue;
        }
      } else {
        throw error;
      }
    }
    const manifestDirectory = path.dirname(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    visited.add(entry.name);
    packages.push({
      name: entry.name,
      sourceDirectory: manifestDirectory
    });

    const enqueueChildren = (dependencyNames, optional) => {
      for (const childName of dependencyNames) {
        if (
          !visited.has(childName) &&
          !isWorkspacePackage(childName) &&
          !isBuiltinDependency(childName) &&
          shouldIncludeRuntimePackage(childName, targetPlatform)
        ) {
          queue.push({ name: childName, optional });
        }
      }
    };
    enqueueChildren(Object.keys(manifest.dependencies || {}), false);
    enqueueChildren(Object.keys(manifest.optionalDependencies || {}), true);
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function copyRuntimePackage(runtimePackage, destination) {
  await fs.cp(runtimePackage.sourceDirectory, destination, {
    recursive: true,
    dereference: true
  });
}

async function copyRuntimeDependencies() {
  await fs.mkdir(targetNodeModules, { recursive: true });
  await removePreviouslyCopiedPackages();

  const targetPlatform = resolveTargetPlatform();
  const packages = await collectRuntimeDependencyGraph();

  for (const runtimePackage of packages) {
    const destination = packageNameToPath(runtimePackage.name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await removePath(destination);
    await copyRuntimePackage(runtimePackage, destination);
  }

  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        packages: packages.map((runtimePackage) => runtimePackage.name)
      },
      null,
      2
    )
  );

  const targetLabel = targetPlatform ? ` (${targetPlatform})` : '';
  console.log(`desktop runtime dependency sync 완료${targetLabel}: ${packages.length}개 패키지`);
}

if (require.main === module) {
  copyRuntimeDependencies().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  copyRuntimeDependencies,
  collectRuntimeDependencyGraph,
  removePath,
  resolveInstalledPackageJson,
  shouldIncludeRuntimePackage,
  resolveTargetPlatform
};
