const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  resolvePackagedAppLaunch,
} = require("./packaged-app-launch.cjs");

const outDir = path.resolve("/tmp/dolgate-out");
const electronPath = path.resolve("/tmp/mock-electron");

function createPathExists(paths) {
  const knownPaths = new Set(
    paths.map((candidatePath) => path.resolve(candidatePath)),
  );
  return (candidatePath) => knownPaths.has(path.resolve(candidatePath));
}

test("prefers the current mac target instead of another packaged output", () => {
  const arm64Executable = path.join(
    outDir,
    "dolgate-darwin-arm64",
    "dolgate.app",
    "Contents",
    "MacOS",
    "dolgate",
  );
  const universalExecutable = path.join(
    outDir,
    "dolgate-darwin-universal",
    "dolgate.app",
    "Contents",
    "MacOS",
    "dolgate",
  );

  const launch = resolvePackagedAppLaunch({
    electronPath,
    outDir,
    platform: "darwin",
    arch: "arm64",
    pathExists: createPathExists([arm64Executable, universalExecutable]),
  });

  assert.deepEqual(launch, {
    executablePath: arm64Executable,
    args: [],
  });
});

test("uses explicit target platform and arch when provided", () => {
  const universalExecutable = path.join(
    outDir,
    "dolgate-darwin-universal",
    "dolgate.app",
    "Contents",
    "MacOS",
    "dolgate",
  );

  const launch = resolvePackagedAppLaunch({
    electronPath,
    outDir,
    platform: "darwin",
    arch: "arm64",
    targetPlatform: "darwin",
    targetArch: "universal",
    pathExists: createPathExists([universalExecutable]),
  });

  assert.deepEqual(launch, {
    executablePath: universalExecutable,
    args: [],
  });
});

test("wraps an asar override with the Electron executable", () => {
  const override = path.join(outDir, "custom", "app.asar");

  const launch = resolvePackagedAppLaunch({
    override,
    electronPath,
    outDir,
    platform: "darwin",
    arch: "arm64",
    pathExists: createPathExists([]),
  });

  assert.deepEqual(launch, {
    executablePath: electronPath,
    args: [override],
  });
});

test("falls back to the mac app.asar when the packaged executable is unavailable", () => {
  const macAsar = path.join(
    outDir,
    "dolgate-darwin-arm64",
    "dolgate.app",
    "Contents",
    "Resources",
    "app.asar",
  );

  const launch = resolvePackagedAppLaunch({
    electronPath,
    outDir,
    platform: "darwin",
    arch: "arm64",
    pathExists: createPathExists([macAsar]),
  });

  assert.deepEqual(launch, {
    executablePath: electronPath,
    args: [macAsar],
  });
});

test("uses the Windows packaged executable when targeting win32", () => {
  const winExecutable = path.join(
    outDir,
    "dolgate-win32-x64",
    "dolgate.exe",
  );

  const launch = resolvePackagedAppLaunch({
    electronPath,
    outDir,
    platform: "win32",
    arch: "x64",
    pathExists: createPathExists([winExecutable]),
  });

  assert.deepEqual(launch, {
    executablePath: winExecutable,
    args: [],
  });
});

test("fails instead of falling back to a different packaged target", () => {
  const universalExecutable = path.join(
    outDir,
    "dolgate-darwin-universal",
    "dolgate.app",
    "Contents",
    "MacOS",
    "dolgate",
  );

  assert.throws(
    () =>
      resolvePackagedAppLaunch({
        electronPath,
        outDir,
        platform: "darwin",
        arch: "arm64",
        pathExists: createPathExists([universalExecutable]),
      }),
    /dolgate-darwin-arm64/,
  );
});
