import type { AuthSession } from './api';

export type AuthType = 'password' | 'privateKey' | 'keyboardInteractive';
export type HostKind = 'ssh' | 'aws-ec2' | 'warpgate-ssh';
export type AppTheme = 'system' | 'light' | 'dark';
export type TerminalThemeId =
  | 'dolssh-dark'
  | 'dolssh-light'
  | 'kanagawa-wave'
  | 'kanagawa-dragon'
  | 'kanagawa-lotus'
  | 'everforest-dark'
  | 'everforest-light'
  | 'night-owl'
  | 'light-owl'
  | 'rose-pine'
  | 'hacker-green'
  | 'hacker-blue'
  | 'hacker-red';
export type TerminalFontFamilyId =
  | 'sf-mono'
  | 'menlo'
  | 'monaco'
  | 'consolas'
  | 'cascadia-mono'
  | 'jetbrains-mono'
  | 'fira-code'
  | 'ibm-plex-mono'
  | 'source-code-pro';
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'upToDate' | 'error';
export type SftpPaneId = 'left' | 'right';
export type SftpEndpointKind = 'local' | 'remote';
export type FileEntryKind = 'folder' | 'file' | 'symlink' | 'unknown';
export type ConflictResolution = 'overwrite' | 'skip' | 'keepBoth';
export type PortForwardMode = 'local' | 'remote' | 'dynamic';
export type PortForwardStatus = 'stopped' | 'starting' | 'running' | 'error';
export type KnownHostTrustStatus = 'trusted' | 'untrusted' | 'mismatch';
export type ActivityLogLevel = 'info' | 'warn' | 'error';
export type ActivityLogCategory = 'session' | 'audit';
export type SecretSource = 'local_keychain' | 'server_managed';
export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticating' | 'authenticated' | 'error';
export type SyncBootstrapStatus = 'idle' | 'syncing' | 'ready' | 'error';

interface HostBaseRecord {
  id: string;
  kind: HostKind;
  label: string;
  groupName?: string | null;
  tags?: string[];
  terminalThemeId?: TerminalThemeId | null;
  createdAt: string;
  updatedAt: string;
}

interface HostBaseDraft {
  kind: HostKind;
  label: string;
  groupName?: string | null;
  tags?: string[];
  terminalThemeId?: TerminalThemeId | null;
}

export interface SshHostRecord extends HostBaseRecord {
  kind: 'ssh';
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  secretRef?: string | null;
}

export interface SshHostDraft extends HostBaseDraft {
  kind: 'ssh';
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  secretRef?: string | null;
}

export interface AwsEc2HostRecord extends HostBaseRecord {
  kind: 'aws-ec2';
  awsProfileName: string;
  awsRegion: string;
  awsInstanceId: string;
  awsInstanceName?: string | null;
  awsPlatform?: string | null;
  awsPrivateIp?: string | null;
  awsState?: string | null;
}

export interface AwsEc2HostDraft extends HostBaseDraft {
  kind: 'aws-ec2';
  awsProfileName: string;
  awsRegion: string;
  awsInstanceId: string;
  awsInstanceName?: string | null;
  awsPlatform?: string | null;
  awsPrivateIp?: string | null;
  awsState?: string | null;
}

export interface WarpgateSshHostRecord extends HostBaseRecord {
  kind: 'warpgate-ssh';
  warpgateBaseUrl: string;
  warpgateSshHost: string;
  warpgateSshPort: number;
  warpgateTargetId: string;
  warpgateTargetName: string;
  warpgateUsername: string;
}

export interface WarpgateSshHostDraft extends HostBaseDraft {
  kind: 'warpgate-ssh';
  warpgateBaseUrl: string;
  warpgateSshHost: string;
  warpgateSshPort: number;
  warpgateTargetId: string;
  warpgateTargetName: string;
  warpgateUsername: string;
}

