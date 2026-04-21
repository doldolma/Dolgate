const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const metroPort = 8081;
const metroStatusUrl = `http://127.0.0.1:${metroPort}/status`;
const metroReadyText = "packager-status:running";
const metroTimeoutMs = 60_000;
const metroStatePath = path.join(os.tmpdir(), "dolgate-mobile-metro.json");
const metroLockPath = path.join(os.tmpdir(), "dolgate-mobile-metro.lock");
const metroLogPath = path.join(os.tmpdir(), "dolgate-mobile-metro.log");

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

  throw new Error(
    `Metro did not become ready on http://127.0.0.1:${metroPort} within 60 seconds.`,
  );
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function signalExitCode(signal) {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

async function stopChild(child, signal = "SIGINT", timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }

  const exitPromise = waitForChildExit(child).catch(() => null);

  try {
    child.kill(signal);
  } catch {
    return;
  }

  const result = await Promise.race([
    exitPromise,
    delay(timeoutMs).then(() => "timeout"),
  ]);

  if (result !== "timeout") {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {}
  await exitPromise.catch(() => null);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listPortListeners(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 5_000,
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return (result.stdout || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      command: parts[0],
      pid: Number.parseInt(parts[1], 10),
    }))
    .filter((entry) => Number.isInteger(entry.pid));
}

async function stopPids(pids, signal = "SIGTERM", timeoutMs = 10_000) {
  const uniquePids = Array.from(
    new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)),
  );

  if (uniquePids.length === 0) {
    return;
  }

  for (const pid of uniquePids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = uniquePids.filter((pid) => isPidAlive(pid));
    if (remaining.length === 0) {
      return;
    }
    await delay(200);
  }

  for (const pid of uniquePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function readMetroState() {
  if (!fs.existsSync(metroStatePath)) {
    return {
      metroPid: null,
      logPath: metroLogPath,
      clients: [],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(metroStatePath, "utf8"));
    return {
      metroPid: Number.isInteger(parsed.metroPid) ? parsed.metroPid : null,
      logPath: typeof parsed.logPath === "string" ? parsed.logPath : metroLogPath,
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    };
  } catch {
    return {
      metroPid: null,
      logPath: metroLogPath,
      clients: [],
    };
  }
}

function normalizeMetroState(state) {
  return {
    metroPid: isPidAlive(state.metroPid) ? state.metroPid : null,
    logPath: state.logPath || metroLogPath,
    clients: (state.clients || []).filter((client) => isPidAlive(client.pid)),
  };
}

function writeMetroState(state) {
  const normalized = normalizeMetroState(state);
  if (!normalized.metroPid && normalized.clients.length === 0) {
    fs.rmSync(metroStatePath, { force: true });
    return;
  }

  fs.writeFileSync(
    metroStatePath,
    JSON.stringify(normalized, null, 2),
    "utf8",
  );
}

async function withMetroLock(fn) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      fs.mkdirSync(metroLockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const lockStats = fs.existsSync(metroLockPath)
        ? fs.statSync(metroLockPath)
        : null;
      if (lockStats && Date.now() - lockStats.mtimeMs > 30_000) {
        fs.rmSync(metroLockPath, { recursive: true, force: true });
        continue;
      }

      await delay(150);
    }
  }

  if (!fs.existsSync(metroLockPath)) {
    throw new Error("Timed out waiting for the shared Metro lock.");
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(metroLockPath, { recursive: true, force: true });
  }
}

function startDetachedMetro({ appRoot, nodeCommand, reactNativeCli, env }) {
  const logFd = fs.openSync(metroLogPath, "a");
  const child = spawn(nodeCommand, [reactNativeCli, "start", "--reset-cache"], {
    cwd: appRoot,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    shell: false,
  });
  child.unref();
  fs.closeSync(logFd);
  return child.pid;
}

