#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const expectedGeneratorVersion = "0.29.3-1";
const androidAbiTargets = {
  "arm64-v8a": "aarch64-linux-android",
  "armeabi-v7a": "armv7-linux-androideabi",
  x86_64: "x86_64-linux-android",
  x86: "i686-linux-android",
};
const defaultAndroidAbis = Object.keys(androidAbiTargets);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--android-only") {
      options.androidOnly = true;
      continue;
    }
    if (arg === "--ios-only") {
      options.iosOnly = true;
      continue;
    }
    if (arg === "--js-only") {
      options.jsOnly = true;
      continue;
    }
    if (arg === "--skip-js") {
      options.skipJs = true;
      continue;
    }
    if (arg === "--android-abis") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--android-abis requires a comma-separated ABI list.");
      }
      options.androidAbis = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--android-abis=")) {
      options.androidAbis = arg.slice("--android-abis=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function normalizeAndroidAbis(value) {
  if (typeof value === "string" && !value.trim()) {
    throw new Error("At least one Android ABI is required.");
  }
  const abis =
    typeof value === "string"
      ? value.split(",").map((abi) => abi.trim()).filter(Boolean)
      : defaultAndroidAbis;
  const seen = new Set();
  const normalized = [];
  for (const abi of abis) {
    if (!androidAbiTargets[abi]) {
      throw new Error(`Unknown Android ABI: ${abi}`);
    }
    if (!seen.has(abi)) {
      normalized.push(abi);
      seen.add(abi);
    }
  }
  if (normalized.length === 0) {
    throw new Error("At least one Android ABI is required.");
  }
  return defaultAndroidAbis.filter((abi) => seen.has(abi));
}

const options = parseArgs(process.argv.slice(2));

process.env.PATH = [
  "/opt/homebrew/opt/rustup/bin",
  path.join(os.homedir(), ".cargo", "bin"),
  process.env.PATH,
]
  .filter(Boolean)
  .join(path.delimiter);

const androidOnly = Boolean(options.androidOnly);
const iosOnly = Boolean(options.iosOnly);
const jsOnly = Boolean(options.jsOnly);
const skipJs = Boolean(options.skipJs);

const shouldBuildAndroid = !iosOnly && !jsOnly;
const shouldBuildIos = !androidOnly && !jsOnly;
const shouldBuildJs = !skipJs;
const selectedAndroidAbis = normalizeAndroidAbis(options.androidAbis);

const androidTargets = selectedAndroidAbis.map((abi) => androidAbiTargets[abi]).join(",");

const iosTargets = [
  "aarch64-apple-ios",
  "aarch64-apple-ios-sim",
  "x86_64-apple-ios",
].join(",");

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCheck(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: packageRoot,
    env: process.env,
    stdio: "ignore",
  }).status === 0;
}

function requireTool(command, commandArgs, installHint) {
  if (!runCheck(command, commandArgs)) {
    console.error(`Missing required tool: ${command} ${commandArgs.join(" ")}`);
    console.error(installHint);
    process.exit(1);
  }
}

function resolvePackageFile(packageName, relativePath) {
  if (packageName === "uniffi-bindgen-react-native") {
    const packageJson = path.join(packageRoot, "node_modules", packageName, "package.json");
    if (!fs.existsSync(packageJson)) {
      throw new Error(
        `Missing package-local ${packageName}. Run npm install before regenerating russh bindings.`,
      );
    }
    const packageInfo = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    if (packageInfo.version !== expectedGeneratorVersion) {
      throw new Error(
        `Expected package-local ${packageName}@${expectedGeneratorVersion}, found ${packageInfo.version}.`,
      );
    }
    return path.join(path.dirname(packageJson), relativePath);
  }

  const packageJson = require.resolve(`${packageName}/package.json`, {
    paths: [packageRoot, repoRoot],
  });
  return path.join(path.dirname(packageJson), relativePath);
}

function removeByExtension(dir, extensions) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeByExtension(fullPath, extensions);
      if (fs.readdirSync(fullPath).length === 0) {
        fs.rmdirSync(fullPath);
      }
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension))) {
      fs.rmSync(fullPath);
    }
  }
}

