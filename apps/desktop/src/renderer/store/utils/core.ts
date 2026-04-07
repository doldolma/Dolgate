import {
  AWS_SFTP_DEFAULT_PORT,
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  getAwsEc2HostSftpDisabledReason,
  getAwsEc2HostSshPort,
  getParentGroupPath,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isLinkedDnsOverrideRecord,
  isSshHostDraft,
  isGroupWithinPath,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  normalizeGroupPath,
  rebaseGroupPath,
  stripRemovedGroupSegment,
} from "@shared";
import type {
  ActivityLogRecord,
  AppSettings,
  AwsEcsClusterSnapshot,
  AwsEcsClusterUtilizationSnapshot,
  AwsMetricHistoryPoint,
  CoreEvent,
  ContainerConnectionProgressEvent,
  ConnectionProgressStage,
  DesktopApi,
  DnsOverrideDraft,
  DnsOverrideResolvedRecord,
  DirectoryListing,
  FileEntry,
  GroupRecord,
  GroupRemoveMode,
  HostDraft,
  HostContainerDetails,
  HostContainerLogSearchResult,
  HostContainerListResult,
  HostContainerLogsSnapshot,
  HostContainerRuntime,
  HostContainerStatsSample,
  HostContainerSummary,
  HostKeyProbeResult,
  HostRecord,
  HostSecretInput,
  KeyboardInteractiveChallenge,
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
  SessionShareState,
  SftpConnectionProgressEvent,
  SftpEndpointSummary,
  SftpPaneId,
  SecretMetadataRecord,
  TerminalConnectionProgress,
  TerminalFontFamilyId,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput,
} from "@shared";

export {
  AWS_SFTP_DEFAULT_PORT,
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  getAwsEc2HostSftpDisabledReason,
  getAwsEc2HostSshPort,
  getParentGroupPath,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isLinkedDnsOverrideRecord,
  isSshHostDraft,
  isGroupWithinPath,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  normalizeGroupPath,
  rebaseGroupPath,
  stripRemovedGroupSegment
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
    }

export function mergeContainerLogLines(
  existingLines: string[],
  incomingLines: string[],
): string[] {
  if (existingLines.length === 0) {
    return incomingLines;
  }
  if (incomingLines.length === 0) {
    return existingLines;
  }

  const maxOverlap = Math.min(existingLines.length, incomingLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (
        existingLines[existingLines.length - overlap + index] !==
        incomingLines[index]
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return [...existingLines, ...incomingLines.slice(overlap)];
    }
  }

  return [...existingLines, ...incomingLines];
}

export function normalizeRemoteInvokeErrorMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^Error:\s*/u, "")
    .trim();
}

export function normalizeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error
    ? normalizeRemoteInvokeErrorMessage(error.message)
    : fallback;
}

export function isAwsSsoAuthenticationErrorMessage(message: string): boolean {
  return /sso session associated with this profile has expired|sso token.+expired|aws sso login|브라우저 로그인이 필요합니다/iu.test(
    message,
  );
}

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

export function arePortForwardRuntimeRecordsEqual(
  left: PortForwardRuntimeRecord | null,
  right: PortForwardRuntimeRecord | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.ruleId === right.ruleId &&
    left.hostId === right.hostId &&
    left.transport === right.transport &&
    left.bindAddress === right.bindAddress &&
    left.bindPort === right.bindPort &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt &&
    left.startedAt === right.startedAt &&
    left.mode === right.mode &&
    left.method === right.method &&
    left.message === right.message
  );
}

export function areEcsTunnelTabStatesEqual(
  left: EcsTunnelTabState | null | undefined,
  right: EcsTunnelTabState | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.serviceName === right.serviceName &&
    left.taskArn === right.taskArn &&
    left.containerName === right.containerName &&
    left.targetPort === right.targetPort &&
    left.bindPort === right.bindPort &&
    left.autoLocalPort === right.autoLocalPort &&
    left.loading === right.loading &&
    left.error === right.error &&
    arePortForwardRuntimeRecordsEqual(left.runtime, right.runtime)
  );
}

export function areContainerTunnelTabStatesEqual(
  left: ContainerTunnelTabState | null | undefined,
  right: ContainerTunnelTabState | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.containerId === right.containerId &&
    left.containerName === right.containerName &&
    left.networkName === right.networkName &&
    left.targetPort === right.targetPort &&
    left.bindPort === right.bindPort &&
    left.autoLocalPort === right.autoLocalPort &&
    left.loading === right.loading &&
    left.error === right.error &&
    arePortForwardRuntimeRecordsEqual(left.runtime, right.runtime)
  );
}

export function normalizeContainerTunnelTabStateForPersistence(
  tunnelState: ContainerTunnelTabState | null | undefined,
): ContainerTunnelTabState | null {
  if (!tunnelState) {
    return null;
  }
  return {
    ...tunnelState,
    loading: false,
    error: null,
  };
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

interface PendingConnectionAttempt {
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

// renderer 전역 상태는 홈, SFTP, 세션 화면을 오가는 워크스페이스 메타데이터를 관리한다.
export interface AppState {
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
  selectHostContainer: (hostId: string, containerId: string | null) => Promise<void>;
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
  saveDnsOverride: (overrideId: string | null, draft: DnsOverrideDraft) => Promise<void>;
  setStaticDnsOverrideActive: (overrideId: string, active: boolean) => Promise<void>;
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

export function normalizeHomeSectionInput(
  section: HomeSection | "knownHosts" | "keychain",
): {
  homeSection: HomeSection;
  settingsSection?: SettingsSection;
} {
  if (section === "knownHosts") {
    return {
      homeSection: "settings",
      settingsSection: "security",
    };
  }

  if (section === "keychain") {
    return {
      homeSection: "settings",
      settingsSection: "secrets",
    };
  }

  return {
    homeSection: section,
  };
}

type TabStatus = TerminalTab["status"];

export function detectRendererPlatform(): "darwin" | "win32" | "linux" | "unknown" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const userAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = (
    userAgentData.userAgentData?.platform ??
    navigator.platform ??
    ""
  ).toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "darwin";
  }
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "win32";
  }
  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }
  return "unknown";
}

export function resolveRendererDefaultTerminalFontFamily(): TerminalFontFamilyId {
  const platform = detectRendererPlatform();
  if (platform === "win32") {
    return "consolas";
  }
  if (platform === "linux") {
    return "jetbrains-mono";
  }
  return "sf-mono";
}

export const defaultSettings: AppSettings = {
  theme: "system",
  globalTerminalThemeId: "dolssh-dark",
  terminalFontFamily: resolveRendererDefaultTerminalFontFamily(),
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
  sessionReplayRetentionCount: 100,
  serverUrl: "https://ssh.doldolma.com",
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: new Date(0).toISOString(),
};

export function createEmptyPane(id: SftpPaneId): SftpPaneState {
  return {
    id,
    sourceKind: id === "left" ? "local" : "host",
    endpoint: null,
    connectingHostId: null,
    connectingEndpointId: null,
    connectionProgress: null,
    hostGroupPath: null,
    currentPath: "",
    lastLocalPath: "",
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: "",
    selectedHostId: null,
    hostSearchQuery: "",
    isLoading: false,
    warningMessages: [],
  };
}

