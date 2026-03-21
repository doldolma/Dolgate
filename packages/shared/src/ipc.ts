import type {
  ActivityLogRecord,
  AppSettings,
  AuthType,
  HostKeyProbeResult,
  KnownHostRecord,
  KnownHostTrustInput,
  PortForwardDraft,
  PortForwardListSnapshot,
  PortForwardMode,
  PortForwardRuleRecord,
  PortForwardRuntimeEvent,
  PortForwardRuntimeRecord,
  DirectoryListing,
  GroupRecord,
  HostDraft,
  HostRecord,
  SecretMetadataRecord,
  SftpEndpointSummary,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput,
  UpdateEvent,
  UpdateState
} from './models';

// Electron main과 Go SSH 코어가 주고받는 명령/이벤트의 집합이다.
export type CoreCommandType =
  | 'health'
  | 'connect'
  | 'resize'
  | 'disconnect'
  | 'probeHostKey'
  | 'portForwardStart'
  | 'portForwardStop'
  | 'sftpConnect'
  | 'sftpDisconnect'
  | 'sftpList'
  | 'sftpMkdir'
  | 'sftpRename'
  | 'sftpDelete'
  | 'sftpTransferStart'
  | 'sftpTransferCancel';
export type CoreEventType =
  | 'status'
  | 'connected'
  | 'data'
  | 'error'
  | 'closed'
  | 'hostKeyProbed'
  | 'portForwardStarted'
  | 'portForwardStopped'
  | 'portForwardError'
  | 'sftpConnected'
  | 'sftpDisconnected'
  | 'sftpListed'
  | 'sftpAck'
  | 'sftpError'
  | 'sftpTransferProgress'
  | 'sftpTransferCompleted'
  | 'sftpTransferFailed'
  | 'sftpTransferCancelled';
export type CoreStreamType = 'write' | 'data';

// renderer는 hostId만 넘기고, 실제 비밀값 해석은 main 프로세스가 담당한다.
export interface DesktopConnectInput {
  hostId: string;
  cols: number;
  rows: number;
}

export interface DesktopSftpConnectInput {
  hostId: string;
}

// main 프로세스가 키체인과 DB를 합쳐 최종적으로 Go 코어에 보내는 payload다.
export interface ResolvedCoreConnectPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  cols: number;
  rows: number;
}

export interface ResolvedSftpConnectPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
}

export interface ResolvedHostKeyProbePayload {
  host: string;
  port: number;
}

export interface ResolvedPortForwardStartPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
}

export interface SftpListInput {
  endpointId: string;
  path: string;
}

export interface SftpMkdirInput {
  endpointId: string;
  path: string;
  name: string;
}

export interface SftpRenameInput {
  endpointId: string;
  path: string;
  nextName: string;
}

export interface SftpDeleteInput {
  endpointId: string;
  paths: string[];
}

export interface KnownHostProbeInput {
  hostId: string;
}

// 모든 stdio 요청은 동일한 envelope 구조를 사용한다.
export interface CoreRequest<TPayload = Record<string, unknown>> {
  id: string;
  type: CoreCommandType;
  sessionId?: string;
  endpointId?: string;
  jobId?: string;
  payload: TPayload;
}

// 모든 stdio 이벤트도 동일한 envelope 구조를 사용한다.
export interface CoreEvent<TPayload = Record<string, unknown>> {
  type: CoreEventType;
  requestId?: string;
  sessionId?: string;
  endpointId?: string;
  jobId?: string;
  payload: TPayload;
}

// control 메시지와 별도로 터미널 스트림용 binary frame 메타데이터를 둔다.
export interface CoreStreamFrame {
  type: CoreStreamType;
  sessionId: string;
  requestId?: string;
}

// 비밀번호와 passphrase는 DB가 아니라 키체인에 저장되는 비밀 입력이다.
export interface HostSecretInput {
  password?: string;
  passphrase?: string;
}

// preload가 renderer에 노출하는 공개 API 표면이다.
export interface DesktopApi {
  hosts: {
    list: () => Promise<HostRecord[]>;
    create: (draft: HostDraft, secrets?: HostSecretInput) => Promise<HostRecord>;
    update: (id: string, draft: HostDraft, secrets?: HostSecretInput) => Promise<HostRecord>;
    remove: (id: string) => Promise<void>;
  };
  groups: {
    list: () => Promise<GroupRecord[]>;
    create: (name: string, parentPath?: string | null) => Promise<GroupRecord>;
  };
  ssh: {
    connect: (input: DesktopConnectInput) => Promise<{ sessionId: string }>;
    write: (sessionId: string, data: string) => Promise<void>;
    writeBinary: (sessionId: string, data: Uint8Array) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    disconnect: (sessionId: string) => Promise<void>;
    onEvent: (listener: (event: CoreEvent) => void) => () => void;
    onData: (sessionId: string, listener: (chunk: Uint8Array) => void) => () => void;
  };
  shell: {
    pickPrivateKey: () => Promise<string | null>;
    openExternal: (url: string) => Promise<void>;
  };
  tabs: {
    list: () => Promise<TerminalTab[]>;
  };
  updater: {
    getState: () => Promise<UpdateState>;
    check: () => Promise<void>;
    download: () => Promise<void>;
    installAndRestart: () => Promise<void>;
    dismissAvailable: (version: string) => Promise<void>;
    onEvent: (listener: (event: UpdateEvent) => void) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (input: Partial<AppSettings>) => Promise<AppSettings>;
  };
  portForwards: {
    list: () => Promise<PortForwardListSnapshot>;
    create: (draft: PortForwardDraft) => Promise<PortForwardRuleRecord>;
    update: (id: string, draft: PortForwardDraft) => Promise<PortForwardRuleRecord>;
    remove: (id: string) => Promise<void>;
    start: (ruleId: string) => Promise<PortForwardRuntimeRecord>;
    stop: (ruleId: string) => Promise<void>;
    onEvent: (listener: (event: PortForwardRuntimeEvent) => void) => () => void;
  };
  knownHosts: {
    list: () => Promise<KnownHostRecord[]>;
    probeHost: (input: KnownHostProbeInput) => Promise<HostKeyProbeResult>;
    trust: (input: KnownHostTrustInput) => Promise<KnownHostRecord>;
    replace: (input: KnownHostTrustInput) => Promise<KnownHostRecord>;
    remove: (id: string) => Promise<void>;
  };
  logs: {
    list: () => Promise<ActivityLogRecord[]>;
    clear: () => Promise<void>;
  };
  keychain: {
    list: () => Promise<SecretMetadataRecord[]>;
    removeForHost: (hostId: string) => Promise<void>;
  };
  files: {
    getHomeDirectory: () => Promise<string>;
    list: (path: string) => Promise<DirectoryListing>;
    mkdir: (path: string, name: string) => Promise<void>;
    rename: (path: string, nextName: string) => Promise<void>;
    delete: (paths: string[]) => Promise<void>;
  };
  sftp: {
    connect: (input: DesktopSftpConnectInput) => Promise<SftpEndpointSummary>;
    disconnect: (endpointId: string) => Promise<void>;
    list: (input: SftpListInput) => Promise<DirectoryListing>;
    mkdir: (input: SftpMkdirInput) => Promise<void>;
    rename: (input: SftpRenameInput) => Promise<void>;
    delete: (input: SftpDeleteInput) => Promise<void>;
    startTransfer: (input: TransferStartInput) => Promise<TransferJob>;
    cancelTransfer: (jobId: string) => Promise<void>;
    onTransferEvent: (listener: (event: TransferJobEvent) => void) => () => void;
  };
}
