import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type {
  HostSecretInput,
  TermiusImportCounts,
  TermiusImportGroupPreview,
  TermiusImportHostPreview,
  TermiusImportSelectionInput,
  TermiusImportWarning,
  TermiusProbeResult,
  TermiusProbeStatus
} from '@shared';
import { normalizeGroupPath } from '@shared';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TermiusExportKey {
  id?: string | number | null;
  localId?: string | number | null;
  name?: string | null;
  passphrase?: string | null;
  privateKeyPem?: string | null;
}

interface TermiusExportIdentity {
  id?: string | number | null;
  localId?: string | number | null;
  name?: string | null;
  username?: string | null;
  password?: string | null;
  sshKey?: TermiusExportKey | null;
}

interface TermiusExportSshConfig {
  id?: string | number | null;
  localId?: string | number | null;
  port?: number | null;
  content?: {
    port?: number | null;
  } | null;
}

export interface TermiusExportHost {
  id?: string | number | null;
  localId?: string | number | null;
  name?: string | null;
  address?: string | null;
  groupPath?: string | null;
  identity?: TermiusExportIdentity | null;
  sshConfig?: TermiusExportSshConfig | null;
}

export interface TermiusExportGroup {
  id?: string | number | null;
  localId?: string | number | null;
  name?: string | null;
  path?: string | null;
}

interface TermiusExportMeta {
  counts?: Partial<TermiusImportCounts> | null;
  warnings?: string[] | null;
  termiusDataDir?: string | null;
  exportedAt?: string | null;
}

export interface TermiusExportBundle {
  meta?: TermiusExportMeta | null;
  groups?: TermiusExportGroup[] | null;
  hosts?: TermiusExportHost[] | null;
  identities?: unknown[] | null;
  keys?: unknown[] | null;
  multiKeys?: unknown[] | null;
  sshConfigs?: unknown[] | null;
  sshConfigIdentities?: unknown[] | null;
}

export interface TermiusSnapshot {
  bundle: TermiusExportBundle;
  hostsByKey: Map<string, TermiusExportHost>;
}

function defaultCounts(): TermiusImportCounts {
  return {
    groups: 0,
    hosts: 0,
    keys: 0,
    multiKeys: 0,
    sshConfigs: 0,
    sshConfigIdentities: 0,
    identities: 0
  };
}

function toWarning(message: string, code: string | null = null): TermiusImportWarning {
  return {
    code,
    message
  };
}

function normalizeCounts(meta: TermiusExportMeta | null | undefined, bundle: TermiusExportBundle): TermiusImportCounts {
  const counts = meta?.counts ?? {};
  return {
    groups: typeof counts.groups === 'number' ? counts.groups : bundle.groups?.length ?? 0,
    hosts: typeof counts.hosts === 'number' ? counts.hosts : bundle.hosts?.length ?? 0,
    keys: typeof counts.keys === 'number' ? counts.keys : bundle.keys?.length ?? 0,
    multiKeys: typeof counts.multiKeys === 'number' ? counts.multiKeys : bundle.multiKeys?.length ?? 0,
    sshConfigs: typeof counts.sshConfigs === 'number' ? counts.sshConfigs : bundle.sshConfigs?.length ?? 0,
    sshConfigIdentities:
      typeof counts.sshConfigIdentities === 'number' ? counts.sshConfigIdentities : bundle.sshConfigIdentities?.length ?? 0,
    identities: typeof counts.identities === 'number' ? counts.identities : bundle.identities?.length ?? 0
  };
}

export function buildTermiusEntityKey(
  id: string | number | null | undefined,
  localId: string | number | null | undefined,
  fallback: string
): string {
  if (id !== undefined && id !== null && String(id).trim()) {
    return `id:${String(id)}`;
  }
  if (localId !== undefined && localId !== null && String(localId).trim()) {
    return `local:${String(localId)}`;
  }
  return `fallback:${fallback}`;
}

export function resolveTermiusHostPort(host: Pick<TermiusExportHost, 'sshConfig'>): number | null {
  const direct = host.sshConfig?.port;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const nested = host.sshConfig?.content?.port;
  if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0) {
    return nested;
  }

  return 22;
}

export function resolveTermiusHostUsername(host: Pick<TermiusExportHost, 'identity'>): string | null {
  const username = host.identity?.username?.trim();
  return username ? username : null;
}

function hasTermiusPassword(host: Pick<TermiusExportHost, 'identity'>): boolean {
  return Boolean(host.identity?.password && host.identity.password.trim());
}

function hasTermiusPrivateKey(host: Pick<TermiusExportHost, 'identity'>): boolean {
  return Boolean(host.identity?.sshKey?.privateKeyPem && host.identity.sshKey.privateKeyPem.trim());
}