export function isPendingSessionInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingSessionInteractiveAuth {
  return pending?.source === "ssh";
}

export function isPendingSftpInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingSftpInteractiveAuth {
  return pending?.source === "sftp";
}

export function isPendingContainersInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingContainersInteractiveAuth {
  return pending?.source === "containers";
}

export function isPendingPortForwardInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingPortForwardInteractiveAuth {
  return pending?.source === "portForward";
}

export function resolveSftpPaneIdByEndpoint(
  state: Pick<AppState, "sftp">,
  endpointId: string,
): SftpPaneId | null {
  if (
    state.sftp.leftPane.endpoint?.id === endpointId ||
    state.sftp.leftPane.connectingEndpointId === endpointId
  ) {
    return "left";
  }
  if (
    state.sftp.rightPane.endpoint?.id === endpointId ||
    state.sftp.rightPane.connectingEndpointId === endpointId
  ) {
    return "right";
  }
  return null;
}

export function resolveContainersHostIdByEndpoint(
  endpointId: string,
): string | null {
  if (!endpointId.startsWith("containers:")) {
    return null;
  }
  const remainder = endpointId.slice("containers:".length);
  const hostId = remainder.split(":")[0]?.trim();
  return hostId || null;
}

export function createContainerConnectionProgress(
  hostId: string,
  endpointId: string,
  stage: ConnectionProgressStage,
  message: string,
): ContainerConnectionProgressEvent {
  return {
    hostId,
    endpointId,
    stage,
    message,
  };
}

export function buildSftpHostPickerPane(pane: SftpPaneState): SftpPaneState {
  return {
    ...pane,
    sourceKind: "host",
    endpoint: null,
    connectingHostId: null,
    connectingEndpointId: null,
    connectionProgress: null,
    currentPath: "",
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: "",
    selectedHostId:
      pane.endpoint?.hostId ?? pane.connectingHostId ?? pane.selectedHostId,
    isLoading: false,
    errorMessage: undefined,
    warningMessages: [],
  };
}

export const defaultSftpState: SftpState = {
  localHomePath: "",
  leftPane: createEmptyPane("left"),
  rightPane: createEmptyPane("right"),
  transfers: [],
  pendingConflictDialog: null,
};

export function sortHosts(hosts: HostRecord[]): HostRecord[] {
  return [...hosts].sort((a, b) => {
    const groupCompare = (a.groupName ?? "").localeCompare(b.groupName ?? "");
    if (groupCompare !== 0) {
      return groupCompare;
    }
    return a.label.localeCompare(b.label);
  });
}

export function toHostDraft(record: HostRecord, label: string): HostDraft {
  if (isAwsEc2HostRecord(record)) {
    return {
      kind: "aws-ec2",
      label,
      groupName: record.groupName ?? null,
      tags: record.tags ?? [],
      terminalThemeId: record.terminalThemeId ?? null,
      awsProfileId: record.awsProfileId ?? null,
      awsProfileName: record.awsProfileName,
      awsRegion: record.awsRegion,
      awsInstanceId: record.awsInstanceId,
      awsAvailabilityZone: record.awsAvailabilityZone ?? null,
      awsInstanceName: record.awsInstanceName ?? null,
      awsPlatform: record.awsPlatform ?? null,
      awsPrivateIp: record.awsPrivateIp ?? null,
      awsState: record.awsState ?? null,
      awsSshUsername: record.awsSshUsername ?? null,
      awsSshPort: record.awsSshPort ?? null,
      awsSshMetadataStatus: record.awsSshMetadataStatus ?? null,
      awsSshMetadataError: record.awsSshMetadataError ?? null,
    };
  }

  if (isWarpgateSshHostRecord(record)) {
    return {
      kind: "warpgate-ssh",
      label,
      groupName: record.groupName ?? null,
      tags: record.tags ?? [],
      terminalThemeId: record.terminalThemeId ?? null,
      warpgateBaseUrl: record.warpgateBaseUrl,
      warpgateSshHost: record.warpgateSshHost,
      warpgateSshPort: record.warpgateSshPort,
      warpgateTargetId: record.warpgateTargetId,
      warpgateTargetName: record.warpgateTargetName,
      warpgateUsername: record.warpgateUsername,
    };
  }

  if (isAwsEcsHostRecord(record)) {
    return {
      kind: "aws-ecs",
      label,
      groupName: record.groupName ?? null,
      tags: record.tags ?? [],
      terminalThemeId: record.terminalThemeId ?? null,
      awsProfileId: record.awsProfileId ?? null,
      awsProfileName: record.awsProfileName,
      awsRegion: record.awsRegion,
      awsEcsClusterArn: record.awsEcsClusterArn,
      awsEcsClusterName: record.awsEcsClusterName,
    };
  }

  return {
    kind: "ssh",
    label,
    hostname: record.hostname,
    port: record.port,
    username: record.username,
    authType: record.authType,
    privateKeyPath: record.privateKeyPath ?? null,
    secretRef: record.secretRef ?? null,
    groupName: record.groupName ?? null,
    tags: record.tags ?? [],
    terminalThemeId: record.terminalThemeId ?? null,
  };
}

export function findSshHostMissingUsername(
  hosts: HostRecord[],
  hostId: string,
): Extract<HostRecord, { kind: "ssh" }> | null {
  const host = hosts.find((item) => item.id === hostId);
  return host && isSshHostRecord(host) && !host.username.trim() ? host : null;
}

export function getDuplicateHostBaseLabel(label: string): string {
  const match = label.match(/^(.*?)(?: Copy(?: (\d+))?)?$/);
  const base = match?.[1]?.trim();
  return base && base.length > 0 ? base : label;
}

export function buildDuplicateHostLabel(
  record: HostRecord,
  hosts: HostRecord[],
): string {
  const baseLabel = getDuplicateHostBaseLabel(record.label);
  const groupPath = normalizeGroupPath(record.groupName);
  const labelsInGroup = new Set(
    hosts
      .filter((host) => normalizeGroupPath(host.groupName) === groupPath)
      .map((host) => host.label),
  );

  const firstCopyLabel = `${baseLabel} Copy`;
  if (!labelsInGroup.has(firstCopyLabel)) {
    return firstCopyLabel;
  }

  let suffix = 2;
  while (labelsInGroup.has(`${baseLabel} Copy ${suffix}`)) {
    suffix += 1;
  }
  return `${baseLabel} Copy ${suffix}`;
}

export function normalizeTagValue(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

export function matchesSelectedTags(
  host: HostRecord,
  selectedTags: string[],
): boolean {
  if (selectedTags.length === 0) {
    return true;
  }
  const hostTags = host.tags ?? [];
  if (hostTags.length === 0) {
    return false;
  }
  const normalizedHostTags = new Set(hostTags.map(normalizeTagValue));
  return selectedTags.some((tag) =>
    normalizedHostTags.has(normalizeTagValue(tag)),
  );
}

export function hasProvidedSecrets(secrets?: HostSecretInput): boolean {
  return Boolean(
    secrets?.password || secrets?.passphrase || secrets?.privateKeyPem,
  );
}

export function sortGroups(groups: GroupRecord[]): GroupRecord[] {
  return [...groups].sort((a, b) => a.path.localeCompare(b.path));
}

export function sortPortForwards(
  rules: PortForwardRuleRecord[],
): PortForwardRuleRecord[] {
  return [...rules].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
      a.label.localeCompare(b.label),
  );
}

