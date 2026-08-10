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
  rmSync,
  writeFileSync
} from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import type {
  ActivityLogRecord,
  AppLanguage,
  AwsProfileMetadataRecord,
  TailnetRecord,
  AwsSsmPortForwardRuleRecord,
  AppTheme,
  ContainerPortForwardRuleRecord,
  DnsOverrideRecord,
  LinkedDnsOverrideRecord,
  StaticDnsOverrideRecord,
  GlobalTerminalThemeId,
  GroupRecord,
  HomeHostViewMode,
  HostRecord,
  HostStartupCommand,
  HostEnvVar,
  KnownHostRecord,
  PortForwardRuleRecord,
  SftpBrowserColumnWidths,
  SftpConflictPolicy,
  SshPortForwardRuleRecord,
  SecretMetadataRecord,
  SnippetRecord,
  AiProviderId,
  AiSettings,
  TerminalFontFamilyId,
  TerminalThemeId,
  RdpDriveShare,
  RdpMonitorSelection
} from '@shared';
import {
  DEFAULT_AUTO_RECONNECT_SETTINGS,
  DEFAULT_COMMAND_NOTIFICATION_SETTINGS,
  DEFAULT_HOST_METRICS_SETTINGS,
  DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  MAX_SESSION_REPLAY_RETENTION_COUNT,
  DEFAULT_AI_SETTINGS,
  MAX_HOST_STARTUP_COMMAND_LENGTH,
  MIN_SESSION_REPLAY_RETENTION_COUNT,
  clampAiTemperature,
  clampAutoReconnectDelayMs,
  clampAutoReconnectMaxAttempts,
  clampCommandNotificationThresholdSeconds,
  normalizeAiBaseUrl,
  normalizeAiTokenLimit,
  normalizeHostEnvVars,
  normalizeJumpHostIds,
  normalizeSftpBrowserColumnWidths
} from '@shared';
import type { SyncKind } from '@shared';
import { normalizeAppLanguage } from '../common/i18n/locale';
import {
  resolveLocalHistoryScope,
  type LocalHistoryOwner
} from './local-history-scope';