// HostRecord는 로컬 스토리지와 sync payload가 공유하는 정규화된 호스트 모델이다.
export type HostRecord = SshHostRecord | AwsEc2HostRecord | WarpgateSshHostRecord;

// HostDraft는 생성/수정 폼에서 사용하는 입력 전용 모델이다.
export type HostDraft = SshHostDraft | AwsEc2HostDraft | WarpgateSshHostDraft;

export function isSshHostRecord(host: HostRecord): host is SshHostRecord {
  return host.kind === 'ssh';
}

export function isAwsEc2HostRecord(host: HostRecord): host is AwsEc2HostRecord {
  return host.kind === 'aws-ec2';
}

export function isWarpgateSshHostRecord(host: HostRecord): host is WarpgateSshHostRecord {
  return host.kind === 'warpgate-ssh';
}

export function isSshHostDraft(host: HostDraft): host is SshHostDraft {
  return host.kind === 'ssh';
}

export function isAwsEc2HostDraft(host: HostDraft): host is AwsEc2HostDraft {
  return host.kind === 'aws-ec2';
}

export function isWarpgateSshHostDraft(host: HostDraft): host is WarpgateSshHostDraft {
  return host.kind === 'warpgate-ssh';
}

export function getHostSearchText(host: HostRecord): string[] {
  if (host.kind === 'aws-ec2') {
    return [
      host.label,
      host.awsInstanceName ?? '',
      host.awsInstanceId,
      host.awsRegion,
      host.awsProfileName,
      host.awsPrivateIp ?? '',
      host.groupName ?? '',
      ...(host.tags ?? [])
    ];
  }
  if (host.kind === 'warpgate-ssh') {
    return [
      host.label,
      host.warpgateTargetName,
      host.warpgateTargetId,
      host.warpgateUsername,
      host.warpgateBaseUrl,
      host.groupName ?? '',
      ...(host.tags ?? [])
    ];
  }
  return [host.label, host.hostname, host.username, host.groupName ?? '', ...(host.tags ?? [])];
}

export function getHostSubtitle(host: HostRecord): string {
  if (host.kind === 'aws-ec2') {
    const parts = ['AWS', host.awsRegion, host.awsPrivateIp || host.awsInstanceId].filter(Boolean);
    return parts.join(' • ');
  }
  if (host.kind === 'warpgate-ssh') {
    const target = host.warpgateTargetName || host.warpgateTargetId;
    return ['Warpgate', host.warpgateUsername, target].filter(Boolean).join(' • ');
  }
  return `${host.username}@${host.hostname}:${host.port}`;
}

export function getHostBadgeLabel(host: HostRecord): string {
  if (host.kind === 'aws-ec2') {
    return 'AWS';
  }
  if (host.kind === 'warpgate-ssh') {
    return 'WARPGATE';
  }
  return host.authType === 'privateKey' ? 'K' : 'S';
}

export function getHostSecretRef(host: HostRecord): string | null {
  return host.kind === 'ssh' ? (host.secretRef ?? null) : null;
}

