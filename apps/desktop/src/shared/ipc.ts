import type {
  ActivityLogRecord,
  AiProviderId,
  AiSearchBackend,
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
  PasskeyCredential,
  OpenSshImportSelectionInput,
  OpenSshProbeResult,
  XshellSnapshotFolderInput,
  XshellImportResult,
  XshellImportSelectionInput,
  XshellProbeResult,
  HostKeyProbeResult,
  KnownHostRecord,
  TailnetRecord,
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
import type {
  AiApiKeyStatus,
  AiApprovalResponse,
  AiChatEvent,
  AiChatStartInput,
  AiTerminalOutputRequest,
  AiTerminalOutputResponse,
  AiTestConnectionInput,
  AiTestResult,
  CodexAuthStatus,
  CodexLoginStart,
  CodexModel,
  CodexUsage,
} from "./ai";

export type DesktopWindowLaunchIntent = {
  type: "connect-host";
  hostId: string;
};

export type HostExportFormat = "dolgate" | "openssh";

export interface HostExportPreview {
  selectedHostCount: number;
  dolgateHostCount: number;
  opensshHostCount: number;
  opensshDependencyCount: number;
  opensshSkippedCount: number;
  opensshWarnings: string[];
}

export interface HostExportSelectionInput {
  hostIds: string[];
  format: HostExportFormat;
  password?: string;
}

export interface HostExportResult {
  canceled: boolean;
  savedPath: string | null;
  exportedHostCount: number;
  skippedHostCount: number;
  warnings: string[];
}

export interface DolgateImportFileSelection {
  filePath: string;
  fileName: string;
}

export interface DolgateImportItemCounts {
  hosts: number;
  groups: number;
  secrets: number;
  awsProfiles: number;
  snippets: number;
  portForwards: number;
  dnsOverrides: number;
  knownHosts: number;
  tailnets: number;
}

export interface DolgateImportPreview {
  snapshotId: string;
  hostCount: number;
  groupCount: number;
  secretCount: number;
  awsProfileCount: number;
  snippetCount: number;
  portForwardCount: number;
  dnsOverrideCount: number;
  knownHostCount: number;
  tailnetCount: number;
  skippedCount: number;
  skippedCounts: DolgateImportItemCounts;
  warnings: string[];
}

export interface DolgateImportResult {
  importedHostCount: number;
  importedGroupCount: number;
  importedSecretCount: number;
  importedAwsProfileCount: number;
  importedSnippetCount: number;
  importedPortForwardCount: number;
  importedDnsOverrideCount: number;
  importedKnownHostCount: number;
  importedTailnetCount: number;
  skippedCount: number;
  skippedCounts: DolgateImportItemCounts;
  warnings: string[];
}

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
  | "generatePrivateKey"
  | "inspectPrivateKey"
  | "installAuthorizedKey"
  | "keyboardInteractiveRespond"
  | "tailnetTest"
  | "tailnetForget"
  | "tailnetDisconnect"
  | "tailnetCancel"
  | "tailnetSnapshot"
  | "tailnetForwardOpen"
  | "tailnetForwardClose"
  | "tailnetConfigure"
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
  | "terminalShellIntegrationReinject"
  | "runCommand"
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
/** tailnet 노드가 올라오는 동안의 상태. ssh-core 의 State 와 같은 값이다. */
export type TailnetState =
  | "stopped"
  | "needsAuth"
  | "needsApproval"
  | "starting"
  | "running";

/** 연결 테스트 중 여러 번 도착한다. authUrl 이 있으면 브라우저에서 인가해야 한다. */
/**
 * tailnet 안의 기기 하나와, 그 기기까지 지금 어떤 경로로 가는지.
 *
 * 경로를 노출하는 이유: 유저스페이스 노드는 붙은 직후 릴레이로 시작해 홀펀칭이 되면 직결로
 * 승격한다. "느리다"가 릴레이 때문인지 아닌지는 이 값 없이는 추측밖에 안 된다.
 */
export interface TailnetPeer {
  /** 짧은 이름과 FQDN(끝점 제거). 호스트 주소가 어느 형태든 맞출 수 있어야 해서 둘 다 온다. */
  hostName?: string;
  dnsName?: string;
  ips?: string[];
  /** 직결 경로가 서 있는지. false 면 릴레이 경유. */
  direct: boolean;
  /** 이 기기와 쓰는 DERP 지역. 직결이어도 폴백으로 남아 채워질 수 있다. */
  relay?: string;
  /**
   * 이 기기가 서브넷 라우터로서 담당하는 대역(CIDR).
   *
   * tailnet 을 거쳐 가는 호스트가 전부 tailnet 노드인 것은 아니다 — tailscale 이 깔려 있지
   * 않은 사내망 장비는 이 대역을 통해 닿는다. 그런 호스트의 경로를 말하려면 라우터를 먼저
   * 찾아야 한다.
   */
  routes?: string[];
  rxBytes?: number;
  txBytes?: number;
}

export interface TailnetStatus {
  id: string;
  state: TailnetState;
  authUrl?: string;
  error?: string;

  /**
   * 붙은 뒤에만 채워진다.
   *
   * Tailscale 기본 서버는 폼이 전부 비어 있어서 여러 개를 등록하면 화면에서 구분할 수
   * 없다 — 누구로 어느 tailnet 에 붙었는지가 유일한 단서다.
   */
  loginName?: string;
  tailnetName?: string;
  nodeName?: string;
  nodeIp?: string;
  /**
   * 이 Tailscale 네트워크를 통해 **확실히** 통신할 수 있는지.
   *
   * 판정은 코어 한 곳에서만 한다(`tailnet.Status.Connected`). 화면과 연결 흐름은 이 값을 읽고,
   * state·expired·peers 로 다시 조합하지 않는다 — 곳곳에서 각자 판단하면 기준이 갈리고, 반쪽
   * 기준이 낡은 상태를 통과시킨다.
   */
  ready?: boolean;
  /**
   * 등록과 로그인이 끝났는지(`tailnet.Status.Authorized`).
   *
   * ready 와 나뉘어 있어야 하는 이유: 이 둘은 다른 질문이다. 등록·로그인이 끝났는지는 **지금
   * 컨트롤 플레인과 동기화되는지와 무관하다**. 하나로 답하면 동기화만 끊긴 상태에서 이미 끝난
   * 등록·로그인 단계가 "아직 안 됨" 으로 되돌아가고, 그 아래 단계에는 체크가 떠 있어서 화면의
   * 순서가 뒤바뀐 것처럼 보인다 — 실제로 그렇게 보였다.
   */
  authorized?: boolean;
  /** 컨트롤 플레인이 현재 노드 identity 를 더 이상 모른다고 확정했는지. */
  identityInvalid?: boolean;
  /**
   * 컨트롤 플레인과 세션이 살아 있는지(map poll 롱폴이 열려 있는지).
   *
   * state 와 expired 는 끊긴 뒤에도 낡은 값으로 남는다 — 등록이 만료돼도 연결됨으로, 기기
   * 목록까지 그대로다. ready 가 false 인 이유를 설명하는 값이다.
   *
   * 이것이 false 라고 통신이 불가능하다는 뜻은 아니다. 데이터 플레인은 이미 받아 둔 넷맵으로
   * 계속 통하고, 끊긴 것은 갱신 통로다 — 그래서 관문은 이 상태를 잠깐만 기다린 뒤 진행한다.
   */
  online?: boolean;
  /**
   * 동기화가 끊긴 채로 코어가 진행하기로 했는지.
   *
   * ready 가 아닌데도 통과시킨 결정이라, 이 값이 곧 "코어가 다음 단계로 넘겼다" 는 신호다.
   * 기다리는 쪽은 ready 와 함께 이것을 종료로 보고, 화면은 동기화 단계를 경고로 그린다.
   */
  degraded?: boolean;
  /** 노드 키가 만료됐는지. state 가 running 이어도 true 일 수 있다. */
  expired?: boolean;
  /**
   * 백엔드가 스스로 보고하는 문제들.
   *
   * state 가 정상으로 보이는데 통신이 안 될 때 유일하게 남는 단서다 — tailscale 은 로그아웃,
   * 마지막 로그인 오류, 컨트롤 플레인과 동기화 실패를 여기에 담는다.
   */
  health?: string[];
  /**
   * tsnet 이 보고한 원문 상태와 노드 키 만료 시각.
   *
   * state 는 몇 가지로 뭉치므로, 무엇을 보고 그렇게 판단했는지 확인하려면 원문이 필요하다.
   * 만료가 상태로 드러나지 않는 문제를 눈으로 확인하는 유일한 수단이다.
   */
  backendState?: string;
  keyExpiry?: string;
  /**
   * 사용자가 시도를 접어서 끝났는지. 실패가 아니라서 error 가 비어 있는데, 그렇다고 진행
   * 중인 것도 아니다 — 이 표시가 없으면 시도가 끝났는지 알 수 없다.
   */
  cancelled?: boolean;
  /**
   * 지금 이 tailnet 을 올리는 시도가 실제로 돌고 있는지.
   *
   * 상태만으로는 알 수 없다 — 인증이 필요한 노드는 아무도 손대지 않아도 계속 needsAuth 로
   * 보고된다. 그것을 진행 중으로 그리면 화면이 거짓 진행을 보여준다(스피너와 "링크를 받는 중"
   * 이 뜨는데 실제로는 아무 일도 일어나지 않고, 취소할 대상도 없다).
   */
  attempting?: boolean;
  /**
   * 인증 링크를 받으려고 코어가 노드를 다시 세운 횟수와, 마지막 시도가 거절됐는지.
   *
   * 링크가 오지 않으면 코어가 노드를 새로 만들어 등록을 처음부터 밟는다. 그 사실이 상태로
   * 나오지 않으면 화면에서는 아무 일도 없는 것과 구분되지 않는다 — 재시작 전후의 상태가
   * 완전히 같기 때문이다. 거절은 이 tailnet 을 쓰던 것이 아직 정리되지 않았다는 뜻이다.
   */
  restarts?: number;
  restartRefused?: boolean;
  /** 삭제된 identity 를 버리고 새 identity 로 등록을 시작한 횟수. */
  reRegistrations?: number;
  /**
   * 백엔드가 확정한 로그인 실패 이유(잘못된 auth key 등).
   *
   * 이 값이 있으면 **기다려서 풀리는 상태가 아니다** — 설정을 고쳐야 한다. state 만으로는 링크를
   * 기다리는 것과 구분되지 않아서, 이것 없이는 화면이 "링크를 받는 중" 을 계속 그린다.
   */
  loginError?: string;
  /**
   * 백엔드가 마지막으로 보고한 오류(IPN 버스의 ErrMessage).
   *
   * 컨트롤 플레인이 요청을 거부한 이유가 이 경로로만 오는 경우가 있다. 진단용으로 그대로 보여
   * 준다 — 이것 없이는 "왜 안 되는지" 를 화면에서 확인할 방법이 없다.
   */
  backendError?: string;

  /** 이 tailnet 안에서 보이는 기기들과 그 경로. 붙어 있지 않으면 비어 있다. */
  peers?: TailnetPeer[];
}

/**
 * tailnet 등록 정보. 컨트롤 플레인(서버)과 인증 방식은 직교한다 — 어느 서버든 auth key 와
 * 브라우저 로그인 둘 다 쓸 수 있다.
 */
/** 지금 살아 있는 노드들의 상태와, 이 기기가 등록에 쓰는 이름. */
export interface TailnetSnapshot {
  statuses: TailnetStatus[];
  /** 붙어 있지 않아도 알 수 있다 — 기기 목록에서 자기 기기를 찾는 단서다. */
  localNodeName?: string;
}

// 연결 요청에는 옵션이 없다.
//
// 예전에는 forceRelogin("기다리기 전에 노드를 버리고 다시 확인해라")이 있었다. 그러면 "강도"를
// 요청하는 쪽이 정하게 되고, 화면이 취소·플래그·재시도를 조립하게 된다. 다시 세울지는 코어가
// 링크를 확보하는 과정에서 판단한다. 사용자가 처음부터 다시 하려면 취소를 거치고, 취소가 노드를
// 없애므로 다음 요청이 새 노드로 시작한다.

export interface TailnetConfig {
  id: string;
  /** 비면 Tailscale, 채우면 Headscale 같은 다른 컨트롤 플레인. */
  controlUrl?: string;
  /** 있으면 브라우저 없이 등록한다. 비면 대화형 로그인으로 간다. */
  authKey?: string;
  /** 활동이 멈추면 노드를 지우도록 요청한다. 컨트롤 플레인이 최종 판단한다. */
  ephemeral?: boolean;
  /**
   * tailnet 기기 목록에 보일 이름. undefined 면 코어가 `dolgate-<기기이름>` 을 쓴다.
   *
   * 선택 필드가 아니다(값은 없을 수 있어도 키는 써야 한다). 코어는 이 config 로 저장된
   * 설정을 덮어쓰므로, 빠뜨리면 밀어 넣어 둔 이름이 지워진다. 필수로 두면 그것을 컴파일러가
   * 잡는다.
   */
  hostname: string | undefined;
}

/**
 * 화면이 "연결"을 눌렀을 때 메인으로 보내는 것. 코어 설정(TailnetConfig)과 다른 타입이다.
 *
 * 화면은 노드 이름도 저장된 auth key 도 모른다 — 둘 다 기기 로컬이라 메인이 채운다. 같은
 * 타입으로 두면 화면이 못 채우는 필드를 필수로 만들 수 없어, 정작 필요한 곳에서 누락을
 * 잡지 못한다.
 */
export interface TailnetTestRequest {
  id: string;
  controlUrl?: string;
  /** 아직 저장하지 않은 초안을 시험할 때만. 저장된 것은 메인이 읽어 넣는다. */
  authKey?: string;
}

export type CoreEventType =
  | "status"
  | "connected"
  | "data"
  | "error"
  | "closed"
  | "latency"
  | "connectionHopProgress"
  | "serialPortsListed"
  | "serialControlCompleted"
  | "hostKeyProbed"
  | "certificateInspected"
  | "tailnetStatus"
  | "tailnetForgot"
  | "tailnetSnapshot"
  | "tailnetForwardOpened"
  | "privateKeyGenerated"
  | "privateKeyInspected"
  | "authorizedKeyInstalled"
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
  | "runCommandResult"
  | "moshState"
  | "agentForwardingStatus"
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

export type AgentForwardingEndpointKind = "unix" | "windows-openssh-pipe";

// SSH Agent 인증 설정 시 HostForm에 표시할 로컬 ssh-agent 상태.
// ok=키 있음, empty=실행 중이나 키 없음, unreachable=연결 불가, not-found=소켓 못 찾음,
// unknown=상태 확인 불가(ssh-add 없음 등 — 인증 자체는 Go가 직접 처리하므로 무관).
export type SshAgentProbeStatus =
  | "ok"
  | "empty"
  | "unreachable"
  | "not-found"
  | "unknown";
export interface SshAgentProbeResult {
  status: SshAgentProbeStatus;
  keyCount?: number;
  endpoint?: string;
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
/**
 * Opaque start blob ssh-core forwards verbatim to sync-api as the first WebSocket
 * frame. Its keys are the JSON the server's relay reads (region, instanceId, EIC
 * publicKey, resolved AWS credential env, ...). Mirrors awsSshTunnelStartMessage
 * on the Go side.
 */
export interface AwsSshTunnelStartMessage {
  region: string;
  profileName: string;
  instanceId: string;
  availabilityZone: string;
  sshUsername: string;
  sshPort: number;
  publicKey: string;
  env: Record<string, string>;
  unsetEnv?: string[];
}

/**
 * Routes the raw SSH transport through a WebSocket to sync-api instead of dialing
 * the target directly (server-proxy / bastion mode for IP-restricted VPCs). ssh-core
 * dials `url` with Bearer `authToken`, forwards `startMessage` verbatim, then speaks
 * plain SSH over the relayed bytes — so shell/tmux/sftp/forwarding work through the
 * server unchanged. Mirrors coretypes.WSProxyTarget on the Go side.
 */
export interface WsProxyTarget {
  url: string;
  authToken?: string;
  startMessage: AwsSshTunnelStartMessage;
}

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
  // authType이 "agent"일 때 서명을 위임할 로컬 ssh-agent 소켓/파이프(연결 단위, config로 전파).
  authAgentEndpointKind?: string;
  authAgentEndpoint?: string;
  /** 있으면 이 tailnet 을 경유해 붙는다. */
  tailnetId?: string;
  /** 설정에 박아 둔 tailnet 이름. 실제로 붙은 곳과 다르면 코어가 연결을 거부한다. */
  tailnetName?: string;
  cols: number;
  rows: number;
  command?: string;
  env?: HostEnvVar[];
  agentForwarding?: boolean;
  agentForwardingEndpointKind?: AgentForwardingEndpointKind;
  agentForwardingEndpoint?: string;
  // true면 SSH 대신 mosh(UDP)로 연결한다. Go 코어의 ConnectPayload.UseMosh에 매핑된다.
  useMosh?: boolean;
  // 감지된 원격 tmux 버전 문자열. Go 코어의 ConnectPayload.TmuxVersion(json: tmuxVersion)에
  // 매핑돼 버전별 입력 인코딩/refresh-client 방언 분기에 쓰인다. tmuxConnect일 때만 의미.
  tmuxVersion?: string;
  // 설정되면 직접 dial 대신 sync-api WebSocket으로 SSH 전송을 라우팅한다(서버 프록시/bastion).
  wsProxy?: WsProxyTarget;
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

export interface ResolvedPrivateKeyInspectPayload {
  privateKeyPem: string;
  passphrase?: string;
}

export interface ResolvedPrivateKeyGeneratePayload {
  algorithm?: "ed25519" | "ecdsa" | "rsa";
  curve?: "nistp256" | "nistp384" | "nistp521";
  rsaBits?: 3072 | 4096;
  privateKeyCipher?: "aes256-ctr" | "aes256-cbc";
  kdfRounds?: number;
  comment?: string | null;
  passphrase?: string;
}

export interface ResolvedPrivateKeyGenerateResult {
  algorithm: string;
  privateKeyPem: string;
  publicKey: string;
  fingerprintSha256: string;
  privateKeyEncrypted: boolean;
  keyCurve?: string;
  keyBits?: number;
  privateKeyCipher?: string;
  privateKeyKdfRounds?: number;
}

export interface ResolvedPrivateKeyInspectResult {
  algorithm: string;
  publicKey: string;
  fingerprintSha256: string;
}

export interface ResolvedAuthorizedKeyInstallPayload
  extends ResolvedCoreConnectPayload {
  publicKey: string;
}

export interface ResolvedAuthorizedKeyInstallResult {
  status: "installed" | "already-present";
}

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
  authAgentEndpointKind?: string;
  authAgentEndpoint?: string;
  wsProxy?: WsProxyTarget;
  /** 있으면 이 tailnet 을 경유해 붙는다. */
  tailnetId?: string;
  /** 설정에 박아 둔 tailnet 이름. 실제로 붙은 곳과 다르면 코어가 연결을 거부한다. */
  tailnetName?: string;
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
  authAgentEndpointKind?: string;
  authAgentEndpoint?: string;
  wsProxy?: WsProxyTarget;
  /** 있으면 이 tailnet 을 경유해 붙는다. */
  tailnetId?: string;
  /** 설정에 박아 둔 tailnet 이름. 실제로 붙은 곳과 다르면 코어가 연결을 거부한다. */
  tailnetName?: string;
}

export interface ResolvedHostKeyProbePayload {
  host: string;
  port: number;
  // 베스천 뒤의(직접 닿지 않는) 타깃 호스트 키를 읽을 때, 경유할 점프 호스트.
  jump?: ResolvedJumpHost;
  // 프로브 중 방출하는 홉 진행(connectionHopProgress)을 해당 연결의 오버레이에 매핑하기 위한
  // 상관 ID. 세션(터미널 탭)이면 sessionId, SFTP·컨테이너 등이면 endpointId를 채운다.
  sessionId?: string;
  endpointId?: string;
  // 설정되면 직접 dial 대신 sync-api WebSocket으로 전송을 라우팅해 호스트 키를 읽는다
  // (서버 프록시/bastion). 실연결과 동일하게 IP 제한 VPC에서도 probe가 서버 IP를 경유한다.
  wsProxy?: WsProxyTarget;
  /**
   * 프로브도 실연결과 같은 tailnet 을 타야 한다. 안 그러면 tailnet 안에만 있는 호스트의 키를
   * 읽을 수 없고, 읽더라도 tailnet 밖의 동명 호스트 키를 읽어 잘못 신뢰하게 된다.
   */
  tailnetId?: string;
  tailnetName?: string;
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
  authAgentEndpointKind?: string;
  authAgentEndpoint?: string;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
  sourceEndpointId?: string;
  // 설정되면 직접 dial 대신 sync-api WebSocket으로 SSH 전송을 라우팅한다(서버 프록시/bastion).
  // AWS EC2 포트포워딩을 네이티브 SSM 대신 SSH -L로 서버 경유시킬 때 쓴다.
  wsProxy?: WsProxyTarget;
  /** 있으면 이 tailnet 을 경유해 붙는다. */
  tailnetId?: string;
  /** 설정에 박아 둔 tailnet 이름. 실제로 붙은 곳과 다르면 코어가 연결을 거부한다. */
  tailnetName?: string;
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
  /**
   * In-process SSM data channel token (issued via ssm:StartSession with a
   * port-forwarding document). When present, ssh-core opens the SSM WebSocket
   * itself instead of spawning aws + session-manager-plugin.
   */
  streamUrl?: string;
  tokenValue?: string;
  ssmSessionId?: string;
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
  // 프로브 홉 진행을 활성 오버레이(터미널 탭 등)에 매핑하기 위한 세션 상관 ID.
  sessionId?: string | null;
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

export interface SshKeyGenerateInput {
  label: string;
  algorithm?: "ed25519" | "ecdsa" | "rsa";
  curve?: "nistp256" | "nistp384" | "nistp521";
  rsaBits?: 3072 | 4096;
  privateKeyCipher?: "aes256-ctr" | "aes256-cbc";
  kdfRounds?: number;
  comment?: string | null;
  passphrase?: string | null;
  savePassphrase?: boolean;
}

export interface SshKeyMaterialResult {
  secretRef: string;
  label: string;
  algorithm: string;
  publicKey: string;
  fingerprintSha256: string;
}

// 세션 리플레이 저장소가 디스크에서 차지하는 용량(설정 화면 표시용).
export interface SessionReplayStorageUsage {
  totalBytes: number;
  recordingCount: number;
}

export type SshKeyInstallMode = "installOnly" | "installAndUse";

export interface SshKeyInstallInput {
  secretRef: string;
  hostIds: string[];
  mode: SshKeyInstallMode;
  passphraseOverride?: string | null;
}

export interface SshKeyInstallHostResult {
  hostId: string;
  hostLabel: string;
  status: "installed" | "already-present" | "failed";
  message?: string;
}

export interface SshKeyInstallResult {
  secretRef: string;
  mode: SshKeyInstallMode;
  results: SshKeyInstallHostResult[];
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
    // 회원 탈퇴 — 서버의 모든 사용자 데이터를 즉시 영구 삭제하고 로컬 세션을 정리한다.
    deleteAccount: () => Promise<void>;
    changeAccountPassword: (
      currentPassword: string,
      newPassword: string,
    ) => Promise<void>;
    // 패스키(WebAuthn) — 설정에서 추가(시스템 브라우저로 등록 페이지 오픈)/목록/삭제.
    addPasskey: () => Promise<void>;
    listPasskeys: () => Promise<PasskeyCredential[]>;
    deletePasskey: (credentialId: string) => Promise<void>;
    // E2EE 볼트 — 동기화 암호 설정/잠금해제/초기화/변경.
    setupVault: (passphrase: string) => Promise<void>;
    unlockVault: (passphrase: string) => Promise<void>;
    resetVault: () => Promise<void>;
    changeVaultPassphrase: (
      currentPassphrase: string,
      nextPassphrase: string,
    ) => Promise<void>;
    // 기존(v1) 유저의 E2EE 전환.
    migrateVault: (passphrase: string) => Promise<void>;
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
    onWorkspaceChanged: (listener: () => void) => () => void;
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
    setFavorite: (id: string, favorite: boolean) => Promise<HostRecord | null>;
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
    getProfileStatusById: (profileId: string) => Promise<AwsProfileStatus>;
    login: (profileName: string) => Promise<void>;
    loginById: (profileId: string) => Promise<void>;
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
  hostTransfer: {
    previewExport: (hostIds: string[]) => Promise<HostExportPreview>;
    exportSelection: (
      input: HostExportSelectionInput,
    ) => Promise<HostExportResult>;
    pickImportFile: () => Promise<DolgateImportFileSelection | null>;
    probeImport: (
      filePath: string,
      password: string,
    ) => Promise<DolgateImportPreview>;
    commitImport: (snapshotId: string) => Promise<DolgateImportResult>;
    discardImport: (snapshotId: string) => Promise<void>;
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
  rdp: {
    connect: (
      sessionId: string,
      hostId: string,
      /**
       * 원격 화면이 들어갈 자리의 크기.
       *
       * 접속할 때 이 크기로 붙어야 화면이 뜨는 순간부터 창에 맞는다. 없으면 메인이 창 크기로
       * 대신한다.
       */
      viewport?: { width: number; height: number },
    ) => Promise<import("./rdp").RdpConnectedPayload>;
    disconnect: (sessionId: string) => Promise<void>;
    sendInput: (
      sessionId: string,
      events: import("./rdp").RdpInputEvent[],
    ) => void;
    trustCertificate: (sessionId: string, accept: boolean) => Promise<void>;
    requestResize: (sessionId: string, width: number, height: number) => void;
    sendClipboardText: (sessionId: string, text: string) => void;
    syncClipboard: (sessionId: string) => void;
    pickShareFolder: () => Promise<string | null>;
    /** 배치도 UI 가 그릴 로컬 디스플레이 목록. */
    listMonitors: () => Promise<import("./rdp").RdpLocalMonitor[]>;
    /** 이미 붙어 있는 세션의 접속 정보. 모니터별 창이 뒤늦게 붙을 때 쓴다. */
    describeSession: (
      sessionId: string,
    ) => Promise<import("./rdp").RdpConnectedPayload | null>;
    /** 지금 화면 전체를 한 번 더 보내게 한다. 도중에 붙는 창이 쓴다. */
    requestRefresh: (sessionId: string) => void;
    /** 원격 모니터를 물리 화면마다 펼친다. 메인 창이 맡을 모니터 번호를 돌려준다. */
    spreadMonitors: (sessionId: string) => Promise<number | null>;
    /** 펼친 창을 접고 메인 창을 데스크톱 전체 보기로 되돌린다. */
    collapseMonitors: (sessionId: string) => Promise<void>;
    onEvent: (
      listener: (event: import("./rdp").RdpSessionEvent) => void,
    ) => () => void;
    onFrame: (
      sessionId: string,
      listener: (frame: import("./rdp").RdpFramePayload) => void,
    ) => () => void;
    onAudio: (
      sessionId: string,
      listener: (audio: import("./rdp").RdpAudioPayload) => void,
    ) => () => void;
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
    reinjectShellIntegration: (sessionId: string) => Promise<void>;
    queryCompletion: (sessionId: string, command: string) => Promise<string>;
    respondKeyboardInteractive: (
      input: KeyboardInteractiveRespondInput,
    ) => Promise<void>;
    // SSH Agent 인증 설정 시 로컬 ssh-agent 상태(도달 여부·키 개수)를 조회한다.
    probeAgent: () => Promise<SshAgentProbeResult>;
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
    openNew: () => Promise<void>;
    openHost: (hostId: string) => Promise<void>;
    consumeLaunchIntent: () => Promise<DesktopWindowLaunchIntent | null>;
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
  ai: {
    testConnection: (input: AiTestConnectionInput) => Promise<AiTestResult>;
    apiKeyStatus: (providerId: AiProviderId) => Promise<AiApiKeyStatus>;
    setApiKey: (providerId: AiProviderId, key: string) => Promise<AiApiKeyStatus>;
    clearApiKey: (providerId: AiProviderId) => Promise<AiApiKeyStatus>;
    searchKeyStatus: (backend: AiSearchBackend) => Promise<AiApiKeyStatus>;
    setSearchKey: (backend: AiSearchBackend, key: string) => Promise<AiApiKeyStatus>;
    clearSearchKey: (backend: AiSearchBackend) => Promise<AiApiKeyStatus>;
    chat: (input: AiChatStartInput) => Promise<{ requestId: string }>;
    cancelChat: (requestId: string) => Promise<void>;
    respondApproval: (input: AiApprovalResponse) => Promise<void>;
    onChatEvent: (listener: (event: AiChatEvent) => void) => () => void;
    respondTerminalOutput: (input: AiTerminalOutputResponse) => Promise<void>;
    onTerminalOutputRequest: (listener: (event: AiTerminalOutputRequest) => void) => () => void;
    // Codex(ChatGPT 계정) 인증. authUrl 은 렌더러가 openExternalUrl 로 연다.
    codexLoginStart: () => Promise<CodexLoginStart>;
    codexAuthStatus: () => Promise<CodexAuthStatus>;
    codexLogout: () => Promise<void>;
    codexUsage: () => Promise<CodexUsage>;
    codexModels: () => Promise<CodexModel[]>;
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
  tailnet: {
    list: () => Promise<TailnetRecord[]>;
    /** authKey 를 생략하면 기존 키를 그대로 둔다. 빈 문자열이면 지운다. */
    save: (input: {
      record: TailnetRecord;
      authKey?: string;
    }) => Promise<TailnetRecord>;
    /** 노드를 정리하고 설정까지 지운다. */
    remove: (id: string) => Promise<void>;
    /**
     * 노드를 올려 running 까지 가는지 확인한다. 반환값은 마지막 상태이고, 그 전의 진행은
     * onStatus 로 온다 — 브라우저 로그인이면 사용자가 인증하는 구간이 있어서 응답 하나로는
     * 무엇을 기다리는지 보여줄 수 없다.
     */
    test: (config: TailnetTestRequest) => Promise<TailnetStatus>;
    /** 노드 등록을 해제한다. tailnet 설정 자체는 남는다. */
    forget: (id: string) => Promise<void>;
    /** 노드를 지금 내린다. 등록은 남으므로 다시 연결해도 재인증이 없다. */
    disconnect: (id: string) => Promise<void>;
    /** 진행 중인 연결 시도를 접는다. 브라우저 로그인은 최대 3 분까지 사람을 기다린다. */
    cancel: (id: string) => Promise<void>;
    /**
     * 지금 살아 있는 노드들의 상태.
     *
     * 여기 없는 tailnet 은 연결돼 있지 않다는 뜻이다. 없는 것을 위해 노드를 만들지 않으므로,
     * 설정 화면을 여는 것만으로 모든 tailnet 이 붙는 일은 없다.
     */
    snapshot: () => Promise<TailnetSnapshot>;
    onStatus: (listener: (status: TailnetStatus) => void) => () => void;
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
    storageUsage: () => Promise<SessionReplayStorageUsage>;
  };
  keychain: {
    list: () => Promise<SecretMetadataRecord[]>;
    load: (secretRef: string) => Promise<LoadedManagedSecretPayload | null>;
    copyPassword: (secretRef: string) => Promise<void>;
    remove: (secretRef: string) => Promise<void>;
    update: (input: KeychainSecretUpdateInput) => Promise<void>;
    cloneForHost: (input: KeychainSecretCloneInput) => Promise<void>;
  };
  sshKeys: {
    generate: (input: SshKeyGenerateInput) => Promise<SshKeyMaterialResult>;
    copyPublicKey: (secretRef: string) => Promise<void>;
    install: (input: SshKeyInstallInput) => Promise<SshKeyInstallResult>;
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
