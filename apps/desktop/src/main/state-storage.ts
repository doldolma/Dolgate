import { app } from 'electron';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import type {
  ActivityLogRecord,
  AwsSsmPortForwardRuleRecord,
  AppTheme,
  ContainerPortForwardRuleRecord,
  GlobalTerminalThemeId,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  PortForwardRuleRecord,
  SftpBrowserColumnWidths,
  SshPortForwardRuleRecord,
  SecretMetadataRecord,
  TerminalFontFamilyId,
  TerminalThemeId
} from '@shared';
import {
  DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  MAX_SESSION_REPLAY_RETENTION_COUNT,
  MIN_SESSION_REPLAY_RETENTION_COUNT,
  normalizeSftpBrowserColumnWidths
} from '@shared';
import type { SyncKind } from '@shared';

const STORAGE_DIRNAME = 'storage';
const STATE_FILE_NAME = 'state.json';
const STATE_TEMP_FILE_NAME = 'state.json.tmp';
const STATE_BACKUP_FILE_NAME = 'state.json.bak';
const ACTIVITY_LOG_FILE_NAME = 'activity-log.jsonl';
const DESKTOP_STATE_SCHEMA_VERSION = 1;
const MAX_ACTIVITY_LOGS = 10_000;

export interface SyncDeletionRecord {
  kind: SyncKind;
  recordId: string;
  deletedAt: string;
}

export type StoredEncryptedValue = {
  encrypted: boolean;
  value: string;
};

export interface DesktopStateFile {
  schemaVersion: number;
  settings: {
    theme: AppTheme;
    sftpBrowserColumnWidths: SftpBrowserColumnWidths;
    sessionReplayRetentionCount: number;
    serverUrlOverride: string | null;
    updatedAt: string;
  };
  terminal: {
    globalThemeId: GlobalTerminalThemeId;
    globalThemeUpdatedAt: string;
    fontFamily: TerminalFontFamilyId;
    fontSize: number;
    scrollbackLines: number;
    lineHeight: number;
    letterSpacing: number;
    minimumContrastRatio: number;
    altIsMeta: boolean;
    webglEnabled: boolean;
    localUpdatedAt: string;
  };
  updater: {
    dismissedVersion: string | null;
    updatedAt: string;
  };
  auth: {
    status: 'unknown' | 'authenticated' | 'offline-authenticated' | 'unauthenticated';
    updatedAt: string;
  };
  sync: {
    lastSuccessfulSyncAt: string | null;
    pendingPush: boolean;
    errorMessage: string | null;
    ownerUserId: string | null;
    ownerServerUrl: string | null;
    updatedAt: string;
  };
  data: {
    groups: GroupRecord[];
    hosts: HostRecord[];
    knownHosts: KnownHostRecord[];
    portForwards: PortForwardRuleRecord[];
    secretMetadata: SecretMetadataRecord[];
    syncOutbox: SyncDeletionRecord[];
  };
  secure: {
    refreshToken: StoredEncryptedValue | null;
    managedSecretsByRef: Record<string, StoredEncryptedValue>;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveUserDataPath(): string {
  const override = process.env.DOLSSH_USER_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (app?.getPath) {
    return app.getPath('userData');
  }

  return path.join(process.cwd(), '.tmp', `dolssh-desktop-storage-${process.pid}`);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalThemeId(value: unknown): value is TerminalThemeId {
  return (
    value === 'dolssh-dark' ||
    value === 'dolssh-light' ||
    value === 'kanagawa-wave' ||
    value === 'kanagawa-dragon' ||
    value === 'kanagawa-lotus' ||
    value === 'everforest-dark' ||
    value === 'everforest-light' ||
    value === 'night-owl' ||
    value === 'light-owl' ||
    value === 'rose-pine' ||
    value === 'hacker-green' ||
    value === 'hacker-blue' ||
    value === 'hacker-red'
  );
}

function isGlobalTerminalThemeId(value: unknown): value is GlobalTerminalThemeId {
  return value === 'system' || isTerminalThemeId(value);
}

function isTerminalFontFamilyId(value: unknown): value is TerminalFontFamilyId {
  return (
    value === 'sf-mono' ||
    value === 'menlo' ||
    value === 'monaco' ||
    value === 'consolas' ||
    value === 'cascadia-mono' ||
    value === 'jetbrains-mono' ||
    value === 'fira-code' ||
    value === 'ibm-plex-mono' ||
    value === 'source-code-pro'
  );
}

function isMacOnlyTerminalFontFamily(value: TerminalFontFamilyId): boolean {
  return value === 'sf-mono' || value === 'menlo' || value === 'monaco';
}

function resolveDefaultTerminalFontFamily(platform: NodeJS.Platform = process.platform): TerminalFontFamilyId {
  if (platform === 'win32') {
    return 'consolas';
  }
  if (platform === 'linux') {
    return 'jetbrains-mono';
  }
  return 'sf-mono';
}

function normalizeTerminalFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 13;
  }
  return Math.min(18, Math.max(11, Math.round(value)));
}

function normalizeTerminalScrollbackLines(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 5000;
  }
  return Math.min(25_000, Math.max(1_000, Math.round(value)));
}

function normalizeTerminalLineHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(2, Math.max(1, Number(value)));
}

function normalizeTerminalLetterSpacing(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(2, Math.max(0, Math.round(value)));
}

function normalizeTerminalMinimumContrastRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(21, Math.max(1, Number(value)));
}

function normalizeTerminalAltIsMeta(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function normalizeTerminalFontFamily(value: unknown, fallback: TerminalFontFamilyId): TerminalFontFamilyId {
  const normalized = isTerminalFontFamilyId(value) ? value : fallback;
  if (process.platform !== 'darwin' && isMacOnlyTerminalFontFamily(normalized)) {
    return resolveDefaultTerminalFontFamily();
  }
  return normalized;
}

function resolveDefaultTerminalWebglEnabled(_platform: NodeJS.Platform = process.platform): boolean {
  return true;
}

function normalizeTerminalWebglEnabled(value: unknown): boolean {
  return typeof value === 'boolean' ? value : resolveDefaultTerminalWebglEnabled();
}

function normalizeSessionReplayRetentionCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SESSION_REPLAY_RETENTION_COUNT;
  }
  return Math.min(
    MAX_SESSION_REPLAY_RETENTION_COUNT,
    Math.max(MIN_SESSION_REPLAY_RETENTION_COUNT, Math.round(value)),
  );
}

function normalizePortForwardRule(value: unknown): PortForwardRuleRecord | null {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.hostId !== 'string' ||
    typeof value.bindAddress !== 'string' ||
    typeof value.bindPort !== 'number' ||
    !Number.isFinite(value.bindPort) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }

  if (value.transport === 'container') {
    if (
      typeof value.containerId !== 'string' ||
      typeof value.containerName !== 'string' ||
      (value.containerRuntime !== 'docker' && value.containerRuntime !== 'podman') ||
      typeof value.networkName !== 'string' ||
      typeof value.targetPort !== 'number' ||
      !Number.isFinite(value.targetPort)
    ) {
      return null;
    }

    const record: ContainerPortForwardRuleRecord = {
      id: value.id,
      label: value.label.trim(),
      hostId: value.hostId,
      transport: 'container',
      bindAddress: '127.0.0.1',
      bindPort: Math.max(0, Math.round(value.bindPort)),
      containerId: value.containerId.trim(),
      containerName: value.containerName.trim(),
      containerRuntime: value.containerRuntime,
      networkName: value.networkName.trim(),
      targetPort: Math.round(value.targetPort),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    };
    return record;
  }

  const transport = value.transport === 'aws-ssm' ? 'aws-ssm' : 'ssh';
  if (transport === 'aws-ssm') {
    const targetKind = value.targetKind === 'remote-host' ? 'remote-host' : 'instance-port';
    if (typeof value.targetPort !== 'number' || !Number.isFinite(value.targetPort)) {
      return null;
    }

    const record: AwsSsmPortForwardRuleRecord = {
      id: value.id,
      label: value.label.trim(),
      hostId: value.hostId,
      transport,
      bindAddress: value.bindAddress.trim() || '127.0.0.1',
      bindPort: Math.round(value.bindPort),
      targetKind,
      targetPort: Math.round(value.targetPort),
      remoteHost: targetKind === 'remote-host' && typeof value.remoteHost === 'string' ? value.remoteHost.trim() : null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    };
    return record;
  }

  const rawMode = value.mode;
  const mode = rawMode === 'remote' || rawMode === 'dynamic' ? rawMode : 'local';
  const record: SshPortForwardRuleRecord = {
    id: value.id,
    label: value.label.trim(),
    hostId: value.hostId,
    transport,
    mode,
    bindAddress: value.bindAddress.trim(),
    bindPort: Math.round(value.bindPort),
    targetHost: mode === 'dynamic' ? null : typeof value.targetHost === 'string' ? value.targetHost.trim() : null,
    targetPort: mode === 'dynamic' ? null : typeof value.targetPort === 'number' && Number.isFinite(value.targetPort) ? Math.round(value.targetPort) : null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
  return record;
}