function normalizeTermiusText(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function buildTermiusGroupAncestorPaths(groupPath: string | null | undefined): string[] {
  const normalized = normalizeGroupPath(groupPath);
  if (!normalized) {
    return [];
  }

  const parts = normalized.split('/');
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    paths.push(parts.slice(0, index + 1).join('/'));
  }
  return paths;
}

export function buildTermiusSharedSecretKey(host: Pick<TermiusExportHost, 'identity' | 'name' | 'address'>): string | null {
  const identity = host.identity;
  if (!identity) {
    return null;
  }

  const entityKey = buildTermiusEntityKey(identity.id, identity.localId, '');
  if (!entityKey.startsWith('fallback:')) {
    return `identity:${entityKey}`;
  }

  const fallbackParts = [
    normalizeTermiusText(identity.name),
    normalizeTermiusText(identity.username),
    normalizeTermiusText(identity.sshKey?.name),
    normalizeTermiusText(host.name),
    normalizeTermiusText(host.address)
  ].filter((value): value is string => Boolean(value));

  return fallbackParts.length > 0 ? `identity-fallback:${fallbackParts.join('|')}` : null;
}

export function buildTermiusSharedSecretLabel(host: Pick<TermiusExportHost, 'identity' | 'name' | 'address'>): string {
  const identity = host.identity;
  return `Termius • ${
    normalizeTermiusText(identity?.name) ??
    normalizeTermiusText(identity?.username) ??
    normalizeTermiusText(identity?.sshKey?.name) ??
    normalizeTermiusText(host.name) ??
    normalizeTermiusText(host.address) ??
    'Imported identity'
  }`;
}

export function resolveTermiusCredential(host: Pick<TermiusExportHost, 'identity' | 'name' | 'address'>): {
  authType: 'password' | 'privateKey';
  secrets: HostSecretInput;
  hasCredential: boolean;
  sharedSecretKey: string | null;
  sharedSecretLabel: string;
} {
  const privateKeyPem = normalizeTermiusText(host.identity?.sshKey?.privateKeyPem);
  if (privateKeyPem) {
    return {
      authType: 'privateKey',
      secrets: {
        privateKeyPem,
        passphrase: normalizeTermiusText(host.identity?.sshKey?.passphrase) ?? undefined
      },
      hasCredential: true,
      sharedSecretKey: buildTermiusSharedSecretKey(host),
      sharedSecretLabel: buildTermiusSharedSecretLabel(host)
    };
  }

  const password = normalizeTermiusText(host.identity?.password);
  return {
    authType: 'password',
    secrets: {
      password: password ?? undefined
    },
    hasCredential: Boolean(password),
    sharedSecretKey: buildTermiusSharedSecretKey(host),
    sharedSecretLabel: buildTermiusSharedSecretLabel(host)
  };
}

