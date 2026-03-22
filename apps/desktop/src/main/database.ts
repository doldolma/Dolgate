import { randomUUID } from 'node:crypto';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  AppSettings,
  AppTheme,
  GroupRecord,
  HostDraft,
  HostRecord,
  KnownHostRecord,
  KnownHostTrustInput,
  PortForwardDraft,
  PortForwardRuleRecord,
  SecretMetadataRecord,
  SecretSource,
  SyncKind,
  TerminalFontFamilyId,
  TerminalPreferencesRecord,
  TerminalThemeId
} from '@shared';
import { getDesktopStateStorage, type SyncDeletionRecord } from './state-storage';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeGroupPath(groupPath?: string | null): string | null {
  const normalized = (groupPath ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  return normalized.length > 0 ? normalized : null;
}

function compareHosts(left: HostRecord, right: HostRecord): number {
  const groupCompare = (left.groupName ?? '').localeCompare(right.groupName ?? '');
  if (groupCompare !== 0) {
    return groupCompare;
  }
  const labelCompare = left.label.localeCompare(right.label);
  if (labelCompare !== 0) {
    return labelCompare;
  }
  return left.hostname.localeCompare(right.hostname);
}

function compareLabels(left: { label: string; secretRef?: string }, right: { label: string; secretRef?: string }): number {
  const labelCompare = left.label.localeCompare(right.label);
  if (labelCompare !== 0) {
    return labelCompare;
  }
  return (left.secretRef ?? '').localeCompare(right.secretRef ?? '');
}

function compareDeletedAtDesc(left: SyncDeletionRecord, right: SyncDeletionRecord): number {
  return right.deletedAt.localeCompare(left.deletedAt);
}

function normalizeTerminalThemeId(terminalThemeId?: TerminalThemeId | null): TerminalThemeId | null {
  return terminalThemeId ?? null;
}

function toHostRecord(id: string, draft: HostDraft, secretRef: string | null, timestamp: string, current?: HostRecord): HostRecord {
  return {
    id,
    label: draft.label,
    hostname: draft.hostname,
    port: draft.port,
    username: draft.username,
    authType: draft.authType,
    privateKeyPath: draft.privateKeyPath ?? null,
    secretRef: secretRef ?? draft.secretRef ?? null,
    groupName: normalizeGroupPath(draft.groupName),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function withLinkedHostCount(record: SecretMetadataRecord, hosts: HostRecord[]): SecretMetadataRecord {
  return {
    ...record,
    linkedHostCount: hosts.filter((host) => host.secretRef === record.secretRef).length
  };
}

const DEFAULT_GLOBAL_TERMINAL_THEME_ID: TerminalThemeId = 'dolssh-dark';
const DEFAULT_TERMINAL_FONT_FAMILY: TerminalFontFamilyId = 'sf-mono';
const DEFAULT_TERMINAL_FONT_SIZE = 13;

const stateStorage = getDesktopStateStorage();

export class HostRepository {
  list(): HostRecord[] {
    return stateStorage.getState().data.hosts.sort(compareHosts);
  }

  getById(id: string): HostRecord | null {
    return stateStorage.getState().data.hosts.find((record) => record.id === id) ?? null;
  }

  create(id: string, draft: HostDraft, secretRef?: string | null): HostRecord {
    const timestamp = nowIso();
    const record = toHostRecord(id, draft, secretRef ?? null, timestamp);
    stateStorage.updateState((state) => {
      state.data.hosts.push(record);
    });
    return record;
  }

  update(id: string, draft: HostDraft, secretRef?: string | null): HostRecord {
    const current = this.getById(id);
    if (!current) {
      throw new Error('Host not found');
    }

    const record = toHostRecord(id, draft, secretRef ?? null, nowIso(), current);
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => (entry.id === id ? record : entry));
    });
    return record;
  }

  updateSecretRef(id: string, secretRef: string | null): HostRecord | null {
    let nextRecord: HostRecord | null = null;
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.id !== id) {
          return entry;
        }
        nextRecord = {
          ...entry,
          secretRef,
          terminalThemeId: normalizeTerminalThemeId(entry.terminalThemeId),
          updatedAt: nowIso()
        };
        return nextRecord;
      });
    });
    return nextRecord;
  }

  clearSecretRef(secretRef: string): void {
    const timestamp = nowIso();
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.secretRef !== secretRef) {
          return entry;
        }
        return {
          ...entry,
          secretRef: null,
          updatedAt: timestamp
        };
      });
    });
  }

  remove(id: string): void {
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.filter((entry) => entry.id !== id);
    });
  }

  replaceAll(records: HostRecord[]): void {
    stateStorage.updateState((state) => {
      state.data.hosts = records.map((record) => ({
        ...record,
        groupName: normalizeGroupPath(record.groupName),
        terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId)
      }));
    });
  }
}

