const { spawn } = require("child_process");

const { appRoot, buildEnvForAndroid } = require("./android-env.cjs");

const reactNativeCli = require.resolve("react-native/cli.js", { paths: [appRoot] });
const command = process.execPath;
const args = [reactNativeCli, "run-android", ...process.argv.slice(2)];
const androidEnv = buildEnvForAndroid(process.env);

const child = spawn(command, args, {
  cwd: appRoot,
  env: androidEnv,
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
