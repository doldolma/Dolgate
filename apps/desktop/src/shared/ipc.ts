import type {
  ActivityLogRecord,
  AppSettings,
  AwsSsmPortForwardTargetKind,
  AwsEc2InstanceSummary,
  AwsProfileStatus,
  AwsProfileSummary,
  AuthState,
  AuthType,
  KeyboardInteractiveChallenge,
  ManagedSecretPayload,
  OpenSshSnapshotFileInput,
  OpenSshImportResult,
  OpenSshImportSelectionInput,
  OpenSshProbeResult,
  XshellSnapshotFolderInput,
  XshellImportResult,
  XshellImportSelectionInput,
  XshellProbeResult,
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
  GroupRemoveMode,
  GroupRemoveResult,
  HostDraft,
  HostRecord,
  SecretMetadataRecord,
  SessionShareChatEvent,
  SessionShareControlSignal,
  SessionShareEvent,
  SessionShareInputToggleInput,
  SessionShareOwnerChatSnapshot,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  SessionShareState,
  SftpEndpointSummary,
  SyncStatus,
  TerminalTab,
  TermiusImportResult,
  TermiusImportSelectionInput,
  TermiusProbeResult,
  TransferJob,
  TransferJobEvent,
  TransferStartInput,
  DesktopWindowState,
  UpdateEvent,
  UpdateState,
  WarpgateConnectionInfo,
  WarpgateTargetSummary,
} from "./models";
import type { SyncPayloadV2 } from "./api";

// Electron main과 Go SSH 코어가 주고받는 명령/이벤트의 집합이다.
export type CoreCommandType =
  | "health"
  | "connect"
  | "awsConnect"
  | "localConnect"
  | "controlSignal"
  | "resize"
  | "disconnect"
  | "probeHostKey"
  | "keyboardInteractiveRespond"
  | "portForwardStart"
  | "ssmPortForwardStart"
  | "portForwardStop"
  | "ssmPortForwardStop"
  | "sftpConnect"
  | "sftpDisconnect"
  | "sftpList"
  | "sftpMkdir"
  | "sftpRename"
  | "sftpChmod"
  | "sftpDelete"
  | "sftpTransferStart"
  | "sftpTransferCancel";
export type CoreEventType =
  | "status"
  | "connected"
  | "data"
  | "error"
  | "closed"
  | "hostKeyProbed"
  | "keyboardInteractiveChallenge"
  | "keyboardInteractiveResolved"
  | "portForwardStarted"
  | "portForwardStopped"
  | "portForwardError"
  | "sftpConnected"
  | "sftpDisconnected"
  | "sftpListed"
  | "sftpAck"
  | "sftpError"
  | "sftpTransferProgress"
  | "sftpTransferCompleted"
  | "sftpTransferFailed"
  | "sftpTransferCancelled";
export type CoreStreamType = "write" | "data";

// renderer는 hostId만 넘기고, 실제 비밀값 해석은 main 프로세스가 담당한다.
export interface DesktopConnectInput {
  hostId: string;
  cols: number;
  rows: number;
  title?: string;
  secrets?: HostSecretInput;
}

export interface DesktopLocalConnectInput {
  cols: number;
  rows: number;
  title?: string;
}

export interface DesktopSftpConnectInput {
  hostId: string;
  endpointId: string;
  secrets?: HostSecretInput;
}

// main 프로세스가 키체인과 DB를 합쳐 최종적으로 Go 코어에 보내는 payload다.
export interface ResolvedCoreConnectPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPem?: string;
  privateKeyPath?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  cols: number;
  rows: number;
}

export interface ResolvedAwsConnectPayload {
  profileName: string;
  region: string;
  instanceId: string;
  cols: number;
  rows: number;
}

export interface ResolvedLocalConnectPayload {
  cols: number;
  rows: number;
  title?: string;
}

export interface KeyboardInteractiveRespondInput {
  sessionId?: string;
  endpointId?: string;
  challengeId: string;
  responses: string[];
}

