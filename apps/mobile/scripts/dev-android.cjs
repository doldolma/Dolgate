const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const {
  appRoot,
  buildEnvForAndroid,
  resolveSdkDir,
} = require("./android-env.cjs");
const { ensureRusshNative } = require("../../../packages/fressh-react-native-uniffi-russh/scripts/ensure-native.cjs");
const {
  delay,
  runDevSession,
  stopChild,
  waitForChildExit,
} = require("./dev-session.cjs");

const nodeCommand = process.execPath;
const reactNativeCli = require.resolve("react-native/cli.js", { paths: [appRoot] });
const androidScript = path.join(__dirname, "run-android.cjs");
const deviceReadyTimeoutMs = 180_000;
const defaultAndroidArgs =
  process.env.DOLGATE_ANDROID_ALL_ARCHES === "1" ? [] : ["--active-arch-only"];

function spawnAndroid(extraArgs, androidEnv) {
  return spawn(
    nodeCommand,
    [androidScript, "--no-packager", ...defaultAndroidArgs, ...extraArgs],
    {
      cwd: appRoot,
      env: androidEnv,
      stdio: "inherit",
      shell: false,
    },
  );
}

function getToolPath(toolDir, toolName) {
  const sdkDir = resolveSdkDir();
  if (!sdkDir) {
    return toolName;
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.join(sdkDir, toolDir, `${toolName}${suffix}`);
}

function runTool(toolPath, args, env) {
  return spawnSync(toolPath, args, {
    cwd: appRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function listConnectedDevices(env) {
  const adbPath = getToolPath("platform-tools", "adb");
  const result = runTool(adbPath, ["devices"], env);
  if (result.error) {
    return [];
  }

  return (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached"))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === "device")
    .map((parts) => parts[0]);
}

function listAvds(env) {
  const emulatorPath = getToolPath("emulator", "emulator");
  if (!fs.existsSync(emulatorPath)) {
    return [];
  }
  const result = runTool(emulatorPath, ["-list-avds"], env);
  if (result.error) {
    return [];
  }

  return (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function startEmulator(avdName, env) {
  const emulatorPath = getToolPath("emulator", "emulator");
  return spawn(emulatorPath, ["-avd", avdName], {
    cwd: appRoot,
    env,
    stdio: "ignore",
    shell: false,
  });
}

async function waitForDeviceReady(serial, env) {
  const adbPath = getToolPath("platform-tools", "adb");
  const startedAt = Date.now();

  while (Date.now() - startedAt < deviceReadyTimeoutMs) {
    const bootCheck = runTool(
      adbPath,
      ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      env,
    );
    if ((bootCheck.stdout || "").trim() === "1") {
      return;
    }
    await delay(2_000);
  }

  throw new Error(
    `Android device ${serial} did not finish booting within 180 seconds.`,
  );
}

async function ensureDeviceReady(env) {
  const existingDevices = listConnectedDevices(env);
  if (existingDevices.length > 0) {
    await waitForDeviceReady(existingDevices[0], env);
    return {
      deviceSerial: existingDevices[0],
      emulatorChild: null,
      startedEmulator: false,
    };
  }

  const avds = listAvds(env);
  if (avds.length === 0) {
    throw new Error("No Android device connected and no emulator AVDs are available.");
  }

  const emulatorChild = startEmulator(avds[0], env);

  const startedAt = Date.now();
  while (Date.now() - startedAt < deviceReadyTimeoutMs) {
    const devices = listConnectedDevices(env);
    if (devices.length > 0) {
      await waitForDeviceReady(devices[0], env);
      return {
        deviceSerial: devices[0],
        emulatorChild,
        startedEmulator: true,
      };
    }
    await delay(2_000);
  }

  throw new Error(`Android emulator ${avds[0]} did not appear within 180 seconds.`);
}

function adbReverse(serial, env) {
  const adbPath = getToolPath("platform-tools", "adb");
  for (const port of ["8081", "8080"]) {
    runTool(adbPath, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], env);
  }
}

function forceStopAndroidApp(serial, env) {
  const adbPath = getToolPath("platform-tools", "adb");
  runTool(adbPath, ["-s", serial, "shell", "am", "force-stop", "com.dolgate"], env);
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const androidEnv = buildEnvForAndroid(process.env);
  ensureRusshNative({ platform: "android" });

  await runDevSession({
    appRoot,
    env: androidEnv,
    nodeCommand,
    reactNativeCli,
    platformLabel: "Android",
    prepareRuntimeOptions: { skipRussh: true },
    launchPlatform: async () => {
      const deviceState = await ensureDeviceReady(androidEnv);
      adbReverse(deviceState.deviceSerial, androidEnv);

      const child = spawnAndroid(extraArgs, androidEnv);
      const { code, signal } = await waitForChildExit(child);
      if (signal) {
        throw new Error(`run-android exited with signal ${signal}.`);
      }
      if ((code ?? 1) !== 0) {
        throw new Error(`run-android exited with code ${code ?? 1}.`);
      }

      return {
        ...deviceState,
        androidEnv,
      };
    },
    cleanupPlatform: async (state) => {
      if (state?.deviceSerial) {
        forceStopAndroidApp(state.deviceSerial, state.androidEnv ?? androidEnv);
      }

      if (state?.startedEmulator && state.emulatorChild) {
        console.log("Stopping emulator...");
        await stopChild(state.emulatorChild);
      }
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
