const fs = require('node:fs/promises');
const { builtinModules } = require('node:module');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const desktopPackage = require(path.join(desktopRoot, 'package.json'));

const targetNodeModules = path.join(desktopRoot, 'node_modules');
const markerPath = path.join(targetNodeModules, '.dolssh-runtime-deps.json');

function isWorkspacePackage(packageName) {
  return packageName.startsWith('@dolssh/');
}

function isBuiltinDependency(packageName) {
  return builtinModules.includes(packageName) || builtinModules.includes(`node:${packageName}`);
}

function packageNameToPath(packageName) {
  return path.join(targetNodeModules, ...packageName.split('/'));
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
      await fs.rm(packageNameToPath(packageName), { recursive: true, force: true });
    })
  );
}

function resolveInstalledPackageJson(packageName) {
  const entryPath = require.resolve(packageName, {
    paths: [desktopRoot, repoRoot]
  });

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

async function collectRuntimeDependencyGraph() {
  const queue = Object.keys(desktopPackage.dependencies || {}).filter((packageName) => !isWorkspacePackage(packageName));
  const visited = new Set();
  const packages = [];

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || visited.has(packageName) || isWorkspacePackage(packageName)) {
      continue;
    }

    const manifestPath = resolveInstalledPackageJson(packageName);
    const manifestDirectory = path.dirname(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    visited.add(manifest.name);
    packages.push({
      name: manifest.name,
      sourceDirectory: manifestDirectory
    });

    const childDependencies = {
      ...(manifest.dependencies || {}),
      ...(manifest.optionalDependencies || {})
    };

    for (const childName of Object.keys(childDependencies)) {
      if (!visited.has(childName) && !isWorkspacePackage(childName) && !isBuiltinDependency(childName)) {
        queue.push(childName);
      }
    }
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

  const packages = await collectRuntimeDependencyGraph();

  for (const runtimePackage of packages) {
    const destination = packageNameToPath(runtimePackage.name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { recursive: true, force: true });
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

  console.log(`desktop runtime dependency sync 완료: ${packages.length}개 패키지`);
}

if (require.main === module) {
  copyRuntimeDependencies().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  copyRuntimeDependencies
};