export class GroupRepository {
  list(): GroupRecord[] {
    return stateStorage
      .getState()
      .data.groups.sort((left, right) => left.path.localeCompare(right.path));
  }

  getByPath(targetPath: string): GroupRecord | null {
    return stateStorage.getState().data.groups.find((record) => record.path === targetPath) ?? null;
  }

  create(id: string, name: string, parentPath?: string | null): GroupRecord {
    const cleanedName = name.trim();
    if (!cleanedName) {
      throw new Error('Group name is required');
    }

    const normalizedParentPath = normalizeGroupPath(parentPath);
    const nextPath = normalizeGroupPath(normalizedParentPath ? `${normalizedParentPath}/${cleanedName}` : cleanedName);
    if (!nextPath) {
      throw new Error('Group path is invalid');
    }
    if (this.getByPath(nextPath)) {
      throw new Error('Group already exists');
    }

    const timestamp = nowIso();
    const record: GroupRecord = {
      id,
      name: cleanedName,
      path: nextPath,
      parentPath: normalizedParentPath,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    stateStorage.updateState((state) => {
      state.data.groups.push(record);
    });
    return record;
  }

  replaceAll(records: GroupRecord[]): void {
    stateStorage.updateState((state) => {
      state.data.groups = records.map((record) => ({
        ...record,
        parentPath: normalizeGroupPath(record.parentPath)
      }));
    });
  }
}

export class SettingsRepository {
  get(): AppSettings {
    const state = stateStorage.getState();
    return {
      theme: state.settings.theme,
      globalTerminalThemeId: state.terminal.globalThemeId,
      terminalFontFamily: state.terminal.fontFamily,
      terminalFontSize: state.terminal.fontSize,
      dismissedUpdateVersion: state.updater.dismissedVersion,
      updatedAt: [
        state.settings.updatedAt,
        state.updater.updatedAt,
        state.terminal.globalThemeUpdatedAt,
        state.terminal.localUpdatedAt
      ].sort((left, right) => right.localeCompare(left))[0]
    };
  }

  getSyncedTerminalPreferences(): TerminalPreferencesRecord {
    const state = stateStorage.getState();
    return {
      id: 'global-terminal',
      globalTerminalThemeId: state.terminal.globalThemeId,
      updatedAt: state.terminal.globalThemeUpdatedAt
    };
  }

  replaceSyncedTerminalPreferences(record: TerminalPreferencesRecord | null): void {
    stateStorage.updateState((state) => {
      state.terminal.globalThemeId = record?.globalTerminalThemeId ?? DEFAULT_GLOBAL_TERMINAL_THEME_ID;
      state.terminal.globalThemeUpdatedAt = record?.updatedAt ?? nowIso();
    });
  }

  clearSyncedTerminalPreferences(): void {
    this.replaceSyncedTerminalPreferences(null);
  }

  update(input: Partial<AppSettings>): AppSettings {
    const current = this.get();
    stateStorage.updateState((state) => {
      if (input.theme === 'light' || input.theme === 'dark' || input.theme === 'system') {
        state.settings.theme = input.theme;
        state.settings.updatedAt = nowIso();
      }

      if (input.globalTerminalThemeId) {
        state.terminal.globalThemeId = input.globalTerminalThemeId;
        state.terminal.globalThemeUpdatedAt = nowIso();
      }

      if (input.terminalFontFamily) {
        state.terminal.fontFamily = input.terminalFontFamily;
        state.terminal.localUpdatedAt = nowIso();
      }

      if (typeof input.terminalFontSize === 'number' && Number.isFinite(input.terminalFontSize)) {
        state.terminal.fontSize = Math.min(18, Math.max(11, Math.round(input.terminalFontSize)));
        state.terminal.localUpdatedAt = nowIso();
      }

      if (Object.prototype.hasOwnProperty.call(input, 'dismissedUpdateVersion')) {
        state.updater.dismissedVersion = input.dismissedUpdateVersion ?? null;
        state.updater.updatedAt = nowIso();
      }

      if (
        !Object.prototype.hasOwnProperty.call(input, 'dismissedUpdateVersion') &&
        input.theme == null &&
        input.globalTerminalThemeId == null &&
        input.terminalFontFamily == null &&
        input.terminalFontSize == null
      ) {
        state.settings.theme = current.theme as AppTheme;
        state.terminal.globalThemeId = current.globalTerminalThemeId ?? DEFAULT_GLOBAL_TERMINAL_THEME_ID;
        state.terminal.fontFamily = current.terminalFontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
        state.terminal.fontSize = current.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
      }
    });
    return this.get();
  }
}

export class PortForwardRepository {
  list(): PortForwardRuleRecord[] {
    return stateStorage
      .getState()
      .data.portForwards.sort((left, right) => {
        const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
        if (updatedCompare !== 0) {
          return updatedCompare;
        }
        return left.label.localeCompare(right.label);
      });
  }

