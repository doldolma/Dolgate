import { randomUUID } from 'node:crypto';
import {
  getGroupLabel,
  getServerUrlValidationMessage,
  getParentGroupPath,
  isAwsEc2HostDraft,
  isGroupWithinPath,
  isWarpgateSshHostDraft,
  isSshHostDraft,
  isSshHostRecord,
  normalizeServerUrl,
  normalizeGroupPath,
  stripRemovedGroupSegment
} from '@shared';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  AppSettings,
  AppTheme,
  AwsEc2HostDraft,
  AwsEc2HostRecord,
  GroupRecord,
  GroupRemoveMode,
  GroupRemoveResult,
  HostDraft,
  HostRecord,
  KnownHostRecord,
  KnownHostTrustInput,
  PortForwardDraft,
  PortForwardRuleRecord,
  SecretMetadataRecord,
  SecretSource,
  SshHostDraft,
  SshHostRecord,
  SyncKind,
  TerminalFontFamilyId,
  TerminalPreferencesRecord,
  TerminalThemeId,
  WarpgateSshHostDraft,
  WarpgateSshHostRecord
} from '@shared';
import { DesktopConfigService } from './app-config';
import { getDesktopStateStorage, type SyncDeletionRecord } from './state-storage';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTags(tags?: string[] | null): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of tags) {
    if (typeof value !== 'string') {
      continue;
    }
    const tag = value.trim();
    if (!tag) {
      continue;
    }
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
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
  if (isSshHostRecord(left) && isSshHostRecord(right)) {
    return left.hostname.localeCompare(right.hostname);
  }
  if (left.kind === right.kind) {
    if (left.kind === 'aws-ec2' && right.kind === 'aws-ec2') {
      const regionCompare = left.awsRegion.localeCompare(right.awsRegion);
      if (regionCompare !== 0) {
        return regionCompare;
      }
      return left.awsInstanceId.localeCompare(right.awsInstanceId);
    }
    if (left.kind === 'warpgate-ssh' && right.kind === 'warpgate-ssh') {
      const hostCompare = left.warpgateSshHost.localeCompare(right.warpgateSshHost);
      if (hostCompare !== 0) {
        return hostCompare;
      }
      return left.warpgateTargetName.localeCompare(right.warpgateTargetName);
    }
    return 0;
  }
  return left.kind.localeCompare(right.kind);
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

function normalizeIncomingHostRecord(record: HostRecord): HostRecord {
  if (record.kind === 'aws-ec2') {
    return {
      ...record,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId)
    };
  }

  if (record.kind === 'ssh') {
    return {
      ...record,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId)
    };
  }
  if (record.kind === 'warpgate-ssh') {
    return {
      ...record,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId)
    };
  }

  const legacyRecord = record as unknown as Partial<SshHostRecord> &
    Partial<AwsEc2HostRecord> &
    Partial<WarpgateSshHostRecord> & { id: string; label: string; createdAt: string; updatedAt: string };
  if (typeof legacyRecord.hostname === 'string' && typeof legacyRecord.port === 'number' && typeof legacyRecord.username === 'string') {
    return {
      id: legacyRecord.id,
      kind: 'ssh',
      label: legacyRecord.label,
      groupName: normalizeGroupPath(legacyRecord.groupName),
      tags: normalizeTags(legacyRecord.tags),
      terminalThemeId: normalizeTerminalThemeId(legacyRecord.terminalThemeId),
      hostname: legacyRecord.hostname,
      port: legacyRecord.port,
      username: legacyRecord.username,
      authType: legacyRecord.authType === 'privateKey' ? 'privateKey' : 'password',
      privateKeyPath: legacyRecord.privateKeyPath ?? null,
      secretRef: legacyRecord.secretRef ?? null,
      createdAt: legacyRecord.createdAt,
      updatedAt: legacyRecord.updatedAt
    };
  }

  if (
    typeof legacyRecord.awsProfileName === 'string' &&
    typeof legacyRecord.awsRegion === 'string' &&
    typeof legacyRecord.awsInstanceId === 'string'
  ) {
    return {
      id: legacyRecord.id,
      kind: 'aws-ec2',
      label: legacyRecord.label,
      groupName: normalizeGroupPath(legacyRecord.groupName),
      tags: normalizeTags(legacyRecord.tags),
      terminalThemeId: normalizeTerminalThemeId(legacyRecord.terminalThemeId),
      awsProfileName: legacyRecord.awsProfileName,
      awsRegion: legacyRecord.awsRegion,
      awsInstanceId: legacyRecord.awsInstanceId,
      awsInstanceName: legacyRecord.awsInstanceName ?? null,
      awsPlatform: legacyRecord.awsPlatform ?? null,
      awsPrivateIp: legacyRecord.awsPrivateIp ?? null,
      awsState: legacyRecord.awsState ?? null,
      createdAt: legacyRecord.createdAt,
      updatedAt: legacyRecord.updatedAt
    };
  }

  if (
    typeof legacyRecord.warpgateBaseUrl === 'string' &&
    typeof legacyRecord.warpgateSshHost === 'string' &&
    typeof legacyRecord.warpgateSshPort === 'number' &&
    typeof legacyRecord.warpgateTargetId === 'string' &&
    typeof legacyRecord.warpgateTargetName === 'string' &&
    typeof legacyRecord.warpgateUsername === 'string'
  ) {
    return {
      id: legacyRecord.id,
      kind: 'warpgate-ssh',
      label: legacyRecord.label,
      groupName: normalizeGroupPath(legacyRecord.groupName),
      tags: normalizeTags(legacyRecord.tags),
      terminalThemeId: normalizeTerminalThemeId(legacyRecord.terminalThemeId),
      warpgateBaseUrl: legacyRecord.warpgateBaseUrl,
      warpgateSshHost: legacyRecord.warpgateSshHost,
      warpgateSshPort: legacyRecord.warpgateSshPort,
      warpgateTargetId: legacyRecord.warpgateTargetId,
      warpgateTargetName: legacyRecord.warpgateTargetName,
      warpgateUsername: legacyRecord.warpgateUsername,
      createdAt: legacyRecord.createdAt,
      updatedAt: legacyRecord.updatedAt
    };
  }

  throw new Error('Unsupported host record');
}

