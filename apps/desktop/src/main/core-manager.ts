import { BrowserWindow, app } from "electron";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ActivityLogRecord,
  HostKeyProbeResult,
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
  ResolvedContainersConnectPayload,
  ResolvedCoreConnectPayload,
  ResolvedHostKeyProbePayload,
  ResolvedLocalConnectPayload,
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
  SftpEndpointSummary,
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
import { ipcChannels } from "../common/ipc-channels";
import {
  CoreFrameParser,
  encodeControlFrame,
  encodeStreamFrame,
} from "./core-framing";
import { resolveDesktopRepoRoot } from "./repo-root";

interface ActivityLogInput {
  level: "info" | "warn" | "error";
  category: "session" | "audit";
  message: string;
  metadata?: Record<string, unknown> | null;
}

interface RemoteSessionLifecycleState {
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

interface ContainersEndpointRuntime {
  hostId: string;
  runtime: HostContainerRuntime | null;
  runtimeCommand: string | null;
  unsupportedReason: string | null;
}

type SessionTransport = "ssh" | "aws-ssm" | "warpgate" | "local-shell" | "serial";

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
  private readonly tabs = new Map<string, TerminalTab>();
  private readonly sftpEndpoints = new Map<string, SftpEndpointSummary>();
  private readonly sftpPartialCleanupRecords = new Map<
    string,
    SftpPartialCleanupRecord
  >();
  private sftpPartialCleanupLoaded = false;
  private readonly containerEndpoints = new Map<
    string,
    ContainersEndpointRuntime
  >();
  private readonly transferJobs = new Map<string, TransferJob>();
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
  private readonly sessionTransportById = new Map<string, SessionTransport>();
  private readonly remoteSessionLifecycleById = new Map<
    string,
    RemoteSessionLifecycleState
  >();
  private onTerminalEvent?: (
    event: CoreEvent<Record<string, unknown>>,
  ) => void | Promise<void>;
  private onTerminalStream?: (
    sessionId: string,
    chunk: Uint8Array,
  ) => void | Promise<void>;
  private onPortForwardEvent?: (
    event: PortForwardRuntimeEvent,
  ) => void | Promise<void>;
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

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on("closed", () => {
      this.windows.delete(window);
    });
  }

  listTabs(): TerminalTab[] {
    return Array.from(this.tabs.values());
  }

  listPortForwardRuntimes(): PortForwardRuntimeRecord[] {
    return Array.from(this.portForwardRuntimes.values()).sort((a, b) =>
      a.ruleId.localeCompare(b.ruleId),
    );
  }

  getRemoteSessionLifecycleState(
    sessionId: string,
  ): RemoteSessionLifecycleState | null {
    const lifecycle = this.remoteSessionLifecycleById.get(sessionId);
    return lifecycle ? { ...lifecycle } : null;
  }

  attachRemoteSessionRecording(sessionId: string, recordingId: string): void {
    const lifecycle = this.remoteSessionLifecycleById.get(sessionId);
    if (!lifecycle) {
      return;
    }
    lifecycle.recordingId = recordingId;
    lifecycle.hasReplay = true;
    this.remoteSessionLifecycleById.set(sessionId, lifecycle);

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
      id: this.getRemoteSessionLifecycleLogId(sessionId),
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

    this.finalizeActiveRemoteSessionsOnShutdown();

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

  private finalizeActiveRemoteSessionsOnShutdown(): void {
    for (const [sessionId, lifecycle] of this.remoteSessionLifecycleById) {
      if (!lifecycle.connectedAt || lifecycle.disconnectedAt) {
        continue;
      }

      this.finalizeRemoteSessionLifecycle(
        sessionId,
        "closed",
        SHUTDOWN_SESSION_DISCONNECT_REASON,
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
      this.clearRuntimeState();
      this.process = null;
      this.isShuttingDown = false;
    });
  }

  async connect(
    payload: ResolvedCoreConnectPayload & {
      title: string;
      hostId: string;
      hostLabel: string;
      transport?: "ssh" | "warpgate" | "aws-ssm";
    },
  ): Promise<{ sessionId: string }> {
    await this.start();
    // 세션 ID는 Electron 쪽에서 먼저 발급해서 탭과 SSH 세션을 동일한 식별자로 묶는다.
    const sessionId = randomUUID();
    this.sessionTransportById.set(sessionId, payload.transport ?? "ssh");
    this.remoteSessionLifecycleById.set(sessionId, {
      hostId: payload.hostId,
      hostLabel: payload.hostLabel,
      title: payload.title,
      connectionDetails: `${payload.host} · ${payload.port} · ${payload.username}`,
      connectionKind:
        payload.transport === "warpgate"
          ? "warpgate"
          : payload.transport === "aws-ssm"
            ? "aws-ssm"
            : "ssh",
      connectedAt: null,
      disconnectedAt: null,
      disconnectReason: null,
      status: null,
      recordingId: null,
      hasReplay: false,
    });
    this.tabs.set(sessionId, {
      id: sessionId,
      title: payload.title,
      source: "host",
      hostId: payload.hostId,
      sessionId,
      status: "connecting",
      lastEventAt: new Date().toISOString(),
    });
    this.sendControl<ResolvedCoreConnectPayload>({
      id: randomUUID(),
      type: "connect",
      sessionId,
      payload,
    });
    return { sessionId };
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
    return { runtime, runtimeCommand, unsupportedReason };
  }

  async containersDisconnect(endpointId: string): Promise<void> {
    this.containerEndpoints.delete(endpointId);
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
  ): Promise<HostContainerLogSearchResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "containersSearchLogs",
        endpointId,
        payload: { containerId, tail, query },
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
  }): Promise<{ sessionId: string }> {
    await this.start();
    const sessionId = randomUUID();
    this.sessionTransportById.set(sessionId, "aws-ssm");
    this.remoteSessionLifecycleById.set(sessionId, {
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
    const tab: TerminalTab = {
      id: sessionId,
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
    };
    this.sendControl<ResolvedAwsConnectPayload>({
      id: randomUUID(),
      type: "awsConnect",
      sessionId,
      payload: resolvedPayload,
    });

    return { sessionId };
  }

  async connectLocalSession(payload: {
    cols: number;
    rows: number;
    title: string;
    shellKind?: string;
    executable?: string;
    args?: string[];
    env?: Record<string, string>;
    workingDirectory?: string | null;
  }): Promise<{ sessionId: string }> {
    await this.start();
    const sessionId = randomUUID();
    this.sessionTransportById.set(sessionId, "local-shell");
    this.tabs.set(sessionId, {
      id: sessionId,
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
    this.sessionTransportById.set(sessionId, "serial");
    const targetDescription =
      payload.transport === "local"
        ? payload.devicePath ?? "Local serial port"
        : `${payload.transport} · ${payload.host ?? ""}:${payload.port ?? ""}`.replace(/:$/, "");
    this.remoteSessionLifecycleById.set(sessionId, {
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

    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: "ssmPortForwardStart",
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
    await this.start();
    const { endpointId, ...connectPayload } = payload;
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
      this.log({
        level: "info",
        category: "session",
        message: "SFTP 연결이 시작되었습니다.",
        metadata: {
          endpointId,
          hostId: payload.hostId,
          title: payload.title,
        },
      });
      void this.cleanupSftpPartialRecordsForHost(payload.hostId, endpointId);
      return summary;
    } catch (error) {
      this.log({
        level: "error",
        category: "session",
        message: "SFTP 연결 오류가 발생했습니다.",
        metadata: {
          hostId: payload.hostId,
          title: payload.title,
          message: error instanceof Error ? error.message : "unknown error",
        },
      });
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
      this.log({
        level: "info",
        category: "session",
        message: "SFTP 연결이 종료되었습니다.",
        metadata: { endpointId },
      });
    } catch (error) {
      this.log({
        level: "error",
        category: "session",
        message: "SFTP 연결 종료 중 오류가 발생했습니다.",
        metadata: {
          endpointId,
          message: error instanceof Error ? error.message : "unknown error",
        },
      });
      throw error;
    }
  }

  async sftpList(input: SftpListInput): Promise<DirectoryListing> {
    await this.start();
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
    return listing;
  }

  async sftpMkdir(input: SftpMkdirInput): Promise<void> {
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "sftpMkdir",
        endpointId: input.endpointId,
        payload: input,
      },
      ["sftpAck"],
    );
  }

  async sftpRename(input: SftpRenameInput): Promise<void> {
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "sftpRename",
        endpointId: input.endpointId,
        payload: input,
      },
      ["sftpAck"],
    );
  }

  async sftpChmod(input: SftpChmodInput): Promise<void> {
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "sftpChmod",
        endpointId: input.endpointId,
        payload: input,
      },
      ["sftpAck"],
    );
  }

  async sftpChown(input: SftpChownInput): Promise<void> {
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "sftpChown",
        endpointId: input.endpointId,
        payload: input,
      },
      ["sftpAck"],
    );
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
    await this.requestResponse(
      {
        id: randomUUID(),
        type: "sftpDelete",
        endpointId: input.endpointId,
        payload: input,
      },
      ["sftpAck"],
    );
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

  write(sessionId: string, data: string): void {
    const tab = this.tabs.get(sessionId);
    // 아직 연결이 성립되지 않은 탭의 입력은 코어로 보내지 않아 "session not found" 오류를 막는다.
    if (!tab || tab.status !== "connected") {
      return;
    }
    if (this.sessionTransportById.get(sessionId) === "aws-ssm") {
      const controlSignal = resolveAwsSsmControlSignal(
        Buffer.from(data, "utf8"),
      );
      if (controlSignal) {
        this.sendControlSignal(sessionId, controlSignal);
        return;
      }
    }
    this.sendStream(
      {
        type: "write",
        sessionId,
      },
      Buffer.from(data, "utf8"),
    );
  }

  writeBinary(sessionId: string, data: Uint8Array): void {
    const tab = this.tabs.get(sessionId);
    // 마우스 보고 등 raw 입력도 연결 완료 이후에만 전달한다.
    if (!tab || tab.status !== "connected") {
      return;
    }
    if (this.sessionTransportById.get(sessionId) === "aws-ssm") {
      const controlSignal = resolveAwsSsmControlSignal(data);
      if (controlSignal) {
        this.sendControlSignal(sessionId, controlSignal);
        return;
      }
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
    if (this.sessionTransportById.get(sessionId) !== "aws-ssm") {
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
    const tab = this.tabs.get(sessionId);
    if (!tab) {
      return;
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
    const tab = this.tabs.get(sessionId);
    if (!tab || tab.status !== "connected") {
      return;
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
    this.sendControl({
      id: randomUUID(),
      type: "resize",
      sessionId,
      payload: desiredSize,
    });
  }

  disconnect(sessionId: string): void {
    this.desiredResizeBySession.delete(sessionId);
    this.sentResizeBySession.delete(sessionId);
    const tab = this.tabs.get(sessionId);
    if (!tab) {
      return;
    }
    // 코어에 실제 세션 핸들이 없을 수 있는 connecting/error 탭은 로컬에서 바로 닫아준다.
    if (!this.process || tab.status !== "connected") {
      this.sessionTransportById.delete(sessionId);
      this.tabs.delete(sessionId);
      this.broadcastTerminalEvent({
        type: "closed",
        sessionId,
        payload: {
          message: "client requested disconnect",
        },
      });
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: "disconnect",
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

  private handleControlEvent(event: CoreEvent<Record<string, unknown>>): void {
    this.resolvePendingResponse(event);

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
        this.clearSftpPartialRecordsForJob(next.job.id);
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
      const isAwsSession = transport === "aws-ssm";
      const isWarpgateSession = transport === "warpgate";
      const isLocalSession = transport === "local-shell";
      const remoteLifecycle = this.remoteSessionLifecycleById.get(event.sessionId);
      const resolvedLocalShellKind =
        isLocalSession && typeof event.payload.shellKind === "string"
          ? event.payload.shellKind
          : null;
      if (!existing && event.type === "closed") {
        this.sessionTransportById.delete(event.sessionId);
        this.remoteSessionLifecycleById.delete(event.sessionId);
      }
      if (existing) {
        if (event.type === "closed") {
          this.sessionTransportById.delete(event.sessionId);
          this.tabs.delete(event.sessionId);
          this.desiredResizeBySession.delete(event.sessionId);
          this.sentResizeBySession.delete(event.sessionId);
          if (isLocalSession || !remoteLifecycle) {
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
          } else if (!remoteLifecycle.disconnectedAt) {
            this.finalizeRemoteSessionLifecycle(
              event.sessionId,
              "closed",
              typeof event.payload.message === "string"
                ? event.payload.message
                : null,
            );
          }
          this.remoteSessionLifecycleById.delete(event.sessionId);
          this.broadcastTerminalEvent(event);
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
          if (isLocalSession || !remoteLifecycle) {
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
            this.markRemoteSessionConnected(event.sessionId);
          }
        }
        if (event.type === "error") {
          if (isLocalSession || !remoteLifecycle) {
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
          } else if (remoteLifecycle.connectedAt) {
            this.finalizeRemoteSessionLifecycle(
              event.sessionId,
              "error",
              typeof event.payload.message === "string"
                ? event.payload.message
                : null,
            );
          } else {
            this.log({
              level: "error",
              category: "session",
              message: `${this.getConnectionKindLabel(remoteLifecycle.connectionKind)} 세션 오류가 발생했습니다.`,
              metadata: {
                sessionId: event.sessionId,
                hostId: remoteLifecycle.hostId,
                hostLabel: remoteLifecycle.hostLabel,
                title: remoteLifecycle.title,
                connectionKind: remoteLifecycle.connectionKind,
                message: event.payload.message ?? null,
              },
            });
            this.remoteSessionLifecycleById.delete(event.sessionId);
          }
        }
      }
      this.broadcastTerminalEvent(event);
      return;
    }

    if (event.type === "status" || event.type === "error") {
      this.broadcastTerminalEvent(event);
    }
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

  private describeTransferEndpoint(
    endpoint: TransferStartInput["source"],
  ): string {
    if (endpoint.kind === "local") {
      return "Local";
    }
    return this.sftpEndpoints.get(endpoint.endpointId)?.title ?? "Remote";
  }

  private clearRuntimeState(): void {
    this.tabs.clear();
    this.sftpEndpoints.clear();
    this.containerEndpoints.clear();
    this.transferJobs.clear();
    this.portForwardDefinitions.clear();
    this.portForwardRuntimes.clear();
    this.desiredResizeBySession.clear();
    this.sentResizeBySession.clear();
    this.sessionTransportById.clear();
    this.remoteSessionLifecycleById.clear();
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
    // 여러 윈도우가 열려 있어도 동일한 코어 상태를 함께 받도록 fan-out 한다.
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.ssh.event, event);
      }
    }
    void this.onTerminalEvent?.(event);
  }

  private broadcastTransferEvent(event: TransferJobEvent): void {
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
    // 터미널 데이터는 별도 채널로 보내 renderer store를 거치지 않고 xterm으로 직결한다.
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.ssh.data, {
          sessionId: metadata.sessionId,
          chunk: new Uint8Array(payload),
        });
      }
    }
    void this.onTerminalStream?.(metadata.sessionId, new Uint8Array(payload));
  }

  private log(entry: ActivityLogInput): void {
    this.appendLog?.(entry);
  }

  private upsertLog(record: ActivityLogRecord): void {
    this.upsertLogRecord?.(record);
  }

  private getRemoteSessionLifecycleLogId(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private getConnectionKindLabel(kind: SessionConnectionKind): string {
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
    return "SSH";
  }

  private markRemoteSessionConnected(sessionId: string): void {
    const lifecycle = this.remoteSessionLifecycleById.get(sessionId);
    if (!lifecycle || lifecycle.connectedAt) {
      return;
    }
    const connectedAt = new Date().toISOString();
    lifecycle.connectedAt = connectedAt;
    lifecycle.status = "connected";
    lifecycle.disconnectedAt = null;
    lifecycle.disconnectReason = null;
    this.remoteSessionLifecycleById.set(sessionId, lifecycle);

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
      id: this.getRemoteSessionLifecycleLogId(sessionId),
      level: "info",
      category: "session",
      kind: "session-lifecycle",
      message: `${this.getConnectionKindLabel(lifecycle.connectionKind)} 세션`,
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    });
  }

  private finalizeRemoteSessionLifecycle(
    sessionId: string,
    status: "closed" | "error",
    disconnectReason: string | null,
  ): void {
    const lifecycle = this.remoteSessionLifecycleById.get(sessionId);
    if (!lifecycle || !lifecycle.connectedAt) {
      return;
    }
    if (lifecycle.disconnectedAt) {
      return;
    }
    const disconnectedAt = new Date().toISOString();
    const durationMs = Math.max(
      0,
      new Date(disconnectedAt).getTime() -
        new Date(lifecycle.connectedAt).getTime(),
    );
    lifecycle.disconnectedAt = disconnectedAt;
    lifecycle.disconnectReason = disconnectReason;
    lifecycle.status = status;
    this.remoteSessionLifecycleById.set(sessionId, lifecycle);

    const metadata: SessionLifecycleLogMetadata = {
      sessionId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      title: lifecycle.title,
      connectionDetails: lifecycle.connectionDetails,
      connectionKind: lifecycle.connectionKind,
      connectedAt: lifecycle.connectedAt,
      disconnectedAt,
      durationMs,
      status,
      disconnectReason,
      recordingId: lifecycle.recordingId,
      hasReplay: lifecycle.hasReplay,
    };
    this.upsertLog({
      id: this.getRemoteSessionLifecycleLogId(sessionId),
      level: status === "error" ? "error" : "info",
      category: "session",
      kind: "session-lifecycle",
      message: `${this.getConnectionKindLabel(lifecycle.connectionKind)} 세션`,
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: lifecycle.connectedAt,
      updatedAt: disconnectedAt,
    });
  }
}
