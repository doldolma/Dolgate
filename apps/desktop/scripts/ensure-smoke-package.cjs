const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const outDir = path.join(desktopRoot, "out");

function resolvePackagedAppTarget({
  platform = process.platform,
  arch = process.arch,
  targetPlatform = process.env.DOLSSH_TARGET_PLATFORM,
  targetArch = process.env.DOLSSH_TARGET_ARCH,
} = {}) {
  const resolvedPlatform = (targetPlatform || platform || "").trim();
  const resolvedArch = (targetArch || arch || "").trim();

  if (!resolvedPlatform) {
    throw new Error("smoke package target platform is not set");
  }

  if (!resolvedArch) {
    throw new Error("smoke package target arch is not set");
  }

  return {
    platform: resolvedPlatform,
    arch: resolvedArch,
    outputDirName: `dolgate-${resolvedPlatform}-${resolvedArch}`,
  };
}

function resolveDefaultResourceArch(platform) {
  if (platform === "darwin") {
    return "universal";
  }

  if (platform === "win32") {
    return "x64";
  }

  return process.arch;
}

function resolveSmokeResourceTarget({
  platform = process.platform,
  targetPlatform = process.env.DOLSSH_TARGET_PLATFORM,
  targetArch = process.env.DOLSSH_TARGET_ARCH,
} = {}) {
  const resolvedPlatform = (targetPlatform || platform || "").trim();

  if (!resolvedPlatform) {
    throw new Error("smoke resource target platform is not set");
  }

  return {
    platform: resolvedPlatform,
    arch: (targetArch || resolveDefaultResourceArch(resolvedPlatform)).trim(),
  };
}

function getSmokeMarkerPath({
  outDir: resolvedOutDir = outDir,
  packageTarget,
}) {
  return path.join(
    resolvedOutDir,
    `.dolssh-smoke-package-${packageTarget.platform}-${packageTarget.arch}.json`,
  );
}

function decideSmokePackageAction({
  fresh = false,
  packagedAppExists,
  currentFingerprint,
  previousFingerprint,
}) {
  if (fresh) {
    return "package";
  }

  if (!packagedAppExists) {
    return "package";
  }

  if (!previousFingerprint || previousFingerprint !== currentFingerprint) {
    return "package";
  }

  return "reuse";
}

async function collectDirectoryFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const entries = [];

  async function walk(currentDir) {
    const children = await fs.readdir(currentDir, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = path.join(currentDir, child.name);
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (child.isFile()) {
        entries.push(absolutePath);
      }
    }
  }

  await walk(rootDir);
  return entries;
}

async function collectSmokeFingerprintFiles({
  desktopRoot: resolvedDesktopRoot = desktopRoot,
  repoRoot: resolvedRepoRoot = repoRoot,
  resourceTarget = resolveSmokeResourceTarget(),
} = {}) {
  const fileSet = new Set();

  const addFile = (absolutePath) => {
    if (absolutePath && existsSync(absolutePath)) {
      fileSet.add(path.resolve(absolutePath));
    }
  };

  const addDirectory = async (absolutePath) => {
    const files = await collectDirectoryFiles(absolutePath);
    for (const filePath of files) {
      addFile(filePath);
    }
  };

  await addDirectory(path.join(resolvedDesktopRoot, "src"));
  await addDirectory(path.join(resolvedDesktopRoot, "assets"));
  await addDirectory(path.join(resolvedDesktopRoot, "config"));
  await addDirectory(
    path.join(
      resolvedDesktopRoot,
      "release",
      "resources",
      resourceTarget.platform,
      resourceTarget.arch,
      "bin",
    ),
  );

  addFile(path.join(resolvedDesktopRoot, "package.json"));
  addFile(path.join(resolvedRepoRoot, "package-lock.json"));
  addFile(path.join(resolvedDesktopRoot, "forge.config.ts"));
  addFile(path.join(resolvedDesktopRoot, "scripts", "generate-icons.cjs"));
  addFile(path.join(resolvedDesktopRoot, "scripts", "sync-runtime-deps.cjs"));
  addFile(path.join(resolvedDesktopRoot, "scripts", "build-ssh-core-dev.cjs"));

  const desktopRootEntries = await fs.readdir(resolvedDesktopRoot, {
    withFileTypes: true,
  });
  for (const entry of desktopRootEntries) {
    if (entry.isFile() && /^vite\..+\.config\.ts$/.test(entry.name)) {
      addFile(path.join(resolvedDesktopRoot, entry.name));
    }
  }

  return Array.from(fileSet).sort((left, right) => left.localeCompare(right));
}