export function sortDnsOverrides(overrides: DnsOverrideResolvedRecord[]): DnsOverrideResolvedRecord[] {
  return [...overrides].sort(
    (a, b) =>
      a.hostname.localeCompare(b.hostname) ||
      (a.type === "linked" ? `linked:${a.portForwardRuleId}` : `static:${a.address}`).localeCompare(
        b.type === "linked" ? `linked:${b.portForwardRuleId}` : `static:${b.address}`
      ),
  );
}

export function sortKnownHosts(records: KnownHostRecord[]): KnownHostRecord[] {
  return [...records].sort(
    (a, b) => a.host.localeCompare(b.host) || a.port - b.port,
  );
}

export function sortLogs(records: ActivityLogRecord[]): ActivityLogRecord[] {
  return [...records].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function sortKeychainEntries(
  entries: SecretMetadataRecord[],
): SecretMetadataRecord[] {
  return [...entries].sort(
    (a, b) =>
      a.label.localeCompare(b.label) || a.secretRef.localeCompare(b.secretRef),
  );
}

export function asSessionTabId(sessionId: string): SessionWorkspaceTabId {
  return `session:${sessionId}`;
}

export function asWorkspaceTabId(workspaceId: string): SplitWorkspaceTabId {
  return `workspace:${workspaceId}`;
}

export function buildContainersEndpointId(hostId: string): string {
  return `containers:${hostId}`;
}

export function buildContainersTabTitle(host: HostRecord): string {
  if (isAwsEcsHostRecord(host)) {
    return `${host.label} · ECS`;
  }
  return `${host.label} · Containers`;
}

export const DEFAULT_CONTAINER_LOGS_TAIL_WINDOW = 200;
export const CONTAINER_LOGS_TAIL_INCREMENT = 1000;
export const MAX_CONTAINER_LOGS_TAIL_WINDOW = 20000;
export const MAX_CONTAINER_METRICS_SAMPLES = 720;
export const ECS_UTILIZATION_HISTORY_WINDOW_MS = 10 * 60 * 1000;

export function classifyContainerLogsErrorMessage(
  message: string,
): ContainerLogsLoadState {
  return message.startsWith("Invalid containersLogs response:")
    ? "malformed"
    : "error";
}

export function trimContainerMetricsSamples(
  samples: HostContainerStatsSample[],
): HostContainerStatsSample[] {
  if (samples.length <= MAX_CONTAINER_METRICS_SAMPLES) {
    return samples;
  }
  return samples.slice(samples.length - MAX_CONTAINER_METRICS_SAMPLES);
}

export function createEmptyContainersTabState(host: HostRecord): HostContainersTabState {
  return {
    kind: isAwsEcsHostRecord(host) ? "ecs-cluster" : "host-containers",
    hostId: host.id,
    title: buildContainersTabTitle(host),
    runtime: null,
    unsupportedReason: null,
    connectionProgress: null,
    items: [],
    selectedContainerId: null,
    activePanel: "overview",
    isLoading: false,
    errorMessage: undefined,
    details: null,
    detailsLoading: false,
    detailsError: undefined,
    logs: null,
    logsState: "idle",
    logsLoading: false,
    logsError: undefined,
    logsFollowEnabled: false,
    logsTailWindow: DEFAULT_CONTAINER_LOGS_TAIL_WINDOW,
    logsSearchQuery: "",
    logsSearchMode: null,
    logsSearchLoading: false,
    logsSearchError: undefined,
    logsSearchResult: null,
    metricsSamples: [],
    metricsState: "idle",
    metricsLoading: false,
    metricsError: undefined,
    pendingAction: null,
    actionError: undefined,
    containerTunnelStatesByContainerId: {},
    ecsSnapshot: null,
    ecsMetricsWarning: null,
    ecsMetricsLoadedAt: null,
    ecsMetricsLoading: false,
    ecsUtilizationHistoryByServiceName: {},
    ecsSelectedServiceName: null,
    ecsActivePanel: "overview",
    ecsTunnelStatesByServiceName: {},
  };
}

export function clearEcsServiceUtilization(snapshot: AwsEcsClusterSnapshot): AwsEcsClusterSnapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => ({
      ...service,
      cpuUtilizationPercent: null,
      memoryUtilizationPercent: null,
    })),
  };
}

export function mergeEcsClusterUtilizationSnapshot(
  snapshot: AwsEcsClusterSnapshot,
  utilization: AwsEcsClusterUtilizationSnapshot,
): AwsEcsClusterSnapshot {
  const metricsByServiceName = new Map(
    utilization.services.map((service) => [service.serviceName, service]),
  );
  return {
    ...snapshot,
    services: snapshot.services.map((service) => {
      const nextMetrics = metricsByServiceName.get(service.serviceName);
      return {
        ...service,
        cpuUtilizationPercent: nextMetrics?.cpuUtilizationPercent ?? null,
        memoryUtilizationPercent: nextMetrics?.memoryUtilizationPercent ?? null,
      };
    }),
  };
}

export function createEcsUtilizationHistoryState(
  utilization: AwsEcsClusterUtilizationSnapshot,
): Record<string, EcsServiceUtilizationHistoryState> {
  return Object.fromEntries(
    utilization.services.map((service) => [
      service.serviceName,
      {
        cpuHistory: service.cpuHistory,
        memoryHistory: service.memoryHistory,
      } satisfies EcsServiceUtilizationHistoryState,
    ]),
  );
}

export function mergeMetricHistory(
  existing: AwsMetricHistoryPoint[],
  incoming: AwsMetricHistoryPoint[],
  loadedAt: string,
): AwsMetricHistoryPoint[] {
  const loadedAtMs = Date.parse(loadedAt);
  const cutoff = Number.isNaN(loadedAtMs)
    ? Number.NEGATIVE_INFINITY
    : loadedAtMs - ECS_UTILIZATION_HISTORY_WINDOW_MS;
  const merged = new Map<string, AwsMetricHistoryPoint>();

  for (const point of existing) {
    const timestampMs = Date.parse(point.timestamp);
    if (Number.isNaN(timestampMs) || timestampMs < cutoff) {
      continue;
    }
    merged.set(point.timestamp, point);
  }

  for (const point of incoming) {
    const timestampMs = Date.parse(point.timestamp);
    if (Number.isNaN(timestampMs) || timestampMs < cutoff) {
      continue;
    }
    merged.set(point.timestamp, point);
  }

  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}

export function mergeEcsUtilizationHistoryState(
  existing: Record<string, EcsServiceUtilizationHistoryState>,
  utilization: AwsEcsClusterUtilizationSnapshot,
): Record<string, EcsServiceUtilizationHistoryState> {
  const nextEntries = utilization.services.map((service) => {
    const current = existing[service.serviceName];
    return [
      service.serviceName,
      {
        cpuHistory: mergeMetricHistory(
          current?.cpuHistory ?? [],
          service.cpuHistory,
          utilization.loadedAt,
        ),
        memoryHistory: mergeMetricHistory(
          current?.memoryHistory ?? [],
          service.memoryHistory,
          utilization.loadedAt,
        ),
      } satisfies EcsServiceUtilizationHistoryState,
    ] as const;
  });

  return Object.fromEntries(nextEntries);
}

