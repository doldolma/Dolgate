import type { StoreApi } from "zustand/vanilla";
import type { CommandFinishedInfo } from "../lib/command-notification";
import type { SessionPanelSectionId } from "../lib/session-panel";
import type { HostDetectedOs, TerminalThemeId } from "@shared";
import type {
  ActivityLogRecord,
  AuthType,
  AppSettings,
  AwsEcsClusterSnapshot,
  AwsEcsServiceLogsSnapshot,
  AwsMetricHistoryPoint,
  ContainerConnectionProgressEvent,
  CoreEvent,
  RdpCertificatePrompt,
  RdpSessionEvent,
  VncSessionEvent,
  DesktopApi,
  DnsOverrideDraft,
  DnsOverrideResolvedRecord,
  SnippetRecord,
  SnippetDraft,
  FileEntry,
  GroupRemoveMode,
  GroupRecord,
  HostContainerDetails,
  HostContainerLogSearchResult,
  HostContainerLogsSnapshot,
  HostContainerRuntime,
  HostContainerStatsSample,
  HostContainerSummary,
  HostDraft,
  HostKeyProbeResult,
  HostRecord,
  HostSecretInput,
  KeyboardInteractiveHop,
  KeyboardInteractivePrompt,
  KnownHostRecord,
  PortForwardDraft,
  PortForwardRuleRecord,
  PortForwardRuntimeEvent,
  PortForwardRuntimeRecord,
  SessionShareChatEvent,
  SessionShareChatMessage,
  SessionShareEvent,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  SftpConnectionProgressEvent,
  SftpEndpointSummary,
  SftpPaneId,
  SftpPrincipal,
  SecretMetadataRecord,
  SshKeyGenerateInput,
  AiApiKeyStatus,
  AiAttachment,
  AiChatEvent,
  AiChatMessage,
  AiErrorPayload,
  AiProviderId,
  AiSearchBackend,
  AiTerminalSnapshotRef,
  AiTestConnectionInput,
  AiTestResult,
  CodexAuthStatus,
  CodexLoginStart,
  CodexModel,
  CodexUsage,
  SessionReplayStorageUsage,
  SshKeyInstallInput,
  SshKeyInstallResult,
  SshKeyMaterialResult,
  TabCommandPayload,
  TerminalConnectionHop,
  TerminalReconnectState,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput,
  TailnetStatus,
  RdpMonitorSelection,
} from "@shared";

export type SessionWorkspaceTabId = `session:${string}`;
export type SplitWorkspaceTabId = `workspace:${string}`;
/** tmux 세션 그룹 상단 탭 id. tmuxGroup.id 로 키잉(재연결에도 불변). */
export type TmuxSessionGroupTabId = `tmuxgrp:${string}`;
export type WorkspaceTabId =
  | "home"
  | "sftp"
  | "containers"
  | SessionWorkspaceTabId
  | SplitWorkspaceTabId
  | TmuxSessionGroupTabId;
export type HomeSection =
  | "hosts"
  | "portForwarding"
  | "snippets"
  | "logs"
  | "settings";
export type SettingsSection = "general" | "sftp" | "security" | "secrets" | "aws-profiles" | "tailnet" | "ai" | "account";
export type SftpSourceKind = "local" | "host";
export type WorkspaceDropDirection = "left" | "right" | "top" | "bottom";
export type HostDrawerState =
  | { mode: "closed" }
  | { mode: "create"; defaultGroupPath: string | null; kind: "ssh" | "serial" | "rdp" }
  | { mode: "edit"; hostId: string };

export interface WorkspaceLeafNode {
  id: string;
  kind: "leaf";
  sessionId: string;
  /**
   * tmux control mode pane이면 tmux 레이아웃이 지정한 정확한 칸 수(cols×rows).
   * 이 pane의 xterm을 컨테이너에 fit하지 않고 이 크기로 고정해 tmux와 1:1 일치시켜
   * 분할 시 리사이즈 진동(셰이크)을 없앤다. 비-tmux 분할 leaf면 undefined.
   */
  cols?: number;
  rows?: number;
}

export interface WorkspaceSplitNode {
  id: string;
  kind: "split";
  axis: "horizontal" | "vertical";
  ratio: number;
  first: WorkspaceLayoutNode;
  second: WorkspaceLayoutNode;
}

export type WorkspaceLayoutNode = WorkspaceLeafNode | WorkspaceSplitNode;

export interface WorkspaceTab {
  id: string;
  title: string;
  layout: WorkspaceLayoutNode;
  activeSessionId: string;
  /**
   * 브로드캐스트가 켜져 있는가. 켜져 있으면 이 워크스페이스의 연결된 pane 이 모두 참여하고,
   * `broadcastExcludedSessionIds` 에 든 것만 빠진다.
   */
  broadcastEnabled: boolean;
  /**
   * 브로드캐스트에서 뺀 pane.
   *
   * 참여를 "포함 목록"이 아니라 "제외 목록"으로 두는 이유: 켜면 전부 참여가 기본이고,
   * pane 이 새로 붙어도(분할·드래그) 따로 등록하지 않아도 자동으로 참여한다. 포함 목록이면
   * 새 pane 이 조용히 빠져 있어서 "왜 저기만 안 가지"가 된다.
   */
  broadcastExcludedSessionIds?: string[];
  /**
   * 잠깐 워크스페이스 전체로 키운 pane. null 이면 평소 분할 배치다.
   *
   * 레이아웃 트리는 건드리지 않는다 — 확대는 "보기"만 바꾸는 것이라, 풀면 원래 비율이
   * 그대로 돌아와야 한다. 트리를 고치면 되돌릴 정보가 사라진다.
   */
  zoomedSessionId?: string | null;
  /**
   * control mode(tmux -CC) workspace(=하나의 tmux window)면 어느 control 세션·window인지.
   * index/name 은 윈도우 바 라벨용(list-windows 응답에서 채워짐). 평시엔 null/undefined.
   */
  tmux?: {
    controlSessionId: string;
    windowId: string;
    index?: number;
    name?: string;
  } | null;
}

/**
 * tmux control 세션(=하나의 -CC 연결) 단위 핸들. 상단 탭 1개가 이 그룹 1개에 대응한다.
 * 윈도우들은 각자 WorkspaceTab(`tmux.controlSessionId` 로 이 그룹에 속함)으로 두고,
 * 그룹은 세션 식별·이름·활성 윈도우만 들고 있다. id 는 재연결로 controlSessionId 가
 * 바뀌어도 불변이라 상단 탭/activeWorkspaceTab 이 안정적으로 유지된다.
 */
// 원격 tmux 세션 한 개 요약(list-sessions 한 줄). 푸터/감지바 세션 메뉴에 쓴다.
export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
}

export interface TmuxSessionGroup {
  id: string;
  controlSessionId: string;
  sessionName: string;
  activeWorkspaceId: string;
  /** 이 control 세션이 붙은 호스트. 메뉴에서 새 세션 생성/전환(connectHost)에 쓴다. */
  hostId?: string | null;
  /** 원격 tmux 세션 목록(라이브; %sessions-changed 로 갱신). 세션 메뉴 표시용. */
  sessions?: TmuxSessionInfo[];
  /** keepalive round-trip(ms). 상단 tmux 그룹 탭 인디게이터의 RTT 표시. control 세션 단위. */
  lastRttMs?: number | null;
  /**
   * 자동 재연결 진행 상태(비정상 단절 시). null/undefined 면 정상 연결. control
   * 세션은 그룹 형성 시 탭이 사라지므로 재연결 상태를 그룹에 둔다(SSH 탭의 reconnect 와 대응).
   */
  reconnect?: TerminalReconnectState | null;
  /**
   * 직전 자동 재연결 시도가 만든 control 세션의 sessionId. 재연결 control 은
   * reconnectGroupId 경로로 tabStrip 에 들어가지 않아(화면엔 안 보임) 누적되지 않지만,
   * 진행/이벤트용으로 tabs 엔 남는다. 다음 시도 시작 시 이 (실패한) control 탭/attempt 를
   * tabs 에서 정리해 잔류를 막는 데 쓴다.
   */
  reconnectSessionId?: string | null;
  /**
   * 이 control 세션을 띄울 때 감지된 원격 tmux 버전("3.0a","2.6"). 자동 재연결 시
   * connectHost 에 다시 넘겨, 구버전(2.6~3.0)에서 입력 인코딩/refresh-client 방언이
   * 재연결 후에도 올바르게 유지되게 한다(없으면 코어가 최신 가정으로 폴백).
   */
  tmuxVersion?: string | null;
}

