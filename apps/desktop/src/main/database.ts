import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
  MAX_SESSION_REPLAY_RETENTION_COUNT,
  MIN_SESSION_REPLAY_RETENTION_COUNT,
  isDnsOverrideEligiblePortForwardRule,
  isLinkedDnsOverrideDraft,
  isLinkedDnsOverrideRecord,
  isStaticDnsOverrideDraft,
  getGroupLabel,
  getServerUrlValidationMessage,
  getParentGroupPath,
  isAwsEc2HostDraft,
  isAwsEcsHostDraft,
  isGroupWithinPath,
  isWarpgateSshHostDraft,
  isSerialHostDraft,
  isSshHostDraft,
  isSshHostRecord,
  isSerialHostRecord,
  normalizeSftpBrowserColumnWidths,
  normalizeServerUrl,
  normalizeGroupPath,
  rebaseGroupPath,
  stripRemovedGroupSegment
} from '@shared';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  AppSettings,
  AppTheme,
  AwsProfileMetadataRecord,
  AwsSshMetadataStatus,
  AwsEc2HostDraft,
  AwsEc2HostRecord,
  AwsEcsHostDraft,
  AwsEcsHostRecord,
  DnsOverrideDraft,
  DnsOverrideRecord,
  GlobalTerminalThemeId,
  GroupPathMutationResult,
  GroupRecord,
  GroupRemoveMode,
  GroupRemoveResult,
  HostDraft,
  HostRecord,
  KnownHostRecord,
  KnownHostTrustInput,
  ManagedAwsProfileKind,
  ManagedAwsProfilePayload,
  PortForwardDraft,
  PortForwardRuleRecord,
  SecretMetadataRecord,
  SftpBrowserColumnWidths,
  SshHostDraft,
  SshHostRecord,
  SerialHostDraft,
  SerialHostRecord,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialStopBits,
  SyncKind,
  TerminalFontFamilyId,
  TerminalPreferencesRecord,
  TerminalThemeId,
  WarpgateSshHostDraft,
  WarpgateSshHostRecord
} from '@shared';
import { DesktopConfigService } from './app-config';
import { getDesktopStateStorage, type SyncDeletionRecord } from './state-storage';
import { decodeSecretFromStorage, encodeSecretForStorage } from './secret-store';

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
    if (left.kind === 'aws-ecs' && right.kind === 'aws-ecs') {
      const regionCompare = left.awsRegion.localeCompare(right.awsRegion);
      if (regionCompare !== 0) {
        return regionCompare;
      }
      return left.awsEcsClusterName.localeCompare(right.awsEcsClusterName);
    }
    if (left.kind === 'warpgate-ssh' && right.kind === 'warpgate-ssh') {
      const hostCompare = left.warpgateSshHost.localeCompare(right.warpgateSshHost);
      if (hostCompare !== 0) {
        return hostCompare;
      }
      return left.warpgateTargetName.localeCompare(right.warpgateTargetName);
    }
    if (left.kind === 'serial' && right.kind === 'serial') {
      if (left.transport === 'local' && right.transport === 'local') {
        return (left.devicePath ?? '').localeCompare(right.devicePath ?? '');
      }
      const endpointCompare = (left.host ?? '').localeCompare(right.host ?? '');
      if (endpointCompare !== 0) {
        return endpointCompare;
      }
      return (left.port ?? 0) - (right.port ?? 0);
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

function compareDnsOverrides(left: DnsOverrideRecord, right: DnsOverrideRecord): number {
  const hostCompare = left.hostname.localeCompare(right.hostname);
  if (hostCompare !== 0) {
    return hostCompare;
  }
  const leftKey = isLinkedDnsOverrideRecord(left) ? `linked:${left.portForwardRuleId}` : `static:${left.address}`;
  const rightKey = isLinkedDnsOverrideRecord(right) ? `linked:${right.portForwardRuleId}` : `static:${right.address}`;
  return leftKey.localeCompare(rightKey);
}

function compareDeletedAtDesc(left: SyncDeletionRecord, right: SyncDeletionRecord): number {
  return right.deletedAt.localeCompare(left.deletedAt);
}

function compareAwsProfileMetadata(left: AwsProfileMetadataRecord, right: AwsProfileMetadataRecord): number {
  const nameCompare = left.name.localeCompare(right.name);
  if (nameCompare !== 0) {
    return nameCompare;
  }
  return left.id.localeCompare(right.id);
}

function normalizeDnsOverrideHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function isValidDnsOverrideHostname(hostname: string): boolean {
  if (!hostname || hostname.includes('*') || hostname.includes(' ') || hostname.endsWith('.')) {
    return false;
  }
  const labels = hostname.split('.');
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function normalizeDnsOverrideAddress(address: string): string {
  return address.trim();
}

function normalizeIncomingDnsOverrideRecord(record: DnsOverrideRecord): DnsOverrideRecord | null {
  const hostname = normalizeDnsOverrideHostname(record.hostname);
  if (!isValidDnsOverrideHostname(hostname)) {
    return null;
  }

  if (isLinkedDnsOverrideRecord(record)) {
    if (typeof record.portForwardRuleId !== 'string' || !record.portForwardRuleId.trim()) {
      return null;
    }
    return {
      ...record,
      type: 'linked',
      hostname,
      portForwardRuleId: record.portForwardRuleId,
    };
  }

  const legacyRecord = record as DnsOverrideRecord & { portForwardRuleId?: string };
  if (!record.type && typeof legacyRecord.portForwardRuleId === 'string') {
    return {
      id: legacyRecord.id,
      type: 'linked',
      hostname,
      portForwardRuleId: legacyRecord.portForwardRuleId,
      createdAt: legacyRecord.createdAt,
      updatedAt: legacyRecord.updatedAt,
    };
  }

  if (!('address' in record) || typeof record.address !== 'string') {
    return null;
  }

  const address = normalizeDnsOverrideAddress(record.address);
  if (!address || isIP(address) === 0) {
    return null;
  }

  return {
    id: record.id,
    type: 'static',
    hostname,
    address,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeTerminalThemeId(terminalThemeId?: TerminalThemeId | null): TerminalThemeId | null {
  return terminalThemeId ?? null;
}

function normalizeAwsSshMetadataStatus(
  status?: AwsSshMetadataStatus | null,
  fallback?: { awsSshUsername?: string | null; awsSshPort?: number | null }
): AwsSshMetadataStatus {
  if (status === 'loading' || status === 'ready' || status === 'error' || status === 'idle') {
    return status;
  }
  return fallback?.awsSshUsername?.trim() || fallback?.awsSshPort ? 'ready' : 'idle';
}

function normalizeAwsSshMetadataError(error?: string | null): string | null {
  const trimmed = error?.trim();
  return trimmed ? trimmed : null;
}

function clampSessionReplayRetentionCount(value: number): number {
  return Math.min(
    MAX_SESSION_REPLAY_RETENTION_COUNT,
    Math.max(MIN_SESSION_REPLAY_RETENTION_COUNT, Math.round(value)),
  );
}

function normalizeIncomingHostRecord(record: HostRecord): HostRecord {
  if (record.kind === 'aws-ec2') {
    return {
      ...record,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId),
      awsSshUsername: record.awsSshUsername ?? null,
      awsSshPort: record.awsSshPort ?? null,
      awsSshMetadataStatus: normalizeAwsSshMetadataStatus(record.awsSshMetadataStatus, record),
      awsSshMetadataError: normalizeAwsSshMetadataError(record.awsSshMetadataError)
    };
  }

  if (record.kind === 'aws-ecs') {
    return {
      ...record,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId),
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
  if (record.kind === 'serial') {
    return {
      ...record,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId),
      devicePath: record.devicePath?.trim() || null,
      host: record.host?.trim() || null,
      port: typeof record.port === 'number' ? Math.round(record.port) : null,
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
      authType:
        legacyRecord.authType === 'privateKey'
          ? 'privateKey'
          : legacyRecord.authType === 'certificate'
            ? 'certificate'
            : 'password',
      privateKeyPath: null,
      certificatePath: null,
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
      awsProfileId: typeof legacyRecord.awsProfileId === 'string' ? legacyRecord.awsProfileId : null,
      awsProfileName: legacyRecord.awsProfileName,
      awsRegion: legacyRecord.awsRegion,
      awsInstanceId: legacyRecord.awsInstanceId,
      awsInstanceName: legacyRecord.awsInstanceName ?? null,
      awsPlatform: legacyRecord.awsPlatform ?? null,
      awsPrivateIp: legacyRecord.awsPrivateIp ?? null,
      awsState: legacyRecord.awsState ?? null,
      awsSshUsername: legacyRecord.awsSshUsername ?? null,
      awsSshPort: legacyRecord.awsSshPort ?? null,
      awsSshMetadataStatus: normalizeAwsSshMetadataStatus(
        legacyRecord.awsSshMetadataStatus as AwsSshMetadataStatus | null | undefined,
        legacyRecord
      ),
      awsSshMetadataError: normalizeAwsSshMetadataError(legacyRecord.awsSshMetadataError as string | null | undefined),
      createdAt: legacyRecord.createdAt,
      updatedAt: legacyRecord.updatedAt
    };
  }

  if (
    typeof legacyRecord.awsProfileName === 'string' &&
    typeof legacyRecord.awsRegion === 'string' &&
    typeof (legacyRecord as Partial<AwsEcsHostRecord>).awsEcsClusterArn === 'string' &&
    typeof (legacyRecord as Partial<AwsEcsHostRecord>).awsEcsClusterName === 'string'
  ) {
    return {
      id: legacyRecord.id,
      kind: 'aws-ecs',
      label: legacyRecord.label,
      groupName: normalizeGroupPath(legacyRecord.groupName),
      tags: normalizeTags(legacyRecord.tags),
      terminalThemeId: normalizeTerminalThemeId(legacyRecord.terminalThemeId),
      awsProfileId: typeof legacyRecord.awsProfileId === 'string' ? legacyRecord.awsProfileId : null,
      awsProfileName: legacyRecord.awsProfileName,
      awsRegion: legacyRecord.awsRegion,
      awsEcsClusterArn: (legacyRecord as Partial<AwsEcsHostRecord>).awsEcsClusterArn ?? '',
      awsEcsClusterName: (legacyRecord as Partial<AwsEcsHostRecord>).awsEcsClusterName ?? '',
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
    privateKeyPath: null,
    certificatePath: null,
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
    awsProfileId: draft.awsProfileId ?? null,
    awsProfileName: draft.awsProfileName,
    awsRegion: draft.awsRegion,
    awsInstanceId: draft.awsInstanceId,
    awsAvailabilityZone: draft.awsAvailabilityZone ?? null,
    awsInstanceName: draft.awsInstanceName ?? null,
    awsPlatform: draft.awsPlatform ?? null,
    awsPrivateIp: draft.awsPrivateIp ?? null,
    awsState: draft.awsState ?? null,
    awsSshUsername: draft.awsSshUsername ?? null,
    awsSshPort: draft.awsSshPort ?? null,
    awsSshMetadataStatus: normalizeAwsSshMetadataStatus(draft.awsSshMetadataStatus, draft),
    awsSshMetadataError: normalizeAwsSshMetadataError(draft.awsSshMetadataError),
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function toAwsEcsHostRecord(
  id: string,
  draft: AwsEcsHostDraft,
  timestamp: string,
  current?: AwsEcsHostRecord,
): AwsEcsHostRecord {
  return {
    id,
    kind: 'aws-ecs',
    label: draft.label,
    awsProfileId: draft.awsProfileId ?? null,
    awsProfileName: draft.awsProfileName,
    awsRegion: draft.awsRegion,
    awsEcsClusterArn: draft.awsEcsClusterArn,
    awsEcsClusterName: draft.awsEcsClusterName,
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
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

function normalizeSerialDataBits(value: number): SerialDataBits {
  if (value === 5 || value === 6 || value === 7) {
    return value;
  }
  return 8;
}

function normalizeSerialParity(value?: string | null): SerialParity {
  if (
    value === 'odd' ||
    value === 'even' ||
    value === 'mark' ||
    value === 'space'
  ) {
    return value;
  }
  return 'none';
}

function normalizeSerialStopBits(value: number): SerialStopBits {
  if (value === 1.5 || value === 2) {
    return value;
  }
  return 1;
}

function normalizeSerialFlowControl(value?: string | null): SerialFlowControl {
  if (value === 'xon-xoff' || value === 'rts-cts' || value === 'dsr-dtr') {
    return value;
  }
  return 'none';
}

function normalizeSerialLineEnding(value?: string | null) {
  if (value === 'cr' || value === 'lf' || value === 'crlf') {
    return value;
  }
  return 'none';
}

function toSerialHostRecord(
  id: string,
  draft: SerialHostDraft,
  timestamp: string,
  current?: SerialHostRecord,
): SerialHostRecord {
  return {
    id,
    kind: 'serial',
    label: draft.label,
    transport: draft.transport,
    devicePath: draft.transport === 'local' ? draft.devicePath?.trim() || null : null,
    host: draft.transport === 'local' ? null : draft.host?.trim() || null,
    port: draft.transport === 'local' ? null : typeof draft.port === 'number' ? Math.round(draft.port) : null,
    baudRate: Math.max(1, Math.round(draft.baudRate)),
    dataBits: normalizeSerialDataBits(draft.dataBits),
    parity: normalizeSerialParity(draft.parity),
    stopBits: normalizeSerialStopBits(draft.stopBits),
    flowControl: normalizeSerialFlowControl(draft.flowControl),
    transmitLineEnding: normalizeSerialLineEnding(draft.transmitLineEnding),
    localEcho: Boolean(draft.localEcho),
    localLineEditing: Boolean(draft.localLineEditing),
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function toHostRecord(id: string, draft: HostDraft, secretRef: string | null, timestamp: string, current?: HostRecord): HostRecord {
  if (isSshHostDraft(draft)) {
    return toSshHostRecord(id, draft, secretRef, timestamp, current?.kind === 'ssh' ? current : undefined);
  }
  if (isAwsEc2HostDraft(draft)) {
    return toAwsHostRecord(id, draft, timestamp, current && current.kind === 'aws-ec2' ? current : undefined);
  }
  if (isAwsEcsHostDraft(draft)) {
    return toAwsEcsHostRecord(id, draft, timestamp, current && current.kind === 'aws-ecs' ? current : undefined);
  }
  if (isWarpgateSshHostDraft(draft)) {
    return toWarpgateHostRecord(id, draft, timestamp, current && current.kind === 'warpgate-ssh' ? current : undefined);
  }
  if (isSerialHostDraft(draft)) {
    return toSerialHostRecord(id, draft, timestamp, current && current.kind === 'serial' ? current : undefined);
  }
  throw new Error('Unsupported host draft type');
}

function withLinkedHostCount(record: SecretMetadataRecord, hosts: HostRecord[]): SecretMetadataRecord {
  return {
    ...record,
    linkedHostCount: hosts.filter((host) => isSshHostRecord(host) && host.secretRef === record.secretRef).length
  };
}

const DEFAULT_GLOBAL_TERMINAL_THEME_ID: GlobalTerminalThemeId = 'dolssh-dark';
const DEFAULT_TERMINAL_FONT_FAMILY: TerminalFontFamilyId =
  process.platform === 'win32' ? 'consolas' : process.platform === 'linux' ? 'jetbrains-mono' : 'sf-mono';
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const DEFAULT_TERMINAL_SCROLLBACK_LINES = 5000;
const DEFAULT_TERMINAL_LINE_HEIGHT = 1;
const DEFAULT_TERMINAL_LETTER_SPACING = 0;
const DEFAULT_TERMINAL_MINIMUM_CONTRAST_RATIO = 1;
const DEFAULT_TERMINAL_ALT_IS_META = false;
const DEFAULT_TERMINAL_WEBGL_ENABLED = true;

function isMacOnlyTerminalFontFamily(value: TerminalFontFamilyId): boolean {
  return value === 'sf-mono' || value === 'menlo' || value === 'monaco';
}

function normalizeTerminalFontFamilyForPlatform(value: TerminalFontFamilyId): TerminalFontFamilyId {
  if (process.platform !== 'darwin' && isMacOnlyTerminalFontFamily(value)) {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  return value;
}

const stateStorage = {
  getState: () => getDesktopStateStorage().getState(),
  updateState: (updater: Parameters<ReturnType<typeof getDesktopStateStorage>["updateState"]>[0]) =>
    getDesktopStateStorage().updateState(updater),
  readManagedAwsProfileValue: (profileId: string) =>
    getDesktopStateStorage().readManagedAwsProfileValue(profileId),
  writeManagedAwsProfileValue: (
    profileId: string,
    record: Parameters<ReturnType<typeof getDesktopStateStorage>["writeManagedAwsProfileValue"]>[1]
  ) => getDesktopStateStorage().writeManagedAwsProfileValue(profileId, record),
  deleteManagedAwsProfileValue: (profileId: string) =>
    getDesktopStateStorage().deleteManagedAwsProfileValue(profileId),
  appendActivityLog: (
    record: Parameters<ReturnType<typeof getDesktopStateStorage>["appendActivityLog"]>[0]
  ) => getDesktopStateStorage().appendActivityLog(record),
  upsertActivityLog: (
    record: Parameters<ReturnType<typeof getDesktopStateStorage>["upsertActivityLog"]>[0]
  ) => getDesktopStateStorage().upsertActivityLog(record),
  listActivityLogs: () => getDesktopStateStorage().listActivityLogs(),
  clearActivityLogs: () => getDesktopStateStorage().clearActivityLogs(),
};

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
          privateKeyPath: null,
          certificatePath: null,
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
          privateKeyPath: null,
          certificatePath: null,
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

  updateAwsProfileCache(profileId: string, nextProfileName: string): HostRecord[] {
    const updatedHosts: HostRecord[] = [];
    const timestamp = nowIso();
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (
          (entry.kind !== 'aws-ec2' && entry.kind !== 'aws-ecs') ||
          entry.awsProfileId !== profileId ||
          entry.awsProfileName === nextProfileName
        ) {
          return entry;
        }
        const nextRecord = {
          ...entry,
          awsProfileName: nextProfileName,
          updatedAt: timestamp
        };
        updatedHosts.push(nextRecord);
        return nextRecord;
      });
    });
    return updatedHosts;
  }

  backfillAwsProfileReferences(
    profiles: Array<{ id: string; name: string }>
  ): HostRecord[] {
    const byId = new Map(profiles.map((profile) => [profile.id, profile.name]));
    const byName = new Map(profiles.map((profile) => [profile.name, profile.id]));
    const updatedHosts: HostRecord[] = [];
    const timestamp = nowIso();

    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.kind !== 'aws-ec2' && entry.kind !== 'aws-ecs') {
          return entry;
        }

        let nextProfileId = entry.awsProfileId ?? null;
        let nextProfileName = entry.awsProfileName;

        if (!nextProfileId) {
          nextProfileId = byName.get(entry.awsProfileName) ?? null;
        }
        if (nextProfileId && byId.has(nextProfileId)) {
          nextProfileName = byId.get(nextProfileId) ?? entry.awsProfileName;
        }

        if (nextProfileId === (entry.awsProfileId ?? null) && nextProfileName === entry.awsProfileName) {
          return entry;
        }

        const nextRecord = {
          ...entry,
          awsProfileId: nextProfileId,
          awsProfileName: nextProfileName,
          updatedAt: timestamp
        };
        updatedHosts.push(nextRecord);
        return nextRecord;
      });
    });

    return updatedHosts;
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

  move(targetPath: string, targetParentPath: string | null): GroupPathMutationResult {
    const normalizedTargetPath = normalizeGroupPath(targetPath);
    if (!normalizedTargetPath) {
      throw new Error('Group path is invalid');
    }

    const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
    if (normalizedTargetParentPath && isGroupWithinPath(normalizedTargetParentPath, normalizedTargetPath)) {
      throw new Error('Group cannot be moved into itself or one of its descendants');
    }

    const nextPath = normalizeGroupPath(
      normalizedTargetParentPath
        ? `${normalizedTargetParentPath}/${getGroupLabel(normalizedTargetPath)}`
        : getGroupLabel(normalizedTargetPath)
    );
    if (!nextPath) {
      throw new Error('Group path is invalid');
    }
    if (nextPath === normalizedTargetPath) {
      throw new Error('Group path is unchanged');
    }

    return this.mutatePath(normalizedTargetPath, nextPath);
  }

  rename(targetPath: string, name: string): GroupPathMutationResult {
    const normalizedTargetPath = normalizeGroupPath(targetPath);
    if (!normalizedTargetPath) {
      throw new Error('Group path is invalid');
    }

    const cleanedName = name.trim();
    if (!cleanedName) {
      throw new Error('Group name is required');
    }

    const nextPath = normalizeGroupPath(
      getParentGroupPath(normalizedTargetPath)
        ? `${getParentGroupPath(normalizedTargetPath)}/${cleanedName}`
        : cleanedName
    );
    if (!nextPath) {
      throw new Error('Group path is invalid');
    }
    if (nextPath === normalizedTargetPath) {
      throw new Error('Group path is unchanged');
    }

    return this.mutatePath(normalizedTargetPath, nextPath);
  }

  private mutatePath(targetPath: string, nextPath: string): GroupPathMutationResult {
    const nextState = stateStorage.updateState((state) => {
      const timestamp = nowIso();
      const affectedGroups = state.data.groups.filter((record) => isGroupWithinPath(record.path, targetPath));
      const affectedHosts = state.data.hosts.filter((record) => isGroupWithinPath(normalizeGroupPath(record.groupName), targetPath));

      if (affectedGroups.length === 0 && affectedHosts.length === 0) {
        throw new Error('Group not found');
      }

      const nextGroupsByPath = new Map<string, GroupRecord>();
      for (const record of state.data.groups) {
        if (!isGroupWithinPath(record.path, targetPath)) {
          nextGroupsByPath.set(record.path, record);
        }
      }
      if (nextGroupsByPath.has(nextPath)) {
        throw new Error('Group already exists');
      }

      for (const record of affectedGroups) {
        const rebasedPath = rebaseGroupPath(record.path, targetPath, nextPath);
        if (!rebasedPath) {
          throw new Error('Group path is invalid');
        }
        if (nextGroupsByPath.has(rebasedPath)) {
          throw new Error('Group already exists');
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
        if (!isGroupWithinPath(hostGroupPath, targetPath)) {
          return record;
        }
        return normalizeIncomingHostRecord({
          ...record,
          groupName: rebaseGroupPath(hostGroupPath, targetPath, nextPath),
          updatedAt: timestamp
        });
      });
    });

    return {
      groups: nextState.data.groups.sort((left, right) => left.path.localeCompare(right.path)),
      hosts: nextState.data.hosts.sort(compareHosts),
      nextPath
    };
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
      sftpBrowserColumnWidths: { ...state.settings.sftpBrowserColumnWidths },
      sessionReplayRetentionCount:
        state.settings.sessionReplayRetentionCount ??
        DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
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
      const hasSftpBrowserColumnWidthsInput = Object.prototype.hasOwnProperty.call(input, 'sftpBrowserColumnWidths');

      if (input.theme === 'light' || input.theme === 'dark' || input.theme === 'system') {
        state.settings.theme = input.theme;
        state.settings.updatedAt = nowIso();
      }

      if (hasSftpBrowserColumnWidthsInput) {
        state.settings.sftpBrowserColumnWidths = normalizeSftpBrowserColumnWidths(
          input.sftpBrowserColumnWidths as Partial<Record<keyof SftpBrowserColumnWidths, unknown>> | null | undefined
        );
        state.settings.updatedAt = nowIso();
      }

      if (
        typeof input.sessionReplayRetentionCount === 'number' &&
        Number.isFinite(input.sessionReplayRetentionCount)
      ) {
        state.settings.sessionReplayRetentionCount = clampSessionReplayRetentionCount(
          input.sessionReplayRetentionCount,
        );
        state.settings.updatedAt = nowIso();
      }

      if (input.globalTerminalThemeId) {
        state.terminal.globalThemeId = input.globalTerminalThemeId;
        state.terminal.globalThemeUpdatedAt = nowIso();
      }

      if (input.terminalFontFamily) {
        state.terminal.fontFamily = normalizeTerminalFontFamilyForPlatform(input.terminalFontFamily);
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
        !hasSftpBrowserColumnWidthsInput &&
        input.sessionReplayRetentionCount == null &&
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
        state.settings.sftpBrowserColumnWidths = { ...current.sftpBrowserColumnWidths };
        state.settings.sessionReplayRetentionCount =
          current.sessionReplayRetentionCount ??
          DEFAULT_SESSION_REPLAY_RETENTION_COUNT;
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
    const record = this.toRecord(randomUUID(), draft, timestamp, timestamp);
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

    const record = this.toRecord(id, draft, current.createdAt, nowIso());

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

  private toRecord(id: string, draft: PortForwardDraft, createdAt: string, updatedAt: string): PortForwardRuleRecord {
    const label = draft.label.trim();
    if (draft.transport === 'container') {
      return {
        id,
        label,
        hostId: draft.hostId,
        transport: 'container',
        bindAddress: '127.0.0.1',
        bindPort: Math.max(0, draft.bindPort),
        containerId: draft.containerId.trim(),
        containerName: draft.containerName.trim(),
        containerRuntime: draft.containerRuntime,
        networkName: draft.networkName.trim(),
        targetPort: draft.targetPort,
        createdAt,
        updatedAt
      };
    }
    if (draft.transport === 'ecs-task') {
      return {
        id,
        label,
        hostId: draft.hostId,
        transport: 'ecs-task',
        bindAddress: '127.0.0.1',
        bindPort: draft.bindPort,
        serviceName: draft.serviceName.trim(),
        containerName: draft.containerName.trim(),
        targetPort: draft.targetPort,
        createdAt,
        updatedAt
      };
    }
    if (draft.transport === 'aws-ssm') {
      return {
        id,
        label,
        hostId: draft.hostId,
        transport: 'aws-ssm',
        bindAddress: draft.bindAddress.trim() || '127.0.0.1',
        bindPort: draft.bindPort,
        targetKind: draft.targetKind,
        targetPort: draft.targetPort,
        remoteHost: draft.targetKind === 'remote-host' ? draft.remoteHost?.trim() ?? null : null,
        createdAt,
        updatedAt
      };
    }

    return {
      id,
      label,
      hostId: draft.hostId,
      transport: 'ssh',
      mode: draft.mode,
      bindAddress: draft.bindAddress.trim(),
      bindPort: draft.bindPort,
      targetHost: draft.mode === 'dynamic' ? null : draft.targetHost?.trim() ?? null,
      targetPort: draft.mode === 'dynamic' ? null : draft.targetPort ?? null,
      createdAt,
      updatedAt
    };
  }
}

export class DnsOverrideRepository {
  list(): DnsOverrideRecord[] {
    return stateStorage.getState().data.dnsOverrides.sort(compareDnsOverrides);
  }

  getById(id: string): DnsOverrideRecord | null {
    return stateStorage.getState().data.dnsOverrides.find((record) => record.id === id) ?? null;
  }

  create(draft: DnsOverrideDraft, portForwards: PortForwardRepository): DnsOverrideRecord {
    const timestamp = nowIso();
    const record = this.toRecord(randomUUID(), draft, timestamp, timestamp, portForwards);
    stateStorage.updateState((state) => {
      state.data.dnsOverrides.push(record);
    });
    return record;
  }

  update(id: string, draft: DnsOverrideDraft, portForwards: PortForwardRepository): DnsOverrideRecord {
    const current = this.getById(id);
    if (!current) {
      throw new Error('DNS override not found');
    }

    const record = this.toRecord(id, draft, current.createdAt, nowIso(), portForwards);
    stateStorage.updateState((state) => {
      state.data.dnsOverrides = state.data.dnsOverrides.map((entry) => (entry.id === id ? record : entry));
    });
    return record;
  }

  remove(id: string): void {
    stateStorage.updateState((state) => {
      state.data.dnsOverrides = state.data.dnsOverrides.filter((entry) => entry.id !== id);
    });
  }

  replaceAll(records: DnsOverrideRecord[]): void {
    stateStorage.updateState((state) => {
      state.data.dnsOverrides = records
        .map(normalizeIncomingDnsOverrideRecord)
        .filter((record): record is DnsOverrideRecord => record !== null)
        .sort(compareDnsOverrides);
    });
  }

  private toRecord(
    id: string,
    draft: DnsOverrideDraft,
    createdAt: string,
    updatedAt: string,
    portForwards: PortForwardRepository
  ): DnsOverrideRecord {
    const hostname = normalizeDnsOverrideHostname(draft.hostname);
    if (!isValidDnsOverrideHostname(hostname)) {
      throw new Error('DNS override hostname is invalid');
    }

    const duplicate = stateStorage
      .getState()
      .data.dnsOverrides.find((record) => record.hostname === hostname && record.id !== id);
    if (duplicate) {
      throw new Error('DNS override hostname already exists');
    }

    if (isLinkedDnsOverrideDraft(draft)) {
      const rule = portForwards.getById(draft.portForwardRuleId);
      if (!rule) {
        throw new Error('Linked port forward rule not found');
      }
      if (!isDnsOverrideEligiblePortForwardRule(rule)) {
        throw new Error('Linked port forward rule must be a local listener with a loopback bind address');
      }

      return {
        id,
        type: 'linked',
        hostname,
        portForwardRuleId: rule.id,
        createdAt,
        updatedAt,
      };
    }

    if (!isStaticDnsOverrideDraft(draft)) {
      throw new Error('DNS override type is invalid');
    }

    const address = normalizeDnsOverrideAddress(draft.address);
    if (!address || isIP(address) === 0) {
      throw new Error('DNS override address must be a valid IPv4 or IPv6 address');
    }

    return {
      id,
      type: 'static',
      hostname,
      address,
      createdAt,
      updatedAt,
    };
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
    const timestamp = nowIso();
    const record: ActivityLogRecord = {
      id: randomUUID(),
      level,
      category,
      kind: 'generic',
      message,
      metadata: metadata ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return stateStorage.appendActivityLog(record);
  }

  upsert(record: ActivityLogRecord): ActivityLogRecord {
    return stateStorage.upsertActivityLog(record);
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
    hasCertificate?: boolean;
  }): void {
    stateStorage.updateState((state) => {
      const timestamp = nowIso();
      const nextRecord: SecretMetadataRecord = {
        secretRef: input.secretRef,
        label: input.label,
        hasPassword: input.hasPassword,
        hasPassphrase: input.hasPassphrase,
        hasManagedPrivateKey: input.hasManagedPrivateKey ?? false,
        hasCertificate: input.hasCertificate ?? false,
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

  replaceAll(records: SecretMetadataRecord[]): void {
    stateStorage.updateState((state) => {
      const nextRecords = records.map((record) => ({
        ...record,
        linkedHostCount: 0
      }));
      state.data.secretMetadata = nextRecords;
    });
  }
}

export class AwsProfileRepository {
  listMetadata(): AwsProfileMetadataRecord[] {
    return stateStorage.getState().data.awsProfiles.sort(compareAwsProfileMetadata);
  }

  listPayloads(): ManagedAwsProfilePayload[] {
    return this.listMetadata()
      .map((metadata) => this.getPayloadById(metadata.id))
      .filter((payload): payload is ManagedAwsProfilePayload => payload !== null)
      .sort((left, right) => compareAwsProfileMetadata(this.toMetadata(left), this.toMetadata(right)));
  }

  getMetadataById(id: string): AwsProfileMetadataRecord | null {
    return stateStorage.getState().data.awsProfiles.find((record) => record.id === id) ?? null;
  }

  getMetadataByName(name: string): AwsProfileMetadataRecord | null {
    return stateStorage.getState().data.awsProfiles.find((record) => record.name === name) ?? null;
  }

  getPayloadById(id: string): ManagedAwsProfilePayload | null {
    const metadata = this.getMetadataById(id);
    if (!metadata) {
      return null;
    }
    const record = stateStorage.readManagedAwsProfileValue(id);
    if (!record) {
      return null;
    }
    const raw = decodeSecretFromStorage(record);
    if (!raw) {
      return null;
    }

    try {
      const payload = JSON.parse(raw) as ManagedAwsProfilePayload;
      return {
        ...payload,
        id: metadata.id,
        name: metadata.name,
        kind: metadata.kind,
        updatedAt: payload.updatedAt ?? metadata.updatedAt
      } as ManagedAwsProfilePayload;
    } catch {
      return null;
    }
  }

  resolveNameById(id: string | null | undefined): string | null {
    if (!id) {
      return null;
    }
    return this.getMetadataById(id)?.name ?? null;
  }

  upsert(payload: ManagedAwsProfilePayload): ManagedAwsProfilePayload {
    const nextPayload: ManagedAwsProfilePayload = {
      ...payload,
      name: payload.name.trim(),
      updatedAt: payload.updatedAt || nowIso(),
    };
    const nextMetadata = this.toMetadata(nextPayload);

    stateStorage.updateState((state) => {
      const currentIndex = state.data.awsProfiles.findIndex((record) => record.id === nextMetadata.id);
      if (currentIndex >= 0) {
        state.data.awsProfiles[currentIndex] = nextMetadata;
      } else {
        state.data.awsProfiles.push(nextMetadata);
      }
    });
    stateStorage.writeManagedAwsProfileValue(
      nextPayload.id,
      encodeSecretForStorage(JSON.stringify(nextPayload))
    );
    return nextPayload;
  }

  remove(id: string): void {
    stateStorage.updateState((state) => {
      state.data.awsProfiles = state.data.awsProfiles.filter((record) => record.id !== id);
    });
    stateStorage.deleteManagedAwsProfileValue(id);
  }

  replaceAll(payloads: ManagedAwsProfilePayload[]): void {
    const nextPayloads = payloads.map((payload) => ({
      ...payload,
      name: payload.name.trim(),
    }));
    const nextMetadata = nextPayloads.map((payload) => this.toMetadata(payload));
    const nextIds = new Set(nextMetadata.map((record) => record.id));

    stateStorage.updateState((state) => {
      state.data.awsProfiles = nextMetadata;
      for (const profileId of Object.keys(state.secure.managedAwsProfilesById)) {
        if (!nextIds.has(profileId)) {
          delete state.secure.managedAwsProfilesById[profileId];
        }
      }
      for (const payload of nextPayloads) {
        state.secure.managedAwsProfilesById[payload.id] = encodeSecretForStorage(JSON.stringify(payload));
      }
    });
  }

  private toMetadata(payload: ManagedAwsProfilePayload): AwsProfileMetadataRecord {
    return {
      id: payload.id,
      name: payload.name.trim(),
      kind: payload.kind as ManagedAwsProfileKind,
      updatedAt: payload.updatedAt
    };
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

  clearMany(records: Array<{ kind: SyncKind; recordId: string; deletedAt?: string }>): void {
    const exactKeys = new Set(
      records
        .filter((record) => typeof record.deletedAt === 'string')
        .map((record) => `${record.kind}:${record.recordId}:${record.deletedAt}`)
    );
    const fallbackKeys = new Set(
      records
        .filter((record) => typeof record.deletedAt !== 'string')
        .map((record) => `${record.kind}:${record.recordId}`)
    );
    stateStorage.updateState((state) => {
      state.data.syncOutbox = state.data.syncOutbox.filter((entry) => {
        if (exactKeys.has(`${entry.kind}:${entry.recordId}:${entry.deletedAt}`)) {
          return false;
        }
        if (fallbackKeys.has(`${entry.kind}:${entry.recordId}`)) {
          return false;
        }
        return true;
      });
    });
  }

  clearAll(): void {
    stateStorage.updateState((state) => {
      state.data.syncOutbox = [];
    });
  }
}