export function buildTermiusGroupPreviews(groups: TermiusExportGroup[], hosts: TermiusExportHost[]): TermiusImportGroupPreview[] {
  return groups
    .filter(
      (group): group is TermiusExportGroup & { path: string; name: string } =>
        Boolean(normalizeGroupPath(group.path)) && Boolean(group.name?.trim())
    )
    .map((group) => {
      const normalizedPath = normalizeGroupPath(group.path)!;
      const parentPath = normalizedPath.includes('/') ? normalizedPath.split('/').slice(0, -1).join('/') : null;
      const hostCount = hosts.filter((host) => {
        const candidatePath = normalizeGroupPath(host.groupPath);
        return candidatePath === normalizedPath || Boolean(candidatePath && candidatePath.startsWith(`${normalizedPath}/`));
      }).length;

      return {
        path: normalizedPath,
        name: group.name.trim(),
        parentPath,
        hostCount
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function buildTermiusHostPreviews(hosts: TermiusExportHost[]): TermiusImportHostPreview[] {
  return hosts
    .map((host) => {
      const name = host.name?.trim() || host.address?.trim() || 'Host';
      const address = host.address?.trim() || null;
      const groupPath = normalizeGroupPath(host.groupPath);
      const username = resolveTermiusHostUsername(host);
      const port = resolveTermiusHostPort(host);
      return {
        key: buildTermiusEntityKey(host.id, host.localId, `${name}|${address ?? ''}|${groupPath ?? ''}`),
        name,
        address,
        groupPath,
        port,
        username,
        hasPassword: hasTermiusPassword(host),
        hasPrivateKey: hasTermiusPrivateKey(host),
        identityName: host.identity?.name?.trim() || null
      };
    })
    .sort((left, right) => {
      const groupCompare = (left.groupPath ?? '').localeCompare(right.groupPath ?? '');
      if (groupCompare !== 0) {
        return groupCompare;
      }
      return left.name.localeCompare(right.name);
    });
}

export function collectSelectedTermiusHosts(snapshot: TermiusSnapshot, input: TermiusImportSelectionInput): TermiusExportHost[] {
  const hosts = snapshot.bundle.hosts ?? [];
  const selectedKeys = new Set(input.selectedHostKeys);
  const selectedGroups = new Set(
    input.selectedGroupPaths.map((pathValue) => normalizeGroupPath(pathValue)).filter((value): value is string => Boolean(value))
  );
  const resolved = new Map<string, TermiusExportHost>();

  for (const host of hosts) {
    const key = buildTermiusEntityKey(host.id, host.localId, `${host.name ?? ''}|${host.address ?? ''}|${host.groupPath ?? ''}`);
    const groupPath = normalizeGroupPath(host.groupPath);
    const matchedByGroup = [...selectedGroups].some((pathValue) => groupPath === pathValue || Boolean(groupPath && groupPath.startsWith(`${pathValue}/`)));
    if (!selectedKeys.has(key) && !matchedByGroup) {
      continue;
    }
    resolved.set(key, host);
  }

  return [...resolved.values()];
}

export function collectSelectedTermiusGroupPaths(snapshot: TermiusSnapshot, input: TermiusImportSelectionInput): string[] {
  const explicitSelections = new Set(
    input.selectedGroupPaths.map((pathValue) => normalizeGroupPath(pathValue)).filter((value): value is string => Boolean(value))
  );

  for (const host of collectSelectedTermiusHosts(snapshot, input)) {
    for (const pathValue of buildTermiusGroupAncestorPaths(host.groupPath)) {
      explicitSelections.add(pathValue);
    }
  }

  return [...explicitSelections].sort((left, right) => {
    const depthCompare = left.split('/').length - right.split('/').length;
    if (depthCompare !== 0) {
      return depthCompare;
    }
    return left.localeCompare(right);
  });
}

function normalizeProbeStatus(error: unknown): { status: TermiusProbeStatus; message: string } {
  const message = error instanceof Error ? error.message : 'Termius 데이터를 읽지 못했습니다.';
  const normalized = message.toLowerCase();

  if (normalized.includes('unsupported platform')) {
    return {
      status: 'unsupported',
      message: 'Termius import는 현재 macOS와 Windows에서만 지원합니다.'
    };
  }

  if (normalized.includes('termius installation was not found') || normalized.includes('native module paths were not found')) {
    return {
      status: 'not-installed',
      message: '로컬 Termius 설치를 찾지 못했습니다.'
    };
  }

  if (normalized.includes('termius data directory was not found')) {
    return {
      status: 'no-data',
      message: '로컬 Termius 데이터 디렉터리를 찾지 못했습니다.'
    };
  }

  return {
    status: 'error',
    message
  };
}

function buildProbeWarnings(meta: TermiusExportMeta | null | undefined): TermiusImportWarning[] {
  return (meta?.warnings ?? []).filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0).map((warning) => toWarning(warning));
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTermiusHelperAssetPath(filename: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'termius', filename);
  }

  return path.resolve(__dirname, '../../assets/termius', filename);
}

function resolveHelperElectronCandidates(): string[] {
  const helperName = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  const homeDir = os.homedir();

  return [
    process.env.DOLSSH_TERMIUS_HELPER_ELECTRON?.trim() || null,
    path.join(homeDir, 'WebstormProjects', 'termius-exporter', 'node_modules', '.bin', helperName),
    path.join(homeDir, 'develop', 'termius-exporter', 'node_modules', '.bin', helperName),
    path.resolve(process.cwd(), '../termius-exporter/node_modules/.bin', helperName),
    path.resolve(process.cwd(), '../../termius-exporter/node_modules/.bin', helperName)
  ].filter((value): value is string => Boolean(value));
}

export function deriveElectronExecutableCandidate(candidatePath: string, platformOverride: NodeJS.Platform = process.platform): string | null {
  const normalizedCandidate = candidatePath.trim();
  if (!normalizedCandidate) {
    return null;
  }

  const basename = path.basename(normalizedCandidate);
  if (
    (platformOverride === 'darwin' && basename === 'Electron') ||
    (platformOverride === 'win32' && basename.toLowerCase() === 'electron.exe') ||
    (platformOverride !== 'darwin' && platformOverride !== 'win32' && basename === 'electron')
  ) {
    return normalizedCandidate;
  }

  let packageDir: string | null = null;
  if (basename === 'cli.js' && path.basename(path.dirname(normalizedCandidate)) === 'electron') {
    packageDir = path.dirname(normalizedCandidate);
  } else if (basename === 'electron' || basename === 'electron.cmd') {
    const parentDir = path.dirname(normalizedCandidate);
    if (path.basename(parentDir) === '.bin') {
      packageDir = path.resolve(parentDir, '../electron');
    }
  }

  if (!packageDir) {
    return null;
  }

  if (platformOverride === 'darwin') {
    return path.join(packageDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }

  if (platformOverride === 'win32') {
    return path.join(packageDir, 'dist', 'electron.exe');
  }

  return path.join(packageDir, 'dist', 'electron');
}

async function resolveHelperElectronCommand(candidatePath: string): Promise<string | null> {
  const uniqueCandidates = new Set<string>();
  const appendCandidate = (value: string | null) => {
    if (value?.trim()) {
      uniqueCandidates.add(value);
    }
  };

  appendCandidate(deriveElectronExecutableCandidate(candidatePath));
  appendCandidate(candidatePath);

  try {
    const resolvedPath = await realpath(candidatePath);
    appendCandidate(deriveElectronExecutableCandidate(resolvedPath));
    appendCandidate(resolvedPath);
  } catch {
    // Ignore broken candidates and fall through to the next one.
  }

  for (const value of uniqueCandidates) {
    if (await pathExists(value)) {
      return value;
    }
  }

  return null;
}

function runHelper(command: string, args: string[], envOverride?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: envOverride ?? process.env
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('exit', (code) => {
      finish(() => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0
        });
      });
    });

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error('Termius import helper timed out.'));
      });
    }, 60_000);
  });
}