async function ensureSharedMetro({
  appRoot,
  env,
  nodeCommand,
  reactNativeCli,
  clientLabel,
}) {
  return withMetroLock(async () => {
    let state = normalizeMetroState(readMetroState());
    const listeners = listPortListeners(metroPort);
    const metroIsReady = await probeMetro();

    if (state.metroPid && metroIsReady) {
      const nextClients = state.clients.filter((client) => client.pid !== process.pid);
      nextClients.push({ pid: process.pid, label: clientLabel });
      writeMetroState({ ...state, clients: nextClients });
      return {
        startedMetro: false,
        metroPid: state.metroPid,
        logPath: state.logPath,
      };
    }

    if (listeners.length > 0) {
      if (!metroIsReady) {
        const owners = listeners
          .map((listener) => `${listener.command}(${listener.pid})`)
          .join(", ");
        throw new Error(
          `Port ${metroPort} is already in use by ${owners}. Stop it first before starting a mobile dev session.`,
        );
      }

      console.log(`Stopping existing Metro on :${metroPort}...`);
      await stopPids(listeners.map((listener) => listener.pid));
    }

    const metroPid = startDetachedMetro({
      appRoot,
      env,
      nodeCommand,
      reactNativeCli,
    });

    try {
      await waitForMetroReady();
    } catch (error) {
      await stopPids([metroPid], "SIGTERM", 3_000);
      throw error;
    }

    state = {
      metroPid,
      logPath: metroLogPath,
      clients: [{ pid: process.pid, label: clientLabel }],
    };
    writeMetroState(state);

    return {
      startedMetro: true,
      metroPid,
      logPath: metroLogPath,
    };
  });
}

async function releaseSharedMetro({ clientPid = process.pid } = {}) {
  return withMetroLock(async () => {
    const state = normalizeMetroState(readMetroState());
    const remainingClients = state.clients.filter((client) => client.pid !== clientPid);

    if (remainingClients.length === 0 && state.metroPid) {
      await stopPids([state.metroPid]);
      writeMetroState({
        metroPid: null,
        logPath: state.logPath,
        clients: [],
      });
      return { stoppedMetro: true };
    }

    writeMetroState({
      metroPid: state.metroPid,
      logPath: state.logPath,
      clients: remainingClients,
    });
    return { stoppedMetro: false };
  });
}

async function runDevSession({
  appRoot,
  env,
  nodeCommand,
  reactNativeCli,
  platformLabel,
  launchPlatform,
  cleanupPlatform,
}) {
  const sessionState = {
    cleanupStarted: false,
    platformState: null,
    metroSession: null,
    resolveSession: null,
    rejectSession: null,
    metroMonitorTimer: null,
  };

  const sessionPromise = new Promise((resolve, reject) => {
    sessionState.resolveSession = resolve;
    sessionState.rejectSession = reject;
  });

  async function cleanup({
    exitCode = 0,
    signal = null,
    failure = null,
  } = {}) {
    if (sessionState.cleanupStarted) {
      return;
    }
    sessionState.cleanupStarted = true;

    if (sessionState.metroMonitorTimer) {
      clearInterval(sessionState.metroMonitorTimer);
      sessionState.metroMonitorTimer = null;
    }

    try {
      console.log("Stopping app...");
      await cleanupPlatform(sessionState.platformState);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }

    try {
      const releaseResult = await releaseSharedMetro();
      if (releaseResult.stoppedMetro) {
        console.log("Stopping Metro...");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }

    if (failure) {
      sessionState.rejectSession(failure);
      return;
    }

    if (signal) {
      sessionState.resolveSession({ exitCode: signalExitCode(signal) });
      return;
    }

    sessionState.resolveSession({ exitCode });
  }

  const handleSignal = (signal) => {
    if (sessionState.cleanupStarted) {
      return;
    }
    void cleanup({ signal });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    const metroSession = await ensureSharedMetro({
      appRoot,
      env,
      nodeCommand,
      reactNativeCli,
      clientLabel: platformLabel,
    });
    sessionState.metroSession = metroSession;

    if (metroSession.startedMetro) {
      console.log("Starting Metro...");
    } else {
      console.log(`Using shared Metro on :${metroPort}.`);
    }

    console.log(`Launching ${platformLabel} app...`);
    sessionState.platformState = await launchPlatform();
    console.log("Dolgate mobile dev session is running. Press Ctrl+C to stop.");

    sessionState.metroMonitorTimer = setInterval(() => {
      if (sessionState.cleanupStarted) {
        return;
      }

      void (async () => {
        if (await probeMetro()) {
          return;
        }

        await cleanup({
          exitCode: 1,
          failure: new Error("Metro stopped unexpectedly."),
        });
      })();
    }, 3_000);
  } catch (error) {
    await cleanup({
      exitCode: 1,
      failure:
        error instanceof Error
          ? error
          : new Error(String(error)),
    });
  }

  const result = await sessionPromise.finally(() => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  });

  process.exit(result.exitCode);
}

module.exports = {
  delay,
  probeMetro,
  releaseSharedMetro,
  runDevSession,
  signalExitCode,
  stopChild,
  waitForChildExit,
};
