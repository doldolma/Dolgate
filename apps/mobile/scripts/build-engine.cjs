// Builds the Go SSH engine (services/ssh-core/mobile) into artifacts the
// mobile app can link: an AAR for Android, an XCFramework for iOS.
//
// gomobile emits one copy of the Go runtime per bind, so services/ssh-core/mobile
// is the single bind target on purpose. Binding additional packages separately
// would load a second runtime into the same process.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildEnvForAndroid, resolveNdkDir, resolveSdkDir } = require("./android-env.cjs");

const repoRoot = path.resolve(__dirname, "../../..");
const serviceDir = path.join(repoRoot, "services", "ssh-core");
const outputRoot = path.join(serviceDir, "build", "mobile");
const bindTarget = "./mobile/";

// Matches minSdkVersion in apps/mobile/android/build.gradle.
const ANDROID_API = "24";

// Release builds ship a single ABI (DOLGATE_ANDROID_RELEASE_ARCHES in
// release.yml), so that is the default here too. The other targets exist for
// emulator work and for checking that nothing platform-specific crept in.
const DEFAULT_ANDROID_TARGETS = ["android/arm64"];

// Apple silicon only: the release archive needs the device slice, and local
// simulators on the Macs this is built from are arm64. An Intel simulator would
// need iossimulator/amd64 added here.
const IOS_TARGETS = ["ios/arm64", "iossimulator/arm64"];
const ANDROID_TARGET_ALIASES = {
  "arm64-v8a": "android/arm64",
  "armeabi-v7a": "android/arm",
  x86_64: "android/amd64",
  x86: "android/386",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function goEnv(name) {
  const result = spawnSync("go", ["env", name], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("Unable to run `go env`; is the Go toolchain installed?");
  }
  return (result.stdout || "").trim();
}

function resolveGomobile() {
  const binDir = path.join(goEnv("GOPATH"), "bin");
  const gomobile = path.join(binDir, process.platform === "win32" ? "gomobile.exe" : "gomobile");
  if (!fs.existsSync(gomobile)) {
    throw new Error(
      [
        "gomobile not found. Install the bind toolchain first:",
        "  cd services/ssh-core",
        "  go install golang.org/x/mobile/cmd/gomobile golang.org/x/mobile/cmd/gobind",
        "",
        "Run it from inside the module (and without @latest) so the version in",
        "go.mod is used — that is the version CI binds with.",
      ].join("\n"),
    );
  }
  return { gomobile, binDir };
}

function reportArtifact(label, artifactPath) {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Expected artifact was not produced: ${artifactPath}`);
  }

  const stat = fs.statSync(artifactPath);
  const size = stat.isDirectory() ? directorySize(artifactPath) : stat.size;
  const relative = path.relative(repoRoot, artifactPath);
  console.log(`${label}: ${(size / 1024 / 1024).toFixed(1)} MB  ${relative}`);
}

function directorySize(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return total + directorySize(entryPath);
    }
    return total + fs.statSync(entryPath).size;
  }, 0);
}

function normalizeAndroidTargets(rawTargets) {
  if (!rawTargets) {
    return DEFAULT_ANDROID_TARGETS;
  }

  return rawTargets
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith("android/")) {
        return entry;
      }
      const alias = ANDROID_TARGET_ALIASES[entry];
      if (!alias) {
        throw new Error(
          `Unknown Android ABI "${entry}". Expected one of: ${Object.keys(ANDROID_TARGET_ALIASES).join(", ")}`,
        );
      }
      return alias;
    });
}

function buildAndroid(gomobile, binDir, targets) {
  const sdkDir = resolveSdkDir();
  if (!sdkDir) {
    throw new Error("Android SDK not found. Set ANDROID_HOME or install the SDK.");
  }
  if (!resolveNdkDir(sdkDir)) {
    throw new Error(
      `Android NDK not found under ${sdkDir}/ndk. Install the version pinned by apps/mobile/android/build.gradle.`,
    );
  }

  const env = buildEnvForAndroid(process.env);
  env.PATH = [binDir, env.PATH].filter(Boolean).join(path.delimiter);

  const outputPath = path.join(outputRoot, "ssh-core-engine.aar");
  run(
    gomobile,
    [
      "bind",
      "-target",
      targets.join(","),
      "-androidapi",
      ANDROID_API,
      "-trimpath",
      "-ldflags",
      // max-page-size: Go's default leaves the LOAD segments 4KB-aligned, which
      // a 16KB-page device cannot load — and Play requires 16KB support at the
      // targetSdk this app ships. Every other native library in the APK is
      // already 0x4000; without this the engine is the only one that is not.
      "-s -w -extldflags=-Wl,-z,max-page-size=16384",
      "-o",
      outputPath,
      bindTarget,
    ],
    { cwd: serviceDir, env },
  );

  reportArtifact(`android (${targets.join(",")})`, outputPath);
}

function buildIos(gomobile, binDir) {
  if (process.platform !== "darwin") {
    throw new Error("iOS artifacts can only be built on macOS.");
  }

  const env = { ...process.env };
  env.PATH = [binDir, env.PATH].filter(Boolean).join(path.delimiter);

  // Both slices, always. The device slice is what ships (build-ios.cjs archives
  // for generic/platform=iOS), but `npm run dev:ios` defaults to a simulator,
  // and an XCFramework without a simulator slice fails to link there. The
  // framework is statically linked, so the unused slice costs nothing in the app.
  const outputPath = path.join(outputRoot, "SshCoreEngine.xcframework");
  fs.rmSync(outputPath, { recursive: true, force: true });
  run(
    gomobile,
    [
      "bind",
      "-target",
      IOS_TARGETS.join(","),
      "-trimpath",
      "-ldflags",
      "-s -w",
      "-o",
      outputPath,
      bindTarget,
    ],
    { cwd: serviceDir, env },
  );

  reportArtifact(`ios (${IOS_TARGETS.join(",")})`, outputPath);
  stageIosPodFramework(outputPath);
}

// CocoaPods only accepts a vendored framework that lives inside the pod, so the
// freshly built XCFramework is copied next to the podspec. Android needs no
// equivalent: Gradle can reference the AAR where it was built.
function stageIosPodFramework(builtPath) {
  const podDir = path.join(__dirname, "..", "ios", "GoSshEngine");
  if (!fs.existsSync(path.join(podDir, "GoSshEngine.podspec"))) {
    throw new Error(`Expected the iOS pod at ${podDir}`);
  }

  const stagedPath = path.join(podDir, "SshCoreEngine.xcframework");
  fs.rmSync(stagedPath, { recursive: true, force: true });
  fs.cpSync(builtPath, stagedPath, { recursive: true });
  console.log(`staged into pod: ${path.relative(repoRoot, stagedPath)}`);
}

function main() {
  const [platform = "both", rawTargets] = process.argv.slice(2);
  if (!["android", "ios", "both"].includes(platform)) {
    throw new Error("Usage: node ./scripts/build-engine.cjs [android|ios|both] [abis]");
  }

  const { gomobile, binDir } = resolveGomobile();
  fs.mkdirSync(outputRoot, { recursive: true });

  if (platform === "android" || platform === "both") {
    buildAndroid(gomobile, binDir, normalizeAndroidTargets(rawTargets));
  }
  if (platform === "ios" || platform === "both") {
    buildIos(gomobile, binDir);
  }
}

main();