function createDefaultStateFile(): DesktopStateFile {
  const timestamp = nowIso();
  const defaultTerminalFontFamily = resolveDefaultTerminalFontFamily();
  const defaultTerminalWebglEnabled = resolveDefaultTerminalWebglEnabled();
  return {
    schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
    settings: {
      theme: 'system',
      sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
      sessionReplayRetentionCount: DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
      serverUrlOverride: null,
      updatedAt: timestamp
    },
    terminal: {
      globalThemeId: 'dolssh-dark',
      globalThemeUpdatedAt: timestamp,
      fontFamily: defaultTerminalFontFamily,
      fontSize: 13,
      scrollbackLines: 5000,
      lineHeight: 1,
      letterSpacing: 0,
      minimumContrastRatio: 1,
      altIsMeta: false,
      webglEnabled: defaultTerminalWebglEnabled,
      localUpdatedAt: timestamp
    },
    updater: {
      dismissedVersion: null,
      updatedAt: timestamp
    },
    auth: {
      status: 'unknown',
      updatedAt: timestamp
    },
    sync: {
      lastSuccessfulSyncAt: null,
      pendingPush: false,
      errorMessage: null,
      ownerUserId: null,
      ownerServerUrl: null,
      updatedAt: timestamp
    },
    data: {
      groups: [],
      hosts: [],
      knownHosts: [],
      portForwards: [],
      secretMetadata: [],
      syncOutbox: []
    },
    secure: {
      refreshToken: null,
      managedSecretsByRef: {}
    }
  };
}

function normalizeStoredEncryptedValue(value: unknown): StoredEncryptedValue | null {
  if (!isObject(value) || typeof value.value !== 'string' || typeof value.encrypted !== 'boolean') {
    return null;
  }
  return {
    encrypted: value.encrypted,
    value: value.value
  };
}