export function upsertContainersTab(
  tabs: HostContainersTabState[],
  tab: HostContainersTabState,
): HostContainersTabState[] {
  const existingIndex = tabs.findIndex((item) => item.hostId === tab.hostId);
  if (existingIndex < 0) {
    return [...tabs, tab];
  }
  return tabs.map((item, index) => (index === existingIndex ? tab : item));
}

export function resolveNextContainerHostId(
  tabs: HostContainersTabState[],
  removedHostId: string,
): string | null {
  const removedIndex = tabs.findIndex((tab) => tab.hostId === removedHostId);
  const remainingTabs = tabs.filter((tab) => tab.hostId !== removedHostId);
  if (remainingTabs.length === 0) {
    return null;
  }
  const nextTab =
    remainingTabs[removedIndex] ??
    remainingTabs[removedIndex - 1] ??
    remainingTabs[0] ??
    null;
  return nextTab?.hostId ?? null;
}

export function createWorkspaceLeaf(sessionId: string): WorkspaceLeafNode {
  return {
    id: globalThis.crypto.randomUUID(),
    kind: "leaf",
    sessionId,
  };
}

export function directionAxis(
  direction: WorkspaceDropDirection,
): WorkspaceSplitNode["axis"] {
  return direction === "left" || direction === "right"
    ? "horizontal"
    : "vertical";
}

export function createWorkspaceSplit(
  existingSessionId: string,
  incomingSessionId: string,
  direction: WorkspaceDropDirection,
): WorkspaceLayoutNode {
  const existingLeaf = createWorkspaceLeaf(existingSessionId);
  const incomingLeaf = createWorkspaceLeaf(incomingSessionId);
  const prependIncoming = direction === "left" || direction === "top";
  return {
    id: globalThis.crypto.randomUUID(),
    kind: "split",
    axis: directionAxis(direction),
    ratio: 0.5,
    first: prependIncoming ? incomingLeaf : existingLeaf,
    second: prependIncoming ? existingLeaf : incomingLeaf,
  };
}

export function listWorkspaceSessionIds(node: WorkspaceLayoutNode): string[] {
  if (node.kind === "leaf") {
    return [node.sessionId];
  }
  return [
    ...listWorkspaceSessionIds(node.first),
    ...listWorkspaceSessionIds(node.second),
  ];
}

export function countWorkspaceSessions(node: WorkspaceLayoutNode): number {
  return listWorkspaceSessionIds(node).length;
}

export function findFirstWorkspaceSessionId(node: WorkspaceLayoutNode): string {
  return node.kind === "leaf"
    ? node.sessionId
    : findFirstWorkspaceSessionId(node.first);
}

export function insertSessionIntoWorkspaceLayout(
  node: WorkspaceLayoutNode,
  targetSessionId: string,
  incomingSessionId: string,
  direction: WorkspaceDropDirection,
): { layout: WorkspaceLayoutNode; inserted: boolean } {
  if (node.kind === "leaf") {
    if (node.sessionId !== targetSessionId) {
      return { layout: node, inserted: false };
    }
    return {
      layout: createWorkspaceSplit(
        targetSessionId,
        incomingSessionId,
        direction,
      ),
      inserted: true,
    };
  }

  const nextFirst = insertSessionIntoWorkspaceLayout(
    node.first,
    targetSessionId,
    incomingSessionId,
    direction,
  );
  if (nextFirst.inserted) {
    return {
      layout: {
        ...node,
        first: nextFirst.layout,
      },
      inserted: true,
    };
  }

  const nextSecond = insertSessionIntoWorkspaceLayout(
    node.second,
    targetSessionId,
    incomingSessionId,
    direction,
  );
  if (nextSecond.inserted) {
    return {
      layout: {
        ...node,
        second: nextSecond.layout,
      },
      inserted: true,
    };
  }

  return { layout: node, inserted: false };
}

export function removeSessionFromWorkspaceLayout(
  node: WorkspaceLayoutNode,
  sessionId: string,
): WorkspaceLayoutNode | null {
  if (node.kind === "leaf") {
    return node.sessionId === sessionId ? null : node;
  }

  const nextFirst = removeSessionFromWorkspaceLayout(node.first, sessionId);
  const nextSecond = removeSessionFromWorkspaceLayout(node.second, sessionId);

  if (!nextFirst && !nextSecond) {
    return null;
  }
  if (!nextFirst) {
    return nextSecond;
  }
  if (!nextSecond) {
    return nextFirst;
  }

  return {
    ...node,
    first: nextFirst,
    second: nextSecond,
  };
}

export function moveSessionWithinWorkspaceLayout(
  node: WorkspaceLayoutNode,
  sessionId: string,
  targetSessionId: string,
  direction: WorkspaceDropDirection,
): { layout: WorkspaceLayoutNode; moved: boolean } {
  if (sessionId === targetSessionId) {
    return { layout: node, moved: false };
  }

  const sessionIds = listWorkspaceSessionIds(node);
  if (
    !sessionIds.includes(sessionId) ||
    !sessionIds.includes(targetSessionId)
  ) {
    return { layout: node, moved: false };
  }

  const reducedLayout = removeSessionFromWorkspaceLayout(node, sessionId);
  if (!reducedLayout) {
    return { layout: node, moved: false };
  }

  const nextLayout = insertSessionIntoWorkspaceLayout(
    reducedLayout,
    targetSessionId,
    sessionId,
    direction,
  );
  if (!nextLayout.inserted) {
    return { layout: node, moved: false };
  }

  return {
    layout: nextLayout.layout,
    moved: true,
  };
}

export function updateWorkspaceSplitRatio(
  node: WorkspaceLayoutNode,
  splitId: string,
  ratio: number,
): WorkspaceLayoutNode {
  if (node.kind === "leaf") {
    return node;
  }

  const clampedRatio = Math.min(0.8, Math.max(0.2, ratio));
  if (node.id === splitId) {
    return {
      ...node,
      ratio: clampedRatio,
    };
  }

  return {
    ...node,
    first: updateWorkspaceSplitRatio(node.first, splitId, clampedRatio),
    second: updateWorkspaceSplitRatio(node.second, splitId, clampedRatio),
  };
}

export function buildSessionTitle(
  label: string,
  scope: { source: "host"; hostId: string } | { source: "local" },
  tabs: TerminalTab[],
): string {
  const existingTitles = new Set(
    tabs
      .filter((tab) =>
        scope.source === "local"
          ? tab.source === "local"
          : tab.source === "host" && tab.hostId === scope.hostId,
      )
      .map((tab) => tab.title),
  );
  if (!existingTitles.has(label)) {
    return label;
  }

  let suffix = 1;
  while (existingTitles.has(`${label} (${suffix})`)) {
    suffix += 1;
  }
  return `${label} (${suffix})`;
}

export const PENDING_SESSION_PREFIX = "pending:";

export function createPendingSessionId(): string {
  return `${PENDING_SESSION_PREFIX}${globalThis.crypto.randomUUID()}`;
}

