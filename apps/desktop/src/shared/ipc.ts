import type {
  ActivityLogRecord,
  AppSettings,
  DnsOverrideDraft,
  DnsOverrideResolvedRecord,
  SnippetRecord,
  SnippetDraft,
  AwsSsmPortForwardTargetKind,
  AwsEc2InstanceSummary,
  AwsEcsClusterListItem,
  AwsEcsClusterSnapshot,
  AwsEcsTaskTunnelServiceDetails,
  AwsEcsTaskTunnelServiceSummary,
  AwsEcsClusterUtilizationSnapshot,
  AwsEcsServiceActionContext,
  AwsEcsServiceLogsSnapshot,
  AwsHostSshInspectionInput,
  AwsHostSshInspectionResult,
  AwsProfileCreateInput,
  AwsProfileDetails,
  AwsExternalProfileImportInput,
  AwsExternalProfileImportResult,
  AwsProfileRenameInput,
  AwsProfileRegionUpdateInput,
  AwsSsoProfilePrepareInput,
  AwsSsoProfilePrepareResult,
  AwsProfileStatus,
  AwsProfileSummary,
  AwsProfileUpdateInput,
  AuthState,
  AuthType,
  DesktopBootstrapSnapshot,
  DesktopSyncedWorkspaceSnapshot,
  KeyboardInteractiveChallenge,
  LoadedManagedSecretPayload,
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
  ResolvedAwsConnectPayload,
  SessionReplayRecording,
  DirectoryListing,
  GroupRecord,
  GroupPathMutationResult,
  GroupRemoveMode,
  GroupRemoveResult,
  HostDraft,
  HostEnvVar,
  HostSecretInput,
  HostContainerAction,
  HostContainerDetails,
  HostContainerListResult,
  HostContainerLogsSnapshot,
  HostContainerLogSearchResult,
  HostContainerStatsSample,
  HostRecord,
  ContainerConnectionProgressEvent,
  SecretMetadataRecord,
  SerialControlAction,
  SerialDataBits,
  SerialFlowControl,
  SerialHostDraft,
  SerialLineEnding,
  SerialParity,
  SerialPortSummary,
  SerialStopBits,
  SerialTransport,
  FileSystemRoot,
  SessionShareChatEvent,
  SessionShareControlSignal,
  SessionShareEvent,
  SessionShareInputToggleInput,
  SessionShareOwnerChatSnapshot,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  SessionShareState,
  SshCertificateInfo,
  SftpConnectionProgressEvent,
  SftpEndpointSummary,
  SftpPrincipal,
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
  WarpgateImportEvent,
  WarpgateTargetSummary,
} from "@dolssh/shared-core";
import type { SyncPayloadV2 } from "@dolssh/shared-core";

// Electron main과 Go SSH 코어가 주고받는 명령/이벤트의 집합이다.
export type CoreCommandType =
  | "health"
  | "connect"
  | "awsConnect"
  | "localConnect"
  | "serialConnect"
  | "serialListPorts"
  | "serialControl"
  | "controlSignal"
  | "resize"
  | "disconnect"
  | "probeHostKey"
  | "inspectCertificate"
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
  | "sftpChown"
  | "sftpListPrincipals"
  | "sftpDelete"
  | "sftpReadFile"
  | "sftpWriteFile"
  | "sftpTransferStart"
  | "sftpTransferCancel"
  | "sftpTransferPause"
  | "sftpTransferResume"
  | "containersConnect"
  | "containersDisconnect"
  | "containersList"
  | "containersInspect"
  | "containersLogs"
  | "containersStart"
  | "containersStop"
  | "containersRestart"
  | "containersRemove"
  | "containersStats"
  | "containersSearchLogs"
  | "terminalAutocompletePrepare"
  | "terminalAutocompleteRefresh"
  | "terminalAutocompleteStop"
  | "terminalCompletionQuery"
  | "terminalShellIntegrationInstall"
  | "tmuxConnect"
  | "tmuxSplitPane"
  | "tmuxNewWindow"
  | "tmuxSelectWindow"
  | "tmuxSelectPane"
  | "tmuxKillPane"
  | "tmuxKillWindow"
  | "tmuxKillSession"
  | "tmuxRenameWindow"
  | "tmuxDetach"
  | "tmuxCommand";
