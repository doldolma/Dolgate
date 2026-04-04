import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import {
  type DnsOverrideResolvedRecord,
  isDnsOverrideEligiblePortForwardRule,
  isLinkedDnsOverrideRecord,
  isLoopbackBindAddress,
  isStaticDnsOverrideRecord,
} from '@shared';
import type { DnsOverrideRecord, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_READY_TIMEOUT_MS = 15_000;
const HELPER_READY_POLL_INTERVAL_MS = 200;
const HELPER_CONNECT_TIMEOUT_MS = 1_000;
const DARWIN_MAX_UNIX_SOCKET_PATH_LENGTH = 103;

export const HOSTS_MANAGED_BLOCK_START = '# >>> dolssh managed dns overrides >>>';
export const HOSTS_MANAGED_BLOCK_END = '# <<< dolssh managed dns overrides <<<';
export const DOLGATE_DNS_HELPER_BINARY_NAME = process.platform === 'win32' ? 'dolgate-dns-helper.exe' : 'dolgate-dns-helper';

export interface ActiveDnsOverrideEntry {
  hostname: string;
  address: string;
  ruleId: string;
}

export interface HostsHelperRpcRequest {
  command: 'ping' | 'rewrite-block' | 'clear-block' | 'shutdown';
  authToken: string;
  hostsFilePath?: string;
  entries?: Array<{ address: string; hostname: string }>;
}

export interface HostsHelperRpcResponse {
  ok: boolean;
  error?: string;
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

export function buildMacElevationScript(helperPath: string, args: string[]): string {
  const quoteShell = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
  const backgroundCommand = `nohup ${[quoteShell(helperPath), ...args.map(quoteShell)].join(' ')} >/dev/null 2>&1 &`;
  return `do shell script "${backgroundCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
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
  const candidates = [
    path.resolve(app.getAppPath(), '../..'),
    path.resolve(app.getAppPath(), '../../..'),
    path.resolve(app.getAppPath(), '../../../..'),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
  ];

  for (const candidate of new Set(candidates)) {
    if (
      existsSync(path.join(candidate, 'services', 'ssh-core')) &&
      existsSync(path.join(candidate, 'apps', 'desktop'))
    ) {
      return candidate;
    }
  }

  throw new Error(`Repository root could not be resolved from appPath=${app.getAppPath()} and __dirname=${__dirname}`);
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
    await runCommand('osascript', ['-e', buildMacElevationScript(options.helperPath, args)]);
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

    await this.launchHelper({
      platform: this.platform,
      helperPath,
      hostsFilePath: this.hostsFilePath,
      endpoint,
      authToken,
    });

    const deadline = Date.now() + this.launchTimeoutMs;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
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
    throw new Error(`Dolgate DNS Helper did not become ready: ${lastError?.message ?? 'unknown error'}`);
  }

  private async sendRequest(request: HostsHelperRpcRequest): Promise<HostsHelperRpcResponse> {
    const session = this.requireSession();
    let response: HostsHelperRpcResponse;
    try {
      response = await session.client.send(request);
    } catch (error) {
      await this.disposeSession();
      throw error;
    }

    if (!response.ok) {
      throw new Error(response.error || `Dolgate DNS Helper ${request.command} failed`);
    }
    return response;
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