export function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_SESSION_PREFIX);
}

export function createConnectionProgress(
  stage: TerminalConnectionProgress["stage"],
  message: string,
  options: Partial<
    Pick<TerminalConnectionProgress, "blockingKind" | "retryable">
  > = {},
): TerminalConnectionProgress {
  return {
    stage,
    message,
    blockingKind: options.blockingKind ?? "none",
    retryable: options.retryable ?? false,
  };
}

export function createInactiveSessionShareState(): SessionShareState {
  return {
    status: "inactive",
    shareUrl: null,
    inputEnabled: false,
    viewerCount: 0,
    errorMessage: null,
  };
}

export function normalizeSessionShareState(
  state?: SessionShareState | null,
): SessionShareState {
  return state ?? createInactiveSessionShareState();
}

export function setSessionShareState(
  tabs: TerminalTab[],
  sessionId: string,
  nextState: SessionShareState,
): TerminalTab[] {
  return tabs.map((tab) =>
    tab.sessionId === sessionId
      ? {
          ...tab,
          sessionShare: nextState,
        }
      : tab,
  );
}

export function clearSessionShareChatNotifications(
  notifications: Record<string, SessionShareChatMessage[]>,
  sessionId: string,
): Record<string, SessionShareChatMessage[]> {
  if (!(sessionId in notifications)) {
    return notifications;
  }

  const next = { ...notifications };
  delete next[sessionId];
  return next;
}

export function appendSessionShareChatNotification(
  notifications: Record<string, SessionShareChatMessage[]>,
  sessionId: string,
  message: SessionShareChatMessage,
): Record<string, SessionShareChatMessage[]> {
  return {
    ...notifications,
    [sessionId]: [...(notifications[sessionId] ?? []), message],
  };
}

export function dismissSessionShareChatNotification(
  notifications: Record<string, SessionShareChatMessage[]>,
  sessionId: string,
  messageId: string,
): Record<string, SessionShareChatMessage[]> {
  const current = notifications[sessionId];
  if (!current) {
    return notifications;
  }

  const nextMessages = current.filter((message) => message.id !== messageId);
  if (nextMessages.length === current.length) {
    return notifications;
  }

  if (nextMessages.length === 0) {
    return clearSessionShareChatNotifications(notifications, sessionId);
  }

  return {
    ...notifications,
    [sessionId]: nextMessages,
  };
}

export function createPendingSessionTab(input: {
  sessionId: string;
  source: "host" | "local";
  hostId: string | null;
  title: string;
  shellKind?: string;
  progress: TerminalConnectionProgress;
}): TerminalTab {
  return {
    id: input.sessionId,
    sessionId: input.sessionId,
    source: input.source,
    hostId: input.hostId,
    title: input.title,
    shellKind: input.shellKind,
    status: "pending",
    connectionProgress: input.progress,
    sessionShare: createInactiveSessionShareState(),
    hasReceivedOutput: false,
    lastEventAt: new Date().toISOString(),
  };
}

export function findPendingConnectionAttempt(
  state: AppState,
  sessionId: string,
): PendingConnectionAttempt | null {
  return (
    state.pendingConnectionAttempts.find(
      (attempt) => attempt.sessionId === sessionId,
    ) ?? null
  );
}

export function findPendingConnectionAttemptByHost(
  state: AppState,
  hostId: string,
): PendingConnectionAttempt | null {
  return (
    state.pendingConnectionAttempts.find(
      (attempt) => attempt.source === "host" && attempt.hostId === hostId,
    ) ?? null
  );
}

export function isPendingEcsShellAttempt(
  attempt: PendingConnectionAttempt | null,
): attempt is PendingConnectionAttempt & {
  source: "ecs-shell";
  hostId: string;
  serviceName: string;
  taskArn: string;
  containerName: string;
} {
  return Boolean(
    attempt &&
      attempt.source === "ecs-shell" &&
      typeof attempt.hostId === "string" &&
      typeof attempt.serviceName === "string" &&
      typeof attempt.taskArn === "string" &&
      typeof attempt.containerName === "string",
  );
}

export function normalizeEcsExecShellPermissionMessage(
  message?: string | null,
): string | null {
  const normalized = message?.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("cloudshell:ApproveCommand")) {
    return "AWS Console에서 CloudShell로 ECS Exec를 테스트하려면 `cloudshell:ApproveCommand` 권한이 필요합니다. Dolgate 앱 자체에는 필수 권한이 아닙니다.";
  }
  if (normalized.includes("ecs:ExecuteCommand")) {
    return `ECS Exec 권한이 없습니다. 사용자/역할에 \`ecs:ExecuteCommand\`와 보통 \`ecs:DescribeTasks\` 권한이 필요합니다. 원본 오류: ${normalized}`;
  }
  if (normalized.includes("ecs:DescribeTasks")) {
    return `ECS task 조회 권한이 없습니다. 사용자/역할에 \`ecs:DescribeTasks\` 권한이 필요합니다. 원본 오류: ${normalized}`;
  }
  if (normalized.includes("ssm:StartSession")) {
    return `Session Manager 권한이 없습니다. 사용자/역할에 \`ssm:StartSession\` 권한이 필요한지 확인해 주세요. 원본 오류: ${normalized}`;
  }
  return normalized;
}


export function replaceSessionIdInLayout(
  node: WorkspaceLayoutNode,
  previousSessionId: string,
  nextSessionId: string,
): WorkspaceLayoutNode {
  if (node.kind === "leaf") {
    return node.sessionId === previousSessionId
      ? {
          ...node,
          sessionId: nextSessionId,
        }
      : node;
  }

  return {
    ...node,
    first: replaceSessionIdInLayout(
      node.first,
      previousSessionId,
      nextSessionId,
    ),
    second: replaceSessionIdInLayout(
      node.second,
      previousSessionId,
      nextSessionId,
    ),
  };
}

export function replaceSessionReferencesInState(
  state: AppState,
  previousSessionId: string,
  nextSessionId: string,
  transformTab?: (tab: TerminalTab) => TerminalTab,
): Partial<AppState> {
  return {
    tabs: state.tabs.map((tab) => {
      if (tab.sessionId !== previousSessionId) {
        return tab;
      }
      const nextTab: TerminalTab = {
        ...tab,
        id: nextSessionId,
        sessionId: nextSessionId,
      };
      return transformTab ? transformTab(nextTab) : nextTab;
    }),
    tabStrip: state.tabStrip.map((item) =>
      item.kind === "session" && item.sessionId === previousSessionId
        ? { kind: "session", sessionId: nextSessionId }
        : item,
    ),
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      layout: replaceSessionIdInLayout(
        workspace.layout,
        previousSessionId,
        nextSessionId,
      ),
      activeSessionId:
        workspace.activeSessionId === previousSessionId
          ? nextSessionId
          : workspace.activeSessionId,
    })),
    activeWorkspaceTab:
      state.activeWorkspaceTab === asSessionTabId(previousSessionId)
        ? asSessionTabId(nextSessionId)
        : state.activeWorkspaceTab,
    pendingHostKeyPrompt:
      state.pendingHostKeyPrompt?.sessionId === previousSessionId
        ? {
            ...state.pendingHostKeyPrompt,
            sessionId: nextSessionId,
          }
        : state.pendingHostKeyPrompt,
    pendingCredentialRetry:
      state.pendingCredentialRetry?.sessionId === previousSessionId
        ? {
            ...state.pendingCredentialRetry,
            sessionId: nextSessionId,
          }
        : state.pendingCredentialRetry,
    pendingInteractiveAuth:
      isPendingSessionInteractiveAuth(state.pendingInteractiveAuth) &&
      state.pendingInteractiveAuth.sessionId === previousSessionId
        ? {
            ...state.pendingInteractiveAuth,
            sessionId: nextSessionId,
          }
        : state.pendingInteractiveAuth,
  };
}

