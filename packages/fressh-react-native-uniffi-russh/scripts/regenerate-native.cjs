#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const args = new Set(process.argv.slice(2));
const expectedGeneratorVersion = "0.29.3-1";

process.env.PATH = [
  "/opt/homebrew/opt/rustup/bin",
  path.join(os.homedir(), ".cargo", "bin"),
  process.env.PATH,
]
  .filter(Boolean)
  .join(path.delimiter);

const androidOnly = args.has("--android-only");
const iosOnly = args.has("--ios-only");
const jsOnly = args.has("--js-only");
const skipJs = args.has("--skip-js");

const shouldBuildAndroid = !iosOnly && !jsOnly;
const shouldBuildIos = !androidOnly && !jsOnly;
const shouldBuildJs = !skipJs;

const androidTargets = [
  "aarch64-linux-android",
  "armv7-linux-androideabi",
  "x86_64-linux-android",
  "i686-linux-android",
].join(",");

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
