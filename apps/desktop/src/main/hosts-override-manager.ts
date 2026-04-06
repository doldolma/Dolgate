import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as execWithSudoPrompt } from '@vscode/sudo-prompt';
import { app } from 'electron';
import {
  type DnsOverrideResolvedRecord,
  isDnsOverrideEligiblePortForwardRule,
  isLinkedDnsOverrideRecord,
  isLoopbackBindAddress,
  isStaticDnsOverrideRecord,
} from '@shared';
import type { DnsOverrideRecord, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';
import { resolveDesktopRepoRoot } from './repo-root';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_READY_TIMEOUT_MS = 15_000;
const HELPER_READY_POLL_INTERVAL_MS = 200;
const HELPER_CONNECT_TIMEOUT_MS = 1_000;
const DARWIN_MAX_UNIX_SOCKET_PATH_LENGTH = 103;

export const HOSTS_MANAGED_BLOCK_START = '# >>> dolssh managed dns overrides >>>';
export const HOSTS_MANAGED_BLOCK_END = '# <<< dolssh managed dns overrides <<<';
export const DOLGATE_DNS_HELPER_BINARY_NAME = process.platform === 'win32' ? 'dolgate-dns-helper.exe' : 'dolgate-dns-helper';
export const DOLGATE_DNS_HELPER_PROMPT_NAME = 'Dolgate DNS Helper';

export type HostsOverrideFailureStage =
  | 'permission-denied'
  | 'helper-not-ready'
  | 'helper-rpc'
  | 'hosts-verification';

export class HostsOverrideError extends Error {
  constructor(
    public readonly stage: HostsOverrideFailureStage,
    message: string,
    public readonly rawError: string | null = null,
  ) {
    super(message);
    this.name = 'HostsOverrideError';
  }
}

export function describeHostsOverrideFailure(
  error: unknown,
  fallbackMessage: string,
): {
  stage: HostsOverrideFailureStage | 'unknown';
  message: string;
  rawError: string | null;
} {
  if (error instanceof HostsOverrideError) {
    return {
      stage: error.stage,
      message: error.message,
      rawError: error.rawError,
    };
  }

  const rawError = error instanceof Error ? error.message : String(error);
  return {
    stage: 'unknown',
    message: fallbackMessage,
    rawError,
  };
}

export interface ActiveDnsOverrideEntry {
  hostname: string;
  address: string;
  ruleId: string;
}

export interface HostsHelperRpcRequest {
  command: 'ping' | 'rewrite-block' | 'clear-block' | 'read-hosts' | 'shutdown';
  authToken: string;
  hostsFilePath?: string;
  entries?: Array<{ address: string; hostname: string }>;
}

export interface HostsHelperRpcResponse {
  ok: boolean;
  error?: string;
  hostsFileContent?: string;
}

export interface HostsHelperClient {
  send(request: HostsHelperRpcRequest): Promise<HostsHelperRpcResponse>;
  close(): void;
}

export interface HostsHelperLaunchOptions {
  platform: NodeJS.Platform;
  helperPath: string;
  hostsFilePath: string;
  endpoint: string;
  authToken: string;
  logPath?: string;
}

interface PendingMacElevatedCommand {
  state: {
    settled: boolean;
    error: unknown | null;
  };
  completion: Promise<void>;
}

export interface HostsOverrideManagerOptions {
  hostsFilePath?: string;
  helperPath?: string;
  platform?: NodeJS.Platform;
  tempDirectory?: string;
  launchTimeoutMs?: number;
  launchPollIntervalMs?: number;
  connectTimeoutMs?: number;
  fileReader?: (targetPath: string) => Promise<string>;
  clientFactory?: (endpoint: string) => Promise<HostsHelperClient>;
  launchHelper?: (options: HostsHelperLaunchOptions) => Promise<void>;
  uuidFactory?: () => string;
}

export function hasManagedHostsBlock(content: string): boolean {
  return content.includes(HOSTS_MANAGED_BLOCK_START) || content.includes(HOSTS_MANAGED_BLOCK_END);
}

export function collectActiveDnsOverrideEntries(
  overrides: DnsOverrideRecord[],
  rules: PortForwardRuleRecord[],
  runtimes: PortForwardRuntimeRecord[],
  activeStaticOverrideIds: ReadonlySet<string> = new Set(),
): ActiveDnsOverrideEntry[] {
  const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));
  const runtimeMap = new Map(runtimes.map((runtime) => [runtime.ruleId, runtime]));
  const seen = new Set<string>();
  const entries: ActiveDnsOverrideEntry[] = [];

  for (const override of overrides) {
    const hostname = override.hostname.trim().toLowerCase();
    let address = '';

    if (isStaticDnsOverrideRecord(override)) {
      if (!activeStaticOverrideIds.has(override.id)) {
        continue;
      }
      address = override.address.trim();
    } else if (isLinkedDnsOverrideRecord(override)) {
      const rule = ruleMap.get(override.portForwardRuleId);
      const runtime = runtimeMap.get(override.portForwardRuleId);
      if (!rule || !runtime || runtime.status !== 'running') {
        continue;
      }
      if (!isDnsOverrideEligiblePortForwardRule(rule) || !isLoopbackBindAddress(runtime.bindAddress)) {
        continue;
      }
      address = runtime.bindAddress.trim();
    } else {
      continue;
    }

    const key = `${hostname}\u0000${address}`;
    if (!hostname || !address || seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({
      hostname,
      address,
      ruleId: isLinkedDnsOverrideRecord(override) ? override.portForwardRuleId : override.id,
    });
  }

  return entries.sort((left, right) => left.hostname.localeCompare(right.hostname) || left.address.localeCompare(right.address));
}