export type CoreEventType =
  | "status"
  | "connected"
  | "data"
  | "error"
  | "closed"
  | "latency"
  | "serialPortsListed"
  | "serialControlCompleted"
  | "hostKeyProbed"
  | "certificateInspected"
  | "keyboardInteractiveChallenge"
  | "keyboardInteractiveResolved"
  | "portForwardStarted"
  | "portForwardStopped"
  | "portForwardError"
  | "sftpConnected"
  | "sftpDisconnected"
  | "sftpListed"
  | "sftpAck"
  | "sftpFileRead"
  | "sftpError"
  | "sftpSudoStatus"
  | "sftpPrincipalsListed"
  | "sftpTransferProgress"
  | "sftpTransferCompleted"
  | "sftpTransferFailed"
  | "sftpTransferCancelled"
  | "containersConnected"
  | "containersDisconnected"
  | "containersListed"
  | "containersInspected"
  | "containersLogs"
  | "containersActionCompleted"
  | "containersStats"
  | "containersLogsSearched"
  | "containersError"
  | "terminalAutocompleteCapability"
  | "terminalAutocompleteSnapshot"
  | "terminalAutocompleteShellState"
  | "terminalCompletionResult"
  | "moshState"
  | "tmuxAvailable"
  | "tmuxLayoutChange"
  | "tmuxWindowAdd"
  | "tmuxWindowClose"
  | "tmuxWindowRenamed"
  | "tmuxSessionChanged"
  | "tmuxSessionsChanged"
  | "tmuxPaused"
  | "tmuxContinue"
  | "tmuxActivePaneChanged"
  | "tmuxExit";
export type CoreStreamType = "write" | "data";

// renderer는 hostId만 넘기고, 실제 비밀값 해석은 main 프로세스가 담당한다.
export interface DesktopConnectInput {
  hostId: string;
  cols: number;
  rows: number;
  title?: string;
  command?: string;
  startupCommand?: string;
  secrets?: HostSecretInput;
  /** control mode(tmux -CC)로 연결할지. true면 main이 connect 대신 tmuxConnect command를 보낸다. */
  tmux?: boolean;
  /**
   * control mode 진입 시 원격에서 실행할 tmux 명령(예: "tmux -CC attach -t mysession").
   * 비우면 Go 코어가 기본값(기존 세션 있으면 attach, 없으면 'dolgate' 생성)을 쓴다. tmux=true 일 때만 의미가 있다.
   */
  tmuxCommand?: string;
  /**
   * 보조채널로 감지한 원격 tmux 버전("3.0a","2.6" 등). Go 코어가 입력 인코딩(-H vs
   * -l+키이름)과 refresh-client 인자 방언(콤마 vs WxH)을 버전별로 분기하는 데 쓴다.
   * tmux=true 일 때만 의미가 있고, 비우면 코어가 최신 가정으로 동작한다.
   */
  tmuxVersion?: string;
}

export interface DesktopLocalConnectInput {
  cols: number;
  rows: number;
  title?: string;
  shellKind?: string;
  executable?: string;
  args?: string[];
  env?: Record<string, string>;
  unsetEnv?: string[];
  workingDirectory?: string | null;
}

export interface DesktopSerialConnectInput {
  hostId: string;
  cols: number;
  rows: number;
  title?: string;
}

export interface DesktopSftpConnectInput {
  hostId: string;
  endpointId: string;
  secrets?: HostSecretInput;
}

// main 프로세스가 점프(베스천) 호스트의 자격증명/신뢰키까지 해석한 결과. Go 코어의
// JumpTarget(json: jump)에 1:1로 직렬화되며, 재귀 구조라 다단 체인도 표현 가능하다
// (현재 UI는 단일 홉만 설정). 필드명은 Go json 태그와 정확히 일치해야 한다.
export interface ResolvedJumpHost {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPem?: string;
  certificateText?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  trustedHostKeysBase64?: string[];
  jump?: ResolvedJumpHost;
}

// main 프로세스가 키체인과 DB를 합쳐 최종적으로 Go 코어에 보내는 payload다.
export interface ResolvedCoreConnectPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPem?: string;
  certificateText?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  trustedHostKeysBase64?: string[];
  jump?: ResolvedJumpHost;
  cols: number;
  rows: number;
  command?: string;
  env?: HostEnvVar[];
  // true면 SSH 대신 mosh(UDP)로 연결한다. Go 코어의 ConnectPayload.UseMosh에 매핑된다.
  useMosh?: boolean;
  // 감지된 원격 tmux 버전 문자열. Go 코어의 ConnectPayload.TmuxVersion(json: tmuxVersion)에
  // 매핑돼 버전별 입력 인코딩/refresh-client 방언 분기에 쓰인다. tmuxConnect일 때만 의미.
  tmuxVersion?: string;
}

