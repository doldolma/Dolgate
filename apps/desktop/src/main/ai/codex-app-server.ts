import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { CodexAuthStatus, CodexLoginStart, CodexRateWindow, CodexUsage } from "../../shared/ai";

// Codex(ChatGPT 계정) 연동의 main 프로세스 배관.
// - 인증: `codex app-server` 자식 프로세스와 stdio JSON-RPC 로 통신(login/status/logout).
//   토큰 저장·갱신은 codex 가 CODEX_HOME/auth.json 에 알아서 한다(우리는 시크릿을 만지지 않음).
// - CODEX_HOME 은 userData/codex 로 앱 격리(사용자의 ~/.codex 와 분리 — 여기 로그인/로그아웃이
//   codex CLI 에 영향을 주지 않는다).
// - 채팅(provider-codex.ts)도 같은 바이너리·CODEX_HOME 을 쓴다.

type JsonRpcResponse = { id: number; result?: unknown; error?: { code: number; message: string } };
type JsonRpcNotification = { method: string; params?: unknown };

type LoginStartResponse =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | { type: string };

type AccountReadResponse = {
  account: null | { type: string; email?: unknown; planType?: unknown };
  requiresOpenaiAuth?: boolean;
};

type RateWindowResponse = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};
type RateLimitsResponse = {
  rateLimits?: {
    planType?: unknown;
    primary?: RateWindowResponse | null;
    secondary?: RateWindowResponse | null;
  } | null;
};