export interface ControlSignalPayload {
  signal: SessionShareControlSignal;
}

export interface ResolvedSftpConnectPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPem?: string;
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
  privateKeyPem?: string;
  privateKeyPath?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
}

export interface ResolvedSsmPortForwardStartPayload {
  profileName: string;
  region: string;
  instanceId: string;
  bindAddress: string;
  bindPort: number;
  targetKind: AwsSsmPortForwardTargetKind;
  targetPort: number;
  remoteHost?: string;
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

export interface SftpChmodInput {
  endpointId: string;
  path: string;
  mode: number;
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
  privateKeyPem?: string;
}

export interface KeychainSecretUpdateInput {
  secretRef: string;
  secrets: HostSecretInput;
}

export interface KeychainSecretCloneInput {
  hostId: string;
  sourceSecretRef: string;
  secrets: HostSecretInput;
}

export interface AuthCallbackPayload {
  code: string;
  state?: string | null;
}

// preload가 renderer에 노출하는 공개 API 표면이다.
export interface DesktopApi {
  auth: {
    getState: () => Promise<AuthState>;
    bootstrap: () => Promise<AuthState>;
    retryOnline: () => Promise<AuthState>;
    beginBrowserLogin: () => Promise<void>;
    logout: () => Promise<void>;
    onEvent: (listener: (state: AuthState) => void) => () => void;
  };
  sync: {
    bootstrap: () => Promise<SyncStatus>;
    pushDirty: () => Promise<SyncStatus>;
    status: () => Promise<SyncStatus>;
    exportDecryptedSnapshot: () => Promise<SyncPayloadV2>;
  };
  hosts: {
    list: () => Promise<HostRecord[]>;
    create: (
      draft: HostDraft,
      secrets?: HostSecretInput,
    ) => Promise<HostRecord>;
    update: (
      id: string,
      draft: HostDraft,
      secrets?: HostSecretInput,
    ) => Promise<HostRecord>;
    remove: (id: string) => Promise<void>;
  };
  groups: {
    list: () => Promise<GroupRecord[]>;
    create: (name: string, parentPath?: string | null) => Promise<GroupRecord>;
    remove: (path: string, mode: GroupRemoveMode) => Promise<GroupRemoveResult>;
  };
  aws: {
    listProfiles: () => Promise<AwsProfileSummary[]>;
    getProfileStatus: (profileName: string) => Promise<AwsProfileStatus>;
    login: (profileName: string) => Promise<void>;
    listRegions: (profileName: string) => Promise<string[]>;
    listEc2Instances: (
      profileName: string,
      region: string,
    ) => Promise<AwsEc2InstanceSummary[]>;
  };
  warpgate: {
    testConnection: (
      baseUrl: string,
      token: string,
    ) => Promise<WarpgateConnectionInfo>;
    getConnectionInfo: (
      baseUrl: string,
      token: string,
    ) => Promise<WarpgateConnectionInfo>;
    listSshTargets: (
      baseUrl: string,
      token: string,
    ) => Promise<WarpgateTargetSummary[]>;
  };
  termius: {
    probeLocal: () => Promise<TermiusProbeResult>;
    importSelection: (
      input: TermiusImportSelectionInput,
    ) => Promise<TermiusImportResult>;
    discardSnapshot: (snapshotId: string) => Promise<void>;
  };
  openssh: {
    probeDefault: () => Promise<OpenSshProbeResult>;
    addFileToSnapshot: (
      input: OpenSshSnapshotFileInput,
    ) => Promise<OpenSshProbeResult>;
    importSelection: (
      input: OpenSshImportSelectionInput,
    ) => Promise<OpenSshImportResult>;
    discardSnapshot: (snapshotId: string) => Promise<void>;
  };
  xshell: {
    probeDefault: () => Promise<XshellProbeResult>;
    addFolderToSnapshot: (
      input: XshellSnapshotFolderInput,
    ) => Promise<XshellProbeResult>;
    importSelection: (
      input: XshellImportSelectionInput,
    ) => Promise<XshellImportResult>;
    discardSnapshot: (snapshotId: string) => Promise<void>;
  };
  ssh: {
    connect: (input: DesktopConnectInput) => Promise<{ sessionId: string }>;
    connectLocal: (
      input: DesktopLocalConnectInput,
    ) => Promise<{ sessionId: string }>;
    write: (sessionId: string, data: string) => Promise<void>;
    writeBinary: (sessionId: string, data: Uint8Array) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    disconnect: (sessionId: string) => Promise<void>;
    respondKeyboardInteractive: (
      input: KeyboardInteractiveRespondInput,
    ) => Promise<void>;
    onEvent: (listener: (event: CoreEvent) => void) => () => void;
    onData: (
      sessionId: string,
      listener: (chunk: Uint8Array) => void,
    ) => () => void;
  };
  sessionShares: {
    start: (input: SessionShareStartInput) => Promise<SessionShareState>;
    updateSnapshot: (input: SessionShareSnapshotInput) => Promise<void>;
    setInputEnabled: (
      input: SessionShareInputToggleInput,
    ) => Promise<SessionShareState>;
    stop: (sessionId: string) => Promise<void>;
    openOwnerChatWindow: (sessionId: string) => Promise<void>;
    getOwnerChatSnapshot: (
      sessionId: string,
    ) => Promise<SessionShareOwnerChatSnapshot>;
    onEvent: (listener: (event: SessionShareEvent) => void) => () => void;
    onChatEvent: (listener: (event: SessionShareChatEvent) => void) => () => void;
  };
  shell: {
    pickPrivateKey: () => Promise<string | null>;
    pickOpenSshConfig: () => Promise<string | null>;
    pickXshellSessionFolder: () => Promise<string | null>;
    openExternal: (url: string) => Promise<void>;
  };
  window: {
    getState: () => Promise<DesktopWindowState>;
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    restore: () => Promise<void>;
    close: () => Promise<void>;
    onStateChanged: (
      listener: (state: DesktopWindowState) => void,
    ) => () => void;
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
    update: (
      id: string,
      draft: PortForwardDraft,
    ) => Promise<PortForwardRuleRecord>;
    remove: (id: string) => Promise<void>;
    start: (ruleId: string) => Promise<PortForwardRuntimeRecord>;
    stop: (ruleId: string) => Promise<PortForwardRuntimeRecord>;
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
    load: (
      secretRef: string,
    ) => Promise<ManagedSecretPayload | HostSecretInput | null>;
    remove: (secretRef: string) => Promise<void>;
    update: (input: KeychainSecretUpdateInput) => Promise<void>;
    cloneForHost: (input: KeychainSecretCloneInput) => Promise<void>;
  };
  sftp: {
    connect: (input: DesktopSftpConnectInput) => Promise<SftpEndpointSummary>;
    disconnect: (endpointId: string) => Promise<void>;
    list: (input: SftpListInput) => Promise<DirectoryListing>;
    mkdir: (input: SftpMkdirInput) => Promise<void>;
    rename: (input: SftpRenameInput) => Promise<void>;
    chmod: (input: SftpChmodInput) => Promise<void>;
    delete: (input: SftpDeleteInput) => Promise<void>;
    startTransfer: (input: TransferStartInput) => Promise<TransferJob>;
    cancelTransfer: (jobId: string) => Promise<void>;
    onTransferEvent: (
      listener: (event: TransferJobEvent) => void,
    ) => () => void;
  };
  files: {
    getHomeDirectory: () => Promise<string>;
    getDownloadsDirectory: () => Promise<string>;
    getParentPath: (targetPath: string) => Promise<string>;
    list: (path: string) => Promise<DirectoryListing>;
    mkdir: (path: string, name: string) => Promise<void>;
    rename: (path: string, nextName: string) => Promise<void>;
    chmod: (path: string, mode: number) => Promise<void>;
    delete: (paths: string[]) => Promise<void>;
  };
}