  getById(id: string): PortForwardRuleRecord | null {
    return stateStorage.getState().data.portForwards.find((record) => record.id === id) ?? null;
  }

  create(draft: PortForwardDraft): PortForwardRuleRecord {
    const timestamp = nowIso();
    const record: PortForwardRuleRecord = {
      id: randomUUID(),
      label: draft.label.trim(),
      hostId: draft.hostId,
      mode: draft.mode,
      bindAddress: draft.bindAddress.trim(),
      bindPort: draft.bindPort,
      targetHost: draft.mode === 'dynamic' ? null : draft.targetHost?.trim() ?? null,
      targetPort: draft.mode === 'dynamic' ? null : draft.targetPort ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    stateStorage.updateState((state) => {
      state.data.portForwards.push(record);
    });
    return record;
  }

  update(id: string, draft: PortForwardDraft): PortForwardRuleRecord {
    const current = this.getById(id);
    if (!current) {
      throw new Error('Port forward rule not found');
    }

    const record: PortForwardRuleRecord = {
      ...current,
      label: draft.label.trim(),
      hostId: draft.hostId,
      mode: draft.mode,
      bindAddress: draft.bindAddress.trim(),
      bindPort: draft.bindPort,
      targetHost: draft.mode === 'dynamic' ? null : draft.targetHost?.trim() ?? null,
      targetPort: draft.mode === 'dynamic' ? null : draft.targetPort ?? null,
      updatedAt: nowIso()
    };

    stateStorage.updateState((state) => {
      state.data.portForwards = state.data.portForwards.map((entry) => (entry.id === id ? record : entry));
    });
    return record;
  }

  remove(id: string): void {
    stateStorage.updateState((state) => {
      state.data.portForwards = state.data.portForwards.filter((entry) => entry.id !== id);
    });
  }

  replaceAll(records: PortForwardRuleRecord[]): void {
    stateStorage.updateState((state) => {
      state.data.portForwards = records.map((record) => ({ ...record }));
    });
  }
}

export class KnownHostRepository {
  list(): KnownHostRecord[] {
    return stateStorage
      .getState()
      .data.knownHosts.sort((left, right) => {
        const hostCompare = left.host.localeCompare(right.host);
        if (hostCompare !== 0) {
          return hostCompare;
        }
        return left.port - right.port;
      });
  }

  getByHostPort(host: string, port: number): KnownHostRecord | null {
    return stateStorage.getState().data.knownHosts.find((record) => record.host === host && record.port === port) ?? null;
  }

  trust(input: KnownHostTrustInput): KnownHostRecord {
    const current = this.getByHostPort(input.host, input.port);
    const timestamp = nowIso();
    const record: KnownHostRecord = {
      id: current?.id ?? randomUUID(),
      host: input.host,
      port: input.port,
      algorithm: input.algorithm,
      publicKeyBase64: input.publicKeyBase64,
      fingerprintSha256: input.fingerprintSha256,
      createdAt: current?.createdAt ?? timestamp,
      lastSeenAt: timestamp,
      updatedAt: timestamp
    };

    stateStorage.updateState((state) => {
      if (current) {
        state.data.knownHosts = state.data.knownHosts.map((entry) => (entry.id === current.id ? record : entry));
        return;
      }
      state.data.knownHosts.push(record);
    });
    return record;
  }

  touch(host: string, port: number): void {
    const timestamp = nowIso();
    stateStorage.updateState((state) => {
      state.data.knownHosts = state.data.knownHosts.map((entry) => {
        if (entry.host !== host || entry.port !== port) {
          return entry;
        }
        return {
          ...entry,
          lastSeenAt: timestamp,
          updatedAt: timestamp
        };
      });
    });
  }

  remove(id: string): void {
    stateStorage.updateState((state) => {
      state.data.knownHosts = state.data.knownHosts.filter((entry) => entry.id !== id);
    });
  }

