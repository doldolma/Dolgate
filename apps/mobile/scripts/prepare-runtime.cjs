const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../../..");
const nodeCommand = process.execPath;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";


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
const xtermInternalEntryPath = path.join(xtermInternalSourceRoot, "main.tsx");
// 빌드가 낡았는지 판정할 입력들. 여기에 없는 파일을 고치면 산출물이 갱신되지 않는다.
const xtermSourcePaths = [
  path.join(xtermRoot, "package.json"),
  path.join(xtermRoot, "index.html"),
  path.join(xtermRoot, "vite.config.ts"),
  path.join(xtermRoot, "vite.config.internal.ts"),
  path.join(xtermRoot, "src"),
  xtermInternalSourceRoot,
];

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

function resolvePackageRoot(specifier) {
  try {
    return path.dirname(
      require.resolve(`${specifier}/package.json`, { paths: [repoRoot] }),
    );
  } catch {
    throw new Error(`Could not resolve ${specifier} from the workspace root.`);
  }
}

/**
 * 빌드 도구를 직접 부른다.
 *
 * `npm run` 으로 감싸면 안 된다. 이 스크립트는 npm 안에서 실행되고(dev:mobile:ios → npm run
 * dev:ios --workspace …), 그 환경에는 npm_config_workspace 같은 값이 남아 있어서 중첩 npm 이
 * **그 워크스페이스**에서 스크립트를 찾는다 — "Missing script: build:page" 로 죽고, dev 는 Metro
 * 를 띄우기 전에 끝난다. 앱에는 "No script URL provided" 로 나타났다.
 */
function runVite(configFile) {
  const viteScript = path.join(resolvePackageRoot("vite"), "bin", "vite.js");
  const result = spawnSync(nodeCommand, [viteScript, "build", "-c", configFile], {
    cwd: xtermRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`vite build -c ${configFile} exited with code ${result.status ?? 1}.`);
  }
}

function hasFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

/** 파일이든 디렉터리든, 그 안에서 가장 최근에 고쳐진 시각. 없으면 0. */
function newestMtimeMs(target) {
  if (!fs.existsSync(target)) {
    return 0;
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtimeMs(path.join(target, entry)));
  }
  return newest;
}

function assertFiles(label, filePaths) {
  const missing = filePaths.filter((filePath) => !hasFile(filePath));
  if (missing.length > 0) {
    throw new Error(
      `${label} is stale or missing. Missing: ${missing
        .map((filePath) => path.relative(repoRoot, filePath))
        .join(", ")}`,
    );
  }
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

/**
 * 산출물이 소스보다 낡았는지.
 *
 * 예전에는 dist/index.js 가 있으면 그대로 넘어갔다. 그러면 WebView 페이지나 래퍼를 고쳐도 앱에는
 * 예전 번들이 들어간다 — 산출물이 gitignore 대상이라 눈에도 띄지 않는다. 터미널 쪽을 손볼 때마다
 * 손으로 다시 빌드해야 한다는 뜻이었고, 잊으면 "고쳤는데 안 바뀐다" 로 나타난다.
 */
function isXtermRuntimeStale() {
  const outputs = [xtermDistJsPath, xtermDistTypesPath, xtermInternalHtmlPath];
  if (outputs.some((filePath) => !hasFile(filePath))) {
    return true;
  }
  const builtAt = Math.min(...outputs.map((filePath) => newestMtimeMs(filePath)));
  const changedAt = Math.max(...xtermSourcePaths.map(newestMtimeMs));
  return changedAt > builtAt;
}

function ensureXtermRuntime() {
  if (!isXtermRuntimeStale()) {
    return;
  }

  console.log("Preparing @fressh/react-native-xtermjs-webview runtime...");

  // 페이지 소스가 있으면 그것으로 만든다. 여기서 게시된 페이지를 쓰면 이 저장소가 페이지에 넣은
  // 것(예: 링크 애드온)이 조용히 빠진 채 앱이 빌드된다.
  //
  // 없을 때의 대비책은 남겨 둔다 — 상류 패키지는 이 소스를 배포에 넣지 않으므로, 벤더 사본을
  // 갈아끼우다 소스가 빠지면 그때는 게시본으로라도 빌드가 서야 한다.
  if (hasFile(xtermInternalEntryPath)) {
    runVite("vite.config.internal.ts");
  } else {
    hydrateXtermInternalHtml();
  }

  runVite("vite.config.ts");

  if (!hasFile(xtermDistJsPath) || !hasFile(xtermDistTypesPath)) {
    throw new Error("@fressh/react-native-xtermjs-webview runtime build did not produce dist/index.js and dist/index.d.ts.");
  }
}

function checkXtermRuntime() {
  assertFiles("@fressh/react-native-xtermjs-webview runtime", [
    xtermDistJsPath,
    xtermDistTypesPath,
    xtermInternalHtmlPath,
  ]);
}

function ensureMobileWorkspaceRuntime(options = {}) {
  if (options.check) {
    checkXtermRuntime();
    return;
  }

  ensureXtermRuntime();
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    ensureMobileWorkspaceRuntime(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  checkXtermRuntime,
  ensureMobileWorkspaceRuntime,
};
