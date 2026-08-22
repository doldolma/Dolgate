import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_AUTO_RECONNECT_SETTINGS,
  DEFAULT_COMMAND_NOTIFICATION_SETTINGS,
  DEFAULT_HOST_METRICS_SETTINGS,
  DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
  MAX_HOST_STARTUP_COMMAND_LENGTH,
  MAX_SESSION_REPLAY_RETENTION_COUNT,
  MIN_SESSION_REPLAY_RETENTION_COUNT,
  clampAiTemperature,
  clampAutoReconnectDelayMs,
  clampAutoReconnectMaxAttempts,
  clampCommandNotificationThresholdSeconds,
  createGroupIn,
  getGroupLabel,
  getParentGroupPath,
  isAwsEc2HostDraft,
  isAwsEcsHostDraft,
  isDnsOverrideEligiblePortForwardRule,
  isGroupWithinPath,
  isLinkedDnsOverrideDraft,
  isLinkedDnsOverrideRecord,
  isRdpHostDraft,
  isRdpHostRecord,
  isSerialHostDraft,
  isSerialHostRecord,
  isSshHostDraft,
  isSshHostRecord,
  isStaticDnsOverrideDraft,
  isVncHostDraft,
  isVncHostRecord,
  isWarpgateSshHostDraft,
  moveGroupIn,
  normalizeAiBaseUrl,
  normalizeAiTokenLimit,
  normalizeGroupPath,
  normalizeHostEnvVars,
  normalizeJumpHostIds,
  normalizeServerUrl,
  normalizeSftpBrowserColumnWidths,
  rebaseGroupPath,
  removeGroupFrom,
  renameGroupIn,
  stripRemovedGroupSegment,
  type RdpAwsSsmTarget,
  type RdpDriveShare,
  type RdpHostDraft,
  type RdpHostRecord,
  type RdpMonitorSelection,
  type VncHostDraft,
  type VncHostRecord,
  type VncImageQuality
} from '@shared';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  AiSettings,
  AppSettings,
  AppTheme,
  AuthType,
  AwsEc2HostDraft,
  AwsEc2HostRecord,
  AwsEcsHostDraft,
  AwsEcsHostRecord,
  AwsProfileMetadataRecord,
  AwsSshMetadataStatus,
  DnsOverrideDraft,
  DnsOverrideRecord,
  GlobalTerminalThemeId,
  GroupPathMutationResult,
  GroupRecord,
  GroupRemoveMode,
  GroupRemoveResult,
  HomeHostViewMode,
  HostDraft,
  HostRecord,
  HostStartupCommand,
  KnownHostRecord,
  KnownHostTrustInput,
  ManagedAwsProfileKind,
  ManagedAwsProfilePayload,
  PortForwardDraft,
  PortForwardRuleRecord,
  SecretMetadataRecord,
  SerialDataBits,
  SerialFlowControl,
  SerialHostDraft,
  SerialHostRecord,
  SerialParity,
  SerialStopBits,
  SftpBrowserColumnWidths,
  SnippetDraft,
  SnippetRecord,
  SshHostDraft,
  SshHostRecord,
  SyncKind,
  TailnetPayload,
  TailnetRecord,
  TerminalFontFamilyId,
  TerminalPreferencesRecord,
  TerminalThemeId,
  WarpgateSshHostDraft,
  WarpgateSshHostRecord,
} from "@shared";
import { normalizeAppLanguage } from '../common/i18n/locale';
import type { ActivityLogMessage } from './activity-log-message';
import { DesktopConfigService } from './app-config';
import {
  getDesktopStateStorage,
  type StoredEncryptedValue,
  type SyncDeletionRecord,
} from './state-storage';
import type { LocalHistoryOwner } from './local-history-scope';
import { decodeSecretFromStorage, encodeSecretForStorage } from './secret-store';
import { getServerUrlValidationMessage } from '../common/shared-messages';

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

