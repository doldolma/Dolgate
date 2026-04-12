const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const serviceRoot = path.join(repoRoot, "services", "ssh-core");
const buildScriptPath = path.join(__dirname, "build-ssh-core.cjs");
const forceBuild = process.env.DOLSSH_FORCE_BUILD_SSH_CORE === "1";

function resolveDevBuildTarget({ platform = process.platform } = {}) {
  if (platform === "win32") {
    return { platform: "win32", arch: "x64" };
  }

  if (platform === "darwin") {
    return { platform: "darwin", arch: "universal" };
  }

  return null;
}

function getTargetRoot({
  releaseRoot = path.join(desktopRoot, "release"),
  target,
}) {
  return path.join(
    releaseRoot,
    "resources",
    target.platform,
    target.arch,
    "bin",
  );
}

function getDevBuildMarkerPath({ targetRoot }) {
  return path.join(targetRoot, ".dolssh-ssh-core-dev-build.json");
}

function getDevBuildLockPath({ targetRoot }) {
  return path.join(targetRoot, ".dolssh-ssh-core-dev-build.lock");
}

function getRequiredOutputNames(target) {
  if (target.platform === "darwin" && target.arch === "universal") {
    return ["ssh-core", "dolgate-dns-helper"];
  }

  if (target.platform === "win32" && target.arch === "x64") {
    return ["ssh-core.exe", "dolgate-dns-helper.exe", "aws-conpty-wrapper.exe"];
  }

  throw new Error(
    `Unsupported ssh-core dev target: ${target.platform}/${target.arch}`,
  );
}

function resolveRequiredOutputs({ target, targetRoot }) {
  return getRequiredOutputNames(target).map((name) => path.join(targetRoot, name));
}

function outputsExist(outputPaths) {
  return outputPaths.every((outputPath) => existsSync(outputPath));
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

async function collectDevBuildFingerprintFiles({
  repoRoot: resolvedRepoRoot = repoRoot,
  desktopRoot: resolvedDesktopRoot = desktopRoot,
  serviceRoot: resolvedServiceRoot = serviceRoot,
  target,
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

  await addDirectory(resolvedServiceRoot);
  addFile(path.join(resolvedDesktopRoot, "scripts", "build-ssh-core-dev.cjs"));
  addFile(path.join(resolvedDesktopRoot, "scripts", "build-ssh-core.cjs"));
  addFile(path.join(resolvedDesktopRoot, "package.json"));
  addFile(path.join(resolvedServiceRoot, "go.mod"));
  addFile(path.join(resolvedServiceRoot, "go.sum"));

  if (target?.platform === "win32") {
    addFile(
      path.join(resolvedRepoRoot, "apps", "desktop", "build", "icons", "dolssh.ico"),
    );
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

function getGoVersion({ spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl("go", ["version"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error("Unable to determine Go toolchain version.");
  }

  return String(result.stdout || "").trim();
}

function buildFingerprintKey({
  target,
  goVersion,
  contentFingerprint,
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      target,
      goVersion,
      contentFingerprint,
    }))
    .digest("hex");
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

async function writeMarker(markerPath, payload) {
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function decideDevBuildAction({
  force = false,
  fingerprint,
  previousFingerprint,
  outputsReady,
}) {
  if (force) {
    return "build";
  }

  if (!outputsReady) {
    return "build";
  }

  if (!previousFingerprint || previousFingerprint !== fingerprint) {
    return "build";
  }

  return "reuse";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireBuildLock(lockPath, { timeoutMs = 120000, pollMs = 200 } = {}) {
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      return {
        async release() {
          await handle.close().catch(() => {});
          await fs.rm(lockPath, { force: true }).catch(() => {});
        },
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for ssh-core dev build lock.");
      }
      await sleep(pollMs);
    }
  }
}

function runBuild(target) {
  const result = spawnSync(process.execPath, [buildScriptPath, target.platform, target.arch], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Local ssh-core dev binary build failed.");
  }
}

async function ensureSshCoreDevBuild({
  platform = process.platform,
  repoRoot: resolvedRepoRoot = repoRoot,
  desktopRoot: resolvedDesktopRoot = desktopRoot,
  releaseRoot = path.join(resolvedDesktopRoot, "release"),
  force = forceBuild,
  getGoVersionImpl = getGoVersion,
  buildImpl = runBuild,
  acquireBuildLockImpl = acquireBuildLock,
} = {}) {
  const target = resolveDevBuildTarget({ platform });
  if (!target) {
    return { skipped: true };
  }

  const targetRoot = getTargetRoot({ releaseRoot, target });
  const markerPath = getDevBuildMarkerPath({ targetRoot });
  const lockPath = getDevBuildLockPath({ targetRoot });
  const requiredOutputs = resolveRequiredOutputs({ target, targetRoot });
  const fingerprintFiles = await collectDevBuildFingerprintFiles({
    repoRoot: resolvedRepoRoot,
    desktopRoot: resolvedDesktopRoot,
    serviceRoot: path.join(resolvedRepoRoot, "services", "ssh-core"),
    target,
  });
  const contentFingerprint = await createContentFingerprint(
    fingerprintFiles,
    resolvedRepoRoot,
  );
  const goVersion = getGoVersionImpl();
  const fingerprint = buildFingerprintKey({
    target,
    goVersion,
    contentFingerprint,
  });

  const currentAction = async () => {
    const previousMarker = await readMarker(markerPath);
    return decideDevBuildAction({
      force,
      fingerprint,
      previousFingerprint: previousMarker?.fingerprint ?? null,
      outputsReady: outputsExist(requiredOutputs),
    });
  };

  if ((await currentAction()) === "reuse") {
    console.log(`Reusing ssh-core dev build for ${target.platform}/${target.arch}`);
    return { reused: true, target, markerPath };
  }

  await fs.mkdir(targetRoot, { recursive: true });
  const lock = await acquireBuildLockImpl(lockPath);
  try {
    if ((await currentAction()) === "reuse") {
      console.log(`Reusing ssh-core dev build for ${target.platform}/${target.arch}`);
      return { reused: true, target, markerPath };
    }

    await buildImpl(target);

    await writeMarker(markerPath, {
      fingerprint,
      goVersion,
      generatedAt: new Date().toISOString(),
      target,
    });

    console.log(`Built ssh-core dev binaries for ${target.platform}/${target.arch}`);
    return { reused: false, target, markerPath };
  } finally {
    await lock.release();
  }
}

if (require.main === module) {
  ensureSshCoreDevBuild().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  acquireBuildLock,
  buildFingerprintKey,
  collectDevBuildFingerprintFiles,
  createContentFingerprint,
  decideDevBuildAction,
  ensureSshCoreDevBuild,
  getDevBuildLockPath,
  getDevBuildMarkerPath,
  getGoVersion,
  getRequiredOutputNames,
  getTargetRoot,
  outputsExist,
  resolveDevBuildTarget,
  resolveRequiredOutputs,
};
