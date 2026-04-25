const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../../..");
const nodeCommand = process.execPath;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const russhEnsureScriptPath = path.join(
  repoRoot,
  "packages",
  "fressh-react-native-uniffi-russh",
  "scripts",
  "ensure-native.cjs",
);

const uniffiRoot = path.join(
  repoRoot,
  "packages",
  "uniffi-bindgen-react-native",
);
const uniffiDistJsPath = path.join(
  uniffiRoot,
  "typescript",
  "dist",
  "index.js",
);
const uniffiDistTypesPath = path.join(
  uniffiRoot,
  "typescript",
  "dist",
  "index.d.ts",
);

const xtermRoot = path.join(
  repoRoot,
  "packages",
  "fressh-react-native-xtermjs-webview",
);
const xtermDistJsPath = path.join(xtermRoot, "dist", "index.js");
const xtermDistTypesPath = path.join(xtermRoot, "dist", "index.d.ts");
const xtermInternalHtmlPath = path.join(
  xtermRoot,
  "dist-internal",
  "index.html",
);
const xtermInternalSourceRoot = path.join(xtermRoot, "src-internal");
const xtermInternalBuildHtmlPath = path.join(xtermRoot, "index.build.html");

function resolvePackageRoot(specifier) {
  try {
    return path.dirname(require.resolve(`${specifier}/package.json`, { paths: [repoRoot] }));
  } catch (error) {
    throw new Error(`Could not resolve ${specifier} from the workspace root.`);
  }
}

function runNodeScript(scriptPath, args, cwd) {
  const result = spawnSync(nodeCommand, [scriptPath, ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${path.basename(scriptPath)} exited with code ${result.status ?? 1}.`);
  }
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 1}.`);
  }
}

function hasFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function hydrateXtermInternalHtml() {
  if (hasFile(xtermInternalHtmlPath)) {
    return;
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(xtermRoot, "package.json"), "utf8"),
  );
  const version = packageJson.version;
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "dolgate-xterm-pack-"),
  );

  try {
    console.log(
      "Hydrating @fressh/react-native-xtermjs-webview internal HTML from the published package...",
    );
    const packResult = spawnSync(
      npmCommand,
      [
        "pack",
        `@fressh/react-native-xtermjs-webview@${version}`,
        "--silent",
      ],
      {
        cwd: tempRoot,
        env: process.env,
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );

    if (packResult.error) {
      throw packResult.error;
    }

    if (packResult.status !== 0) {
      throw new Error(
        `npm pack exited with code ${packResult.status ?? 1} while hydrating @fressh/react-native-xtermjs-webview internal HTML.`,
      );
    }

    const tarballName = (packResult.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (!tarballName) {
      throw new Error(
        "npm pack did not return a tarball name for @fressh/react-native-xtermjs-webview.",
      );
    }

    runCommand(
      "tar",
      ["-xzf", tarballName, "package/dist-internal/index.html"],
      tempRoot,
    );

    const extractedHtmlPath = path.join(
      tempRoot,
      "package",
      "dist-internal",
      "index.html",
    );
    if (!hasFile(extractedHtmlPath)) {
      throw new Error(
        "Published @fressh/react-native-xtermjs-webview package did not contain dist-internal/index.html.",
      );
    }

    fs.mkdirSync(path.dirname(xtermInternalHtmlPath), { recursive: true });
    fs.copyFileSync(extractedHtmlPath, xtermInternalHtmlPath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function ensureUniffiRuntime() {
  if (hasFile(uniffiDistJsPath) && hasFile(uniffiDistTypesPath)) {
    return;
  }

  console.log("Preparing uniffi-bindgen-react-native runtime...");
  const tscScript = path.join(resolvePackageRoot("typescript"), "bin", "tsc");
  runNodeScript(tscScript, ["-p", "tsconfig.json"], uniffiRoot);

  if (!hasFile(uniffiDistJsPath) || !hasFile(uniffiDistTypesPath)) {
    throw new Error("uniffi-bindgen-react-native runtime build did not produce dist/index.js and dist/index.d.ts.");
  }
}

function ensureXtermRuntime() {
  if (hasFile(xtermDistJsPath) && hasFile(xtermDistTypesPath)) {
    return;
  }

  console.log("Preparing @fressh/react-native-xtermjs-webview runtime...");
  const viteScript = path.join(resolvePackageRoot("vite"), "bin", "vite.js");

  if (
    fs.existsSync(xtermInternalSourceRoot) &&
    hasFile(xtermInternalBuildHtmlPath)
  ) {
    runNodeScript(
      viteScript,
      ["build", "-c", "vite.config.internal.ts"],
      xtermRoot,
    );
  } else {
    hydrateXtermInternalHtml();
  }

  runNodeScript(viteScript, ["build", "-c", "vite.config.ts"], xtermRoot);

  if (!hasFile(xtermDistJsPath) || !hasFile(xtermDistTypesPath)) {
    throw new Error("@fressh/react-native-xtermjs-webview runtime build did not produce dist/index.js and dist/index.d.ts.");
  }
}

function ensureRusshRuntime() {
  const { ensureRusshNative } = require(russhEnsureScriptPath);
  ensureRusshNative({ jsOnly: true });
}

function ensureMobileWorkspaceRuntime(options = {}) {
  ensureUniffiRuntime();
  ensureXtermRuntime();
  if (!options.skipRussh) {
    ensureRusshRuntime();
  }
}

if (require.main === module) {
  try {
    ensureMobileWorkspaceRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  ensureMobileWorkspaceRuntime,
};
