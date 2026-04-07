import type { StoreApi } from "zustand/vanilla";
import type {
  ActivityLogRecord,
  AppSettings,
  AwsEcsClusterSnapshot,
  AwsMetricHistoryPoint,
  ContainerConnectionProgressEvent,
  CoreEvent,
  DesktopApi,
  DnsOverrideDraft,
  DnsOverrideResolvedRecord,
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
  SecretMetadataRecord,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput,
} from "@shared";

export type SessionWorkspaceTabId = `session:${string}`;
export type SplitWorkspaceTabId = `workspace:${string}`;
export type WorkspaceTabId =
  | "home"
  | "sftp"
  | "containers"
  | SessionWorkspaceTabId
  | SplitWorkspaceTabId;
export type HomeSection = "hosts" | "portForwarding" | "logs" | "settings";
export type SettingsSection = "general" | "security" | "secrets" | "aws-profiles";
export type SftpSourceKind = "local" | "host";
export type WorkspaceDropDirection = "left" | "right" | "top" | "bottom";
export type HostDrawerState =
  | { mode: "closed" }
  | { mode: "create"; defaultGroupPath: string | null }
  | { mode: "edit"; hostId: string };

export interface WorkspaceLeafNode {
  id: string;
  kind: "leaf";
  sessionId: string;
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
}