export function resolveDnsOverrideRecords(
  overrides: DnsOverrideRecord[],
  rules: PortForwardRuleRecord[],
  runtimes: PortForwardRuntimeRecord[],
  activeStaticOverrideIds: ReadonlySet<string> = new Set(),
): DnsOverrideResolvedRecord[] {
  const activeKeys = new Set(
    collectActiveDnsOverrideEntries(overrides, rules, runtimes, activeStaticOverrideIds).map(
      (entry) => `${entry.hostname}\u0000${entry.ruleId}`,
    ),
  );

  return overrides.map((override) => ({
    ...override,
    status: activeKeys.has(`${override.hostname.trim().toLowerCase()}\u0000${isLinkedDnsOverrideRecord(override) ? override.portForwardRuleId : override.id}`)
      ? 'active'
      : 'inactive',
  }));
}

export function buildHostsHelperPayload(entries: ActiveDnsOverrideEntry[]): string {
  return Buffer.from(
    JSON.stringify(entries.map((entry) => ({ address: entry.address, hostname: entry.hostname }))),
    'utf8',
  ).toString('base64');
}

export function buildHostsHelperServeArgs(endpoint: string, authToken: string, hostsFilePath: string): string[] {
  return ['serve', '--endpoint', endpoint, '--auth-token', authToken, '--hosts-file', hostsFilePath];
}

export function buildWindowsElevationCommand(helperPath: string, args: string[]): string {
  const renderValue = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return `$p = Start-Process -FilePath ${renderValue(helperPath)} -ArgumentList @(${args.map(renderValue).join(', ')}) -Verb RunAs -WindowStyle Hidden -PassThru; if ($null -eq $p) { exit 1 }`;
}

export function buildMacElevationCommand(
  helperPath: string,
  args: string[],
  logPath: string = '/dev/null',
): string {
  const quoteShell = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
  return `${[quoteShell(helperPath), ...args.map(quoteShell)].join(' ')} >${quoteShell(logPath)} 2>&1 </dev/null`;
}

function buildDarwinHelperLogPath(endpoint: string): string {
  return `${endpoint}.log`;
}