function normalizeHostRecord(value: unknown): HostRecord | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.label !== 'string') {
    return null;
  }

  const tags = Array.isArray(value.tags)
    ? value.tags
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  if (value.kind === 'aws-ec2') {
    if (typeof value.awsProfileName !== 'string' || typeof value.awsRegion !== 'string' || typeof value.awsInstanceId !== 'string') {
      return null;
    }
    return {
      id: value.id,
      kind: 'aws-ec2',
      label: value.label,
      groupName: typeof value.groupName === 'string' ? value.groupName : null,
      tags,
      terminalThemeId: isTerminalThemeId(value.terminalThemeId) ? value.terminalThemeId : null,
      awsProfileName: value.awsProfileName,
      awsRegion: value.awsRegion,
      awsInstanceId: value.awsInstanceId,
      awsAvailabilityZone: typeof value.awsAvailabilityZone === 'string' ? value.awsAvailabilityZone : null,
      awsInstanceName: typeof value.awsInstanceName === 'string' ? value.awsInstanceName : null,
      awsPlatform: typeof value.awsPlatform === 'string' ? value.awsPlatform : null,
      awsPrivateIp: typeof value.awsPrivateIp === 'string' ? value.awsPrivateIp : null,
      awsState: typeof value.awsState === 'string' ? value.awsState : null,
      awsSshUsername: typeof value.awsSshUsername === 'string' ? value.awsSshUsername : null,
      awsSshPort:
        typeof value.awsSshPort === 'number' && Number.isFinite(value.awsSshPort)
          ? Math.round(value.awsSshPort)
          : null,
      awsSshMetadataStatus:
        value.awsSshMetadataStatus === 'idle' ||
        value.awsSshMetadataStatus === 'loading' ||
        value.awsSshMetadataStatus === 'ready' ||
        value.awsSshMetadataStatus === 'error'
          ? value.awsSshMetadataStatus
          : null,
      awsSshMetadataError:
        typeof value.awsSshMetadataError === 'string' ? value.awsSshMetadataError : null,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
    };
  }

  if (value.kind === 'warpgate-ssh') {
    if (
      typeof value.warpgateBaseUrl !== 'string' ||
      typeof value.warpgateSshHost !== 'string' ||
      typeof value.warpgateSshPort !== 'number' ||
      typeof value.warpgateTargetId !== 'string' ||
      typeof value.warpgateTargetName !== 'string' ||
      typeof value.warpgateUsername !== 'string'
    ) {
      return null;
    }

    return {
      id: value.id,
      kind: 'warpgate-ssh',
      label: value.label,
      groupName: typeof value.groupName === 'string' ? value.groupName : null,
      tags,
      terminalThemeId: isTerminalThemeId(value.terminalThemeId) ? value.terminalThemeId : null,
      warpgateBaseUrl: value.warpgateBaseUrl,
      warpgateSshHost: value.warpgateSshHost,
      warpgateSshPort: value.warpgateSshPort,
      warpgateTargetId: value.warpgateTargetId,
      warpgateTargetName: value.warpgateTargetName,
      warpgateUsername: value.warpgateUsername,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
    };
  }

  if (value.kind !== 'ssh' && typeof value.hostname !== 'string') {
    return null;
  }

  if (typeof value.hostname !== 'string' || typeof value.port !== 'number' || typeof value.username !== 'string') {
    return null;
  }

  return {
    id: value.id,
    kind: 'ssh',
    label: value.label,
    groupName: typeof value.groupName === 'string' ? value.groupName : null,
    tags,
    terminalThemeId: isTerminalThemeId(value.terminalThemeId) ? value.terminalThemeId : null,
    hostname: value.hostname,
    port: value.port,
    username: value.username,
    authType: value.authType === 'privateKey' ? 'privateKey' : 'password',
    privateKeyPath: typeof value.privateKeyPath === 'string' ? value.privateKeyPath : null,
    secretRef: typeof value.secretRef === 'string' ? value.secretRef : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
  };
}

