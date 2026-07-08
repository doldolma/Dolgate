const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  acquireBuildLock,
  buildFingerprintKey,
  collectDevBuildFingerprintFiles,
  createContentFingerprint,
  ensureSshCoreDevBuild,
  getDevBuildMarkerPath,
  getTargetRoot,
  readLockOwnerPid,
  resolveDevBuildTarget,
  resolveRequiredOutputs,
} = require("../scripts/build-ssh-core-dev.cjs");

async function createFixture({ platform = "darwin" } = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-core-dev-build-"));
  const desktopRoot = path.join(repoRoot, "apps", "desktop");
  const serviceRoot = path.join(repoRoot, "services", "ssh-core");

  await fs.mkdir(path.join(desktopRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(desktopRoot, "release"), { recursive: true });
  await fs.mkdir(path.join(serviceRoot, "cmd", "ssh-core"), { recursive: true });
  await fs.mkdir(path.join(serviceRoot, "internal", "sshconn"), {
    recursive: true,
  });

  await fs.writeFile(
    path.join(desktopRoot, "package.json"),
    JSON.stringify({ version: "1.3.3" }),
  );
  await fs.writeFile(
    path.join(desktopRoot, "scripts", "build-ssh-core-dev.cjs"),
    "module.exports = {};",
  );
  await fs.writeFile(
    path.join(desktopRoot, "scripts", "build-ssh-core.cjs"),
    "module.exports = {};",
  );
  await fs.writeFile(
    path.join(serviceRoot, "go.mod"),
    "module example.com/ssh-core\n\ngo 1.24.0\n",
  );
  await fs.writeFile(path.join(serviceRoot, "go.sum"), "");
  await fs.writeFile(
    path.join(serviceRoot, "cmd", "ssh-core", "main.go"),
    "package main\nfunc main() {}\n",
  );
  await fs.writeFile(
    path.join(serviceRoot, "internal", "sshconn", "sshconn.go"),
    "package sshconn\n",
  );

  if (platform === "win32") {
    await fs.mkdir(path.join(desktopRoot, "build", "icons"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(desktopRoot, "build", "icons", "dolssh.ico"),
      "icon",
    );
  }

  return { repoRoot, desktopRoot };
}

async function cleanupFixture(fixture) {
  await fs.rm(fixture.repoRoot, { recursive: true, force: true });
}

async function writeOutputs(targetRoot, outputPaths) {
  await fs.mkdir(targetRoot, { recursive: true });
  await Promise.all(
    outputPaths.map((outputPath) => fs.writeFile(outputPath, "binary")),
  );
}

async function computeFingerprint({ repoRoot, desktopRoot, target, goVersion }) {
  const files = await collectDevBuildFingerprintFiles({
    repoRoot,
    desktopRoot,
    serviceRoot: path.join(repoRoot, "services", "ssh-core"),
    target,
  });
  const contentFingerprint = await createContentFingerprint(files, repoRoot);
  return buildFingerprintKey({
    target,
    goVersion,
    contentFingerprint,
  });
}

test("builds once and then reuses when fingerprint and outputs match", async () => {
  const fixture = await createFixture();
  const buildCalls = [];

  try {
    const getGoVersionImpl = () => "go version go1.24.0 darwin/arm64";
    const buildImpl = async (target) => {
      buildCalls.push(target);
      const targetRoot = getTargetRoot({
        releaseRoot: path.join(fixture.desktopRoot, "release"),
        target,
      });
      const outputs = resolveRequiredOutputs({ target, targetRoot });
      await writeOutputs(targetRoot, outputs);
    };

    const first = await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
    });
    const second = await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
    });

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(buildCalls.length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("rebuilds when an expected output is missing", async () => {
  const fixture = await createFixture();
  let buildCount = 0;

  try {
    const getGoVersionImpl = () => "go version go1.24.0 darwin/arm64";
    const buildImpl = async (target) => {
      buildCount += 1;
      const targetRoot = getTargetRoot({
        releaseRoot: path.join(fixture.desktopRoot, "release"),
        target,
      });
      const outputs = resolveRequiredOutputs({ target, targetRoot });
      await writeOutputs(targetRoot, outputs);
    };

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
    });

    const target = { platform: "darwin", arch: "universal" };
    const targetRoot = getTargetRoot({
      releaseRoot: path.join(fixture.desktopRoot, "release"),
      target,
    });
    const [firstOutput] = resolveRequiredOutputs({ target, targetRoot });
    await fs.rm(firstOutput, { force: true });

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
    });

    assert.equal(buildCount, 2);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("rebuilds when the fingerprint changes", async () => {
  const fixture = await createFixture();
  let buildCount = 0;

  try {
    const getGoVersionImpl = () => "go version go1.24.0 darwin/arm64";
    const buildImpl = async (target) => {
      buildCount += 1;
      const targetRoot = getTargetRoot({
        releaseRoot: path.join(fixture.desktopRoot, "release"),
        target,
      });
      const outputs = resolveRequiredOutputs({ target, targetRoot });
      await writeOutputs(targetRoot, outputs);
    };

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
    });

    await fs.writeFile(
      path.join(fixture.repoRoot, "services", "ssh-core", "internal", "sshconn", "sshconn.go"),
      "package sshconn\nconst Changed = true\n",
    );

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
    });

    assert.equal(buildCount, 2);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("rebuilds when the Go toolchain version changes", async () => {
  const fixture = await createFixture();
  let buildCount = 0;

  try {
    const buildImpl = async (target) => {
      buildCount += 1;
      const targetRoot = getTargetRoot({
        releaseRoot: path.join(fixture.desktopRoot, "release"),
        target,
      });
      const outputs = resolveRequiredOutputs({ target, targetRoot });
      await writeOutputs(targetRoot, outputs);
    };

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl: () => "go version go1.24.0 darwin/arm64",
      buildImpl,
    });

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl: () => "go version go1.25.0 darwin/arm64",
      buildImpl,
    });

    assert.equal(buildCount, 2);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("force mode always rebuilds", async () => {
  const fixture = await createFixture();
  let buildCount = 0;

  try {
    const getGoVersionImpl = () => "go version go1.24.0 darwin/arm64";
    const buildImpl = async (target) => {
      buildCount += 1;
      const targetRoot = getTargetRoot({
        releaseRoot: path.join(fixture.desktopRoot, "release"),
        target,
      });
      const outputs = resolveRequiredOutputs({ target, targetRoot });
      await writeOutputs(targetRoot, outputs);
    };

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
    });

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl,
      force: true,
    });

    assert.equal(buildCount, 2);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("re-checks the marker after waiting on a concurrent build lock", async () => {
  const fixture = await createFixture();
  let buildCount = 0;

  try {
    const target = { platform: "darwin", arch: "universal" };
    const targetRoot = getTargetRoot({
      releaseRoot: path.join(fixture.desktopRoot, "release"),
      target,
    });
    const markerPath = getDevBuildMarkerPath({ targetRoot });
    const outputs = resolveRequiredOutputs({ target, targetRoot });
    const getGoVersionImpl = () => "go version go1.24.0 darwin/arm64";

    const acquireBuildLockImpl = async () => {
      const fingerprint = await computeFingerprint({
        repoRoot: fixture.repoRoot,
        desktopRoot: fixture.desktopRoot,
        target,
        goVersion: getGoVersionImpl(),
      });
      await writeOutputs(targetRoot, outputs);
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(
        markerPath,
        JSON.stringify({ fingerprint, target }, null, 2),
      );
      return {
        async release() {},
      };
    };

    await ensureSshCoreDevBuild({
      platform: "darwin",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
      getGoVersionImpl,
      buildImpl: async () => {
        buildCount += 1;
      },
      acquireBuildLockImpl,
    });

    assert.equal(buildCount, 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("skips unsupported platforms", async () => {
  const fixture = await createFixture();

  try {
    const result = await ensureSshCoreDevBuild({
      platform: "freebsd",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
    });

    assert.deepEqual(result, { skipped: true });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("resolves the linux dev target from the host arch", () => {
  assert.deepEqual(resolveDevBuildTarget({ platform: "linux", arch: "x64" }), {
    platform: "linux",
    arch: "x64",
  });
  assert.deepEqual(resolveDevBuildTarget({ platform: "linux", arch: "arm64" }), {
    platform: "linux",
    arch: "arm64",
  });
});

test("acquireBuildLock records the owner pid and releases the lock", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-core-lock-"));
  const lockPath = path.join(dir, "build.lock");

  try {
    const lock = await acquireBuildLock(lockPath, { pid: 4242, logger: () => {} });
    assert.equal(await readLockOwnerPid(lockPath), 4242);

    await lock.release();
    await assert.rejects(fs.access(lockPath), "lock file should be gone after release");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("acquireBuildLock reclaims a stale lock left by a dead process", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-core-lock-"));
  const lockPath = path.join(dir, "build.lock");
  const logs = [];

  try {
    // Simulate a lock left behind by a build that was interrupted (Ctrl+C).
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999 }));

    const lock = await acquireBuildLock(lockPath, {
      pid: 4242,
      isProcessAliveImpl: () => false, // the recorded owner is gone
      logger: (message) => logs.push(message),
    });

    assert.equal(await readLockOwnerPid(lockPath), 4242, "current process took over");
    assert.ok(
      logs.some((line) => line.includes("stale") && line.includes("999999")),
      `expected a stale-lock notice, got ${JSON.stringify(logs)}`,
    );

    await lock.release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("acquireBuildLock waits then times out while a live owner holds the lock", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-core-lock-"));
  const lockPath = path.join(dir, "build.lock");
  const logs = [];

  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 4243 }));

    await assert.rejects(
      acquireBuildLock(lockPath, {
        pid: 4242,
        timeoutMs: 60,
        pollMs: 10,
        isProcessAliveImpl: () => true, // owner still running
        logger: (message) => logs.push(message),
      }),
      /Timed out waiting for ssh-core dev build lock/,
    );

    assert.ok(
      logs.some((line) => line.includes("Waiting for ssh-core dev build lock")),
      `expected a waiting notice, got ${JSON.stringify(logs)}`,
    );
    // A live owner's lock must never be removed.
    assert.equal(await readLockOwnerPid(lockPath), 4243);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