function copyDirectoryContents(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function backupNonSelectedAndroidJniLibs(selectedAndroidAbis) {
  const selected = new Set(selectedAndroidAbis);
  const abiDirs = defaultAndroidAbis.filter((abi) => !selected.has(abi));
  if (abiDirs.length === 0) {
    return () => {};
  }

  const jniLibsRoot = path.join(packageRoot, "android", "src", "main", "jniLibs");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dolssh-russh-jni-"));
  const backups = [];

  for (const abi of abiDirs) {
    const sourceDir = path.join(jniLibsRoot, abi);
    if (!fs.existsSync(sourceDir)) {
      continue;
    }
    const backupDir = path.join(tempRoot, abi);
    copyDirectoryContents(sourceDir, backupDir);
    backups.push({ sourceDir, backupDir });
  }

  return () => {
    try {
      for (const { sourceDir, backupDir } of backups) {
        fs.rmSync(sourceDir, { recursive: true, force: true });
        copyDirectoryContents(backupDir, sourceDir);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}

function stripTrailingWhitespace(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, content.replace(/[ \t]+$/gm, ""));
}

function stripGeneratedWhitespace() {
  [
    path.join(packageRoot, "cpp", "generated", "uniffi_russh.cpp"),
    path.join(packageRoot, "cpp", "generated", "uniffi_russh.hpp"),
    path.join(packageRoot, "src", "generated", "uniffi_russh.ts"),
    path.join(packageRoot, "src", "generated", "uniffi_russh-ffi.ts"),
    path.join(packageRoot, "lib", "module", "generated", "uniffi_russh.js"),
    path.join(packageRoot, "lib", "module", "generated", "uniffi_russh-ffi.js"),
    path.join(
      packageRoot,
      "lib",
      "typescript",
      "src",
      "generated",
      "uniffi_russh.d.ts",
    ),
    path.join(
      packageRoot,
      "lib",
      "typescript",
      "src",
      "generated",
      "uniffi_russh-ffi.d.ts",
    ),
  ].forEach(stripTrailingWhitespace);
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function isInsideDirectory(parentDir, filePath) {
  const relative = path.relative(parentDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeSourceMapFile(filePath) {
  const sourceMap = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(sourceMap.sources)) {
    return;
  }

  const packageSourceMarker = `/${path.basename(packageRoot)}/`;
  const sourceMapDir = path.dirname(filePath);
  sourceMap.sources = sourceMap.sources.map((source) => {
    if (typeof source !== "string" || source.includes("://")) {
      return source;
    }

    const normalizedSource = source.split(path.win32.sep).join(path.posix.sep);
    const packageMarkerIndex = normalizedSource.lastIndexOf(packageSourceMarker);
    const resolvedSource =
      packageMarkerIndex === -1
        ? path.resolve(sourceMapDir, source)
        : path.join(
            packageRoot,
            ...normalizedSource
              .slice(packageMarkerIndex + packageSourceMarker.length)
              .split(path.posix.sep),
          );
    if (!isInsideDirectory(packageRoot, resolvedSource)) {
      return source;
    }

    return toPosixPath(path.relative(sourceMapDir, resolvedSource));
  });

  fs.writeFileSync(filePath, JSON.stringify(sourceMap));
}

function normalizeSourceMaps(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      normalizeSourceMaps(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".map")) {
      normalizeSourceMapFile(fullPath);
    }
  }
}

function addJsExtensionToRelativeImports(content) {
  return content.replace(
    /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+)(["']\)?)/g,
    (match, prefix, specifier, suffix) => {
      const queryIndex = specifier.search(/[?#]/);
      const bareSpecifier =
        queryIndex === -1 ? specifier : specifier.slice(0, queryIndex);
      if (path.posix.extname(bareSpecifier) || bareSpecifier.endsWith("/")) {
        return match;
      }
      const query = queryIndex === -1 ? "" : specifier.slice(queryIndex);
      return `${prefix}${bareSpecifier}.js${query}${suffix}`;
    },
  );
}

function rewriteModuleImports(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteModuleImports(fullPath);
      continue;
    }
    if (!entry.name.endsWith(".js")) {
      continue;
    }
    const content = fs.readFileSync(fullPath, "utf8");
    fs.writeFileSync(fullPath, addJsExtensionToRelativeImports(content));
  }
}

function buildJsOutputs() {
  const tsc = resolvePackageFile("typescript", "bin/tsc");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dolssh-russh-"));
  const moduleOut = path.join(tempRoot, "module");
  const typesOut = path.join(tempRoot, "typescript");

  run(process.execPath, [
    tsc,
    "-p",
    "tsconfig.build.json",
    "--noEmit",
    "false",
    "--emitDeclarationOnly",
    "false",
    "--declaration",
    "false",
    "--sourceMap",
    "true",
    "--outDir",
    moduleOut,
    "--rootDir",
    "src",
  ]);
  rewriteModuleImports(moduleOut);

  run(process.execPath, [
    tsc,
    "-p",
    "tsconfig.build.json",
    "--noEmit",
    "false",
    "--declaration",
    "true",
    "--emitDeclarationOnly",
    "true",
    "--declarationMap",
    "true",
    "--outDir",
    typesOut,
    "--rootDir",
    ".",
  ]);

  const moduleTarget = path.join(packageRoot, "lib", "module");
  const typesTarget = path.join(packageRoot, "lib", "typescript");

  removeByExtension(moduleTarget, [".js", ".js.map"]);
  removeByExtension(typesTarget, [".d.ts", ".d.ts.map"]);
  copyDirectoryContents(moduleOut, moduleTarget);
  copyDirectoryContents(typesOut, typesTarget);
  fs.writeFileSync(
    path.join(moduleTarget, "package.json"),
    JSON.stringify({ type: "module" }) + "\n",
  );
  fs.writeFileSync(
    path.join(typesTarget, "package.json"),
    JSON.stringify({ type: "module" }) + "\n",
  );
  normalizeSourceMaps(moduleTarget);
  normalizeSourceMaps(typesTarget);
  stripGeneratedWhitespace();
}

function patchAndroidCallInvokerAdapter() {
  const adapterPath = path.join(packageRoot, "android", "cpp-adapter.cpp");
  if (!fs.existsSync(adapterPath)) {
    return;
  }

  let content = fs.readFileSync(adapterPath, "utf8");
  if (!content.includes("#include <fbjni/fbjni.h>")) {
    content = content.replace(
      "#include <ReactCommon/CallInvokerHolder.h>\n",
      "#include <ReactCommon/CallInvokerHolder.h>\n#include <fbjni/fbjni.h>\n",
    );
  }

  const installStart = content.indexOf(
    "extern \"C\"\nJNIEXPORT jboolean JNICALL\nJava_com_uniffirussh_ReactNativeUniffiRusshModule_nativeInstallRustCrate",
  );
  const cleanupStart = content.indexOf(
    "extern \"C\"\nJNIEXPORT jboolean JNICALL\nJava_com_uniffirussh_ReactNativeUniffiRusshModule_nativeCleanupRustCrate",
  );
  if (installStart === -1 || cleanupStart === -1 || cleanupStart <= installStart) {
    throw new Error("Unable to patch Android CallInvoker adapter.");
  }

  const installFunction = `extern "C"
JNIEXPORT jboolean JNICALL
Java_com_uniffirussh_ReactNativeUniffiRusshModule_nativeInstallRustCrate(
    JNIEnv *env,
    jclass type,
    jlong rtPtr,
    jobject callInvokerHolderJavaObj
) {
    try {
        if (callInvokerHolderJavaObj == nullptr) {
            return false;
        }

        auto alias = facebook::jni::alias_ref<jobject>(callInvokerHolderJavaObj);
        auto holder = facebook::jni::static_ref_cast<facebook::react::CallInvokerHolder::javaobject>(alias);
        if (!holder) {
            return false;
        }

        auto jsCallInvoker = holder->cthis()->getCallInvoker();
        if (!jsCallInvoker) {
            return false;
        }

        auto runtime = reinterpret_cast<jsi::Runtime *>(rtPtr);
        return fressh_reactnativeuniffirussh::installRustCrate(*runtime, jsCallInvoker);
    } catch (...) {
        return false;
    }
}

`;

  fs.writeFileSync(
    adapterPath,
    content.slice(0, installStart) + installFunction + content.slice(cleanupStart),
  );
}

function patchAndroidBuildGradleAbiFilters() {
  const gradlePath = path.join(packageRoot, "android", "build.gradle");
  if (!fs.existsSync(gradlePath)) {
    return;
  }

  const content = fs.readFileSync(gradlePath, "utf8");
  const nextContent = content.replace(
    /ndk \{\n\s+abiFilters [^\n]+\n\s+\}/,
    "ndk {\n      abiFilters (*reactNativeArchitectures())\n    }",
  );
  if (nextContent === content) {
    throw new Error("Unable to patch Android ABI filters in build.gradle.");
  }
  fs.writeFileSync(gradlePath, nextContent);
}

if (shouldBuildAndroid || shouldBuildIos) {
  requireTool("cargo", ["--version"], "Install Rust with rustup first.");
}

if (shouldBuildAndroid) {
  requireTool(
    "cargo",
    ["ndk", "--version"],
    "Install cargo-ndk with: cargo install cargo-ndk",
  );
}

const ubrn = resolvePackageFile("uniffi-bindgen-react-native", "bin/cli.cjs");

if (shouldBuildAndroid) {
  const restoreAndroidJniLibs = backupNonSelectedAndroidJniLibs(selectedAndroidAbis);
  try {
    run(process.execPath, [
      ubrn,
      "build",
      "android",
      "--release",
      "--and-generate",
      "--targets",
      androidTargets,
    ]);
    patchAndroidCallInvokerAdapter();
    patchAndroidBuildGradleAbiFilters();
  } finally {
    restoreAndroidJniLibs();
  }
}

if (shouldBuildIos) {
  const env = { ...process.env };
  if (!env.DEVELOPER_DIR) {
    const xcodeDeveloperDir = "/Applications/Xcode.app/Contents/Developer";
    if (fs.existsSync(xcodeDeveloperDir)) {
      env.DEVELOPER_DIR = xcodeDeveloperDir;
    }
  }
  run(process.execPath, [
    ubrn,
    "build",
    "ios",
    "--release",
    "--and-generate",
    "--targets",
    iosTargets,
  ], { env });
}

stripGeneratedWhitespace();

if (shouldBuildJs) {
  buildJsOutputs();
}
