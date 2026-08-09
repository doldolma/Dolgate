import type { StoreApi } from "zustand/vanilla";
import type { CommandFinishedInfo } from "../lib/command-notification";
import type {
  ActivityLogRecord,
  AuthType,
  AppSettings,
  AwsEcsClusterSnapshot,
  AwsEcsServiceLogsSnapshot,
  AwsMetricHistoryPoint,
  ContainerConnectionProgressEvent,
  CoreEvent,
  RdpSessionEvent,
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
  broadcastEnabled: boolean;
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

export type PendingInteractiveAuth =
  | PendingSessionInteractiveAuth
  | PendingSftpInteractiveAuth
  | PendingContainersInteractiveAuth
  | PendingPortForwardInteractiveAuth;

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
  pendingInteractiveAuth: PendingInteractiveAuth | null;
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
  openCreateSerialDrawer: () => void;
  openCreateRdpDrawer: () => void;
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
  saveHost: (
    hostId: string | null,
    draft: HostDraft,
    secrets?: HostSecretInput,
  ) => Promise<HostRecord>;
  duplicateHosts: (hostIds: string[]) => Promise<void>;
  moveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  setHostFavorite: (hostId: string, favorite: boolean) => Promise<void>;
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
     * tmux 를 기존 세션의 탭 자리에서 열 때, 닫고 대체할 그 세션 id. tmux=true 일 때만
     * 의미가 있다. 지정하면 그 세션을 끊고 tmux 세션 그룹 탭이 그 자리에 들어선다
     * ("현재 화면에서 진행"). 호스트 레벨 연결처럼 원 세션이 없으면 생략한다.
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
  toggleWorkspaceBroadcast: (workspaceId: string) => void;
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
  clearLogs: () => Promise<void>;
  removeKeychainSecret: (secretRef: string) => Promise<void>;
  updateKeychainSecret: (
    secretRef: string,
    secrets: HostSecretInput,
  ) => Promise<void>;
  cloneKeychainSecretForHost: (
    hostId: string,
    sourceSecretRef: string,
    secrets: HostSecretInput,
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
  acceptPendingHostKeyPrompt: (mode: "trust" | "replace") => Promise<void>;
  dismissPendingHostKeyPrompt: () => void;
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
  ) => Promise<void>;
  reopenInteractiveAuthUrl: () => Promise<void>;
  clearPendingInteractiveAuth: () => void;
  updatePendingConnectionSize: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => void;
  markSessionOutput: (sessionId: string, chunk?: Uint8Array) => void;
  handleCoreEvent: (event: CoreEvent<Record<string, unknown>>) => void;
  handleRdpEvent: (event: RdpSessionEvent) => void;
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
  | "openCreateSerialDrawer"
  | "openCreateRdpDrawer"
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
  | "saveHost"
  | "duplicateHosts"
  | "moveHostToGroup"
  | "setHostFavorite"
  | "removeHost"
>;

export type SessionSlice = Pick<
  AppStateParts,
  | "setRdpMonitors"
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
  | "pendingInteractiveAuth"
  | "pendingConnectionAttempts"
  | "resolvedStartupCommandsBySessionId"
  | "sessionReturnTargets"
  | "openLocalTerminal"
  | "connectHost"
  | "retrySessionConnection"
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
  | "toggleWorkspaceBroadcast"
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
  open: boolean;
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
  aiPanelWidth: number;
  toggleAiPanel: (sessionId: string) => void;
  setAiPanelWidth: (width: number) => void;
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

export type AppState = CatalogSlice &
  SessionSlice &
  ContainersSlice &
  SftpSlice &
  NetworkSlice &
  SettingsSlice &
  RuntimeEventSlice &
  ZmodemSlice &
  AiChatSlice;

export interface SliceDeps {
  api: DesktopApi;
  set: StoreApi<AppState>["setState"];
  get: StoreApi<AppState>["getState"];
}
