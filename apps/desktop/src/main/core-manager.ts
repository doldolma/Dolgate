import { BrowserWindow, app } from "electron";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  ActivityLogRecord,
  ContainerActionLogMetadata,
  ContainerLifecycleLogMetadata,
  ContainerLifecycleTransport,
  ContainerWorkspaceKind,
  HostKeyProbeResult,
  HostContainerAction,
  HostContainerDetails,
  HostContainerListResult,
  HostContainerLogSearchResult,
  HostContainerLogsSnapshot,
  HostContainerRuntime,
  HostContainerStatsSample,
  CoreEvent,
  CoreEventType,
  CoreRequest,
  CoreStreamFrame,
  DirectoryListing,
  FileEntry,
  PortForwardMode,
  PortForwardTransport,
  PortForwardRuntimeEvent,
  PortForwardRuntimeRecord,
  KeyboardInteractiveRespondInput,
  ControlSignalPayload,
  ResolvedCertificateInspectPayload,
  ResolvedAwsConnectPayload,
  ResolvedAuthorizedKeyInstallPayload,
  ResolvedAuthorizedKeyInstallResult,
  ResolvedContainersConnectPayload,
  ResolvedCoreConnectPayload,
  ResolvedHostKeyProbePayload,
  ResolvedLocalConnectPayload,
  ResolvedPrivateKeyGeneratePayload,
  ResolvedPrivateKeyGenerateResult,
  ResolvedPrivateKeyInspectPayload,
  ResolvedPrivateKeyInspectResult,
  ResolvedSerialConnectPayload,
  ResolvedSerialControlPayload,
  ResolvedSerialControlResult,
  ResolvedSerialListPortsPayload,
  ResolvedPortForwardStartPayload,
  ResolvedSsmPortForwardStartPayload,
  ResolvedSftpConnectPayload,
  SessionConnectionKind,
  SessionLifecycleLogMetadata,
  SerialPortSummary,
  SftpChmodInput,
  SftpChownInput,
  SftpDeleteInput,
  SftpReadFileInput,
  SftpReadFileResult,
  SftpWriteFileInput,
  SftpEndpointSummary,
  SftpLifecycleLogMetadata,
  SftpListPrincipalsInput,
  SftpListInput,
  SftpMkdirInput,
  SftpPrincipal,
  SftpRenameInput,
  SessionShareControlSignal,
  SshCertificateInfo,
  TerminalTab,
  TransferFailedItem,
  TransferJob,
  TransferJobEvent,
  TransferStartInput,
} from "@shared";
import { MAX_HOST_STARTUP_COMMAND_LENGTH } from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import {
  CoreFrameParser,
  encodeControlFrame,
  encodeStreamFrame,
} from "./core-framing";
import { resolveDesktopRepoRoot } from "./repo-root";

const TERMINAL_COMPLETION_QUERY_TIMEOUT_MS = 10_000;
// AI run_command 기본 타임아웃(모델이 지정 안 하면). Go 코어가 최대 120s 로 상한을 건다.
const AI_RUN_COMMAND_DEFAULT_TIMEOUT_MS = 15_000;

// AI run_in_terminal 캡처 출력에서 ANSI/OSC 이스케이프·CR 을 제거해 모델이 읽기 좋게 만든다.
function stripTerminalNoise(text: string): string {
  // 소스에 실제 제어문자를 넣지 않도록 ESC/LF 를 char code 로 만든다.
  const ESC = String.fromCharCode(27);
  const LF = String.fromCharCode(10);
  let out = "";
  for (let idx = 0; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (ch === ESC) {
      const next = text[idx + 1];
      if (next === "]") {
        // OSC: BEL(7) 또는 ESC 까지 스킵
        idx += 2;
        while (idx < text.length && text.charCodeAt(idx) !== 7 && text[idx] !== ESC) idx += 1;
      } else if (next === "[") {
        // CSI: 최종 바이트(@-~ = 64..126) 까지 스킵
        idx += 2;
        while (idx < text.length) {
          const code = text.charCodeAt(idx);
          if (code >= 64 && code <= 126) break;
          idx += 1;
        }
      } else {
        idx += 1;
      }
      continue;
    }
    const code = text.charCodeAt(idx);
    if (code === 13) {
      out += LF;
      continue;
    }
    if (code < 32 && code !== 10 && code !== 9) continue;
    out += ch;
  }
  return out.trim();
}

// AWS SSM 자동완성 프로브 대기 상한. ssh-core의 autocompleteProbeTimeout(9s,
// services/ssh-core/internal/awssession/manager.go)이 prompt 대기 + snapshot
// probe를 하나의 deadline으로 묶으므로, 여기는 그보다 길어야 한다(릴레이 여유 +1s).
// 이보다 짧으면(과거 3.5s) 코어가 정상적으로 프로브 중인데 데스크톱이 먼저
// 포기해 응답이 버려지고, 그 동안 큐에 잡힌 입력 때문에 "연결됐는데 입력이
// 안 되는" 세션처럼 보인다.
const AWS_SSM_AUTOCOMPLETE_PROBE_TIMEOUT_MS = 10_000;
const AUTOCOMPLETE_PREPARE_TIMEOUT_MS = 3_500;

interface ActivityLogInput {
  level: "info" | "warn" | "error";
  category: "session" | "audit";
  message: string;
  metadata?: Record<string, unknown> | null;
}

interface SessionLifecycleState {
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails: string | null;
  connectionKind: SessionConnectionKind;
  connectedAt: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  status: "connected" | "closed" | "error" | null;
  recordingId: string | null;
  hasReplay: boolean;
}

type CoreSessionConnectPayload = ResolvedCoreConnectPayload & {
  title: string;
  hostId: string;
  hostLabel: string;
  transport?: "ssh" | "warpgate" | "aws-ssm";
  connectionKind?: Extract<
    SessionConnectionKind,
    "ssh" | "mosh" | "aws-ssm" | "warpgate"
  >;
  connectionDetails?: string | null;
  startupCommand?: string;
  tmux?: boolean;
};

interface AwsServerProxyStartPayload {
  hostId: string;
  label: string;
  profileName: string;
  region: string;
  instanceId: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  unsetEnv?: string[];
}

interface AwsServerProxySessionRuntime {
  socket: WebSocket;
  finalized: boolean;
  errorEmitted: boolean;
}

interface PortForwardDefinition {
  ruleId: string;
  hostId: string;
  transport: PortForwardTransport;
  backendTransport: "ssh" | "aws-ssm";
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
}

interface CoreManagerShutdownOptions {
  finalizePortForwardsAsStopped?: boolean;
}

interface SftpPartialCleanupRecord {
  id: string;
  jobId: string;
  hostId: string;
  path: string;
  createdAt: string;
}

interface SftpLifecycleState {
  endpointId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  status: SftpLifecycleLogMetadata["status"];
  endReason: string | null;
  uploadedCount: number;
  downloadedCount: number;
  remoteCopyCount: number;
  uploadedBytes: number;
  downloadedBytes: number;
  remoteCopyBytes: number;
  mkdirCount: number;
  renameCount: number;
  chmodCount: number;
  chownCount: number;
  deleteCount: number;
  errorCount: number;
  visitedPaths: Set<string>;
  lastPath: string | null;
}

interface ContainersEndpointRuntime {
  hostId: string;
  runtime: HostContainerRuntime | null;
  runtimeCommand: string | null;
  unsupportedReason: string | null;
}

interface ContainerLifecycleState {
  lifecycleId: string;
  scopeId: string;
  hostId: string;
  hostLabel: string;
  workspaceKind: ContainerWorkspaceKind;
  transport: ContainerLifecycleTransport;
  runtime: HostContainerRuntime | null;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  status: ContainerLifecycleLogMetadata["status"];
  refreshCount: number;
  errorCount: number;
  resourceCount: number | null;
  lastError: string | null;
  endReason: string | null;
}

export type SessionTransport =
  | "ssh"
  | "mosh"
  | "aws-ssm"
  | "aws-ssm-server-proxy"
  | "warpgate"
  | "local-shell"
  | "serial";

const AWS_SSM_CONTROL_SIGNAL_BY_BYTE: ReadonlyMap<
  number,
  SessionShareControlSignal
> = new Map<number, SessionShareControlSignal>([
  [0x03, "interrupt"],
  [0x1a, "suspend"],
  [0x1c, "quit"],
]);

const packagedUnixCorePathEntries = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];
const SHUTDOWN_SESSION_DISCONNECT_REASON =
  "앱 종료로 세션이 정리되었습니다.";
const SHUTDOWN_SFTP_DISCONNECT_REASON =
  "앱 종료로 SFTP 연결이 정리되었습니다.";
const SHUTDOWN_CONTAINERS_DISCONNECT_REASON =
  "앱 종료로 Containers 연결이 정리되었습니다.";
// connected 직후엔 셸이 아직 프롬프트(PS1)를 안 찍었을 수 있다. 이때 startup command를
// 보내면 커널 tty(cooked, echo on)와 readline(raw)이 입력을 두 번 echo 한다.
// 그래서 "출력이 잠잠해졌고 + 꼬리가 프롬프트처럼 보일 때"에만 보낸다.
// (rc 파일 sourcing처럼 출력이 잠깐 멈추는 구간에 속으면 안 되므로 단순 디바운스로는 부족하다.)
const STARTUP_COMMAND_FLUSH_QUIET_MS = 180;
// 프롬프트를 끝내 못 알아봐도(특이한 PS1 등) 이 시간이 지나면 보낸다.
// 이 시점이면 보통 프롬프트가 떠 있어 echo는 한 번만 난다.
const STARTUP_COMMAND_FLUSH_MAX_WAIT_MS = 2500;
// 프롬프트 판별을 위해 들여다보는 최근 출력 길이(바이트가 아니라 문자 기준).
const STARTUP_COMMAND_TAIL_MAX_LENGTH = 256;

interface StartupCommandFlushState {
  // 프롬프트 판별을 위해 모아 둔 최근 출력 꼬리(제어문자 포함, 길이 제한).
  tail: string;
  // 출력이 멈추면 발사되는 디바운스 타이머.
  quietTimer: ReturnType<typeof setTimeout> | null;
  // 프롬프트를 못 알아봐도 결국 보내기 위한 상한 타이머.
  maxWaitTimer: ReturnType<typeof setTimeout>;
}

// 출력 꼬리가 대화형 셸 프롬프트로 끝나는지 추정한다(완벽할 수는 없고 보수적으로 본다).
function looksLikeShellPrompt(tail: string): boolean {
  const stripped = tail
    // OSC(창 제목 설정 등) 제거: ESC ] ... (BEL | ESC \\)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // CSI(색상 등) 제거: ESC [ ... final
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // 남은 단독 ESC 시퀀스 제거
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[ \t\r]+$/g, "");
  // 흔한 프롬프트 종결자: $ # % > 그리고 oh-my-zsh/starship/powerline의 ❯ ➜
  return /[$#%>\u276f\u279c]$/.test(stripped);
}

type PathDelimiter = ":" | ";";

function getPathDelimiterForPlatform(platform: NodeJS.Platform): PathDelimiter {
  return platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
}

function splitPathEntries(
  rawPath: string | undefined,
  delimiter: PathDelimiter = path.delimiter,
): string[] {
  return (rawPath ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeUniquePathEntries(
  preferredEntries: string[],
  rawPath: string | undefined,
  options?: {
    delimiter?: PathDelimiter;
    caseInsensitive?: boolean;
  },
): string {
  const delimiter: PathDelimiter = options?.delimiter ?? path.delimiter;
  const caseInsensitive = options?.caseInsensitive ?? false;
  const entries: string[] = [];
  const seen = new Set<string>();

  const appendUnique = (entry: string) => {
    const normalized = entry.trim();
    const seenKey = caseInsensitive ? normalized.toLowerCase() : normalized;
    if (!normalized || seen.has(seenKey)) {
      return;
    }
    seen.add(seenKey);
    entries.push(normalized);
  };

  preferredEntries.forEach(appendUnique);
  splitPathEntries(rawPath, delimiter).forEach(appendUnique);
  return entries.join(delimiter);
}

function resolveAwsSsmControlSignal(
  payload: Uint8Array,
): SessionShareControlSignal | null {
  if (payload.length !== 1) {
    return null;
  }
  return AWS_SSM_CONTROL_SIGNAL_BY_BYTE.get(payload[0]) ?? null;
}

function lookupEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  options?: { caseInsensitive?: boolean },
): string | undefined {
  if (!options?.caseInsensitive) {
    return env[key];
  }

  const target = key.toLowerCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function resolveExistingEnvKey(
  env: NodeJS.ProcessEnv,
  key: string,
  options?: { caseInsensitive?: boolean },
): string | null {
  if (!options?.caseInsensitive) {
    return Object.prototype.hasOwnProperty.call(env, key) ? key : null;
  }

  const target = key.toLowerCase();
  for (const candidate of Object.keys(env)) {
    if (candidate.toLowerCase() === target) {
      return candidate;
    }
  }
  return null;
}

function buildPackagedWindowsCorePathEntries(env: NodeJS.ProcessEnv): {
  pathEntries: string[];
  cmdExecutablePath: string | null;
  windowsRoot: string | null;
} {
  const systemRoot =
    lookupEnvValue(env, "SystemRoot", { caseInsensitive: true }) ??
    lookupEnvValue(env, "windir", { caseInsensitive: true }) ??
    "C:\\Windows";
  const win32 = path.win32;
  const windowsRoot = systemRoot.trim() || "C:\\Windows";
  const cmdExecutablePath = win32.join(windowsRoot, "System32", "cmd.exe");
  const powerShell7PathEntries = buildWindowsPowerShell7PathEntries(env, win32);

  return {
    pathEntries: [
      win32.join(windowsRoot, "System32"),
      windowsRoot,
      win32.join(windowsRoot, "System32", "Wbem"),
      ...powerShell7PathEntries,
      win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
    ],
    cmdExecutablePath,
    windowsRoot,
  };
}

function buildWindowsPowerShell7PathEntries(
  env: NodeJS.ProcessEnv,
  win32: typeof path.win32,
): string[] {
  const roots = [
    lookupEnvValue(env, "ProgramFiles", { caseInsensitive: true }),
    lookupEnvValue(env, "ProgramW6432", { caseInsensitive: true }),
    lookupEnvValue(env, "ProgramFiles(x86)", { caseInsensitive: true }),
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ];
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const normalizedRoot = root?.trim();
    if (!normalizedRoot) {
      continue;
    }
    const candidate = win32.join(normalizedRoot, "PowerShell", "7");
    const seenKey = candidate.toLowerCase();
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);
    entries.push(candidate);
  }

  return entries;
}

function assignEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
  options?: { caseInsensitive?: boolean; fallbackKey?: string },
): void {
  const existingKey =
    resolveExistingEnvKey(env, key, {
      caseInsensitive: options?.caseInsensitive,
    }) ??
    options?.fallbackKey ??
    key;
  env[existingKey] = value;

  if (options?.caseInsensitive) {
    const target = existingKey.toLowerCase();
    for (const candidate of Object.keys(env)) {
      if (candidate !== existingKey && candidate.toLowerCase() === target) {
        delete env[candidate];
      }
    }
  }
}

export function buildCoreChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options?: {
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
  },
): NodeJS.ProcessEnv {
  const platform = options?.platform ?? process.platform;
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  const env = { ...baseEnv };

  if (!isPackaged) {
    return env;
  }

  if (platform === "win32") {
    const { pathEntries, cmdExecutablePath, windowsRoot } =
      buildPackagedWindowsCorePathEntries(env);
    const delimiter = getPathDelimiterForPlatform(platform);
    const currentPathValue = lookupEnvValue(env, "PATH", {
      caseInsensitive: true,
    });
    assignEnvValue(
      env,
      "PATH",
      mergeUniquePathEntries(pathEntries, currentPathValue, {
        delimiter,
        caseInsensitive: true,
      }),
      {
        caseInsensitive: true,
        fallbackKey: "Path",
      },
    );
    if (windowsRoot) {
      assignEnvValue(
        env,
        "SystemRoot",
        lookupEnvValue(env, "SystemRoot", { caseInsensitive: true }) ??
          windowsRoot,
        {
          caseInsensitive: true,
          fallbackKey: "SystemRoot",
        },
      );
      assignEnvValue(
        env,
        "windir",
        lookupEnvValue(env, "windir", { caseInsensitive: true }) ?? windowsRoot,
        {
          caseInsensitive: true,
          fallbackKey: "windir",
        },
      );
    }
    if (
      !lookupEnvValue(env, "COMSPEC", { caseInsensitive: true }) &&
      cmdExecutablePath
    ) {
      assignEnvValue(env, "COMSPEC", cmdExecutablePath, {
        caseInsensitive: true,
        fallbackKey: "ComSpec",
      });
    }
    return env;
  }

  env.PATH = mergeUniquePathEntries(packagedUnixCorePathEntries, env.PATH, {
    delimiter: getPathDelimiterForPlatform(platform),
  });
  return env;
}

function resolveRepoRoot(): string {
  return resolveDesktopRepoRoot({
    appPath: app.getAppPath(),
    currentDir: __dirname,
  });
}

function resolveBundledCorePath(): string {
  const binaryName = process.platform === "win32" ? "ssh-core.exe" : "ssh-core";
  return path.join(process.resourcesPath, "bin", binaryName);
}

function resolveDevCoreBinaryPath(): string {
  const binaryName = process.platform === "win32" ? "ssh-core.exe" : "ssh-core";
  const repoRoot = resolveRepoRoot();
  return path.join(
    repoRoot,
    "apps",
    "desktop",
    "release",
    "resources",
    process.platform,
    "x64",
    "bin",
    binaryName,
  );
}

function resolveCoreLaunchConfig(): {
  command: string;
  args: string[];
  cwd: string;
} {
  if (app.isPackaged) {
    const bundledCorePath = resolveBundledCorePath();
    if (!existsSync(bundledCorePath)) {
      throw new Error(`Bundled ssh-core binary not found: ${bundledCorePath}`);
    }
    return {
      command: bundledCorePath,
      args: [],
      cwd: path.dirname(bundledCorePath),
    };
  }

  const repoRoot = resolveRepoRoot();
  const serviceDir = path.join(repoRoot, "services", "ssh-core");
  if (!existsSync(serviceDir)) {
    throw new Error(`SSH core directory not found: ${serviceDir}`);
  }

  if (process.platform === "win32") {
    const devCoreBinaryPath = resolveDevCoreBinaryPath();
    if (!existsSync(devCoreBinaryPath)) {
      throw new Error(
        `Local ssh-core dev binary not found: ${devCoreBinaryPath}`,
      );
    }
    return {
      command: devCoreBinaryPath,
      args: [],
      cwd: path.dirname(devCoreBinaryPath),
    };
  }

  return {
    command: "go",
    args: ["run", "./cmd/ssh-core"],
    cwd: serviceDir,
  };
}

interface PendingResponse<TPayload> {
  resolve: (payload: TPayload) => void;
  reject: (error: Error) => void;
  expectedTypes: Set<CoreEventType>;
  timeout: NodeJS.Timeout;
}

interface PendingAwsAutocompleteResponse {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingSessionReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  suppressFailureEvent: boolean;
  settled: boolean;
}

function isTransferEvent(type: CoreEventType): boolean {
  return (
    type === "sftpTransferProgress" ||
    type === "sftpTransferCompleted" ||
    type === "sftpTransferFailed" ||
    type === "sftpTransferCancelled"
  );
}

function toDirectoryListing(
  payload: Record<string, unknown>,
): DirectoryListing {
  return {
    path: String(payload.path ?? "/"),
    entries: Array.isArray(payload.entries)
      ? payload.entries.map((entry) => {
          const candidate = entry as Record<string, unknown>;
          return {
            name: String(candidate.name ?? ""),
            path: String(candidate.path ?? ""),
            isDirectory: Boolean(candidate.isDirectory),
            size: Number(candidate.size ?? 0),
            mtime: String(candidate.mtime ?? new Date(0).toISOString()),
            kind:
              candidate.kind === "folder" ||
              candidate.kind === "file" ||
              candidate.kind === "symlink" ||
              candidate.kind === "unknown"
                ? candidate.kind
                : "unknown",
            permissions: candidate.permissions
              ? String(candidate.permissions)
              : undefined,
            uid: typeof candidate.uid === "number" ? candidate.uid : undefined,
            gid: typeof candidate.gid === "number" ? candidate.gid : undefined,
            owner:
              typeof candidate.owner === "string" && candidate.owner
                ? candidate.owner
                : undefined,
            group:
              typeof candidate.group === "string" && candidate.group
                ? candidate.group
                : undefined,
          } satisfies FileEntry;
        })
      : [],
  };
}

function toSftpPrincipals(payload: Record<string, unknown>): SftpPrincipal[] {
  const principals = Array.isArray(payload.principals)
    ? payload.principals
    : [];
  return principals
    .map((principal) => {
      const candidate = principal as Record<string, unknown>;
      const kind = candidate.kind === "group" ? "group" : "user";
      const id = Number(candidate.id);
      return {
        kind,
        name: String(candidate.name ?? ""),
        id,
        displayName:
          typeof candidate.displayName === "string" && candidate.displayName
            ? candidate.displayName
            : undefined,
      } satisfies SftpPrincipal;
    })
    .filter((principal) => principal.name && Number.isFinite(principal.id));
}

