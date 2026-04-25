const path = require("path");
const { spawn, spawnSync } = require("child_process");

const {
  appRoot,
  buildEnvForIos,
  ensurePodsInstalled,
  ensureXcodeAvailable,
} = require("./ios-env.cjs");
const { ensureRusshNative } = require("../../../packages/fressh-react-native-uniffi-russh/scripts/ensure-native.cjs");
const { runDevSession, waitForChildExit } = require("./dev-session.cjs");

const nodeCommand = process.execPath;
const reactNativeCli = require.resolve("react-native/cli.js", { paths: [appRoot] });
const iosScript = path.join(__dirname, "run-ios.cjs");
const iosBundleId = "com.dolgate";

function spawnIos(extraArgs, iosEnv) {
  return spawn(nodeCommand, [iosScript, "--no-packager", ...extraArgs], {
    cwd: appRoot,
    env: iosEnv,
    stdio: "inherit",
    shell: false,
  });
}

function terminateIosApp(env) {
  spawnSync("xcrun", ["simctl", "terminate", "booted", iosBundleId], {
    cwd: appRoot,
    env,
    stdio: "ignore",
    timeout: 15_000,
  });
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const iosEnv = buildEnvForIos(process.env);

  ensureXcodeAvailable(iosEnv);
  ensureRusshNative({ platform: "ios" });
  ensurePodsInstalled(iosEnv);

  await runDevSession({
    appRoot,
    env: iosEnv,
    nodeCommand,
    reactNativeCli,
    platformLabel: "iOS",
    prepareRuntimeOptions: { skipRussh: true },
    launchPlatform: async () => {
      const child = spawnIos(extraArgs, iosEnv);
      const { code, signal } = await waitForChildExit(child);
      if (signal) {
        throw new Error(`run-ios exited with signal ${signal}.`);
      }
      if ((code ?? 1) !== 0) {
        throw new Error(`run-ios exited with code ${code ?? 1}.`);
      }
      return { iosEnv };
    },
    cleanupPlatform: async (state) => {
      terminateIosApp(state?.iosEnv ?? iosEnv);
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