function normalizeStateFile(value: unknown): DesktopStateFile {
  const fallback = createDefaultStateFile();
  if (!isObject(value)) {
    return fallback;
  }

  const settings = isObject(value.settings) ? value.settings : {};
  const terminal = isObject(value.terminal) ? value.terminal : {};
  const updater = isObject(value.updater) ? value.updater : {};
  const auth = isObject(value.auth) ? value.auth : {};
  const sync = isObject(value.sync) ? value.sync : {};
  const data = isObject(value.data) ? value.data : {};
  const secure = isObject(value.secure) ? value.secure : {};
  const managedSecrets = isObject(secure.managedSecretsByRef) ? secure.managedSecretsByRef : {};
  const normalizedTerminalFontFamily = normalizeTerminalFontFamily(terminal.fontFamily, fallback.terminal.fontFamily);
  const normalizedTerminalWebglEnabled = normalizeTerminalWebglEnabled(terminal.webglEnabled);

  const normalizedManagedSecrets: Record<string, StoredEncryptedValue> = {};
  for (const [secretRef, record] of Object.entries(managedSecrets)) {
    const normalized = normalizeStoredEncryptedValue(record);
    if (normalized) {
      normalizedManagedSecrets[secretRef] = normalized;
    }
  }

  return {
    schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
    settings: {
      theme: settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system',
      sftpBrowserColumnWidths: normalizeSftpBrowserColumnWidths(
        isObject(settings.sftpBrowserColumnWidths) ? settings.sftpBrowserColumnWidths : null
      ),
      sessionReplayRetentionCount: normalizeSessionReplayRetentionCount(settings.sessionReplayRetentionCount),
      serverUrlOverride: typeof settings.serverUrlOverride === 'string' && settings.serverUrlOverride.trim() ? settings.serverUrlOverride.trim() : null,
      updatedAt: typeof settings.updatedAt === 'string' ? settings.updatedAt : fallback.settings.updatedAt
    },
    terminal: {
      globalThemeId: isGlobalTerminalThemeId(terminal.globalThemeId) ? terminal.globalThemeId : fallback.terminal.globalThemeId,
      globalThemeUpdatedAt:
        typeof terminal.globalThemeUpdatedAt === 'string' ? terminal.globalThemeUpdatedAt : fallback.terminal.globalThemeUpdatedAt,
      fontFamily: normalizedTerminalFontFamily,
      fontSize: normalizeTerminalFontSize(terminal.fontSize),
      scrollbackLines: normalizeTerminalScrollbackLines(terminal.scrollbackLines),
      lineHeight: normalizeTerminalLineHeight(terminal.lineHeight),
      letterSpacing: normalizeTerminalLetterSpacing(terminal.letterSpacing),
      minimumContrastRatio: normalizeTerminalMinimumContrastRatio(terminal.minimumContrastRatio),
      altIsMeta: normalizeTerminalAltIsMeta(terminal.altIsMeta),
      webglEnabled: normalizedTerminalWebglEnabled,
      localUpdatedAt: typeof terminal.localUpdatedAt === 'string' ? terminal.localUpdatedAt : fallback.terminal.localUpdatedAt
    },
    updater: {
      dismissedVersion: typeof updater.dismissedVersion === 'string' ? updater.dismissedVersion : null,
      updatedAt: typeof updater.updatedAt === 'string' ? updater.updatedAt : fallback.updater.updatedAt
    },
    auth: {
      status:
        auth.status === 'authenticated' || auth.status === 'offline-authenticated' || auth.status === 'unauthenticated'
          ? auth.status
          : 'unknown',
      updatedAt: typeof auth.updatedAt === 'string' ? auth.updatedAt : fallback.auth.updatedAt
    },
    sync: {
      lastSuccessfulSyncAt: typeof sync.lastSuccessfulSyncAt === 'string' ? sync.lastSuccessfulSyncAt : null,
      pendingPush: typeof sync.pendingPush === 'boolean' ? sync.pendingPush : false,
      errorMessage: typeof sync.errorMessage === 'string' ? sync.errorMessage : null,
      ownerUserId: typeof sync.ownerUserId === 'string' ? sync.ownerUserId : null,
      ownerServerUrl: typeof sync.ownerServerUrl === 'string' ? sync.ownerServerUrl : null,
      updatedAt: typeof sync.updatedAt === 'string' ? sync.updatedAt : fallback.sync.updatedAt
    },
    data: {
      groups: Array.isArray(data.groups) ? (data.groups as GroupRecord[]) : [],
      hosts: Array.isArray(data.hosts) ? data.hosts.map(normalizeHostRecord).filter((entry): entry is HostRecord => entry !== null) : [],
      knownHosts: Array.isArray(data.knownHosts) ? (data.knownHosts as KnownHostRecord[]) : [],
      portForwards: Array.isArray(data.portForwards)
        ? data.portForwards
            .map(normalizePortForwardRule)
            .filter((entry): entry is PortForwardRuleRecord => entry !== null)
        : [],
      secretMetadata: Array.isArray(data.secretMetadata) ? (data.secretMetadata as SecretMetadataRecord[]) : [],
      syncOutbox: Array.isArray(data.syncOutbox) ? (data.syncOutbox as SyncDeletionRecord[]) : []
    },
    secure: {
      refreshToken: normalizeStoredEncryptedValue(secure.refreshToken),
      managedSecretsByRef: normalizedManagedSecrets
    }
  };
}

