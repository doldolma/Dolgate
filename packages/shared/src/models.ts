export type AuthType = 'password' | 'privateKey';
export type AppTheme = 'system' | 'light' | 'dark';
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'upToDate' | 'error';
export type SftpPaneId = 'left' | 'right';
export type SftpEndpointKind = 'local' | 'remote';
export type FileEntryKind = 'folder' | 'file' | 'symlink' | 'unknown';
export type ConflictResolution = 'overwrite' | 'skip' | 'keepBoth';
export type PortForwardMode = 'local' | 'remote' | 'dynamic';
export type PortForwardStatus = 'stopped' | 'starting' | 'running' | 'error';
export type KnownHostTrustStatus = 'trusted' | 'untrusted' | 'mismatch';
export type ActivityLogLevel = 'info' | 'warn' | 'error';
export type ActivityLogCategory = 'ssh' | 'sftp' | 'forwarding' | 'known_hosts' | 'keychain';
export type SecretSource = 'local_keychain' | 'server_managed';

// HostRecord는 로컬 DB에서 읽어 renderer까지 올라오는 정규화된 호스트 모델이다.
export interface HostRecord {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  secretRef?: string | null;
  groupName?: string | null;
  createdAt: string;
  updatedAt: string;
}

// HostDraft는 생성/수정 폼에서 사용하는 입력 전용 모델이다.
export interface HostDraft {
  label: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  secretRef?: string | null;
  groupName?: string | null;
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

// AppSettings는 사용자의 로컬 환경 설정을 표현한다.
export interface AppSettings {
  theme: AppTheme;
  dismissedUpdateVersion?: string | null;
  updatedAt: string;
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
  hostId: string;
  hostLabel: string;
  hostname: string;
  username: string;
  secretRef: string;
  hasPassword: boolean;
  hasPassphrase: boolean;
  hasManagedPrivateKey: boolean;
  source: SecretSource;
  updatedAt: string;
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

export type TransferEndpointRef =
  | {
      kind: 'local';
      path: string;
    }
  | {
      kind: 'remote';
      endpointId: string;
      path: string;
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

// TransferJob은 SFTP 하단 전송 바가 그대로 표시하는 진행 상태 스냅샷이다.
export interface TransferJob {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  activeItemName?: string;
  itemCount: number;
  bytesTotal: number;
  bytesCompleted: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  errorMessage?: string;
  request?: TransferStartInput;
}

export interface TransferJobEvent {
  job: TransferJob;
}

// TerminalTab은 UI 탭과 SSH 세션 상태를 함께 추적하기 위한 뷰 모델이다.
export interface TerminalTab {
  id: string;
  title: string;
  hostId: string;
  sessionId: string;
  status: 'connecting' | 'connected' | 'disconnecting' | 'closed' | 'error';
  lastEventAt: string;
  errorMessage?: string;
}
