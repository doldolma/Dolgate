const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { ensureMobileWorkspaceRuntime } = require("./prepare-runtime.cjs");
const { ensureRusshNative } = require("../../../packages/fressh-react-native-uniffi-russh/scripts/ensure-native.cjs");

const { androidRoot, buildEnvForAndroid } = (() => {
  const env = require("./android-env.cjs");
  return {
    androidRoot: path.join(env.appRoot, "android"),
    buildEnvForAndroid: env.buildEnvForAndroid,
  };
})();

const outputApkPath = path.join(
  androidRoot,
  "app",
  "build",
  "outputs",
  "apk",
  "release",
  "app-release.apk",
);
const cmakeBuildPath = path.join(androidRoot, "app", ".cxx");
const defaultReleaseArchitectures = "armeabi-v7a,arm64-v8a";

function resolveApkSigner(androidEnv) {
  const sdkRoot = androidEnv.ANDROID_SDK_ROOT || androidEnv.ANDROID_HOME;
  if (!sdkRoot) {
    return null;
  }

  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(buildToolsRoot)) {
    return null;
  }

  const apksignerName = process.platform === "win32" ? "apksigner.bat" : "apksigner";
  const candidates = fs
    .readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(buildToolsRoot, entry.name, apksignerName))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  return candidates.at(-1) ?? null;
}

function verifySignedApk(androidEnv) {
  if (!fs.existsSync(outputApkPath)) {
    console.error(`Release APK was not found at ${outputApkPath}.`);
    process.exit(1);
  }

  const apksigner = resolveApkSigner(androidEnv);
  if (!apksigner) {
    console.error("Could not locate apksigner in the configured Android SDK.");
    process.exit(1);
  }

  const result = spawnSync(apksigner, ["verify", outputApkPath], {
    cwd: androidRoot,
    env: androidEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  ensureMobileWorkspaceRuntime({ skipRussh: true });
  ensureRusshNative({ platform: "android" });

  const androidEnv = buildEnvForAndroid(process.env);
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  const releaseArchitectures =
    process.env.DOLGATE_ANDROID_RELEASE_ARCHES?.trim() ||
    defaultReleaseArchitectures;

  try {
    require("fs").rmSync(cmakeBuildPath, { recursive: true, force: true });
  } catch (error) {
    // Best-effort cleanup for stale native build intermediates.
  }

  const result = spawnSync(
    gradlew,
    [
      "app:assembleRelease",
      `-PreactNativeArchitectures=${releaseArchitectures}`,
    ],
    {
    cwd: androidRoot,
    env: androidEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  verifySignedApk(androidEnv);

  console.log(
    `Android release APK ready at ${outputApkPath} (${releaseArchitectures})`,
  );
}

main();