export function removeSessionFromState(
  state: AppState,
  sessionId: string,
): Partial<AppState> {
  const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId);
  const standaloneIndex = state.tabStrip.findIndex(
    (item) => item.kind === "session" && item.sessionId === sessionId,
  );
  let nextTabStrip = state.tabStrip.filter(
    (item) => !(item.kind === "session" && item.sessionId === sessionId),
  );
  let nextWorkspaces = state.workspaces;
  let nextActive = state.activeWorkspaceTab;

  const owningWorkspace = state.workspaces.find((workspace) =>
    listWorkspaceSessionIds(workspace.layout).includes(sessionId),
  );
  if (owningWorkspace) {
    const reducedLayout = removeSessionFromWorkspaceLayout(
      owningWorkspace.layout,
      sessionId,
    );
    if (!reducedLayout) {
      nextWorkspaces = state.workspaces.filter(
        (workspace) => workspace.id !== owningWorkspace.id,
      );
      const workspaceIndex = state.tabStrip.findIndex(
        (item) =>
          item.kind === "workspace" && item.workspaceId === owningWorkspace.id,
      );
      nextTabStrip = state.tabStrip.filter(
        (item) =>
          !(
            item.kind === "workspace" && item.workspaceId === owningWorkspace.id
          ),
      );
      if (nextActive === asWorkspaceTabId(owningWorkspace.id)) {
        nextActive = resolveNextVisibleTab(
          nextTabStrip,
          workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length,
        );
      }
    } else if (reducedLayout.kind === "leaf") {
      const workspaceIndex = state.tabStrip.findIndex(
        (item) =>
          item.kind === "workspace" && item.workspaceId === owningWorkspace.id,
      );
      nextWorkspaces = state.workspaces.filter(
        (workspace) => workspace.id !== owningWorkspace.id,
      );
      nextTabStrip = state.tabStrip.filter(
        (item) =>
          !(
            item.kind === "workspace" && item.workspaceId === owningWorkspace.id
          ),
      );
      nextTabStrip.splice(
        workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length,
        0,
        {
          kind: "session",
          sessionId: reducedLayout.sessionId,
        },
      );
      if (nextActive === asWorkspaceTabId(owningWorkspace.id)) {
        nextActive = asSessionTabId(reducedLayout.sessionId);
      }
    } else {
      nextWorkspaces = state.workspaces.map((workspace) =>
        workspace.id === owningWorkspace.id
          ? {
              ...workspace,
              layout: reducedLayout,
              activeSessionId:
                workspace.activeSessionId === sessionId
                  ? findFirstWorkspaceSessionId(reducedLayout)
                  : workspace.activeSessionId,
            }
          : workspace,
      );
    }
  } else if (nextActive === asSessionTabId(sessionId)) {
    nextActive = resolveNextVisibleTab(
      nextTabStrip,
      standaloneIndex >= 0 ? standaloneIndex : nextTabStrip.length,
    );
  }

  return {
    tabs,
    sessionShareChatNotifications: clearSessionShareChatNotifications(
      state.sessionShareChatNotifications,
      sessionId,
    ),
    workspaces: nextWorkspaces,
    tabStrip: nextTabStrip,
    activeWorkspaceTab: nextActive,
    pendingHostKeyPrompt:
      state.pendingHostKeyPrompt?.sessionId === sessionId
        ? null
        : state.pendingHostKeyPrompt,
    pendingCredentialRetry:
      state.pendingCredentialRetry?.sessionId === sessionId
        ? null
        : state.pendingCredentialRetry,
    pendingInteractiveAuth:
      isPendingSessionInteractiveAuth(state.pendingInteractiveAuth) &&
      state.pendingInteractiveAuth.sessionId === sessionId
        ? null
        : state.pendingInteractiveAuth,
    pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
      (attempt) => attempt.sessionId !== sessionId,
    ),
  };
}

export function activateSessionContextInState(
  state: AppState,
  sessionId: string,
): Partial<AppState> {
  const owningWorkspace = state.workspaces.find((workspace) =>
    listWorkspaceSessionIds(workspace.layout).includes(sessionId),
  );
  if (!owningWorkspace) {
    return {
      activeWorkspaceTab: asSessionTabId(sessionId),
    };
  }

  return {
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === owningWorkspace.id
        ? {
            ...workspace,
            activeSessionId: sessionId,
          }
        : workspace,
    ),
    activeWorkspaceTab: asWorkspaceTabId(owningWorkspace.id),
  };
}

export function buildWorkspaceTitle(workspaces: WorkspaceTab[]): string {
  const existingTitles = new Set(
    workspaces.map((workspace) => workspace.title),
  );
  if (!existingTitles.has("Workspace")) {
    return "Workspace";
  }

  let suffix = 1;
  while (existingTitles.has(`Workspace (${suffix})`)) {
    suffix += 1;
  }
  return `Workspace (${suffix})`;
}

export function resolveNextVisibleTab(
  tabStrip: DynamicTabStripItem[],
  removedIndex: number,
): WorkspaceTabId {
  const nextItem = tabStrip[removedIndex] ?? tabStrip[removedIndex - 1];
  if (!nextItem) {
    return "home";
  }
  if (nextItem.kind === "session") {
    return asSessionTabId(nextItem.sessionId);
  }
  if (nextItem.kind === "workspace") {
    return asWorkspaceTabId(nextItem.workspaceId);
  }
  return "home";
}

export function resolveAdjacentTarget(
  tabStrip: DynamicTabStripItem[],
  workspaces: WorkspaceTab[],
  sessionId: string,
): DynamicTabStripItem | null {
  const currentIndex = tabStrip.findIndex(
    (item) => item.kind === "session" && item.sessionId === sessionId,
  );
  if (currentIndex < 0) {
    return null;
  }

  const candidateIndexes = [currentIndex + 1, currentIndex - 1];
  for (const index of candidateIndexes) {
    const candidate = tabStrip[index];
    if (!candidate) {
      continue;
    }
    if (candidate.kind === "workspace") {
      const workspace = workspaces.find(
        (item) => item.id === candidate.workspaceId,
      );
      if (!workspace) {
        continue;
      }
      if (countWorkspaceSessions(workspace.layout) >= 4) {
        continue;
      }
    }
    return candidate;
  }

  return null;
}

export function dynamicTabMatches(
  left: DynamicTabStripItem,
  right: DynamicTabStripItem,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "session" && right.kind === "session") {
    return left.sessionId === right.sessionId;
  }
  if (left.kind === "workspace" && right.kind === "workspace") {
    return left.workspaceId === right.workspaceId;
  }
  return false;
}