export function buildHostsHelperEndpoint(
  platform: NodeJS.Platform = process.platform,
  id: string = randomUUID(),
  tempDirectory: string = tmpdir(),
): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\dolgate-dns-helper-${process.pid}-${id}`;
  }
  if (platform === 'darwin') {
    const normalizedTempDirectory = tempDirectory.replace(/\\/g, '/');
    const compactId = id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(-10) || 'helper';
    const socketBasename = `dgdns-${process.pid}-${compactId}.sock`;
    const preferredEndpoint = path.posix.join(normalizedTempDirectory, socketBasename);
    if (preferredEndpoint.length <= DARWIN_MAX_UNIX_SOCKET_PATH_LENGTH) {
      return preferredEndpoint;
    }
    const fallbackEndpoint = path.posix.join('/tmp', socketBasename);
    if (fallbackEndpoint.length <= DARWIN_MAX_UNIX_SOCKET_PATH_LENGTH) {
      return fallbackEndpoint;
    }
    throw new Error(
      `Unable to build a valid Dolgate DNS Helper socket endpoint within ${DARWIN_MAX_UNIX_SOCKET_PATH_LENGTH} characters`,
    );
  }
  throw new Error(`Hosts overrides are not supported on platform: ${platform}`);
}

function resolveRepoRoot(): string {
  return resolveDesktopRepoRoot({
    appPath: app.getAppPath(),
    currentDir: __dirname,
  });
}

export function resolveHostsHelperPath(): string {
  const binaryName = DOLGATE_DNS_HELPER_BINARY_NAME;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', binaryName);
  }

  const repoRoot = resolveRepoRoot();
  const devPath =
    process.platform === 'win32'
      ? path.join(repoRoot, 'apps', 'desktop', 'release', 'resources', 'win32', 'x64', 'bin', binaryName)
      : path.join(repoRoot, 'apps', 'desktop', 'release', 'resources', 'darwin', 'universal', 'bin', binaryName);
  if (!existsSync(devPath)) {
    throw new Error(`Local Dolgate DNS Helper binary not found: ${devPath}`);
  }
  return devPath;
}

export function resolveHostsFilePath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || 'C:\\Windows';
    return path.join(systemRoot, 'System32', 'drivers', 'etc', 'hosts');
  }
  if (platform === 'darwin') {
    return '/etc/hosts';
  }
  throw new Error(`Hosts overrides are not supported on platform: ${platform}`);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'null'}`));
    });
  });
}

function normalizeUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isPermissionDeniedMessage(message: string): boolean {
  return /user did not grant permission/i.test(message);
}

async function runMacElevatedCommand(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execWithSudoPrompt(
      command,
      { name: DOLGATE_DNS_HELPER_PROMPT_NAME },
      (error) => {
        if (!error) {
          resolve();
          return;
        }
        reject(error);
      },
    );
  });
}