export function normalizeTailnetPayloadForStorage(
  payload: TailnetPayload,
): TailnetRecord {
  const { authKey, ...record } = payload;
  return {
    ...record,
    hasAuthKey: Boolean(authKey),
    // Auth keys are commonly one-time keys. Persisting ephemeral=true makes the
    // control plane remove the node on exit and leaves the key unusable next run.
    ephemeral: false,
  };
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

function normalizeHostStartupCommand(
  value: HostStartupCommand | null | undefined,
): HostStartupCommand | null {
  if (value?.type === 'command') {
    return value.command.trim() && value.command.length <= MAX_HOST_STARTUP_COMMAND_LENGTH
      ? { type: 'command', command: value.command }
      : null;
  }
  if (value?.type === 'snippet') {
    const snippetId = value.snippetId.trim();
    return snippetId ? { type: 'snippet', snippetId } : null;
  }
  return null;
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

function normalizeHomeHostViewMode(value: unknown): HomeHostViewMode {
  return value === 'list' ? 'list' : 'grid';
}

function normalizeIncomingHostRecord(record: HostRecord): HostRecord {
  if (record.kind === 'aws-ec2') {
    return {
      ...record,
      favorite: record.favorite === true ? true : null,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId),
      startupCommand: normalizeHostStartupCommand(record.startupCommand),
      awsSshUsername: record.awsSshUsername ?? null,
      awsSshPort: record.awsSshPort ?? null,
      awsSshMetadataStatus: normalizeAwsSshMetadataStatus(record.awsSshMetadataStatus, record),
      awsSshMetadataError: normalizeAwsSshMetadataError(record.awsSshMetadataError),
      agentForwarding: record.agentForwarding === true ? true : null
    };
  }

  if (record.kind === 'aws-ecs') {
    return {
      ...record,
      favorite: record.favorite === true ? true : null,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId),
    };
  }

  if (record.kind === 'ssh') {
    return {
      ...record,
      favorite: record.favorite === true ? true : null,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId),
      startupCommand: normalizeHostStartupCommand(record.startupCommand),
      agentForwarding: record.agentForwarding === true ? true : null,
      env: normalizeHostEnvVars(record.env)
    };
  }
  if (record.kind === 'warpgate-ssh') {
    return {
      ...record,
      favorite: record.favorite === true ? true : null,
      groupName: normalizeGroupPath(record.groupName),
      tags: normalizeTags(record.tags),
      terminalThemeId: normalizeTerminalThemeId(record.terminalThemeId),
      startupCommand: normalizeHostStartupCommand(record.startupCommand)
    };
  }
  if (record.kind === 'serial') {
    return {
      ...record,
      favorite: record.favorite === true ? true : null,
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
  const jumpHostIds = normalizeJumpHostIds(draft.jumpHostIds, draft.jumpHostId);
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
    jumpHostId: jumpHostIds[0] ?? null,
    jumpHostIds: jumpHostIds.length > 0 ? jumpHostIds : null,
    // 이 변환도 필드를 나열하는 화이트리스트다. 빠뜨리면 폼에서 고른 tailnet 이 저장 시점에
    // 사라진다 — 화면에는 선택돼 보이는데 레코드에는 없다.
    tailnetId: draft.tailnetId?.trim() || null,
    useMosh: draft.useMosh ?? null,
    agentForwarding: draft.agentForwarding === true ? true : null,
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    startupCommand: normalizeHostStartupCommand(draft.startupCommand),
    // env는 시크릿이 아니라 호스트 속성 — 드래프트 값을 그대로 정규화해 저장(공유 시크릿으로 번지지 않음).
    env: draft.env !== undefined ? normalizeHostEnvVars(draft.env) : (current?.env ?? null),
    favorite: current?.favorite ?? null,
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
    awsSsmServerProxyEnabled:
      draft.awsSsmServerProxyEnabled ??
      (current?.awsSsmServerProxyEnabled === true),
    agentForwarding: draft.agentForwarding === true ? true : null,
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    startupCommand: normalizeHostStartupCommand(draft.startupCommand),
    favorite: current?.favorite ?? null,
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
    favorite: current?.favorite ?? null,
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
    startupCommand: normalizeHostStartupCommand(draft.startupCommand),
    favorite: current?.favorite ?? null,
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
    favorite: current?.favorite ?? null,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function toRdpHostRecord(
  id: string,
  draft: RdpHostDraft,
  secretRef: string | null,
  timestamp: string,
  current?: RdpHostRecord,
): RdpHostRecord {
  return {
    id,
    kind: 'rdp',
    label: draft.label.trim() || draft.hostname.trim(),
    hostname: draft.hostname.trim(),
    port: Number.isFinite(draft.port) ? Math.round(draft.port) : 3389,
    // SSH 와 같은 규칙: 호출자가 넘긴 ref 가 우선이고, 없으면 draft 가 들고 있던 것을 유지한다.
    secretRef: secretRef ?? draft.secretRef ?? null,
    // 핀은 폼이 아니라 신뢰 흐름이 정한다. draft 에 없으므로 기존 레코드에서 이어받지 않으면
    // 호스트를 수정할 때마다 신뢰가 초기화된다.
    certificateFingerprint: current?.certificateFingerprint ?? null,
    drives: normalizeRdpDrives(draft.drives),
    // 옛 필드는 더 쓰지 않는다. 새로 쓰지도 않아서 편집하면 자연히 비워진다.
    drivePath: null,
    driveReadOnly: null,
    adminSession: draft.adminSession === true ? true : null,
    useAllMonitors: draft.useAllMonitors === true ? true : null,
    // 없거나 null 이 "켜짐"이다. 옛 호스트가 조용히 조용해지지 않게 false 만 저장한다.
    audioEnabled: draft.audioEnabled === false ? false : null,
    // 기본이 꺼짐이라 **켠 경우만** 참으로 남긴다(audioEnabled 와 방향이 반대다).
    microphoneEnabled: draft.microphoneEnabled === true ? true : null,
    cameraEnabled: draft.cameraEnabled === true ? true : null,
    clipboardEnabled: draft.clipboardEnabled === false ? false : null,
    // 32 는 기본값이라 저장하지 않는다 — 접속 경로가 null 을 32 로 읽는다.
    colorDepth: draft.colorDepth === 16 ? 16 : null,
    tailnetId: draft.tailnetId?.trim() || null,
    // SSM 경유. draft 에 없으면 기존 값을 이어받는다 — 호스트 편집 폼은 이 필드를 다루지 않으므로
    // (AWS 가져오기가 정한다) 여기서 draft 만 보면 편집 한 번에 경로가 지워진다.
    awsSsm:
      draft.awsSsm === undefined
        ? (current?.awsSsm ?? null)
        : normalizeRdpAwsSsm(draft.awsSsm),
    // 인증서 핀과 같은 이유로 draft 에 없으면 기존 값을 이어받는다. 모니터 선택은 배치도에서만
    // 정해지므로, 호스트 폼처럼 이 필드를 모르는 경로가 draft 를 만들면 선택이 지워진다.
    monitors:
      draft.monitors === undefined
        ? (current?.monitors ?? null)
        : normalizeRdpMonitors(draft.monitors),
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    favorite: current?.favorite ?? null,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

/**
 * VNC 드래프트를 레코드로.
 *
 * **이 변환도 필드를 나열하는 화이트리스트다.** 읽는 쪽(state-storage 의 normalizeHostRecord)과
 * 짝이 맞아야 한다 — 한쪽에서 빠뜨리면 "저장은 되는데 앱을 다시 켜면 초기값" 이 된다.
 *
 * 계정은 없다. RFB 의 VncAuth 는 비밀번호만 쓰고, VeNCrypt 의 Plain 계열은 계정을 자격증명에
 * 둔다(SSH·RDP 와 같은 저장소).
 */
function toVncHostRecord(
  id: string,
  draft: VncHostDraft,
  secretRef: string | null,
  timestamp: string,
  current?: VncHostRecord,
): VncHostRecord {
  return {
    id,
    kind: 'vnc',
    label: draft.label.trim() || draft.hostname.trim(),
    hostname: draft.hostname.trim(),
    port: Number.isFinite(draft.port) ? Math.round(draft.port) : 5900,
    // SSH·RDP 와 같은 규칙: 호출자가 넘긴 ref 가 우선이고, 없으면 draft 가 들고 있던 것을 유지한다.
    secretRef: secretRef ?? draft.secretRef ?? null,
    // 기본값이 "켜짐" 인 것은 false 만 저장한다 — null 과 true 를 구분할 필요가 없고, 그래야 기본값을
    // 나중에 바꿀 여지가 남는다(RDP 의 audioEnabled 와 같은 규칙).
    shared: draft.shared === false ? false : null,
    viewOnly: draft.viewOnly === true ? true : null,
    tailnetId: draft.tailnetId?.trim() || null,
    sshTunnelHostId: draft.sshTunnelHostId?.trim() || null,
    // 무손실이 기본이다 — 그 값은 저장하지 않는다(위 shared·viewOnly 와 같은 규칙).
    imageQuality: normalizeVncImageQuality(draft.imageQuality),
    groupName: normalizeGroupPath(draft.groupName),
    tags: normalizeTags(draft.tags),
    terminalThemeId: normalizeTerminalThemeId(draft.terminalThemeId),
    favorite: current?.favorite ?? null,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

/**
 * 화질 값을 정규화한다. 모르는 값과 무손실은 null 로 떨어진다.
 *
 * 기본값을 저장하지 않는 이유는 다른 토글과 같다 — 나중에 기본을 바꿀 여지를 남긴다.
 */
function normalizeVncImageQuality(
  value: VncImageQuality | null | undefined,
): VncImageQuality | null {
  return value === 'balanced' || value === 'fast' ? value : null;
}

// RDP 화면 크기는 200~8192 이고 폭은 홀수를 허용하지 않는다([MS-RDPEDISP] 2.2.2.2.1).
// 규격을 벗어난 값은 연결 시점에 거부되므로 저장 전에 맞춰 둔다.
/**
 * SSM 경유 정보를 정리한다.
 *
 * 세 값이 다 있어야 포워드를 열 수 있다. 하나라도 비면 없는 것으로 본다 — 반쯤 채워진 값을 저장하면
 * "SSM 으로 붙는 호스트" 처럼 보이면서 매번 실패한다.
 */
function normalizeRdpAwsSsm(
  target: RdpAwsSsmTarget | null | undefined
): RdpAwsSsmTarget | null {
  const profileName = target?.profileName?.trim() ?? '';
  const region = target?.region?.trim() ?? '';
  const instanceId = target?.instanceId?.trim() ?? '';
  if (!profileName || !region || !instanceId) {
    return null;
  }
  // **필드를 나열하는 화이트리스트다.** profileId 를 빠뜨리면 임포트가 넣어 준 값이 저장되는
  // 순간 사라지고, 접속 시 프로파일을 이름으로만 찾게 된다(이름은 바뀔 수 있다).
  const profileId = target?.profileId?.trim() ?? '';
  return { profileId: profileId || null, profileName, region, instanceId };
}

/**
 * 공유 폴더 목록을 정리한다.
 *
 * 경로가 빈 항목은 버리고, 빈 목록은 null 로 눕힌다 — "공유 없음"이 두 모양으로 저장되면
 * 접속 경로에서 판단이 갈린다.
 */
function normalizeRdpDrives(
  drives: RdpDriveShare[] | null | undefined
): RdpDriveShare[] | null {
  if (!Array.isArray(drives)) {
    return null;
  }
  const cleaned = drives.flatMap((drive) => {
    const path = drive?.path?.trim();
    return path ? [{ path, readOnly: drive.readOnly === true ? true : null }] : [];
  });
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 호스트에 저장할 모니터 선택을 정리한다.
 *
 * 빈 배열은 null 로 눕힌다 — "선택 없음"이 두 모양으로 저장되면 접속 경로에서 판단이 갈린다.
 */
function normalizeRdpMonitors(
  value: RdpMonitorSelection[] | null | undefined,
): RdpMonitorSelection[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  return value.map((monitor) => ({
    id: Math.round(monitor.id),
    label: String(monitor.label ?? ''),
    width: Math.round(monitor.width),
    height: Math.round(monitor.height)
  }));
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
  if (isRdpHostDraft(draft)) {
    return toRdpHostRecord(id, draft, secretRef, timestamp, current && current.kind === 'rdp' ? current : undefined);
  }
  if (isVncHostDraft(draft)) {
    return toVncHostRecord(id, draft, secretRef, timestamp, current && current.kind === 'vnc' ? current : undefined);
  }
  throw new Error('Unsupported host draft type');
}

function withLinkedHostCount(record: SecretMetadataRecord, hosts: HostRecord[]): SecretMetadataRecord {
  // SSH·RDP·VNC 가 같은 자격증명 저장소를 쓴다. 하나라도 빼먹으면 그 자격증명이 "연결된 호스트
  // 0개"로 보여서, 지워도 아무 경고가 없고 지운 뒤 그 호스트가 조용히 못 붙는다.
  const linked = hosts.filter((host) => {
    if (isSshHostRecord(host) || isRdpHostRecord(host) || isVncHostRecord(host)) {
      return host.secretRef === record.secretRef;
    }
    return false;
  });
  return {
    ...record,
    linkedHostCount: linked.length,
    // **종류를 잃은 항목을 연결된 호스트로 되짚는다.**
    //
    // 옛 빌드의 동기화 투영이 metadata 에서 kind 를 떨어뜨린 적이 있다(실측: 86개 전부 유실).
    // 그러면 RDP·VNC 폼의 자격증명 목록이 그 항목을 걸러내 비어 보인다. 암호화된 페이로드에는
    // 종류가 남아 있지만 목록을 그리려고 전부 복호화할 수는 없다 — 대신 그 자격증명을 가리키는
    // 호스트의 종류가 같은 사실을 알려 준다(평문이고 이미 여기 있다).
    kind: record.kind ?? inferSecretKindFromHosts(linked)
  };
}

/**
 * 이 자격증명을 쓰는 호스트들의 종류가 하나로 모이면 그것이 자격증명의 종류다.
 *
 * 섞여 있거나(같은 비밀번호를 SSH·RDP 에 함께 쓰는 경우) 아무 호스트도 없으면 판단하지 않는다 —
 * 틀린 종류를 씌우면 그 항목이 엉뚱한 폼의 목록에 나타난다.
 */
function inferSecretKindFromHosts(hosts: HostRecord[]): 'ssh' | 'rdp' | 'vnc' | null {
  if (hosts.length === 0) {
    return null;
  }
  const kinds = new Set(
    hosts.map((host) => (isRdpHostRecord(host) ? 'rdp' : isVncHostRecord(host) ? 'vnc' : 'ssh'))
  );
  if (kinds.size !== 1) {
    return null;
  }
  return [...kinds][0] as 'ssh' | 'rdp' | 'vnc';
}

const DEFAULT_GLOBAL_TERMINAL_THEME_ID: GlobalTerminalThemeId = 'system';
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
  reconcileReplayFlags: (existingRecordingIds: ReadonlySet<string>) =>
    getDesktopStateStorage().reconcileReplayFlags(existingRecordingIds),
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

  setFavorite(id: string, favorite: boolean): HostRecord | null {
    let nextRecord: HostRecord | null = null;
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.id !== id) {
          return entry;
        }
        nextRecord = { ...entry, favorite: favorite ? true : null, updatedAt: nowIso() };
        return nextRecord;
      });
    });
    return nextRecord;
  }

  // 사용자가 신뢰한 RDP 서버 인증서 지문을 기록한다. 호스트 폼을 거치지 않는 값이라
  // update() 로 통째로 저장하면 draft 에 없는 이 필드가 날아간다.
  //
  // `null` 은 신뢰 해제다(설정 › Security 의 목록에서 지울 때). 기록과 해제를 한 메서드로 두는
  // 이유는 둘이 갈리면 한쪽만 updatedAt·동기화를 놓치기 때문이다 — 핀이 로컬에만 남으면 다음
  // pull 이 호스트 목록을 서버 사본으로 교체하면서 되살린다.
  updateRdpCertificateFingerprint(id: string, fingerprint: string | null): HostRecord | null {
    let nextRecord: HostRecord | null = null;
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.id !== id || entry.kind !== 'rdp') {
          return entry;
        }
        nextRecord = { ...entry, certificateFingerprint: fingerprint, updatedAt: nowIso() };
        return nextRecord;
      });
    });
    return nextRecord;
  }

  /**
   * RDP 호스트의 SSM 프로파일 id 를 채운다.
   *
   * 이 필드가 생기기 전에 만든 레코드는 프로파일을 이름으로만 갖는다. 접속할 때 이름으로 한 번
   * 찾아내면 그 id 를 적어 두어, 다음부터는 이름에 의존하지 않는다 — 이름은 설정에서 바뀔 수 있고
   * 그러면 이름으로만 찾던 경로가 조용히 끊긴다. 인증서 지문을 접속 중에 저장하는 것과 같은 방식
   * 이다(updateRdpCertificateFingerprint).
   *
   * `updatedAt` 을 올리지 않는다. 사용자가 고친 것이 아니라 우리가 같은 뜻을 더 안전한 형태로 적는
   * 것이고, 시각을 올리면 마지막-쓰기-승리에서 다른 기기의 실제 편집을 이길 수 있다.
   */
  fillRdpAwsSsmProfileId(id: string, profileId: string): HostRecord | null {
    let nextRecord: HostRecord | null = null;
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.id !== id || entry.kind !== 'rdp' || !entry.awsSsm) {
          return entry;
        }
        if (entry.awsSsm.profileId) {
          return entry;
        }
        nextRecord = {
          ...entry,
          awsSsm: { ...entry.awsSsm, profileId },
        };
        return nextRecord;
      });
    });
    return nextRecord;
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

  updateSshAuthSecret(
    id: string,
    authType: Extract<AuthType, 'privateKey' | 'certificate'>,
    secretRef: string | null
  ): HostRecord | null {
    let nextRecord: HostRecord | null = null;
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.id !== id || !isSshHostRecord(entry)) {
          return entry;
        }
        nextRecord = {
          ...entry,
          authType,
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

  clearStartupSnippetRef(snippetId: string): HostRecord[] {
    const updated: HostRecord[] = [];
    const timestamp = nowIso();
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (
          (entry.kind !== 'ssh' && entry.kind !== 'aws-ec2' && entry.kind !== 'warpgate-ssh') ||
          entry.startupCommand?.type !== 'snippet' ||
          entry.startupCommand.snippetId !== snippetId
        ) {
          return entry;
        }
        const next = { ...entry, startupCommand: null, updatedAt: timestamp };
        updated.push(next);
        return next;
      });
    });
    return updated;
  }

  remove(id: string): void {
    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts
        .filter((entry) => entry.id !== id)
        // Drop dangling jump-host references so a removed bastion doesn't leave
        // other hosts pointing at a host that no longer exists.
        .map((entry) => {
          if (!isSshHostRecord(entry)) {
            return entry;
          }
          const currentChain = normalizeJumpHostIds(entry.jumpHostIds, entry.jumpHostId);
          if (!currentChain.includes(id)) {
            return entry;
          }
          const nextChain = currentChain.filter((jumpId) => jumpId !== id);
          return {
            ...entry,
            jumpHostId: nextChain[0] ?? null,
            jumpHostIds: nextChain.length > 0 ? nextChain : null,
          };
        });
      // 이 호스트에 대해 기기 로컬로 골라 둔 모니터도 같이 버린다. 남겨 두면 없는 호스트의
      // 설정이 계속 쌓이고, 같은 id 가 재사용되면(가져오기 등) 엉뚱한 배치가 되살아난다.
      delete state.settings.rdpMonitorsByHostId[id];
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

  refreshAwsProfileNameCaches(
    profiles: Array<{ id: string; name: string }>
  ): HostRecord[] {
    const byId = new Map(profiles.map((profile) => [profile.id, profile.name]));
    const updatedHosts: HostRecord[] = [];
    const timestamp = nowIso();

    stateStorage.updateState((state) => {
      state.data.hosts = state.data.hosts.map((entry) => {
        if (entry.kind !== 'aws-ec2' && entry.kind !== 'aws-ecs') {
          return entry;
        }

        const profileId = entry.awsProfileId ?? null;
        const nextProfileName = profileId ? byId.get(profileId) : null;
        if (!nextProfileName) {
          if (profileId === null && entry.awsProfileName === '') {
            return entry;
          }
          const nextRecord = {
            ...entry,
            awsProfileId: null,
            awsProfileName: '',
            updatedAt: timestamp
          };
          updatedHosts.push(nextRecord);
          return nextRecord;
        }
        if (nextProfileName === entry.awsProfileName) {
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
    const { created } = createGroupIn(stateStorage.getState().data.groups, {
      id,
      name,
      parentPath,
      timestamp: nowIso()
    });

    stateStorage.updateState((state) => {
      state.data.groups.push(created);
    });
    return created;
  }

  move(targetPath: string, targetParentPath: string | null): GroupPathMutationResult {
    return this.applyPathMutation((groups, hosts, options) =>
      moveGroupIn(groups, hosts, targetPath, targetParentPath, options)
    );
  }

  rename(targetPath: string, name: string): GroupPathMutationResult {
    return this.applyPathMutation((groups, hosts, options) =>
      renameGroupIn(groups, hosts, targetPath, name, options)
    );
  }

  /**
   * 경로를 바꾸는 변형(이동·이름 변경)을 상태에 적용한다.
   *
   * 규칙 자체는 shared-core 의 순수 함수가 갖고 있다 — 모바일도 같은 것을 쓴다. 여기서는
   * 상태를 읽어 넘기고, 결과를 저장하고, 정렬해서 돌려주는 것만 한다.
   */
  private applyPathMutation(
    mutate: (
      groups: GroupRecord[],
      hosts: HostRecord[],
      options: { timestamp: string; normalizeHost: (host: HostRecord) => HostRecord }
    ) => { groups: GroupRecord[]; hosts: HostRecord[]; nextPath: string }
  ): GroupPathMutationResult {
    let nextPath = '';
    const nextState = stateStorage.updateState((state) => {
      const result = mutate(state.data.groups, state.data.hosts, {
        timestamp: nowIso(),
        normalizeHost: normalizeIncomingHostRecord
      });
      state.data.groups = result.groups;
      state.data.hosts = result.hosts;
      nextPath = result.nextPath;
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
    let removedGroupIds: string[] = [];
    let removedHostIds: string[] = [];
    const nextState = stateStorage.updateState((state) => {
      const result = removeGroupFrom(state.data.groups, state.data.hosts, targetPath, mode, {
        timestamp: nowIso(),
        normalizeHost: normalizeIncomingHostRecord
      });
      state.data.groups = result.groups;
      state.data.hosts = result.hosts;
      removedGroupIds = result.removedGroupIds;
      removedHostIds = result.removedHostIds;
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

/**
 * 등록된 tailnet. 설정과 auth key 를 분리해 보관한다 — 키는 비밀이라 암호화 저장소에 두고,
 * 레코드에는 키가 있는지 여부만 남긴다. 1b 에서 설정이 기기 간 동기화 대상이 되어도 키는
 * 따라가지 않는다.
 */
export class TailnetRepository {
  list(): TailnetRecord[] {
    return stateStorage.getState().data.tailnets;
  }

  /** 설정을 저장한다. authKey 가 undefined 면 기존 키를 그대로 둔다(빈 문자열은 삭제). */
  save(record: TailnetRecord, authKey?: string): TailnetRecord {
    const now = new Date().toISOString();
    stateStorage.updateState((state) => {
      if (authKey !== undefined) {
        if (authKey.length > 0) {
          state.secure.tailnetAuthKeysById[record.id] =
            encodeSecretForStorage(authKey);
        } else {
          delete state.secure.tailnetAuthKeysById[record.id];
        }
      }

      const hasAuthKey = Boolean(state.secure.tailnetAuthKeysById[record.id]);
      const existing = state.data.tailnets.find((item) => item.id === record.id);
      const next: TailnetRecord = {
        ...record,
        hasAuthKey,
        // ephemeral 은 요청하지 않는다.
        //
        // 예전에는 auth key 가 있으면 켰다("재등록이 자동이라 공짜다"). 그 전제가 틀렸다 —
        // Tailscale auth key 는 기본이 1회용이라 첫 등록에 소진되고, 앱을 끄면 컨트롤 플레인이
        // ephemeral 노드를 지운 뒤 다음 실행의 재등록이 "invalid key" 로 실패한다. 그때부터
        // 그 tailnet 은 새 키를 넣기 전까지 못 쓴다.
        //
        // 영속으로 등록하면 앱을 꺼도 노드가 남아 1회용 키도 문제가 되지 않는다. ephemeral 키를
        // 쓰는 경우에는 컨트롤 플레인이 키를 보고 알아서 그렇게 처리한다.
        ephemeral: false,
        createdAt: existing?.createdAt ?? record.createdAt ?? now,
        updatedAt: now,
      };

      state.data.tailnets = existing
        ? state.data.tailnets.map((item) => (item.id === record.id ? next : item))
        : [...state.data.tailnets, next];
    });

    return this.list().find((item) => item.id === record.id) ?? record;
  }

  remove(id: string): void {
    const timestamp = nowIso();
    stateStorage.updateState((state) => {
      state.data.tailnets = state.data.tailnets.filter((item) => item.id !== id);
      delete state.secure.tailnetAuthKeysById[id];
      // Tailnet 설정과 호스트의 경유 설정은 하나의 관계다. 설정만 지우면 호스트가 존재하지
      // 않는 id 를 계속 가리켜 연결할 수 없으므로, 같은 저장 트랜잭션에서 일반 네트워크로
      // 되돌린다. updatedAt 도 움직여야 이 변경이 다른 기기로 동기화된다.
      state.data.hosts = state.data.hosts.map((host) => {
        // SSH 와 RDP 가 같은 필드를 쓴다. 한쪽만 정리하면 그 종류만 없는 tailnet 을 가리킨 채
        // 남아 연결할 수 없다.
        if (
          (!isSshHostRecord(host) && !isRdpHostRecord(host)) ||
          host.tailnetId?.trim() !== id
        ) {
          return host;
        }
        return {
          ...host,
          tailnetId: null,
          updatedAt: timestamp,
        };
      });
    });
  }

  /**
   * 동기화에 실을 형태 — 레코드 + auth key.
   *
   * 렌더러로 가는 list() 와 달리 키가 들어 있다. 볼트 키로 암호화해 서버로 올리는 경로만
   * 이걸 쓴다. AWS 프로필의 listPayloads() 와 같은 역할이다.
   */
  listPayloads(): TailnetPayload[] {
    return this.list().map((record) => {
      const authKey = this.readAuthKey(record.id);
      return authKey ? { ...record, authKey } : { ...record };
    });
  }

  /**
   * 동기화로 내려온 것으로 전부 갈아 끼운다.
   *
   * 키와 레코드를 한 번의 updateState 로 같이 쓴다 — hasAuthKey 가 그 둘에서 나오므로
   * 나눠 쓰면 그 사이에 잘못된 값이 보인다.
   */
  replaceAll(payloads: TailnetPayload[]): void {
    stateStorage.updateState((state) => {
      const keys: Record<string, StoredEncryptedValue> = {};
      state.data.tailnets = payloads.map((payload) => {
        const record = normalizeTailnetPayloadForStorage(payload);
        const { authKey } = payload;
        if (authKey) {
          keys[record.id] = encodeSecretForStorage(authKey);
        }
        return record;
      });
      state.secure.tailnetAuthKeysById = keys;
    });
  }

  /** 연결할 때만 읽는다. 렌더러로는 절대 내보내지 않는다. */
  readAuthKey(id: string): string | null {
    const record = stateStorage.getState().secure.tailnetAuthKeysById[id];
    if (!record) {
      return null;
    }
    return decodeSecretFromStorage(record);
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
      language: normalizeAppLanguage(state.settings.language),
      homeHostViewMode: normalizeHomeHostViewMode(state.settings.homeHostViewMode),
      globalTerminalThemeId: state.terminal.globalThemeId,
      terminalFontFamily: state.terminal.fontFamily,
      terminalFontSize: state.terminal.fontSize,
      terminalScrollbackLines: state.terminal.scrollbackLines,
      terminalLineHeight: state.terminal.lineHeight,
      terminalLetterSpacing: state.terminal.letterSpacing,
      terminalMinimumContrastRatio: state.terminal.minimumContrastRatio,
      terminalAltIsMeta: state.terminal.altIsMeta,
      terminalWebglEnabled: state.terminal.webglEnabled,
      terminalAutocompleteEnabled: state.terminal.autocompleteEnabled,
      sftpBrowserColumnWidths: { ...state.settings.sftpBrowserColumnWidths },
      sftpConflictPolicy: state.settings.sftpConflictPolicy,
      sftpPreserveMtime: state.settings.sftpPreserveMtime,
      sftpPreservePermissions: state.settings.sftpPreservePermissions,
      sessionReplayRetentionCount:
        state.settings.sessionReplayRetentionCount ??
        DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
      commandNotificationsEnabled:
        state.settings.commandNotificationsEnabled ??
        DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationsEnabled,
      commandNotificationThresholdSeconds:
        state.settings.commandNotificationThresholdSeconds ??
        DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationThresholdSeconds,
      commandNotificationOnlyWhenUnfocused:
        state.settings.commandNotificationOnlyWhenUnfocused ??
        DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationOnlyWhenUnfocused,
      commandNotificationOnFailure:
        state.settings.commandNotificationOnFailure ??
        DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationOnFailure,
      commandNotificationSound:
        state.settings.commandNotificationSound ??
        DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationSound,
      hostMetricsEnabled:
        state.settings.hostMetricsEnabled ??
        DEFAULT_HOST_METRICS_SETTINGS.hostMetricsEnabled,
      autoReconnectEnabled:
        state.settings.autoReconnectEnabled ??
        DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectEnabled,
      autoReconnectMaxAttempts:
        state.settings.autoReconnectMaxAttempts ??
        DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectMaxAttempts,
      autoReconnectBaseDelayMs:
        state.settings.autoReconnectBaseDelayMs ??
        DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectBaseDelayMs,
      autoReconnectMaxDelayMs:
        state.settings.autoReconnectMaxDelayMs ??
        DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectMaxDelayMs,
      tmuxPrefixKey: state.settings.tmuxPrefixKey ?? 'C-b',
      ai: state.settings.ai ?? { ...DEFAULT_AI_SETTINGS },
      serverUrl: serverUrlOverride || this.getDefaultServerUrl(),
      serverUrlOverride,
      tailnetHostname: state.settings.tailnetHostname ?? null,
      // 상태에서 읽어야 한다. 여기 빈 객체를 두면 저장은 되는데 읽을 때마다 사라진다 —
      // get() 은 필드를 하나하나 나열하는 화이트리스트다.
      rdpMonitorsByHostId: state.settings.rdpMonitorsByHostId ?? {},
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
      const hasSftpConflictPolicyInput = Object.prototype.hasOwnProperty.call(input, 'sftpConflictPolicy');
      const hasSftpPreserveMtimeInput = Object.prototype.hasOwnProperty.call(input, 'sftpPreserveMtime');
      const hasSftpPreservePermissionsInput = Object.prototype.hasOwnProperty.call(input, 'sftpPreservePermissions');
      const hasHomeHostViewModeInput = Object.prototype.hasOwnProperty.call(input, 'homeHostViewMode');

      if (input.theme === 'light' || input.theme === 'dark' || input.theme === 'system') {
        state.settings.theme = input.theme;
        state.settings.updatedAt = nowIso();
      }

      if (input.language === 'ko' || input.language === 'en' || input.language === 'system') {
        state.settings.language = input.language;
        state.settings.updatedAt = nowIso();
      }

      if (input.homeHostViewMode === 'grid' || input.homeHostViewMode === 'list') {
        state.settings.homeHostViewMode = input.homeHostViewMode;
        state.settings.updatedAt = nowIso();
      }

      if (hasSftpBrowserColumnWidthsInput) {
        state.settings.sftpBrowserColumnWidths = normalizeSftpBrowserColumnWidths(
          input.sftpBrowserColumnWidths as Partial<Record<keyof SftpBrowserColumnWidths, unknown>> | null | undefined
        );
        state.settings.updatedAt = nowIso();
      }

      if (
        hasSftpConflictPolicyInput &&
        (input.sftpConflictPolicy === 'ask' ||
          input.sftpConflictPolicy === 'overwrite' ||
          input.sftpConflictPolicy === 'skip' ||
          input.sftpConflictPolicy === 'keepBoth')
      ) {
        state.settings.sftpConflictPolicy = input.sftpConflictPolicy;
        state.settings.updatedAt = nowIso();
      }

      if (hasSftpPreserveMtimeInput && typeof input.sftpPreserveMtime === 'boolean') {
        state.settings.sftpPreserveMtime = input.sftpPreserveMtime;
        state.settings.updatedAt = nowIso();
      }

      if (hasSftpPreservePermissionsInput && typeof input.sftpPreservePermissions === 'boolean') {
        state.settings.sftpPreservePermissions = input.sftpPreservePermissions;
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

      if (typeof input.commandNotificationsEnabled === 'boolean') {
        state.settings.commandNotificationsEnabled = input.commandNotificationsEnabled;
        state.settings.updatedAt = nowIso();
      }

      if (
        typeof input.commandNotificationThresholdSeconds === 'number' &&
        Number.isFinite(input.commandNotificationThresholdSeconds)
      ) {
        state.settings.commandNotificationThresholdSeconds = clampCommandNotificationThresholdSeconds(
          input.commandNotificationThresholdSeconds,
        );
        state.settings.updatedAt = nowIso();
      }

      if (typeof input.commandNotificationOnlyWhenUnfocused === 'boolean') {
        state.settings.commandNotificationOnlyWhenUnfocused = input.commandNotificationOnlyWhenUnfocused;
        state.settings.updatedAt = nowIso();
      }

      if (typeof input.commandNotificationOnFailure === 'boolean') {
        state.settings.commandNotificationOnFailure = input.commandNotificationOnFailure;
        state.settings.updatedAt = nowIso();
      }

      if (typeof input.commandNotificationSound === 'boolean') {
        state.settings.commandNotificationSound = input.commandNotificationSound;
        state.settings.updatedAt = nowIso();
      }

      if (typeof input.hostMetricsEnabled === 'boolean') {
        state.settings.hostMetricsEnabled = input.hostMetricsEnabled;
        state.settings.updatedAt = nowIso();
      }

      if (typeof input.autoReconnectEnabled === 'boolean') {
        state.settings.autoReconnectEnabled = input.autoReconnectEnabled;
        state.settings.updatedAt = nowIso();
      }

      if (
        typeof input.autoReconnectMaxAttempts === 'number' &&
        Number.isFinite(input.autoReconnectMaxAttempts)
      ) {
        state.settings.autoReconnectMaxAttempts = clampAutoReconnectMaxAttempts(
          input.autoReconnectMaxAttempts,
        );
        state.settings.updatedAt = nowIso();
      }

      if (
        typeof input.autoReconnectBaseDelayMs === 'number' &&
        Number.isFinite(input.autoReconnectBaseDelayMs)
      ) {
        state.settings.autoReconnectBaseDelayMs = clampAutoReconnectDelayMs(
          input.autoReconnectBaseDelayMs,
        );
        state.settings.updatedAt = nowIso();
      }

      if (
        typeof input.autoReconnectMaxDelayMs === 'number' &&
        Number.isFinite(input.autoReconnectMaxDelayMs)
      ) {
        state.settings.autoReconnectMaxDelayMs = clampAutoReconnectDelayMs(
          input.autoReconnectMaxDelayMs,
        );
        state.settings.updatedAt = nowIso();
      }

      if (typeof input.tmuxPrefixKey === 'string' && input.tmuxPrefixKey.trim()) {
        state.settings.tmuxPrefixKey = input.tmuxPrefixKey.trim();
        state.settings.updatedAt = nowIso();
      }

      // AI 설정. providerId enum / baseUrl 정규화 / temperature clamp 로 하위필드별 검증한다.
      // API 키는 여기 오지 않는다(SecretStore 전용). 부분 병합이므로 현재값을 기준으로 덮어쓴다.
      if (Object.prototype.hasOwnProperty.call(input, 'ai') && input.ai && typeof input.ai === 'object') {
        const incoming = input.ai as Partial<AiSettings>;
        const next: AiSettings = { ...(state.settings.ai ?? DEFAULT_AI_SETTINGS) };
        if (typeof incoming.enabled === 'boolean') {
          next.enabled = incoming.enabled;
        }
        if (
          incoming.providerId === 'openai-compat' ||
          incoming.providerId === 'anthropic' ||
          incoming.providerId === 'codex'
        ) {
          next.providerId = incoming.providerId;
        }
        if (Object.prototype.hasOwnProperty.call(incoming, 'baseUrl')) {
          next.baseUrl = normalizeAiBaseUrl(
            typeof incoming.baseUrl === 'string' ? incoming.baseUrl : undefined
          );
        }
        if (typeof incoming.model === 'string') {
          next.model = incoming.model.trim();
        }
        if (Object.prototype.hasOwnProperty.call(incoming, 'temperature')) {
          next.temperature =
            typeof incoming.temperature === 'number'
              ? clampAiTemperature(incoming.temperature)
              : undefined;
        }
        if (Object.prototype.hasOwnProperty.call(incoming, 'contextTokens')) {
          next.contextTokens =
            normalizeAiTokenLimit(incoming.contextTokens) ?? DEFAULT_AI_SETTINGS.contextTokens;
        }
        state.settings.ai = next;
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

      if (typeof input.terminalAutocompleteEnabled === 'boolean') {
        state.terminal.autocompleteEnabled = input.terminalAutocompleteEnabled;
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

      // 기기 로컬 전용이라 updatedAt 을 움직여도 동기화로 나가지 않는다(settings 는 동기화
      // 대상이 아니다). 빈 값은 null 로 — 코어가 기본값 `dolgate-<기기이름>` 으로 되돌린다.
      if (Object.prototype.hasOwnProperty.call(input, 'tailnetHostname')) {
        const nextHostname =
          typeof input.tailnetHostname === 'string' && input.tailnetHostname.trim()
            ? input.tailnetHostname.trim()
            : null;
        state.settings.tailnetHostname = nextHostname;
        state.settings.updatedAt = nowIso();
      }

      // RDP 호스트별 모니터 선택. tailnetHostname 과 같이 기기 로컬 전용이라 동기화로 나가지
      // 않는다. 선택이 빈 배열이면 항목째로 지운다 — "고른 것 없음"이 두 모양으로 저장되면
      // 접속 경로에서 판단이 갈린다.
      if (Object.prototype.hasOwnProperty.call(input, 'rdpMonitorsByHostId')) {
        const next: Record<string, RdpMonitorSelection[]> = {};
        for (const [hostId, monitors] of Object.entries(input.rdpMonitorsByHostId ?? {})) {
          if (hostId.trim() && Array.isArray(monitors) && monitors.length > 0) {
            next[hostId] = monitors;
          }
        }
        state.settings.rdpMonitorsByHostId = next;
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
        !hasSftpConflictPolicyInput &&
        !hasSftpPreserveMtimeInput &&
        !hasSftpPreservePermissionsInput &&
        !hasHomeHostViewModeInput &&
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
        input.terminalWebglEnabled == null &&
        input.terminalAutocompleteEnabled == null
      ) {
        state.settings.theme = current.theme as AppTheme;
        state.settings.homeHostViewMode = normalizeHomeHostViewMode(current.homeHostViewMode);
        state.settings.sftpBrowserColumnWidths = { ...current.sftpBrowserColumnWidths };
        state.settings.sftpConflictPolicy = current.sftpConflictPolicy ?? 'ask';
        state.settings.sftpPreserveMtime = current.sftpPreserveMtime ?? true;
        state.settings.sftpPreservePermissions = current.sftpPreservePermissions ?? false;
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
        state.terminal.autocompleteEnabled = current.terminalAutocompleteEnabled ?? true;
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

function toSnippetRecord(
  id: string,
  draft: SnippetDraft,
  createdAt: string,
  updatedAt: string,
): SnippetRecord {
  const label = draft.label.trim();
  if (!label) {
    throw new Error('Snippet label is required');
  }
  if (!draft.command.trim()) {
    throw new Error('Snippet command is required');
  }
  return {
    id,
    label,
    command: draft.command,
    keyword: draft.keyword?.trim() || null,
    createdAt,
    updatedAt,
  };
}

function normalizeIncomingSnippetRecord(record: SnippetRecord): SnippetRecord {
  return {
    ...record,
    keyword: record.keyword?.trim() || null,
  };
}

function compareSnippets(left: SnippetRecord, right: SnippetRecord): number {
  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

export class SnippetRepository {
  list(): SnippetRecord[] {
    return stateStorage.getState().data.snippets.slice().sort(compareSnippets);
  }

  getById(id: string): SnippetRecord | null {
    return stateStorage.getState().data.snippets.find((record) => record.id === id) ?? null;
  }

  create(draft: SnippetDraft): SnippetRecord {
    const timestamp = nowIso();
    const record = toSnippetRecord(randomUUID(), draft, timestamp, timestamp);
    stateStorage.updateState((state) => {
      state.data.snippets.push(record);
    });
    return record;
  }

  update(id: string, draft: SnippetDraft): SnippetRecord {
    const current = this.getById(id);
    if (!current) {
      throw new Error('Snippet not found');
    }
    const record = toSnippetRecord(id, draft, current.createdAt, nowIso());
    stateStorage.updateState((state) => {
      state.data.snippets = state.data.snippets.map((entry) => (entry.id === id ? record : entry));
    });
    return record;
  }

  remove(id: string): void {
    stateStorage.updateState((state) => {
      state.data.snippets = state.data.snippets.filter((entry) => entry.id !== id);
    });
  }

  replaceAll(records: SnippetRecord[]): void {
    stateStorage.updateState((state) => {
      state.data.snippets = records.map(normalizeIncomingSnippetRecord).sort(compareSnippets);
    });
  }
}

/**
 * 신뢰 범위를 정규화한다. 없음·빈 문자열·공백은 모두 "일반 네트워크"다.
 *
 * 이 비교가 곧 보안 경계다. 느슨하게 맞추면 tailnet 안에서 신뢰한 키가 일반 네트워크의
 * 같은 이름 호스트에도 적용되고, 그 반대도 된다.
 */
function normalizeTailnetScope(tailnetId?: string | null): string {
  return (tailnetId ?? '').trim();
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
        const portCompare = left.port - right.port;
        if (portCompare !== 0) {
          return portCompare;
        }
        return left.algorithm.localeCompare(right.algorithm);
      });
  }

  getByHostPort(host: string, port: number): KnownHostRecord | null {
    return stateStorage.getState().data.knownHosts.find((record) => record.host === host && record.port === port) ?? null;
  }

  getByHostPortAlgorithm(
    host: string,
    port: number,
    algorithm: string,
    tailnetId?: string,
  ): KnownHostRecord | null {
    const scope = normalizeTailnetScope(tailnetId);
    return (
      stateStorage
        .getState()
        .data.knownHosts.find(
          (record) =>
            normalizeTailnetScope(record.tailnetId) === scope &&
            record.host === host &&
            record.port === port &&
            record.algorithm === algorithm
        ) ?? null
    );
  }

  listByHostPort(host: string, port: number, tailnetId?: string): KnownHostRecord[] {
    const scope = normalizeTailnetScope(tailnetId);
    return stateStorage
      .getState()
      .data.knownHosts.filter(
        (record) =>
          normalizeTailnetScope(record.tailnetId) === scope &&
          record.host === host &&
          record.port === port
      )
      .sort((left, right) => left.algorithm.localeCompare(right.algorithm));
  }

  trust(input: KnownHostTrustInput): KnownHostRecord {
    const current = this.getByHostPortAlgorithm(
      input.host,
      input.port,
      input.algorithm,
      input.tailnetId,
    );
    const timestamp = nowIso();
    const scope = normalizeTailnetScope(input.tailnetId);
    const record: KnownHostRecord = {
      id: current?.id ?? randomUUID(),
      ...(scope ? { tailnetId: scope } : {}),
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

  touch(host: string, port: number, algorithm?: string, tailnetId?: string): void {
    const timestamp = nowIso();
    const scope = normalizeTailnetScope(tailnetId);
    stateStorage.updateState((state) => {
      state.data.knownHosts = state.data.knownHosts.map((entry) => {
        if (
          normalizeTailnetScope(entry.tailnetId) !== scope ||
          entry.host !== host ||
          entry.port !== port ||
          (algorithm && entry.algorithm !== algorithm)
        ) {
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
  activate(owner: LocalHistoryOwner): void {
    getDesktopStateStorage().activateActivityLogScope(owner);
  }

  deactivate(): void {
    getDesktopStateStorage().deactivateActivityLogScope();
  }

  list(): ActivityLogRecord[] {
    return stateStorage.listActivityLogs();
  }

  // message 는 logMessage() 로 만든 값을 권장한다 — 그러면 번역 키가 함께 저장돼 나중에
  // 언어를 바꿔도 목록이 현재 언어로 다시 그려진다. 문자열을 그대로 넘기면 그 문구가
  // 기록 당시 언어로 굳는다.
  append(
    level: ActivityLogLevel,
    category: ActivityLogCategory,
    message: string | ActivityLogMessage,
    metadata?: Record<string, unknown> | null
  ): ActivityLogRecord {
    const timestamp = nowIso();
    const resolved =
      typeof message === 'string'
        ? { message, messageKey: undefined, messageParams: null }
        : message;
    const record: ActivityLogRecord = {
      id: randomUUID(),
      level,
      category,
      kind: 'generic',
      message: resolved.message,
      messageKey: resolved.messageKey,
      messageParams: resolved.messageParams ?? null,
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

  reconcileReplayFlags(existingRecordingIds: ReadonlySet<string>): number {
    return stateStorage.reconcileReplayFlags(existingRecordingIds);
  }
}

export class SecretMetadataRepository {
  upsert(input: {
    secretRef: string;
    label: string;
    kind?: 'ssh' | 'rdp' | 'vnc';
    username?: string;
    domain?: string;
    hasPassword: boolean;
    hasPassphrase: boolean;
    hasManagedPrivateKey?: boolean;
    hasCertificate?: boolean;
    privateKeyEncrypted?: boolean;
    keyAlgorithm?: string;
    keyCurve?: string;
    keyBits?: number;
    privateKeyCipher?: string;
    privateKeyKdfRounds?: number;
    passphraseSaved?: boolean;
  }): void {
    stateStorage.updateState((state) => {
      const timestamp = nowIso();
      const nextRecord: SecretMetadataRecord = {
        secretRef: input.secretRef,
        label: input.label,
        // 없으면 SSH 로 본다 — 이 필드가 생기기 전 항목은 모두 SSH 용이다.
        kind: input.kind ?? null,
        username: input.username?.trim() || null,
        domain: input.domain?.trim() || null,
        hasPassword: input.hasPassword,
        hasPassphrase: input.hasPassphrase,
        hasManagedPrivateKey: input.hasManagedPrivateKey ?? false,
        hasCertificate: input.hasCertificate ?? false,
        privateKeyEncrypted: input.privateKeyEncrypted,
        keyAlgorithm: input.keyAlgorithm,
        keyCurve: input.keyCurve,
        keyBits: input.keyBits,
        privateKeyCipher: input.privateKeyCipher,
        privateKeyKdfRounds: input.privateKeyKdfRounds,
        passphraseSaved: input.passphraseSaved,
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