export function findContainersTab(
  state: AppState,
  hostId: string,
): HostContainersTabState | null {
  return state.containerTabs.find((tab) => tab.hostId === hostId) ?? null;
}

export function parentPath(targetPath: string): string {
  if (!targetPath || targetPath === "/") {
    return targetPath || "/";
  }
  const normalized =
    targetPath.length > 1 && targetPath.endsWith("/")
      ? targetPath.slice(0, -1)
      : targetPath;
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index) || "/";
}

export function resolveCurrentGroupPathAfterGroupRemoval(
  currentGroupPath: string | null,
  removedGroupPath: string,
  mode: GroupRemoveMode,
): string | null {
  const normalizedCurrentPath = normalizeGroupPath(currentGroupPath);
  const normalizedRemovedPath = normalizeGroupPath(removedGroupPath);
  if (
    !normalizedCurrentPath ||
    !normalizedRemovedPath ||
    !isGroupWithinPath(normalizedCurrentPath, normalizedRemovedPath)
  ) {
    return normalizedCurrentPath;
  }

  if (mode === "delete-subtree") {
    return getParentGroupPath(normalizedRemovedPath);
  }

  return stripRemovedGroupSegment(normalizedCurrentPath, normalizedRemovedPath);
}

export function resolveCurrentGroupPathAfterGroupMutation(
  currentGroupPath: string | null,
  previousGroupPath: string,
  nextGroupPath: string,
): string | null {
  return rebaseGroupPath(currentGroupPath, previousGroupPath, nextGroupPath);
}

export function resolveCredentialRetryKind(
  host: HostRecord | undefined,
  message: string,
): "password" | "passphrase" | null {
  if (!host || !isSshHostRecord(host)) {
    return null;
  }

  if (host.authType === "password") {
    return /requires a password|password required|permission denied|unable to authenticate|authentication failed|ssh handshake failed/i.test(
      message,
    )
      ? "password"
      : null;
  }

  return /passphrase|private key|unable to authenticate|authentication failed|ssh handshake failed|parse private key/i.test(
    message,
  )
    ? "passphrase"
    : null;
}

export function shouldPromptAwsSftpConfigRetry(
  host: HostRecord | undefined,
  message: string,
): boolean {
  if (!host || !isAwsEc2HostRecord(host)) {
    return false;
  }
  if (!(host.awsSshUsername ?? "").trim()) {
    return true;
  }
  return /instanceosuser|os user|ssh username|authentication failed|unable to authenticate|ssh handshake failed|permission denied|connection refused|timed out/i.test(
    message,
  );
}

export function resolveHostKeyCheckProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "host-key-check",
    `${host.label} 호스트 키를 확인하는 중입니다.`,
  );
}

export function resolveAwaitingHostTrustProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "awaiting-host-trust",
    `${host.label} 호스트 키 확인이 필요합니다.`,
    {
      blockingKind: "dialog",
    },
  );
}

export function resolveConnectingProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  if (isAwsEc2HostRecord(host)) {
    return createConnectionProgress(
      "connecting",
      `${host.label} SSM 세션을 시작하는 중입니다.`,
    );
  }
  if (isWarpgateSshHostRecord(host)) {
    return createConnectionProgress(
      "connecting",
      `${host.label} Warpgate SSH 세션을 연결하는 중입니다.`,
    );
  }
  return createConnectionProgress(
    "connecting",
    `${host.label} SSH 세션을 연결하는 중입니다.`,
  );
}

export function resolveLocalStartingProgress(): TerminalConnectionProgress {
  return createConnectionProgress(
    "connecting",
    "로컬 터미널을 시작하는 중입니다.",
  );
}

export function resolveWaitingShellProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "waiting-shell",
    `${host.label} 원격 셸이 첫 출력을 보내는 중입니다.`,
  );
}

export function resolveLocalWaitingShellProgress(): TerminalConnectionProgress {
  return createConnectionProgress("waiting-shell", "셸이 준비되는 중입니다.");
}

export function resolveCredentialRetryProgress(
  host: HostRecord,
  credentialKind: PendingCredentialRetry["credentialKind"],
): TerminalConnectionProgress {
  return createConnectionProgress(
    "awaiting-credentials",
    credentialKind === "password"
      ? `${host.label} 비밀번호를 다시 입력해 주세요.`
      : `${host.label} passphrase를 다시 입력해 주세요.`,
    {
      blockingKind: "dialog",
      retryable: true,
    },
  );
}

export function resolveErrorProgress(
  message: string,
  retryable = true,
): TerminalConnectionProgress {
  return createConnectionProgress("connecting", message, {
    retryable,
  });
}

export function normalizeInteractiveText(value: string | undefined | null): string {
  return (value ?? "").trim();
}