const STORAGE_DIRNAME = 'storage';
const STATE_FILE_NAME = 'state.json';
const STATE_TEMP_FILE_NAME = 'state.json.tmp';
const STATE_BACKUP_FILE_NAME = 'state.json.bak';
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
    language: AppLanguage;
    homeHostViewMode: HomeHostViewMode;
    sftpBrowserColumnWidths: SftpBrowserColumnWidths;
    sftpConflictPolicy: SftpConflictPolicy;
    sftpPreserveMtime: boolean;
    sftpPreservePermissions: boolean;
    sessionReplayRetentionCount: number;
    commandNotificationsEnabled: boolean;
    commandNotificationThresholdSeconds: number;
    commandNotificationOnlyWhenUnfocused: boolean;
    commandNotificationOnFailure: boolean;
    commandNotificationSound: boolean;
    hostMetricsEnabled: boolean;
    autoReconnectEnabled: boolean;
    autoReconnectMaxAttempts: number;
    autoReconnectBaseDelayMs: number;
    autoReconnectMaxDelayMs: number;
    tmuxPrefixKey: string;
    subshellReinjectEnabled: boolean;
    subshellReinjectPatterns: string[];
    ai: AiSettings | null;
    serverUrlOverride: string | null;
    // 기기 로컬 전용. settings 는 동기화 대상이 아니라 여기 두는 것만으로 그렇게 된다.
    tailnetHostname: string | null;
    /**
     * RDP 호스트별로 고른 모니터. 기기 로컬 전용이다.
     *
     * 호스트 레코드에 두지 않는 이유: 레코드는 동기화되는데 붙어 있는 모니터는 기기마다 다르다.
     * 다른 기기에서 고른 화면 배치가 넘어오면 없는 화면을 가리키게 된다. 호스트에는 "전체
     * 모니터를 쓸 것인가"(useAllMonitors)만 남고 세부 선택은 여기 있다.
     */
    rdpMonitorsByHostId: Record<string, RdpMonitorSelection[]>;
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
    autocompleteEnabled: boolean;
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
  client: {
    installationId: string | null;
    updatedAt: string;
  };
  sync: {
    lastSuccessfulSyncAt: string | null;
    pendingPush: boolean;
    errorMessage: string | null;
    awsProfilesServerSupport: 'unknown' | 'supported' | 'unsupported';
    ownerUserId: string | null;
    ownerServerUrl: string | null;
    updatedAt: string;
  };
  data: {
    groups: GroupRecord[];
    hosts: HostRecord[];
    knownHosts: KnownHostRecord[];
    portForwards: PortForwardRuleRecord[];
    dnsOverrides: DnsOverrideRecord[];
    secretMetadata: SecretMetadataRecord[];
    awsProfiles: AwsProfileMetadataRecord[];
    /** 등록된 tailnet. auth key 는 secure.tailnetAuthKeysById 에 따로 둔다. */
    tailnets: TailnetRecord[];
    snippets: SnippetRecord[];
    syncOutbox: SyncDeletionRecord[];
  };
  secure: {
    refreshToken: StoredEncryptedValue | null;
    // sync 대상이 아닌 앱 자체 시크릿(auth:*, ai:* 등).
    // managedSecretsByRef 는 sync 스냅샷 적용 시 통째로 교체되므로 여기 두면 안 된다.
    appSecretsByAccount: Record<string, StoredEncryptedValue>;
    managedSecretsByRef: Record<string, StoredEncryptedValue>;
    managedAwsProfilesById: Record<string, StoredEncryptedValue>;
    /**
     * tailnet id → auth key. 설정(이름·ControlURL 등)은 평문 상태에 두지만 키는 비밀이라
     * 여기 둔다. 1b 에서 tailnet 설정이 동기화 대상이 되어도 키는 딸려 나가지 않는다.
     */
    tailnetAuthKeysById: Record<string, StoredEncryptedValue>;
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

// 저장된 원본 AI 설정을 검증/정규화한다. 없거나 형식이 아니면 null(→ get()이 DEFAULT 폴백).
function normalizeAiSettings(value: unknown): AiSettings | null {
  if (!isObject(value)) {
    return null;
  }
  const providerId: AiProviderId =
    value.providerId === 'anthropic' || value.providerId === 'codex'
      ? value.providerId
      : 'openai-compat';
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
    providerId,
    baseUrl: normalizeAiBaseUrl(typeof value.baseUrl === 'string' ? value.baseUrl : undefined),
    model: typeof value.model === 'string' ? value.model : '',
    temperature:
      typeof value.temperature === 'number' ? clampAiTemperature(value.temperature) : undefined,
    contextTokens: normalizeAiTokenLimit(value.contextTokens) ?? DEFAULT_AI_SETTINGS.contextTokens
  };
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
    value === 'source-code-pro' ||
    value === 'cascadia-code' ||
    value === 'geist-mono' ||
    value === 'roboto-mono' ||
    value === 'ubuntu-mono' ||
    value === 'space-mono' ||
    value === 'inconsolata' ||
    value === 'victor-mono'
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

function normalizeSftpConflictPolicy(value: unknown): SftpConflictPolicy {
  return value === 'overwrite' || value === 'skip' || value === 'keepBoth' || value === 'ask'
    ? value
    : 'ask';
}

function normalizeHomeHostViewMode(value: unknown): HomeHostViewMode {
  return value === 'list' ? 'list' : 'grid';
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

export function normalizePortForwardRule(value: unknown): PortForwardRuleRecord | null {
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

  if (value.transport === 'ecs-task') {
    if (typeof value.targetPort !== 'number' || !Number.isFinite(value.targetPort)) {
      return null;
    }

    return {
      id: value.id,
      label: value.label.trim(),
      hostId: value.hostId,
      transport: 'ecs-task',
      bindAddress: '127.0.0.1',
      bindPort: Math.round(value.bindPort),
      serviceName: typeof value.serviceName === 'string' ? value.serviceName.trim() : '',
      containerName: typeof value.containerName === 'string' ? value.containerName.trim() : '',
      targetPort: Math.round(value.targetPort),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
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

export function normalizeDnsOverrideRecord(value: unknown): DnsOverrideRecord | null {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.hostname !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }

  const hostname = value.hostname.trim().toLowerCase();
  if (!hostname) {
    return null;
  }

  const normalizedType = value.type === 'static' ? 'static' : 'linked';
  if (normalizedType === 'linked') {
    if (typeof value.portForwardRuleId !== 'string') {
      return null;
    }
    const record: LinkedDnsOverrideRecord = {
      id: value.id,
      type: 'linked',
      hostname,
      portForwardRuleId: value.portForwardRuleId,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    };
    return record;
  }

  if (typeof value.address !== 'string') {
    return null;
  }
  const address = value.address.trim();
  if (!address || isIP(address) === 0) {
    return null;
  }

  const record: StaticDnsOverrideRecord = {
    id: value.id,
    type: 'static',
    hostname,
    address,
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
      language: 'system',
      homeHostViewMode: 'grid',
      sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
      sftpConflictPolicy: 'ask',
      sftpPreserveMtime: true,
      sftpPreservePermissions: false,
      sessionReplayRetentionCount: DEFAULT_SESSION_REPLAY_RETENTION_COUNT,
      commandNotificationsEnabled: DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationsEnabled,
      commandNotificationThresholdSeconds:
        DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationThresholdSeconds,
      commandNotificationOnlyWhenUnfocused:
        DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationOnlyWhenUnfocused,
      commandNotificationOnFailure: DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationOnFailure,
      commandNotificationSound: DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationSound,
      hostMetricsEnabled: DEFAULT_HOST_METRICS_SETTINGS.hostMetricsEnabled,
      autoReconnectEnabled: DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectEnabled,
      autoReconnectMaxAttempts: DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectMaxAttempts,
      autoReconnectBaseDelayMs: DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectBaseDelayMs,
      autoReconnectMaxDelayMs: DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectMaxDelayMs,
      tmuxPrefixKey: 'C-b',
      subshellReinjectEnabled: true,
      subshellReinjectPatterns: [],
      ai: null,
      serverUrlOverride: null,
      tailnetHostname: null,
      rdpMonitorsByHostId: {},
      updatedAt: timestamp
    },
    terminal: {
      globalThemeId: 'system',
      globalThemeUpdatedAt: timestamp,
      fontFamily: defaultTerminalFontFamily,
      fontSize: 13,
      scrollbackLines: 5000,
      lineHeight: 1,
      letterSpacing: 0,
      minimumContrastRatio: 1,
      altIsMeta: false,
      webglEnabled: defaultTerminalWebglEnabled,
      autocompleteEnabled: true,
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
    client: {
      installationId: null,
      updatedAt: timestamp
    },
    sync: {
      lastSuccessfulSyncAt: null,
      pendingPush: false,
      errorMessage: null,
      awsProfilesServerSupport: 'unknown',
      ownerUserId: null,
      ownerServerUrl: null,
      updatedAt: timestamp
    },
    data: {
      groups: [],
      hosts: [],
      knownHosts: [],
      portForwards: [],
      dnsOverrides: [],
      secretMetadata: [],
      awsProfiles: [],
      tailnets: [],
      snippets: [],
      syncOutbox: []
    },
    secure: {
      refreshToken: null,
      appSecretsByAccount: {},
      managedSecretsByRef: {},
      managedAwsProfilesById: {},
      tailnetAuthKeysById: {}
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

/**
 * 저장된 모니터 선택을 읽어들인다.
 *
 * 저장 파일은 손으로 고칠 수도 있고 예전 버전이 쓴 것일 수도 있다. 모양이 어긋난 항목은 버린다 —
 * 반쯤 깨진 선택으로 접속하면 엉뚱한 화면 배치가 나온다.
 */
function normalizeStoredRdpMonitors(value: unknown): RdpMonitorSelection[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const monitors = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    const id = candidate.id;
    const width = candidate.width;
    const height = candidate.height;
    if (
      typeof id !== 'number' ||
      !Number.isFinite(id) ||
      typeof width !== 'number' ||
      !Number.isFinite(width) ||
      typeof height !== 'number' ||
      !Number.isFinite(height)
    ) {
      return [];
    }
    return [
      {
        id: Math.round(id),
        label: typeof candidate.label === 'string' ? candidate.label : '',
        width: Math.round(width),
        height: Math.round(height)
      }
    ];
  });
  return monitors.length > 0 ? monitors : null;
}

/**
 * 호스트별로 고른 모니터 묶음. 기기 로컬 설정이라 동기화되지 않는다.
 *
 * 선택이 빈 배열이 된 호스트는 항목째로 버린다 — "고른 것 없음"이 두 모양(없음/빈 배열)으로
 * 저장되면 접속 경로에서 판단이 갈린다.
 */
/**
 * 공유 폴더 목록. 없으면 옛 단일 필드(`drivePath`)를 한 항목으로 옮긴다.
 *
 * 이관을 안 하면 기존 사용자의 공유가 조용히 사라진다 — 원격에 드라이브가 안 뜨는데 설정
 * 화면에도 아무것도 없어서 왜 없어졌는지 알 수 없다.
 */
function normalizeStoredRdpDrives(
  value: unknown,
  legacyPath: unknown,
  legacyReadOnly: unknown
): RdpDriveShare[] | null {
  const fromList = Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!isObject(entry) || typeof entry.path !== 'string' || !entry.path.trim()) {
          return [];
        }
        return [{ path: entry.path, readOnly: entry.readOnly === true ? true : null }];
      })
    : [];
  if (fromList.length > 0) {
    return fromList;
  }

  if (typeof legacyPath === 'string' && legacyPath.trim()) {
    return [{ path: legacyPath, readOnly: legacyReadOnly === true ? true : null }];
  }

  return null;
}

function normalizeStoredRdpMonitorsByHost(
  value: unknown
): Record<string, RdpMonitorSelection[]> {
  if (!isObject(value)) {
    return {};
  }
  const result: Record<string, RdpMonitorSelection[]> = {};
  for (const [hostId, monitors] of Object.entries(value)) {
    if (!hostId.trim()) {
      continue;
    }
    const normalized = normalizeStoredRdpMonitors(monitors);
    if (normalized) {
      result[hostId] = normalized;
    }
  }
  return result;
}

function normalizeStoredHostStartupCommand(value: unknown): HostStartupCommand | null {
  if (!isObject(value)) {
    return null;
  }
  if (value.type === 'command' && typeof value.command === 'string') {
    return value.command.trim() && value.command.length <= MAX_HOST_STARTUP_COMMAND_LENGTH
      ? { type: 'command', command: value.command }
      : null;
  }
  if (value.type === 'snippet' && typeof value.snippetId === 'string') {
    const snippetId = value.snippetId.trim();
    return snippetId ? { type: 'snippet', snippetId } : null;
  }
  return null;
}

export function normalizeHostRecord(value: unknown): HostRecord | null {
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
      startupCommand: normalizeStoredHostStartupCommand(value.startupCommand),
      awsProfileId: typeof value.awsProfileId === 'string' ? value.awsProfileId : null,
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
      awsSsmServerProxyEnabled: value.awsSsmServerProxyEnabled === true,
      agentForwarding: value.agentForwarding === true ? true : null,
      favorite: value.favorite === true ? true : null,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
    };
  }

  if (value.kind === 'aws-ecs') {
    if (
      typeof value.awsProfileName !== 'string' ||
      typeof value.awsRegion !== 'string' ||
      typeof value.awsEcsClusterArn !== 'string' ||
      typeof value.awsEcsClusterName !== 'string'
    ) {
      return null;
    }
    return {
      id: value.id,
      kind: 'aws-ecs',
      label: value.label,
      groupName: typeof value.groupName === 'string' ? value.groupName : null,
      tags,
      terminalThemeId: isTerminalThemeId(value.terminalThemeId) ? value.terminalThemeId : null,
      awsProfileId: typeof value.awsProfileId === 'string' ? value.awsProfileId : null,
      awsProfileName: value.awsProfileName,
      awsRegion: value.awsRegion,
      awsEcsClusterArn: value.awsEcsClusterArn,
      awsEcsClusterName: value.awsEcsClusterName,
      favorite: value.favorite === true ? true : null,
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
      startupCommand: normalizeStoredHostStartupCommand(value.startupCommand),
      warpgateBaseUrl: value.warpgateBaseUrl,
      warpgateSshHost: value.warpgateSshHost,
      warpgateSshPort: value.warpgateSshPort,
      warpgateTargetId: value.warpgateTargetId,
      warpgateTargetName: value.warpgateTargetName,
      warpgateUsername: value.warpgateUsername,
      favorite: value.favorite === true ? true : null,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
    };
  }

  if (value.kind === 'serial') {
    if (
      (value.transport !== 'local' && value.transport !== 'raw-tcp' && value.transport !== 'rfc2217') ||
      typeof value.baudRate !== 'number' ||
      !Number.isFinite(value.baudRate)
    ) {
      return null;
    }

    const rawDataBits = typeof value.dataBits === 'number' ? value.dataBits : 8;
    const dataBits = rawDataBits === 5 || rawDataBits === 6 || rawDataBits === 7 ? rawDataBits : 8;
    const rawStopBits = typeof value.stopBits === 'number' ? value.stopBits : 1;
    const stopBits = rawStopBits === 1.5 || rawStopBits === 2 ? rawStopBits : 1;
    const parity =
      value.parity === 'odd' ||
      value.parity === 'even' ||
      value.parity === 'mark' ||
      value.parity === 'space'
        ? value.parity
        : 'none';
    const flowControl =
      value.flowControl === 'xon-xoff' ||
      value.flowControl === 'rts-cts' ||
      value.flowControl === 'dsr-dtr'
        ? value.flowControl
        : 'none';

    return {
      id: value.id,
      kind: 'serial',
      label: value.label,
      groupName: typeof value.groupName === 'string' ? value.groupName : null,
      tags,
      terminalThemeId: isTerminalThemeId(value.terminalThemeId) ? value.terminalThemeId : null,
      transport: value.transport,
      devicePath: typeof value.devicePath === 'string' ? value.devicePath : null,
      host: typeof value.host === 'string' ? value.host : null,
      port:
        typeof value.port === 'number' && Number.isFinite(value.port)
          ? Math.round(value.port)
          : null,
      baudRate: Math.max(1, Math.round(value.baudRate)),
      dataBits,
      parity,
      stopBits,
      flowControl,
      transmitLineEnding:
        value.transmitLineEnding === 'cr' ||
        value.transmitLineEnding === 'lf' ||
        value.transmitLineEnding === 'crlf'
          ? value.transmitLineEnding
          : 'none',
      localEcho: Boolean(value.localEcho),
      localLineEditing: Boolean(value.localLineEditing),
      favorite: value.favorite === true ? true : null,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
    };
  }

  if (value.kind === 'rdp') {
    // 계정은 자격증명에 있으므로 레코드에 없다. 옛 레코드에 남아 있어도 검사하지 않는다 —
    // 여기서 걸러 내면 그 호스트가 목록에서 통째로 사라진다.
    if (typeof value.hostname !== 'string') {
      return null;
    }

    return {
      id: value.id,
      kind: 'rdp',
      label: value.label,
      groupName: typeof value.groupName === 'string' ? value.groupName : null,
      tags,
      terminalThemeId: isTerminalThemeId(value.terminalThemeId) ? value.terminalThemeId : null,
      hostname: value.hostname,
      port:
        typeof value.port === 'number' && Number.isFinite(value.port)
          ? Math.round(value.port)
          : 3389,
      secretRef: typeof value.secretRef === 'string' ? value.secretRef : null,
      certificateFingerprint:
        typeof value.certificateFingerprint === 'string' ? value.certificateFingerprint : null,
      drives: normalizeStoredRdpDrives(value.drives, value.drivePath, value.driveReadOnly),
      // 옛 필드는 그대로 남긴다. 지우면 다른 기기의 옛 빌드와 동기화될 때 값이 왕복한다.
      drivePath: typeof value.drivePath === 'string' ? value.drivePath : null,
      driveReadOnly: value.driveReadOnly === true ? true : null,
      adminSession: value.adminSession === true ? true : null,
      useAllMonitors: value.useAllMonitors === true ? true : null,
      audioEnabled: value.audioEnabled === false ? false : null,
      clipboardEnabled: value.clipboardEnabled === false ? false : null,
      colorDepth: value.colorDepth === 16 ? 16 : null,
      tailnetId: typeof value.tailnetId === 'string' && value.tailnetId.trim() ? value.tailnetId.trim() : null,
      monitors: normalizeStoredRdpMonitors(value.monitors),
      favorite: value.favorite === true ? true : null,
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

  const jumpHostIds = normalizeJumpHostIds(
    value.jumpHostIds as (string | null | undefined)[] | null | undefined,
    typeof value.jumpHostId === 'string' ? value.jumpHostId : null,
  );

  return {
    id: value.id,
    kind: 'ssh',
    label: value.label,
    groupName: typeof value.groupName === 'string' ? value.groupName : null,
    tags,
    terminalThemeId: isTerminalThemeId(value.terminalThemeId) ? value.terminalThemeId : null,
    startupCommand: normalizeStoredHostStartupCommand(value.startupCommand),
    hostname: value.hostname,
    port: value.port,
    username: value.username,
    authType:
      value.authType === 'privateKey'
        ? 'privateKey'
        : value.authType === 'certificate'
          ? 'certificate'
          : 'password',
    privateKeyPath: typeof value.privateKeyPath === 'string' ? value.privateKeyPath : null,
    certificatePath: typeof value.certificatePath === 'string' ? value.certificatePath : null,
    secretRef: typeof value.secretRef === 'string' ? value.secretRef : null,
    jumpHostId: jumpHostIds[0] ?? null,
    jumpHostIds: jumpHostIds.length > 0 ? jumpHostIds : null,
    // 이 정규화는 필드를 나열해 새로 만드는 화이트리스트다. 빠뜨리면 디스크 리로드와 동기화
    // 적용에서 조용히 사라진다 — 저장은 됐는데 앱을 다시 켜면 없다.
    tailnetId: typeof value.tailnetId === 'string' ? value.tailnetId : null,
    useMosh: value.useMosh === true ? true : null,
    agentForwarding: value.agentForwarding === true ? true : null,
    // env는 호스트 속성으로 저장된다(시크릿 분리). 디스크 리로드 시에도 보존돼야 한다.
    env: normalizeHostEnvVars(value.env as HostEnvVar[] | undefined),
    favorite: value.favorite === true ? true : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
  };
}

function normalizeSecretMetadataRecord(value: unknown): SecretMetadataRecord | null {
  if (!isObject(value) || typeof value.secretRef !== 'string' || typeof value.label !== 'string') {
    return null;
  }

  return {
    secretRef: value.secretRef,
    label: value.label,
    kind: value.kind === 'rdp' ? 'rdp' : value.kind === 'ssh' ? 'ssh' : null,
    username: typeof value.username === 'string' && value.username.trim() ? value.username : null,
    domain: typeof value.domain === 'string' && value.domain.trim() ? value.domain : null,
    hasPassword: Boolean(value.hasPassword),
    hasPassphrase: Boolean(value.hasPassphrase),
    hasManagedPrivateKey: Boolean(value.hasManagedPrivateKey),
    hasCertificate: Boolean(value.hasCertificate),
    privateKeyEncrypted:
      typeof value.privateKeyEncrypted === 'boolean'
        ? value.privateKeyEncrypted
        : undefined,
    keyAlgorithm: typeof value.keyAlgorithm === 'string' ? value.keyAlgorithm : undefined,
    keyCurve: typeof value.keyCurve === 'string' ? value.keyCurve : undefined,
    keyBits: typeof value.keyBits === 'number' ? value.keyBits : undefined,
    privateKeyCipher:
      typeof value.privateKeyCipher === 'string'
        ? value.privateKeyCipher
        : undefined,
    privateKeyKdfRounds:
      typeof value.privateKeyKdfRounds === 'number'
        ? value.privateKeyKdfRounds
        : undefined,
    passphraseSaved:
      typeof value.passphraseSaved === 'boolean' ? value.passphraseSaved : undefined,
    linkedHostCount: typeof value.linkedHostCount === 'number' ? value.linkedHostCount : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
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
  const client = isObject(value.client) ? value.client : {};
  const sync = isObject(value.sync) ? value.sync : {};
  const data = isObject(value.data) ? value.data : {};
  const secure = isObject(value.secure) ? value.secure : {};
  const appSecrets = isObject(secure.appSecretsByAccount) ? secure.appSecretsByAccount : {};
  const managedSecrets = isObject(secure.managedSecretsByRef) ? secure.managedSecretsByRef : {};
  const managedAwsProfiles = isObject(secure.managedAwsProfilesById) ? secure.managedAwsProfilesById : {};
  const tailnetAuthKeys = isObject(secure.tailnetAuthKeysById) ? secure.tailnetAuthKeysById : {};
  const normalizedTerminalFontFamily = normalizeTerminalFontFamily(terminal.fontFamily, fallback.terminal.fontFamily);
  const normalizedTerminalWebglEnabled = normalizeTerminalWebglEnabled(terminal.webglEnabled);

  const normalizedAppSecrets: Record<string, StoredEncryptedValue> = {};
  for (const [account, record] of Object.entries(appSecrets)) {
    const normalized = normalizeStoredEncryptedValue(record);
    if (normalized) {
      normalizedAppSecrets[account] = normalized;
    }
  }

  const normalizedManagedSecrets: Record<string, StoredEncryptedValue> = {};
  for (const [secretRef, record] of Object.entries(managedSecrets)) {
    const normalized = normalizeStoredEncryptedValue(record);
    if (!normalized) {
      continue;
    }
    // 과거 버전이 앱 시크릿(auth:*, ai:*)을 이 맵에 저장했다 — sync 교체에 지워지지 않게 이전한다.
    if (!secretRef.startsWith('secret:')) {
      normalizedAppSecrets[secretRef] ??= normalized;
      continue;
    }
    normalizedManagedSecrets[secretRef] = normalized;
  }
  const normalizedManagedAwsProfiles: Record<string, StoredEncryptedValue> = {};
  for (const [profileId, record] of Object.entries(managedAwsProfiles)) {
    const normalized = normalizeStoredEncryptedValue(record);
    if (normalized) {
      normalizedManagedAwsProfiles[profileId] = normalized;
    }
  }
  const normalizedTailnetAuthKeys: Record<string, StoredEncryptedValue> = {};
  for (const [tailnetId, record] of Object.entries(tailnetAuthKeys)) {
    const normalized = normalizeStoredEncryptedValue(record);
    if (normalized) {
      normalizedTailnetAuthKeys[tailnetId] = normalized;
    }
  }

  return {
    schemaVersion: DESKTOP_STATE_SCHEMA_VERSION,
    settings: {
      theme: settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system',
      language: normalizeAppLanguage(settings.language),
      homeHostViewMode: normalizeHomeHostViewMode(settings.homeHostViewMode),
      sftpBrowserColumnWidths: normalizeSftpBrowserColumnWidths(
        isObject(settings.sftpBrowserColumnWidths) ? settings.sftpBrowserColumnWidths : null
      ),
      sftpConflictPolicy: normalizeSftpConflictPolicy(settings.sftpConflictPolicy),
      sftpPreserveMtime:
        typeof settings.sftpPreserveMtime === 'boolean' ? settings.sftpPreserveMtime : true,
      sftpPreservePermissions:
        typeof settings.sftpPreservePermissions === 'boolean' ? settings.sftpPreservePermissions : false,
      sessionReplayRetentionCount: normalizeSessionReplayRetentionCount(settings.sessionReplayRetentionCount),
      commandNotificationsEnabled:
        typeof settings.commandNotificationsEnabled === 'boolean'
          ? settings.commandNotificationsEnabled
          : DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationsEnabled,
      commandNotificationThresholdSeconds:
        typeof settings.commandNotificationThresholdSeconds === 'number'
          ? clampCommandNotificationThresholdSeconds(settings.commandNotificationThresholdSeconds)
          : DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationThresholdSeconds,
      commandNotificationOnlyWhenUnfocused:
        typeof settings.commandNotificationOnlyWhenUnfocused === 'boolean'
          ? settings.commandNotificationOnlyWhenUnfocused
          : DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationOnlyWhenUnfocused,
      commandNotificationOnFailure:
        typeof settings.commandNotificationOnFailure === 'boolean'
          ? settings.commandNotificationOnFailure
          : DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationOnFailure,
      commandNotificationSound:
        typeof settings.commandNotificationSound === 'boolean'
          ? settings.commandNotificationSound
          : DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationSound,
      hostMetricsEnabled:
        typeof settings.hostMetricsEnabled === 'boolean'
          ? settings.hostMetricsEnabled
          : DEFAULT_HOST_METRICS_SETTINGS.hostMetricsEnabled,
      autoReconnectEnabled:
        typeof settings.autoReconnectEnabled === 'boolean'
          ? settings.autoReconnectEnabled
          : DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectEnabled,
      autoReconnectMaxAttempts:
        typeof settings.autoReconnectMaxAttempts === 'number'
          ? clampAutoReconnectMaxAttempts(settings.autoReconnectMaxAttempts)
          : DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectMaxAttempts,
      autoReconnectBaseDelayMs:
        typeof settings.autoReconnectBaseDelayMs === 'number'
          ? clampAutoReconnectDelayMs(settings.autoReconnectBaseDelayMs)
          : DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectBaseDelayMs,
      autoReconnectMaxDelayMs:
        typeof settings.autoReconnectMaxDelayMs === 'number'
          ? clampAutoReconnectDelayMs(settings.autoReconnectMaxDelayMs)
          : DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectMaxDelayMs,
      tmuxPrefixKey:
        typeof settings.tmuxPrefixKey === 'string' && settings.tmuxPrefixKey.trim()
          ? settings.tmuxPrefixKey.trim()
          : 'C-b',
      // Absent in a stored state (upgrading users) → default ON, matching the
      // fresh-install behavior of re-establishing shell integration in subshells.
      subshellReinjectEnabled:
        typeof settings.subshellReinjectEnabled === 'boolean'
          ? settings.subshellReinjectEnabled
          : true,
      subshellReinjectPatterns: Array.isArray(settings.subshellReinjectPatterns)
        ? settings.subshellReinjectPatterns.filter(
            (pattern): pattern is string => typeof pattern === 'string',
          )
        : [],
      ai: normalizeAiSettings(settings.ai),
      serverUrlOverride: typeof settings.serverUrlOverride === 'string' && settings.serverUrlOverride.trim() ? settings.serverUrlOverride.trim() : null,
      tailnetHostname:
        typeof settings.tailnetHostname === 'string' && settings.tailnetHostname.trim()
          ? settings.tailnetHostname.trim()
          : null,
      rdpMonitorsByHostId: normalizeStoredRdpMonitorsByHost(settings.rdpMonitorsByHostId),
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
      // Absent in a stored state (existing users upgrading to the first version
      // with this feature) → default ON, matching the fresh-install default.
      autocompleteEnabled:
        typeof terminal.autocompleteEnabled === 'boolean'
          ? terminal.autocompleteEnabled
          : true,
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
    client: {
      installationId:
        typeof client.installationId === 'string' && client.installationId.trim() ? client.installationId.trim() : null,
      updatedAt: typeof client.updatedAt === 'string' ? client.updatedAt : fallback.client.updatedAt
    },
    sync: {
      lastSuccessfulSyncAt: typeof sync.lastSuccessfulSyncAt === 'string' ? sync.lastSuccessfulSyncAt : null,
      pendingPush: typeof sync.pendingPush === 'boolean' ? sync.pendingPush : false,
      errorMessage: typeof sync.errorMessage === 'string' ? sync.errorMessage : null,
      awsProfilesServerSupport:
        sync.awsProfilesServerSupport === 'supported' || sync.awsProfilesServerSupport === 'unsupported'
          ? sync.awsProfilesServerSupport
          : 'unknown',
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
      dnsOverrides: Array.isArray(data.dnsOverrides)
        ? data.dnsOverrides
            .map(normalizeDnsOverrideRecord)
            .filter((entry): entry is DnsOverrideRecord => entry !== null)
        : [],
      secretMetadata: Array.isArray(data.secretMetadata)
        ? data.secretMetadata
            .map(normalizeSecretMetadataRecord)
            .filter((entry): entry is SecretMetadataRecord => entry !== null)
        : [],
      snippets: Array.isArray(data.snippets) ? (data.snippets as SnippetRecord[]) : [],
      awsProfiles: Array.isArray(data.awsProfiles) ? (data.awsProfiles as AwsProfileMetadataRecord[]) : [],
      tailnets: Array.isArray(data.tailnets) ? (data.tailnets as TailnetRecord[]) : [],
      syncOutbox: Array.isArray(data.syncOutbox) ? (data.syncOutbox as SyncDeletionRecord[]) : []
    },
    secure: {
      refreshToken: normalizeStoredEncryptedValue(secure.refreshToken),
      appSecretsByAccount: normalizedAppSecrets,
      managedSecretsByRef: normalizedManagedSecrets,
      managedAwsProfilesById: normalizedManagedAwsProfiles,
      tailnetAuthKeysById: normalizedTailnetAuthKeys
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
    value.kind === 'session-lifecycle' ||
    value.kind === 'port-forward-lifecycle' ||
    value.kind === 'sftp-lifecycle' ||
    value.kind === 'container-lifecycle' ||
    value.kind === 'container-action' ||
    value.kind === 'generic'
      ? value.kind
      : 'generic';
  const metadata = isObject(value.metadata) ? value.metadata : null;
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : undefined;
  // 예전 기록에는 messageKey 가 없다 — 그때는 저장된 message 를 그대로 보여준다.
  const messageKey = typeof value.messageKey === 'string' ? value.messageKey : undefined;
  const messageParams = isObject(value.messageParams) ? value.messageParams : null;

  return {
    id: value.id,
    level,
    category,
    kind,
    message: value.message,
    messageKey,
    messageParams,
    metadata,
    createdAt: value.createdAt,
    updatedAt
  };
}

class DesktopStateStorage {
  private loaded = false;
  private state = createDefaultStateFile();
  private activityLogs: ActivityLogRecord[] = [];
  private activityLogScopeId: string | null = null;
  private activityLogFilePath: string | null = null;

  activateActivityLogScope(owner: LocalHistoryOwner): void {
    this.ensureLoaded();
    const scope = resolveLocalHistoryScope(owner);
    if (this.activityLogScopeId === scope.id) {
      return;
    }

    const scopedLogs = this.loadActivityLogs(scope.activityLogFilePath);
    const legacyLogs = this.loadActivityLogs(scope.legacyActivityLogFilePath);
    const mergedById = new Map<string, ActivityLogRecord>();
    for (const record of legacyLogs) {
      mergedById.set(record.id, record);
    }
    for (const record of scopedLogs) {
      mergedById.set(record.id, record);
    }

    this.activityLogScopeId = scope.id;
    this.activityLogFilePath = scope.activityLogFilePath;
    this.activityLogs = Array.from(mergedById.values())
      .sort(compareIsoDesc)
      .slice(0, MAX_ACTIVITY_LOGS);

    if (existsSync(scope.legacyActivityLogFilePath)) {
      this.rewriteLogsFile();
      rmSync(scope.legacyActivityLogFilePath, { force: true });
    }
  }

  deactivateActivityLogScope(): void {
    this.activityLogScopeId = null;
    this.activityLogFilePath = null;
    this.activityLogs = [];
  }

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
    if (!this.activityLogFilePath) {
      return deepClone(record);
    }
    this.activityLogs.unshift(record);
    mkdirSync(path.dirname(this.activityLogFilePath), { recursive: true });
    appendFileSync(this.activityLogFilePath, `${JSON.stringify(record)}\n`, 'utf8');
    if (this.activityLogs.length > MAX_ACTIVITY_LOGS) {
      this.activityLogs = this.activityLogs.slice(0, MAX_ACTIVITY_LOGS);
      this.rewriteLogsFile();
    }
    return record;
  }

  upsertActivityLog(record: ActivityLogRecord): ActivityLogRecord {
    this.ensureLoaded();
    if (!this.activityLogFilePath) {
      return deepClone(record);
    }
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
    if (!this.activityLogFilePath) {
      return;
    }
    this.activityLogs = [];
    this.rewriteLogsFile();
  }

  // 녹화 파일이 더 이상 없는(보존 한도로 prune된) 세션 로그의 hasReplay를 끈다.
  // 활동 로그는 녹화보다 훨씬 오래 보존돼서, 옛 로그가 이미 삭제된 녹화를 가리키면
  // Replay 버튼이 떠도 눌러지지 않는다 → 실제 존재하는 녹화만 hasReplay를 유지한다.
  reconcileReplayFlags(existingRecordingIds: ReadonlySet<string>): number {
    this.ensureLoaded();
    if (!this.activityLogFilePath) {
      return 0;
    }
    let changed = 0;
    for (let index = 0; index < this.activityLogs.length; index += 1) {
      const record = this.activityLogs[index];
      if (record.kind !== 'session-lifecycle') {
        continue;
      }
      const metadata = record.metadata as
        | { hasReplay?: boolean; recordingId?: string }
        | null;
      if (!metadata || metadata.hasReplay !== true) {
        continue;
      }
      const recordingId =
        typeof metadata.recordingId === 'string' ? metadata.recordingId : null;
      if (recordingId && existingRecordingIds.has(recordingId)) {
        continue;
      }
      this.activityLogs[index] = {
        ...record,
        metadata: { ...metadata, hasReplay: false },
      };
      changed += 1;
    }
    if (changed > 0) {
      this.rewriteLogsFile();
    }
    return changed;
  }

  // sync 스냅샷이 통째로 교체하는 맵은 managedSecretsByRef 뿐이므로,
  // sync 관리 시크릿(secret:*)만 거기에 두고 나머지 계정은 appSecretsByAccount 에 격리한다.
  readSecureValue(account: string): StoredEncryptedValue | null {
    this.ensureLoaded();
    if (account === 'auth:refresh-token') {
      return this.state.secure.refreshToken ? { ...this.state.secure.refreshToken } : null;
    }
    const record = account.startsWith('secret:')
      ? this.state.secure.managedSecretsByRef[account]
      : this.state.secure.appSecretsByAccount[account];
    return record ? { ...record } : null;
  }

  writeSecureValue(account: string, record: StoredEncryptedValue): void {
    this.updateState((draft) => {
      if (account === 'auth:refresh-token') {
        draft.secure.refreshToken = { ...record };
        draft.auth.updatedAt = nowIso();
        return;
      }
      if (account.startsWith('secret:')) {
        draft.secure.managedSecretsByRef[account] = { ...record };
        return;
      }
      draft.secure.appSecretsByAccount[account] = { ...record };
    });
  }

  deleteSecureValue(account: string): void {
    this.updateState((draft) => {
      if (account === 'auth:refresh-token') {
        draft.secure.refreshToken = null;
        draft.auth.updatedAt = nowIso();
        return;
      }
      if (account.startsWith('secret:')) {
        delete draft.secure.managedSecretsByRef[account];
        return;
      }
      delete draft.secure.appSecretsByAccount[account];
    });
  }

  readManagedAwsProfileValue(profileId: string): StoredEncryptedValue | null {
    this.ensureLoaded();
    const record = this.state.secure.managedAwsProfilesById[profileId];
    return record ? { ...record } : null;
  }

  writeManagedAwsProfileValue(profileId: string, record: StoredEncryptedValue): void {
    this.updateState((draft) => {
      draft.secure.managedAwsProfilesById[profileId] = { ...record };
    });
  }

  deleteManagedAwsProfileValue(profileId: string): void {
    this.updateState((draft) => {
      delete draft.secure.managedAwsProfilesById[profileId];
    });
  }

  updateAuthStatus(status: DesktopStateFile['auth']['status']): void {
    this.updateState((draft) => {
      draft.auth.status = status;
      draft.auth.updatedAt = nowIso();
    });
  }

  getClientInstallationId(): string | null {
    this.ensureLoaded();
    return this.state.client.installationId;
  }

  getOrCreateClientInstallationId(factory: () => string): string {
    this.ensureLoaded();
    if (this.state.client.installationId) {
      return this.state.client.installationId;
    }

    const installationId = factory().trim();
    if (!installationId) {
      throw new Error('client installation id must not be empty');
    }

    this.updateState((draft) => {
      draft.client.installationId = installationId;
      draft.client.updatedAt = nowIso();
    });
    return installationId;
  }

  updateSyncState(snapshot: {
    lastSuccessfulSyncAt?: string | null;
    pendingPush: boolean;
    errorMessage?: string | null;
    awsProfilesServerSupport?: 'unknown' | 'supported' | 'unsupported';
  }): void {
    this.updateState((draft) => {
      draft.sync.lastSuccessfulSyncAt =
        Object.prototype.hasOwnProperty.call(snapshot, 'lastSuccessfulSyncAt') ? snapshot.lastSuccessfulSyncAt ?? null : draft.sync.lastSuccessfulSyncAt;
      draft.sync.pendingPush = snapshot.pendingPush;
      draft.sync.errorMessage = snapshot.errorMessage ?? null;
      if (snapshot.awsProfilesServerSupport) {
        draft.sync.awsProfilesServerSupport = snapshot.awsProfilesServerSupport;
      }
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

  private loadActivityLogs(filePath: string): ActivityLogRecord[] {
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
    if (!this.activityLogFilePath) {
      return;
    }
    mkdirSync(path.dirname(this.activityLogFilePath), { recursive: true });
    const payload = this.activityLogs.map((entry) => JSON.stringify(entry)).join('\n');
    const tempPath = `${this.activityLogFilePath}.tmp`;
    const descriptor = openSync(tempPath, 'w');
    try {
      writeFileSync(descriptor, payload.length > 0 ? `${payload}\n` : '', 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(tempPath, this.activityLogFilePath);
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
