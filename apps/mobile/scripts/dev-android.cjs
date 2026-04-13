const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { appRoot, buildEnvForAndroid, resolveSdkDir } = require("./android-env.cjs");
const nodeCommand = process.execPath;
const reactNativeCli = require.resolve("react-native/cli.js", { paths: [appRoot] });
const metroStatusUrl = "http://127.0.0.1:8081/status";
const metroReadyText = "packager-status:running";
const metroTimeoutMs = 60_000;
const deviceReadyTimeoutMs = 180_000;

let metroChild = null;
let androidChild = null;
let emulatorChild = null;
let shuttingDown = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeMetro() {
  return new Promise((resolve) => {
    const request = http.get(metroStatusUrl, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").trim();
        resolve(response.statusCode === 200 && body === metroReadyText);
      });
    });

    request.on("error", () => resolve(false));
    request.setTimeout(2_000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForMetroReady() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < metroTimeoutMs) {
    if (await probeMetro()) {
      return;
    }
    await delay(1_000);
  }
  throw new Error("Metro did not become ready on http://127.0.0.1:8081 within 60 seconds.");
}

function spawnMetro() {
  return spawn(nodeCommand, [reactNativeCli, "start", "--reset-cache"], {
    cwd: appRoot,
    stdio: "inherit",
    shell: false,
  });
}

function spawnAndroid(extraArgs) {
  const androidScript = path.join(__dirname, "run-android.cjs");
  return spawn(nodeCommand, [androidScript, "--no-packager", ...extraArgs], {
    cwd: appRoot,
    stdio: "inherit",
    shell: false,
  });
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
    detached: false,
    stdio: "ignore",
  });
}

async function waitForDeviceReady(serial, env) {
  const adbPath = getToolPath("platform-tools", "adb");
  const startedAt = Date.now();

  while (Date.now() - startedAt < deviceReadyTimeoutMs) {
    const bootCheck = runTool(adbPath, ["-s", serial, "shell", "getprop", "sys.boot_completed"], env);
    if ((bootCheck.stdout || "").trim() === "1") {
      return;
    }
    await delay(2_000);
  }

  throw new Error(`Android device ${serial} did not finish booting within 180 seconds.`);
}

async function ensureDeviceReady(env) {
  const existingDevices = listConnectedDevices(env);
  if (existingDevices.length > 0) {
    await waitForDeviceReady(existingDevices[0], env);
    return existingDevices[0];
  }

  const avds = listAvds(env);
  if (avds.length === 0) {
    throw new Error("No Android device connected and no emulator AVDs are available.");
  }

  emulatorChild = startEmulator(avds[0], env);

  const startedAt = Date.now();
  while (Date.now() - startedAt < deviceReadyTimeoutMs) {
    const devices = listConnectedDevices(env);
    if (devices.length > 0) {
      await waitForDeviceReady(devices[0], env);
      return devices[0];
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

function forwardSignal(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (androidChild && !androidChild.killed) {
    androidChild.kill(signal);
  }
  if (metroChild && !metroChild.killed) {
    metroChild.kill(signal);
  }
  if (emulatorChild && !emulatorChild.killed) {
    emulatorChild.kill(signal);
  }
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const androidEnv = buildEnvForAndroid(process.env);
  const metroAlreadyRunning = await probeMetro();

  if (!metroAlreadyRunning) {
    metroChild = spawnMetro();
    metroChild.on("exit", (code, signal) => {
      if (shuttingDown) {
        return;
      }
      if (androidChild && !androidChild.killed) {
        androidChild.kill("SIGTERM");
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });

    await waitForMetroReady();
  }

  const deviceSerial = await ensureDeviceReady(androidEnv);
  adbReverse(deviceSerial, androidEnv);

  androidChild = spawnAndroid(extraArgs);
  androidChild.on("exit", (code, signal) => {
    if (signal) {
      forwardSignal(signal);
      return;
    }
    if ((code ?? 1) !== 0) {
      if (metroChild && !metroChild.killed) {
        metroChild.kill("SIGTERM");
      }
      process.exit(code ?? 1);
      return;
    }

    if (!metroChild) {
      process.exit(0);
      return;
    }

    console.log("Android app installed. Metro is still running; press Ctrl+C to stop.");
  });
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

main().catch((error) => {
  console.error(error.message);
  if (metroChild && !metroChild.killed) {
    metroChild.kill("SIGTERM");
  }
  process.exit(1);
});