function toSshHostRecord(id: string, draft: SshHostDraft, secretRef: string | null, timestamp: string, current?: SshHostRecord): SshHostRecord {
  return {
    id,
    kind: 'ssh',
    label: draft.label,
    hostname: draft.hostname,
    port: draft.port,
    username: draft.username,
    authType: draft.authType,
    privateKeyPath: draft.privateKeyPath ?? null,
    secretRef: secretRef ?? draft.secretRef ?? null,
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function toAwsHostRecord(id: string, draft: AwsEc2HostDraft, timestamp: string, current?: AwsEc2HostRecord): AwsEc2HostRecord {
  return {
    id,
    kind: 'aws-ec2',
    label: draft.label,
    awsProfileName: draft.awsProfileName,
    awsRegion: draft.awsRegion,
    awsInstanceId: draft.awsInstanceId,
    awsInstanceName: draft.awsInstanceName ?? null,
    awsPlatform: draft.awsPlatform ?? null,
    awsPrivateIp: draft.awsPrivateIp ?? null,
    awsState: draft.awsState ?? null,
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function toWarpgateHostRecord(
  id: string,
  draft: WarpgateSshHostDraft,
  timestamp: string,
  current?: WarpgateSshHostRecord
): WarpgateSshHostRecord {
  return {
    id,
    kind: 'warpgate-ssh',
    label: draft.label,
    warpgateBaseUrl: draft.warpgateBaseUrl,
    warpgateSshHost: draft.warpgateSshHost,
    warpgateSshPort: draft.warpgateSshPort,
    warpgateTargetId: draft.warpgateTargetId,
    warpgateTargetName: draft.warpgateTargetName,
    warpgateUsername: draft.warpgateUsername,
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function toHostRecord(id: string, draft: HostDraft, secretRef: string | null, timestamp: string, current?: HostRecord): HostRecord {
  if (isSshHostDraft(draft)) {
    return toSshHostRecord(id, draft, secretRef, timestamp, current?.kind === 'ssh' ? current : undefined);
  }
  if (isAwsEc2HostDraft(draft)) {
    return toAwsHostRecord(id, draft, timestamp, current && current.kind === 'aws-ec2' ? current : undefined);
  }
  if (isWarpgateSshHostDraft(draft)) {
    return toWarpgateHostRecord(id, draft, timestamp, current && current.kind === 'warpgate-ssh' ? current : undefined);
  }
  throw new Error('Unsupported host draft type');
}

function withLinkedHostCount(record: SecretMetadataRecord, hosts: HostRecord[]): SecretMetadataRecord {
  return {
    ...record,
    linkedHostCount: hosts.filter((host) => isSshHostRecord(host) && host.secretRef === record.secretRef).length
  };
}

const DEFAULT_GLOBAL_TERMINAL_THEME_ID: TerminalThemeId = 'dolssh-dark';
const DEFAULT_TERMINAL_FONT_FAMILY: TerminalFontFamilyId = 'sf-mono';
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const DEFAULT_TERMINAL_SCROLLBACK_LINES = 5000;
const DEFAULT_TERMINAL_LINE_HEIGHT = 1;
const DEFAULT_TERMINAL_LETTER_SPACING = 0;
const DEFAULT_TERMINAL_MINIMUM_CONTRAST_RATIO = 1;
const DEFAULT_TERMINAL_ALT_IS_META = false;
const DEFAULT_TERMINAL_WEBGL_ENABLED = true;

const stateStorage = getDesktopStateStorage();

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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
        if (entry.id !== id || !isSshHostRecord(entry)) {
          return entry;
        }
        nextRecord = {
          ...entry,
          secretRef,
          tags: normalizeTags(entry.tags),
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
        if (!isSshHostRecord(entry) || entry.secretRef !== secretRef) {
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
      state.data.hosts = records.map(normalizeIncomingHostRecord);
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

  remove(
    targetPath: string,
    mode: GroupRemoveMode
  ): GroupRemoveResult & {
    removedGroupIds: string[];
    removedHostIds: string[];
  } {
    const normalizedTargetPath = normalizeGroupPath(targetPath);
    if (!normalizedTargetPath) {
      throw new Error('Group path is invalid');
    }

    const removedGroupIds: string[] = [];
    const removedHostIds: string[] = [];
    const nextState = stateStorage.updateState((state) => {
      const timestamp = nowIso();

      const affectedGroups = state.data.groups.filter((record) => isGroupWithinPath(record.path, normalizedTargetPath));
      const affectedHosts = state.data.hosts.filter((record) => isGroupWithinPath(normalizeGroupPath(record.groupName), normalizedTargetPath));

      if (affectedGroups.length === 0 && affectedHosts.length === 0) {
        throw new Error('Group not found');
      }

      if (mode === 'delete-subtree') {
        removedGroupIds.push(...affectedGroups.map((record) => record.id));
        removedHostIds.push(...affectedHosts.map((record) => record.id));
        state.data.groups = state.data.groups.filter((record) => !isGroupWithinPath(record.path, normalizedTargetPath));
        state.data.hosts = state.data.hosts.filter((record) => !isGroupWithinPath(normalizeGroupPath(record.groupName), normalizedTargetPath));
        return;
      }

      const remainingGroups = state.data.groups.filter((record) => !isGroupWithinPath(record.path, normalizedTargetPath));
      const nextGroupsByPath = new Map<string, GroupRecord>();
      for (const record of remainingGroups) {
        nextGroupsByPath.set(record.path, record);
      }

      for (const record of affectedGroups) {
        if (record.path === normalizedTargetPath) {
          removedGroupIds.push(record.id);
          continue;
        }
        const rebasedPath = stripRemovedGroupSegment(record.path, normalizedTargetPath);
        if (!rebasedPath || nextGroupsByPath.has(rebasedPath)) {
          removedGroupIds.push(record.id);
          continue;
        }
        nextGroupsByPath.set(rebasedPath, {
          ...record,
          name: getGroupLabel(rebasedPath),
          path: rebasedPath,
          parentPath: getParentGroupPath(rebasedPath),
          updatedAt: timestamp
        });
      }

      state.data.groups = [...nextGroupsByPath.values()];
      state.data.hosts = state.data.hosts.map((record) => {
        const hostGroupPath = normalizeGroupPath(record.groupName);
        if (!isGroupWithinPath(hostGroupPath, normalizedTargetPath)) {
          return record;
        }
        const nextGroupPath = stripRemovedGroupSegment(hostGroupPath, normalizedTargetPath);
        return normalizeIncomingHostRecord({
          ...record,
          groupName: nextGroupPath,
          updatedAt: timestamp
        });
      });
    });

    return {
      groups: nextState.data.groups.sort((left, right) => left.path.localeCompare(right.path)),
      hosts: nextState.data.hosts.sort(compareHosts),
      removedGroupIds,
      removedHostIds
    };
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
  constructor(private readonly configService: DesktopConfigService = new DesktopConfigService()) {}

  private getDefaultServerUrl(): string {
    return this.configService.getConfig().sync.serverUrl;
  }

  get(): AppSettings {
    const state = stateStorage.getState();
    const serverUrlOverride = state.settings.serverUrlOverride ?? null;
    return {
      theme: state.settings.theme,
      globalTerminalThemeId: state.terminal.globalThemeId,
      terminalFontFamily: state.terminal.fontFamily,
      terminalFontSize: state.terminal.fontSize,
      terminalScrollbackLines: state.terminal.scrollbackLines,
      terminalLineHeight: state.terminal.lineHeight,
      terminalLetterSpacing: state.terminal.letterSpacing,
      terminalMinimumContrastRatio: state.terminal.minimumContrastRatio,
      terminalAltIsMeta: state.terminal.altIsMeta,
      terminalWebglEnabled: state.terminal.webglEnabled,
      serverUrl: serverUrlOverride || this.getDefaultServerUrl(),
      serverUrlOverride,
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
        state.terminal.fontSize = clampInteger(input.terminalFontSize, 11, 18);
        state.terminal.localUpdatedAt = nowIso();
      }

      if (typeof input.terminalScrollbackLines === 'number' && Number.isFinite(input.terminalScrollbackLines)) {
        state.terminal.scrollbackLines = clampInteger(input.terminalScrollbackLines, 1000, 25000);
        state.terminal.localUpdatedAt = nowIso();
      }

      if (typeof input.terminalLineHeight === 'number' && Number.isFinite(input.terminalLineHeight)) {
        state.terminal.lineHeight = clampNumber(input.terminalLineHeight, 1, 2);
        state.terminal.localUpdatedAt = nowIso();
      }

      if (typeof input.terminalLetterSpacing === 'number' && Number.isFinite(input.terminalLetterSpacing)) {
        state.terminal.letterSpacing = clampInteger(input.terminalLetterSpacing, 0, 2);
        state.terminal.localUpdatedAt = nowIso();
      }

      if (typeof input.terminalMinimumContrastRatio === 'number' && Number.isFinite(input.terminalMinimumContrastRatio)) {
        state.terminal.minimumContrastRatio = clampNumber(input.terminalMinimumContrastRatio, 1, 21);
        state.terminal.localUpdatedAt = nowIso();
      }

      if (typeof input.terminalAltIsMeta === 'boolean') {
        state.terminal.altIsMeta = input.terminalAltIsMeta;
        state.terminal.localUpdatedAt = nowIso();
      }

      if (typeof input.terminalWebglEnabled === 'boolean') {
        state.terminal.webglEnabled = input.terminalWebglEnabled;
        state.terminal.localUpdatedAt = nowIso();
      }

      if (Object.prototype.hasOwnProperty.call(input, 'serverUrlOverride')) {
        const nextValue =
          typeof input.serverUrlOverride === 'string' && input.serverUrlOverride.trim() ? input.serverUrlOverride.trim() : null;
        if (nextValue) {
          const validationMessage = getServerUrlValidationMessage(nextValue);
          if (validationMessage) {
            throw new Error(validationMessage);
          }
        }
        state.settings.serverUrlOverride = nextValue ? normalizeServerUrl(nextValue) : null;
        state.settings.updatedAt = nowIso();
      }

      if (Object.prototype.hasOwnProperty.call(input, 'dismissedUpdateVersion')) {
        state.updater.dismissedVersion = input.dismissedUpdateVersion ?? null;
        state.updater.updatedAt = nowIso();
      }

      if (
        !Object.prototype.hasOwnProperty.call(input, 'dismissedUpdateVersion') &&
        !Object.prototype.hasOwnProperty.call(input, 'serverUrlOverride') &&
        input.theme == null &&
        input.globalTerminalThemeId == null &&
        input.terminalFontFamily == null &&
        input.terminalFontSize == null &&
        input.terminalScrollbackLines == null &&
        input.terminalLineHeight == null &&
        input.terminalLetterSpacing == null &&
        input.terminalMinimumContrastRatio == null &&
        input.terminalAltIsMeta == null &&
        input.terminalWebglEnabled == null
      ) {
        state.settings.theme = current.theme as AppTheme;
        state.settings.serverUrlOverride = current.serverUrlOverride ?? null;
        state.terminal.globalThemeId = current.globalTerminalThemeId ?? DEFAULT_GLOBAL_TERMINAL_THEME_ID;
        state.terminal.fontFamily = current.terminalFontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
        state.terminal.fontSize = current.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
        state.terminal.scrollbackLines = current.terminalScrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK_LINES;
        state.terminal.lineHeight = current.terminalLineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT;
        state.terminal.letterSpacing = current.terminalLetterSpacing ?? DEFAULT_TERMINAL_LETTER_SPACING;
        state.terminal.minimumContrastRatio =
          current.terminalMinimumContrastRatio ?? DEFAULT_TERMINAL_MINIMUM_CONTRAST_RATIO;
        state.terminal.altIsMeta = current.terminalAltIsMeta ?? DEFAULT_TERMINAL_ALT_IS_META;
        state.terminal.webglEnabled = current.terminalWebglEnabled ?? DEFAULT_TERMINAL_WEBGL_ENABLED;
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
