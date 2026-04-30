const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const appRoot = path.resolve(__dirname, "..");
const androidRoot = path.join(appRoot, "android");
const localPropertiesPath = path.join(androidRoot, "local.properties");
const androidBuildGradlePath = path.join(androidRoot, "build.gradle");

function decodeLocalPropertiesPath(rawValue) {
  return rawValue.replace(/\\:/g, ":").replace(/\\\\/g, "\\");
}

function readSdkDirFromLocalProperties() {
  if (!fs.existsSync(localPropertiesPath)) {
    return null;
  }

  const contents = fs.readFileSync(localPropertiesPath, "utf8");
  const sdkLine = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("sdk.dir="));

  if (!sdkLine) {
    return null;
  }

  return decodeLocalPropertiesPath(sdkLine.slice("sdk.dir=".length));
}

function getSdkCandidates() {
  const homeDir = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    readSdkDirFromLocalProperties(),
    process.platform === "win32"
      ? path.join(homeDir, "AppData", "Local", "Android", "Sdk")
      : null,
    process.platform === "darwin" ? path.join(homeDir, "Library", "Android", "sdk") : null,
    process.platform === "linux" ? path.join(homeDir, "Android", "Sdk") : null,
  ].filter(Boolean);
}

function resolveSdkDir() {
  return getSdkCandidates().find((candidate) => fs.existsSync(candidate)) ?? null;
}

function readRequiredNdkVersion() {
  if (!fs.existsSync(androidBuildGradlePath)) {
    return null;
  }

  const contents = fs.readFileSync(androidBuildGradlePath, "utf8");
  const match = contents.match(/ndkVersion\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function listDirectories(parentDir) {
  if (!parentDir || !fs.existsSync(parentDir)) {
    return [];
  }

  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDir, entry.name));
}

function compareVersionish(left, right) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function isNdkDir(candidate) {
  return Boolean(candidate && fs.existsSync(path.join(candidate, "source.properties")));
}

function resolveNdkDir(sdkDir = resolveSdkDir(), env = process.env) {
  const explicitNdk = [env.ANDROID_NDK_HOME, env.ANDROID_NDK_ROOT].find(isNdkDir);
  if (explicitNdk) {
    return explicitNdk;
  }

  const requiredNdkVersion = readRequiredNdkVersion();
  const ndkRoot = sdkDir ? path.join(sdkDir, "ndk") : null;
  if (!ndkRoot || !fs.existsSync(ndkRoot)) {
    return null;
  }

  const requiredNdkDir = requiredNdkVersion ? path.join(ndkRoot, requiredNdkVersion) : null;
  if (isNdkDir(requiredNdkDir)) {
    return requiredNdkDir;
  }

  return listDirectories(ndkRoot)
    .sort((left, right) => compareVersionish(path.basename(right), path.basename(left)))
    .find(isNdkDir) ?? null;
}

function runJavaHome(args) {
  if (process.platform !== "darwin") {
    return null;
  }

  const result = spawnSync("/usr/libexec/java_home", args, {
    encoding: "utf8",
    timeout: 5_000,
  });

  if (result.status !== 0) {
    return null;
  }

  const javaHome = (result.stdout || "").trim();
  return javaHome || null;
}

function expandJavaHomeDirectory(parentDir) {
  return listDirectories(parentDir)
    .flatMap((candidateDir) => {
      const contentsHome = path.join(candidateDir, "Contents", "Home");
      if (hasJavaBinary(contentsHome)) {
        return [contentsHome];
      }
      return hasJavaBinary(candidateDir) ? [candidateDir] : [];
    })
    .filter(Boolean);
}