function startMacElevatedCommand(command: string): PendingMacElevatedCommand {
  const state: PendingMacElevatedCommand['state'] = {
    settled: false,
    error: null,
  };
  const completion = new Promise<void>((resolve, reject) => {
    execWithSudoPrompt(
      command,
      { name: DOLGATE_DNS_HELPER_PROMPT_NAME },
      (error) => {
        state.settled = true;
        state.error = error ?? null;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
  completion.catch(() => undefined);
  return { state, completion };
}

function toMacLaunchHostsOverrideError(error: unknown): HostsOverrideError {
  const rawError = normalizeUnknownErrorMessage(error);
  if (isPermissionDeniedMessage(rawError)) {
    return new HostsOverrideError(
      'permission-denied',
      'DNS Override 권한 승인이 취소되었습니다.',
      rawError,
    );
  }
  return new HostsOverrideError(
    'helper-not-ready',
    'Dolgate DNS Helper를 시작하지 못했습니다.',
    rawError,
  );
}

async function launchElevatedHelper(options: HostsHelperLaunchOptions): Promise<void> {
  const args = buildHostsHelperServeArgs(options.endpoint, options.authToken, options.hostsFilePath);
  if (options.platform === 'win32') {
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      buildWindowsElevationCommand(options.helperPath, args),
    ]);
    return;
  }
  if (options.platform === 'darwin') {
    try {
      await runMacElevatedCommand(
        buildMacElevationCommand(
          options.helperPath,
          args,
          options.logPath ?? buildDarwinHelperLogPath(options.endpoint),
        ),
      );
    } catch (error) {
      const rawError = normalizeUnknownErrorMessage(error);
      if (isPermissionDeniedMessage(rawError)) {
        throw new HostsOverrideError(
          'permission-denied',
          'DNS Override 권한 승인이 취소되었습니다.',
          rawError,
        );
      }
      throw new HostsOverrideError(
        'helper-not-ready',
        'Dolgate DNS Helper를 시작하지 못했습니다.',
        rawError,
      );
    }
    return;
  }
  throw new Error(`Hosts overrides are not supported on platform: ${options.platform}`);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

class JsonSocketHostsHelperClient implements HostsHelperClient {
  private buffer = '';
  private pending:
    | {
        resolve: (response: HostsHelperRpcResponse) => void;
        reject: (error: Error) => void;
      }
    | null = null;
  private closedError: Error | null = null;

  constructor(private readonly socket: Socket) {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.handleData(chunk);
    });
    this.socket.on('error', (error) => {
      this.handleDisconnect(error instanceof Error ? error : new Error(String(error)));
    });
    this.socket.on('close', () => {
      this.handleDisconnect(new Error('Dolgate DNS Helper connection closed'));
    });
  }

  send(request: HostsHelperRpcRequest): Promise<HostsHelperRpcResponse> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    if (this.pending) {
      return Promise.reject(new Error('Dolgate DNS Helper does not support concurrent requests'));
    }

    return new Promise<HostsHelperRpcResponse>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) {
          return;
        }
        const nextError = error instanceof Error ? error : new Error(String(error));
        const pending = this.pending;
        this.pending = null;
        pending?.reject(nextError);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const lineBreakIndex = this.buffer.indexOf('\n');
      if (lineBreakIndex < 0) {
        return;
      }
      const rawLine = this.buffer.slice(0, lineBreakIndex).trim();
      this.buffer = this.buffer.slice(lineBreakIndex + 1);
      if (!rawLine) {
        continue;
      }

      const pending = this.pending;
      this.pending = null;
      if (!pending) {
        continue;
      }

      try {
        pending.resolve(JSON.parse(rawLine) as HostsHelperRpcResponse);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleDisconnect(error: Error): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }
}