  replaceAll(records: KnownHostRecord[]): void {
    stateStorage.updateState((state) => {
      state.data.knownHosts = records.map((record) => ({ ...record }));
    });
  }
}

export class ActivityLogRepository {
  list(): ActivityLogRecord[] {
    return stateStorage.listActivityLogs();
  }

  append(level: ActivityLogLevel, category: ActivityLogCategory, message: string, metadata?: Record<string, unknown> | null): ActivityLogRecord {
    const record: ActivityLogRecord = {
      id: randomUUID(),
      level,
      category,
      message,
      metadata: metadata ?? null,
      createdAt: nowIso()
    };
    return stateStorage.appendActivityLog(record);
  }

  clear(): void {
    stateStorage.clearActivityLogs();
  }
}

export class SecretMetadataRepository {
  upsert(input: {
    secretRef: string;
    label: string;
    hasPassword: boolean;
    hasPassphrase: boolean;
    hasManagedPrivateKey?: boolean;
    source?: SecretSource;
  }): void {
    stateStorage.updateState((state) => {
      const timestamp = nowIso();
      const nextRecord: SecretMetadataRecord = {
        secretRef: input.secretRef,
        label: input.label,
        hasPassword: input.hasPassword,
        hasPassphrase: input.hasPassphrase,
        hasManagedPrivateKey: input.hasManagedPrivateKey ?? false,
        source: input.source ?? 'local_keychain',
        linkedHostCount: 0,
        updatedAt: timestamp
      };

      const currentIndex = state.data.secretMetadata.findIndex((record) => record.secretRef === input.secretRef);
      if (currentIndex >= 0) {
        state.data.secretMetadata[currentIndex] = {
          ...state.data.secretMetadata[currentIndex],
          ...nextRecord
        };
        return;
      }
      state.data.secretMetadata.push(nextRecord);
    });
  }

  remove(secretRef: string): void {
    stateStorage.updateState((state) => {
      state.data.secretMetadata = state.data.secretMetadata.filter((record) => record.secretRef !== secretRef);
    });
  }

  getBySecretRef(secretRef: string): SecretMetadataRecord | null {
    const state = stateStorage.getState();
    const record = state.data.secretMetadata.find((entry) => entry.secretRef === secretRef);
    return record ? withLinkedHostCount(record, state.data.hosts) : null;
  }

  list(): SecretMetadataRecord[] {
    const state = stateStorage.getState();
    return state.data.secretMetadata.map((record) => withLinkedHostCount(record, state.data.hosts)).sort(compareLabels);
  }

  listBySource(source: SecretSource): SecretMetadataRecord[] {
    const state = stateStorage.getState();
    return state.data.secretMetadata
      .filter((record) => record.source === source)
      .map((record) => withLinkedHostCount(record, state.data.hosts))
      .sort(compareLabels);
  }

  replaceAll(records: SecretMetadataRecord[], source: SecretSource = 'server_managed'): void {
    stateStorage.updateState((state) => {
      const remaining = state.data.secretMetadata.filter((record) => record.source !== source);
      const nextRecords = records.map((record) => ({
        ...record,
        source,
        linkedHostCount: 0
      }));
      state.data.secretMetadata = [...remaining, ...nextRecords];
    });
  }
}

export { SyncDeletionRecord };

export class SyncOutboxRepository {
  list(): SyncDeletionRecord[] {
    return stateStorage.getState().data.syncOutbox.sort(compareDeletedAtDesc);
  }

  upsertDeletion(kind: SyncKind, recordId: string, deletedAt: string = nowIso()): void {
    stateStorage.updateState((state) => {
      const currentIndex = state.data.syncOutbox.findIndex((entry) => entry.kind === kind && entry.recordId === recordId);
      const nextRecord: SyncDeletionRecord = {
        kind,
        recordId,
        deletedAt
      };
      if (currentIndex >= 0) {
        state.data.syncOutbox[currentIndex] = nextRecord;
        return;
      }
      state.data.syncOutbox.push(nextRecord);
    });
  }

  clear(kind: SyncKind, recordId: string): void {
    stateStorage.updateState((state) => {
      state.data.syncOutbox = state.data.syncOutbox.filter((entry) => !(entry.kind === kind && entry.recordId === recordId));
    });
  }

  clearMany(records: Array<{ kind: SyncKind; recordId: string }>): void {
    const keys = new Set(records.map((record) => `${record.kind}:${record.recordId}`));
    stateStorage.updateState((state) => {
      state.data.syncOutbox = state.data.syncOutbox.filter((entry) => !keys.has(`${entry.kind}:${entry.recordId}`));
    });
  }

  clearAll(): void {
    stateStorage.updateState((state) => {
      state.data.syncOutbox = [];
    });
  }
}