export class TermiusImportService {
  private readonly snapshots = new Map<string, TermiusSnapshot>();

  private async resolveHelperElectronPath(): Promise<string> {
    for (const candidate of resolveHelperElectronCandidates()) {
      const resolved = await resolveHelperElectronCommand(candidate);
      if (resolved) {
        return resolved;
      }
    }

    throw new Error(
      'Termius import helper runtime was not found. Set DOLSSH_TERMIUS_HELPER_ELECTRON or install the termius-exporter helper runtime.'
    );
  }

  private async runExportHelper(): Promise<TermiusExportBundle> {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }

    const helperElectron = await this.resolveHelperElectronPath();
    const helperScript = resolveTermiusHelperAssetPath('termius-helper.cjs');
    const helperProbeFile = resolveTermiusHelperAssetPath('termius-probe.html');
    const helperTempRoot = await mkdtemp(path.join(os.tmpdir(), 'dolssh-termius-export-'));
    const outputPath = path.join(helperTempRoot, 'termius-export.json');

    try {
      const result = await runHelper(helperElectron, [helperScript, '--out', outputPath, '--probe-file', helperProbeFile], process.env);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || 'Termius import helper failed.');
      }

      const raw = await readFile(outputPath, 'utf8');
      return JSON.parse(raw) as TermiusExportBundle;
    } finally {
      await rm(helperTempRoot, { recursive: true, force: true });
    }
  }

  async probeLocal(): Promise<TermiusProbeResult> {
    try {
      const bundle = await this.runExportHelper();
      const counts = normalizeCounts(bundle.meta, bundle);
      const groups = buildTermiusGroupPreviews(bundle.groups ?? [], bundle.hosts ?? []);
      const hosts = buildTermiusHostPreviews(bundle.hosts ?? []);
      const warnings = buildProbeWarnings(bundle.meta);

      if (counts.groups === 0 && counts.hosts === 0) {
        return {
          status: 'no-data',
          snapshotId: null,
          message: '로컬 Termius 데이터에서 가져올 그룹이나 호스트를 찾지 못했습니다.',
          meta: {
            counts,
            warnings,
            termiusDataDir: bundle.meta?.termiusDataDir ?? null,
            exportedAt: bundle.meta?.exportedAt ?? null
          },
          groups,
          hosts
        };
      }

      const snapshotId = randomUUID();
      this.snapshots.set(snapshotId, {
        bundle,
        hostsByKey: new Map((bundle.hosts ?? []).map((host) => [buildTermiusEntityKey(host.id, host.localId, `${host.name ?? ''}|${host.address ?? ''}|${host.groupPath ?? ''}`), host]))
      });

      return {
        status: 'ready',
        snapshotId,
        message: null,
        meta: {
          counts,
          warnings,
          termiusDataDir: bundle.meta?.termiusDataDir ?? null,
          exportedAt: bundle.meta?.exportedAt ?? null
        },
        groups,
        hosts
      };
    } catch (error) {
      const normalized = normalizeProbeStatus(error);
      return {
        status: normalized.status,
        snapshotId: null,
        message: normalized.message,
        meta: {
          counts: defaultCounts(),
          warnings: error instanceof Error ? [toWarning(error.message)] : [],
          termiusDataDir: null,
          exportedAt: null
        },
        groups: [],
        hosts: []
      };
    }
  }

  getSnapshot(snapshotId: string): TermiusSnapshot | null {
    return this.snapshots.get(snapshotId) ?? null;
  }

  discardSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
  }
}
