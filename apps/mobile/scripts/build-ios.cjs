const path = require("path");
const { spawnSync } = require("child_process");
const { ensureMobileWorkspaceRuntime } = require("./prepare-runtime.cjs");

const {
  appRoot,
  iosRoot,
  buildEnvForIos,
  ensurePodsInstalled,
  ensureXcodeAvailable,
} = require("./ios-env.cjs");

const derivedDataPath = path.join(iosRoot, "build", "derived-data");
const outputAppPath = path.join(
  derivedDataPath,
  "Build",
  "Products",
  "Release-iphoneos",
  "Dolgate.app",
);

function main() {
  ensureMobileWorkspaceRuntime();

  const iosEnv = buildEnvForIos(process.env);

  ensureXcodeAvailable(iosEnv);
  ensurePodsInstalled(iosEnv);

  const result = spawnSync(
    "xcodebuild",
    [
      "-workspace",
      "Dolgate.xcworkspace",
      "-scheme",
      "Dolgate",
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-derivedDataPath",
      derivedDataPath,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    {
      cwd: iosRoot,
      env: iosEnv,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`iOS release build ready at ${outputAppPath}`);
}

main();