function compareIsoDesc(left: { createdAt?: string; deletedAt?: string }, right: { createdAt?: string; deletedAt?: string }): number {
  const leftValue = left.createdAt ?? left.deletedAt ?? '';
  const rightValue = right.createdAt ?? right.deletedAt ?? '';
  return rightValue.localeCompare(leftValue);
}

function normalizeActivityLogRecord(value: unknown): ActivityLogRecord | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.createdAt !== 'string' || typeof value.message !== 'string') {
    return null;
  }

  const rawCategory = typeof value.category === 'string' ? value.category : 'audit';
  const category =
    rawCategory === 'session' || rawCategory === 'ssh' || rawCategory === 'sftp'
      ? 'session'
      : 'audit';

  const level = value.level === 'warn' || value.level === 'error' ? value.level : 'info';
  const kind =
    value.kind === 'session-lifecycle' || value.kind === 'generic'
      ? value.kind
      : 'generic';
  const metadata = isObject(value.metadata) ? value.metadata : null;
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : undefined;

  return {
    id: value.id,
    level,
    category,
    kind,
    message: value.message,
    metadata,
    createdAt: value.createdAt,
    updatedAt
  };
}

class DesktopStateStorage {
  private loaded = false;
  private state = createDefaultStateFile();
  private activityLogs: ActivityLogRecord[] = [];

  getState(): DesktopStateFile {
    this.ensureLoaded();
    return deepClone(this.state);
  }

  updateState(mutator: (draft: DesktopStateFile) => void): DesktopStateFile {
    this.ensureLoaded();
    mutator(this.state);
    this.persistState();
    return deepClone(this.state);
  }

  listActivityLogs(): ActivityLogRecord[] {
    this.ensureLoaded();
    return deepClone(this.activityLogs);
  }

  appendActivityLog(record: ActivityLogRecord): ActivityLogRecord {
    this.ensureLoaded();
    this.activityLogs.unshift(record);
    appendFileSync(this.logFilePath(), `${JSON.stringify(record)}\n`, 'utf8');
    if (this.activityLogs.length > MAX_ACTIVITY_LOGS) {
      this.activityLogs = this.activityLogs.slice(0, MAX_ACTIVITY_LOGS);
      this.rewriteLogsFile();
    }
    return record;
  }

  upsertActivityLog(record: ActivityLogRecord): ActivityLogRecord {
    this.ensureLoaded();
    const currentIndex = this.activityLogs.findIndex((entry) => entry.id === record.id);
    if (currentIndex >= 0) {
      this.activityLogs[currentIndex] = { ...record };
    } else {
      this.activityLogs.unshift(record);
    }
    this.activityLogs.sort(compareIsoDesc);
    if (this.activityLogs.length > MAX_ACTIVITY_LOGS) {
      this.activityLogs = this.activityLogs.slice(0, MAX_ACTIVITY_LOGS);
    }
    this.rewriteLogsFile();
    return deepClone(record);
  }

  clearActivityLogs(): void {
    this.ensureLoaded();
    this.activityLogs = [];
    this.rewriteLogsFile();
  }

  readSecureValue(account: string): StoredEncryptedValue | null {
    this.ensureLoaded();
    if (account === 'auth:refresh-token') {
      return this.state.secure.refreshToken ? { ...this.state.secure.refreshToken } : null;
    }
    const record = this.state.secure.managedSecretsByRef[account];
    return record ? { ...record } : null;
  }

  writeSecureValue(account: string, record: StoredEncryptedValue): void {
    this.updateState((draft) => {
      if (account === 'auth:refresh-token') {
        draft.secure.refreshToken = { ...record };
        draft.auth.updatedAt = nowIso();
        return;
      }
      draft.secure.managedSecretsByRef[account] = { ...record };
    });
  }

  deleteSecureValue(account: string): void {
    this.updateState((draft) => {
      if (account === 'auth:refresh-token') {
        draft.secure.refreshToken = null;
        draft.auth.updatedAt = nowIso();
        return;
      }
      delete draft.secure.managedSecretsByRef[account];
    });
  }

  updateAuthStatus(status: DesktopStateFile['auth']['status']): void {
    this.updateState((draft) => {
      draft.auth.status = status;
      draft.auth.updatedAt = nowIso();
    });
  }