// tmux 명령 프롬프트 오버레이 상태(Ctrl-b : / $ / ,). 텍스트 입력이 필요한 명령에 쓴다.
export interface TmuxCommandPromptState {
  /** 명령을 보낼 pane 가상 sessionId. */
  sessionId: string;
  /** 'raw': 입력 그대로 tmux 명령 / 'rename-window'·'rename-session': 입력을 이름으로 사용. */
  mode: "raw" | "rename-window" | "rename-session";
  /** rename-window 대상 window id(@N). */
  windowId?: string;
  /** 입력창 초기값(예: 현재 윈도우 이름). */
  initialValue?: string;
}

export type DynamicTabStripItem =
  | {
      kind: "session";
      sessionId: string;
    }
  | {
      kind: "workspace";
      workspaceId: string;
    }
  | {
      kind: "tmux";
      tmuxGroupId: string;
    };

export type ContainersWorkspacePanel =
  | "overview"
  | "logs"
  | "metrics"
  | "tunnel";
export type ContainerLogsLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "malformed";
export type ContainerMetricsLoadState = "idle" | "loading" | "ready" | "error";
export type ContainerLogsSearchMode = "local" | "remote" | null;
export type HostContainersTabKind = "host-containers" | "ecs-cluster";
export type EcsDetailPanel = "overview" | "logs" | "metrics" | "tunnel";
export type LogsRangeMode = "recent" | "absolute";
export type LogsRelativePresetKey =
  | "30m"
  | "1h"
  | "6h"
  | "1d"
  | "3d"
  | "1w"
  | "custom";