function toSftpFileRead(payload: Record<string, unknown>): SftpReadFileResult {
  return {
    path: String(payload.path ?? ""),
    content: typeof payload.content === "string" ? payload.content : "",
    size: Number(payload.size ?? 0),
    mtime: typeof payload.mtime === "string" ? payload.mtime : "",
    mode: Number(payload.mode ?? 0),
  };
}

function normalizeSftpSudoStatus(value: string): SftpEndpointSummary["sudoStatus"] {
  return value === "probing" ||
    value === "root" ||
    value === "passwordless" ||
    value === "passwordRequired" ||
    value === "unavailable"
    ? value
    : "unknown";
}

function toTransferJobEvent(
  existing: TransferJob | undefined,
  event: CoreEvent<Record<string, unknown>>,
): TransferJobEvent {
  const payload = event.payload;
  const now = new Date().toISOString();
  const terminalStatus =
    event.type === "sftpTransferCompleted"
      ? "completed"
      : event.type === "sftpTransferFailed"
        ? "failed"
        : event.type === "sftpTransferCancelled"
          ? "cancelled"
          : null;
  const payloadStatus =
    payload.status === "paused" || payload.status === "running"
      ? payload.status
      : undefined;
  const nextStatus =
    terminalStatus ??
    (existing?.status === "cancelling" ? "cancelling" : payloadStatus ?? "running");
  const payloadMessage =
    typeof payload.message === "string" ? payload.message : undefined;
  const detailMessage =
    typeof payload.detailMessage === "string"
      ? payload.detailMessage
      : payloadMessage;
  const errorCode = normalizeTransferErrorCode(payload.errorCode);
  const errorOperation =
    typeof payload.errorOperation === "string"
      ? payload.errorOperation
      : undefined;
  const errorPath =
    typeof payload.errorPath === "string" ? payload.errorPath : undefined;
  const errorItemName =
    typeof payload.errorItemName === "string"
      ? payload.errorItemName
      : undefined;
  const failedItems = Array.isArray(payload.failedItems)
    ? payload.failedItems
        .map((item) => normalizeTransferFailedItem(item))
        .filter((item): item is TransferFailedItem => Boolean(item))
    : existing?.failedItems;

  return {
    job: {
      id: event.jobId ?? existing?.id ?? "",
      sourceLabel: existing?.sourceLabel ?? "Unknown",
      targetLabel: existing?.targetLabel ?? "Unknown",
      itemCount: existing?.itemCount ?? 0,
      bytesTotal: Number(payload.bytesTotal ?? existing?.bytesTotal ?? 0),
      bytesCompleted: Number(
        payload.bytesCompleted ?? existing?.bytesCompleted ?? 0,
      ),
      speedBytesPerSecond:
        typeof payload.speedBytesPerSecond === "number"
          ? payload.speedBytesPerSecond
          : existing?.speedBytesPerSecond,
      etaSeconds:
        typeof payload.etaSeconds === "number"
          ? payload.etaSeconds
          : existing?.etaSeconds,
      status: nextStatus,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      activeItemName: payload.activeItemName
        ? String(payload.activeItemName)
        : existing?.activeItemName,
      errorMessage:
        event.type === "sftpTransferFailed"
          ? getTransferFailureSummary({
              errorCode,
              errorOperation,
              fallbackMessage: payloadMessage ?? existing?.errorMessage,
            })
          : payloadMessage
            ? payloadMessage
            : existing?.errorMessage,
      errorCode: errorCode ?? existing?.errorCode,
      errorOperation: errorOperation ?? existing?.errorOperation,
      errorPath: errorPath ?? existing?.errorPath,
      errorItemName: errorItemName ?? existing?.errorItemName,
      detailMessage: detailMessage ?? existing?.detailMessage,
      completedItemCount:
        typeof payload.completedItemCount === "number"
          ? payload.completedItemCount
          : existing?.completedItemCount,
      failedItemCount:
        typeof payload.failedItemCount === "number"
          ? payload.failedItemCount
          : existing?.failedItemCount,
      failedItems,
      request: existing?.request,
    },
  };
}

function normalizeTransferFailedItem(value: unknown): TransferFailedItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const item = record.item;
  if (!item || typeof item !== "object") {
    return null;
  }
  const itemRecord = item as Record<string, unknown>;
  if (typeof itemRecord.name !== "string" || typeof itemRecord.path !== "string") {
    return null;
  }
  return {
    item: {
      name: itemRecord.name,
      path: itemRecord.path,
      isDirectory: Boolean(itemRecord.isDirectory),
      size: typeof itemRecord.size === "number" ? itemRecord.size : 0,
    },
    errorMessage:
      typeof record.errorMessage === "string"
        ? record.errorMessage
        : "전송에 실패했습니다.",
    errorCode: normalizeTransferErrorCode(record.errorCode),
    errorOperation:
      typeof record.errorOperation === "string"
        ? record.errorOperation
        : undefined,
    errorPath:
      typeof record.errorPath === "string" ? record.errorPath : undefined,
  };
}