// GroupRecord는 홈 화면의 그룹 브라우징이 쓰는 계층형 그룹 메타데이터다.
export interface GroupRecord {
  id: string;
  name: string;
  path: string;
  parentPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GroupRemoveMode = 'delete-subtree' | 'reparent-descendants';

export interface GroupRemoveResult {
  groups: GroupRecord[];
  hosts: HostRecord[];
}

export interface TerminalAppearanceSettings {
  globalTerminalThemeId: TerminalThemeId;
  terminalFontFamily: TerminalFontFamilyId;
  terminalFontSize: number;
}

// AppSettings는 사용자의 로컬 환경 설정을 표현한다.
export interface AppSettings extends TerminalAppearanceSettings {
  theme: AppTheme;
  serverUrl: string;
  serverUrlOverride?: string | null;
  dismissedUpdateVersion?: string | null;
  updatedAt: string;
}

export interface TerminalPreferencesRecord {
  id: 'global-terminal';
  globalTerminalThemeId: TerminalThemeId;
  updatedAt: string;
}

// AuthState는 desktop 로그인 게이트와 세션 복구가 읽는 최소 상태다.
export interface AuthState {
  status: AuthStatus;
  session?: AuthSession | null;
  errorMessage?: string | null;
}

// SyncStatus는 초기 hydrate와 이후 push 재시도를 UI/서비스가 추적하기 위한 상태다.
export interface SyncStatus {
  status: SyncBootstrapStatus;
  lastSuccessfulSyncAt?: string | null;
  pendingPush: boolean;
  errorMessage?: string | null;
}

// UpdateReleaseInfo는 GitHub Releases에서 읽어온 배포 메타데이터를 정규화한 형태다.
export interface UpdateReleaseInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

// UpdateProgressInfo는 다운로드 진행률을 UI가 그대로 렌더링하기 위한 뷰 모델이다.
export interface UpdateProgressInfo {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

// UpdateState는 메인 프로세스 auto updater의 현재 상태 스냅샷이다.
export interface UpdateState {
  enabled: boolean;
  status: UpdateStatus;
  currentVersion: string;
  release?: UpdateReleaseInfo | null;
  progress?: UpdateProgressInfo | null;
  checkedAt?: string | null;
  dismissedVersion?: string | null;
  errorMessage?: string | null;
}

export interface UpdateEvent {
  state: UpdateState;
}

export interface DesktopWindowState {
  isMaximized: boolean;
}

export interface TerminalThemePreset {
  id: TerminalThemeId;
  title: string;
}

export interface AwsProfileSummary {
  name: string;
}

export interface AwsProfileStatus {
  profileName: string;
  available: boolean;
  isSsoProfile: boolean;
  isAuthenticated: boolean;
  accountId?: string | null;
  arn?: string | null;
  errorMessage?: string | null;
  missingTools?: string[];
}

export interface AwsEc2InstanceSummary {
  instanceId: string;
  name: string;
  platform?: string | null;
  privateIp?: string | null;
  state?: string | null;
}

export interface WarpgateTargetSummary {
  id: string;
  name: string;
  kind: 'ssh';
}

export interface WarpgateConnectionInfo {
  baseUrl: string;
  sshHost: string;
  sshPort: number;
  username?: string | null;
}

export interface KeyboardInteractivePrompt {
  label: string;
  echo: boolean;
}

export interface KeyboardInteractiveChallenge {
  sessionId: string;
  challengeId: string;
  attempt: number;
  name?: string | null;
  instruction: string;
  prompts: KeyboardInteractivePrompt[];
}

// PortForwardRuleRecord는 사용자가 저장한 포워딩 규칙 자체를 표현한다.
export interface PortForwardRuleRecord {
  id: string;
  label: string;
  hostId: string;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetHost?: string | null;
  targetPort?: number | null;
  createdAt: string;
  updatedAt: string;
}

// PortForwardDraft는 생성/수정 폼에서 사용하는 입력 전용 모델이다.
export interface PortForwardDraft {
  label: string;
  hostId: string;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetHost?: string | null;
  targetPort?: number | null;
}

// PortForwardRuntimeRecord는 현재 메모리에서 살아 있는 실행 상태 스냅샷이다.
export interface PortForwardRuntimeRecord {
  ruleId: string;
  hostId: string;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  status: PortForwardStatus;
  message?: string;
  updatedAt: string;
  startedAt?: string;
}

export interface PortForwardRuntimeEvent {
  runtime: PortForwardRuntimeRecord;
}

export interface PortForwardListSnapshot {
  rules: PortForwardRuleRecord[];
  runtimes: PortForwardRuntimeRecord[];
}

// KnownHostRecord는 신뢰된 호스트 키 한 건을 나타낸다.
export interface KnownHostRecord {
  id: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
  createdAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

// HostKeyProbeResult는 연결 전 서버에서 읽어온 실제 호스트 키와 저장된 신뢰 레코드 비교 결과다.
export interface HostKeyProbeResult {
  hostId: string;
  hostLabel: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
  status: KnownHostTrustStatus;
  existing?: KnownHostRecord | null;
}

// KnownHostTrustInput은 probe 결과에서 저장에 필요한 필드만 추려낸 형태다.
export interface KnownHostTrustInput {
  hostId: string;
  hostLabel: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
}

// ActivityLogRecord는 앱 활동 로그 화면이 그대로 렌더링하는 구조다.
export interface ActivityLogRecord {
  id: string;
  level: ActivityLogLevel;
  category: ActivityLogCategory;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// SecretMetadataRecord는 원문 secret 없이 저장 위치와 존재 여부만 표현한다.
export interface SecretMetadataRecord {
  secretRef: string;
  label: string;
  hasPassword: boolean;
  hasPassphrase: boolean;
  hasManagedPrivateKey: boolean;
  source: SecretSource;
  linkedHostCount: number;
  updatedAt: string;
}

// ManagedSecretPayload는 서버 sync와 로컬 keychain이 공유하는 실제 secret 본문이다.
// privateKeyPem은 새 기기에서도 바로 SSH 접속이 가능하도록 PEM 전체를 저장한다.
export interface ManagedSecretPayload {
  secretRef: string;
  label: string;
  password?: string;
  passphrase?: string;
  privateKeyPem?: string;
  source: SecretSource;
  updatedAt: string;
}

export interface LinkedHostSummary {
  id: string;
  label: string;
  hostname: string;
  username: string;
}

// FileEntry는 local/remote 파일 브라우저가 공통으로 쓰는 단일 파일 메타데이터 모델이다.
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  kind: FileEntryKind;
  permissions?: string;
}

// DirectoryListing은 특정 경로의 목록 응답을 표현한다.
export interface DirectoryListing {
  path: string;
  entries: FileEntry[];
  warnings?: string[];
}

// SftpEndpointSummary는 현재 패널이 붙어 있는 remote endpoint 정보를 표현한다.
export interface SftpEndpointSummary {
  id: string;
  kind: 'remote';
  hostId: string;
  title: string;
  path: string;
  connectedAt: string;
}

export interface SftpHostSelectionState {
  query: string;
  selectedHostId?: string | null;
}

export interface SftpPaneState {
  id: SftpPaneId;
  sourceKind: SftpEndpointKind;
  currentPath: string;
  listing?: DirectoryListing | null;
  endpoint?: SftpEndpointSummary | null;
  isLoading: boolean;
  filterQuery: string;
  history: string[];
  historyIndex: number;
  selectedPaths: string[];
  hostSelection: SftpHostSelectionState;
  errorMessage?: string | null;
}

export interface TransferJob {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  itemCount: number;
  bytesTotal: number;
  bytesCompleted: number;
  speedBytesPerSecond?: number | null;
  etaSeconds?: number | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  activeItemName?: string | null;
  errorMessage?: string | null;
  updatedAt: string;
  request?: TransferStartInput;
}

export interface TransferJobEvent {
  job: TransferJob;
}

export type TransferEndpointRef =
  | {
      kind: 'local';
      path: string;
    }
  | {
      kind: 'remote';
      path: string;
      endpointId: string;
    };

export interface TransferItemInput {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface TransferStartInput {
  source: TransferEndpointRef;
  target: TransferEndpointRef;
  items: TransferItemInput[];
  conflictResolution: ConflictResolution;
}

export interface TerminalTab {
  id: string;
  sessionId: string;
  hostId: string;
  title: string;
  status: 'connecting' | 'connected' | 'disconnecting' | 'closed' | 'error';
  errorMessage?: string;
  lastEventAt: string;
}
