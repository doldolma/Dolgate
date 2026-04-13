const { spawn } = require("child_process");

const {
  appRoot,
  buildEnvForIos,
  ensurePodsInstalled,
  ensureXcodeAvailable,
  getPreferredSimulatorName,
  hasExplicitDeviceSelection,
  removeLegacyIosApps,
} = require("./ios-env.cjs");

const reactNativeCli = require.resolve("react-native/cli.js", { paths: [appRoot] });
const command = process.execPath;

function buildRunIosArgs(extraArgs, env) {
  if (hasExplicitDeviceSelection(extraArgs) || extraArgs.includes("--list-devices")) {
    return [reactNativeCli, "run-ios", ...extraArgs];
  }

  const preferredSimulator = getPreferredSimulatorName(env);
  if (!preferredSimulator) {
    return [reactNativeCli, "run-ios", ...extraArgs];
  }

  return [reactNativeCli, "run-ios", "--simulator", preferredSimulator, ...extraArgs];
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const iosEnv = buildEnvForIos(process.env);

  ensureXcodeAvailable(iosEnv);
  ensurePodsInstalled(iosEnv);
  removeLegacyIosApps(extraArgs, iosEnv);

  const child = spawn(command, buildRunIosArgs(extraArgs, iosEnv), {
    cwd: appRoot,
    env: iosEnv,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
