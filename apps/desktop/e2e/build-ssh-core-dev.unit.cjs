const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildFingerprintKey,
  collectDevBuildFingerprintFiles,
  createContentFingerprint,
  ensureSshCoreDevBuild,
  getDevBuildMarkerPath,
  getTargetRoot,
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
      platform: "linux",
      repoRoot: fixture.repoRoot,
      desktopRoot: fixture.desktopRoot,
    });

    assert.deepEqual(result, { skipped: true });
  } finally {
    await cleanupFixture(fixture);
  }
});