export interface ResolvedLocalConnectPayload {
  cols: number;
  rows: number;
  title?: string;
  shellKind?: string;
  executable?: string;
  args?: string[];
  env?: Record<string, string>;
  unsetEnv?: string[];
  workingDirectory?: string | null;
}

export interface ResolvedSerialConnectPayload {
  transport: SerialTransport;
  cols: number;
  rows: number;
  title?: string;
  devicePath?: string;
  host?: string;
  port?: number;
  baudRate: number;
  dataBits: SerialDataBits;
  parity: SerialParity;
  stopBits: SerialStopBits;
  flowControl: SerialFlowControl;
  transmitLineEnding: SerialLineEnding;
  localEcho: boolean;
  localLineEditing: boolean;
}

export interface ResolvedSerialListPortsPayload {
  includeBusy?: boolean;
}

export interface ResolvedSerialListPortsResult {
  ports: SerialPortSummary[];
}

export interface DesktopSerialControlInput {
  sessionId: string;
  action: SerialControlAction;
  enabled?: boolean;
}

export interface ResolvedSerialControlPayload {
  action: SerialControlAction;
  enabled?: boolean;
}

export interface ResolvedSerialControlResult {
  action: SerialControlAction;
  enabled?: boolean;
}

export interface ResolvedCertificateInspectPayload {
  certificateText: string;
}

export interface ResolvedCertificateInspectResult
  extends SshCertificateInfo {}

export interface AwsEcsServiceLogsInput {
  hostId: string;
  serviceName: string;
  taskArn?: string | null;
  containerName?: string | null;
  followCursor?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  limit?: number;
}

export interface AwsEcsExecShellInput {
  hostId: string;
  serviceName: string;
  taskArn: string;
  containerName: string;
  cols: number;
  rows: number;
  command?: string;
}

export interface AwsEcsEphemeralTunnelStartInput {
  hostId: string;
  serviceName: string;
  taskArn: string;
  containerName: string;
  targetPort: number;
  bindAddress: string;
  bindPort: number;
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
  certificateText?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  trustedHostKeysBase64?: string[];
  jump?: ResolvedJumpHost;
}

export interface ResolvedContainersConnectPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPem?: string;
  certificateText?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  trustedHostKeysBase64?: string[];
  jump?: ResolvedJumpHost;
}

export interface ResolvedHostKeyProbePayload {
  host: string;
  port: number;
  // 베스천 뒤의(직접 닿지 않는) 타깃 호스트 키를 읽을 때, 경유할 점프 호스트.
  jump?: ResolvedJumpHost;
}

export interface ResolvedPortForwardStartPayload {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPem?: string;
  certificateText?: string;
  passphrase?: string;
  trustedHostKeyBase64: string;
  trustedHostKeysBase64?: string[];
  jump?: ResolvedJumpHost;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
  sourceEndpointId?: string;
}