export type LogsRelativeUnit =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export interface LogsAbsoluteRangeValue {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export interface LogsRelativeRangeValue {
  presetKey: LogsRelativePresetKey;
  amount: string;
  unit: LogsRelativeUnit;
}

export interface HostContainerLogsRefreshOptions {
  tail?: number;
  followCursor?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  rangeMode?: LogsRangeMode;
  relativeRange?: LogsRelativeRangeValue | null;
  absoluteRange?: LogsAbsoluteRangeValue | null;
}

export interface EcsServiceUtilizationHistoryState {
  cpuHistory: AwsMetricHistoryPoint[];
  memoryHistory: AwsMetricHistoryPoint[];
}

export interface EcsTunnelTabState {
  serviceName: string;
  taskArn: string | null;
  containerName: string | null;
  targetPort: string;
  bindPort: string;
  autoLocalPort: boolean;
  loading: boolean;
  error: string | null;
  runtime: PortForwardRuntimeRecord | null;
}

export interface ContainerTunnelTabState {
  containerId: string;
  containerName: string;
  networkName: string;
  targetPort: string;
  bindPort: string;
  autoLocalPort: boolean;
  loading: boolean;
  error: string | null;
  runtime: PortForwardRuntimeRecord | null;
}

export interface EcsServiceLogsViewState {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  snapshot: AwsEcsServiceLogsSnapshot | null;
  follow: boolean;
  query: string;
  taskArn: string | null;
  containerName: string | null;
  rangeMode: LogsRangeMode;
  relativeRange: LogsRelativeRangeValue;
  absoluteRange: LogsAbsoluteRangeValue | null;
}

export type EcsServiceLogsStateUpdater =
  | EcsServiceLogsViewState
  | ((previous: EcsServiceLogsViewState) => EcsServiceLogsViewState);

export interface HostContainersTabState {
  kind: HostContainersTabKind;
  hostId: string;
  lifecycleId: string | null;
  title: string;
  runtime: HostContainerRuntime | null;
  unsupportedReason: string | null;
  connectionProgress?: ContainerConnectionProgressEvent | null;
  // 다단 ProxyJump 연결 시 각 홉 진행(공통 오버레이 스텝). connectionHopProgress가 endpointId로 채운다.
  connectionHops?: TerminalConnectionHop[] | null;
  items: HostContainerSummary[];
  selectedContainerId: string | null;
  activePanel: ContainersWorkspacePanel;
  isLoading: boolean;
  errorMessage?: string;
  details: HostContainerDetails | null;
  detailsLoading: boolean;
  detailsError?: string;
  logs: HostContainerLogsSnapshot | null;
  logsState: ContainerLogsLoadState;
  logsLoading: boolean;
  logsError?: string;
  logsFollowEnabled: boolean;
  logsTailWindow: number;
  logsRangeMode: LogsRangeMode;
  logsRelativeRange: LogsRelativeRangeValue;
  logsAbsoluteRange: LogsAbsoluteRangeValue | null;
  logsSearchQuery: string;
  logsSearchMode: ContainerLogsSearchMode;
  logsSearchLoading: boolean;
  logsSearchError?: string;
  logsSearchResult: HostContainerLogSearchResult | null;
  metricsSamples: HostContainerStatsSample[];
  metricsState: ContainerMetricsLoadState;
  metricsLoading: boolean;
  metricsError?: string;
  pendingAction: "start" | "stop" | "restart" | "remove" | null;
  actionError?: string;
  containerTunnelStatesByContainerId: Record<string, ContainerTunnelTabState>;
  ecsSnapshot: AwsEcsClusterSnapshot | null;
  ecsMetricsWarning?: string | null;
  ecsMetricsLoadedAt?: string | null;
  ecsMetricsLoading: boolean;
  ecsUtilizationHistoryByServiceName: Record<
    string,
    EcsServiceUtilizationHistoryState
  >;
  ecsLogsByServiceName: Record<string, EcsServiceLogsViewState>;
  ecsSelectedServiceName: string | null;
  ecsActivePanel: EcsDetailPanel;
  ecsTunnelStatesByServiceName: Record<string, EcsTunnelTabState>;
}

export interface SftpPaneState {
  id: SftpPaneId;
  sourceKind: SftpSourceKind;
  endpoint: SftpEndpointSummary | null;
  connectingHostId?: string | null;
  connectingEndpointId?: string | null;
  connectionProgress?: SftpConnectionProgressEvent | null;
  connectionDiagnostic?: SftpConnectionProgressEvent | null;
  // 다단 ProxyJump 연결 시 각 홉 진행(공통 오버레이 스텝). connectionHopProgress가 endpointId로 채운다.
  connectionHops?: TerminalConnectionHop[] | null;
  hostGroupPath: string | null;
  currentPath: string;
  lastLocalPath: string;
  history: string[];
  historyIndex: number;
  entries: FileEntry[];
  selectedPaths: string[];
  selectionAnchorPath: string | null;
  filterQuery: string;
  selectedHostId: string | null;
  hostSearchQuery: string;
  isLoading: boolean;
  errorMessage?: string;
  warningMessages?: string[];
}

export interface SftpEntrySelectionInput {
  entryPath: string | null;
  visibleEntryPaths?: string[];
  toggle?: boolean;
  range?: boolean;
}

export interface SftpOwnershipChangeInput {
  owner?: string;
  group?: string;
  uid?: number;
  gid?: number;
  recursive?: boolean;
  sudoPassword?: string;
}

export interface PendingConflictDialog {
  input: TransferStartInput;
  names: string[];
}

export interface PendingHostKeyPrompt {
  sessionId?: string | null;
  probe: HostKeyProbeResult;
  /**
   * 연결이 이 창의 답을 기다리고 있으면 그 질의 ID.
   *
   * 있으면 수락·거절이 **코어로 답을 보내는 것**이다 — 다시 연결하지 않는다(연결은 이미 그 자리에서
   * 기다린다). 없으면 예전 흐름이다: 신뢰를 저장한 뒤 action 으로 연결을 시작한다.
   *
   * 이 구분이 필요한 이유: 키를 미리 읽어 오는 별도 연결(프로브)을 없애면서, 처음 보는 호스트에서
   * 인증을 두 번 요구하던 문제를 없앴다. OTP 는 30초마다 바뀌어 두 번 넣을 수 없다.
   */
  liveChallengeId?: string | null;
  action:
    | {
        kind: "ssh";
        hostId: string;
        cols: number;
        rows: number;
        secrets?: HostSecretInput;
      }
    | {
        kind: "sftp";
        paneId: SftpPaneId;
        hostId: string;
        endpointId: string;
        secrets?: HostSecretInput;
      }
    | {
        kind: "terminalUpload";
        hostId: string;
        endpointId: string;
        targetPath: string | null;
        localPaths: string[];
      }
    | {
        kind: "portForward";
        ruleId: string;
        hostId: string;
      }
    | {
        kind: "containers";
        hostId: string;
      }
    | {
        kind: "containerShell";
        hostId: string;
        containerId: string;
      }
    | {
        /**
         * VNC 세션이 경유할 SSH 호스트를 신뢰하는 중.
         *
         * `hostId` 는 **VNC 호스트**다(경유 SSH 호스트가 아니다) — 수락한 뒤 이어갈 것이 VNC
         * 접속이기 때문이다. 신뢰 대상은 프롬프트의 probe 가 이미 들고 있다.
         */
        kind: "vnc";
        hostId: string;
      };
}

export interface PendingCredentialRetry {
  sessionId?: string | null;
  hostId: string;
  source: "ssh" | "sftp";
  authType: Extract<AuthType, "password" | "privateKey" | "certificate">;
  message: string;
  initialUsername: string;
  paneId?: SftpPaneId;
}

export interface PendingCredentialRetryAttempt {
  sessionId?: string | null;
  hostId: string;
  source: "ssh" | "sftp";
  paneId?: SftpPaneId;
  originalUsername: string;
  attemptedUsername: string;
}

export interface CredentialRetryInput extends HostSecretInput {
  username: string;
}

export interface PendingAwsSftpConfigRetry {
  hostId: string;
  paneId: SftpPaneId;
  message: string;
  suggestedUsername: string;
  suggestedPort: number;
}

export interface PendingMissingUsernamePrompt {
  hostId: string;
  source: "ssh" | "sftp" | "containers" | "containerShell" | "portForward";
  cols?: number;
  rows?: number;
  secrets?: HostSecretInput;
  paneId?: SftpPaneId;
  containerId?: string;
  ruleId?: string;
}

export interface PendingStartupCommandPrompt {
  hostId: string;
  cols: number;
  rows: number;
  secrets?: HostSecretInput;
  snippetId: string;
  command: string;
  variables: Array<{ name: string; defaultValue: string }>;
}

interface PendingInteractiveAuthBase {
  sessionId: string;
  challengeId: string;
  name?: string | null;
  instruction: string;
  prompts: KeyboardInteractivePrompt[];
  provider: "generic" | "warpgate";
  approvalUrl?: string | null;
  authCode?: string | null;
  autoSubmitted: boolean;
  /**
   * 이 연결에 저장된 비밀번호가 있는지. 참이면 인증 창이 칸마다 "저장된 비밀번호 사용" 을 내민다.
   * 값은 코어 밖으로 나오지 않으므로, 누르면 그 칸의 인덱스만 코어로 돌아간다.
   */
  hasStoredPassword?: boolean;
  /**
   * 이 프롬프트를 낸 홉. 점프 체인에서 누구의 코드를 묻는지 화면이 말할 수 있게 한다 — 없으면
   * 베스천과 최종 대상의 "Verification code:" 가 구분되지 않는다.
   */
  hop?: KeyboardInteractiveHop | null;
  /**
   * 답을 코어에 전달하지 못한 이유. 카드에 그대로 보여 준다.
   *
   * 이것이 없으면 "응답 보내기" 가 아무 반응 없는 버튼이 된다 — 요청이 이미 끝나서 받을 곳이
   * 없을 때 조용히 실패했었다.
   */
  deliveryError?: string | null;
}

export interface PendingSessionInteractiveAuth
  extends PendingInteractiveAuthBase {
  source: "ssh";
}

export interface PendingSftpInteractiveAuth
  extends Omit<PendingInteractiveAuthBase, "sessionId"> {
  source: "sftp";
  endpointId: string;
  paneId: SftpPaneId;
  hostId: string;
}

export interface PendingContainersInteractiveAuth
  extends Omit<PendingInteractiveAuthBase, "sessionId"> {
  source: "containers";
  endpointId: string;
  hostId: string;
}

export interface PendingPortForwardInteractiveAuth
  extends Omit<PendingInteractiveAuthBase, "sessionId"> {
  source: "portForward";
  endpointId: string;
  ruleId: string;
  hostId: string;
}

/**
 * VNC 세션의 경유 터널이 묻는 인증.
 *
 * 두 ID 를 다 갖는 유일한 종류다. **답은 endpointId 로** 보내야 한다(터널을 여는 것은 포워딩
 * 서비스라 코어의 대기표가 그 ID 에 걸려 있다). **카드는 sessionId 로** 그린다 — VNC 탭 위에
 * 띄워야 사용자가 본다. 하나만 들고 있으면 답이 사라지거나 카드가 사라진다.
 */
export interface PendingVncTunnelInteractiveAuth
  extends PendingInteractiveAuthBase {
  source: "vncTunnel";
  endpointId: string;
  sessionId: string;
  hostId: string;
}

/**
 * 공개 키 설치가 묻는 인증.
 *
 * 설치는 탭도 엔드포인트도 만들지 않아서 붙일 화면이 없었다 — 코어는 물을 곳이 없으니 그냥
 * "responder is not configured" 로 끝냈고, OTP 나 비밀번호를 묻는 호스트에는 키를 올릴 수
 * 없었다. sessionId 에 `keyinstall:<hostId>` 를 실어 그 대화상자를 찾는다
 * (@shared 의 KEY_INSTALL_CORRELATION_PREFIX).
 */
export interface PendingKeyInstallInteractiveAuth
  extends PendingInteractiveAuthBase {
  source: "keyInstall";
  sessionId: string;
  hostId: string;
}

/** 진행 중인 연결 하나의 상태. 경로를 가리지 않는다. */
export interface ConnectionView {
  /** 상관 ID — sessionId 또는 endpointId. */
  key: string;
  status: "connecting" | "connected" | "error";
  /** 코어가 보고한 세부 단계. 단계 화면이 이것으로 관문을 칠한다. */
  stage?: string | null;
  /** 실패 문구(있으면). */
  message?: string | null;
  /** 다단 점프의 홉별 진행. */
  hops: TerminalConnectionHop[];
  /** 이 연결이 붙는 호스트. 단계 화면이 tailnet 여부·이름을 여기서 찾는다. */
  hostId?: string | null;
  /** 서버가 인증 단계에 보낸 배너. 승인 링크가 여기 실려 온다. */
  banner?: string | null;
}

export type PendingInteractiveAuth =
  | PendingSessionInteractiveAuth
  | PendingKeyInstallInteractiveAuth
  | PendingSftpInteractiveAuth
  | PendingContainersInteractiveAuth
  | PendingPortForwardInteractiveAuth
  | PendingVncTunnelInteractiveAuth;

export interface PendingConnectionAttempt {
  sessionId: string;
  source: "host" | "local" | "container-shell" | "ecs-shell";
  hostId: string | null;
  title: string;
  latestCols: number;
  latestRows: number;
  containerId?: string;
  serviceName?: string;
  taskArn?: string;
  containerName?: string;
  /** control mode(tmux -CC)로 연결할 attempt면 true. startPendingSessionConnect가 api.ssh.connect에 tmux를 넘긴다. */
  tmux?: boolean;
  /** 특정 tmux 세션 attach 등, control mode 진입 시 쓸 원격 tmux 명령. tmux=true 일 때만 의미가 있다. */
  tmuxCommand?: string;
  /** 감지된 원격 tmux 버전("3.0a","2.6"). 코어가 버전별 입력 인코딩/refresh-client 방언을 고르게 한다. tmux=true 일 때만 의미. */
  tmuxVersion?: string;
}

export interface SessionReturnTarget {
  activeWorkspaceTab: WorkspaceTabId;
  homeSection?: HomeSection;
  settingsSection?: SettingsSection;
  activeContainerHostId?: string | null;
}

export interface SftpState {
  localHomePath: string;
  leftPane: SftpPaneState;
  rightPane: SftpPaneState;
  transfers: TransferJob[];
  pendingConflictDialog: PendingConflictDialog | null;
  // 터미널 파일 드롭(SFTP 업로드)용 백그라운드 endpoint를 hostId별로 캐시한다.
  // SFTP 패널 UI와 무관하게 재사용해 중복 연결과 워크스페이스 전환을 막는다.
  terminalUploadEndpoints: Record<string, SftpEndpointSummary>;
}

// 터미널 파일 드롭 업로드 결과. 드롭 핸들러가 토스트 피드백에 사용한다.
export type TerminalUploadResult =
  | {
      ok: true;
      job: TransferJob;
      hostLabel: string;
      targetPath: string;
      /** cwd를 못 찾아 홈(endpoint 루트)으로 업로드한 경우 true. */
      usedHomeFallback: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      reason:
        | "unsupported"
        | "connect-failed"
        | "no-items"
        | "awaiting-host-trust";
      message?: string;
    };

interface AppStateParts {
  hosts: HostRecord[];
  groups: GroupRecord[];
  tabs: TerminalTab[];
  sessionShareChatNotifications: Record<string, SessionShareChatMessage[]>;
  workspaces: WorkspaceTab[];
  tmuxGroups: TmuxSessionGroup[];
  tmuxCommandPrompt: TmuxCommandPromptState | null;
  containerTabs: HostContainersTabState[];
  activeContainerHostId: string | null;
  tabStrip: DynamicTabStripItem[];
  portForwards: PortForwardRuleRecord[];
  dnsOverrides: DnsOverrideResolvedRecord[];
  snippets: SnippetRecord[];
  portForwardRuntimes: PortForwardRuntimeRecord[];
  knownHosts: KnownHostRecord[];
  activityLogs: ActivityLogRecord[];
  keychainEntries: SecretMetadataRecord[];
  activeWorkspaceTab: WorkspaceTabId;
  homeSection: HomeSection;
  settingsSection: SettingsSection;
  savedCredentialsSearchQuery: string;
  hostDrawer: HostDrawerState;
  currentGroupPath: string | null;
  searchQuery: string;
  selectedHostTags: string[];
  settings: AppSettings;
  isReady: boolean;
  sftp: SftpState;
  pendingHostKeyPrompt: PendingHostKeyPrompt | null;
  /**
   * 지금 보여 주는 것 뒤에 줄 선 신뢰 물음들.
   *
   * 슬롯이 하나뿐이던 시절에는 새 물음이 앞의 것을 덮었고, 덮인 물음은 아무도 답할 수 없어 그
   * 연결이 예산(5분)이 다 될 때까지 "연결 중…"에 앉아 있었다. 세션을 여러 개 복원하거나 같은
   * 베스천 뒤의 호스트를 한꺼번에 열면 실제로 겹친다(store/utils/host-key-prompts.ts).
   */
  queuedHostKeyPrompts: PendingHostKeyPrompt[];
  /**
   * 진행 중인 연결들의 공통 진행 상태. 열쇠는 상관 ID(sessionId 또는 endpointId)다.
   *
   * 코어는 모든 경로에 같은 이벤트를 올리는데(홉 진행·배너·신뢰·대화형 인증) 그것을 받는 자리가
   * 경로마다 따로여서, 자리가 없는 포워딩·공개키 설치는 통째로 버려졌다 — 시작해도 tailnet 도
   * 점프도 아무것도 안 보였다. 여기 모아 두면 어느 화면이든 같은 것을 그린다
   * (store/utils/connection-views.ts).
   */
  connectionViews: Record<string, ConnectionView>;
  /** 진행 팝업을 닫는다. 실패한 뷰는 스스로 사라지지 않으므로 사용자가 닫을 길이 있어야 한다. */
  dismissConnectionView: (key: string) => void;
  /**
   * 사용자의 판단을 기다리는 RDP 서버 인증서. 없으면 null.
   *
   * **왜 스토어에 두는가:** 프롬프트를 그리는 곳(RdpSessionCanvas)과 그동안 자기를 내려야 하는
   * 곳(RdpConnectionOverlay)이 형제 컴포넌트라 서로의 로컬 state 를 볼 수 없다. 각자 이벤트를
   * 구독하면 "사용자가 눌렀다"는 사실은 누른 쪽만 알아서, 수락한 뒤에도 연결 화면이 계속 숨은 채
   * 남는다. 한 곳에 두고 둘이 읽는다 — SSH 의 pendingHostKeyPrompt 와 같은 이유다.
   */
  pendingRdpCertificatePrompt: RdpCertificatePrompt | null;
  setPendingRdpCertificatePrompt: (prompt: RdpCertificatePrompt | null) => void;
  /**
   * tailnet 별 최신 상태. 화면들이 여기만 읽어서 서로 다른 말을 하지 않게 한다.
   *
   * 노드는 tailnet 단위로 공유되므로 상태도 하나다 — 설정에서 시작한 연결의 진행을 터미널
   * 화면도 봐야 하고, 그 반대도 마찬가지다.
   */
  tailnetStatuses: Record<string, TailnetStatus>;
  /** 이 기기가 tailnet 에 등록될 때 쓰는 이름. 기기 목록에서 자기를 찾는 단서다. */
  localTailnetNodeName: string | null;
  pendingCredentialRetry: PendingCredentialRetry | null;
  activeCredentialRetryAttempt: PendingCredentialRetryAttempt | null;
  pendingAwsSftpConfigRetry: PendingAwsSftpConfigRetry | null;
  pendingMissingUsernamePrompt: PendingMissingUsernamePrompt | null;
  pendingStartupCommandPrompt: PendingStartupCommandPrompt | null;
  /**
   * 지금 답을 기다리는 대화형 인증들. **대상(세션·엔드포인트)마다 하나씩** 담는다.
   *
   * 예전에는 앱 전체에 슬롯이 하나였다. 그래서 두 번째 챌린지가 오면 먼저 뜬 카드가 사라지고,
   * 그 연결은 아무 표시 없이 영원히 기다렸다 — 실기기에서 터미널 연결이 "추가 인증 응답이
   * 필요합니다" 만 띄운 채 멈춘 원인이다. 화면은 자기 대상의 것을 골라 그린다(utils 의
   * findSessionPendingInteractiveAuth·findEndpointPendingInteractiveAuth).
   */
  pendingInteractiveAuths: PendingInteractiveAuth[];
  pendingConnectionAttempts: PendingConnectionAttempt[];
  resolvedStartupCommandsBySessionId: Record<string, string>;
  sessionReturnTargets: Record<string, SessionReturnTarget>;
  setSearchQuery: (value: string) => void;
  setSavedCredentialsSearchQuery: (value: string) => void;
  toggleHostTag: (tag: string) => void;
  clearHostTagFilter: () => void;
  activateHome: () => void;
  activateSftp: () => void;
  activateSession: (sessionId: string) => void;
  activateWorkspace: (workspaceId: string) => void;
  /** tmux 세션 그룹 상단 탭을 활성화한다(activeWorkspaceTab = tmuxgrp:groupId). */
  activateTmuxGroup: (tmuxGroupId: string) => void;
  activateContainers: () => void;
  focusHostContainersTab: (hostId: string) => void;
  openHomeSection: (section: HomeSection) => void;
  openSettingsSection: (section: SettingsSection) => void;
  openCreateHostDrawer: () => void;
  openEditHostDrawer: (hostId: string) => void;
  closeHostDrawer: () => void;
  navigateGroup: (path: string | null) => void;
  bootstrap: () => Promise<void>;
  refreshHostCatalog: () => Promise<void>;
  refreshOperationalData: () => Promise<void>;
  refreshSyncedWorkspaceData: () => Promise<void>;
  clearSyncedWorkspaceData: () => void;
  createGroup: (name: string, parentPath?: string | null) => Promise<void>;
  removeGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  moveGroup: (path: string, targetParentPath: string | null) => Promise<void>;
  renameGroup: (path: string, name: string) => Promise<void>;
  /**
   * 직접 정렬에서 그룹을 옮긴다. 부모가 바뀌면 이동까지 함께 처리한다.
   *
   * `targetIndex` 는 **옮긴 뒤** 그 형제 목록에서 있어야 할 자리다(화면에 보이는 순서 기준).
   */
  reorderGroup: (
    path: string,
    targetParentPath: string | null,
    targetIndex: number,
  ) => Promise<void>;
  saveHost: (
    hostId: string | null,
    draft: HostDraft,
    secrets?: HostSecretInput,
  ) => Promise<HostRecord>;
  duplicateHosts: (hostIds: string[]) => Promise<void>;
  moveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  setHostFavorite: (hostId: string, favorite: boolean) => Promise<void>;
  /** 이 호스트의 터미널 테마만 바꾼다. null 은 앱 설정을 따른다는 뜻. */
  setHostTerminalTheme: (
    hostId: string,
    terminalThemeId: TerminalThemeId | null,
  ) => Promise<void>;
  /**
   * 연결할 때 감지한 운영체제를 기록한다(호스트 아이콘용).
   *
   * 같은 값이면 메인이 아무것도 쓰지 않으므로 여기서 비교하지 않는다.
   */
  setHostDetectedOs: (
    hostId: string,
    detectedOs: HostDetectedOs | null,
  ) => Promise<void>;
  removeHost: (hostId: string) => Promise<void>;
  openLocalTerminal: (cols: number, rows: number) => Promise<void>;
  connectHost: (
    hostId: string,
    cols: number,
    rows: number,
    secrets?: HostSecretInput,
    tmux?: boolean,
    tmuxCommand?: string,
    /**
     * 새 세션이 물려받을 탭 자리 — 지정한 세션의 탭을 없애고 그 자리에 새 탭이 들어선다
     * ("현재 화면에서 진행"). 호스트 레벨 연결처럼 원 세션이 없으면 생략한다.
     *
     * `tmux=true`(control mode) **또는 `startupCommandOverride` 를 준 passthrough** 에서만
     * 듣는다 — 평범한 연결에 실수로 넘어와 남의 탭을 닫지 않게 구현에서 그 두 경우만
     * 통과시킨다(sessionSlice 의 connectHost 참고). 옛 tmux(2.6 미만)를 일반 SSH 로 띄우는
     * 경로가 두 번째 경우다.
     */
    replaceSessionId?: string,
    /**
     * tmux 자동 재연결 전용. 지정하면 새 control 세션을 standalone 탭(tabStrip)으로
     * 만들지 않고, 이 그룹으로 흡수될 때까지 화면 밖(tabs/pending)에만 둔다. 그래서
     * 재연결 시 별도 SSH 탭이 보이거나 시도마다 쌓이지 않는다(슬롯 식별을 휘발성
     * sessionId 가 아니라 group.id 로 안정화). tmux=true 일 때만 의미가 있다.
     */
    reconnectGroupId?: string,
    /**
     * 감지된 원격 tmux 버전("3.0a","2.6"). 코어가 버전별 입력 인코딩(-H vs -l+키이름)·
     * refresh-client 방언(콤마 vs WxH)을 고르는 데 쓴다. tmux=true 일 때만 의미가 있다.
     */
    tmuxVersion?: string,
    /**
     * 호스트 설정의 startupCommand 대신 쓸 일회성 startup 명령. control mode floor(2.6)
     * 미만 tmux 를 passthrough(일반 SSH 세션)로 띄울 때, 접속 직후 셸에 호환 attach-or-create
     * 명령("tmux attach || tmux new")을 자동 입력하는 데 쓴다. 지정하면 tmux 는 무시한다.
     */
    startupCommandOverride?: string,
  ) => Promise<void>;
  retrySessionConnection: (
    sessionId: string,
    secrets?: HostSecretInput,
  ) => Promise<void>;
  /** RDP 세션을 같은 탭에 다시 붙인다. 재연결 오케스트레이터와 오버레이의 재시도가 쓴다. */
  retryRdpConnection: (sessionId: string) => Promise<void>;
  /** VNC 세션을 같은 탭에 다시 붙인다(재연결 시도 횟수를 유지한다). */
  retryVncConnection: (sessionId: string) => Promise<void>;
  startSessionShare: (input: SessionShareStartInput) => Promise<void>;
  updateSessionShareSnapshot: (
    input: SessionShareSnapshotInput,
  ) => Promise<void>;
  setSessionShareInputEnabled: (
    sessionId: string,
    inputEnabled: boolean,
  ) => Promise<void>;
  stopSessionShare: (sessionId: string) => Promise<void>;
  disconnectTab: (sessionId: string) => Promise<void>;
  cancelSessionReconnect: (sessionId: string) => void;
  closeWorkspace: (workspaceId: string) => Promise<void>;
  /** Cmd+W: 활성 동적 탭을 닫는다. 닫을 탭이 없으면(home/sftp/containers) false. */
  closeActiveTab: () => boolean;
  /** 메뉴 탭 단축키(다음/이전/번호/마지막/닫은탭 다시 열기) 처리. */
  runTabCommand: (payload: TabCommandPayload) => void;
  openHostContainersTab: (hostId: string) => Promise<void>;
  closeHostContainersTab: (hostId: string) => Promise<void>;
  reorderContainerTab: (
    sourceHostId: string,
    targetHostId: string,
    placement: "before" | "after",
  ) => void;
  refreshHostContainers: (hostId: string) => Promise<void>;
  refreshEcsClusterUtilization: (hostId: string) => Promise<void>;
  loginAwsProfileForEcsHost: (hostId: string) => Promise<void>;
  selectHostContainer: (
    hostId: string,
    containerId: string | null,
  ) => Promise<void>;
  setHostContainersPanel: (
    hostId: string,
    panel: ContainersWorkspacePanel,
  ) => void;
  setHostContainerTunnelState: (
    hostId: string,
    containerId: string,
    state: ContainerTunnelTabState | null,
  ) => void;
  setEcsClusterSelectedService: (
    hostId: string,
    serviceName: string | null,
  ) => void;
  setEcsClusterActivePanel: (hostId: string, panel: EcsDetailPanel) => void;
  setEcsClusterTunnelState: (
    hostId: string,
    serviceName: string,
    state: EcsTunnelTabState | null,
  ) => void;
  setEcsClusterLogsState: (
    hostId: string,
    serviceName: string,
    state: EcsServiceLogsStateUpdater | null,
  ) => void;
  refreshHostContainerLogs: (
    hostId: string,
    options?: HostContainerLogsRefreshOptions,
  ) => Promise<void>;
  loadMoreHostContainerLogs: (hostId: string) => Promise<void>;
  setHostContainerLogsFollow: (hostId: string, enabled: boolean) => void;
  setHostContainerLogsSearchQuery: (hostId: string, query: string) => void;
  searchHostContainerLogs: (hostId: string) => Promise<void>;
  clearHostContainerLogsSearch: (hostId: string) => void;
  refreshHostContainerStats: (hostId: string) => Promise<void>;
  runHostContainerAction: (
    hostId: string,
    action: "start" | "stop" | "restart" | "remove",
  ) => Promise<void>;
  openHostContainerShell: (hostId: string, containerId: string) => Promise<void>;
  openEcsExecShell: (
    hostId: string,
    serviceName: string,
    taskArn: string,
    containerName: string,
  ) => Promise<void>;
  splitSessionIntoWorkspace: (
    sessionId: string,
    direction: WorkspaceDropDirection,
    targetSessionId?: string,
  ) => boolean;
  moveWorkspaceSession: (
    workspaceId: string,
    sessionId: string,
    direction: WorkspaceDropDirection,
    targetSessionId: string,
  ) => boolean;
  detachSessionFromWorkspace: (workspaceId: string, sessionId: string) => void;
  reorderDynamicTab: (
    source: DynamicTabStripItem,
    target: DynamicTabStripItem,
    placement: "before" | "after",
  ) => void;
  focusWorkspaceSession: (workspaceId: string, sessionId: string) => void;
  /**
   * tmux 서버의 active pane 변경(%window-pane-changed)을 로컬 포커스에 반영한다.
   * select-pane 을 재전송하지 않아 키보드 pane 이동의 포커스 동기화에 쓴다.
   */
  applyTmuxActivePane: (controlSessionId: string, paneId: string) => void;
  /** tmux 명령 프롬프트(Ctrl-b : / $ / ,) 오버레이를 연다. */
  openTmuxCommandPrompt: (spec: TmuxCommandPromptState) => void;
  /** tmux 명령 프롬프트를 닫는다. */
  closeTmuxCommandPrompt: () => void;
  /**
   * tmux workspace(=control mode window)에서 새 tmux window 를 만든다(new-window).
   * 일반(비 tmux) workspace 면 아무 것도 하지 않는다. 결과 window 는 이어 오는
   * tmuxWindowAdd / tmuxLayoutChange 이벤트가 새 workspace 로 반영한다.
   */
  tmuxNewWindowInWorkspace: (workspaceId: string) => void;
  /**
   * tmux control mode workspace 를 detach 한다 — 서버의 tmux 세션·프로세스는 살린 채
   * control 채널(detach-client)만 분리하고 로컬 워크스페이스/탭만 제거한다. pane 을
   * kill 하지 않으므로 재접속(attach)으로 그대로 복원된다. 비 tmux workspace 면 무시.
   * closeWorkspace(=kill: kill-pane 으로 세션째 종료)와 의도가 반대다.
   */
  detachTmuxWorkspace: (workspaceId: string) => Promise<void>;
  /** tmux window-close/exit 후 로컬 workspace·pane 탭 정리(명령 미전송). windowId 생략 시 controlSessionId 전체. 윈도우가 모두 사라지면 그룹/상단탭도 제거. */
  removeTmuxWorkspacesLocal: (controlSessionId: string, windowId?: string) => void;
  /** 자동 재연결 진행 표시: 그룹의 reconnect 요약 + 패인 탭을 'connecting'(재연결 중)으로. */
  applyTmuxGroupReconnecting: (
    groupId: string,
    summary: TerminalReconnectState,
    message: string,
  ) => void;
  /** 자동 재연결 포기/끊김 확정: 그룹 reconnect 해제 + 패인 탭을 'error'(수동 재시도)로. */
  applyTmuxGroupReconnectGaveUp: (groupId: string, message: string) => void;
  /** 셸 통합(OSC 133) 마커로 탭의 명령 상태(실행 중/성공/실패)를 갱신한다. 탭 점 하이브리드용. */
  applyTabCommandState: (
    sessionId: string,
    state: "running" | "ok" | "failed" | null,
  ) => void;
  /** 그룹 내에서 활성 tmux window 를 전환한다(select-window + group.activeWorkspaceId). */
  selectTmuxWindow: (workspaceId: string) => void;
  /** tmux window 이름을 바꾼다(rename-window). 결과는 %window-renamed 로 되돌아온다. */
  renameTmuxWindow: (workspaceId: string, name: string) => void;
  /** %window-renamed 수신 시 해당 window WorkspaceTab 의 이름을 반영한다. */
  applyTmuxWindowRenamed: (
    controlSessionId: string,
    windowId: string,
    name: string,
  ) => void;
  /** %session-changed 수신 시 세션 그룹 푸터의 세션명을 실제 tmux 세션명으로 갱신한다. */
  applyTmuxSessionName: (controlSessionId: string, sessionName: string) => void;
  /** %sessions-changed 수신 시 그 control 세션 그룹의 원격 세션 목록을 갱신한다(메뉴용). */
  applyTmuxSessionsList: (
    controlSessionId: string,
    sessions: TmuxSessionInfo[],
  ) => void;
  /** tmux 세션 전체를 종료한다(kill-session). sessionId 는 그 control 세션의 pane id. */
  killTmuxSession: (sessionId: string, sessionName: string) => void;
  /**
   * pane 하나의 브로드캐스트 참여를 토글한다.
   *
   * 꺼져 있으면 **전부 켠다**(제외 목록을 비운다) — "다 같이 치기"가 압도적으로 흔한 쓰임이라
   * 한 번에 되게 한다. 켜져 있을 때 참여 중인 pane 을 누르면 그 pane 만 빠지고, 빠져 있던
   * pane 을 누르면 다시 들어온다. 참여가 2개 미만이 되면 브로드캐스트 자체를 끈다 —
   * 혼자 남은 브로드캐스트는 켜져 있어도 하는 일이 없는데 켜진 표시만 남는다.
   */
  toggleSessionBroadcast: (workspaceId: string, sessionId: string) => void;
  /** pane 확대 토글. 이미 그 pane 이 확대 중이면 해제한다. */
  toggleWorkspaceZoom: (workspaceId: string, sessionId: string) => void;
  resizeWorkspaceSplit: (
    workspaceId: string,
    splitId: string,
    ratio: number,
  ) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (input: Partial<AppSettings>) => Promise<void>;
  notifyCommandFinished: (
    info: CommandFinishedInfo,
    context: { visibleToUser: boolean; hostLabel: string },
  ) => void;
  savePortForward: (
    ruleId: string | null,
    draft: PortForwardDraft,
  ) => Promise<void>;
  saveDnsOverride: (
    overrideId: string | null,
    draft: DnsOverrideDraft,
  ) => Promise<void>;
  setStaticDnsOverrideActive: (
    overrideId: string,
    active: boolean,
  ) => Promise<void>;
  removeDnsOverride: (overrideId: string) => Promise<void>;
  saveSnippet: (
    snippetId: string | null,
    draft: SnippetDraft,
  ) => Promise<SnippetRecord>;
  removeSnippet: (snippetId: string) => Promise<void>;
  removePortForward: (ruleId: string) => Promise<void>;
  startPortForward: (ruleId: string) => Promise<void>;
  stopPortForward: (ruleId: string) => Promise<void>;
  removeKnownHost: (id: string) => Promise<void>;
  /**
   * RDP 서버 인증서 신뢰를 해제한다. 다음 접속에서 다시 확인한다.
   *
   * 이 신뢰는 known_hosts 가 아니라 호스트 레코드(`certificateFingerprint`)에 있다 — 그래서
   * 목록·해제도 호스트를 통해 한다.
   */
  revokeRdpCertificateTrust: (hostId: string) => Promise<void>;
  clearLogs: () => Promise<void>;
  removeKeychainSecret: (secretRef: string) => Promise<void>;
  updateKeychainSecret: (
    secretRef: string,
    secrets: HostSecretInput,
    label?: string,
  ) => Promise<void>;
  cloneKeychainSecretForHost: (
    hostId: string,
    sourceSecretRef: string,
    secrets: HostSecretInput,
    label?: string,
  ) => Promise<void>;
  generateSshKey: (input: SshKeyGenerateInput) => Promise<SshKeyMaterialResult>;
  copySshPublicKey: (secretRef: string) => Promise<void>;
  installSshPublicKey: (
    input: SshKeyInstallInput,
  ) => Promise<SshKeyInstallResult>;
  loadSessionReplayStorageUsage: () => Promise<SessionReplayStorageUsage>;
  testAiConnection: (input: AiTestConnectionInput) => Promise<AiTestResult>;
  setAiApiKey: (providerId: AiProviderId, key: string) => Promise<AiApiKeyStatus>;
  clearAiApiKey: (providerId: AiProviderId) => Promise<AiApiKeyStatus>;
  getAiApiKeyStatus: (providerId: AiProviderId) => Promise<AiApiKeyStatus>;
  getAiSearchKeyStatus: (backend: AiSearchBackend) => Promise<AiApiKeyStatus>;
  setAiSearchKey: (backend: AiSearchBackend, key: string) => Promise<AiApiKeyStatus>;
  clearAiSearchKey: (backend: AiSearchBackend) => Promise<AiApiKeyStatus>;
  codexLoginStart: () => Promise<CodexLoginStart>;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  codexLogout: () => Promise<void>;
  getCodexUsage: () => Promise<CodexUsage>;
  listCodexModels: () => Promise<CodexModel[]>;
  openExternalUrl: (url: string) => Promise<void>;
  /**
   * 신뢰 물음에 답한다. sessionId 를 주면 그 탭의 물음을, 없으면 지금 보여 주는 것을 대상으로 한다.
   *
   * 지목이 필요한 이유: 세션이 있는 물음은 각자 자기 판에서 답하므로, 탭 세 개가 동시에 물으면
   * "지금 보여 주는 것" 이 답한 대상이라는 보장이 없다.
   */
  acceptPendingHostKeyPrompt: (
    mode: "trust" | "replace",
    sessionId?: string,
  ) => Promise<void>;
  dismissPendingHostKeyPrompt: (sessionId?: string) => void;
  dismissPendingCredentialRetry: () => void;
  submitCredentialRetry: (input: CredentialRetryInput) => Promise<void>;
  dismissPendingAwsSftpConfigRetry: () => void;
  submitAwsSftpConfigRetry: (input: {
    username: string;
    port: number;
  }) => Promise<void>;
  dismissPendingMissingUsernamePrompt: () => void;
  submitMissingUsernamePrompt: (input: { username: string }) => Promise<void>;
  confirmStartupCommandPrompt: (values: Record<string, string>) => Promise<void>;
  cancelStartupCommandPrompt: () => void;
  respondInteractiveAuth: (
    challengeId: string,
    responses: string[],
    /** 저장된 비밀번호로 채울 칸(프롬프트 인덱스). 값이 아니라 인덱스만 보낸다 — 코어가 채운다. */
    storedPasswordIndexes?: number[],
  ) => Promise<void>;
  /**
   * 승인 링크를 다시 연다. challengeId 를 주면 그 요청의 것, 안 주면 링크가 있는 첫 요청의 것이다.
   */
  reopenInteractiveAuthUrl: (challengeId?: string) => Promise<void>;
  /** 인증 카드를 내린다. challengeId 를 주면 그것만, 안 주면 전부. */
  clearPendingInteractiveAuth: (challengeId?: string) => void;
  updatePendingConnectionSize: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => void;
  markSessionOutput: (sessionId: string, chunk?: Uint8Array) => void;
  handleCoreEvent: (event: CoreEvent<Record<string, unknown>>) => void;
  handleRdpEvent: (event: RdpSessionEvent) => void;
  /** VNC 세션 이벤트. 끊긴 세션을 되살리거나 왜 끊겼는지 탭에 남긴다. */
  handleVncEvent: (event: VncSessionEvent) => void;
  /**
   * 이 세션의 호스트가 쓸 로컬 모니터를 정하고 다시 붙는다.
   *
   * 선택은 호스트에 남는다 — 매번 고르지 않아도 되고, 자리를 옮겨 디스플레이 구성이 바뀌면
   * 이름·크기로 다시 맞춘다. 배치는 접속 시점에 협상되므로 적용에 재접속이 필요하다.
   */
  setRdpMonitors: (
    sessionId: string,
    monitors: RdpMonitorSelection[] | null,
  ) => Promise<void>;
  /**
   * 마이크를 보낼 수 없는 이유를 이 세션 탭에 기록한다(탭 hover 표시용).
   *
   * 이유를 아는 곳은 렌더러다 — 권한·장치는 캡처를 시도해 봐야 알고, 서버가 채널을 열지 않은
   * 것은 코어가 이벤트로 알려 준다. 둘 다 이 한 곳으로 모은다.
   */
  setRdpMicrophoneProblem: (
    sessionId: string,
    problem: TerminalTab["rdpMicrophoneProblem"],
  ) => void;
  /** 카메라를 보낼 수 없는 이유를 이 세션 탭에 기록한다(탭 hover 표시용). */
  setRdpCameraProblem: (
    sessionId: string,
    problem: TerminalTab["rdpCameraProblem"],
  ) => void;
  handleTmuxLayoutChange: (
    controlSessionId: string,
    windowId: string,
    layout: string,
    meta?: {
      index?: number;
      name?: string;
      active?: boolean;
      sessionName?: string;
    },
  ) => void;
  handleSessionShareEvent: (event: SessionShareEvent) => void;
  handleSessionShareChatEvent: (event: SessionShareChatEvent) => void;
  dismissSessionShareChatNotification: (
    sessionId: string,
    messageId: string,
  ) => void;
  handleTransferEvent: (event: TransferJobEvent) => void;
  handlePortForwardEvent: (event: PortForwardRuntimeEvent) => void;
  handleSftpConnectionProgressEvent: (
    event: SftpConnectionProgressEvent,
  ) => void;
  handleContainerConnectionProgressEvent: (
    event: ContainerConnectionProgressEvent,
  ) => void;
  handleActivityLogsChanged: () => void;
  setSftpPaneSource: (
    paneId: SftpPaneId,
    sourceKind: SftpSourceKind,
  ) => Promise<void>;
  disconnectSftpPane: (paneId: SftpPaneId) => Promise<void>;
  setSftpPaneFilter: (paneId: SftpPaneId, query: string) => void;
  setSftpHostSearchQuery: (paneId: SftpPaneId, query: string) => void;
  navigateSftpHostGroup: (paneId: SftpPaneId, path: string | null) => void;
  selectSftpHost: (paneId: SftpPaneId, hostId: string) => void;
  connectSftpHost: (paneId: SftpPaneId, hostId: string) => Promise<void>;
  openSftpEntry: (paneId: SftpPaneId, entryPath: string) => Promise<void>;
  refreshSftpPane: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpBack: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpForward: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpParent: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpBreadcrumb: (
    paneId: SftpPaneId,
    nextPath: string,
  ) => Promise<void>;
  selectSftpEntry: (paneId: SftpPaneId, input: SftpEntrySelectionInput) => void;
  createSftpDirectory: (paneId: SftpPaneId, name: string) => Promise<void>;
  renameSftpSelection: (paneId: SftpPaneId, nextName: string) => Promise<void>;
  changeSftpSelectionPermissions: (
    paneId: SftpPaneId,
    mode: number,
  ) => Promise<void>;
  changeSftpSelectionOwner: (
    paneId: SftpPaneId,
    input: SftpOwnershipChangeInput,
  ) => Promise<void>;
  listSftpPrincipals: (
    paneId: SftpPaneId,
    kind: "user" | "group",
    query?: string,
  ) => Promise<SftpPrincipal[]>;
  deleteSftpSelection: (paneId: SftpPaneId) => Promise<void>;
  downloadSftpSelection: (paneId: SftpPaneId) => Promise<void>;
  prepareSftpTransfer: (
    sourcePaneId: SftpPaneId,
    targetPaneId: SftpPaneId,
    targetPath: string,
    draggedPath?: string | null,
  ) => Promise<void>;
  prepareSftpExternalTransfer: (
    targetPaneId: SftpPaneId,
    targetPath: string,
    droppedPaths: string[],
  ) => Promise<void>;
  // 터미널 패널에 드롭한 파일을 해당 세션 호스트의 cwd로 SFTP 업로드한다(SFTP 패널 비종속).
  uploadLocalFilesToHost: (
    input: {
      hostId: string;
      targetPath: string | null;
      localPaths: string[];
    },
    onProgress?: (message: string) => void,
  ) => Promise<TerminalUploadResult>;
  // connection_lost로 죽은 터미널 업로드 전송을 자동 복구한다(엔드포인트 재수립 + 실패 항목 재업로드).
  recoverTransferConnectionLoss: (job: TransferJob) => Promise<void>;
  transferSftpSelectionToPane: (
    sourcePaneId: SftpPaneId,
    targetPaneId: SftpPaneId,
  ) => Promise<void>;
  resolveSftpConflict: (
    resolution: "overwrite" | "skip" | "keepBoth",
    remember?: boolean,
  ) => Promise<void>;
  dismissSftpConflict: () => void;
  cancelTransfer: (jobId: string) => Promise<void>;
  pauseTransfer: (jobId: string) => Promise<void>;
  resumeTransfer: (jobId: string) => Promise<void>;
  retryTransfer: (jobId: string) => Promise<void>;
  dismissTransfer: (jobId: string) => void;
}

export type CatalogSlice = Pick<
  AppStateParts,
  | "hosts"
  | "groups"
  | "activeWorkspaceTab"
  | "homeSection"
  | "settingsSection"
  | "savedCredentialsSearchQuery"
  | "hostDrawer"
  | "currentGroupPath"
  | "searchQuery"
  | "selectedHostTags"
  | "isReady"
  | "setSearchQuery"
  | "setSavedCredentialsSearchQuery"
  | "toggleHostTag"
  | "clearHostTagFilter"
  | "activateHome"
  | "activateSftp"
  | "activateSession"
  | "activateWorkspace"
  | "activateTmuxGroup"
  | "activateContainers"
  | "focusHostContainersTab"
  | "openHomeSection"
  | "openSettingsSection"
  | "openCreateHostDrawer"
  | "openEditHostDrawer"
  | "closeHostDrawer"
  | "navigateGroup"
  | "bootstrap"
  | "refreshHostCatalog"
  | "refreshOperationalData"
  | "refreshSyncedWorkspaceData"
  | "clearSyncedWorkspaceData"
  | "createGroup"
  | "removeGroup"
  | "moveGroup"
  | "renameGroup"
  | "reorderGroup"
  | "saveHost"
  | "duplicateHosts"
  | "moveHostToGroup"
  | "setHostFavorite"
  | "setHostTerminalTheme"
  | "setHostDetectedOs"
  | "removeHost"
>;

export type SessionSlice = Pick<
  AppStateParts,
  | "setRdpMonitors"
  | "setRdpMicrophoneProblem"
  | "setRdpCameraProblem"
  | "tabs"
  | "sessionShareChatNotifications"
  | "workspaces"
  | "tmuxGroups"
  | "tmuxCommandPrompt"
  | "tabStrip"
  | "pendingCredentialRetry"
  | "activeCredentialRetryAttempt"
  | "pendingMissingUsernamePrompt"
  | "pendingStartupCommandPrompt"
  | "pendingInteractiveAuths"
  | "pendingConnectionAttempts"
  | "resolvedStartupCommandsBySessionId"
  | "sessionReturnTargets"
  | "openLocalTerminal"
  | "connectHost"
  | "retrySessionConnection"
  | "retryRdpConnection"
  | "retryVncConnection"
  | "startSessionShare"
  | "updateSessionShareSnapshot"
  | "setSessionShareInputEnabled"
  | "stopSessionShare"
  | "disconnectTab"
  | "cancelSessionReconnect"
  | "closeWorkspace"
  | "closeActiveTab"
  | "runTabCommand"
  | "splitSessionIntoWorkspace"
  | "moveWorkspaceSession"
  | "detachSessionFromWorkspace"
  | "reorderDynamicTab"
  | "focusWorkspaceSession"
  | "applyTmuxActivePane"
  | "openTmuxCommandPrompt"
  | "closeTmuxCommandPrompt"
  | "tmuxNewWindowInWorkspace"
  | "detachTmuxWorkspace"
  | "removeTmuxWorkspacesLocal"
  | "applyTmuxGroupReconnecting"
  | "applyTmuxGroupReconnectGaveUp"
  | "applyTabCommandState"
  | "selectTmuxWindow"
  | "renameTmuxWindow"
  | "applyTmuxWindowRenamed"
  | "applyTmuxSessionName"
  | "applyTmuxSessionsList"
  | "killTmuxSession"
  | "toggleSessionBroadcast"
  | "toggleWorkspaceZoom"
  | "resizeWorkspaceSplit"
  | "dismissPendingCredentialRetry"
  | "submitCredentialRetry"
  | "dismissPendingMissingUsernamePrompt"
  | "submitMissingUsernamePrompt"
  | "confirmStartupCommandPrompt"
  | "cancelStartupCommandPrompt"
  | "respondInteractiveAuth"
  | "reopenInteractiveAuthUrl"
  | "clearPendingInteractiveAuth"
  | "updatePendingConnectionSize"
  | "markSessionOutput"
  | "handleTmuxLayoutChange"
>;

export type ContainersSlice = Pick<
  AppStateParts,
  | "containerTabs"
  | "activeContainerHostId"
  | "openHostContainersTab"
  | "closeHostContainersTab"
  | "reorderContainerTab"
  | "refreshHostContainers"
  | "refreshEcsClusterUtilization"
  | "loginAwsProfileForEcsHost"
  | "selectHostContainer"
  | "setHostContainersPanel"
  | "setHostContainerTunnelState"
  | "setEcsClusterSelectedService"
  | "setEcsClusterActivePanel"
  | "setEcsClusterTunnelState"
  | "setEcsClusterLogsState"
  | "refreshHostContainerLogs"
  | "loadMoreHostContainerLogs"
  | "setHostContainerLogsFollow"
  | "setHostContainerLogsSearchQuery"
  | "searchHostContainerLogs"
  | "clearHostContainerLogsSearch"
  | "refreshHostContainerStats"
  | "runHostContainerAction"
  | "openHostContainerShell"
  | "openEcsExecShell"
>;

export type SftpSlice = Pick<
  AppStateParts,
  | "sftp"
  | "pendingAwsSftpConfigRetry"
  | "dismissPendingAwsSftpConfigRetry"
  | "submitAwsSftpConfigRetry"
  | "setSftpPaneSource"
  | "disconnectSftpPane"
  | "setSftpPaneFilter"
  | "setSftpHostSearchQuery"
  | "navigateSftpHostGroup"
  | "selectSftpHost"
  | "connectSftpHost"
  | "openSftpEntry"
  | "refreshSftpPane"
  | "navigateSftpBack"
  | "navigateSftpForward"
  | "navigateSftpParent"
  | "navigateSftpBreadcrumb"
  | "selectSftpEntry"
  | "createSftpDirectory"
  | "renameSftpSelection"
  | "changeSftpSelectionPermissions"
  | "changeSftpSelectionOwner"
  | "listSftpPrincipals"
  | "deleteSftpSelection"
  | "downloadSftpSelection"
  | "prepareSftpTransfer"
  | "prepareSftpExternalTransfer"
  | "uploadLocalFilesToHost"
  | "recoverTransferConnectionLoss"
  | "transferSftpSelectionToPane"
  | "resolveSftpConflict"
  | "dismissSftpConflict"
  | "cancelTransfer"
  | "pauseTransfer"
  | "resumeTransfer"
  | "retryTransfer"
  | "dismissTransfer"
>;

export type NetworkSlice = Pick<
  AppStateParts,
  | "portForwards"
  | "dnsOverrides"
  | "snippets"
  | "portForwardRuntimes"
  | "knownHosts"
  | "pendingHostKeyPrompt"
  | "connectionViews"
  | "dismissConnectionView"
  | "queuedHostKeyPrompts"
  | "pendingRdpCertificatePrompt"
  | "setPendingRdpCertificatePrompt"
  | "tailnetStatuses"
  | "localTailnetNodeName"
  | "savePortForward"
  | "saveDnsOverride"
  | "setStaticDnsOverrideActive"
  | "removeDnsOverride"
  | "saveSnippet"
  | "removeSnippet"
  | "removePortForward"
  | "startPortForward"
  | "stopPortForward"
  | "removeKnownHost"
  | "revokeRdpCertificateTrust"
  | "acceptPendingHostKeyPrompt"
  | "dismissPendingHostKeyPrompt"
>;

export type SettingsSlice = Pick<
  AppStateParts,
  | "settings"
  | "activityLogs"
  | "keychainEntries"
  | "loadSettings"
  | "updateSettings"
  | "notifyCommandFinished"
  | "clearLogs"
  | "removeKeychainSecret"
  | "updateKeychainSecret"
  | "cloneKeychainSecretForHost"
  | "generateSshKey"
  | "copySshPublicKey"
  | "installSshPublicKey"
  | "loadSessionReplayStorageUsage"
  | "testAiConnection"
  | "setAiApiKey"
  | "clearAiApiKey"
  | "getAiApiKeyStatus"
  | "getAiSearchKeyStatus"
  | "setAiSearchKey"
  | "clearAiSearchKey"
  | "codexLoginStart"
  | "getCodexAuthStatus"
  | "codexLogout"
  | "getCodexUsage"
  | "listCodexModels"
  | "openExternalUrl"
>;

export type RuntimeEventSlice = Pick<
  AppStateParts,
  | "handleCoreEvent"
  | "handleRdpEvent"
  | "handleVncEvent"
  | "handleSessionShareEvent"
  | "handleSessionShareChatEvent"
  | "dismissSessionShareChatNotification"
  | "handleTransferEvent"
  | "handlePortForwardEvent"
  | "handleSftpConnectionProgressEvent"
  | "handleContainerConnectionProgressEvent"
  | "handleActivityLogsChanged"
>;

// ZMODEM(sz) 다운로드 진행 상태. 렌더러 컨트롤러가 잡을 upsert하고,
// 통합 전송 토스트가 이를 읽어 표시한다.
export interface ZmodemSlice {
  zmodemTransfers: TransferJob[];
  upsertZmodemTransfer: (job: TransferJob) => void;
  cancelZmodemTransfer: (jobId: string) => void;
  dismissZmodemTransfer: (jobId: string) => void;
}

// AI 채팅 패널(Phase 2). 대화는 sessionId(탭)별, in-memory. 터미널 최근 출력은 전송 시
// 자동으로 컨텍스트에 포함하며(별도 첨부 UI 없음), 표시 메시지에는 담지 않고 요청에만 싣는다.
// 한 번의 도구 실행(패널에 진행/완료 표시). 완료된 턴은 해당 assistant 메시지에 접혀서 보존된다.
export interface AiToolRun {
  id: string;
  label: string;
  status: "running" | "done" | "error";
}

// 표시용 메시지 = wire 메시지 + (assistant 턴이 사용한 도구 실행 목록).
export interface AiDisplayMessage extends AiChatMessage {
  toolRuns?: AiToolRun[];
  // 스트리밍 중 이미 화면에 표시했던 중간 생성 텍스트. 최종 답변 아래 접힌 상태로 보존한다.
  generationTrace?: string;
}

export interface AiConversation {
  messages: AiDisplayMessage[];
  requestId: string | null;
  terminalSnapshotId: string | null;
  streamingText: string;
  generationTrace: string;
  streaming: boolean;
  error: AiErrorPayload | null;
  // 현재 진행 중인 턴의 도구 실행들(스트리밍 중 펼쳐서 표시). done 시 마지막 메시지에 옮겨 접는다.
  toolRuns: AiToolRun[];
  // run_command 변경 명령 승인 대기(패널에 승인/거부 카드 표시). 응답/취소 시 clear.
  pendingApproval: { toolCallId: string; command: string; reason: string } | null;
}

export interface AiChatSlice {
  aiConversations: Record<string, AiConversation>;
  // context = 전송 시점 세션 컨텍스트(호스트 요약 + 터미널 최근 출력, redaction됨).
  // 표시 메시지엔 안 들어가고 요청에만 실린다. attachments 는 표시 메시지와 요청 양쪽에 실린다.
  sendAiMessage: (
    sessionId: string,
    text: string,
    context?: string,
    terminalSnapshot?: AiTerminalSnapshotRef,
    attachments?: AiAttachment[],
  ) => Promise<void>;
  handleAiChatEvent: (event: AiChatEvent) => void;
  // run_command 승인/거부. remember=true 면 이 세션에서 이후 변경 명령을 자동 승인.
  respondAiApproval: (
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    remember?: boolean,
  ) => Promise<void>;
  cancelAiMessage: (sessionId: string) => void;
  clearAiConversation: (sessionId: string) => void;
}

export interface SessionPanelSlice {
  /** 패널이 열려 있는가. 상단 바의 토글로만 바뀐다(창 단위). */
  sessionPanelOpen: boolean;
  /** 창 단위 패널 폭(px). 영속화하지 않는다. */
  sessionPanelWidth: number;
  /** 세션마다 마지막으로 본 섹션. */
  sessionPanelSectionBySessionId: Record<string, SessionPanelSectionId | null>;
  toggleSessionPanel: () => void;
  setSessionPanelWidth: (width: number) => void;
  selectSessionPanelSection: (
    sessionId: string,
    section: SessionPanelSectionId,
  ) => void;
  toggleSessionPanelSection: (
    sessionId: string,
    section: SessionPanelSectionId,
  ) => void;
}

export type AppState = CatalogSlice &
  SessionSlice &
  ContainersSlice &
  SftpSlice &
  NetworkSlice &
  SettingsSlice &
  RuntimeEventSlice &
  ZmodemSlice &
  AiChatSlice &
  SessionPanelSlice;

export interface SliceDeps {
  api: DesktopApi;
  set: StoreApi<AppState>["setState"];
  get: StoreApi<AppState>["getState"];
}
