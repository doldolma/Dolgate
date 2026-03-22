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
  AppTheme,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  PortForwardRuleRecord,
  SecretMetadataRecord
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
    updatedAt: string;
  };
  updater: {
    dismissedVersion: string | null;
    updatedAt: string;
  };
  auth: {
    status: 'unknown' | 'authenticated' | 'unauthenticated';
    updatedAt: string;
  };
  sync: {
    lastSuccessfulSyncAt: string | null;
    pendingPush: boolean;
    errorMessage: string | null;
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

function createDefaultStateFile(): DesktopStateFile {
  const timestamp = nowIso();
  return {
    schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
    settings: {
      theme: 'system',
      updatedAt: timestamp
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

function normalizeStateFile(value: unknown): DesktopStateFile {
  const fallback = createDefaultStateFile();
  if (!isObject(value)) {
    return fallback;
  }

  const settings = isObject(value.settings) ? value.settings : {};
  const updater = isObject(value.updater) ? value.updater : {};
  const auth = isObject(value.auth) ? value.auth : {};
  const sync = isObject(value.sync) ? value.sync : {};
  const data = isObject(value.data) ? value.data : {};
  const secure = isObject(value.secure) ? value.secure : {};
  const managedSecrets = isObject(secure.managedSecretsByRef) ? secure.managedSecretsByRef : {};

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
      updatedAt: typeof settings.updatedAt === 'string' ? settings.updatedAt : fallback.settings.updatedAt
    },
    updater: {
      dismissedVersion: typeof updater.dismissedVersion === 'string' ? updater.dismissedVersion : null,
      updatedAt: typeof updater.updatedAt === 'string' ? updater.updatedAt : fallback.updater.updatedAt
    },
    auth: {
      status: auth.status === 'authenticated' || auth.status === 'unauthenticated' ? auth.status : 'unknown',
      updatedAt: typeof auth.updatedAt === 'string' ? auth.updatedAt : fallback.auth.updatedAt
    },
    sync: {
      lastSuccessfulSyncAt: typeof sync.lastSuccessfulSyncAt === 'string' ? sync.lastSuccessfulSyncAt : null,
      pendingPush: typeof sync.pendingPush === 'boolean' ? sync.pendingPush : false,
      errorMessage: typeof sync.errorMessage === 'string' ? sync.errorMessage : null,
      updatedAt: typeof sync.updatedAt === 'string' ? sync.updatedAt : fallback.sync.updatedAt
    },
    data: {
      groups: Array.isArray(data.groups) ? (data.groups as GroupRecord[]) : [],
      hosts: Array.isArray(data.hosts) ? (data.hosts as HostRecord[]) : [],
      knownHosts: Array.isArray(data.knownHosts) ? (data.knownHosts as KnownHostRecord[]) : [],
      portForwards: Array.isArray(data.portForwards) ? (data.portForwards as PortForwardRuleRecord[]) : [],
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
  const metadata = isObject(value.metadata) ? value.metadata : null;

  return {
    id: value.id,
    level,
    category,
    message: value.message,
    metadata,
    createdAt: value.createdAt
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
