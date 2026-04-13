const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const { appRoot, buildEnvForIos } = require("./ios-env.cjs");

const nodeCommand = process.execPath;
const reactNativeCli = require.resolve("react-native/cli.js", { paths: [appRoot] });
const metroStatusUrl = "http://127.0.0.1:8081/status";
const metroReadyText = "packager-status:running";
const metroTimeoutMs = 60_000;

let metroChild = null;
let iosChild = null;
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

function spawnIos(extraArgs, iosEnv) {
  const iosScript = path.join(__dirname, "run-ios.cjs");
  return spawn(nodeCommand, [iosScript, "--no-packager", ...extraArgs], {
    cwd: appRoot,
    env: iosEnv,
    stdio: "inherit",
    shell: false,
  });
}

function forwardSignal(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (iosChild && !iosChild.killed) {
    iosChild.kill(signal);
  }
  if (metroChild && !metroChild.killed) {
    metroChild.kill(signal);
  }
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const iosEnv = buildEnvForIos(process.env);
  const metroAlreadyRunning = await probeMetro();

  if (!metroAlreadyRunning) {
    metroChild = spawnMetro();
    metroChild.on("exit", (code, signal) => {
      if (shuttingDown) {
        return;
      }
      if (iosChild && !iosChild.killed) {
        iosChild.kill("SIGTERM");
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });

    await waitForMetroReady();
  }

  iosChild = spawnIos(extraArgs, iosEnv);
  iosChild.on("exit", (code, signal) => {
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

    console.log("iOS app installed. Metro is still running; press Ctrl+C to stop.");
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