async function createContentFingerprint(filePaths, baseDir = repoRoot) {
  const hash = createHash("sha256");

  for (const filePath of [...filePaths].sort((left, right) => left.localeCompare(right))) {
    const relativePath = path.relative(baseDir, filePath);
    const content = await fs.readFile(filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function packagedAppExists(packageTarget) {
  const outputDir = path.join(outDir, packageTarget.outputDirName);

  if (packageTarget.platform === "darwin") {
    return (
      existsSync(path.join(outputDir, "dolgate.app", "Contents", "MacOS", "dolgate")) ||
      existsSync(path.join(outputDir, "dolgate.app", "Contents", "Resources", "app.asar"))
    );
  }

  if (packageTarget.platform === "win32") {
    return (
      existsSync(path.join(outputDir, "dolgate.exe")) ||
      existsSync(path.join(outputDir, "resources", "app.asar"))
    );
  }

  return (
    existsSync(path.join(outputDir, "dolgate")) ||
    existsSync(path.join(outputDir, "resources", "app.asar"))
  );
}

async function readMarker(markerPath) {
  try {
    const raw = await fs.readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.fingerprint === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveElectronForgeCommand() {
  const binaryName = process.platform === "win32" ? "electron-forge.cmd" : "electron-forge";
  const candidates = [
    path.join(desktopRoot, "node_modules", ".bin", binaryName),
    path.join(repoRoot, "node_modules", ".bin", binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate ${binaryName} in workspace node_modules/.bin`);
}

function runCommand(command, args) {
  const isWindowsShellCommand =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    stdio: "inherit",
  env: process.env,
    shell: isWindowsShellCommand,
  });

  if (result.error) {
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} failed: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

async function writeMarker(markerPath, payload) {
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function ensureSmokePackage({
  fresh = false,
  platform = process.platform,
  arch = process.arch,
  targetPlatform = process.env.DOLSSH_TARGET_PLATFORM,
  targetArch = process.env.DOLSSH_TARGET_ARCH,
} = {}) {
  const packageTarget = resolvePackagedAppTarget({
    platform,
    arch,
    targetPlatform,
    targetArch,
  });
  const resourceTarget = resolveSmokeResourceTarget({
    platform,
    targetPlatform,
    targetArch,
  });
  const markerPath = getSmokeMarkerPath({ packageTarget });
  const previousMarker = await readMarker(markerPath);
  const fingerprintFiles = await collectSmokeFingerprintFiles({
    resourceTarget,
  });
  const fingerprint = await createContentFingerprint(fingerprintFiles);
  const action = decideSmokePackageAction({
    fresh,
    packagedAppExists: packagedAppExists(packageTarget),
    currentFingerprint: fingerprint,
    previousFingerprint: previousMarker?.fingerprint ?? null,
  });

  if (action === "reuse") {
    console.log(
      `Reusing packaged smoke app for ${packageTarget.platform}/${packageTarget.arch}`,
    );
    return {
      reused: true,
      fingerprint,
      markerPath,
      packageTarget,
      resourceTarget,
    };
  }

  runCommand(process.execPath, ["./scripts/generate-icons.cjs"]);
  runCommand(process.execPath, ["./scripts/sync-runtime-deps.cjs"]);

  const forgeArgs = ["package"];
  if (targetPlatform) {
    forgeArgs.push("--platform", targetPlatform);
  }
  if (targetArch) {
    forgeArgs.push("--arch", targetArch);
  }
  runCommand(resolveElectronForgeCommand(), forgeArgs);

  await writeMarker(markerPath, {
    fingerprint,
    generatedAt: new Date().toISOString(),
    packageTarget,
    resourceTarget,
  });

  console.log(
    `Packaged smoke app for ${packageTarget.platform}/${packageTarget.arch}`,
  );

  return {
    reused: false,
    fingerprint,
    markerPath,
    packageTarget,
    resourceTarget,
  };
}

if (require.main === module) {
  ensureSmokePackage({
    fresh: process.argv.includes("--fresh"),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  collectSmokeFingerprintFiles,
  createContentFingerprint,
  decideSmokePackageAction,
  ensureSmokePackage,
  getSmokeMarkerPath,
  resolvePackagedAppTarget,
  resolveSmokeResourceTarget,
};