async function createHostsHelperClient(endpoint: string, timeoutMs: number): Promise<HostsHelperClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = createConnection(endpoint);
    const timeoutHandle = setTimeout(() => {
      client.destroy(new Error(`Dolgate DNS Helper connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const handleError = (error: Error) => {
      client.removeListener('connect', handleConnect);
      clearTimeout(timeoutHandle);
      reject(error);
    };
    const handleConnect = () => {
      client.removeListener('error', handleError);
      clearTimeout(timeoutHandle);
      resolve(client);
    };

    client.once('error', handleError);
    client.once('connect', handleConnect);
  });

  return new JsonSocketHostsHelperClient(socket);
}

function normalizeManagedHostsLine(address: string, hostname: string): string {
  return `${address.trim()} ${hostname.trim().toLowerCase()}`;
}

function extractManagedHostsLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const managedLines: string[] = [];
  let insideManagedBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === HOSTS_MANAGED_BLOCK_START) {
      insideManagedBlock = true;
      continue;
    }
    if (trimmed === HOSTS_MANAGED_BLOCK_END) {
      insideManagedBlock = false;
      continue;
    }
    if (!insideManagedBlock || !trimmed) {
      continue;
    }
    const [address, hostname] = trimmed.split(/\s+/, 2);
    if (!address || !hostname) {
      continue;
    }
    managedLines.push(normalizeManagedHostsLine(address, hostname));
  }
  return managedLines.sort((left, right) => left.localeCompare(right));
}

function buildExpectedManagedHostsLines(entries: ActiveDnsOverrideEntry[]): string[] {
  return entries
    .map((entry) => normalizeManagedHostsLine(entry.address, entry.hostname))
    .sort((left, right) => left.localeCompare(right));
}

function verifyManagedHostsRewrite(content: string, entries: ActiveDnsOverrideEntry[]): string | null {
  const hasStart = content.includes(HOSTS_MANAGED_BLOCK_START);
  const hasEnd = content.includes(HOSTS_MANAGED_BLOCK_END);
  if (!hasStart || !hasEnd) {
    return 'hosts 파일에서 관리 블록을 찾지 못했습니다.';
  }

  const actual = extractManagedHostsLines(content);
  const expected = buildExpectedManagedHostsLines(entries);
  if (actual.length !== expected.length) {
    return `hosts 파일의 override 개수가 예상과 다릅니다. expected=${expected.length} actual=${actual.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return `hosts 파일의 override 내용이 예상과 다릅니다. expected=${expected.join(', ')} actual=${actual.join(', ')}`;
    }
  }
  return null;
}

function verifyManagedHostsCleared(content: string): string | null {
  if (content.includes(HOSTS_MANAGED_BLOCK_START) || content.includes(HOSTS_MANAGED_BLOCK_END)) {
    return 'hosts 파일의 관리 블록이 제거되지 않았습니다.';
  }
  return null;
}

async function readHelperLaunchLogTail(logPath: string | null | undefined): Promise<string | null> {
  if (!logPath) {
    return null;
  }
  try {
    const content = await readFile(logPath, 'utf8');
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return null;
    }
    return lines.slice(-5).join(' | ').slice(0, 600);
  } catch {
    return null;
  }
}

function combineHelperReadyDetails(lastErrorMessage: string | null | undefined, logTail: string | null): string {
  const details = [lastErrorMessage?.trim(), logTail?.trim()].filter(Boolean);
  if (details.length === 0) {
    return 'unknown error';
  }
  return details.join(' | helper log: ');
}

function isPermissionReadError(error: unknown): boolean {
  const message = normalizeUnknownErrorMessage(error);
  return /EACCES|EPERM|permission denied/i.test(message);
}

interface HelperSession {
  endpoint: string;
  authToken: string;
  client: HostsHelperClient;
}

export class HostsOverrideManager {
  private queue = Promise.resolve();
  private session: HelperSession | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly activeStaticOverrideIds = new Set<string>();
  private readonly hostsFilePath: string;
  private readonly helperPathOverride: string | null;
  private readonly platform: NodeJS.Platform;
  private readonly tempDirectory: string;
  private readonly launchTimeoutMs: number;
  private readonly launchPollIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly readHostsFile: (targetPath: string) => Promise<string>;
  private readonly createClient: (endpoint: string) => Promise<HostsHelperClient>;
  private readonly launchHelper: (options: HostsHelperLaunchOptions) => Promise<void>;
  private readonly uuidFactory: () => string;
  private readonly usesCustomLaunchHelper: boolean;

  constructor(options?: HostsOverrideManagerOptions) {
    this.platform = options?.platform ?? process.platform;
    this.hostsFilePath = options?.hostsFilePath ?? resolveHostsFilePath(this.platform);
    this.helperPathOverride = options?.helperPath ?? null;
    this.tempDirectory = options?.tempDirectory ?? tmpdir();
    this.launchTimeoutMs = options?.launchTimeoutMs ?? HELPER_READY_TIMEOUT_MS;
    this.launchPollIntervalMs = options?.launchPollIntervalMs ?? HELPER_READY_POLL_INTERVAL_MS;
    this.connectTimeoutMs = options?.connectTimeoutMs ?? HELPER_CONNECT_TIMEOUT_MS;
    this.readHostsFile = options?.fileReader ?? ((targetPath) => readFile(targetPath, 'utf8'));
    this.createClient = options?.clientFactory ?? ((endpoint) => createHostsHelperClient(endpoint, this.connectTimeoutMs));
    this.launchHelper = options?.launchHelper ?? launchElevatedHelper;
    this.uuidFactory = options?.uuidFactory ?? randomUUID;
    this.usesCustomLaunchHelper = Boolean(options?.launchHelper);
  }

  hasManagedHostsBlock(): Promise<boolean> {
    return this.shouldTouchHostsFile();
  }

  async ensureReady(): Promise<void> {
    await this.ensureReadyInternal();
  }

  getActiveStaticOverrideIds(): ReadonlySet<string> {
    return this.activeStaticOverrideIds;
  }

  setStaticOverrideActive(id: string, active: boolean): void {
    if (active) {
      this.activeStaticOverrideIds.add(id);
      return;
    }
    this.activeStaticOverrideIds.delete(id);
  }

  removeStaticOverrideState(id: string): void {
    this.activeStaticOverrideIds.delete(id);
  }

  clearStaticOverrideStates(): void {
    this.activeStaticOverrideIds.clear();
  }

  pruneStaticOverrideStates(validIds: Iterable<string>): void {
    const next = new Set(validIds);
    for (const id of this.activeStaticOverrideIds) {
      if (!next.has(id)) {
        this.activeStaticOverrideIds.delete(id);
      }
    }
  }

  rewrite(entries: ActiveDnsOverrideEntry[]): Promise<void> {
    return this.enqueue(async () => {
      if (entries.length === 0) {
        await this.clearInternal();
        return;
      }

      await this.ensureReadyInternal();
      await this.sendRequest({
        command: 'rewrite-block',
        authToken: this.requireSession().authToken,
        hostsFilePath: this.hostsFilePath,
        entries: entries.map((entry) => ({ address: entry.address, hostname: entry.hostname })),
      });
      await this.verifyRewriteResult(entries);
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.clearInternal();
    });
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      const shouldClearHosts = this.session !== null || (await this.shouldTouchHostsFile());
      this.clearStaticOverrideStates();
      if (!shouldClearHosts) {
        return;
      }

      try {
        await this.clearInternal();
      } catch {
        // 앱 종료 시 cleanup은 최선의 시도로만 처리한다.
      }

      const session = this.session;
      if (!session) {
        return;
      }

      try {
        await session.client.send({
          command: 'shutdown',
          authToken: session.authToken,
        });
      } catch {
        // helper가 이미 내려간 경우에도 앱 종료는 계속 진행한다.
      } finally {
        await this.disposeSession();
      }
    });
  }

  private requireSession(): HelperSession {
    if (!this.session) {
      throw new Error('Dolgate DNS Helper session is not ready');
    }
    return this.session;
  }

  private async clearInternal(): Promise<void> {
    if (!this.session && !(await this.shouldTouchHostsFile())) {
      return;
    }

    await this.ensureReadyInternal();
    await this.sendRequest({
      command: 'clear-block',
      authToken: this.requireSession().authToken,
      hostsFilePath: this.hostsFilePath,
    });
    await this.verifyClearResult();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async shouldTouchHostsFile(): Promise<boolean> {
    try {
      const content = await this.readHostsFile(this.hostsFilePath);
      return hasManagedHostsBlock(content);
    } catch {
      return false;
    }
  }

  private async ensureReadyInternal(): Promise<void> {
    const currentSession = this.session;
    if (currentSession) {
      try {
        const response = await currentSession.client.send({
          command: 'ping',
          authToken: currentSession.authToken,
        });
        if (response.ok) {
          return;
        }
      } catch {
        // reconnect path below
      }
      await this.disposeSession();
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.launchHelperSession().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  private async launchHelperSession(): Promise<void> {
    const endpoint = buildHostsHelperEndpoint(this.platform, this.uuidFactory(), this.tempDirectory);
    const authToken = this.uuidFactory();
    const helperPath = this.helperPathOverride ?? resolveHostsHelperPath();
    const helperLogPath = this.platform === 'darwin' ? buildDarwinHelperLogPath(endpoint) : null;
    let pendingMacLaunch: PendingMacElevatedCommand | null = null;

    if (this.platform === 'darwin' && !this.usesCustomLaunchHelper) {
      pendingMacLaunch = startMacElevatedCommand(
        buildMacElevationCommand(
          helperPath,
          buildHostsHelperServeArgs(endpoint, authToken, this.hostsFilePath),
          helperLogPath ?? undefined,
        ),
      );
    } else {
      try {
        await this.launchHelper({
          platform: this.platform,
          helperPath,
          hostsFilePath: this.hostsFilePath,
          endpoint,
          authToken,
          logPath: helperLogPath ?? undefined,
        });
      } catch (error) {
        if (error instanceof HostsOverrideError) {
          throw error;
        }
        throw new HostsOverrideError(
          'helper-not-ready',
          'Dolgate DNS Helper를 시작하지 못했습니다.',
          normalizeUnknownErrorMessage(error),
        );
      }
    }

    const deadline = Date.now() + this.launchTimeoutMs;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      if (pendingMacLaunch?.state.settled && pendingMacLaunch.state.error) {
        throw toMacLaunchHostsOverrideError(pendingMacLaunch.state.error);
      }
      let client: HostsHelperClient | null = null;
      try {
        client = await this.createClient(endpoint);
        const response = await client.send({
          command: 'ping',
          authToken,
        });
        if (!response.ok) {
          throw new Error(response.error || 'Dolgate DNS Helper ping failed');
        }
        this.session = {
          endpoint,
          authToken,
          client,
        };
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        client?.close();
        await sleep(this.launchPollIntervalMs);
      }
    }

    await this.cleanupEndpoint(endpoint);
    if (pendingMacLaunch?.state.settled && pendingMacLaunch.state.error) {
      throw toMacLaunchHostsOverrideError(pendingMacLaunch.state.error);
    }
    const helperLogTail = await readHelperLaunchLogTail(helperLogPath);
    throw new HostsOverrideError(
      'helper-not-ready',
      'Dolgate DNS Helper가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',
      combineHelperReadyDetails(lastError?.message, helperLogTail),
    );
  }

  private async sendRequest(request: HostsHelperRpcRequest): Promise<HostsHelperRpcResponse> {
    const session = this.requireSession();
    let response: HostsHelperRpcResponse;
    try {
      response = await session.client.send(request);
    } catch (error) {
      await this.disposeSession();
      throw new HostsOverrideError(
        'helper-rpc',
        request.command === 'clear-block'
          ? 'DNS Override를 제거하지 못했습니다. Dolgate DNS Helper와 통신하지 못했습니다.'
          : 'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper와 통신하지 못했습니다.',
        normalizeUnknownErrorMessage(error),
      );
    }

    if (!response.ok) {
      throw new HostsOverrideError(
        'helper-rpc',
        request.command === 'clear-block'
          ? 'DNS Override를 제거하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.'
          : 'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.',
        response.error || `Dolgate DNS Helper ${request.command} failed`,
      );
    }
    return response;
  }

  private async verifyRewriteResult(entries: ActiveDnsOverrideEntry[]): Promise<void> {
    let content: string;
    try {
      content = await this.readHostsFileForVerification();
    } catch (error) {
      throw new HostsOverrideError(
        'hosts-verification',
        'DNS Override를 적용한 뒤 hosts 파일을 확인하지 못했습니다.',
        normalizeUnknownErrorMessage(error),
      );
    }

    const verificationError = verifyManagedHostsRewrite(content, entries);
    if (!verificationError) {
      return;
    }
    throw new HostsOverrideError(
      'hosts-verification',
      'DNS Override를 적용했지만 hosts 파일에서 확인되지 않았습니다.',
      verificationError,
    );
  }

  private async verifyClearResult(): Promise<void> {
    let content: string;
    try {
      content = await this.readHostsFileForVerification();
    } catch (error) {
      throw new HostsOverrideError(
        'hosts-verification',
        'DNS Override를 제거한 뒤 hosts 파일을 확인하지 못했습니다.',
        normalizeUnknownErrorMessage(error),
      );
    }

    const verificationError = verifyManagedHostsCleared(content);
    if (!verificationError) {
      return;
    }
    throw new HostsOverrideError(
      'hosts-verification',
      'DNS Override를 제거했지만 hosts 파일 정리가 확인되지 않았습니다.',
      verificationError,
    );
  }

  private async readHostsFileForVerification(): Promise<string> {
    try {
      return await this.readHostsFile(this.hostsFilePath);
    } catch (error) {
      if (!isPermissionReadError(error) || !this.session) {
        throw error;
      }
    }

    const response = await this.sendRequest({
      command: 'read-hosts',
      authToken: this.requireSession().authToken,
      hostsFilePath: this.hostsFilePath,
    });
    return response.hostsFileContent ?? '';
  }

  private async disposeSession(): Promise<void> {
    const currentSession = this.session;
    this.session = null;
    if (!currentSession) {
      return;
    }
    currentSession.client.close();
    await this.cleanupEndpoint(currentSession.endpoint);
  }

  private async cleanupEndpoint(endpoint: string): Promise<void> {
    if (this.platform === 'win32') {
      return;
    }
    await rm(endpoint, { force: true }).catch(() => undefined);
  }
}