export interface ResolvedSsmPortForwardStartPayload {
  profileName: string;
  region: string;
  targetType: 'instance' | 'ecs-task';
  targetId: string;
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

export interface SftpReadFileInput {
  endpointId: string;
  path: string;
}

export interface SftpReadFileResult {
  path: string;
  content: string;
  size: number;
  mtime: string;
  mode: number;
}

export interface SftpWriteFileInput {
  endpointId: string;
  path: string;
  content: string;
  mode: number;
  preserveMtime?: boolean;
  expectedSize?: number;
  expectedMtime?: string;
  sudoPassword?: string;
  force?: boolean;
}

export interface SftpChmodInput {
  endpointId: string;
  path: string;
  mode: number;
}

export interface SftpChownInput {
  endpointId: string;
  path: string;
  owner?: string;
  group?: string;
  uid?: number;
  gid?: number;
  recursive?: boolean;
  sudoPassword?: string;
}

export interface SftpListPrincipalsInput {
  endpointId: string;
  kind: "user" | "group";
  query?: string;
  limit?: number;
}

export interface HostContainersLogsInput {
  hostId: string;
  containerId: string;
  tail: number;
  followCursor?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

export interface HostContainersActionInput {
  hostId: string;
  containerId: string;
  action: HostContainerAction;
}

export interface HostContainersStatsInput {
  hostId: string;
  containerId: string;
}

export interface HostContainersSearchLogsInput {
  hostId: string;
  containerId: string;
  tail: number;
  query: string;
  startTime?: string | null;
  endTime?: string | null;
}

export interface HostContainersEphemeralTunnelInput {
  hostId: string;
  containerId: string;
  networkName: string;
  targetPort: number;
  bindAddress: string;
  bindPort: number;
}

export interface KnownHostProbeInput {
  hostId: string;
  endpointId?: string | null;
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

export interface PickedShellFile {
  path: string;
  name: string;
  content: string;
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
export interface CommandFinishedNotification {
  title: string;
  body: string;
  silent: boolean;
}

// 메뉴(탭 이동/다시 열기) 단축키가 렌더러로 보내는 명령. index 는 1-based 가시 탭 위치.
export type TabCommandPayload =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "index"; index: number }
  | { kind: "last" }
  | { kind: "reopen" };

export interface DesktopApi {
  auth: {
    getState: () => Promise<AuthState>;
    bootstrap: () => Promise<AuthState>;
    retryOnline: () => Promise<AuthState>;
    beginBrowserLogin: () => Promise<void>;
    reopenBrowserLogin: () => Promise<void>;
    cancelBrowserLogin: () => Promise<void>;
    logout: () => Promise<void>;
    onEvent: (listener: (state: AuthState) => void) => () => void;
  };
  sync: {
    bootstrap: () => Promise<SyncStatus>;
    pushDirty: () => Promise<SyncStatus>;
    status: () => Promise<SyncStatus>;
    exportDecryptedSnapshot: () => Promise<SyncPayloadV2>;
  };
  bootstrap: {
    getInitialSnapshot: () => Promise<DesktopBootstrapSnapshot>;
    getSyncedWorkspaceSnapshot: () => Promise<DesktopSyncedWorkspaceSnapshot>;
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
    move: (
      path: string,
      targetParentPath: string | null,
    ) => Promise<GroupPathMutationResult>;
    rename: (path: string, name: string) => Promise<GroupPathMutationResult>;
  };
  aws: {
    listProfiles: () => Promise<AwsProfileSummary[]>;
    listExternalProfiles: () => Promise<AwsProfileSummary[]>;
    createProfile: (input: AwsProfileCreateInput) => Promise<void>;
    prepareSsoProfile: (
      input: AwsSsoProfilePrepareInput,
    ) => Promise<AwsSsoProfilePrepareResult>;
    getProfileDetails: (profileName: string) => Promise<AwsProfileDetails>;
    getExternalProfileDetails: (profileName: string) => Promise<AwsProfileDetails>;
    importExternalProfiles: (
      input: AwsExternalProfileImportInput,
    ) => Promise<AwsExternalProfileImportResult>;
    updateProfile: (input: AwsProfileUpdateInput) => Promise<void>;
    updateProfileRegion: (input: AwsProfileRegionUpdateInput) => Promise<void>;
    renameProfile: (input: AwsProfileRenameInput) => Promise<void>;
    deleteProfile: (profileName: string) => Promise<void>;
    getProfileStatus: (profileName: string) => Promise<AwsProfileStatus>;
    login: (profileName: string) => Promise<void>;
    listRegions: (profileName: string) => Promise<string[]>;
    listEc2Instances: (
      profileName: string,
      region: string,
    ) => Promise<AwsEc2InstanceSummary[]>;
    listEcsClusters: (
      profileName: string,
      region: string,
    ) => Promise<AwsEcsClusterListItem[]>;
    loadEcsClusterSnapshot: (hostId: string) => Promise<AwsEcsClusterSnapshot>;
    loadEcsClusterUtilization: (
      hostId: string,
    ) => Promise<AwsEcsClusterUtilizationSnapshot>;
    loadEcsServiceActionContext: (
      hostId: string,
      serviceName: string,
    ) => Promise<AwsEcsServiceActionContext>;
    loadEcsServiceLogs: (
      input: AwsEcsServiceLogsInput,
    ) => Promise<AwsEcsServiceLogsSnapshot>;
    openEcsExecShell: (
      input: AwsEcsExecShellInput,
    ) => Promise<{ sessionId: string }>;
    startEcsServiceTunnel: (
      input: AwsEcsEphemeralTunnelStartInput,
    ) => Promise<PortForwardRuntimeRecord>;
    stopEcsServiceTunnel: (runtimeId: string) => Promise<void>;
    listEcsTaskTunnelServices: (
      hostId: string,
    ) => Promise<AwsEcsTaskTunnelServiceSummary[]>;
    loadEcsTaskTunnelService: (
      hostId: string,
      serviceName: string,
    ) => Promise<AwsEcsTaskTunnelServiceDetails>;
    inspectHostSshMetadata: (
      input: AwsHostSshInspectionInput,
    ) => Promise<AwsHostSshInspectionResult>;
    loadHostSshMetadata: (hostId: string) => Promise<HostRecord>;
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
    startBrowserImport: (baseUrl: string) => Promise<{ attemptId: string }>;
    cancelBrowserImport: (attemptId: string) => Promise<void>;
    onImportEvent: (listener: (event: WarpgateImportEvent) => void) => () => void;
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
    prepareAutocomplete: (sessionId: string) => Promise<void>;
    refreshAutocomplete: (sessionId: string) => Promise<void>;
    stopAutocomplete: (sessionId: string) => Promise<void>;
    installShellIntegration: (sessionId: string) => Promise<void>;
    queryCompletion: (sessionId: string, command: string) => Promise<string>;
    respondKeyboardInteractive: (
      input: KeyboardInteractiveRespondInput,
    ) => Promise<void>;
    // tmux control mode 명령. sessionId 는 pane 가상 세션 id("tmux:<controlSessionId>:<paneNum>")다.
    tmuxSplitPane: (sessionId: string, direction: "h" | "v") => Promise<void>;
    tmuxNewWindow: (sessionId: string) => Promise<void>;
    tmuxSelectWindow: (sessionId: string, windowId: string) => Promise<void>;
    tmuxSelectPane: (sessionId: string) => Promise<void>;
    tmuxKillPane: (sessionId: string) => Promise<void>;
    tmuxKillWindow: (sessionId: string, windowId: string) => Promise<void>;
    tmuxKillSession: (sessionId: string, sessionName: string) => Promise<void>;
    tmuxRenameWindow: (
      sessionId: string,
      windowId: string,
      name: string,
    ) => Promise<void>;
    tmuxDetach: (sessionId: string) => Promise<void>;
    tmuxCommand: (sessionId: string, command: string) => Promise<void>;
    onEvent: (listener: (event: CoreEvent) => void) => () => void;
    onData: (
      sessionId: string,
      listener: (chunk: Uint8Array) => void,
    ) => () => void;
  };
  serial: {
    connect: (input: DesktopSerialConnectInput) => Promise<{ sessionId: string }>;
    listPorts: () => Promise<SerialPortSummary[]>;
    control: (input: DesktopSerialControlInput) => Promise<void>;
  };
  sessionShares: {
    start: (input: SessionShareStartInput) => Promise<SessionShareState>;
    updateSnapshot: (input: SessionShareSnapshotInput) => Promise<void>;
    setInputEnabled: (
      input: SessionShareInputToggleInput,
    ) => Promise<SessionShareState>;
    stop: (sessionId: string) => Promise<void>;
    openOwnerChatWindow: (sessionId: string) => Promise<void>;
    sendOwnerChatMessage: (sessionId: string, text: string) => Promise<void>;
    getOwnerChatSnapshot: (
      sessionId: string,
    ) => Promise<SessionShareOwnerChatSnapshot>;
    onEvent: (listener: (event: SessionShareEvent) => void) => () => void;
    onChatEvent: (listener: (event: SessionShareChatEvent) => void) => () => void;
  };
  shell: {
    pickPrivateKey: () => Promise<PickedShellFile | null>;
    pickSshCertificate: () => Promise<PickedShellFile | null>;
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
    /** 메뉴(Cmd+W)의 '탭 닫기' 신호 구독. */
    onCloseActiveTab: (listener: () => void) => () => void;
    /** 메뉴(탭 이동/다시 열기) 단축키 신호 구독. */
    onTabCommand: (listener: (payload: TabCommandPayload) => void) => () => void;
  };
  system: {
    /** OS 절전/잠금 복귀 알림 구독. 자동 재연결의 즉시 재검증 트리거. */
    onResume: (listener: () => void) => () => void;
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
  dnsOverrides: {
    list: () => Promise<DnsOverrideResolvedRecord[]>;
    create: (draft: DnsOverrideDraft) => Promise<DnsOverrideResolvedRecord>;
    update: (id: string, draft: DnsOverrideDraft) => Promise<DnsOverrideResolvedRecord>;
    setStaticActive: (id: string, active: boolean) => Promise<DnsOverrideResolvedRecord>;
    remove: (id: string) => Promise<void>;
  };
  snippets: {
    list: () => Promise<SnippetRecord[]>;
    create: (draft: SnippetDraft) => Promise<SnippetRecord>;
    update: (id: string, draft: SnippetDraft) => Promise<SnippetRecord>;
    remove: (id: string) => Promise<void>;
  };
  notifications: {
    commandFinished: (payload: CommandFinishedNotification) => Promise<void>;
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
    onChanged: (listener: () => void) => () => void;
  };
  sessionReplays: {
    open: (recordingId: string) => Promise<void>;
    get: (recordingId: string) => Promise<SessionReplayRecording>;
  };
  keychain: {
    list: () => Promise<SecretMetadataRecord[]>;
    load: (secretRef: string) => Promise<LoadedManagedSecretPayload | null>;
    copyPassword: (secretRef: string) => Promise<void>;
    remove: (secretRef: string) => Promise<void>;
    update: (input: KeychainSecretUpdateInput) => Promise<void>;
    cloneForHost: (input: KeychainSecretCloneInput) => Promise<void>;
  };
  containers: {
    beginLifecycle: (hostId: string) => Promise<{ lifecycleId: string }>;
    reportLifecycleError: (input: {
      lifecycleId: string;
      message: string;
    }) => Promise<void>;
    list: (hostId: string) => Promise<HostContainerListResult>;
    inspect: (
      hostId: string,
      containerId: string,
    ) => Promise<HostContainerDetails>;
    logs: (
      input: HostContainersLogsInput,
    ) => Promise<HostContainerLogsSnapshot>;
    startTunnel: (
      input: HostContainersEphemeralTunnelInput,
    ) => Promise<PortForwardRuntimeRecord>;
    stopTunnel: (runtimeId: string) => Promise<void>;
    openShell: (
      hostId: string,
      containerId: string,
    ) => Promise<{ sessionId: string }>;
    start: (hostId: string, containerId: string) => Promise<void>;
    stop: (hostId: string, containerId: string) => Promise<void>;
    restart: (hostId: string, containerId: string) => Promise<void>;
    remove: (hostId: string, containerId: string) => Promise<void>;
    stats: (input: HostContainersStatsInput) => Promise<HostContainerStatsSample>;
    searchLogs: (
      input: HostContainersSearchLogsInput,
    ) => Promise<HostContainerLogSearchResult>;
    release: (hostId: string, lifecycleId?: string) => Promise<void>;
    onConnectionProgress: (
      listener: (event: ContainerConnectionProgressEvent) => void,
    ) => () => void;
  };
  sftp: {
    connect: (input: DesktopSftpConnectInput) => Promise<SftpEndpointSummary>;
    disconnect: (endpointId: string) => Promise<void>;
    list: (input: SftpListInput) => Promise<DirectoryListing>;
    mkdir: (input: SftpMkdirInput) => Promise<void>;
    rename: (input: SftpRenameInput) => Promise<void>;
    chmod: (input: SftpChmodInput) => Promise<void>;
    chown: (input: SftpChownInput) => Promise<void>;
    listPrincipals: (
      input: SftpListPrincipalsInput,
    ) => Promise<SftpPrincipal[]>;
    delete: (input: SftpDeleteInput) => Promise<void>;
    readFile: (input: SftpReadFileInput) => Promise<SftpReadFileResult>;
    writeFile: (input: SftpWriteFileInput) => Promise<void>;
    startTransfer: (input: TransferStartInput) => Promise<TransferJob>;
    cancelTransfer: (jobId: string) => Promise<void>;
    pauseTransfer: (jobId: string) => Promise<void>;
    resumeTransfer: (jobId: string) => Promise<void>;
    onConnectionProgress: (
      listener: (event: SftpConnectionProgressEvent) => void,
    ) => () => void;
    onTransferEvent: (
      listener: (event: TransferJobEvent) => void,
    ) => () => void;
  };
  files: {
    getHomeDirectory: () => Promise<string>;
    getDownloadsDirectory: () => Promise<string>;
    getPathForDroppedFile: (file: File) => string | null;
    listRoots: () => Promise<FileSystemRoot[]>;
    getParentPath: (targetPath: string) => Promise<string>;
    list: (path: string) => Promise<DirectoryListing>;
    mkdir: (path: string, name: string) => Promise<void>;
    rename: (path: string, nextName: string) => Promise<void>;
    chmod: (path: string, mode: number) => Promise<void>;
    delete: (paths: string[]) => Promise<void>;
    saveZmodemDownload: (input: {
      name: string;
      bytes: Uint8Array;
    }) => Promise<{ savedPath: string }>;
    reveal: (targetPath: string) => Promise<void>;
  };
}
