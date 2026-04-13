const fs = require("fs");
const os = require("os");
const path = require("path");

const appRoot = path.resolve(__dirname, "..");
const androidRoot = path.join(appRoot, "android");
const localPropertiesPath = path.join(androidRoot, "local.properties");

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

function listDirectories(parentDir) {
  if (!parentDir || !fs.existsSync(parentDir)) {
    return [];
  }

  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDir, entry.name));
}

function getJavaHomeCandidates() {
  const homeDir = os.homedir();
  const candidates = [process.env.JAVA_HOME];

  if (process.platform === "win32") {
    candidates.push(
      path.join("C:\\", "Program Files", "Android", "Android Studio", "jbr"),
      ...listDirectories(path.join("C:\\", "Program Files", "Java")),
      ...listDirectories(path.join("C:\\", "Program Files", "Eclipse Adoptium")),
    );
  }

  if (process.platform === "darwin") {
    candidates.push(
      path.join("/", "Applications", "Android Studio.app", "Contents", "jbr", "Contents", "Home"),
      path.join("/", "Library", "Java", "JavaVirtualMachines"),
    );
  }

  if (process.platform === "linux") {
    candidates.push(
      path.join("/", "usr", "lib", "jvm", "default-java"),
      path.join("/", "usr", "lib", "jvm", "java-17-openjdk-amd64"),
      path.join("/", "usr", "lib", "jvm", "java-21-openjdk-amd64"),
    );
  }

  return candidates.filter(Boolean);
}

function hasJavaBinary(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }
  const javaBinary = process.platform === "win32" ? "java.exe" : "java";
  return fs.existsSync(path.join(candidate, "bin", javaBinary));
}

function resolveJavaHome() {
  return getJavaHomeCandidates().find((candidate) => hasJavaBinary(candidate)) ?? null;
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
    extraPaths.push(
      ...[path.join(sdkDir, "platform-tools"), path.join(sdkDir, "emulator")].filter((toolDir) =>
        fs.existsSync(toolDir),
      ),
    );
  }

  const javaHome = resolveJavaHome();
  if (javaHome) {
    env.JAVA_HOME = env.JAVA_HOME || javaHome;
    extraPaths.push(path.join(javaHome, "bin"));
  }

  env.PATH = [...extraPaths, env.PATH || ""].filter(Boolean).join(path.delimiter);
  return env;
}

module.exports = {
  appRoot,
  buildEnvForAndroid,
  resolveSdkDir,
};