export type DynamicTabStripItem =
  | {
      kind: "session";
      sessionId: string;
    }
  | {
      kind: "workspace";
      workspaceId: string;
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

export interface HostContainersTabState {
  kind: HostContainersTabKind;
  hostId: string;
  title: string;
  runtime: HostContainerRuntime | null;
  unsupportedReason: string | null;
  connectionProgress?: ContainerConnectionProgressEvent | null;
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
  credentialKind: "password" | "passphrase";
  message: string;
  paneId?: SftpPaneId;
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
}

export interface SftpState {
  localHomePath: string;
  leftPane: SftpPaneState;
  rightPane: SftpPaneState;
  transfers: TransferJob[];
  pendingConflictDialog: PendingConflictDialog | null;
}

interface AppStateParts {
  hosts: HostRecord[];
  groups: GroupRecord[];
  tabs: TerminalTab[];
  sessionShareChatNotifications: Record<string, SessionShareChatMessage[]>;
  workspaces: WorkspaceTab[];
  containerTabs: HostContainersTabState[];
  activeContainerHostId: string | null;
  tabStrip: DynamicTabStripItem[];
  portForwards: PortForwardRuleRecord[];
  dnsOverrides: DnsOverrideResolvedRecord[];
  portForwardRuntimes: PortForwardRuntimeRecord[];
  knownHosts: KnownHostRecord[];
  activityLogs: ActivityLogRecord[];
  keychainEntries: SecretMetadataRecord[];
  activeWorkspaceTab: WorkspaceTabId;
  homeSection: HomeSection;
  settingsSection: SettingsSection;
  hostDrawer: HostDrawerState;
  currentGroupPath: string | null;
  searchQuery: string;
  selectedHostTags: string[];
  settings: AppSettings;
  isReady: boolean;
  sftp: SftpState;
  pendingHostKeyPrompt: PendingHostKeyPrompt | null;
  pendingCredentialRetry: PendingCredentialRetry | null;
  pendingAwsSftpConfigRetry: PendingAwsSftpConfigRetry | null;
  pendingMissingUsernamePrompt: PendingMissingUsernamePrompt | null;
  pendingInteractiveAuth: PendingInteractiveAuth | null;
  pendingConnectionAttempts: PendingConnectionAttempt[];
  setSearchQuery: (value: string) => void;
  toggleHostTag: (tag: string) => void;
  clearHostTagFilter: () => void;
  activateHome: () => void;
  activateSftp: () => void;
  activateSession: (sessionId: string) => void;
  activateWorkspace: (workspaceId: string) => void;
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
  createGroup: (name: string) => Promise<void>;
  removeGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  moveGroup: (path: string, targetParentPath: string | null) => Promise<void>;
  renameGroup: (path: string, name: string) => Promise<void>;
  saveHost: (
    hostId: string | null,
    draft: HostDraft,
    secrets?: HostSecretInput,
  ) => Promise<void>;
  duplicateHosts: (hostIds: string[]) => Promise<void>;
  moveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  removeHost: (hostId: string) => Promise<void>;
  openLocalTerminal: (cols: number, rows: number) => Promise<void>;
  connectHost: (
    hostId: string,
    cols: number,
    rows: number,
    secrets?: HostSecretInput,
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
  closeWorkspace: (workspaceId: string) => Promise<void>;
  openHostContainersTab: (hostId: string) => Promise<void>;
  closeHostContainersTab: (hostId: string) => Promise<void>;
  reorderContainerTab: (
    sourceHostId: string,
    targetHostId: string,
    placement: "before" | "after",
  ) => void;
  refreshHostContainers: (hostId: string) => Promise<void>;
  refreshEcsClusterUtilization: (hostId: string) => Promise<void>;
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
  refreshHostContainerLogs: (
    hostId: string,
    options?: { tail?: number; followCursor?: string | null },
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
  toggleWorkspaceBroadcast: (workspaceId: string) => void;
  resizeWorkspaceSplit: (
    workspaceId: string,
    splitId: string,
    ratio: number,
  ) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (input: Partial<AppSettings>) => Promise<void>;
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
  acceptPendingHostKeyPrompt: (mode: "trust" | "replace") => Promise<void>;
  dismissPendingHostKeyPrompt: () => void;
  dismissPendingCredentialRetry: () => void;
  submitCredentialRetry: (secrets: HostSecretInput) => Promise<void>;
  dismissPendingAwsSftpConfigRetry: () => void;
  submitAwsSftpConfigRetry: (input: {
    username: string;
    port: number;
  }) => Promise<void>;
  dismissPendingMissingUsernamePrompt: () => void;
  submitMissingUsernamePrompt: (input: { username: string }) => Promise<void>;
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
  transferSftpSelectionToPane: (
    sourcePaneId: SftpPaneId,
    targetPaneId: SftpPaneId,
  ) => Promise<void>;
  resolveSftpConflict: (
    resolution: "overwrite" | "skip" | "keepBoth",
  ) => Promise<void>;
  dismissSftpConflict: () => void;
  cancelTransfer: (jobId: string) => Promise<void>;
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
  | "hostDrawer"
  | "currentGroupPath"
  | "searchQuery"
  | "selectedHostTags"
  | "isReady"
  | "setSearchQuery"
  | "toggleHostTag"
  | "clearHostTagFilter"
  | "activateHome"
  | "activateSftp"
  | "activateSession"
  | "activateWorkspace"
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
  | "saveHost"
  | "duplicateHosts"
  | "moveHostToGroup"
  | "removeHost"
>;

export type SessionSlice = Pick<
  AppStateParts,
  | "tabs"
  | "sessionShareChatNotifications"
  | "workspaces"
  | "tabStrip"
  | "pendingCredentialRetry"
  | "pendingMissingUsernamePrompt"
  | "pendingInteractiveAuth"
  | "pendingConnectionAttempts"
  | "openLocalTerminal"
  | "connectHost"
  | "retrySessionConnection"
  | "startSessionShare"
  | "updateSessionShareSnapshot"
  | "setSessionShareInputEnabled"
  | "stopSessionShare"
  | "disconnectTab"
  | "closeWorkspace"
  | "splitSessionIntoWorkspace"
  | "moveWorkspaceSession"
  | "detachSessionFromWorkspace"
  | "reorderDynamicTab"
  | "focusWorkspaceSession"
  | "toggleWorkspaceBroadcast"
  | "resizeWorkspaceSplit"
  | "dismissPendingCredentialRetry"
  | "submitCredentialRetry"
  | "dismissPendingMissingUsernamePrompt"
  | "submitMissingUsernamePrompt"
  | "respondInteractiveAuth"
  | "reopenInteractiveAuthUrl"
  | "clearPendingInteractiveAuth"
  | "updatePendingConnectionSize"
  | "markSessionOutput"
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
  | "selectHostContainer"
  | "setHostContainersPanel"
  | "setHostContainerTunnelState"
  | "setEcsClusterSelectedService"
  | "setEcsClusterActivePanel"
  | "setEcsClusterTunnelState"
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
  | "deleteSftpSelection"
  | "downloadSftpSelection"
  | "prepareSftpTransfer"
  | "prepareSftpExternalTransfer"
  | "transferSftpSelectionToPane"
  | "resolveSftpConflict"
  | "dismissSftpConflict"
  | "cancelTransfer"
  | "retryTransfer"
  | "dismissTransfer"
>;

export type NetworkSlice = Pick<
  AppStateParts,
  | "portForwards"
  | "dnsOverrides"
  | "portForwardRuntimes"
  | "knownHosts"
  | "pendingHostKeyPrompt"
  | "savePortForward"
  | "saveDnsOverride"
  | "setStaticDnsOverrideActive"
  | "removeDnsOverride"
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
  | "clearLogs"
  | "removeKeychainSecret"
  | "updateKeychainSecret"
  | "cloneKeychainSecretForHost"
>;

export type RuntimeEventSlice = Pick<
  AppStateParts,
  | "handleCoreEvent"
  | "handleSessionShareEvent"
  | "handleSessionShareChatEvent"
  | "dismissSessionShareChatNotification"
  | "handleTransferEvent"
  | "handlePortForwardEvent"
  | "handleSftpConnectionProgressEvent"
  | "handleContainerConnectionProgressEvent"
>;

export type AppState = CatalogSlice &
  SessionSlice &
  ContainersSlice &
  SftpSlice &
  NetworkSlice &
  SettingsSlice &
  RuntimeEventSlice;

export interface SliceDeps {
  api: DesktopApi;
  set: StoreApi<AppState>["setState"];
  get: StoreApi<AppState>["getState"];
}
