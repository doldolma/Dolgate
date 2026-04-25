#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const markerRoot = path.join(packageRoot, "rust", "target", "dolssh-russh-build");
const lockDir = path.join(markerRoot, ".lock");
const regenerateScript = path.join(__dirname, "regenerate-native.cjs");
const expectedGeneratorVersion = "0.29.3-1";

const rustPathEnv = [
  "/opt/homebrew/opt/rustup/bin",
  path.join(os.homedir(), ".cargo", "bin"),
  process.env.PATH,
]
  .filter(Boolean)
  .join(path.delimiter);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativePath(filePath) {
  return toPosixPath(path.relative(packageRoot, filePath));
}

function hasFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? { ...process.env, PATH: rustPathEnv },
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    shell: options.shell ?? false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? 1}.`);
  }
  return result;
}

function runQuiet(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? { ...process.env, PATH: rustPathEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: options.shell ?? false,
  });

  if (result.error || result.status !== 0) {
    return null;
  }
  return (result.stdout || "").trim();
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function listFiles(rootDir, options = {}) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const skip = options.skip ?? (() => false);
  const include = options.include ?? (() => true);

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const rel = relativePath(fullPath);
      if (skip(fullPath, rel, entry)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && include(fullPath, rel)) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files.sort((left, right) => relativePath(left).localeCompare(relativePath(right)));
}

function digestFiles(files, extra) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(extra));
  hash.update("\0");
  for (const filePath of files) {
    hash.update(relativePath(filePath));
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function localGeneratorPackagePath() {
  const candidate = path.join(
    packageRoot,
    "node_modules",
    "uniffi-bindgen-react-native",
    "package.json",
  );
  if (!hasFile(candidate)) {
    throw new Error(
      "Package-local uniffi-bindgen-react-native is missing. Run `npm install` before regenerating russh bindings.",
    );
  }
  return candidate;
}

function readToolVersions(target) {
  const packageJson = readJson(path.join(packageRoot, "package.json"));
  const dependencyVersion = packageJson.dependencies?.["uniffi-bindgen-react-native"];
  const localGenerator = readJson(localGeneratorPackagePath());
  const rootGeneratorPath = path.join(
    repoRoot,
    "packages",
    "uniffi-bindgen-react-native",
    "package.json",
  );
  const rootGeneratorVersion = hasFile(rootGeneratorPath)
    ? readJson(rootGeneratorPath).version
    : null;

  if (dependencyVersion !== expectedGeneratorVersion) {
    throw new Error(
      `@fressh/react-native-uniffi-russh must depend on uniffi-bindgen-react-native ${expectedGeneratorVersion}; found ${dependencyVersion || "missing"}.`,
    );
  }
  if (localGenerator.version !== expectedGeneratorVersion) {
    throw new Error(
      `Package-local uniffi-bindgen-react-native must be ${expectedGeneratorVersion}; found ${localGenerator.version}.`,
    );
  }

  const rustUniffiVersion = readRustUniffiVersion();
  if (!rustUniffiVersion.startsWith("0.29.")) {
    throw new Error(`Rust uniffi must stay on 0.29.x for this bridge; found ${rustUniffiVersion}.`);
  }

  const versions = {
    dependencyVersion,
    localGeneratorVersion: localGenerator.version,
    rootGeneratorVersion,
    rustUniffiVersion,
    cargoVersion: runQuiet("cargo", ["--version"]),
  };

  if (target === "android") {
    versions.cargoNdkVersion = runQuiet("cargo", ["ndk", "--version"]);
  }
  if (target === "ios") {
    versions.xcodebuildVersion = runQuiet("xcodebuild", ["-version"]);
  }

  return versions;
}

function readRustUniffiVersion() {
  const lockPath = path.join(packageRoot, "rust", "Cargo.lock");
  const content = fs.readFileSync(lockPath, "utf8");
  const match = content.match(/\[\[package\]\]\s+name = "uniffi"\s+version = "([^"]+)"/m);
  if (!match) {
    throw new Error("Could not read Rust uniffi version from rust/Cargo.lock.");
  }
  return match[1];
}

function readBindingsContractVersion(filePath) {
  if (!hasFile(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/bindingsContractVersion\s*=\s*(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function readContractInfo() {
  const srcContract = readBindingsContractVersion(
    path.join(packageRoot, "src", "generated", "uniffi_russh.ts"),
  );
  const moduleContract = readBindingsContractVersion(
    path.join(packageRoot, "lib", "module", "generated", "uniffi_russh.js"),
  );

  return {
    srcContract,
    moduleContract,
    contractVersion:
      srcContract !== null && srcContract === moduleContract ? srcContract : null,
  };
}

function assertContractsMatch() {
  const contractInfo = readContractInfo();
  if (contractInfo.srcContract === null) {
    throw new Error("Missing bindings contract version in src/generated/uniffi_russh.ts.");
  }
  if (contractInfo.moduleContract === null) {
    throw new Error("Missing bindings contract version in lib/module/generated/uniffi_russh.js.");
  }
  if (contractInfo.srcContract !== contractInfo.moduleContract) {
    throw new Error(
      `UniFFI contract mismatch between src (${contractInfo.srcContract}) and lib/module (${contractInfo.moduleContract}).`,
    );
  }
  return contractInfo;
}

function jsInputFiles() {
  return [
    path.join(packageRoot, "package.json"),
    path.join(packageRoot, "tsconfig.json"),
    path.join(packageRoot, "tsconfig.build.json"),
    path.join(packageRoot, "scripts", "regenerate-native.cjs"),
    path.join(packageRoot, "scripts", "ensure-native.cjs"),
    ...listFiles(path.join(packageRoot, "src"), {
      include: (filePath) => /\.(ts|tsx)$/.test(filePath),
    }),
  ].filter(hasFile);
}

function nativeInputFiles() {
  return [
    path.join(packageRoot, "package.json"),
    path.join(packageRoot, "ubrn.config.yaml"),
    path.join(packageRoot, "scripts", "regenerate-native.cjs"),
    path.join(packageRoot, "scripts", "ensure-native.cjs"),
    ...listFiles(path.join(packageRoot, "rust"), {
      skip: (filePath, rel, entry) =>
        entry.isDirectory() && rel.startsWith("rust/target"),
      include: (filePath) => !filePath.includes(`${path.sep}.git${path.sep}`),
    }),
  ].filter(hasFile);
}

function jsOutputs() {
  return [
    path.join(packageRoot, "src", "generated", "uniffi_russh.ts"),
    path.join(packageRoot, "src", "generated", "uniffi_russh-ffi.ts"),
    path.join(packageRoot, "lib", "module", "api.js"),
    path.join(packageRoot, "lib", "module", "index.js"),
    path.join(packageRoot, "lib", "module", "NativeReactNativeUniffiRussh.js"),
    path.join(packageRoot, "lib", "module", "generated", "uniffi_russh.js"),
    path.join(packageRoot, "lib", "module", "generated", "uniffi_russh-ffi.js"),
    path.join(packageRoot, "lib", "typescript", "src", "api.d.ts"),
    path.join(packageRoot, "lib", "typescript", "src", "index.d.ts"),
    path.join(packageRoot, "lib", "typescript", "src", "NativeReactNativeUniffiRussh.d.ts"),
    path.join(packageRoot, "lib", "typescript", "src", "generated", "uniffi_russh.d.ts"),
    path.join(packageRoot, "lib", "typescript", "src", "generated", "uniffi_russh-ffi.d.ts"),
  ];
}

function androidOutputs() {
  return [
    path.join(packageRoot, "cpp", "generated", "uniffi_russh.cpp"),
    path.join(packageRoot, "cpp", "generated", "uniffi_russh.hpp"),
    path.join(packageRoot, "android", "src", "main", "jniLibs", "arm64-v8a", "libuniffi_russh.a"),
    path.join(packageRoot, "android", "src", "main", "jniLibs", "armeabi-v7a", "libuniffi_russh.a"),
    path.join(packageRoot, "android", "src", "main", "jniLibs", "x86", "libuniffi_russh.a"),
    path.join(packageRoot, "android", "src", "main", "jniLibs", "x86_64", "libuniffi_russh.a"),
  ];
}

function iosOutputs() {
  return [
    path.join(packageRoot, "cpp", "generated", "uniffi_russh.cpp"),
    path.join(packageRoot, "cpp", "generated", "uniffi_russh.hpp"),
    path.join(
      packageRoot,
      "FresshReactNativeUniffiRusshFramework.xcframework",
      "ios-arm64",
      "libuniffi_russh.a",
    ),
    path.join(
      packageRoot,
      "FresshReactNativeUniffiRusshFramework.xcframework",
      "ios-arm64_x86_64-simulator",
      "libuniffi_russh.a",
    ),
  ];
}

function outputFilesForTarget(target) {
  if (target === "js") {
    return jsOutputs();
  }
  if (target === "android") {
    return [...jsOutputs(), ...androidOutputs()];
  }
  if (target === "ios") {
    return [...jsOutputs(), ...iosOutputs()];
  }
  throw new Error(`Unknown russh ensure target: ${target}`);
}

function missingFiles(files) {
  return files.filter((filePath) => !hasFile(filePath));
}

function hashOutputs(files) {
  return Object.fromEntries(
    files.map((filePath) => [relativePath(filePath), hashFile(filePath)]),
  );
}

function markerPath(target) {
  return path.join(markerRoot, `${target}.json`);
}

function readMarker(target) {
  const filePath = markerPath(target);
  if (!hasFile(filePath)) {
    return null;
  }
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function writeMarker(target, marker) {
  fs.mkdirSync(markerRoot, { recursive: true });
  fs.writeFileSync(markerPath(target), `${JSON.stringify(marker, null, 2)}\n`);
}

function buildMarker(target, fingerprint, toolVersions, outputs) {
  const contractInfo = assertContractsMatch();
  return {
    target,
    fingerprint,
    toolVersions,
    bindingsContractVersion: contractInfo.contractVersion,
    outputs: hashOutputs(outputs),
    updatedAt: new Date().toISOString(),
  };
}

function markerMatches(marker, target, fingerprint, toolVersions, outputs) {
  if (!marker || marker.target !== target || marker.fingerprint !== fingerprint) {
    return false;
  }
  if (JSON.stringify(marker.toolVersions) !== JSON.stringify(toolVersions)) {
    return false;
  }
  if (missingFiles(outputs).length > 0) {
    return false;
  }

  const contractInfo = readContractInfo();
  if (
    contractInfo.contractVersion === null ||
    marker.bindingsContractVersion !== contractInfo.contractVersion
  ) {
    return false;
  }

  const currentOutputHashes = hashOutputs(outputs);
  return JSON.stringify(marker.outputs) === JSON.stringify(currentOutputHashes);
}

function jsFingerprint(toolVersions) {
  return digestFiles(jsInputFiles(), {
    kind: "js",
    toolVersions: {
      dependencyVersion: toolVersions.dependencyVersion,
      localGeneratorVersion: toolVersions.localGeneratorVersion,
      rustUniffiVersion: toolVersions.rustUniffiVersion,
    },
  });
}

function nativeFingerprint(target, toolVersions) {
  return digestFiles(nativeInputFiles(), {
    kind: "native",
    target,
    toolVersions,
  });
}

function runRegenerate(args) {
  run(process.execPath, [regenerateScript, ...args], {
    cwd: packageRoot,
    env: { ...process.env, PATH: rustPathEnv },
  });
}

function ensureJs(options = {}) {
  const target = "js";
  const toolVersions = readToolVersions(target);
  const fingerprint = jsFingerprint(toolVersions);
  const outputs = outputFilesForTarget(target);
  const marker = readMarker(target);

  if (
    !options.fresh &&
    !process.env.DOLSSH_FORCE_REGENERATE_RUSSH &&
    markerMatches(marker, target, fingerprint, toolVersions, outputs)
  ) {
    console.log("Reusing generated russh JS bindings.");
    return;
  }

  if (options.check) {
    throw new Error("Generated russh JS bindings are stale or missing. Run `npm run mobile:russh:ensure -- --js-only`.");
  }

  console.log("Preparing generated russh JS bindings...");
  runRegenerate(["--js-only"]);

  const missing = missingFiles(outputs);
  if (missing.length > 0) {
    throw new Error(`Generated russh JS outputs are missing: ${missing.map(relativePath).join(", ")}`);
  }
  writeMarker(target, buildMarker(target, fingerprint, toolVersions, outputs));
}

function ensurePlatform(target, options = {}) {
  const toolVersions = readToolVersions(target);
  const fingerprint = nativeFingerprint(target, toolVersions);
  const outputs = outputFilesForTarget(target);
  const marker = readMarker(target);

  if (
    !options.fresh &&
    !process.env.DOLSSH_FORCE_REGENERATE_RUSSH &&
    markerMatches(marker, target, fingerprint, toolVersions, outputs)
  ) {
    console.log(`Reusing generated russh ${target} native artifacts.`);
    ensureJs(options);
    return;
  }

  if (options.check) {
    throw new Error(`Generated russh ${target} native artifacts are stale or missing.`);
  }

  console.log(`Preparing generated russh ${target} native artifacts...`);
  runRegenerate(target === "android" ? ["--android-only"] : ["--ios-only"]);

  const missing = missingFiles(outputs);
  if (missing.length > 0) {
    throw new Error(`Generated russh ${target} outputs are missing: ${missing.map(relativePath).join(", ")}`);
  }
  writeMarker(target, buildMarker(target, fingerprint, toolVersions, outputs));

  const jsToolVersions = readToolVersions("js");
  writeMarker(
    "js",
    buildMarker("js", jsFingerprint(jsToolVersions), jsToolVersions, outputFilesForTarget("js")),
  );
}

function acquireLock() {
  fs.mkdirSync(markerRoot, { recursive: true });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const stats = fs.existsSync(lockDir) ? fs.statSync(lockDir) : null;
      if (stats && Date.now() - stats.mtimeMs > 30 * 60 * 1000) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }

  throw new Error("Timed out waiting for russh native generation lock.");
}

function normalizeOptions(options = {}) {
  const jsOnly = Boolean(options.jsOnly);
  const platform = options.platform ?? (jsOnly ? null : "android");
  if (platform && !["android", "ios", "all"].includes(platform)) {
    throw new Error(`Unknown russh platform: ${platform}`);
  }
  return {
    platform,
    jsOnly,
    check: Boolean(options.check),
    fresh: Boolean(options.fresh),
  };
}

function ensureRusshNative(options = {}) {
  const normalized = normalizeOptions(options);
  const releaseLock = acquireLock();
  try {
    if (normalized.jsOnly) {
      ensureJs(normalized);
      return;
    }
    if (normalized.platform === "all") {
      ensurePlatform("android", normalized);
      ensurePlatform("ios", normalized);
      return;
    }
    ensurePlatform(normalized.platform, normalized);
  } finally {
    releaseLock();
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--js-only") {
      options.jsOnly = true;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--fresh") {
      options.fresh = true;
      continue;
    }
    if (arg === "--android-only") {
      options.platform = "android";
      continue;
    }
    if (arg === "--ios-only") {
      options.platform = "ios";
      continue;
    }
    if (arg === "--platform") {
      options.platform = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      options.platform = arg.slice("--platform=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    ensureRusshNative(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  ensureRusshNative,
};