function normalizeTransferErrorCode(
  value: unknown,
): TransferJob["errorCode"] | undefined {
  switch (value) {
    case "permission_denied":
    case "not_found":
    case "operation_unsupported":
    case "connection_lost":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

function getTransferFailureSummary(input: {
  errorCode?: TransferJob["errorCode"];
  errorOperation?: string;
  fallbackMessage?: string | null;
}): string {
  if (input.errorCode === "permission_denied") {
    if (input.errorOperation?.startsWith("source")) {
      return "원본 파일을 읽을 권한이 없습니다.";
    }
    if (
      input.errorOperation?.includes("remove") ||
      input.errorOperation?.includes("overwrite")
    ) {
      return "기존 항목을 덮어쓰거나 삭제할 권한이 없습니다.";
    }
    if (input.errorOperation?.startsWith("target")) {
      return "대상 폴더에 쓸 권한이 없습니다.";
    }
    return "파일을 전송할 권한이 없습니다.";
  }

  return input.fallbackMessage ?? "전송에 실패했습니다.";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export class CoreManager {
  constructor(
    private readonly appendLog?: (entry: ActivityLogInput) => void,
    private readonly upsertLogRecord?: (record: ActivityLogRecord) => void,
    private readonly buildChildEnv: () => Promise<NodeJS.ProcessEnv> = async () =>
      buildCoreChildEnv(process.env),
  ) {}

  // Go SSH 코어는 앱 전체에서 하나만 띄우고, 여러 SSH/SFTP 작업을 그 안에서 관리한다.
  private process: ChildProcessWithoutNullStreams | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private isShuttingDown = false;
  private readonly windows = new Set<BrowserWindow>();
  private readonly windowsByWebContentsId = new Map<number, BrowserWindow>();
  private readonly sessionOwnerStorage = new AsyncLocalStorage<number>();
  private readonly sessionOwnerById = new Map<string, number>();
  private readonly tabs = new Map<string, TerminalTab>();
  private readonly sftpEndpoints = new Map<string, SftpEndpointSummary>();
  private readonly sftpEndpointOwnerById = new Map<string, number>();
  private readonly sftpLifecycleByEndpointId = new Map<
    string,
    SftpLifecycleState
  >();
  private readonly sftpPartialCleanupRecords = new Map<
    string,
    SftpPartialCleanupRecord
  >();
  private sftpPartialCleanupLoaded = false;
  private readonly containerEndpoints = new Map<
    string,
    ContainersEndpointRuntime
  >();
  private readonly containerSubscriberIdsByEndpoint = new Map<
    string,
    Set<number>
  >();
  private readonly pendingContainerInteractiveEventByEndpoint = new Map<
    string,
    CoreEvent<Record<string, unknown>>
  >();
  private readonly containerLifecycleByScopeId = new Map<
    string,
    ContainerLifecycleState
  >();
  private readonly containerNamesByEndpointId = new Map<
    string,
    Map<string, string>
  >();
  private readonly transferJobs = new Map<string, TransferJob>();
  private readonly transferOwnerById = new Map<string, number>();
  private readonly portForwardDefinitions = new Map<
    string,
    PortForwardDefinition
  >();
  private readonly portForwardRuntimes = new Map<
    string,
    PortForwardRuntimeRecord
  >();
  private readonly pendingResponses = new Map<
    string,
    PendingResponse<Record<string, unknown>>
  >();
  private readonly desiredResizeBySession = new Map<
    string,
    { cols: number; rows: number }
  >();
  private readonly sentResizeBySession = new Map<
    string,
    { cols: number; rows: number }
  >();
  private readonly awsServerProxySessions = new Map<
    string,
    AwsServerProxySessionRuntime
  >();
  private readonly pendingAwsAutocompleteResponses = new Map<
    string,
    PendingAwsAutocompleteResponse
  >();
  private readonly pendingSessionReadyWaiters = new Map<
    string,
    PendingSessionReadyWaiter
  >();
  private readonly suppressedSessionCloseEvents = new Set<string>();
  private readonly suppressedSessionCloseEventTimers = new Map<
    string,
    NodeJS.Timeout
  >();
  private readonly sessionTransportById = new Map<string, SessionTransport>();
  // tmux control mode 로 연결한 control 세션 id 집합. control 세션은 transport 가 "ssh"
  // 라 일반 SSH 와 구분이 안 되므로 connect 시점(payload.tmux)에 기록한다. 세션 녹화
  // 제외 판정(isTmuxSession)에 쓴다(pane 가상 세션은 "tmux:" 프리픽스로 따로 판정).
  private readonly tmuxControlSessionIds = new Set<string>();
  private readonly pendingStartupCommandsBySessionId = new Map<string, string>();
  // connected 후 프롬프트가 떴다고 판단되면 startup command를 flush 하기 위한 상태.
  private readonly startupCommandFlushStateBySessionId = new Map<
    string,
    StartupCommandFlushState
  >();
  private readonly sessionLifecycleById = new Map<
    string,
    SessionLifecycleState
  >();
  private onTerminalEvent?: (
    event: CoreEvent<Record<string, unknown>>,
  ) => void | Promise<void>;
  private onTerminalStream?: (
    sessionId: string,
    chunk: Uint8Array,
  ) => void | Promise<void>;
  // AI run_in_terminal 출력 캡처(sessionId당 1개). broadcastStream 이 활성 캡처에 청크를 쌓는다.
  private readonly terminalCaptures = new Map<
    string,
    { chunks: Uint8Array[]; bytes: number; maxBytes: number; lastAt: number; truncated: boolean }
  >();
  private onPortForwardEvent?: (
    event: PortForwardRuntimeEvent,
  ) => void | Promise<void>;
  private issueSsmPortForwardToken?: (
    payload: ResolvedSsmPortForwardStartPayload,
  ) => Promise<
    { sessionId: string; streamUrl: string; tokenValue: string } | undefined
  >;
  // 바이너리 frame은 청크 경계를 보장하지 않으므로 별도 parser가 필요하다.
  private readonly parser = new CoreFrameParser();

  private getSftpPartialCleanupPath(): string {
    const userDataPath =
      typeof app?.getPath === "function"
        ? app.getPath("userData")
        : path.join(process.cwd(), ".tmp", "dolgate-sftp-cleanup");
    return path.join(userDataPath, "sftp-partial-cleanup.json");
  }

  private ensureSftpPartialCleanupLoaded(): void {
    if (this.sftpPartialCleanupLoaded) {
      return;
    }
    this.sftpPartialCleanupLoaded = true;
    const filePath = this.getSftpPartialCleanupPath();
    if (!existsSync(filePath)) {
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!Array.isArray(raw)) {
        return;
      }
      for (const item of raw) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const record = item as Record<string, unknown>;
        if (
          typeof record.id !== "string" ||
          typeof record.jobId !== "string" ||
          typeof record.hostId !== "string" ||
          typeof record.path !== "string" ||
          typeof record.createdAt !== "string"
        ) {
          continue;
        }
        this.sftpPartialCleanupRecords.set(record.id, {
          id: record.id,
          jobId: record.jobId,
          hostId: record.hostId,
          path: record.path,
          createdAt: record.createdAt,
        });
      }
    } catch {
      this.sftpPartialCleanupRecords.clear();
    }
  }

  private persistSftpPartialCleanupRecords(): void {
    this.ensureSftpPartialCleanupLoaded();
    const filePath = this.getSftpPartialCleanupPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify(Array.from(this.sftpPartialCleanupRecords.values()), null, 2),
    );
  }

  private recordSftpPartialPath(jobId: string, partialPath: string): void {
    if (!jobId || !partialPath) {
      return;
    }
    const job = this.transferJobs.get(jobId);
    const target = job?.request?.target;
    if (!target || target.kind !== "remote") {
      return;
    }
    const endpoint = this.sftpEndpoints.get(target.endpointId);
    if (!endpoint) {
      return;
    }
    this.ensureSftpPartialCleanupLoaded();
    const id = `${endpoint.hostId}:${partialPath}`;
    this.sftpPartialCleanupRecords.set(id, {
      id,
      jobId,
      hostId: endpoint.hostId,
      path: partialPath,
      createdAt: new Date().toISOString(),
    });
    this.persistSftpPartialCleanupRecords();
  }

  private clearSftpPartialRecordsForJob(jobId: string): void {
    this.ensureSftpPartialCleanupLoaded();
    let changed = false;
    for (const [id, record] of this.sftpPartialCleanupRecords) {
      if (record.jobId !== jobId) {
        continue;
      }
      this.sftpPartialCleanupRecords.delete(id);
      changed = true;
    }
    if (changed) {
      this.persistSftpPartialCleanupRecords();
    }
  }

  private async cleanupSftpPartialRecordsForHost(
    hostId: string,
    endpointId: string,
  ): Promise<void> {
    this.ensureSftpPartialCleanupLoaded();
    const records = Array.from(this.sftpPartialCleanupRecords.values()).filter(
      (record) => record.hostId === hostId,
    );
    if (records.length === 0) {
      return;
    }
    try {
      await this.sftpDelete({
        endpointId,
        paths: records.map((record) => record.path),
      });
      for (const record of records) {
        this.sftpPartialCleanupRecords.delete(record.id);
      }
      this.persistSftpPartialCleanupRecords();
    } catch (error) {
      this.log({
        level: "warn",
        category: "session",
        message: "이전 SFTP partial 파일 정리에 실패했습니다.",
        metadata: {
          endpointId,
          hostId,
          message: error instanceof Error ? error.message : "unknown error",
        },
      });
    }
  }

  setTerminalEventHandler(
    handler:
      | ((event: CoreEvent<Record<string, unknown>>) => void | Promise<void>)
      | undefined,
  ): void {
    this.onTerminalEvent = handler;
  }

  setTerminalStreamHandler(
    handler:
      | ((sessionId: string, chunk: Uint8Array) => void | Promise<void>)
      | undefined,
  ): void {
    this.onTerminalStream = handler;
  }

  setPortForwardEventHandler(
    handler:
      | ((event: PortForwardRuntimeEvent) => void | Promise<void>)
      | undefined,
  ): void {
    this.onPortForwardEvent = handler;
  }

  setSsmPortForwardTokenIssuer(
    issuer:
      | ((
          payload: ResolvedSsmPortForwardStartPayload,
        ) => Promise<
          { sessionId: string; streamUrl: string; tokenValue: string } | undefined
        >)
      | undefined,
  ): void {
    this.issueSsmPortForwardToken = issuer;
  }

  registerWindow(window: BrowserWindow): void {
    const ownerWebContentsId = window.webContents.id;
    this.windows.add(window);
    this.windowsByWebContentsId.set(ownerWebContentsId, window);
    window.on("closed", () => {
      this.windows.delete(window);
      this.windowsByWebContentsId.delete(ownerWebContentsId);
      this.disconnectSessionsOwnedBy(ownerWebContentsId);
      void this.disconnectSftpResourcesOwnedBy(ownerWebContentsId);
      void this.releaseContainerSubscriptionsOwnedBy(ownerWebContentsId);
    });
  }

  runWithSessionOwner<T>(
    ownerWebContentsId: number,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.sessionOwnerStorage.run(ownerWebContentsId, action);
  }

  registerSftpEndpointOwner(
    endpointId: string,
    ownerWebContentsId: number,
  ): void {
    const existingOwner = this.sftpEndpointOwnerById.get(endpointId);
    if (
      existingOwner !== undefined &&
      existingOwner !== ownerWebContentsId
    ) {
      throw new Error("다른 창에서 사용 중인 SFTP 연결입니다.");
    }
    this.sftpEndpointOwnerById.set(endpointId, ownerWebContentsId);
  }

  releaseSftpEndpointOwner(
    endpointId: string,
    ownerWebContentsId?: number,
  ): void {
    const existingOwner = this.sftpEndpointOwnerById.get(endpointId);
    if (
      ownerWebContentsId === undefined ||
      existingOwner === ownerWebContentsId
    ) {
      this.sftpEndpointOwnerById.delete(endpointId);
    }
  }

  assertSftpEndpointOwner(
    endpointId: string,
    ownerWebContentsId: number,
  ): void {
    if (this.sftpEndpointOwnerById.get(endpointId) !== ownerWebContentsId) {
      throw new Error("이 창에 속한 SFTP 연결이 아닙니다.");
    }
  }

  assertSftpTransferOwner(
    jobId: string,
    ownerWebContentsId: number,
  ): void {
    if (this.transferOwnerById.get(jobId) !== ownerWebContentsId) {
      throw new Error("이 창에 속한 파일 전송이 아닙니다.");
    }
  }

  sendSftpConnectionProgressToOwner(
    endpointId: string,
    payload: unknown,
  ): boolean {
    return this.sendToSftpEndpointOwner(
      endpointId,
      ipcChannels.sftp.connectionProgress,
      payload,
    );
  }

  registerContainerSubscriber(
    endpointId: string,
    ownerWebContentsId: number,
  ): void {
    const subscribers =
      this.containerSubscriberIdsByEndpoint.get(endpointId) ?? new Set<number>();
    subscribers.add(ownerWebContentsId);
    this.containerSubscriberIdsByEndpoint.set(endpointId, subscribers);
  }

  releaseContainerSubscriber(
    endpointId: string,
    ownerWebContentsId: number,
  ): { released: boolean; remainingSubscribers: number } {
    const subscribers = this.containerSubscriberIdsByEndpoint.get(endpointId);
    if (!subscribers) {
      return { released: false, remainingSubscribers: 0 };
    }
    const wasInteractiveOwner =
      subscribers.values().next().value === ownerWebContentsId;
    const released = subscribers.delete(ownerWebContentsId);
    if (released && wasInteractiveOwner && subscribers.size > 0) {
      const pendingEvent =
        this.pendingContainerInteractiveEventByEndpoint.get(endpointId);
      if (pendingEvent) {
        this.sendToContainerSubscribers(
          endpointId,
          ipcChannels.ssh.event,
          pendingEvent,
          true,
        );
      }
    }
    if (subscribers.size === 0) {
      this.pendingContainerInteractiveEventByEndpoint.delete(endpointId);
    }
    return {
      released,
      remainingSubscribers: subscribers.size,
    };
  }

  assertContainerSubscriber(
    endpointId: string,
    ownerWebContentsId: number,
  ): void {
    if (
      !this.containerSubscriberIdsByEndpoint
        .get(endpointId)
        ?.has(ownerWebContentsId)
    ) {
      throw new Error("이 창에서 연 Container 탭이 아닙니다.");
    }
  }

  sendContainersConnectionProgressToSubscribers(
    endpointId: string,
    payload: unknown,
  ): boolean {
    return this.sendToContainerSubscribers(
      endpointId,
      ipcChannels.containers.connectionProgress,
      payload,
    );
  }

  listTabs(ownerWebContentsId?: number): TerminalTab[] {
    const tabs = Array.from(this.tabs.values());
    if (ownerWebContentsId === undefined) {
      return tabs;
    }
    return tabs.filter(
      (tab) => this.resolveSessionOwnerId(tab.sessionId) === ownerWebContentsId,
    );
  }

  listPortForwardRuntimes(): PortForwardRuntimeRecord[] {
    return Array.from(this.portForwardRuntimes.values()).sort((a, b) =>
      a.ruleId.localeCompare(b.ruleId),
    );
  }

  getSessionLifecycleState(
    sessionId: string,
  ): SessionLifecycleState | null {
    const lifecycle = this.sessionLifecycleById.get(sessionId);
    return lifecycle ? { ...lifecycle } : null;
  }

  attachSessionRecording(sessionId: string, recordingId: string): void {
    const lifecycle = this.sessionLifecycleById.get(sessionId);
    if (!lifecycle) {
      return;
    }
    lifecycle.recordingId = recordingId;
    lifecycle.hasReplay = true;
    this.sessionLifecycleById.set(sessionId, lifecycle);

    if (!lifecycle.connectedAt) {
      return;
    }

    const metadata: SessionLifecycleLogMetadata = {
      sessionId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      title: lifecycle.title,
      connectionDetails: lifecycle.connectionDetails,
      connectionKind: lifecycle.connectionKind,
      connectedAt: lifecycle.connectedAt,
      disconnectedAt: lifecycle.disconnectedAt,
      durationMs: lifecycle.connectedAt && lifecycle.disconnectedAt
        ? Math.max(
            0,
            new Date(lifecycle.disconnectedAt).getTime() -
              new Date(lifecycle.connectedAt).getTime(),
          )
        : null,
      status: lifecycle.status ?? "connected",
      disconnectReason: lifecycle.disconnectReason,
      recordingId: lifecycle.recordingId,
      hasReplay: lifecycle.hasReplay,
    };

    this.upsertLog({
      id: this.getSessionLifecycleLogId(sessionId),
      level: metadata.status === "error" ? "error" : "info",
      category: "session",
      kind: "session-lifecycle",
      message: `${this.getConnectionKindLabel(lifecycle.connectionKind)} 세션`,
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: lifecycle.connectedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  setPortForwardRuntime(
    runtime: PortForwardRuntimeRecord,
  ): PortForwardRuntimeRecord {
    this.portForwardRuntimes.set(runtime.ruleId, runtime);
    this.broadcastPortForwardEvent({ runtime });
    void this.onPortForwardEvent?.({ runtime });
    return runtime;
  }

  async shutdown(options: CoreManagerShutdownOptions = {}): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.finalizeActiveSessionsOnShutdown();
    this.finalizeActiveSftpLifecyclesOnShutdown();
    this.finalizeActiveContainerLifecyclesOnShutdown();

    if (options.finalizePortForwardsAsStopped) {
      await this.finalizeActivePortForwardsAsStopped();
    }

    if (!this.process) {
      this.clearRuntimeState();
      return;
    }

    const currentProcess = this.process;
    this.isShuttingDown = true;
    this.shutdownPromise = new Promise((resolve) => {
      const finish = () => {
        this.clearRuntimeState();
        this.process = null;
        this.isShuttingDown = false;
        this.shutdownPromise = null;
        resolve();
      };

      const timeout = setTimeout(() => {
        if (currentProcess.exitCode === null && !currentProcess.killed) {
          currentProcess.kill("SIGKILL");
        }
      }, 1500);

      currentProcess.once("exit", () => {
        clearTimeout(timeout);
        finish();
      });

      currentProcess.stdin.end();
      if (currentProcess.exitCode === null && !currentProcess.killed) {
        currentProcess.kill("SIGTERM");
      }
    });

    return this.shutdownPromise;
  }

  private finalizeActiveSessionsOnShutdown(): void {
    for (const [sessionId, lifecycle] of this.sessionLifecycleById) {
      if (!lifecycle.connectedAt || lifecycle.disconnectedAt) {
        continue;
      }

      this.finalizeSessionLifecycle(
        sessionId,
        "closed",
        SHUTDOWN_SESSION_DISCONNECT_REASON,
      );
    }
  }

  private finalizeActiveSftpLifecyclesOnShutdown(): void {
    for (const [endpointId, lifecycle] of this.sftpLifecycleByEndpointId) {
      if (lifecycle.endedAt) {
        continue;
      }
      this.finalizeSftpLifecycle(
        endpointId,
        "closed",
        SHUTDOWN_SFTP_DISCONNECT_REASON,
      );
    }
  }

  private finalizeActiveContainerLifecyclesOnShutdown(): void {
    for (const lifecycle of this.containerLifecycleByScopeId.values()) {
      if (lifecycle.endedAt) {
        continue;
      }
      this.finalizeContainerLifecycle(
        lifecycle.scopeId,
        lifecycle.lifecycleId,
        "closed",
        SHUTDOWN_CONTAINERS_DISCONNECT_REASON,
      );
    }
  }

  private async finalizeActivePortForwardsAsStopped(): Promise<void> {
    const activeRuntimes = this.listPortForwardRuntimes().filter(
      (runtime) =>
        runtime.status === "starting" || runtime.status === "running",
    );
    if (activeRuntimes.length === 0) {
      return;
    }

    const finalizedAt = new Date().toISOString();
    for (const runtime of activeRuntimes) {
      const stoppedRuntime: PortForwardRuntimeRecord = {
        ...runtime,
        status: "stopped",
        updatedAt: finalizedAt,
        message: undefined,
      };
      this.portForwardRuntimes.set(runtime.ruleId, stoppedRuntime);
      const event: PortForwardRuntimeEvent = { runtime: stoppedRuntime };
      this.broadcastPortForwardEvent(event);
      await this.onPortForwardEvent?.(event);
    }
  }

  async start(): Promise<void> {
    // 이미 실행 중이면 중복 spawn을 막고 기존 프로세스를 재사용한다.
    if (this.process) {
      return;
    }

    const launchConfig = resolveCoreLaunchConfig();
    const childEnv = await this.buildChildEnv();

    this.process = spawn(launchConfig.command, launchConfig.args, {
      cwd: launchConfig.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      windowsHide: true,
    });

    // stdout은 control + raw stream이 섞인 framed binary 채널이다.
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk);
    });

    // stderr는 운영 중 진단 메시지를 위해 별도 error 이벤트로 내린다.
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.broadcastTerminalEvent({
        type: "error",
        payload: {
          message: chunk.trim() || "SSH core error",
        },
      });
    });

    this.process.on("exit", (code, signal) => {
      const message = `SSH core exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      if (!this.isShuttingDown) {
        for (const sessionId of this.tabs.keys()) {
          this.broadcastTerminalEvent({
            type: "closed",
            sessionId,
            payload: {
              message,
            },
          });
        }
        for (const [jobId, existing] of this.transferJobs.entries()) {
          this.broadcastTransferEvent({
            job: {
              ...existing,
              status: "failed",
              updatedAt: new Date().toISOString(),
              errorMessage: message,
            },
          });
        }
        for (const runtime of this.portForwardRuntimes.values()) {
          this.broadcastPortForwardEvent({
            runtime: {
              ...runtime,
              status: "error",
              updatedAt: new Date().toISOString(),
              message,
            },
          });
        }
        this.broadcastTerminalEvent({
          type: "status",
          payload: {
            status: "stopped",
            message,
          },
        });
      }
      this.rejectAllPending(message);
      this.rejectAllPendingSessionReady(message);
      this.clearRuntimeState();
      this.process = null;
      this.isShuttingDown = false;
    });
  }

  private async startCoreSession(
    payload: CoreSessionConnectPayload,
    options: {
      awaitReady?: boolean;
      suppressReadyFailureEvent?: boolean;
    } = {},
  ): Promise<{ sessionId: string; ready?: Promise<void> }> {
    await this.start();
    // 세션 ID는 Electron 쪽에서 먼저 발급해서 탭과 SSH 세션을 동일한 식별자로 묶는다.
    const sessionId = randomUUID();
    this.assignCurrentSessionOwner(sessionId);
    const startupCommand = this.normalizeStartupCommand(payload.startupCommand);
    if (startupCommand) {
      this.pendingStartupCommandsBySessionId.set(sessionId, startupCommand);
    }
    // mosh는 SSH 호스트의 옵션이라 transport는 "ssh"로 오지만, useMosh면 mosh로 표기해
    // 라우팅(autocomplete 차단 등)·라벨·하단 상태바가 mosh 경로를 타게 한다.
    const transport: SessionTransport = payload.useMosh
      ? "mosh"
      : payload.transport ?? "ssh";
    this.sessionTransportById.set(sessionId, transport);
    if (payload.tmux === true) {
      // control 세션(tmux -CC). 세션 녹화 제외 판정에 쓴다(transport 는 "ssh"라 구분 불가).
      this.tmuxControlSessionIds.add(sessionId);
    }
    this.sessionLifecycleById.set(sessionId, {
      hostId: payload.hostId,
      hostLabel: payload.hostLabel,
      title: payload.title,
      connectionDetails:
        payload.connectionDetails ??
        `${payload.host} · ${payload.port} · ${payload.username}`,
      connectionKind:
        payload.connectionKind ??
        (payload.useMosh
          ? "mosh"
          : payload.transport === "warpgate"
            ? "warpgate"
            : payload.transport === "aws-ssm"
              ? "aws-ssm"
              : "ssh"),
      connectedAt: null,
      disconnectedAt: null,
      disconnectReason: null,
      status: null,
      recordingId: null,
      hasReplay: false,
    });
    this.tabs.set(sessionId, {
      id: sessionId,
      stableId: sessionId,
      title: payload.title,
      source: "host",
      hostId: payload.hostId,
      sessionId,
      status: "connecting",
      lastEventAt: new Date().toISOString(),
    });
    const ready = options.awaitReady
      ? new Promise<void>((resolve, reject) => {
          this.pendingSessionReadyWaiters.set(sessionId, {
            resolve,
            reject,
            suppressFailureEvent: options.suppressReadyFailureEvent === true,
            settled: false,
          });
        })
      : undefined;
    const {
      startupCommand: _startupCommand,
      tmux: useTmux,
      connectionKind: _connectionKind,
      connectionDetails: _connectionDetails,
      ...corePayload
    } = payload;
    this.sendControl<ResolvedCoreConnectPayload>({
      id: randomUUID(),
      type: useTmux ? "tmuxConnect" : "connect",
      sessionId,
      payload: corePayload,
    });
    return { sessionId, ready };
  }

  async connect(payload: CoreSessionConnectPayload): Promise<{ sessionId: string }> {
    const { sessionId } = await this.startCoreSession(payload);
    return { sessionId };
  }

  async connectAndAwaitReady(
    payload: CoreSessionConnectPayload,
  ): Promise<{ sessionId: string }> {
    const { sessionId, ready } = await this.startCoreSession(payload, {
      awaitReady: true,
      suppressReadyFailureEvent: true,
    });
    await ready;
    this.replayConnectedEventSoon(sessionId);
    return { sessionId };
  }

  private replayConnectedEventSoon(sessionId: string): void {
    const timer = setTimeout(() => {
      if (!this.tabs.has(sessionId)) {
        return;
      }
      this.handleControlEvent({
        type: "connected",
        sessionId,
        payload: { status: "connected" },
      });
    }, 25);
    timer.unref?.();
  }

  beginContainerLifecycle(input: {
    scopeId: string;
    hostId: string;
    hostLabel: string;
    workspaceKind: ContainerWorkspaceKind;
    transport: ContainerLifecycleTransport;
  }): { lifecycleId: string } {
    const current = this.containerLifecycleByScopeId.get(input.scopeId);
    if (current && !current.endedAt) {
      current.hostId = input.hostId;
      current.hostLabel = input.hostLabel;
      current.workspaceKind = input.workspaceKind;
      current.transport = input.transport;
      this.containerLifecycleByScopeId.set(input.scopeId, current);
      this.upsertContainerLifecycleLog(current);
      return { lifecycleId: current.lifecycleId };
    }

    const lifecycle: ContainerLifecycleState = {
      lifecycleId: randomUUID(),
      scopeId: input.scopeId,
      hostId: input.hostId,
      hostLabel: input.hostLabel,
      workspaceKind: input.workspaceKind,
      transport: input.transport,
      runtime: null,
      startedAt: new Date().toISOString(),
      connectedAt: null,
      endedAt: null,
      status: "connecting",
      refreshCount: 0,
      errorCount: 0,
      resourceCount: null,
      lastError: null,
      endReason: null,
    };
    this.containerLifecycleByScopeId.set(input.scopeId, lifecycle);
    this.upsertContainerLifecycleLog(lifecycle);
    return { lifecycleId: lifecycle.lifecycleId };
  }

  noteContainerLifecycleLoadStarted(
    scopeId: string,
    lifecycleId: string,
  ): void {
    const lifecycle = this.getActiveContainerLifecycle(scopeId, lifecycleId);
    if (!lifecycle) {
      return;
    }
    if (lifecycle.status === "connected") {
      lifecycle.refreshCount += 1;
      this.containerLifecycleByScopeId.set(scopeId, lifecycle);
      this.upsertContainerLifecycleLog(lifecycle);
    }
  }

  markContainerLifecycleConnected(input: {
    scopeId: string;
    lifecycleId: string;
    runtime?: HostContainerRuntime | null;
    resourceCount?: number | null;
  }): void {
    const lifecycle = this.getActiveContainerLifecycle(
      input.scopeId,
      input.lifecycleId,
    );
    if (!lifecycle) {
      return;
    }
    lifecycle.status = "connected";
    lifecycle.connectedAt ??= new Date().toISOString();
    lifecycle.runtime = input.runtime ?? lifecycle.runtime;
    lifecycle.resourceCount = input.resourceCount ?? lifecycle.resourceCount;
    lifecycle.lastError = null;
    lifecycle.endReason = null;
    this.containerLifecycleByScopeId.set(input.scopeId, lifecycle);
    this.upsertContainerLifecycleLog(lifecycle);
  }

  markContainerLifecycleUnsupported(input: {
    scopeId: string;
    lifecycleId: string;
    reason: string;
  }): void {
    this.finalizeContainerLifecycle(
      input.scopeId,
      input.lifecycleId,
      "unsupported",
      input.reason,
    );
  }

  reportContainerLifecycleError(input: {
    lifecycleId: string;
    message: string;
  }): void {
    const matched = Array.from(this.containerLifecycleByScopeId.values()).find(
      (lifecycle) => lifecycle.lifecycleId === input.lifecycleId,
    );
    if (!matched || matched.endedAt) {
      return;
    }
    if (matched.status === "connected") {
      matched.errorCount += 1;
      matched.lastError = input.message;
      this.containerLifecycleByScopeId.set(matched.scopeId, matched);
      this.upsertContainerLifecycleLog(matched);
      return;
    }
    this.finalizeContainerLifecycle(
      matched.scopeId,
      matched.lifecycleId,
      "error",
      input.message,
    );
  }

  finalizeContainerLifecycleForScope(
    scopeId: string,
    lifecycleId?: string,
    reason: string | null = null,
  ): void {
    const lifecycle = this.containerLifecycleByScopeId.get(scopeId);
    if (!lifecycle || lifecycle.endedAt) {
      return;
    }
    if (lifecycleId && lifecycle.lifecycleId !== lifecycleId) {
      return;
    }
    this.finalizeContainerLifecycle(
      scopeId,
      lifecycle.lifecycleId,
      "closed",
      reason,
    );
  }

  failContainerLifecycleForScope(scopeId: string, reason: string): void {
    const lifecycle = this.containerLifecycleByScopeId.get(scopeId);
    if (!lifecycle || lifecycle.endedAt) {
      return;
    }
    this.finalizeContainerLifecycle(
      scopeId,
      lifecycle.lifecycleId,
      "error",
      reason,
    );
  }

  getContainerLifecycleId(scopeId: string): string | null {
    const lifecycle = this.containerLifecycleByScopeId.get(scopeId);
    return lifecycle && !lifecycle.endedAt ? lifecycle.lifecycleId : null;
  }

  async containersConnect(
    payload: ResolvedContainersConnectPayload & {
      endpointId: string;
      hostId: string;
    },
  ): Promise<{
    runtime: HostContainerRuntime | null;
    runtimeCommand: string | null;
    unsupportedReason: string | null;
  }> {
    await this.start();
    const { endpointId, hostId, ...connectPayload } = payload;
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "containersConnect",
        endpointId,
        payload: connectPayload,
      },
      ["containersConnected"],
      { timeoutMs: 120000 },
    );
    const runtime =
      response.runtime === "docker" || response.runtime === "podman"
        ? (response.runtime as HostContainerRuntime)
        : null;
    const unsupportedReason =
      typeof response.unsupportedReason === "string"
        ? response.unsupportedReason
        : null;
    const runtimeCommand =
      typeof response.runtimeCommand === "string" &&
      response.runtimeCommand.trim()
        ? response.runtimeCommand
        : null;
    this.containerEndpoints.set(endpointId, {
      hostId,
      runtime,
      runtimeCommand,
      unsupportedReason,
    });
    const subscribers = this.containerSubscriberIdsByEndpoint.get(endpointId);
    if (subscribers && subscribers.size === 0) {
      await this.containersDisconnect(endpointId).catch(() => undefined);
      throw new Error("Container 탭을 연 창이 모두 닫혔습니다.");
    }
    return { runtime, runtimeCommand, unsupportedReason };
  }

  async containersDisconnect(endpointId: string): Promise<void> {
    this.containerEndpoints.delete(endpointId);
    this.containerNamesByEndpointId.delete(endpointId);
    if (!this.process) {
      return;
    }
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "containersDisconnect",
        endpointId,
        payload: {},
      },
      ["containersDisconnected"],
    );
  }

  async containersList(endpointId: string): Promise<HostContainerListResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "containersList",
        endpointId,
        payload: {},
      },
      ["containersListed"],
      { timeoutMs: 25000 },
    );
    const runtime =
      response.runtime === "docker" || response.runtime === "podman"
        ? (response.runtime as HostContainerRuntime)
        : null;
    const containers = Array.isArray(response.containers)
      ? response.containers.map((item) => {
          const candidate = item as Record<string, unknown>;
          return {
            id: String(candidate.id ?? ""),
            name: String(candidate.name ?? ""),
            runtime:
              candidate.runtime === "docker" || candidate.runtime === "podman"
                ? (candidate.runtime as HostContainerRuntime)
                : "docker",
            image: String(candidate.image ?? ""),
            status: String(candidate.status ?? ""),
            createdAt: String(candidate.createdAt ?? ""),
            ports: String(candidate.ports ?? ""),
          };
        })
      : [];
    this.containerNamesByEndpointId.set(
      endpointId,
      new Map(
        containers.map((container) => [
          container.id,
          container.name.trim() || container.id,
        ]),
      ),
    );
    return {
      hostId: this.containerEndpoints.get(endpointId)?.hostId ?? "",
      runtime,
      containers,
    };
  }

  async containersInspect(
    endpointId: string,
    containerId: string,
  ): Promise<HostContainerDetails> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "containersInspect",
        endpointId,
        payload: { containerId },
      },
      ["containersInspected"],
      { timeoutMs: 25000 },
    );
    return {
      id: String(response.id ?? ""),
      name: String(response.name ?? ""),
      runtime:
        response.runtime === "docker" || response.runtime === "podman"
          ? (response.runtime as HostContainerRuntime)
          : "docker",
      image: String(response.image ?? ""),
      status: String(response.status ?? ""),
      createdAt: String(response.createdAt ?? ""),
      command: String(response.command ?? ""),
      entrypoint: String(response.entrypoint ?? ""),
      mounts: Array.isArray(response.mounts)
        ? response.mounts.map((mount) => {
            const candidate = mount as Record<string, unknown>;
            return {
              type: String(candidate.type ?? ""),
              source: String(candidate.source ?? ""),
              destination: String(candidate.destination ?? ""),
              mode: String(candidate.mode ?? ""),
              readOnly: Boolean(candidate.readOnly),
            };
          })
        : [],
      networks: Array.isArray(response.networks)
        ? response.networks.map((network) => {
            const candidate = network as Record<string, unknown>;
            return {
              name: String(candidate.name ?? ""),
              ipAddress: String(candidate.ipAddress ?? ""),
              aliases: Array.isArray(candidate.aliases)
                ? candidate.aliases.map((alias) => String(alias))
                : [],
            };
          })
        : [],
      ports: Array.isArray(response.ports)
        ? response.ports.map((port) => {
            const candidate = port as Record<string, unknown>;
            return {
              containerPort: Number(candidate.containerPort ?? 0),
              protocol: String(candidate.protocol ?? ""),
              publishedBindings: Array.isArray(candidate.publishedBindings)
                ? candidate.publishedBindings.map((binding) => {
                    const bindingRecord = binding as Record<string, unknown>;
                    const hostPort =
                      typeof bindingRecord.hostPort === "number" &&
                      Number.isFinite(bindingRecord.hostPort)
                        ? bindingRecord.hostPort
                        : null;
                    return {
                      hostIp:
                        bindingRecord.hostIp == null
                          ? null
                          : String(bindingRecord.hostIp),
                      hostPort,
                    };
                  })
                : [],
            };
          })
        : [],
      environment: Array.isArray(response.environment)
        ? response.environment.map((entry) => {
            const candidate = entry as Record<string, unknown>;
            return {
              key: String(candidate.key ?? ""),
              value: String(candidate.value ?? ""),
            };
          })
        : [],
      labels: Array.isArray(response.labels)
        ? response.labels.map((entry) => {
            const candidate = entry as Record<string, unknown>;
            return {
              key: String(candidate.key ?? ""),
              value: String(candidate.value ?? ""),
            };
          })
        : [],
    };
  }

  async containersLogs(
    endpointId: string,
    containerId: string,
    tail: number,
    followCursor?: string | null,
    startTime?: string | null,
    endTime?: string | null,
  ): Promise<HostContainerLogsSnapshot> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "containersLogs",
        endpointId,
        payload: {
          containerId,
          tail,
          followCursor: followCursor ?? null,
          startTime: startTime ?? null,
          endTime: endTime ?? null,
        },
      },
      ["containersLogs"],
      { timeoutMs: 25000 },
    );
    if (!Array.isArray(response.lines)) {
      throw new Error("Invalid containersLogs response: lines must be string[]");
    }
    if (response.lines.some((line) => typeof line !== "string")) {
      throw new Error("Invalid containersLogs response: lines must be string[]");
    }
    if (
      response.cursor != null &&
      typeof response.cursor !== "string"
    ) {
      throw new Error("Invalid containersLogs response: cursor must be string");
    }
    return {
      hostId: this.containerEndpoints.get(endpointId)?.hostId ?? "",
      runtime:
        response.runtime === "docker" || response.runtime === "podman"
          ? (response.runtime as HostContainerRuntime)
          : "docker",
      containerId: String(response.containerId ?? containerId),
      lines: response.lines,
      cursor:
        typeof response.cursor === "string" && response.cursor.trim()
          ? response.cursor
          : null,
    };
  }

  async containersStart(endpointId: string, containerId: string): Promise<void> {
    await this.runContainerAction(endpointId, "containersStart", containerId);
  }

  async containersStop(endpointId: string, containerId: string): Promise<void> {
    await this.runContainerAction(endpointId, "containersStop", containerId);
  }

  async containersRestart(endpointId: string, containerId: string): Promise<void> {
    await this.runContainerAction(endpointId, "containersRestart", containerId);
  }

  async containersRemove(endpointId: string, containerId: string): Promise<void> {
    await this.runContainerAction(endpointId, "containersRemove", containerId);
  }

  private async runContainerAction(
    endpointId: string,
    type: "containersStart" | "containersStop" | "containersRestart" | "containersRemove",
    containerId: string,
  ): Promise<void> {
    const action = this.resolveContainerAction(type);
    const actionId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      await this.start();
      await this.requestResponse<Record<string, unknown>>(
        {
          id: randomUUID(),
          type,
          endpointId,
          payload: { containerId },
        },
        ["containersActionCompleted"],
        { timeoutMs: 25000 },
      );
      this.recordContainerActionLog({
        actionId,
        endpointId,
        containerId,
        action,
        startedAt,
        status: "success",
        errorMessage: null,
      });
    } catch (error) {
      this.recordContainerActionLog({
        actionId,
        endpointId,
        containerId,
        action,
        startedAt,
        status: "error",
        errorMessage: toErrorMessage(error),
      });
      throw error;
    }
  }

  async containersStats(
    endpointId: string,
    containerId: string,
  ): Promise<HostContainerStatsSample> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "containersStats",
        endpointId,
        payload: { containerId },
      },
      ["containersStats"],
      { timeoutMs: 25000 },
    );
    return {
      hostId: this.containerEndpoints.get(endpointId)?.hostId ?? "",
      containerId: String(response.containerId ?? containerId),
      runtime:
        response.runtime === "docker" || response.runtime === "podman"
          ? (response.runtime as HostContainerRuntime)
          : "docker",
      recordedAt: String(response.recordedAt ?? new Date().toISOString()),
      cpuPercent: Number(response.cpuPercent ?? 0),
      memoryUsedBytes: Number(response.memoryUsedBytes ?? 0),
      memoryLimitBytes: Number(response.memoryLimitBytes ?? 0),
      memoryPercent: Number(response.memoryPercent ?? 0),
      networkRxBytes: Number(response.networkRxBytes ?? 0),
      networkTxBytes: Number(response.networkTxBytes ?? 0),
      blockReadBytes: Number(response.blockReadBytes ?? 0),
      blockWriteBytes: Number(response.blockWriteBytes ?? 0),
    };
  }

  async containersSearchLogs(
    endpointId: string,
    containerId: string,
    tail: number,
    query: string,
    startTime?: string | null,
    endTime?: string | null,
  ): Promise<HostContainerLogSearchResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "containersSearchLogs",
        endpointId,
        payload: {
          containerId,
          tail,
          query,
          startTime: startTime ?? null,
          endTime: endTime ?? null,
        },
      },
      ["containersLogsSearched"],
      { timeoutMs: 25000 },
    );
    if (!Array.isArray(response.lines) || response.lines.some((line) => typeof line !== "string")) {
      throw new Error("Invalid containersSearchLogs response: lines must be string[]");
    }
    return {
      hostId: this.containerEndpoints.get(endpointId)?.hostId ?? "",
      containerId: String(response.containerId ?? containerId),
      runtime:
        response.runtime === "docker" || response.runtime === "podman"
          ? (response.runtime as HostContainerRuntime)
          : "docker",
      query: String(response.query ?? query),
      lines: response.lines,
      matchCount: Number(response.matchCount ?? response.lines.length),
    };
  }

  getContainersEndpointRuntime(
    endpointId: string,
  ): ContainersEndpointRuntime | null {
    return this.containerEndpoints.get(endpointId) ?? null;
  }

  async connectAwsSession(payload: {
    profileName: string;
    region: string;
    instanceId: string;
    cols: number;
    rows: number;
    title: string;
    hostId: string;
    hostLabel: string;
    env?: Record<string, string>;
    unsetEnv?: string[];
    startupCommand?: string;
    ssmSession?: { sessionId: string; streamUrl: string; tokenValue: string };
    connectionKind?: "aws-ssm" | "aws-ecs-exec";
    connectionDetails?: string;
  }): Promise<{ sessionId: string }> {
    await this.start();
    const sessionId = randomUUID();
    this.assignCurrentSessionOwner(sessionId);
    const startupCommand = this.normalizeStartupCommand(payload.startupCommand);
    if (startupCommand) {
      this.pendingStartupCommandsBySessionId.set(sessionId, startupCommand);
    }
    this.sessionTransportById.set(sessionId, "aws-ssm");
    this.sessionLifecycleById.set(sessionId, {
      hostId: payload.hostId,
      hostLabel: payload.hostLabel,
      title: payload.title,
      connectionDetails:
        payload.connectionDetails ??
        `${payload.profileName} · ${payload.region} · ${payload.instanceId}`,
      connectionKind: payload.connectionKind ?? "aws-ssm",
      connectedAt: null,
      disconnectedAt: null,
      disconnectReason: null,
      status: null,
      recordingId: null,
      hasReplay: false,
    });
    const tab: TerminalTab = {
      id: sessionId,
      stableId: sessionId,
      title: payload.title,
      source: "host",
      hostId: payload.hostId,
      sessionId,
      status: "connecting",
      lastEventAt: new Date().toISOString(),
    };
    this.tabs.set(sessionId, tab);

    const resolvedPayload: ResolvedAwsConnectPayload = {
      profileName: payload.profileName,
      region: payload.region,
      instanceId: payload.instanceId,
      cols: payload.cols,
      rows: payload.rows,
      env: payload.env,
      unsetEnv: payload.unsetEnv,
      streamUrl: payload.ssmSession?.streamUrl,
      tokenValue: payload.ssmSession?.tokenValue,
      ssmSessionId: payload.ssmSession?.sessionId,
    };
    this.sendControl<ResolvedAwsConnectPayload>({
      id: randomUUID(),
      type: "awsConnect",
      sessionId,
      payload: resolvedPayload,
    });

    return { sessionId };
  }

  async connectAwsServerProxySession(payload: {
    serverUrl: string;
    accessToken: string;
    profileName: string;
    region: string;
    instanceId: string;
    cols: number;
    rows: number;
    title: string;
    hostId: string;
    hostLabel: string;
    env?: Record<string, string>;
    unsetEnv?: string[];
    startupCommand?: string;
  }): Promise<{ sessionId: string }> {
    const sessionId = randomUUID();
    const ownerWebContentsId = this.sessionOwnerStorage.getStore();
    const startupCommand = this.normalizeStartupCommand(payload.startupCommand);
    if (startupCommand) {
      this.pendingStartupCommandsBySessionId.set(sessionId, startupCommand);
    }
    const wsUrl = this.buildAwsServerProxyUrl(payload.serverUrl, payload.accessToken);
    const socket = new WebSocket(wsUrl);

    return new Promise<{ sessionId: string }>((resolve, reject) => {
      let settled = false;
      const openTimeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearPendingStartupCommand(sessionId);
        try {
          socket.close();
        } catch {
          // ignore close failures during startup timeout
        }
        reject(new Error("서버 AWS SSM 프록시 연결 시간이 초과되었습니다."));
      }, 8_000);

      socket.onopen = () => {
        if (settled) {
          return;
        }
        if (
          ownerWebContentsId !== undefined &&
          !this.windowsByWebContentsId.has(ownerWebContentsId)
        ) {
          settled = true;
          clearTimeout(openTimeout);
          this.clearPendingStartupCommand(sessionId);
          socket.close();
          reject(new Error("연결을 요청한 창이 닫혔습니다."));
          return;
        }
        settled = true;
        clearTimeout(openTimeout);

        this.assignSessionOwner(sessionId, ownerWebContentsId);

        this.sessionTransportById.set(sessionId, "aws-ssm-server-proxy");
        this.sessionLifecycleById.set(sessionId, {
          hostId: payload.hostId,
          hostLabel: payload.hostLabel,
          title: payload.title,
          connectionDetails: `${payload.profileName} · ${payload.region} · ${payload.instanceId}`,
          connectionKind: "aws-ssm",
          connectedAt: null,
          disconnectedAt: null,
          disconnectReason: null,
          status: null,
          recordingId: null,
          hasReplay: false,
        });
        this.tabs.set(sessionId, {
          id: sessionId,
          stableId: sessionId,
          title: payload.title,
          source: "host",
          hostId: payload.hostId,
          sessionId,
          status: "connecting",
          lastEventAt: new Date().toISOString(),
        });
        this.awsServerProxySessions.set(sessionId, {
          socket,
          finalized: false,
          errorEmitted: false,
        });

        this.sendAwsServerProxyMessage(sessionId, {
          type: "start",
          payload: {
            hostId: payload.hostId,
            label: payload.hostLabel,
            profileName: "",
            region: payload.region,
            instanceId: payload.instanceId,
            cols: payload.cols,
            rows: payload.rows,
            env: payload.env,
            unsetEnv: payload.unsetEnv,
          } satisfies AwsServerProxyStartPayload,
        });
        resolve({ sessionId });
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(openTimeout);
          this.clearPendingStartupCommand(sessionId);
          reject(new Error("서버 AWS SSM 프록시 연결에 실패했습니다."));
          return;
        }
        this.emitAwsServerProxyEvent(
          sessionId,
          "error",
          "서버 AWS SSM 프록시 연결에 실패했습니다.",
        );
      };

      socket.onmessage = (event) => {
        this.handleAwsServerProxyMessage(sessionId, event.data);
      };

      socket.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(openTimeout);
          this.clearPendingStartupCommand(sessionId);
          reject(new Error("서버 AWS SSM 프록시 연결이 종료되었습니다."));
          return;
        }
        this.handleAwsServerProxySocketClosed(sessionId);
      };
    });
  }

  private buildAwsServerProxyUrl(serverUrl: string, accessToken: string): string {
    const url = new URL("/api/aws-sessions/ws", serverUrl);
    url.searchParams.set("access_token", accessToken);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private sendAwsServerProxyMessage(
    sessionId: string,
    message: Record<string, unknown>,
  ): boolean {
    const runtime = this.awsServerProxySessions.get(sessionId);
    if (!runtime || runtime.finalized || runtime.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    runtime.socket.send(JSON.stringify(message));
    return true;
  }

  private handleAwsServerProxyMessage(sessionId: string, rawData: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(rawData)) as Record<string, unknown>;
    } catch {
      this.emitAwsServerProxyEvent(
        sessionId,
        "error",
        "서버 AWS SSM 프록시 응답을 해석하지 못했습니다.",
      );
      return;
    }

    const type = typeof message.type === "string" ? message.type : "";
    if (type === "ready") {
      this.emitAwsServerProxyEvent(sessionId, "connected", "");
      return;
    }

    // 서버 프록시 SSM 세션의 keepalive RTT — 직결 세션과 동일한 latency 이벤트로
    // 흘려보내 탭 지연 인디케이터를 갱신한다.
    if (type === "latency") {
      const payload =
        message.payload && typeof message.payload === "object"
          ? (message.payload as Record<string, unknown>)
          : {};
      this.handleControlEvent({ type: "latency", sessionId, payload });
      return;
    }

    if (type === "output") {
      const dataBase64 = typeof message.dataBase64 === "string" ? message.dataBase64 : "";
      if (!dataBase64) {
        return;
      }
      try {
        this.broadcastStream(
          {
            type: "data",
            sessionId,
          },
          Uint8Array.from(Buffer.from(dataBase64, "base64")),
        );
      } catch {
        this.emitAwsServerProxyEvent(
          sessionId,
          "error",
          "서버 AWS SSM 프록시 출력 데이터를 해석하지 못했습니다.",
        );
      }
      return;
    }

    if (
      type === "autocompleteCapability" ||
      type === "autocompleteSnapshot" ||
      type === "autocompleteShellState"
    ) {
      const requestId =
        typeof message.requestId === "string" ? message.requestId : undefined;
      const payload =
        message.payload && typeof message.payload === "object"
          ? (message.payload as Record<string, unknown>)
          : {};
      const eventType =
        type === "autocompleteCapability"
          ? "terminalAutocompleteCapability"
          : type === "autocompleteSnapshot"
            ? "terminalAutocompleteSnapshot"
            : "terminalAutocompleteShellState";
      this.handleControlEvent({
        type: eventType,
        requestId,
        sessionId,
        payload,
      });
      if (type === "autocompleteCapability" && requestId) {
        const pending = this.pendingAwsAutocompleteResponses.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingAwsAutocompleteResponses.delete(requestId);
          pending.resolve();
        }
      }
      return;
    }

    if (type === "error") {
      const runtime = this.awsServerProxySessions.get(sessionId);
      if (runtime) {
        runtime.errorEmitted = true;
      }
      this.emitAwsServerProxyEvent(
        sessionId,
        "error",
        typeof message.message === "string"
          ? message.message
          : "서버 AWS SSM 프록시 오류가 발생했습니다.",
      );
      return;
    }

    if (type === "exit") {
      const runtime = this.awsServerProxySessions.get(sessionId);
      if (runtime) {
        runtime.finalized = true;
        this.awsServerProxySessions.delete(sessionId);
      }
      this.emitAwsServerProxyEvent(
        sessionId,
        "closed",
        typeof message.message === "string" ? message.message : "AWS SSM 세션이 종료되었습니다.",
      );
    }
  }

  private handleAwsServerProxySocketClosed(sessionId: string): void {
    const runtime = this.awsServerProxySessions.get(sessionId);
    if (!runtime || runtime.finalized) {
      return;
    }
    runtime.finalized = true;
    this.awsServerProxySessions.delete(sessionId);
    this.rejectPendingAwsAutocomplete(sessionId);

    if (runtime.errorEmitted) {
      return;
    }
    // 의도치 않은 웹소켓 단절(의도적 종료는 finalized 가드로 위에서 걸러짐).
    this.emitAwsServerProxyEvent(
      sessionId,
      "closed",
      "서버 AWS SSM 프록시 연결이 종료되었습니다.",
      "transport",
    );
  }

  private closeAwsServerProxySession(sessionId: string, message: string): void {
    const runtime = this.awsServerProxySessions.get(sessionId);
    if (runtime && !runtime.finalized) {
      this.sendAwsServerProxyMessage(sessionId, { type: "close" });
      runtime.finalized = true;
      try {
        runtime.socket.close();
      } catch {
        // ignore close failures
      }
    }
    this.awsServerProxySessions.delete(sessionId);
    this.rejectPendingAwsAutocomplete(sessionId);
    this.emitAwsServerProxyEvent(sessionId, "closed", message, "client");
  }

  private rejectPendingAwsAutocomplete(sessionId: string): void {
    for (const [requestId, pending] of this.pendingAwsAutocompleteResponses) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timeout);
      pending.reject(new Error("AWS SSM server proxy session closed"));
      this.pendingAwsAutocompleteResponses.delete(requestId);
    }
  }

  // reason은 ssh 경로의 ClosedPayload.Reason과 같은 재연결 판별 구분자다.
  // 프록시 이벤트는 여기서 직접 만들므로 클라이언트가 아는 종료 유형("client",
  // "transport")을 명시해, 렌더러가 사용자 닫기를 드롭으로 오인해 자동
  // 재연결하지 않게 한다.
  private emitAwsServerProxyEvent(
    sessionId: string,
    type: Extract<CoreEventType, "connected" | "error" | "closed">,
    message: string,
    reason?: "client" | "transport",
  ): void {
    this.handleControlEvent({
      type,
      sessionId,
      payload: reason ? { message, reason } : { message },
    });
  }

  async connectLocalSession(payload: {
    cols: number;
    rows: number;
    title: string;
    shellKind?: string;
    executable?: string;
    args?: string[];
    env?: Record<string, string>;
    unsetEnv?: string[];
    workingDirectory?: string | null;
    lifecycle?: {
      hostId: string;
      hostLabel: string;
      connectionDetails?: string | null;
      connectionKind: Extract<
        SessionConnectionKind,
        "local" | "aws-ecs-exec"
      >;
    };
  }): Promise<{ sessionId: string }> {
    await this.start();
    const sessionId = randomUUID();
    this.assignCurrentSessionOwner(sessionId);
    this.sessionTransportById.set(sessionId, "local-shell");
    if (payload.lifecycle) {
      this.sessionLifecycleById.set(sessionId, {
        hostId: payload.lifecycle.hostId,
        hostLabel: payload.lifecycle.hostLabel,
        title: payload.title,
        connectionDetails: payload.lifecycle.connectionDetails ?? null,
        connectionKind: payload.lifecycle.connectionKind,
        connectedAt: null,
        disconnectedAt: null,
        disconnectReason: null,
        status: null,
        recordingId: null,
        hasReplay: false,
      });
    }
    this.tabs.set(sessionId, {
      id: sessionId,
      stableId: sessionId,
      title: payload.title,
      source: "local",
      hostId: null,
      shellKind: payload.shellKind?.trim() || undefined,
      sessionId,
      status: "connecting",
      lastEventAt: new Date().toISOString(),
    });
    this.sendControl<ResolvedLocalConnectPayload>({
      id: randomUUID(),
      type: "localConnect",
      sessionId,
      payload: {
        cols: payload.cols,
        rows: payload.rows,
        title: payload.title,
        shellKind: payload.shellKind?.trim() || undefined,
        executable: payload.executable?.trim() || undefined,
        args: payload.args?.filter((value) => value.trim().length > 0),
        env: payload.env,
        unsetEnv: payload.unsetEnv,
        workingDirectory: payload.workingDirectory?.trim() || undefined,
      },
    });
    return { sessionId };
  }

  async connectSerialSession(
    payload: ResolvedSerialConnectPayload & {
      title: string;
      hostId: string;
      hostLabel: string;
    },
  ): Promise<{ sessionId: string }> {
    await this.start();
    const sessionId = randomUUID();
    this.assignCurrentSessionOwner(sessionId);
    this.sessionTransportById.set(sessionId, "serial");
    const targetDescription =
      payload.transport === "local"
        ? payload.devicePath ?? "Local serial port"
        : `${payload.transport} · ${payload.host ?? ""}:${payload.port ?? ""}`.replace(/:$/, "");
    this.sessionLifecycleById.set(sessionId, {
      hostId: payload.hostId,
      hostLabel: payload.hostLabel,
      title: payload.title,
      connectionDetails: targetDescription,
      connectionKind: "serial",
      connectedAt: null,
      disconnectedAt: null,
      disconnectReason: null,
      status: null,
      recordingId: null,
      hasReplay: false,
    });
    this.tabs.set(sessionId, {
      id: sessionId,
      stableId: sessionId,
      title: payload.title,
      source: "host",
      hostId: payload.hostId,
      sessionId,
      status: "connecting",
      lastEventAt: new Date().toISOString(),
    });
    this.sendControl<ResolvedSerialConnectPayload>({
      id: randomUUID(),
      type: "serialConnect",
      sessionId,
      payload,
    });
    return { sessionId };
  }

  async listSerialPorts(): Promise<SerialPortSummary[]> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "serialListPorts",
        payload: {} satisfies ResolvedSerialListPortsPayload,
      },
      ["serialPortsListed"],
    );
    if (!Array.isArray(response.ports)) {
      return [];
    }
    return response.ports.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const candidate = entry as Record<string, unknown>;
      const pathValue = typeof candidate.path === "string" ? candidate.path : "";
      if (!pathValue) {
        return [];
      }
      return [{
        path: pathValue,
        displayName:
          typeof candidate.displayName === "string" && candidate.displayName.trim()
            ? candidate.displayName
            : pathValue,
        manufacturer:
          typeof candidate.manufacturer === "string"
            ? candidate.manufacturer
            : null,
      }];
    });
  }

  async controlSerialSession(
    sessionId: string,
    payload: ResolvedSerialControlPayload,
  ): Promise<ResolvedSerialControlResult> {
    await this.start();
    const tab = this.tabs.get(sessionId);
    if (!tab) {
      throw new Error("Serial session not found");
    }
    if (this.sessionTransportById.get(sessionId) !== "serial") {
      throw new Error("이 기능은 Serial 세션에서만 사용할 수 있습니다.");
    }

    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "serialControl",
        sessionId,
        payload,
      },
      ["serialControlCompleted"],
    );

    return {
      action:
        response.action === "break" ||
        response.action === "set-dtr" ||
        response.action === "set-rts"
          ? response.action
          : payload.action,
      enabled:
        typeof response.enabled === "boolean" ? response.enabled : payload.enabled,
    };
  }

  async probeHostKey(
    payload: ResolvedHostKeyProbePayload,
  ): Promise<HostKeyProbeResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "probeHostKey",
        payload,
      },
      ["hostKeyProbed"],
    );
    return {
      hostId: "",
      hostLabel: "",
      host: payload.host,
      port: payload.port,
      algorithm: String(response.algorithm ?? ""),
      publicKeyBase64: String(response.publicKeyBase64 ?? ""),
      fingerprintSha256: String(response.fingerprintSha256 ?? ""),
      status: "untrusted",
      existing: null,
    };
  }

  async inspectCertificate(
    certificateText: string,
  ): Promise<SshCertificateInfo> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "inspectCertificate",
        payload: {
          certificateText,
        } satisfies ResolvedCertificateInspectPayload,
      },
      ["certificateInspected"],
    );
    return {
      status:
        response.status === "expired" ||
        response.status === "not_yet_valid" ||
        response.status === "invalid"
          ? response.status
          : "valid",
      validAfter:
        typeof response.validAfter === "string" ? response.validAfter : null,
      validBefore:
        typeof response.validBefore === "string" ? response.validBefore : null,
      principals: Array.isArray(response.principals)
        ? response.principals.filter((value): value is string => typeof value === "string")
        : [],
      keyId: typeof response.keyId === "string" ? response.keyId : null,
      serial: typeof response.serial === "string" ? response.serial : null,
    };
  }

  async inspectPrivateKey(
    privateKeyPem: string,
    passphrase?: string,
  ): Promise<ResolvedPrivateKeyInspectResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "inspectPrivateKey",
        payload: {
          privateKeyPem,
          passphrase: passphrase || undefined,
        } satisfies ResolvedPrivateKeyInspectPayload,
      },
      ["privateKeyInspected"],
    );
    return {
      algorithm: String(response.algorithm ?? ""),
      publicKey: String(response.publicKey ?? ""),
      fingerprintSha256: String(response.fingerprintSha256 ?? ""),
    };
  }

  async generatePrivateKey(
    payload: ResolvedPrivateKeyGeneratePayload,
  ): Promise<ResolvedPrivateKeyGenerateResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "generatePrivateKey",
        payload,
      },
      ["privateKeyGenerated"],
    );
    return {
      algorithm: String(response.algorithm ?? ""),
      privateKeyPem: String(response.privateKeyPem ?? ""),
      publicKey: String(response.publicKey ?? ""),
      fingerprintSha256: String(response.fingerprintSha256 ?? ""),
      privateKeyEncrypted: response.privateKeyEncrypted === true,
      keyCurve:
        typeof response.keyCurve === "string" ? response.keyCurve : undefined,
      keyBits:
        typeof response.keyBits === "number" ? response.keyBits : undefined,
      privateKeyCipher:
        typeof response.privateKeyCipher === "string"
          ? response.privateKeyCipher
          : undefined,
      privateKeyKdfRounds:
        typeof response.privateKeyKdfRounds === "number"
          ? response.privateKeyKdfRounds
          : undefined,
    };
  }

  async installAuthorizedKey(
    payload: ResolvedAuthorizedKeyInstallPayload,
  ): Promise<ResolvedAuthorizedKeyInstallResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "installAuthorizedKey",
        payload,
      },
      ["authorizedKeyInstalled"],
      { timeoutMs: 30_000 },
    );
    return {
      status:
        response.status === "already-present" ? "already-present" : "installed",
    };
  }

  async startPortForward(
    payload: ResolvedPortForwardStartPayload & {
      ruleId: string;
      hostId: string;
      transport?: PortForwardTransport;
    },
  ): Promise<PortForwardRuntimeRecord> {
    await this.start();
    const baseRuntime: PortForwardRuntimeRecord = {
      ruleId: payload.ruleId,
      hostId: payload.hostId,
      transport: payload.transport ?? "ssh",
      mode: payload.mode,
      method: "ssh-native",
      bindAddress: payload.bindAddress,
      bindPort: payload.bindPort,
      status: "starting",
      updatedAt: new Date().toISOString(),
    };
    this.portForwardDefinitions.set(payload.ruleId, {
      ruleId: payload.ruleId,
      hostId: payload.hostId,
      transport: payload.transport ?? "ssh",
      backendTransport: "ssh",
      mode: payload.mode,
      bindAddress: payload.bindAddress,
      bindPort: payload.bindPort,
    });
    this.portForwardRuntimes.set(payload.ruleId, baseRuntime);
    this.broadcastPortForwardEvent({ runtime: baseRuntime });
    void this.onPortForwardEvent?.({ runtime: baseRuntime });
    try {
      const response = await this.requestResponse<Record<string, unknown>>(
        {
          id: randomUUID(),
          type: "portForwardStart",
          endpointId: payload.ruleId,
          payload,
        },
        ["portForwardStarted"],
      );

      const runtime = this.buildForwardRuntime(
        payload.ruleId,
        response,
        "running",
      );
      this.portForwardRuntimes.set(payload.ruleId, runtime);
      this.broadcastPortForwardEvent({ runtime });
      return runtime;
    } finally {
      if (payload.sourceEndpointId) {
        this.containerEndpoints.delete(payload.sourceEndpointId);
      }
    }
  }

  async startSsmPortForward(
    payload: ResolvedSsmPortForwardStartPayload & {
      ruleId: string;
      hostId: string;
      transport?: PortForwardTransport;
    },
  ): Promise<PortForwardRuntimeRecord> {
    await this.start();
    const baseRuntime: PortForwardRuntimeRecord = {
      ruleId: payload.ruleId,
      hostId: payload.hostId,
      transport: payload.transport ?? "aws-ssm",
      mode: "local",
      method: "ssm-remote-host",
      bindAddress: payload.bindAddress,
      bindPort: payload.bindPort,
      status: "starting",
      updatedAt: new Date().toISOString(),
    };
    this.portForwardDefinitions.set(payload.ruleId, {
      ruleId: payload.ruleId,
      hostId: payload.hostId,
      transport: payload.transport ?? "aws-ssm",
      backendTransport: "aws-ssm",
      mode: "local",
      bindAddress: payload.bindAddress,
      bindPort: payload.bindPort,
    });
    this.portForwardRuntimes.set(payload.ruleId, baseRuntime);
    this.broadcastPortForwardEvent({ runtime: baseRuntime });
    void this.onPortForwardEvent?.({ runtime: baseRuntime });

    const response = await this.sendSsmPortForwardStart(payload.ruleId, payload);

    const runtime = this.buildForwardRuntime(
      payload.ruleId,
      response,
      "running",
    );
    this.portForwardRuntimes.set(payload.ruleId, runtime);
    this.broadcastPortForwardEvent({ runtime });
    return runtime;
  }

  // Obtain an SSM data-channel token so ssh-core can open the WebSocket
  // itself. The issuer declines only in e2e-fake mode, where ssh-core
  // substitutes a fake runner instead of a real session.
  private async sendSsmPortForwardStart(
    ruleId: string,
    payload: ResolvedSsmPortForwardStartPayload,
  ): Promise<Record<string, unknown>> {
    const ssmSession = await this.issueSsmPortForwardToken?.(payload);
    const framePayload: ResolvedSsmPortForwardStartPayload = ssmSession
      ? {
          ...payload,
          streamUrl: ssmSession.streamUrl,
          tokenValue: ssmSession.tokenValue,
          ssmSessionId: ssmSession.sessionId,
        }
      : payload;

    return this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "ssmPortForwardStart",
        endpointId: ruleId,
        payload: framePayload,
      },
      ["portForwardStarted"],
    );
  }

  // Endpoint-scoped SSM tunnels (AWS SFTP, containers, container shells) share
  // the Go ssm-forward runtime with startSsmPortForward but skip the eager
  // definition/runtime registration and broadcasts. Asynchronous Go port-forward
  // events still flow through the common event routing, same as ECS tunnels.
  async startSsmTunnel(
    payload: ResolvedSsmPortForwardStartPayload & { ruleId: string },
  ): Promise<{ bindAddress: string; bindPort: number }> {
    await this.start();
    const response = await this.sendSsmPortForwardStart(payload.ruleId, payload);
    const bindAddress =
      typeof response.bindAddress === "string" && response.bindAddress
        ? response.bindAddress
        : payload.bindAddress;
    const bindPort =
      typeof response.bindPort === "number" && response.bindPort > 0
        ? response.bindPort
        : payload.bindPort;
    return { bindAddress, bindPort };
  }

  async stopSsmTunnel(ruleId: string): Promise<void> {
    if (!this.process) {
      return;
    }
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "ssmPortForwardStop",
        endpointId: ruleId,
        payload: {},
      },
      ["portForwardStopped"],
    );
  }

  async stopPortForward(ruleId: string): Promise<void> {
    if (!this.process) {
      this.portForwardDefinitions.delete(ruleId);
      this.portForwardRuntimes.delete(ruleId);
      return;
    }
    await this.start();
    const definition = this.portForwardDefinitions.get(ruleId);
    await this.requestResponse(
      {
        id: randomUUID(),
        type:
          definition?.backendTransport === "aws-ssm"
            ? "ssmPortForwardStop"
            : "portForwardStop",
        endpointId: ruleId,
        payload: {},
      },
      ["portForwardStopped"],
    );
    this.portForwardDefinitions.delete(ruleId);
    const runtime = this.portForwardRuntimes.get(ruleId);
    if (runtime) {
      this.portForwardRuntimes.set(ruleId, {
        ...runtime,
        status: "stopped",
        updatedAt: new Date().toISOString(),
        message: undefined,
      });
      this.broadcastPortForwardEvent({
        runtime: this.portForwardRuntimes.get(ruleId)!,
      });
    }
  }

  async sftpConnect(
    payload: ResolvedSftpConnectPayload & {
      endpointId: string;
      title: string;
      hostId: string;
    },
  ): Promise<SftpEndpointSummary> {
    this.assignCurrentSftpEndpointOwner(payload.endpointId);
    await this.start();
    const { endpointId, ...connectPayload } = payload;
    this.startSftpLifecycle(payload);
    try {
      const requestId = randomUUID();
      const response = await this.requestResponse<{
        path: string;
        sudoStatus?: string;
      }>(
        {
          id: requestId,
          type: "sftpConnect",
          endpointId,
          payload: connectPayload,
        },
        ["sftpConnected"],
      );

      const summary: SftpEndpointSummary = {
        id: endpointId,
        kind: "remote",
        hostId: payload.hostId,
        title: payload.title,
        path: String(response.path ?? "/"),
        connectedAt: new Date().toISOString(),
        sudoStatus:
          typeof response.sudoStatus === "string"
            ? normalizeSftpSudoStatus(response.sudoStatus)
            : "unknown",
      };
      this.sftpEndpoints.set(endpointId, summary);
      this.markSftpLifecycleConnected(summary);
      void this.cleanupSftpPartialRecordsForHost(payload.hostId, endpointId);
      return summary;
    } catch (error) {
      this.finalizeSftpLifecycle(endpointId, "error", toErrorMessage(error));
      throw error;
    }
  }

  async sftpDisconnect(endpointId: string): Promise<void> {
    if (!this.sftpEndpoints.has(endpointId)) {
      return;
    }
    await this.start();
    try {
      await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpDisconnect",
          endpointId,
          payload: {},
        },
        ["sftpDisconnected"],
      );
      this.sftpEndpoints.delete(endpointId);
      this.finalizeSftpLifecycle(endpointId, "closed", null);
      this.sftpEndpointOwnerById.delete(endpointId);
    } catch (error) {
      this.finalizeSftpLifecycle(endpointId, "error", toErrorMessage(error));
      throw error;
    }
  }

  async sftpList(input: SftpListInput): Promise<DirectoryListing> {
    await this.start();
    try {
      const response = await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpList",
          endpointId: input.endpointId,
          payload: {
            path: input.path,
          },
        },
        ["sftpListed"],
      );

      const listing = toDirectoryListing(response);
      const endpoint = this.sftpEndpoints.get(input.endpointId);
      if (endpoint) {
        this.sftpEndpoints.set(input.endpointId, {
          ...endpoint,
          path: listing.path,
        });
      }
      this.recordSftpLifecycleVisit(input.endpointId, listing.path);
      return listing;
    } catch (error) {
      this.recordSftpLifecycleError(input.endpointId, error, input.path);
      throw error;
    }
  }

  async sftpMkdir(input: SftpMkdirInput): Promise<void> {
    await this.start();
    try {
      await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpMkdir",
          endpointId: input.endpointId,
          payload: input,
        },
        ["sftpAck"],
      );
      this.incrementSftpLifecycle(
        input.endpointId,
        { mkdirCount: 1 },
        { path: path.posix.join(input.path, input.name) },
      );
    } catch (error) {
      this.recordSftpLifecycleError(input.endpointId, error, input.path);
      throw error;
    }
  }

  async sftpRename(input: SftpRenameInput): Promise<void> {
    await this.start();
    try {
      await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpRename",
          endpointId: input.endpointId,
          payload: input,
        },
        ["sftpAck"],
      );
      this.incrementSftpLifecycle(
        input.endpointId,
        { renameCount: 1 },
        { path: input.path },
      );
    } catch (error) {
      this.recordSftpLifecycleError(input.endpointId, error, input.path);
      throw error;
    }
  }

  async sftpChmod(input: SftpChmodInput): Promise<void> {
    await this.start();
    try {
      await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpChmod",
          endpointId: input.endpointId,
          payload: input,
        },
        ["sftpAck"],
      );
      this.incrementSftpLifecycle(
        input.endpointId,
        { chmodCount: 1 },
        { path: input.path },
      );
    } catch (error) {
      this.recordSftpLifecycleError(input.endpointId, error, input.path);
      throw error;
    }
  }

  async sftpChown(input: SftpChownInput): Promise<void> {
    await this.start();
    try {
      await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpChown",
          endpointId: input.endpointId,
          payload: input,
        },
        ["sftpAck"],
      );
      this.incrementSftpLifecycle(
        input.endpointId,
        { chownCount: 1 },
        { path: input.path },
      );
    } catch (error) {
      this.recordSftpLifecycleError(input.endpointId, error, input.path);
      throw error;
    }
  }

  async sftpListPrincipals(
    input: SftpListPrincipalsInput,
  ): Promise<SftpPrincipal[]> {
    await this.start();
    const response = await this.requestResponse(
      {
        id: randomUUID(),
        type: "sftpListPrincipals",
        endpointId: input.endpointId,
        payload: input,
      },
      ["sftpPrincipalsListed"],
    );
    return toSftpPrincipals(response);
  }

  async sftpDelete(input: SftpDeleteInput): Promise<void> {
    await this.start();
    try {
      await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpDelete",
          endpointId: input.endpointId,
          payload: input,
        },
        ["sftpAck"],
      );
      this.incrementSftpLifecycle(
        input.endpointId,
        { deleteCount: input.paths.length },
        { path: input.paths[0] ?? null },
      );
    } catch (error) {
      this.recordSftpLifecycleError(
        input.endpointId,
        error,
        input.paths[0] ?? null,
      );
      throw error;
    }
  }

  async sftpReadFile(input: SftpReadFileInput): Promise<SftpReadFileResult> {
    await this.start();
    try {
      const response = await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpReadFile",
          endpointId: input.endpointId,
          payload: { path: input.path },
        },
        ["sftpFileRead"],
        { timeoutMs: 30000 },
      );
      return toSftpFileRead(response);
    } catch (error) {
      this.recordSftpLifecycleError(input.endpointId, error, input.path);
      throw error;
    }
  }

  async sftpWriteFile(input: SftpWriteFileInput): Promise<void> {
    await this.start();
    try {
      await this.requestResponse(
        {
          id: randomUUID(),
          type: "sftpWriteFile",
          endpointId: input.endpointId,
          payload: input,
        },
        ["sftpAck"],
        { timeoutMs: 30000 },
      );
    } catch (error) {
      this.recordSftpLifecycleError(input.endpointId, error, input.path);
      throw error;
    }
  }

  async startSftpTransfer(input: TransferStartInput): Promise<TransferJob> {
    await this.start();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const job: TransferJob = {
      id: jobId,
      sourceLabel: this.describeTransferEndpoint(input.source),
      targetLabel: this.describeTransferEndpoint(input.target),
      itemCount: input.items.length,
      bytesTotal: input.items.reduce((sum, item) => sum + item.size, 0),
      bytesCompleted: 0,
      status: "queued",
      startedAt: now,
      updatedAt: now,
      request: input,
    };
    this.assignCurrentTransferOwner(jobId);
    this.transferJobs.set(jobId, job);
    this.broadcastTransferEvent({ job });
    this.sendControl({
      id: randomUUID(),
      type: "sftpTransferStart",
      jobId,
      payload: input,
    });
    return job;
  }

  async cancelSftpTransfer(jobId: string): Promise<void> {
    const existing = this.transferJobs.get(jobId);
    if (!existing) {
      return;
    }
    await this.start();
    if (
      existing.status !== "completed" &&
      existing.status !== "failed" &&
      existing.status !== "cancelled"
    ) {
      const nextJob: TransferJob = {
        ...existing,
        status: "cancelling",
        etaSeconds: null,
        updatedAt: new Date().toISOString(),
      };
      this.transferJobs.set(jobId, nextJob);
      this.broadcastTransferEvent({ job: nextJob });
    }
    this.sendControl({
      id: randomUUID(),
      type: "sftpTransferCancel",
      jobId,
      payload: {},
    });
  }

  async pauseSftpTransfer(jobId: string): Promise<void> {
    const existing = this.transferJobs.get(jobId);
    if (!existing || existing.status !== "running") {
      return;
    }
    await this.start();
    const nextJob: TransferJob = {
      ...existing,
      status: "paused",
      etaSeconds: null,
      updatedAt: new Date().toISOString(),
    };
    this.transferJobs.set(jobId, nextJob);
    this.broadcastTransferEvent({ job: nextJob });
    this.sendControl({
      id: randomUUID(),
      type: "sftpTransferPause",
      jobId,
      payload: {},
    });
  }

  async resumeSftpTransfer(jobId: string): Promise<void> {
    const existing = this.transferJobs.get(jobId);
    if (!existing || existing.status !== "paused") {
      return;
    }
    await this.start();
    const nextJob: TransferJob = {
      ...existing,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    this.transferJobs.set(jobId, nextJob);
    this.broadcastTransferEvent({ job: nextJob });
    this.sendControl({
      id: randomUUID(),
      type: "sftpTransferResume",
      jobId,
      payload: {},
    });
  }

  // tmux pane sessionId(tmux:<controlSessionId>:<paneNum>)의 부모 control 세션 탭이
  // connected 인지 판정한다. pane 은 tabs 에 자기 항목이 없다.
  // sessionId 가 tmux 관련(control 세션 또는 pane 가상 세션)인지. 세션 녹화 제외 등에 쓴다.
  isTmuxSession(sessionId: string | undefined | null): boolean {
    if (!sessionId) {
      return false;
    }
    return (
      sessionId.startsWith("tmux:") || this.tmuxControlSessionIds.has(sessionId)
    );
  }

  private isTmuxControlConnected(paneSessionId: string): boolean {
    const controlSessionId = paneSessionId.slice(
      "tmux:".length,
      paneSessionId.lastIndexOf(":"),
    );
    const controlTab = this.tabs.get(controlSessionId);
    return !!controlTab && controlTab.status === "connected";
  }

  write(sessionId: string, data: string): void {
    // tmux control 세션 id 자체로 들어온 raw 입력은 버린다. control 세션은 -CC 채널이라
    // 터미널 입력을 받지 않으며(입력은 pane 으로 send-keys), 흡수 직전 control 터미널/
    // 자동완성이 보낸 stray write 를 코어로 보내면 "not a tmux pane session" 에러로
    // control 세션이 죽어 모든 pane 입력이 막힌다(freeze 근본 원인). 경계에서 차단.
    if (this.tmuxControlSessionIds.has(sessionId)) {
      return;
    }
    // tmux control mode pane(tmux:<controlSessionId>:<paneNum>)은 tabs에 자기 항목이
    // 없고, 연결 상태는 부모 control 세션 탭으로 판정한다.
    if (sessionId.startsWith("tmux:")) {
      const connected = this.isTmuxControlConnected(sessionId);
      if (!connected) {
        return;
      }
      this.sendStream({ type: "write", sessionId }, Buffer.from(data, "utf8"));
      return;
    }
    const tab = this.tabs.get(sessionId);
    // 아직 연결이 성립되지 않은 탭의 입력은 코어로 보내지 않아 "session not found" 오류를 막는다.
    if (!tab || tab.status !== "connected") {
      return;
    }
    const transport = this.sessionTransportById.get(sessionId);
    if (transport === "aws-ssm" || transport === "aws-ssm-server-proxy") {
      const controlSignal = resolveAwsSsmControlSignal(
        Buffer.from(data, "utf8"),
      );
      if (controlSignal) {
        this.sendControlSignal(sessionId, controlSignal);
        return;
      }
    }
    if (transport === "aws-ssm-server-proxy") {
      this.sendAwsServerProxyMessage(sessionId, {
        type: "input",
        dataBase64: Buffer.from(data, "utf8").toString("base64"),
      });
      return;
    }
    this.sendStream(
      {
        type: "write",
        sessionId,
      },
      Buffer.from(data, "utf8"),
    );
  }

  async prepareAutocomplete(sessionId: string): Promise<void> {
    await this.start();
    if (this.sessionTransportById.get(sessionId) === "aws-ssm-server-proxy") {
      return this.requestAwsServerProxyAutocomplete(sessionId, "autocompletePrepare");
    }
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "terminalAutocompletePrepare",
        sessionId,
        payload: {},
      },
      ["terminalAutocompleteCapability"],
      { timeoutMs: this.autocompleteProbeTimeoutMs(sessionId) },
    );
  }

  // 직결 AWS SSM 세션도 ssh-core의 8초 프로브 예산을 그대로 타므로 SSM 계열만
  // 길게 기다린다. SSH/local은 ~2초 안에 응답하므로 짧은 상한을 유지해
  // 실패 시 입력 큐가 오래 잡혀 있지 않게 한다.
  private autocompleteProbeTimeoutMs(sessionId: string): number {
    return this.sessionTransportById.get(sessionId) === "aws-ssm"
      ? AWS_SSM_AUTOCOMPLETE_PROBE_TIMEOUT_MS
      : AUTOCOMPLETE_PREPARE_TIMEOUT_MS;
  }

  // autocomplete와 무관하게 셸 통합(OSC 7 cwd / OSC 133)만 설치한다(probe 없음).
  // 터미널 드롭 업로드의 cwd 인식이 autocomplete 설정에 휘둘리지 않도록 쓴다.
  async installShellIntegration(sessionId: string): Promise<void> {
    await this.start();
    if (this.sessionTransportById.get(sessionId) === "aws-ssm-server-proxy") {
      // server-proxy 세션은 코어 stdin 밖이라 기존 prepare 경로로 위임(probe 포함).
      try {
        await this.requestAwsServerProxyAutocomplete(
          sessionId,
          "autocompletePrepare",
        );
      } catch {
        // best-effort
      }
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "terminalShellIntegrationInstall",
      sessionId,
      payload: {},
    });
  }

  async refreshAutocomplete(sessionId: string): Promise<void> {
    await this.start();
    if (this.sessionTransportById.get(sessionId) === "aws-ssm-server-proxy") {
      return this.requestAwsServerProxyAutocomplete(sessionId, "autocompleteRefresh");
    }
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "terminalAutocompleteRefresh",
        sessionId,
        payload: {},
      },
      ["terminalAutocompleteCapability"],
      { timeoutMs: this.autocompleteProbeTimeoutMs(sessionId) },
    );
  }

  async stopAutocomplete(sessionId: string): Promise<void> {
    if (this.sessionTransportById.get(sessionId) === "aws-ssm-server-proxy") {
      this.sendAwsServerProxyMessage(sessionId, { type: "autocompleteStop" });
      return;
    }
    if (!this.process) {
      return;
    }
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "terminalAutocompleteStop",
        sessionId,
        payload: {},
      },
      ["terminalAutocompleteCapability"],
      { timeoutMs: 1500 },
    );
  }

  async queryCompletion(sessionId: string, command: string): Promise<string> {
    await this.start();
    // 동적 완성은 보조 채널이 있는 전송에서만 지원한다(SSH/local). SSM 계열은 단일 PTY라 미지원이며,
    // 호출되더라도 원격을 건드리지 않고 빈 결과로 조용히 degrade한다.
    // tmux control mode pane(가상 세션)은 transport 맵에 없지만, control 세션의 SSH client
    // 보조 exec 채널로 완성 명령을 돌릴 수 있으므로 허용한다(generator/path 완성). 없으면
    // 기본(스냅샷) 완성만 되고 동적 완성이 통째로 빠졌다.
    const transport = this.sessionTransportById.get(sessionId);
    const isTmuxPane =
      sessionId.startsWith("tmux:") && this.isTmuxControlConnected(sessionId);
    if (transport !== "ssh" && transport !== "local-shell" && !isTmuxPane) {
      return "";
    }
    const response = await this.requestResponse<{
      stdout?: string;
      truncated?: boolean;
    }>(
      {
        id: randomUUID(),
        type: "terminalCompletionQuery",
        sessionId,
        payload: { command },
      },
      ["terminalCompletionResult"],
      { timeoutMs: TERMINAL_COMPLETION_QUERY_TIMEOUT_MS },
    );
    return typeof response.stdout === "string" ? response.stdout : "";
  }

  // AI 어시스턴트의 run_command 도구용. 세션의 기존 ssh.Client에 별도 exec 채널을 열어(사용자 PTY와 분리)
  // 명령을 실행하고 stdout/stderr/exit 를 돌려준다. exec 자체가 불가한 세션/상황이면 throw(도구가 잡아
  // 모델에 isError 로 전달). Go 코어가 최종 capability 게이트(비-SSH 세션은 error 페이로드로 응답).
  async runCommand(
    sessionId: string,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
    await this.start();
    const commandTimeoutMs = options?.timeoutMs ?? AI_RUN_COMMAND_DEFAULT_TIMEOUT_MS;
    const response = await this.requestResponse<{
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      truncated?: boolean;
      error?: string;
    }>(
      {
        id: randomUUID(),
        type: "runCommand",
        sessionId,
        payload: { command, timeoutMs: commandTimeoutMs },
      },
      ["runCommandResult"],
      { timeoutMs: commandTimeoutMs + 5_000 },
    );
    if (typeof response.error === "string" && response.error.length > 0) {
      throw new Error(response.error);
    }
    return {
      stdout: typeof response.stdout === "string" ? response.stdout : "",
      stderr: typeof response.stderr === "string" ? response.stderr : "",
      exitCode: typeof response.exitCode === "number" ? response.exitCode : -1,
      truncated: response.truncated === true,
    };
  }

  getSessionTransport(sessionId: string): SessionTransport | undefined {
    return this.sessionTransportById.get(sessionId);
  }

  // AI run_in_terminal: 사용자의 활성 PTY 에 명령+Enter 를 입력하고, 나온 출력을 캡처해 돌려준다.
  // quietMs 동안 새 출력이 없거나 · maxMs 초과 · 크기 상한 도달 중 먼저 오는 것에서 멈춘다.
  // 스트리밍/장기 실행(docker logs -f 등)은 maxMs 로 잘려 running:true 로 반환(모델이 무한 대기 안 함).
  async runInTerminalCapture(
    sessionId: string,
    command: string,
    opts?: { quietMs?: number; maxMs?: number; maxBytes?: number },
  ): Promise<{ output: string; running: boolean }> {
    await this.start();
    const quietMs = opts?.quietMs ?? 800;
    const maxMs = opts?.maxMs ?? 12_000;
    const maxBytes = opts?.maxBytes ?? 200_000;
    const capture = {
      chunks: [] as Uint8Array[],
      bytes: 0,
      maxBytes,
      lastAt: Date.now(),
      truncated: false,
    };
    this.terminalCaptures.set(sessionId, capture);
    const startedAt = Date.now();
    try {
      this.writeBinary(sessionId, new TextEncoder().encode(`${command}\r`));
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const now = Date.now();
          const quiet = capture.bytes > 0 && now - capture.lastAt >= quietMs;
          if (quiet || now - startedAt >= maxMs || capture.truncated) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    } finally {
      this.terminalCaptures.delete(sessionId);
    }
    const running = capture.truncated || Date.now() - startedAt >= maxMs;
    const raw = Buffer.concat(capture.chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    return { output: stripTerminalNoise(raw), running };
  }

  private requestAwsServerProxyAutocomplete(
    sessionId: string,
    type: "autocompletePrepare" | "autocompleteRefresh",
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAwsAutocompleteResponses.delete(requestId);
        reject(new Error("Timed out waiting for AWS SSM autocomplete probe"));
      }, AWS_SSM_AUTOCOMPLETE_PROBE_TIMEOUT_MS);
      this.pendingAwsAutocompleteResponses.set(requestId, {
        sessionId,
        resolve,
        reject,
        timeout,
      });
      if (!this.sendAwsServerProxyMessage(sessionId, { type, requestId })) {
        clearTimeout(timeout);
        this.pendingAwsAutocompleteResponses.delete(requestId);
        reject(new Error("AWS SSM server proxy session is unavailable"));
      }
    });
  }

  writeBinary(sessionId: string, data: Uint8Array): void {
    // tmux pane 은 부모 control 세션 탭으로 연결 상태를 판정한다(write 와 동일).
    if (sessionId.startsWith("tmux:")) {
      if (!this.isTmuxControlConnected(sessionId)) {
        return;
      }
      this.sendStream({ type: "write", sessionId }, data);
      return;
    }
    const tab = this.tabs.get(sessionId);
    // 마우스 보고 등 raw 입력도 연결 완료 이후에만 전달한다.
    if (!tab || tab.status !== "connected") {
      return;
    }
    const transport = this.sessionTransportById.get(sessionId);
    if (transport === "aws-ssm" || transport === "aws-ssm-server-proxy") {
      const controlSignal = resolveAwsSsmControlSignal(data);
      if (controlSignal) {
        this.sendControlSignal(sessionId, controlSignal);
        return;
      }
    }
    if (transport === "aws-ssm-server-proxy") {
      this.sendAwsServerProxyMessage(sessionId, {
        type: "input",
        dataBase64: Buffer.from(data).toString("base64"),
      });
      return;
    }
    this.sendStream(
      {
        type: "write",
        sessionId,
      },
      data,
    );
  }

  sendControlSignal(
    sessionId: string,
    signal: SessionShareControlSignal,
  ): void {
    const tab = this.tabs.get(sessionId);
    if (!tab || tab.status !== "connected") {
      return;
    }
    const transport = this.sessionTransportById.get(sessionId);
    if (transport === "aws-ssm-server-proxy") {
      this.sendAwsServerProxyMessage(sessionId, {
        type: "controlSignal",
        signal,
      });
      return;
    }
    if (transport !== "aws-ssm") {
      return;
    }

    this.sendControl<ControlSignalPayload>({
      id: randomUUID(),
      type: "controlSignal",
      sessionId,
      payload: {
        signal,
      },
    });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (sessionId.startsWith("tmux:")) {
      if (!this.isTmuxControlConnected(sessionId)) {
        return;
      }
    } else {
      const tab = this.tabs.get(sessionId);
      if (!tab) {
        return;
      }
    }
    // 숨겨진 패널이나 과도한 observer 발화로 들어온 무효/중복 resize는 main에서 한 번 더 걸러준다.
    if (cols <= 0 || rows <= 0) {
      return;
    }
    const nextSize = { cols, rows };
    const desiredSize = this.desiredResizeBySession.get(sessionId);
    if (desiredSize?.cols === cols && desiredSize.rows === rows) {
      this.flushResizeIfReady(sessionId);
      return;
    }
    this.desiredResizeBySession.set(sessionId, nextSize);
    this.flushResizeIfReady(sessionId);
  }

  private flushResizeIfReady(sessionId: string): void {
    if (sessionId.startsWith("tmux:")) {
      if (!this.isTmuxControlConnected(sessionId)) {
        return;
      }
    } else {
      const tab = this.tabs.get(sessionId);
      if (!tab || tab.status !== "connected") {
        return;
      }
    }

    const desiredSize = this.desiredResizeBySession.get(sessionId);
    if (!desiredSize) {
      return;
    }

    const sentSize = this.sentResizeBySession.get(sessionId);
    if (
      sentSize?.cols === desiredSize.cols &&
      sentSize.rows === desiredSize.rows
    ) {
      return;
    }

    this.sentResizeBySession.set(sessionId, desiredSize);
    if (this.sessionTransportById.get(sessionId) === "aws-ssm-server-proxy") {
      this.sendAwsServerProxyMessage(sessionId, {
        type: "resize",
        cols: desiredSize.cols,
        rows: desiredSize.rows,
      });
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "resize",
      sessionId,
      payload: desiredSize,
    });
  }

  // 윈도우를 닫으면(Cmd+W; 앱은 유지) 모든 터미널 세션을 끊어 재오픈 시 깨끗하게 시작한다.
  // 어중간하게 복원돼 tmux 윈도우 이름/세션 목록 같은 메타데이터만 비는 상태를 방지한다.
  // (포트포워딩·SFTP·컨테이너 등 비-터미널 리소스는 별도 맵이라 건드리지 않는다.)
  disconnectAllSessions(): void {
    for (const sessionId of Array.from(this.tabs.keys())) {
      this.disconnect(sessionId);
    }
  }

  disconnectSessionsOwnedBy(ownerWebContentsId: number): void {
    for (const [sessionId, ownerId] of Array.from(this.sessionOwnerById)) {
      if (ownerId === ownerWebContentsId) {
        this.disconnect(sessionId);
      }
    }
  }

  private async disconnectSftpResourcesOwnedBy(
    ownerWebContentsId: number,
  ): Promise<void> {
    const activeTransferJobIds = Array.from(this.transferOwnerById)
      .filter(([, ownerId]) => ownerId === ownerWebContentsId)
      .map(([jobId]) => jobId)
      .filter((jobId) => {
        const status = this.transferJobs.get(jobId)?.status;
        return (
          status !== undefined &&
          status !== "completed" &&
          status !== "failed" &&
          status !== "cancelled"
        );
      });
    for (const jobId of activeTransferJobIds) {
      await this.cancelSftpTransfer(jobId).catch(() => undefined);
    }
    for (const [jobId, ownerId] of Array.from(this.transferOwnerById)) {
      if (ownerId !== ownerWebContentsId) {
        continue;
      }
      const status = this.transferJobs.get(jobId)?.status;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        this.transferOwnerById.delete(jobId);
      }
    }

    const endpointIds = Array.from(this.sftpEndpointOwnerById)
      .filter(([, ownerId]) => ownerId === ownerWebContentsId)
      .map(([endpointId]) => endpointId);
    for (const endpointId of endpointIds) {
      try {
        await this.sftpDisconnect(endpointId);
      } catch {
        // The owning window is already gone; shutdown cleanup is best-effort.
      } finally {
        this.releaseSftpEndpointOwner(endpointId, ownerWebContentsId);
      }
    }
  }

  private async releaseContainerSubscriptionsOwnedBy(
    ownerWebContentsId: number,
  ): Promise<void> {
    const endpointIds = Array.from(this.containerSubscriberIdsByEndpoint)
      .filter(([, subscribers]) => subscribers.has(ownerWebContentsId))
      .map(([endpointId]) => endpointId);
    for (const endpointId of endpointIds) {
      const { remainingSubscribers } = this.releaseContainerSubscriber(
        endpointId,
        ownerWebContentsId,
      );
      if (remainingSubscribers > 0) {
        continue;
      }
      if (this.getContainersEndpointRuntime(endpointId)) {
        try {
          await this.containersDisconnect(endpointId);
        } catch (error) {
          this.broadcastTerminalEvent({
            type: "containersError",
            endpointId,
            payload: { message: toErrorMessage(error) },
          });
        }
      }
      const lifecycleId = this.getContainerLifecycleId(endpointId);
      if (lifecycleId) {
        this.finalizeContainerLifecycleForScope(
          endpointId,
          lifecycleId,
          "Container 탭을 연 창이 모두 닫혔습니다.",
        );
      }
    }
  }

  disconnect(sessionId: string): void {
    this.desiredResizeBySession.delete(sessionId);
    this.sentResizeBySession.delete(sessionId);
    const tab = this.tabs.get(sessionId);
    if (!tab) {
      return;
    }
    if (this.sessionTransportById.get(sessionId) === "aws-ssm-server-proxy") {
      this.closeAwsServerProxySession(sessionId, "client requested disconnect");
      return;
    }
    // 코어에 실제 세션 핸들이 없을 수 있는 connecting/error 탭은 로컬에서 바로 닫아준다.
    if (!this.process || tab.status !== "connected") {
      this.sessionTransportById.delete(sessionId);
      this.tmuxControlSessionIds.delete(sessionId);
      this.tabs.delete(sessionId);
      this.broadcastTerminalEvent({
        type: "closed",
        sessionId,
        payload: {
          message: "client requested disconnect",
        },
      });
      this.sessionOwnerById.delete(sessionId);
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "disconnect",
      sessionId,
      payload: {},
    });
  }

  // tmux control mode 명령들. sessionId 는 pane 가상 세션 id
  // ("tmux:<controlSessionId>:<paneNum>")이며, control 채널 stdin 으로 명령을 보낸다.
  // 부모 control 세션이 아직 connected 가 아니면(또는 닫혔으면) 조용히 무시한다.
  tmuxSplitPane(sessionId: string, direction: "h" | "v"): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl<{ direction: string }>({
      id: randomUUID(),
      type: "tmuxSplitPane",
      sessionId,
      payload: { direction },
    });
  }

  tmuxNewWindow(sessionId: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "tmuxNewWindow",
      sessionId,
      payload: {},
    });
  }

  tmuxSelectWindow(sessionId: string, windowId: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl<{ windowId: string }>({
      id: randomUUID(),
      type: "tmuxSelectWindow",
      sessionId,
      payload: { windowId },
    });
  }

  tmuxSelectPane(sessionId: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "tmuxSelectPane",
      sessionId,
      payload: {},
    });
  }

  // tmuxCommand 는 렌더러 키맵이 만든 tmux 명령을 control 채널로 그대로 보낸다(단축키 확장용).
  tmuxCommand(sessionId: string, command: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "tmuxCommand",
      sessionId,
      payload: { command },
    });
  }

  tmuxKillPane(sessionId: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "tmuxKillPane",
      sessionId,
      payload: {},
    });
  }

  tmuxKillWindow(sessionId: string, windowId: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl<{ windowId: string }>({
      id: randomUUID(),
      type: "tmuxKillWindow",
      sessionId,
      payload: { windowId },
    });
  }

  tmuxKillSession(sessionId: string, sessionName: string): void {
    // control 세션(pane id)이면 control 채널로, 감지 하단바의 연결된 SSH 세션이면 보조
    // exec 채널로 kill 한다(Go runtime 이 sessionId 종류로 라우팅). 둘 다 아니면 무시.
    const sshTabConnected =
      this.tabs.get(sessionId)?.status === "connected";
    if (!this.isTmuxControlConnected(sessionId) && !sshTabConnected) {
      return;
    }
    this.sendControl<{ sessionName: string }>({
      id: randomUUID(),
      type: "tmuxKillSession",
      sessionId,
      payload: { sessionName },
    });
  }

  tmuxRenameWindow(sessionId: string, windowId: string, name: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl<{ windowId: string; name: string }>({
      id: randomUUID(),
      type: "tmuxRenameWindow",
      sessionId,
      payload: { windowId, name },
    });
  }

  tmuxDetach(sessionId: string): void {
    if (!this.isTmuxControlConnected(sessionId)) {
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "tmuxDetach",
      sessionId,
      payload: {},
    });
  }

  async respondKeyboardInteractive(
    input: KeyboardInteractiveRespondInput,
  ): Promise<void> {
    const hasSessionId =
      typeof input.sessionId === "string" && input.sessionId.length > 0;
    const hasEndpointId =
      typeof input.endpointId === "string" && input.endpointId.length > 0;
    if (hasSessionId === hasEndpointId) {
      throw new Error(
        "keyboard-interactive response requires exactly one sessionId or endpointId",
      );
    }
    await this.start();
    this.sendControl({
      id: randomUUID(),
      type: "keyboardInteractiveRespond",
      sessionId: hasSessionId ? input.sessionId : undefined,
      endpointId: hasEndpointId ? input.endpointId : undefined,
      payload: {
        challengeId: input.challengeId,
        responses: input.responses,
      },
    });
  }

  private consumeStdout(chunk: Buffer): void {
    for (const frame of this.parser.push(chunk)) {
      if (frame.kind === "control") {
        this.handleControlEvent(frame.metadata);
        continue;
      }
      this.broadcastStream(frame.metadata, frame.payload);
    }
  }

  private resolvePendingSessionReady(
    event: CoreEvent<Record<string, unknown>>,
  ): boolean {
    if (!event.sessionId) {
      return false;
    }
    if (
      event.type === "closed" &&
      this.consumeSuppressedSessionCloseEvent(event.sessionId)
    ) {
      return true;
    }
    const pending = this.pendingSessionReadyWaiters.get(event.sessionId);
    if (!pending || pending.settled) {
      return false;
    }

    if (event.type === "connected") {
      pending.settled = true;
      this.pendingSessionReadyWaiters.delete(event.sessionId);
      pending.resolve();
      return false;
    }

    if (event.type !== "error" && event.type !== "closed") {
      return false;
    }

    pending.settled = true;
    this.pendingSessionReadyWaiters.delete(event.sessionId);
    const fallbackMessage =
      event.type === "closed"
        ? "SSH session closed before it was ready."
        : "SSH session failed before it was ready.";
    const message =
      typeof event.payload.message === "string" && event.payload.message.trim()
        ? event.payload.message
        : fallbackMessage;
    if (pending.suppressFailureEvent) {
      if (event.type !== "closed") {
        this.suppressNextSessionCloseEvent(event.sessionId);
      }
      this.clearSpeculativeSession(event.sessionId);
    }
    pending.reject(new Error(message));
    return pending.suppressFailureEvent;
  }

  private suppressNextSessionCloseEvent(sessionId: string): void {
    const currentTimer = this.suppressedSessionCloseEventTimers.get(sessionId);
    if (currentTimer) {
      clearTimeout(currentTimer);
    }
    this.suppressedSessionCloseEvents.add(sessionId);
    const timer = setTimeout(() => {
      this.suppressedSessionCloseEvents.delete(sessionId);
      this.suppressedSessionCloseEventTimers.delete(sessionId);
    }, 30_000);
    timer.unref?.();
    this.suppressedSessionCloseEventTimers.set(sessionId, timer);
  }

  private consumeSuppressedSessionCloseEvent(sessionId: string): boolean {
    if (!this.suppressedSessionCloseEvents.delete(sessionId)) {
      return false;
    }
    const timer = this.suppressedSessionCloseEventTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.suppressedSessionCloseEventTimers.delete(sessionId);
    }
    return true;
  }

  private clearSpeculativeSession(sessionId: string): void {
    this.clearPendingStartupCommand(sessionId);
    this.sessionTransportById.delete(sessionId);
    this.tmuxControlSessionIds.delete(sessionId);
    this.tabs.delete(sessionId);
    this.desiredResizeBySession.delete(sessionId);
    this.sentResizeBySession.delete(sessionId);
    this.sessionLifecycleById.delete(sessionId);
    this.sessionOwnerById.delete(sessionId);
  }

  private handleControlEvent(event: CoreEvent<Record<string, unknown>>): void {
    this.resolvePendingResponse(event);
    if (this.resolvePendingSessionReady(event)) {
      return;
    }

    if (isTransferEvent(event.type)) {
      const existing = event.jobId
        ? this.transferJobs.get(event.jobId)
        : undefined;
      const next = toTransferJobEvent(existing, event);
      this.transferJobs.set(next.job.id, next.job);
      if (
        event.jobId &&
        typeof event.payload.partialPath === "string" &&
        event.payload.partialPath
      ) {
        this.recordSftpPartialPath(event.jobId, event.payload.partialPath);
      }
      this.broadcastTransferEvent(next);
      if (
        next.job.status === "completed" ||
        next.job.status === "failed" ||
        next.job.status === "cancelled"
      ) {
        this.transferJobs.set(next.job.id, next.job);
        this.recordSftpTransferLifecycle(next.job);
        this.clearSftpPartialRecordsForJob(next.job.id);
        const ownerWebContentsId = this.transferOwnerById.get(next.job.id);
        if (
          ownerWebContentsId !== undefined &&
          !this.windowsByWebContentsId.has(ownerWebContentsId)
        ) {
          this.transferOwnerById.delete(next.job.id);
        }
      }
      return;
    }

    if (
      event.type === "portForwardStarted" ||
      event.type === "portForwardStopped" ||
      event.type === "portForwardError"
    ) {
      const ruleId = event.endpointId ?? "";
      const status =
        event.type === "portForwardStarted"
          ? "running"
          : event.type === "portForwardStopped"
            ? "stopped"
            : "error";
      const runtime = this.buildForwardRuntime(ruleId, event.payload, status);
      if (status === "stopped") {
        this.portForwardDefinitions.delete(ruleId);
      }
      this.portForwardRuntimes.set(ruleId, runtime);
      this.broadcastPortForwardEvent({ runtime });
      void this.onPortForwardEvent?.({ runtime });
      return;
    }

    if (event.endpointId) {
      if (event.type === "sftpSudoStatus") {
        const endpoint = this.sftpEndpoints.get(event.endpointId);
        if (endpoint) {
          const status = normalizeSftpSudoStatus(
            String(event.payload.status ?? "unknown"),
          );
          this.sftpEndpoints.set(event.endpointId, {
            ...endpoint,
            sudoStatus: status,
          });
        }
        this.broadcastTerminalEvent(event);
        return;
      }
      if (
        event.type === "containersConnected" ||
        event.type === "containersDisconnected" ||
        event.type === "containersError"
      ) {
        if (
          event.type === "containersDisconnected" ||
          event.type === "containersError"
        ) {
          this.containerEndpoints.delete(event.endpointId);
          this.containerNamesByEndpointId.delete(event.endpointId);
          const lifecycleId = this.getContainerLifecycleId(event.endpointId);
          if (lifecycleId) {
            if (event.type === "containersError") {
              this.failContainerLifecycleForScope(
                event.endpointId,
                String(
                  event.payload.message ?? "Containers 연결 오류가 발생했습니다.",
                ),
              );
            } else {
              this.finalizeContainerLifecycleForScope(
                event.endpointId,
                lifecycleId,
                typeof event.payload.message === "string"
                  ? event.payload.message
                  : null,
              );
            }
          }
        }
        this.broadcastTerminalEvent(event);
        return;
      }
      if (
        event.type === "containersListed" ||
        event.type === "containersInspected" ||
        event.type === "containersLogs"
      ) {
        return;
      }
      this.broadcastTerminalEvent(event);
      return;
    }

    if (event.sessionId) {
      const existing = this.tabs.get(event.sessionId);
      const transport = this.sessionTransportById.get(event.sessionId) ?? "ssh";
      const isAwsSession =
        transport === "aws-ssm" || transport === "aws-ssm-server-proxy";
      const isWarpgateSession = transport === "warpgate";
      const isLocalSession = transport === "local-shell";
      const sessionLifecycle = this.sessionLifecycleById.get(event.sessionId);
      const resolvedLocalShellKind =
        isLocalSession && typeof event.payload.shellKind === "string"
          ? event.payload.shellKind
          : null;
      if (!existing && event.type === "closed") {
        this.sessionTransportById.delete(event.sessionId);
        this.tmuxControlSessionIds.delete(event.sessionId);
        this.sessionLifecycleById.delete(event.sessionId);
      }
      if (existing) {
        if (event.type === "closed") {
          this.clearPendingStartupCommand(event.sessionId);
          this.sessionTransportById.delete(event.sessionId);
          this.tmuxControlSessionIds.delete(event.sessionId);
          this.tabs.delete(event.sessionId);
          this.desiredResizeBySession.delete(event.sessionId);
          this.sentResizeBySession.delete(event.sessionId);
          if (!sessionLifecycle) {
            this.log({
              level: "info",
              category: "session",
              message: isLocalSession
                ? "로컬 터미널 세션이 종료되었습니다."
                : isAwsSession
                  ? "AWS SSM 세션이 종료되었습니다."
                  : isWarpgateSession
                    ? "Warpgate 세션이 종료되었습니다."
                    : "SSH 세션이 종료되었습니다.",
              metadata: {
                sessionId: event.sessionId,
                message: event.payload.message ?? null,
              },
            });
          } else if (!sessionLifecycle.disconnectedAt) {
            this.finalizeSessionLifecycle(
              event.sessionId,
              "closed",
              typeof event.payload.message === "string"
                ? event.payload.message
                : null,
            );
          }
          this.sessionLifecycleById.delete(event.sessionId);
          this.broadcastTerminalEvent(event);
          this.sessionOwnerById.delete(event.sessionId);
          return;
        }
        // 코어 이벤트를 탭 상태로 축약해 renderer가 바로 표시할 수 있게 한다.
        const nextStatus =
          event.type === "connected"
            ? "connected"
            : event.type === "error"
              ? "error"
              : existing.status;
        this.tabs.set(event.sessionId, {
          ...existing,
          status: nextStatus,
          shellKind: resolvedLocalShellKind ?? existing.shellKind,
          errorMessage:
            event.type === "error"
              ? String(event.payload.message ?? "SSH error")
              : existing.errorMessage,
          lastEventAt: new Date().toISOString(),
        });
        if (event.type === "connected") {
          this.flushResizeIfReady(event.sessionId);
          this.armStartupCommandFlush(event.sessionId);
          if (!sessionLifecycle) {
            this.log({
              level: "info",
              category: "session",
              message: isLocalSession
                ? "로컬 터미널 세션이 연결되었습니다."
                : isAwsSession
                  ? "AWS SSM 세션이 연결되었습니다."
                  : isWarpgateSession
                    ? "Warpgate 세션이 연결되었습니다."
                    : "SSH 세션이 연결되었습니다.",
              metadata: {
                sessionId: event.sessionId,
                hostId: existing.hostId,
                title: existing.title,
                transport,
                shellKind: resolvedLocalShellKind,
              },
            });
          } else {
            this.markSessionConnected(event.sessionId);
          }
        }
        if (event.type === "error") {
          this.clearPendingStartupCommand(event.sessionId);
          if (!sessionLifecycle) {
            this.log({
              level: "error",
              category: "session",
              message: isLocalSession
                ? "로컬 터미널 세션 오류가 발생했습니다."
                : isAwsSession
                  ? "AWS SSM 세션 오류가 발생했습니다."
                  : isWarpgateSession
                    ? "Warpgate 세션 오류가 발생했습니다."
                    : "SSH 세션 오류가 발생했습니다.",
              metadata: {
                sessionId: event.sessionId,
                message: event.payload.message ?? null,
                transport,
              },
            });
          } else if (sessionLifecycle.connectedAt) {
            // 연결 성공 후 오류: lifecycle을 error로 마감(local 포함).
            this.finalizeSessionLifecycle(
              event.sessionId,
              "error",
              typeof event.payload.message === "string"
                ? event.payload.message
                : null,
            );
          } else if (sessionLifecycle.status !== "error") {
            if (sessionLifecycle.connectionKind === "local") {
              // 로컬 터미널의 연결 전 실패: replay/연결 lifecycle 대상이 아니라 generic 에러 로그만.
              this.log({
                level: "error",
                category: "session",
                message: `${this.getConnectionKindLabel(sessionLifecycle.connectionKind)} 세션 오류가 발생했습니다.`,
                metadata: {
                  sessionId: event.sessionId,
                  hostId: sessionLifecycle.hostId,
                  hostLabel: sessionLifecycle.hostLabel,
                  title: sessionLifecycle.title,
                  connectionKind: sessionLifecycle.connectionKind,
                  message: event.payload.message ?? null,
                },
              });
              sessionLifecycle.status = "error";
              this.sessionLifecycleById.set(event.sessionId, sessionLifecycle);
            } else {
              // host 세션(ssh/ssm/warpgate/ecs-exec/serial)의 연결 전 실패: hostId 포함
              // lifecycle error 로그로 남겨 최근 로그/Logs 에 표시한다.
              this.finalizeSessionLifecycle(
                event.sessionId,
                "error",
                typeof event.payload.message === "string"
                  ? event.payload.message
                  : null,
              );
            }
          }
        }
      }
      this.broadcastTerminalEvent(event);
      if (event.type === "closed") {
        this.sessionOwnerById.delete(event.sessionId);
      }
      return;
    }

    if (event.type === "status" || event.type === "error") {
      this.broadcastTerminalEvent(event);
    }
  }

  private normalizeStartupCommand(value?: string): string | null {
    if (typeof value !== "string" || value.length > MAX_HOST_STARTUP_COMMAND_LENGTH) {
      return null;
    }
    const normalized = value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
    return normalized.trim() ? normalized : null;
  }

  // connected 시점엔 셸이 아직 프롬프트를 안 찍었을 수 있어 바로 보내지 않는다.
  // 프롬프트가 떴다고 판단될 때까지 기다리되, 끝내 못 알아봐도 상한 시간엔 보낸다.
  private armStartupCommandFlush(sessionId: string): void {
    if (!this.pendingStartupCommandsBySessionId.has(sessionId)) {
      return;
    }
    // connected가 중복으로 와도 한 번만 무장한다.
    if (this.startupCommandFlushStateBySessionId.has(sessionId)) {
      return;
    }
    this.startupCommandFlushStateBySessionId.set(sessionId, {
      tail: "",
      quietTimer: null,
      maxWaitTimer: setTimeout(() => {
        this.flushStartupCommand(sessionId);
      }, STARTUP_COMMAND_FLUSH_MAX_WAIT_MS),
    });
  }

  // 무장된 세션의 출력을 모아, 출력이 잠시 멈췄을 때 꼬리가 프롬프트처럼 보이면 전송한다.
  // rc 파일 sourcing 같은 중간 공백에는 프롬프트가 아니므로 발사하지 않고 더 기다린다.
  private noteOutputForStartupCommand(
    sessionId: string,
    payload: Uint8Array,
  ): void {
    const state = this.startupCommandFlushStateBySessionId.get(sessionId);
    if (!state) {
      return;
    }
    state.tail = (state.tail + Buffer.from(payload).toString("utf8")).slice(
      -STARTUP_COMMAND_TAIL_MAX_LENGTH,
    );
    // 셸 통합 init이 적용된 통합 프롬프트(OSC 133;A)가 보이면 즉시 flush한다.
    // 이렇게 하면 startup command가 init 뒤에 들어가, init 주입으로 프롬프트가
    // 한 번 더 그려지는(=셸이 2개로 보이는) 현상이 사라진다.
    if (state.tail.includes("]133;A")) {
      this.flushStartupCommand(sessionId);
      return;
    }
    if (state.quietTimer) {
      clearTimeout(state.quietTimer);
    }
    state.quietTimer = setTimeout(() => {
      state.quietTimer = null;
      if (looksLikeShellPrompt(state.tail)) {
        this.flushStartupCommand(sessionId);
      }
    }, STARTUP_COMMAND_FLUSH_QUIET_MS);
  }

  private flushStartupCommand(sessionId: string): void {
    const command = this.pendingStartupCommandsBySessionId.get(sessionId);
    this.clearPendingStartupCommand(sessionId);
    if (!command) {
      return;
    }
    try {
      this.write(sessionId, `${command}\r`);
    } catch {
      this.log({
        level: "warn",
        category: "session",
        message: "Startup command를 터미널에 전송하지 못했습니다.",
        metadata: {
          sessionId,
        },
      });
    }
  }

  // startup command 관련 보류 상태(명령/타이머)를 한 번에 정리한다.
  private clearPendingStartupCommand(sessionId: string): void {
    const state = this.startupCommandFlushStateBySessionId.get(sessionId);
    if (state) {
      if (state.quietTimer) {
        clearTimeout(state.quietTimer);
      }
      clearTimeout(state.maxWaitTimer);
      this.startupCommandFlushStateBySessionId.delete(sessionId);
    }
    this.pendingStartupCommandsBySessionId.delete(sessionId);
  }

  private requestResponse<TPayload extends Record<string, unknown>>(
    request: CoreRequest<unknown>,
    expectedTypes: CoreEventType[],
    options?: {
      timeoutMs?: number;
    },
  ): Promise<TPayload> {
    if (!this.process) {
      throw new Error("SSH core process is not running");
    }

    return new Promise<TPayload>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 8000;
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(request.id);
        reject(
          new Error(`Timed out waiting for SSH core response: ${request.type}`),
        );
      }, timeoutMs);

      this.pendingResponses.set(request.id, {
        resolve: (payload) => resolve(payload as TPayload),
        reject,
        expectedTypes: new Set(expectedTypes),
        timeout,
      });

      this.sendControl(request);
    });
  }

  private resolvePendingResponse(
    event: CoreEvent<Record<string, unknown>>,
  ): void {
    if (!event.requestId) {
      return;
    }
    const pending = this.pendingResponses.get(event.requestId);
    if (!pending) {
      return;
    }

    if (
      event.type === "error" ||
      event.type === "sftpError" ||
      event.type === "portForwardError" ||
      event.type === "containersError"
    ) {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(event.requestId);
      pending.reject(
        new Error(String(event.payload.message ?? "SSH core error")),
      );
      return;
    }

    if (!pending.expectedTypes.has(event.type)) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingResponses.delete(event.requestId);
    pending.resolve(event.payload);
  }

  private rejectAllPending(message: string): void {
    for (const [requestId, pending] of this.pendingResponses.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingResponses.delete(requestId);
    }
  }

  private rejectAllPendingSessionReady(message: string): void {
    for (const [sessionId, pending] of this.pendingSessionReadyWaiters) {
      pending.settled = true;
      pending.reject(new Error(message));
      this.pendingSessionReadyWaiters.delete(sessionId);
    }
  }

  private describeTransferEndpoint(
    endpoint: TransferStartInput["source"],
  ): string {
    if (endpoint.kind === "local") {
      return "Local";
    }
    return this.sftpEndpoints.get(endpoint.endpointId)?.title ?? "Remote";
  }

  private clearRuntimeState(): void {
    for (const runtime of this.awsServerProxySessions.values()) {
      runtime.finalized = true;
      try {
        runtime.socket.close();
      } catch {
        // ignore close failures while clearing runtime state
      }
    }
    this.awsServerProxySessions.clear();
    for (const pending of this.pendingAwsAutocompleteResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("SSH core process stopped"));
    }
    this.pendingAwsAutocompleteResponses.clear();
    this.rejectAllPendingSessionReady("SSH core process stopped");
    this.tabs.clear();
    this.sftpEndpoints.clear();
    this.sftpEndpointOwnerById.clear();
    this.sftpLifecycleByEndpointId.clear();
    this.containerEndpoints.clear();
    this.containerSubscriberIdsByEndpoint.clear();
    this.pendingContainerInteractiveEventByEndpoint.clear();
    this.containerLifecycleByScopeId.clear();
    this.containerNamesByEndpointId.clear();
    this.transferJobs.clear();
    this.transferOwnerById.clear();
    this.portForwardDefinitions.clear();
    this.portForwardRuntimes.clear();
    this.desiredResizeBySession.clear();
    this.sentResizeBySession.clear();
    for (const timer of this.suppressedSessionCloseEventTimers.values()) {
      clearTimeout(timer);
    }
    this.suppressedSessionCloseEventTimers.clear();
    this.suppressedSessionCloseEvents.clear();
    this.sessionTransportById.clear();
    for (const state of this.startupCommandFlushStateBySessionId.values()) {
      if (state.quietTimer) {
        clearTimeout(state.quietTimer);
      }
      clearTimeout(state.maxWaitTimer);
    }
    this.startupCommandFlushStateBySessionId.clear();
    this.pendingStartupCommandsBySessionId.clear();
    this.sessionLifecycleById.clear();
    this.sessionOwnerById.clear();
  }

  private buildForwardRuntime(
    ruleId: string,
    payload: Record<string, unknown>,
    status: PortForwardRuntimeRecord["status"],
  ): PortForwardRuntimeRecord {
    const fallback = this.portForwardDefinitions.get(ruleId);
    const transport =
      payload.transport === "aws-ssm" || payload.transport === "ssh"
        ? (fallback?.transport ?? (payload.transport as PortForwardTransport))
        : (fallback?.transport ?? "ssh");
    return {
      ruleId,
      hostId: fallback?.hostId ?? "",
      transport,
      mode:
        payload.mode === "remote" ||
        payload.mode === "dynamic" ||
        payload.mode === "local"
          ? (payload.mode as PortForwardMode)
          : (fallback?.mode ?? "local"),
      method:
        payload.method === "ssh-native" ||
        payload.method === "ssh-session-proxy" ||
        payload.method === "ssm-remote-host"
          ? payload.method
          : this.portForwardRuntimes.get(ruleId)?.method ??
            (fallback?.backendTransport === "aws-ssm"
              ? "ssm-remote-host"
              : "ssh-native"),
      bindAddress: String(
        payload.bindAddress ?? fallback?.bindAddress ?? "127.0.0.1",
      ),
      bindPort: Number(payload.bindPort ?? fallback?.bindPort ?? 0),
      status,
      message: payload.message ? String(payload.message) : undefined,
      updatedAt: new Date().toISOString(),
      startedAt:
        status === "running"
          ? new Date().toISOString()
          : this.portForwardRuntimes.get(ruleId)?.startedAt,
    };
  }

  private sendControl<TPayload>(request: CoreRequest<TPayload>): void {
    if (!this.process) {
      throw new Error("SSH core process is not running");
    }
    this.process.stdin.write(encodeControlFrame(request));
  }

  private sendStream(metadata: CoreStreamFrame, payload: Uint8Array): void {
    if (!this.process) {
      throw new Error("SSH core process is not running");
    }
    this.process.stdin.write(encodeStreamFrame(metadata, payload));
  }

  private broadcastTerminalEvent(
    event: CoreEvent<Record<string, unknown>>,
  ): void {
    if (
      event.endpointId &&
      this.sendToSftpEndpointOwner(
        event.endpointId,
        ipcChannels.ssh.event,
        event,
      )
    ) {
      void this.onTerminalEvent?.(event);
      return;
    }
    if (
      event.endpointId &&
      this.containerSubscriberIdsByEndpoint.has(event.endpointId)
    ) {
      const isInteractiveChallenge =
        event.type === "keyboardInteractiveChallenge";
      const isInteractiveResolution =
        event.type === "keyboardInteractiveResolved";
      if (isInteractiveChallenge) {
        this.pendingContainerInteractiveEventByEndpoint.set(
          event.endpointId,
          event,
        );
      }
      if (
        this.sendToContainerSubscribers(
          event.endpointId,
          ipcChannels.ssh.event,
          event,
          isInteractiveChallenge || isInteractiveResolution,
        )
      ) {
        if (
          isInteractiveResolution ||
          event.type === "containersConnected" ||
          event.type === "containersDisconnected" ||
          event.type === "containersError"
        ) {
          this.pendingContainerInteractiveEventByEndpoint.delete(
            event.endpointId,
          );
        }
        void this.onTerminalEvent?.(event);
        return;
      }
    }
    if (
      event.sessionId &&
      this.sendToSessionOwner(event.sessionId, ipcChannels.ssh.event, event)
    ) {
      void this.onTerminalEvent?.(event);
      return;
    }
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.ssh.event, event);
      }
    }
    void this.onTerminalEvent?.(event);
  }

  private broadcastTransferEvent(event: TransferJobEvent): void {
    const ownerWebContentsId = this.transferOwnerById.get(event.job.id);
    if (
      ownerWebContentsId !== undefined &&
      this.sendToWindowOwner(
        ownerWebContentsId,
        ipcChannels.sftp.transferEvent,
        event,
      )
    ) {
      return;
    }
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.sftp.transferEvent, event);
      }
    }
  }

  private broadcastPortForwardEvent(event: PortForwardRuntimeEvent): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.portForwards.event, event);
      }
    }
  }

  private broadcastStream(
    metadata: CoreStreamFrame,
    payload: Uint8Array,
  ): void {
    if (metadata.type !== "data") {
      return;
    }
    // 출력이 들어올 때마다 프롬프트가 떴는지 보고 그때 startup command를 보낸다.
    this.noteOutputForStartupCommand(metadata.sessionId, payload);
    // 터미널 데이터는 별도 채널로 보내 renderer store를 거치지 않고 xterm으로 직결한다.
    const streamPayload = {
      sessionId: metadata.sessionId,
      chunk: new Uint8Array(payload),
    };
    if (!this.sendToSessionOwner(metadata.sessionId, ipcChannels.ssh.data, streamPayload)) {
      for (const window of this.windows) {
        if (!window.isDestroyed()) {
          window.webContents.send(ipcChannels.ssh.data, streamPayload);
        }
      }
    }
    void this.onTerminalStream?.(metadata.sessionId, new Uint8Array(payload));
    // AI run_in_terminal 출력 캡처가 활성이면 청크를 쌓는다(상한까지).
    const capture = this.terminalCaptures.get(metadata.sessionId);
    if (capture) {
      capture.lastAt = Date.now();
      if (capture.bytes < capture.maxBytes) {
        capture.chunks.push(new Uint8Array(payload));
        capture.bytes += payload.length;
      } else {
        capture.truncated = true;
      }
    }
  }

  private assignCurrentSessionOwner(sessionId: string): void {
    this.assignSessionOwner(sessionId, this.sessionOwnerStorage.getStore());
  }

  private assignCurrentSftpEndpointOwner(endpointId: string): void {
    const ownerWebContentsId =
      this.sessionOwnerStorage.getStore() ??
      this.sftpEndpointOwnerById.get(endpointId);
    if (ownerWebContentsId === undefined) {
      return;
    }
    if (!this.windowsByWebContentsId.has(ownerWebContentsId)) {
      throw new Error("연결을 요청한 창이 닫혔습니다.");
    }
    this.registerSftpEndpointOwner(endpointId, ownerWebContentsId);
  }

  private assignCurrentTransferOwner(jobId: string): void {
    const ownerWebContentsId = this.sessionOwnerStorage.getStore();
    if (ownerWebContentsId === undefined) {
      return;
    }
    if (!this.windowsByWebContentsId.has(ownerWebContentsId)) {
      throw new Error("파일 전송을 요청한 창이 닫혔습니다.");
    }
    this.transferOwnerById.set(jobId, ownerWebContentsId);
  }

  private assignSessionOwner(
    sessionId: string,
    ownerWebContentsId: number | undefined,
  ): void {
    if (ownerWebContentsId !== undefined) {
      this.sessionOwnerById.set(sessionId, ownerWebContentsId);
    }
  }

  private resolveSessionOwnerId(sessionId: string): number | undefined {
    const directOwner = this.sessionOwnerById.get(sessionId);
    if (directOwner !== undefined) {
      return directOwner;
    }
    if (!sessionId.startsWith("tmux:")) {
      return undefined;
    }
    const controlSessionId = sessionId.slice(
      "tmux:".length,
      sessionId.lastIndexOf(":"),
    );
    return this.sessionOwnerById.get(controlSessionId);
  }

  private sendToSessionOwner(
    sessionId: string,
    channel: string,
    payload: unknown,
  ): boolean {
    const ownerWebContentsId = this.resolveSessionOwnerId(sessionId);
    if (ownerWebContentsId === undefined) {
      return false;
    }
    return this.sendToWindowOwner(ownerWebContentsId, channel, payload);
  }

  private sendToSftpEndpointOwner(
    endpointId: string,
    channel: string,
    payload: unknown,
  ): boolean {
    const ownerWebContentsId = this.sftpEndpointOwnerById.get(endpointId);
    if (ownerWebContentsId === undefined) {
      return false;
    }
    return this.sendToWindowOwner(ownerWebContentsId, channel, payload);
  }

  private sendToContainerSubscribers(
    endpointId: string,
    channel: string,
    payload: unknown,
    firstSubscriberOnly = false,
  ): boolean {
    const subscribers = this.containerSubscriberIdsByEndpoint.get(endpointId);
    if (!subscribers) {
      return false;
    }
    const ownerIds = firstSubscriberOnly
      ? Array.from(subscribers).slice(0, 1)
      : Array.from(subscribers);
    for (const ownerWebContentsId of ownerIds) {
      this.sendToWindowOwner(ownerWebContentsId, channel, payload);
    }
    return true;
  }

  private sendToWindowOwner(
    ownerWebContentsId: number,
    channel: string,
    payload: unknown,
  ): boolean {
    const window = this.windowsByWebContentsId.get(ownerWebContentsId);
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
    return true;
  }

  private startSftpLifecycle(
    payload: ResolvedSftpConnectPayload & {
      endpointId: string;
      title: string;
      hostId: string;
    },
  ): void {
    const startedAt = new Date().toISOString();
    const lifecycle: SftpLifecycleState = {
      endpointId: payload.endpointId,
      hostId: payload.hostId,
      hostLabel: payload.title,
      title: payload.title,
      startedAt,
      connectedAt: null,
      endedAt: null,
      status: "connecting",
      endReason: null,
      uploadedCount: 0,
      downloadedCount: 0,
      remoteCopyCount: 0,
      uploadedBytes: 0,
      downloadedBytes: 0,
      remoteCopyBytes: 0,
      mkdirCount: 0,
      renameCount: 0,
      chmodCount: 0,
      chownCount: 0,
      deleteCount: 0,
      errorCount: 0,
      visitedPaths: new Set<string>(),
      lastPath: null,
    };
    this.sftpLifecycleByEndpointId.set(payload.endpointId, lifecycle);
    this.upsertSftpLifecycleLog(lifecycle);
  }

  private markSftpLifecycleConnected(summary: SftpEndpointSummary): void {
    const lifecycle = this.sftpLifecycleByEndpointId.get(summary.id);
    if (!lifecycle) {
      return;
    }
    lifecycle.connectedAt = summary.connectedAt;
    lifecycle.status = "connected";
    lifecycle.lastPath = summary.path;
    lifecycle.visitedPaths.add(summary.path);
    this.sftpLifecycleByEndpointId.set(summary.id, lifecycle);
    this.upsertSftpLifecycleLog(lifecycle);
  }

  private finalizeSftpLifecycle(
    endpointId: string,
    status: "closed" | "error",
    endReason: string | null,
  ): void {
    const lifecycle = this.sftpLifecycleByEndpointId.get(endpointId);
    if (!lifecycle || lifecycle.endedAt) {
      return;
    }
    lifecycle.endedAt = new Date().toISOString();
    lifecycle.status = status;
    lifecycle.endReason = endReason;
    this.sftpLifecycleByEndpointId.set(endpointId, lifecycle);
    this.upsertSftpLifecycleLog(lifecycle);
  }

  private recordSftpLifecycleVisit(endpointId: string, pathValue: string): void {
    const lifecycle = this.sftpLifecycleByEndpointId.get(endpointId);
    if (!lifecycle) {
      return;
    }
    lifecycle.lastPath = pathValue;
    lifecycle.visitedPaths.add(pathValue);
    this.sftpLifecycleByEndpointId.set(endpointId, lifecycle);
    this.upsertSftpLifecycleLog(lifecycle);
  }

  private incrementSftpLifecycle(
    endpointId: string,
    updates: Partial<
      Pick<
        SftpLifecycleState,
        | "uploadedCount"
        | "downloadedCount"
        | "remoteCopyCount"
        | "uploadedBytes"
        | "downloadedBytes"
        | "remoteCopyBytes"
        | "mkdirCount"
        | "renameCount"
        | "chmodCount"
        | "chownCount"
        | "deleteCount"
        | "errorCount"
      >
    >,
    options: { path?: string | null; endReason?: string | null } = {},
  ): void {
    const lifecycle = this.sftpLifecycleByEndpointId.get(endpointId);
    if (!lifecycle) {
      return;
    }
    lifecycle.uploadedCount += updates.uploadedCount ?? 0;
    lifecycle.downloadedCount += updates.downloadedCount ?? 0;
    lifecycle.remoteCopyCount += updates.remoteCopyCount ?? 0;
    lifecycle.uploadedBytes += updates.uploadedBytes ?? 0;
    lifecycle.downloadedBytes += updates.downloadedBytes ?? 0;
    lifecycle.remoteCopyBytes += updates.remoteCopyBytes ?? 0;
    lifecycle.mkdirCount += updates.mkdirCount ?? 0;
    lifecycle.renameCount += updates.renameCount ?? 0;
    lifecycle.chmodCount += updates.chmodCount ?? 0;
    lifecycle.chownCount += updates.chownCount ?? 0;
    lifecycle.deleteCount += updates.deleteCount ?? 0;
    lifecycle.errorCount += updates.errorCount ?? 0;
    if (options.path) {
      lifecycle.lastPath = options.path;
      lifecycle.visitedPaths.add(options.path);
    }
    if (options.endReason) {
      lifecycle.endReason = options.endReason;
    }
    this.sftpLifecycleByEndpointId.set(endpointId, lifecycle);
    this.upsertSftpLifecycleLog(lifecycle);
  }

  private recordSftpLifecycleError(
    endpointId: string,
    error: unknown,
    pathValue?: string | null,
  ): void {
    this.incrementSftpLifecycle(
      endpointId,
      { errorCount: 1 },
      { endReason: toErrorMessage(error), path: pathValue },
    );
  }

  private recordSftpTransferLifecycle(job: TransferJob): void {
    const request = job.request;
    if (!request) {
      return;
    }
    const sourceEndpointId =
      request.source.kind === "remote" ? request.source.endpointId : null;
    const targetEndpointId =
      request.target.kind === "remote" ? request.target.endpointId : null;
    const remoteEndpointIds = Array.from(
      new Set([sourceEndpointId, targetEndpointId].filter(Boolean) as string[]),
    );
    if (remoteEndpointIds.length === 0) {
      return;
    }

    if (job.status === "failed") {
      for (const endpointId of remoteEndpointIds) {
        this.incrementSftpLifecycle(
          endpointId,
          { errorCount: 1 },
          {
            endReason:
              job.errorMessage ?? job.detailMessage ?? "전송에 실패했습니다.",
          },
        );
      }
      return;
    }

    if (job.status !== "completed") {
      return;
    }

    const itemCount = job.completedItemCount ?? job.itemCount;
    const bytes = Math.max(0, job.bytesCompleted || job.bytesTotal);
    if (sourceEndpointId && targetEndpointId) {
      if (sourceEndpointId === targetEndpointId) {
        this.incrementSftpLifecycle(sourceEndpointId, {
          remoteCopyCount: itemCount,
          remoteCopyBytes: bytes,
        });
        return;
      }
      this.incrementSftpLifecycle(sourceEndpointId, {
        downloadedCount: itemCount,
        downloadedBytes: bytes,
      });
      this.incrementSftpLifecycle(targetEndpointId, {
        uploadedCount: itemCount,
        uploadedBytes: bytes,
      });
      return;
    }

    if (sourceEndpointId) {
      this.incrementSftpLifecycle(sourceEndpointId, {
        downloadedCount: itemCount,
        downloadedBytes: bytes,
      });
    }
    if (targetEndpointId) {
      this.incrementSftpLifecycle(targetEndpointId, {
        uploadedCount: itemCount,
        uploadedBytes: bytes,
      });
    }
  }

  private upsertSftpLifecycleLog(lifecycle: SftpLifecycleState): void {
    const metadata = this.buildSftpLifecycleMetadata(lifecycle);
    this.upsertLog({
      id: this.getSftpLifecycleLogId(lifecycle.endpointId),
      level:
        metadata.status === "error" || metadata.errorCount > 0
          ? "error"
          : "info",
      category: "session",
      kind: "sftp-lifecycle",
      message: "SFTP 세션",
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: lifecycle.startedAt,
      updatedAt: lifecycle.endedAt ?? new Date().toISOString(),
    });
  }

  private buildSftpLifecycleMetadata(
    lifecycle: SftpLifecycleState,
  ): SftpLifecycleLogMetadata {
    const durationStart = lifecycle.connectedAt ?? lifecycle.startedAt;
    const durationMs = lifecycle.endedAt
      ? Math.max(
          0,
          new Date(lifecycle.endedAt).getTime() -
            new Date(durationStart).getTime(),
        )
      : null;
    return {
      endpointId: lifecycle.endpointId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      title: lifecycle.title,
      startedAt: lifecycle.startedAt,
      connectedAt: lifecycle.connectedAt,
      endedAt: lifecycle.endedAt,
      durationMs,
      status: lifecycle.status,
      endReason: lifecycle.endReason,
      uploadedCount: lifecycle.uploadedCount,
      downloadedCount: lifecycle.downloadedCount,
      remoteCopyCount: lifecycle.remoteCopyCount,
      uploadedBytes: lifecycle.uploadedBytes,
      downloadedBytes: lifecycle.downloadedBytes,
      remoteCopyBytes: lifecycle.remoteCopyBytes,
      mkdirCount: lifecycle.mkdirCount,
      renameCount: lifecycle.renameCount,
      chmodCount: lifecycle.chmodCount,
      chownCount: lifecycle.chownCount,
      deleteCount: lifecycle.deleteCount,
      errorCount: lifecycle.errorCount,
      visitedPathCount: lifecycle.visitedPaths.size,
      lastPath: lifecycle.lastPath,
    };
  }

  private log(entry: ActivityLogInput): void {
    this.appendLog?.(entry);
  }

  private upsertLog(record: ActivityLogRecord): void {
    this.upsertLogRecord?.(record);
  }

  private getActiveContainerLifecycle(
    scopeId: string,
    lifecycleId: string,
  ): ContainerLifecycleState | null {
    const lifecycle = this.containerLifecycleByScopeId.get(scopeId);
    if (
      !lifecycle ||
      lifecycle.lifecycleId !== lifecycleId ||
      lifecycle.endedAt
    ) {
      return null;
    }
    return lifecycle;
  }

  private finalizeContainerLifecycle(
    scopeId: string,
    lifecycleId: string,
    status: "closed" | "error" | "unsupported",
    reason: string | null,
  ): void {
    const lifecycle = this.getActiveContainerLifecycle(scopeId, lifecycleId);
    if (!lifecycle) {
      return;
    }
    lifecycle.status = status;
    lifecycle.endedAt = new Date().toISOString();
    lifecycle.endReason = reason;
    if (status === "error") {
      lifecycle.errorCount += 1;
      lifecycle.lastError = reason;
    }
    this.containerLifecycleByScopeId.set(scopeId, lifecycle);
    this.upsertContainerLifecycleLog(lifecycle);
  }

  private upsertContainerLifecycleLog(
    lifecycle: ContainerLifecycleState,
  ): void {
    const durationMs = lifecycle.endedAt
      ? Math.max(
          0,
          new Date(lifecycle.endedAt).getTime() -
            new Date(lifecycle.startedAt).getTime(),
        )
      : null;
    const metadata: ContainerLifecycleLogMetadata = {
      lifecycleId: lifecycle.lifecycleId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      workspaceKind: lifecycle.workspaceKind,
      transport: lifecycle.transport,
      runtime: lifecycle.runtime,
      startedAt: lifecycle.startedAt,
      connectedAt: lifecycle.connectedAt,
      endedAt: lifecycle.endedAt,
      durationMs,
      status: lifecycle.status,
      refreshCount: lifecycle.refreshCount,
      errorCount: lifecycle.errorCount,
      resourceCount: lifecycle.resourceCount,
      lastError: lifecycle.lastError,
      endReason: lifecycle.endReason,
    };
    this.upsertLog({
      id: `container:${lifecycle.lifecycleId}`,
      level:
        lifecycle.status === "error"
          ? "error"
          : lifecycle.status === "unsupported"
            ? "warn"
            : "info",
      category: "session",
      kind: "container-lifecycle",
      message:
        lifecycle.workspaceKind === "ecs-cluster"
          ? "ECS Containers 탐색"
          : "Containers 연결",
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: lifecycle.startedAt,
      updatedAt: lifecycle.endedAt ?? new Date().toISOString(),
    });
  }

  private resolveContainerAction(
    type:
      | "containersStart"
      | "containersStop"
      | "containersRestart"
      | "containersRemove",
  ): HostContainerAction {
    if (type === "containersStart") {
      return "start";
    }
    if (type === "containersStop") {
      return "stop";
    }
    if (type === "containersRestart") {
      return "restart";
    }
    return "remove";
  }

  private recordContainerActionLog(input: {
    actionId: string;
    endpointId: string;
    containerId: string;
    action: HostContainerAction;
    startedAt: string;
    status: ContainerActionLogMetadata["status"];
    errorMessage: string | null;
  }): void {
    const lifecycle = this.containerLifecycleByScopeId.get(input.endpointId);
    const endpoint = this.containerEndpoints.get(input.endpointId);
    const completedAt = new Date().toISOString();
    const metadata: ContainerActionLogMetadata = {
      actionId: input.actionId,
      hostId: lifecycle?.hostId ?? endpoint?.hostId ?? "",
      hostLabel: lifecycle?.hostLabel ?? endpoint?.hostId ?? "Unknown host",
      containerId: input.containerId,
      containerName:
        this.containerNamesByEndpointId
          .get(input.endpointId)
          ?.get(input.containerId) ?? null,
      runtime: endpoint?.runtime ?? lifecycle?.runtime ?? null,
      action: input.action,
      status: input.status,
      startedAt: input.startedAt,
      completedAt,
      durationMs: Math.max(
        0,
        new Date(completedAt).getTime() - new Date(input.startedAt).getTime(),
      ),
      errorMessage: input.errorMessage,
    };
    const actionLabel =
      input.action === "start"
        ? "시작"
        : input.action === "stop"
          ? "중지"
          : input.action === "restart"
            ? "재시작"
            : "삭제";
    this.upsertLog({
      id: `container-action:${input.actionId}`,
      level:
        input.status === "error"
          ? "error"
          : input.action === "remove"
            ? "warn"
            : "info",
      category: "audit",
      kind: "container-action",
      message: `컨테이너 ${actionLabel}`,
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: input.startedAt,
      updatedAt: completedAt,
    });
  }

  private getSessionLifecycleLogId(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private getSftpLifecycleLogId(endpointId: string): string {
    return `sftp:${endpointId}`;
  }

  private getConnectionKindLabel(kind: SessionConnectionKind): string {
    if (kind === "local") {
      return "Local";
    }
    if (kind === "aws-ssm") {
      return "AWS SSM";
    }
    if (kind === "aws-ecs-exec") {
      return "AWS ECS Exec";
    }
    if (kind === "serial") {
      return "Serial";
    }
    if (kind === "warpgate") {
      return "Warpgate";
    }
    if (kind === "mosh") {
      return "Mosh";
    }
    return "SSH";
  }

  private markSessionConnected(sessionId: string): void {
    const lifecycle = this.sessionLifecycleById.get(sessionId);
    if (!lifecycle || lifecycle.connectedAt) {
      return;
    }
    const connectedAt = new Date().toISOString();
    lifecycle.connectedAt = connectedAt;
    lifecycle.status = "connected";
    lifecycle.disconnectedAt = null;
    lifecycle.disconnectReason = null;
    this.sessionLifecycleById.set(sessionId, lifecycle);

    const metadata: SessionLifecycleLogMetadata = {
      sessionId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      title: lifecycle.title,
      connectionDetails: lifecycle.connectionDetails,
      connectionKind: lifecycle.connectionKind,
      connectedAt,
      disconnectedAt: null,
      durationMs: null,
      status: "connected",
      disconnectReason: null,
      recordingId: lifecycle.recordingId,
      hasReplay: lifecycle.hasReplay,
    };
    this.upsertLog({
      id: this.getSessionLifecycleLogId(sessionId),
      level: "info",
      category: "session",
      kind: "session-lifecycle",
      message: `${this.getConnectionKindLabel(lifecycle.connectionKind)} 세션`,
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    });
  }

  private finalizeSessionLifecycle(
    sessionId: string,
    status: "closed" | "error",
    disconnectReason: string | null,
  ): void {
    const lifecycle = this.sessionLifecycleById.get(sessionId);
    if (!lifecycle) {
      return;
    }
    if (lifecycle.disconnectedAt) {
      return;
    }
    // 로컬 터미널은 연결 전 실패를 lifecycle 로그로 남기지 않는다(generic 로그로만 처리).
    if (lifecycle.connectionKind === "local" && !lifecycle.connectedAt) {
      return;
    }
    const disconnectedAt = new Date().toISOString();
    // 연결 전 실패(connectedAt 없음)도 기록한다. 기준 시각은 실패 시각, duration은 null.
    const referenceAt = lifecycle.connectedAt ?? disconnectedAt;
    const durationMs = lifecycle.connectedAt
      ? Math.max(
          0,
          new Date(disconnectedAt).getTime() -
            new Date(lifecycle.connectedAt).getTime(),
        )
      : null;
    lifecycle.disconnectedAt = disconnectedAt;
    lifecycle.disconnectReason = disconnectReason;
    lifecycle.status = status;
    this.sessionLifecycleById.set(sessionId, lifecycle);

    const metadata: SessionLifecycleLogMetadata = {
      sessionId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      title: lifecycle.title,
      connectionDetails: lifecycle.connectionDetails,
      connectionKind: lifecycle.connectionKind,
      connectedAt: referenceAt,
      disconnectedAt,
      durationMs,
      status,
      disconnectReason,
      recordingId: lifecycle.recordingId,
      hasReplay: lifecycle.hasReplay,
    };
    this.upsertLog({
      id: this.getSessionLifecycleLogId(sessionId),
      level: status === "error" ? "error" : "info",
      category: "session",
      kind: "session-lifecycle",
      message: `${this.getConnectionKindLabel(lifecycle.connectionKind)} 세션`,
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: referenceAt,
      updatedAt: disconnectedAt,
    });
  }
}