export function parseWarpgateApprovalUrl(
  ...parts: Array<string | undefined | null>
): string | null {
  const combined = parts
    .map(normalizeInteractiveText)
    .filter(Boolean)
    .join("\n");
  const match = combined.match(/https?:\/\/[^\s<>"')]+/i);
  return match ? match[0] : null;
}

export function parseWarpgateAuthCode(
  ...parts: Array<string | undefined | null>
): string | null {
  const combined = parts
    .map(normalizeInteractiveText)
    .filter(Boolean)
    .join("\n");
  const labeledMatch = combined.match(
    /(?:auth(?:entication)?|verification|security|device)?\s*code\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  );
  if (labeledMatch) {
    return labeledMatch[1];
  }
  const tokenMatch = combined.match(/([A-Z0-9]{4,}(?:-[A-Z0-9]{2,})+)/i);
  return tokenMatch ? tokenMatch[1] : null;
}

export function isWarpgateCompletionPrompt(
  label: string,
  instruction: string,
): boolean {
  return /press enter when done|press enter to continue|once authorized|after authoriz|after logging in|after completing authentication|hit enter|return to continue/i.test(
    `${label}\n${instruction}`,
  );
}

export function isWarpgateCodePrompt(label: string, instruction: string): boolean {
  return (
    /code|verification|security|token|device/i.test(label) ||
    (/code/i.test(instruction) && !/press enter/i.test(label))
  );
}

export function shouldTreatAsWarpgate(
  host: HostRecord | undefined,
  challenge: KeyboardInteractiveChallenge,
): boolean {
  if (!host || !isWarpgateSshHostRecord(host)) {
    return false;
  }
  const sourceText = `${challenge.name ?? ""}\n${challenge.instruction}\n${challenge.prompts.map((prompt) => prompt.label).join("\n")}`;
  return /warpgate|authorize|device authorization|device code|verification code/i.test(
    sourceText,
  );
}

export function resolveInteractiveAuthUiState(
  host: HostRecord | undefined,
  challenge: KeyboardInteractiveChallenge,
): {
  provider: "generic" | "warpgate";
  approvalUrl: string | null;
  authCode: string | null;
  autoResponses: string[];
  autoSubmitted: boolean;
} {
  const isWarpgateChallenge = shouldTreatAsWarpgate(host, challenge);
  const approvalUrl = isWarpgateChallenge
    ? parseWarpgateApprovalUrl(
        challenge.instruction,
        challenge.name,
        ...challenge.prompts.map((prompt) => prompt.label),
      )
    : null;
  const authCode = isWarpgateChallenge
    ? parseWarpgateAuthCode(
        challenge.instruction,
        challenge.name,
        ...challenge.prompts.map((prompt) => prompt.label),
      )
    : null;
  const provider =
    isWarpgateChallenge && Boolean(approvalUrl || authCode)
      ? "warpgate"
      : "generic";

  const autoResponses: string[] = [];
  let canAutoRespond = challenge.prompts.length > 0;
  for (const prompt of challenge.prompts) {
    if (
      provider === "warpgate" &&
      authCode &&
      isWarpgateCodePrompt(prompt.label, challenge.instruction)
    ) {
      autoResponses.push(authCode);
      continue;
    }
    if (
      provider === "warpgate" &&
      isWarpgateCompletionPrompt(prompt.label, challenge.instruction)
    ) {
      autoResponses.push("");
      continue;
    }
    canAutoRespond = false;
    break;
  }

  return {
    provider,
    approvalUrl,
    authCode,
    autoResponses,
    autoSubmitted:
      canAutoRespond &&
      autoResponses.length === challenge.prompts.length &&
      challenge.prompts.length > 0,
  };
}

export function buildInteractiveBrowserChallengeKey(input: {
  sessionId?: string | null;
  endpointId?: string | null;
  challengeId: string;
  approvalUrl?: string | null;
}): string {
  const scopeId = normalizeInteractiveText(input.sessionId ?? input.endpointId);
  const approvalUrl = normalizeInteractiveText(input.approvalUrl);
  if (scopeId && approvalUrl) {
    return `${scopeId}::${approvalUrl}`;
  }
  if (scopeId) {
    return `${scopeId}::${input.challengeId}`;
  }
  if (approvalUrl) {
    return approvalUrl;
  }
  return input.challengeId;
}

export function upsertTransferJob(
  transfers: TransferJob[],
  job: TransferJob,
): TransferJob[] {
  const existingIndex = transfers.findIndex((item) => item.id === job.id);
  if (existingIndex >= 0) {
    return transfers.map((item, index) =>
      index === existingIndex ? job : item,
    );
  }
  return [job, ...transfers].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

export function upsertForwardRuntime(
  runtimes: PortForwardRuntimeRecord[],
  runtime: PortForwardRuntimeRecord,
): PortForwardRuntimeRecord[] {
  const next = [
    runtime,
    ...runtimes.filter((item) => item.ruleId !== runtime.ruleId),
  ];
  return next.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

export function basenameFromPath(targetPath: string): string {
  const normalized = targetPath.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return separatorIndex >= 0
    ? normalized.slice(separatorIndex + 1)
    : normalized;
}

export function resolveSftpVisibleEntryPaths(
  pane: SftpPaneState,
  provided?: string[],
): string[] {
  if (provided && provided.length > 0) {
    const available = new Set(pane.entries.map((entry) => entry.path));
    return provided.filter((entryPath) => available.has(entryPath));
  }
  return pane.entries
    .filter((entry) => {
      if (!pane.filterQuery.trim()) {
        return true;
      }
      return entry.name
        .toLowerCase()
        .includes(pane.filterQuery.trim().toLowerCase());
    })
    .map((entry) => entry.path);
}

export function resolveNextSftpSelection(
  pane: SftpPaneState,
  input: SftpEntrySelectionInput,
): Pick<SftpPaneState, "selectedPaths" | "selectionAnchorPath"> {
  if (!input.entryPath) {
    return {
      selectedPaths: [],
      selectionAnchorPath: null,
    };
  }

  const entryExists = pane.entries.some(
    (entry) => entry.path === input.entryPath,
  );
  if (!entryExists) {
    return {
      selectedPaths: pane.selectedPaths,
      selectionAnchorPath: pane.selectionAnchorPath,
    };
  }

  if (input.range) {
    const visiblePaths = resolveSftpVisibleEntryPaths(
      pane,
      input.visibleEntryPaths,
    );
    const anchorPath =
      pane.selectionAnchorPath &&
      visiblePaths.includes(pane.selectionAnchorPath)
        ? pane.selectionAnchorPath
        : null;
    const targetIndex = visiblePaths.indexOf(input.entryPath);
    if (!anchorPath || targetIndex < 0) {
      return {
        selectedPaths: [input.entryPath],
        selectionAnchorPath: input.entryPath,
      };
    }
    const anchorIndex = visiblePaths.indexOf(anchorPath);
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return {
      selectedPaths: visiblePaths.slice(start, end + 1),
      selectionAnchorPath: anchorPath,
    };
  }

  if (input.toggle) {
    const nextSelected = pane.selectedPaths.includes(input.entryPath)
      ? pane.selectedPaths.filter((entryPath) => entryPath !== input.entryPath)
      : [...pane.selectedPaths, input.entryPath];
    return {
      selectedPaths: nextSelected,
      selectionAnchorPath: input.entryPath,
    };
  }

  return {
    selectedPaths: [input.entryPath],
    selectionAnchorPath: input.entryPath,
  };
}

export function resolveTransferItemsFromPane(
  pane: SftpPaneState,
  draggedPath?: string | null,
): FileEntry[] {
  if (!draggedPath) {
    return pane.entries.filter((entry) =>
      pane.selectedPaths.includes(entry.path),
    );
  }
  const selected = pane.entries.filter((entry) =>
    pane.selectedPaths.includes(entry.path),
  );
  if (selected.some((entry) => entry.path === draggedPath)) {
    return selected;
  }
  return pane.entries.filter((entry) => entry.path === draggedPath);
}

export function isBrowsableSftpPane(pane: SftpPaneState): boolean {
  return (
    pane.sourceKind === "local" ||
    (Boolean(pane.endpoint) && !pane.connectingHostId)
  );
}

export function pushHistory(
  pane: SftpPaneState,
  nextPath: string,
): Pick<SftpPaneState, "history" | "historyIndex"> {
  const historyPrefix = pane.history.slice(0, pane.historyIndex + 1);
  if (historyPrefix[historyPrefix.length - 1] === nextPath) {
    return {
      history: historyPrefix,
      historyIndex: historyPrefix.length - 1,
    };
  }
  const history = [...historyPrefix, nextPath];
  return {
    history,
    historyIndex: history.length - 1,
  };
}

export function getPane(state: AppState, paneId: SftpPaneId): SftpPaneState {
  return paneId === "left" ? state.sftp.leftPane : state.sftp.rightPane;
}

export function updatePaneState(
  state: AppState,
  paneId: SftpPaneId,
  nextPane: SftpPaneState,
): SftpState {
  return {
    ...state.sftp,
    leftPane: paneId === "left" ? nextPane : state.sftp.leftPane,
    rightPane: paneId === "right" ? nextPane : state.sftp.rightPane,
  };
}

export function toTrustInput(probe: HostKeyProbeResult) {
  return {
    hostId: probe.hostId,
    hostLabel: probe.hostLabel,
    host: probe.host,
    port: probe.port,
    algorithm: probe.algorithm,
    publicKeyBase64: probe.publicKeyBase64,
    fingerprintSha256: probe.fingerprintSha256,
  };
}