// npm 플랫폼 패키지 이름/vendor 트리플 매핑(@openai/codex bin/codex.js 와 동일한 규칙).
function platformTarget(): { pkg: string; triple: string } | null {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") {
    return { pkg: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { pkg: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" };
  }
  if (platform === "linux" && arch === "x64") {
    return { pkg: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { pkg: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" };
  }
  if (platform === "win32" && arch === "x64") {
    return { pkg: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  }
  if (platform === "win32" && arch === "arm64") {
    return { pkg: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
  }
  return null;
}

function appAsarUnpackedPath(appPath: string): string | null {
  const normalizedPath = path.normalize(appPath);
  const asarSegment = `${path.sep}app.asar`;
  const asarIndex = normalizedPath.indexOf(asarSegment);
  if (asarIndex === -1) {
    return null;
  }
  return `${normalizedPath.slice(0, asarIndex)}${path.sep}app.asar.unpacked${normalizedPath.slice(
    asarIndex + asarSegment.length,
  )}`;
}

function nodeModulesRootsForCodex(): string[] {
  const appPath = app.getAppPath();
  if (app.isPackaged) {
    const unpackedAppPath = appAsarUnpackedPath(appPath);
    return unpackedAppPath ? [path.join(unpackedAppPath, "node_modules")] : [];
  }
  return [
    path.join(appPath, "node_modules"),
    path.resolve(appPath, "..", "..", "node_modules"),
  ];
}

interface CodexInstallation {
  binaryPath: string;
  pathDirs: string[];
  managedPackageRoot?: string;
}

function findPackagedCodexRuntime(binaryName: string): CodexInstallation | null {
  const target = platformTarget();
  if (!target || !app.isPackaged) {
    return null;
  }

  const packageRoot = path.join(process.resourcesPath, "codex-cli");
  const targetRoot = path.join(packageRoot, "vendor", target.triple);
  const binaryPath = path.join(targetRoot, "bin", binaryName);
  if (!existsSync(binaryPath)) {
    return null;
  }

  return {
    binaryPath,
    pathDirs: [path.join(targetRoot, "codex-path")].filter((dir) => existsSync(dir)),
    managedPackageRoot: packageRoot,
  };
}

function findCodexNativePackage(binaryName: string): CodexInstallation | null {
  const target = platformTarget();
  if (!target) {
    return null;
  }

  for (const root of nodeModulesRootsForCodex()) {
    const packageRoot = path.join(root, ...target.pkg.split("/"));
    const vendorRoot = path.join(packageRoot, "vendor", target.triple);
    const packageBinaryPath = path.join(vendorRoot, "bin", binaryName);
    if (existsSync(packageBinaryPath)) {
      return {
        binaryPath: packageBinaryPath,
        pathDirs: [path.join(vendorRoot, "codex-path")].filter((dir) => existsSync(dir)),
        managedPackageRoot: packageRoot,
      };
    }

    const legacyBinaryPath = path.join(vendorRoot, "codex", binaryName);
    if (existsSync(legacyBinaryPath)) {
      return {
        binaryPath: legacyBinaryPath,
        pathDirs: [path.join(vendorRoot, "path")].filter((dir) => existsSync(dir)),
        managedPackageRoot: packageRoot,
      };
    }
  }

  return null;
}

function findCodexInstallation(binaryName: string): CodexInstallation | null {
  return findPackagedCodexRuntime(binaryName) ?? findCodexNativePackage(binaryName);
}

// codex 네이티브 바이너리 경로 해석.
// - 패키지 앱: extraResource 로 실어둔 resources/codex-cli/vendor/<triple>/bin 을 우선 사용한다.
// - dev: 워크스페이스 node_modules 의 플랫폼 패키지(vendor/<triple>/bin — 0.142+, 구버전은 codex/).
// - 폴백: PATH 의 codex.
export function resolveCodexBin(): string {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  if (app.isPackaged) {
    const packagedInstallation = findPackagedCodexRuntime(binaryName);
    if (packagedInstallation) {
      return packagedInstallation.binaryPath;
    }
    const resourceBinaryPath = path.join(process.resourcesPath, "bin", binaryName);
    if (existsSync(resourceBinaryPath)) {
      return resourceBinaryPath;
    }
    return findCodexNativePackage(binaryName)?.binaryPath ?? resourceBinaryPath;
  }
  return findCodexInstallation(binaryName)?.binaryPath ?? binaryName;
}

export function resolveCodexPathDirs(): string[] {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  return findCodexInstallation(binaryName)?.pathDirs ?? [];
}

function pathEnvKey(env: Record<string, string>): string {
  if (process.platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function prependPathDirs(env: Record<string, string>, pathDirs: string[]): void {
  if (pathDirs.length === 0) {
    return;
  }
  const key = pathEnvKey(env);
  const existingEntries = (env[key] ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && !pathDirs.includes(entry));
  env[key] = [...pathDirs, ...existingEntries].join(path.delimiter);
}

export function resolveCodexHome(): string {
  const home = path.join(app.getPath("userData"), "codex");
  mkdirSync(home, { recursive: true });
  return home;
}

// codex 프로세스(app-server·exec 공용)에 넘길 환경. SDK 의 env 옵션은 process.env 를
// 상속하지 않으므로 반드시 스프레드해서 만든다.
export function codexEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.CODEX_HOME = resolveCodexHome();
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const installation = findCodexInstallation(binaryName);
  if (installation?.managedPackageRoot) {
    env.CODEX_MANAGED_BY_NPM = "1";
    env.CODEX_MANAGED_PACKAGE_ROOT = installation.managedPackageRoot;
  }
  prependPathDirs(env, installation?.pathDirs ?? []);
  return env;
}

// `codex app-server` JSON-RPC 클라이언트. 첫 요청 때 lazy spawn 하고 재사용한다.
// 프로세스가 죽으면 pending 을 전부 reject 하고 다음 요청에서 재기동한다.
export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly spawnProcess: () => ChildProcessWithoutNullStreams = () =>
      spawn(resolveCodexBin(), ["app-server"], {
        env: codexEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      }),
  ) {
    super();
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.start();
    return this.send<T>(method, params);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.initPromise = null;
  }

  private start(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.startInner().catch((error) => {
        // 기동 실패(바이너리 없음 등)를 캐시하지 않는다 — 다음 요청에서 재시도.
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async startInner(): Promise<void> {
    const child = this.spawnProcess();
    this.child = child;

    child.once("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      this.failAll(new Error(`Codex app-server 가 종료되었습니다 (${code ?? signal ?? "unknown"})`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));

    await this.send("initialize", {
      clientInfo: { name: "dolgate", title: "Dolgate", version: app.getVersion() },
      capabilities: { experimentalApi: true },
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.child = null;
    this.initPromise = null;
    this.emit("exit", error);
  }

  private send<T>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("Codex app-server 가 실행 중이 아닙니다."));
    }
    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      this.emit("stderr", `Codex app-server 비-JSON 출력: ${line}`);
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.emit("notification", message);
  }
}

// 인증 편의 메서드 — 렌더러가 authUrl 을 외부 브라우저로 열고 status 폴링으로 완료를 감지한다.
export async function codexLoginStart(client: CodexAppServerClient): Promise<CodexLoginStart> {
  const response = await client.request<LoginStartResponse>("account/login/start", { type: "chatgpt" });
  if (response.type !== "chatgpt" || !("authUrl" in response)) {
    throw new Error("Codex 가 브라우저 로그인 URL을 반환하지 않았습니다.");
  }
  return { loginId: response.loginId, authUrl: response.authUrl };
}

export async function codexAuthStatus(client: CodexAppServerClient): Promise<CodexAuthStatus> {
  const response = await client.request<AccountReadResponse>("account/read", { refreshToken: true });
  const account = response.account;
  return {
    authenticated: Boolean(account),
    authMode: account?.type ?? null,
    email: account && typeof account.email === "string" ? account.email : null,
    planType: account && typeof account.planType === "string" ? account.planType : null,
  };
}

export async function codexLogout(client: CodexAppServerClient): Promise<void> {
  await client.request("account/logout");
}

function toRateWindow(raw: RateWindowResponse | null | undefined): CodexRateWindow | null {
  if (!raw || typeof raw.usedPercent !== "number" || typeof raw.windowDurationMins !== "number") {
    return null;
  }
  return {
    usedPercent: raw.usedPercent,
    windowMinutes: raw.windowDurationMins,
    resetsAt: typeof raw.resetsAt === "number" ? raw.resetsAt : null,
  };
}

// 플랜 사용량(rate limit 창) 조회. 미인증/미지원이면 window 들이 null 인 요약을 돌려준다(throw 안 함).
export async function codexUsage(client: CodexAppServerClient): Promise<CodexUsage> {
  const response = await client.request<RateLimitsResponse>("account/rateLimits/read");
  const limits = response.rateLimits ?? null;
  return {
    planType: limits && typeof limits.planType === "string" ? limits.planType : null,
    primary: toRateWindow(limits?.primary),
    secondary: toRateWindow(limits?.secondary),
  };
}

// 앱 전역 공유 인스턴스(첫 사용 때 spawn). 앱 종료 시 정리.
let sharedClient: CodexAppServerClient | null = null;

export function getCodexAppServer(): CodexAppServerClient {
  if (!sharedClient) {
    sharedClient = new CodexAppServerClient();
    app.once("will-quit", () => {
      sharedClient?.stop();
      sharedClient = null;
    });
  }
  return sharedClient;
}