function getJavaHomeCandidates() {
  const homeDir = os.homedir();
  const preferredCandidates = [];
  const fallbackCandidates = [process.env.JAVA_HOME];

  if (process.platform === "win32") {
    fallbackCandidates.push(
      path.join("C:\\", "Program Files", "Android", "Android Studio", "jbr"),
      ...listDirectories(path.join("C:\\", "Program Files", "Java")),
      ...listDirectories(path.join("C:\\", "Program Files", "Eclipse Adoptium")),
    );
  }

  if (process.platform === "darwin") {
    preferredCandidates.push(runJavaHome(["-v", "17"]));
    preferredCandidates.push(runJavaHome(["-v", "21"]));

    fallbackCandidates.push(
      path.join("/", "Applications", "Android Studio.app", "Contents", "jbr", "Contents", "Home"),
      ...expandJavaHomeDirectory(path.join(homeDir, "Library", "Java", "JavaVirtualMachines")),
      ...expandJavaHomeDirectory(path.join("/", "Library", "Java", "JavaVirtualMachines")),
      runJavaHome([]),
    );
  }

  if (process.platform === "linux") {
    fallbackCandidates.push(
      path.join("/", "usr", "lib", "jvm", "default-java"),
      path.join("/", "usr", "lib", "jvm", "java-17-openjdk-amd64"),
      path.join("/", "usr", "lib", "jvm", "java-21-openjdk-amd64"),
    );
  }

  return [...preferredCandidates, ...fallbackCandidates].filter(Boolean);
}

function hasJavaBinary(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }
  const javaBinary = process.platform === "win32" ? "java.exe" : "java";
  return fs.existsSync(path.join(candidate, "bin", javaBinary));
}

function readJavaMajorVersion(candidate) {
  if (!candidate) {
    return null;
  }

  const releasePath = path.join(candidate, "release");
  if (!fs.existsSync(releasePath)) {
    return null;
  }

  const contents = fs.readFileSync(releasePath, "utf8");
  const match = contents.match(/JAVA_VERSION="(\d+)(?:\.[^"]*)?"/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function scoreJavaHome(candidate) {
  const majorVersion = readJavaMajorVersion(candidate);
  if (majorVersion === 17) {
    return 3;
  }
  if (majorVersion === 21) {
    return 2;
  }
  if (majorVersion && majorVersion >= 17 && majorVersion < 24) {
    return 1;
  }
  return 0;
}

function resolveJavaHome() {
  const uniqueCandidates = Array.from(new Set(getJavaHomeCandidates()));
  const supportedCandidate = uniqueCandidates
    .filter((candidate) => hasJavaBinary(candidate))
    .sort((left, right) => scoreJavaHome(right) - scoreJavaHome(left))[0];
  return supportedCandidate ?? null;
}

function buildEnvForAndroid(baseEnv) {
  const sdkDir = resolveSdkDir();
  const env = { ...baseEnv };
  const extraPaths = [];

  env.NODE_BINARY = env.NODE_BINARY || process.execPath;
  extraPaths.push(path.dirname(process.execPath));

  if (sdkDir) {
    env.ANDROID_HOME = env.ANDROID_HOME || sdkDir;
    env.ANDROID_SDK_ROOT = env.ANDROID_SDK_ROOT || sdkDir;
    const ndkDir = resolveNdkDir(sdkDir, env);
    if (ndkDir) {
      env.ANDROID_NDK_HOME = env.ANDROID_NDK_HOME || ndkDir;
      env.ANDROID_NDK_ROOT = env.ANDROID_NDK_ROOT || ndkDir;
    }
    extraPaths.push(
      ...[path.join(sdkDir, "platform-tools"), path.join(sdkDir, "emulator")].filter((toolDir) =>
        fs.existsSync(toolDir),
      ),
    );
  }

  const configuredJavaHome = hasJavaBinary(env.JAVA_HOME) ? env.JAVA_HOME : null;
  const javaHome =
    configuredJavaHome && scoreJavaHome(configuredJavaHome) > 0 ? configuredJavaHome : resolveJavaHome();
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    extraPaths.push(path.join(javaHome, "bin"));
  }

  env.PATH = [...extraPaths, env.PATH || ""].filter(Boolean).join(path.delimiter);
  return env;
}

module.exports = {
  appRoot,
  buildEnvForAndroid,
  readRequiredNdkVersion,
  resolveNdkDir,
  resolveSdkDir,
};
