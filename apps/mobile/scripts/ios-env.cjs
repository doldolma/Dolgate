const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const appRoot = path.resolve(__dirname, "..");
const iosRoot = path.join(appRoot, "ios");
const xcodeWorkspaceName = "Dolgate.xcworkspace";
const legacyIosBundleIds = ["com.dolgate.mobile"];

function hasExecutable(candidatePath) {
  return Boolean(candidatePath && fs.existsSync(candidatePath));
}

function resolveDeveloperDir() {
  const candidates = [
    process.env.DEVELOPER_DIR,
    "/Applications/Xcode.app/Contents/Developer",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      hasExecutable(path.join(candidate, "usr", "bin", "xcodebuild")) &&
      fs.existsSync(path.join(candidate, "Applications", "Simulator.app"))
    ) {
      return candidate;
    }
  }

  return null;
}

function buildEnvForIos(baseEnv) {
  const env = { ...baseEnv };
  const extraPaths = [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"];
  const developerDir = resolveDeveloperDir();

  env.NODE_BINARY = env.NODE_BINARY || process.execPath;
  if (developerDir) {
    env.DEVELOPER_DIR = developerDir;
    extraPaths.push(path.join(developerDir, "usr", "bin"));
  }

  env.PATH = [...extraPaths, env.PATH || ""].filter(Boolean).join(path.delimiter);
  return env;
}

function ensureXcodeAvailable(env) {
  const result = spawnSync("xcodebuild", ["-version"], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    "Xcode를 찾지 못했습니다. /Applications/Xcode.app 이 설치되어 있는지 확인해 주세요.",
  );
}

function ensureCocoaPodsAvailable(env) {
  const result = spawnSync("pod", ["--version"], {
    cwd: iosRoot,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    "CocoaPods를 찾지 못했습니다. `brew install cocoapods` 후 다시 시도해 주세요.",
  );
}

function readFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function shouldInstallPods() {
  const workspacePath = path.join(iosRoot, xcodeWorkspaceName);
  const podfilePath = path.join(iosRoot, "Podfile");
  const podfileLockPath = path.join(iosRoot, "Podfile.lock");
  const manifestLockPath = path.join(iosRoot, "Pods", "Manifest.lock");

  if (!fs.existsSync(workspacePath) || !fs.existsSync(podfileLockPath)) {
    return true;
  }

  const podfileStats = fs.statSync(podfilePath);
  const podfileLockStats = fs.statSync(podfileLockPath);
  if (podfileStats.mtimeMs > podfileLockStats.mtimeMs) {
    return true;
  }

  return readFileIfExists(podfileLockPath) !== readFileIfExists(manifestLockPath);
}

function ensurePodsInstalled(env) {
  ensureCocoaPodsAvailable(env);
  if (!shouldInstallPods()) {
    return;
  }

  const result = spawnSync("pod", ["install"], {
    cwd: iosRoot,
    env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("`pod install`에 실패했습니다.");
  }
}

function getAvailableSimulators(env) {
  const result = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    {
      cwd: appRoot,
      env,
      encoding: "utf8",
      timeout: 15_000,
    },
  );

  if (result.status !== 0) {
    return [];
  }

  const parsed = JSON.parse(result.stdout || "{}");
  const devices = Object.values(parsed.devices || {})
    .flat()
    .filter((device) => device && device.isAvailable)
    .map((device) => ({
      name: device.name,
      udid: device.udid,
      state: device.state,
    }));

  return devices;
}

function getPreferredSimulatorName(env) {
  if (process.env.DOLGATE_IOS_SIMULATOR) {
    return process.env.DOLGATE_IOS_SIMULATOR;
  }

  const simulators = getAvailableSimulators(env);
  const firstIPhone = simulators.find((simulator) =>
    simulator.name.startsWith("iPhone "),
  );
  return firstIPhone?.name ?? simulators[0]?.name ?? null;
}

function getExplicitDeviceSelection(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--udid" && next) {
      return { type: "udid", value: next };
    }
    if (arg === "--simulator" && next) {
      return { type: "simulator", value: next };
    }
  }
  return null;
}

function resolveSimulatorUdids(args, env) {
  const simulators = getAvailableSimulators(env);
  const explicitSelection = getExplicitDeviceSelection(args);

  if (explicitSelection?.type === "udid") {
    return [explicitSelection.value];
  }

  const simulatorName =
    explicitSelection?.type === "simulator"
      ? explicitSelection.value
      : getPreferredSimulatorName(env);
  if (!simulatorName) {
    return [];
  }

  return simulators
    .filter((simulator) => simulator.name === simulatorName)
    .map((simulator) => simulator.udid);
}

function removeLegacyIosApps(args, env) {
  const simulatorUdids = resolveSimulatorUdids(args, env);
  for (const simulatorUdid of simulatorUdids) {
    for (const bundleId of legacyIosBundleIds) {
      spawnSync("xcrun", ["simctl", "uninstall", simulatorUdid, bundleId], {
        cwd: appRoot,
        env,
        stdio: "ignore",
      });
    }
  }
}

function hasExplicitDeviceSelection(args) {
  return args.some((arg, index) => {
    if (["--simulator", "--device", "--udid"].includes(arg)) {
      return true;
    }
    const previous = args[index - 1];
    return Boolean(previous && ["--simulator", "--device", "--udid"].includes(previous));
  });
}

module.exports = {
  appRoot,
  iosRoot,
  buildEnvForIos,
  ensurePodsInstalled,
  ensureXcodeAvailable,
  getPreferredSimulatorName,
  hasExplicitDeviceSelection,
  removeLegacyIosApps,
};
