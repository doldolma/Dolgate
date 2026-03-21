export type AuthType = 'password' | 'privateKey';
export type AppTheme = 'system' | 'light' | 'dark';
export type SftpPaneId = 'left' | 'right';
export type SftpEndpointKind = 'local' | 'remote';
export type FileEntryKind = 'folder' | 'file' | 'symlink' | 'unknown';
export type ConflictResolution = 'overwrite' | 'skip' | 'keepBoth';

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