  updateSyncState(snapshot: {
    lastSuccessfulSyncAt?: string | null;
    pendingPush: boolean;
    errorMessage?: string | null;
  }): void {
    this.updateState((draft) => {
      draft.sync.lastSuccessfulSyncAt =
        Object.prototype.hasOwnProperty.call(snapshot, 'lastSuccessfulSyncAt') ? snapshot.lastSuccessfulSyncAt ?? null : draft.sync.lastSuccessfulSyncAt;
      draft.sync.pendingPush = snapshot.pendingPush;
      draft.sync.errorMessage = snapshot.errorMessage ?? null;
      draft.sync.updatedAt = nowIso();
    });
  }

  getSyncDataOwner(): { userId: string | null; serverUrl: string | null } {
    this.ensureLoaded();
    return {
      userId: this.state.sync.ownerUserId,
      serverUrl: this.state.sync.ownerServerUrl
    };
  }

  updateSyncDataOwner(owner: { userId: string | null; serverUrl: string | null }): void {
    this.updateState((draft) => {
      draft.sync.ownerUserId = owner.userId;
      draft.sync.ownerServerUrl = owner.serverUrl;
      draft.sync.updatedAt = nowIso();
    });
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }

    mkdirSync(this.storageDirectoryPath(), { recursive: true });
    this.state = this.loadStateWithRecovery();
    this.activityLogs = this.loadActivityLogs();
    this.loaded = true;
  }

  private loadStateWithRecovery(): DesktopStateFile {
    for (const filePath of [this.stateFilePath(), this.backupStateFilePath()]) {
      try {
        if (!existsSync(filePath)) {
          continue;
        }
        return normalizeStateFile(JSON.parse(readFileSync(filePath, 'utf8')));
      } catch {
        continue;
      }
    }

    return createDefaultStateFile();
  }

  private loadActivityLogs(): ActivityLogRecord[] {
    const filePath = this.logFilePath();
    if (!existsSync(filePath)) {
      return [];
    }

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const logs: ActivityLogRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = normalizeActivityLogRecord(JSON.parse(line));
        if (parsed) {
          logs.push(parsed);
        }
      } catch {
        continue;
      }
    }

    logs.sort(compareIsoDesc);
    return logs.slice(0, MAX_ACTIVITY_LOGS);
  }

  private persistState(): void {
    const serialized = JSON.stringify(this.state, null, 2);
    const tempPath = this.tempStateFilePath();
    const statePath = this.stateFilePath();
    const backupPath = this.backupStateFilePath();

    mkdirSync(this.storageDirectoryPath(), { recursive: true });
    const descriptor = openSync(tempPath, 'w');
    try {
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    if (existsSync(statePath)) {
      copyFileSync(statePath, backupPath);
    }
    renameSync(tempPath, statePath);
  }

  private rewriteLogsFile(): void {
    mkdirSync(this.storageDirectoryPath(), { recursive: true });
    const payload = this.activityLogs.map((entry) => JSON.stringify(entry)).join('\n');
    writeFileSync(this.logFilePath(), payload.length > 0 ? `${payload}\n` : '', 'utf8');
  }

  private storageDirectoryPath(): string {
    return path.join(resolveUserDataPath(), STORAGE_DIRNAME);
  }

  private stateFilePath(): string {
    return path.join(this.storageDirectoryPath(), STATE_FILE_NAME);
  }

  private tempStateFilePath(): string {
    return path.join(this.storageDirectoryPath(), STATE_TEMP_FILE_NAME);
  }

  private backupStateFilePath(): string {
    return path.join(this.storageDirectoryPath(), STATE_BACKUP_FILE_NAME);
  }

  private logFilePath(): string {
    return path.join(this.storageDirectoryPath(), ACTIVITY_LOG_FILE_NAME);
  }
}

let desktopStateStorage: DesktopStateStorage | null = null;

export function getDesktopStateStorage(): DesktopStateStorage {
  if (!desktopStateStorage) {
    desktopStateStorage = new DesktopStateStorage();
  }
  return desktopStateStorage;
}

export function resetDesktopStateStorageForTests(): void {
  desktopStateStorage = null;
}
