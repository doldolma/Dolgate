const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectSmokeFingerprintFiles,
  createContentFingerprint,
  decideSmokePackageAction,
  getSmokeMarkerPath,
  resolvePackagedAppTarget,
  resolveSmokeResourceTarget,
} = require("../scripts/ensure-smoke-package.cjs");

test("packages when the packaged app is missing", () => {
  assert.equal(
    decideSmokePackageAction({
      packagedAppExists: false,
      currentFingerprint: "next",
      previousFingerprint: "next",
    }),
    "package",
  );
});

test("reuses when the packaged app exists and the fingerprint matches", () => {
  assert.equal(
    decideSmokePackageAction({
      packagedAppExists: true,
      currentFingerprint: "same",
      previousFingerprint: "same",
    }),
    "reuse",
  );
});

test("packages again when the fingerprint changes", () => {
  assert.equal(
    decideSmokePackageAction({
      packagedAppExists: true,
      currentFingerprint: "next",
      previousFingerprint: "previous",
    }),
    "package",
  );
});

test("fresh mode always packages again", () => {
  assert.equal(
    decideSmokePackageAction({
      fresh: true,
      packagedAppExists: true,
      currentFingerprint: "same",
      previousFingerprint: "same",
    }),
    "package",
  );
});

test("uses distinct markers per packaged target", () => {
  const outDir = path.resolve("/tmp/dolgate-out");
  const arm64Marker = getSmokeMarkerPath({
    outDir,
    packageTarget: resolvePackagedAppTarget({
      platform: "darwin",
      arch: "arm64",
    }),
  });
  const universalMarker = getSmokeMarkerPath({
    outDir,
    packageTarget: resolvePackagedAppTarget({
      platform: "darwin",
      arch: "arm64",
      targetArch: "universal",
    }),
  });

  assert.notEqual(arm64Marker, universalMarker);
  assert.match(arm64Marker, /arm64/);
  assert.match(universalMarker, /universal/);
});

test("uses forge-style resource targets for default smoke packaging", () => {
  assert.deepEqual(
    resolveSmokeResourceTarget({
      platform: "darwin",
      targetPlatform: "darwin",
    }),
    { platform: "darwin", arch: "universal" },
  );
  assert.deepEqual(
    resolveSmokeResourceTarget({
      platform: "win32",
      targetPlatform: "win32",
    }),
    { platform: "win32", arch: "x64" },
  );
});

test("fingerprints are based on file contents, not just file paths", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-fingerprint-"));
  const filePath = path.join(tmpRoot, "fixture.txt");
  await fs.writeFile(filePath, "alpha");
  const alpha = await createContentFingerprint([filePath], tmpRoot);
  await fs.writeFile(filePath, "beta");
  const beta = await createContentFingerprint([filePath], tmpRoot);

  assert.notEqual(alpha, beta);

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test("collects the current target ssh-core bin directory into the fingerprint inputs", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-inputs-"));
  const desktopRoot = path.join(tmpRoot, "apps", "desktop");
  const repoRoot = tmpRoot;
  const binDir = path.join(
    desktopRoot,
    "release",
    "resources",
    "darwin",
    "universal",
    "bin",
  );

  await fs.mkdir(path.join(desktopRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(desktopRoot, "src", "main.ts"), "export {};\n");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "ssh-core"), "binary");
  await fs.writeFile(path.join(desktopRoot, "package.json"), "{}\n");
  await fs.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n");
  await fs.writeFile(path.join(desktopRoot, "forge.config.ts"), "export default {};\n");
  await fs.mkdir(path.join(desktopRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(desktopRoot, "scripts", "generate-icons.cjs"), "");
  await fs.writeFile(path.join(desktopRoot, "scripts", "sync-runtime-deps.cjs"), "");
  await fs.writeFile(path.join(desktopRoot, "scripts", "build-ssh-core-dev.cjs"), "");

  const files = await collectSmokeFingerprintFiles({
    desktopRoot,
    repoRoot,
    resourceTarget: { platform: "darwin", arch: "universal" },
  });

  assert(files.some((candidate) => candidate.endsWith(path.join("bin", "ssh-core"))));

  await fs.rm(tmpRoot, { recursive: true, force: true });
});
