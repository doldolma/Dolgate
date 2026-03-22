import { createStore } from 'zustand/vanilla';
import type {
  ActivityLogRecord,
  AppSettings,
  CoreEvent,
  DesktopApi,
  DirectoryListing,
  FileEntry,
  GroupRecord,
  HostDraft,
  HostKeyProbeResult,
  HostRecord,
  HostSecretInput,
  KnownHostRecord,
  PortForwardDraft,
  PortForwardRuleRecord,
  PortForwardRuntimeEvent,
  PortForwardRuntimeRecord,
  SftpEndpointSummary,
  SftpPaneId,
  SecretMetadataRecord,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput
} from '@shared';

export type SessionWorkspaceTabId = `session:${string}`;
export type SplitWorkspaceTabId = `workspace:${string}`;
export type WorkspaceTabId = 'home' | 'sftp' | SessionWorkspaceTabId | SplitWorkspaceTabId;
export type HomeSection = 'hosts' | 'portForwarding' | 'knownHosts' | 'logs' | 'keychain' | 'settings';
export type SftpSourceKind = 'local' | 'host';
export type WorkspaceDropDirection = 'left' | 'right' | 'top' | 'bottom';
export type HostDrawerState =
  | { mode: 'closed' }
  | { mode: 'create'; defaultGroupPath: string | null }
  | { mode: 'edit'; hostId: string };

export interface WorkspaceLeafNode {
  id: string;
  kind: 'leaf';
  sessionId: string;
}

export interface WorkspaceSplitNode {
  id: string;
  kind: 'split';
  axis: 'horizontal' | 'vertical';
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
}

export type DynamicTabStripItem =
  | {
      kind: 'session';
      sessionId: string;
    }
  | {
      kind: 'workspace';
      workspaceId: string;
    };

export interface SftpPaneState {
  id: SftpPaneId;
  sourceKind: SftpSourceKind;
  endpoint: SftpEndpointSummary | null;
  currentPath: string;
  lastLocalPath: string;
  history: string[];
  historyIndex: number;
  entries: FileEntry[];
  selectedPaths: string[];
  filterQuery: string;
  selectedHostId: string | null;
  hostSearchQuery: string;
  isLoading: boolean;
  errorMessage?: string;
}

export interface PendingConflictDialog {
  input: TransferStartInput;
  names: string[];
}

export interface PendingHostKeyPrompt {
  probe: HostKeyProbeResult;
  action:
    | {
        kind: 'ssh';
        hostId: string;
        cols: number;
        rows: number;
      }
    | {
        kind: 'sftp';
        paneId: SftpPaneId;
        hostId: string;
      }
    | {
        kind: 'portForward';
        ruleId: string;
        hostId: string;
      };
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
  workspaces: WorkspaceTab[];
  tabStrip: DynamicTabStripItem[];
  portForwards: PortForwardRuleRecord[];
  portForwardRuntimes: PortForwardRuntimeRecord[];
  knownHosts: KnownHostRecord[];
  activityLogs: ActivityLogRecord[];
  keychainEntries: SecretMetadataRecord[];
  activeWorkspaceTab: WorkspaceTabId;
  homeSection: HomeSection;
  hostDrawer: HostDrawerState;
  currentGroupPath: string | null;
  searchQuery: string;
  settings: AppSettings;
  isReady: boolean;
  sftp: SftpState;
  pendingHostKeyPrompt: PendingHostKeyPrompt | null;
  setSearchQuery: (value: string) => void;
  activateHome: () => void;
  activateSftp: () => void;
  activateSession: (sessionId: string) => void;
  activateWorkspace: (workspaceId: string) => void;
  openHomeSection: (section: HomeSection) => void;
  openCreateHostDrawer: () => void;
  openEditHostDrawer: (hostId: string) => void;
  closeHostDrawer: () => void;
  navigateGroup: (path: string | null) => void;
  bootstrap: () => Promise<void>;
  refreshOperationalData: () => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  saveHost: (hostId: string | null, draft: HostDraft, secrets?: HostSecretInput) => Promise<void>;
  moveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  removeHost: (hostId: string) => Promise<void>;
  connectHost: (hostId: string, cols: number, rows: number) => Promise<void>;
  disconnectTab: (sessionId: string) => Promise<void>;
  closeWorkspace: (workspaceId: string) => Promise<void>;
  splitSessionIntoWorkspace: (sessionId: string, direction: WorkspaceDropDirection, targetSessionId?: string) => boolean;
  detachSessionFromWorkspace: (workspaceId: string, sessionId: string) => void;
  focusWorkspaceSession: (workspaceId: string, sessionId: string) => void;
  resizeWorkspaceSplit: (workspaceId: string, splitId: string, ratio: number) => void;
  updateSettings: (input: Partial<AppSettings>) => Promise<void>;
  savePortForward: (ruleId: string | null, draft: PortForwardDraft) => Promise<void>;
  removePortForward: (ruleId: string) => Promise<void>;
  startPortForward: (ruleId: string) => Promise<void>;
  stopPortForward: (ruleId: string) => Promise<void>;
  removeKnownHost: (id: string) => Promise<void>;
  clearLogs: () => Promise<void>;
  removeKeychainSecret: (secretRef: string) => Promise<void>;
  updateKeychainSecret: (secretRef: string, secrets: HostSecretInput) => Promise<void>;
  cloneKeychainSecretForHost: (hostId: string, sourceSecretRef: string, secrets: HostSecretInput) => Promise<void>;
  acceptPendingHostKeyPrompt: (mode: 'trust' | 'replace') => Promise<void>;
  dismissPendingHostKeyPrompt: () => void;
  handleCoreEvent: (event: CoreEvent<Record<string, unknown>>) => void;
  handleTransferEvent: (event: TransferJobEvent) => void;
  handlePortForwardEvent: (event: PortForwardRuntimeEvent) => void;
  setSftpPaneSource: (paneId: SftpPaneId, sourceKind: SftpSourceKind) => Promise<void>;
  setSftpPaneFilter: (paneId: SftpPaneId, query: string) => void;
  setSftpHostSearchQuery: (paneId: SftpPaneId, query: string) => void;
  selectSftpHost: (paneId: SftpPaneId, hostId: string) => void;
  connectSftpHost: (paneId: SftpPaneId, hostId: string) => Promise<void>;
  openSftpEntry: (paneId: SftpPaneId, entryPath: string) => Promise<void>;
  refreshSftpPane: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpBack: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpForward: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpParent: (paneId: SftpPaneId) => Promise<void>;
  navigateSftpBreadcrumb: (paneId: SftpPaneId, nextPath: string) => Promise<void>;
  selectSftpEntry: (paneId: SftpPaneId, entryPath: string) => void;
  createSftpDirectory: (paneId: SftpPaneId, name: string) => Promise<void>;
  renameSftpSelection: (paneId: SftpPaneId, nextName: string) => Promise<void>;
  deleteSftpSelection: (paneId: SftpPaneId) => Promise<void>;
  prepareSftpTransfer: (sourcePaneId: SftpPaneId, targetPaneId: SftpPaneId, targetPath: string, draggedPath: string) => Promise<void>;
  resolveSftpConflict: (resolution: 'overwrite' | 'skip' | 'keepBoth') => Promise<void>;
  dismissSftpConflict: () => void;
  cancelTransfer: (jobId: string) => Promise<void>;
  retryTransfer: (jobId: string) => Promise<void>;
}

type TabStatus = TerminalTab['status'];

const defaultSettings: AppSettings = {
  theme: 'system',
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: 'sf-mono',
  terminalFontSize: 13,
  dismissedUpdateVersion: null,
  updatedAt: new Date(0).toISOString()
};

function createEmptyPane(id: SftpPaneId): SftpPaneState {
  return {
    id,
    sourceKind: id === 'left' ? 'local' : 'host',
    endpoint: null,
    currentPath: '',
    lastLocalPath: '',
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    filterQuery: '',
    selectedHostId: null,
    hostSearchQuery: '',
    isLoading: false
  };
}

const defaultSftpState: SftpState = {
  localHomePath: '',
  leftPane: createEmptyPane('left'),
  rightPane: createEmptyPane('right'),
  transfers: [],
  pendingConflictDialog: null
};

function sortHosts(hosts: HostRecord[]): HostRecord[] {
  return [...hosts].sort((a, b) => {
    const groupCompare = (a.groupName ?? '').localeCompare(b.groupName ?? '');
    if (groupCompare !== 0) {
      return groupCompare;
    }
    return a.label.localeCompare(b.label);
  });
}

function sortGroups(groups: GroupRecord[]): GroupRecord[] {
  return [...groups].sort((a, b) => a.path.localeCompare(b.path));
}

function sortPortForwards(rules: PortForwardRuleRecord[]): PortForwardRuleRecord[] {
  return [...rules].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.label.localeCompare(b.label));
}

function sortKnownHosts(records: KnownHostRecord[]): KnownHostRecord[] {
  return [...records].sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
}

function sortLogs(records: ActivityLogRecord[]): ActivityLogRecord[] {
  return [...records].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function sortKeychainEntries(entries: SecretMetadataRecord[]): SecretMetadataRecord[] {
  return [...entries].sort((a, b) => a.label.localeCompare(b.label) || a.secretRef.localeCompare(b.secretRef));
}

function asSessionTabId(sessionId: string): SessionWorkspaceTabId {
  return `session:${sessionId}`;
}

function asWorkspaceTabId(workspaceId: string): SplitWorkspaceTabId {
  return `workspace:${workspaceId}`;
}

function createWorkspaceLeaf(sessionId: string): WorkspaceLeafNode {
  return {
    id: globalThis.crypto.randomUUID(),
    kind: 'leaf',
    sessionId
  };
}

function directionAxis(direction: WorkspaceDropDirection): WorkspaceSplitNode['axis'] {
  return direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
}

function createWorkspaceSplit(
  existingSessionId: string,
  incomingSessionId: string,
  direction: WorkspaceDropDirection
): WorkspaceLayoutNode {
  const existingLeaf = createWorkspaceLeaf(existingSessionId);
  const incomingLeaf = createWorkspaceLeaf(incomingSessionId);
  const prependIncoming = direction === 'left' || direction === 'top';
  return {
    id: globalThis.crypto.randomUUID(),
    kind: 'split',
    axis: directionAxis(direction),
    ratio: 0.5,
    first: prependIncoming ? incomingLeaf : existingLeaf,
    second: prependIncoming ? existingLeaf : incomingLeaf
  };
}

function listWorkspaceSessionIds(node: WorkspaceLayoutNode): string[] {
  if (node.kind === 'leaf') {
    return [node.sessionId];
  }
  return [...listWorkspaceSessionIds(node.first), ...listWorkspaceSessionIds(node.second)];
}

function countWorkspaceSessions(node: WorkspaceLayoutNode): number {
  return listWorkspaceSessionIds(node).length;
}

function findFirstWorkspaceSessionId(node: WorkspaceLayoutNode): string {
  return node.kind === 'leaf' ? node.sessionId : findFirstWorkspaceSessionId(node.first);
}

function insertSessionIntoWorkspaceLayout(
  node: WorkspaceLayoutNode,
  targetSessionId: string,
  incomingSessionId: string,
  direction: WorkspaceDropDirection
): { layout: WorkspaceLayoutNode; inserted: boolean } {
  if (node.kind === 'leaf') {
    if (node.sessionId !== targetSessionId) {
      return { layout: node, inserted: false };
    }
    return {
      layout: createWorkspaceSplit(targetSessionId, incomingSessionId, direction),
      inserted: true
    };
  }

  const nextFirst = insertSessionIntoWorkspaceLayout(node.first, targetSessionId, incomingSessionId, direction);
  if (nextFirst.inserted) {
    return {
      layout: {
        ...node,
        first: nextFirst.layout
      },
      inserted: true
    };
  }

  const nextSecond = insertSessionIntoWorkspaceLayout(node.second, targetSessionId, incomingSessionId, direction);
  if (nextSecond.inserted) {
    return {
      layout: {
        ...node,
        second: nextSecond.layout
      },
      inserted: true
    };
  }

  return { layout: node, inserted: false };
}

function removeSessionFromWorkspaceLayout(node: WorkspaceLayoutNode, sessionId: string): WorkspaceLayoutNode | null {
  if (node.kind === 'leaf') {
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
    second: nextSecond
  };
}

function updateWorkspaceSplitRatio(node: WorkspaceLayoutNode, splitId: string, ratio: number): WorkspaceLayoutNode {
  if (node.kind === 'leaf') {
    return node;
  }

  const clampedRatio = Math.min(0.8, Math.max(0.2, ratio));
  if (node.id === splitId) {
    return {
      ...node,
      ratio: clampedRatio
    };
  }

  return {
    ...node,
    first: updateWorkspaceSplitRatio(node.first, splitId, clampedRatio),
    second: updateWorkspaceSplitRatio(node.second, splitId, clampedRatio)
  };
}

function buildSessionTitle(label: string, hostId: string, tabs: TerminalTab[]): string {
  const existingTitles = new Set(tabs.filter((tab) => tab.hostId === hostId).map((tab) => tab.title));
  if (!existingTitles.has(label)) {
    return label;
  }

  let suffix = 1;
  while (existingTitles.has(`${label} (${suffix})`)) {
    suffix += 1;
  }
  return `${label} (${suffix})`;
}

function buildWorkspaceTitle(workspaces: WorkspaceTab[]): string {
  const existingTitles = new Set(workspaces.map((workspace) => workspace.title));
  if (!existingTitles.has('Workspace')) {
    return 'Workspace';
  }

  let suffix = 1;
  while (existingTitles.has(`Workspace (${suffix})`)) {
    suffix += 1;
  }
  return `Workspace (${suffix})`;
}

function resolveNextVisibleTab(
  tabStrip: DynamicTabStripItem[],
  removedIndex: number
): WorkspaceTabId {
  const nextItem = tabStrip[removedIndex] ?? tabStrip[removedIndex - 1];
  if (!nextItem) {
    return 'home';
  }
  return nextItem.kind === 'session' ? asSessionTabId(nextItem.sessionId) : asWorkspaceTabId(nextItem.workspaceId);
}

function resolveAdjacentTarget(
  tabStrip: DynamicTabStripItem[],
  workspaces: WorkspaceTab[],
  sessionId: string
): DynamicTabStripItem | null {
  const currentIndex = tabStrip.findIndex((item) => item.kind === 'session' && item.sessionId === sessionId);
  if (currentIndex < 0) {
    return null;
  }

  const candidateIndexes = [currentIndex + 1, currentIndex - 1];
  for (const index of candidateIndexes) {
    const candidate = tabStrip[index];
    if (!candidate) {
      continue;
    }
    if (candidate.kind === 'workspace') {
      const workspace = workspaces.find((item) => item.id === candidate.workspaceId);
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

function normalizeGroupPath(groupPath?: string | null): string | null {
  const normalized = (groupPath ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  return normalized.length > 0 ? normalized : null;
}

function parentPath(targetPath: string): string {
  if (!targetPath || targetPath === '/') {
    return targetPath || '/';
  }
  const normalized = targetPath.length > 1 && targetPath.endsWith('/') ? targetPath.slice(0, -1) : targetPath;
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return normalized.slice(0, index) || '/';
}

function upsertTransferJob(transfers: TransferJob[], job: TransferJob): TransferJob[] {
  const next = [job, ...transfers.filter((item) => item.id !== job.id)];
  return next.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function upsertForwardRuntime(runtimes: PortForwardRuntimeRecord[], runtime: PortForwardRuntimeRecord): PortForwardRuntimeRecord[] {
  const next = [runtime, ...runtimes.filter((item) => item.ruleId !== runtime.ruleId)];
  return next.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

function resolveTargetItems(pane: SftpPaneState, draggedPath: string): FileEntry[] {
  const selected = pane.entries.filter((entry) => pane.selectedPaths.includes(entry.path));
  if (selected.some((entry) => entry.path === draggedPath)) {
    return selected;
  }
  return pane.entries.filter((entry) => entry.path === draggedPath);
}

function pushHistory(pane: SftpPaneState, nextPath: string): Pick<SftpPaneState, 'history' | 'historyIndex'> {
  const historyPrefix = pane.history.slice(0, pane.historyIndex + 1);
  if (historyPrefix[historyPrefix.length - 1] === nextPath) {
    return {
      history: historyPrefix,
      historyIndex: historyPrefix.length - 1
    };
  }
  const history = [...historyPrefix, nextPath];
  return {
    history,
    historyIndex: history.length - 1
  };
}

function getPane(state: AppState, paneId: SftpPaneId): SftpPaneState {
  return paneId === 'left' ? state.sftp.leftPane : state.sftp.rightPane;
}

function updatePaneState(state: AppState, paneId: SftpPaneId, nextPane: SftpPaneState): SftpState {
  return {
    ...state.sftp,
    leftPane: paneId === 'left' ? nextPane : state.sftp.leftPane,
    rightPane: paneId === 'right' ? nextPane : state.sftp.rightPane
  };
}

function toTrustInput(probe: HostKeyProbeResult) {
  return {
    hostId: probe.hostId,
    hostLabel: probe.hostLabel,
    host: probe.host,
    port: probe.port,
    algorithm: probe.algorithm,
    publicKeyBase64: probe.publicKeyBase64,
    fingerprintSha256: probe.fingerprintSha256
  };
}

export function createAppStore(api: DesktopApi) {
  const syncOperationalData = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void
  ) => {
    const [snapshot, knownHosts, activityLogs, keychainEntries] = await Promise.all([
      api.portForwards.list(),
      api.knownHosts.list(),
      api.logs.list(),
      api.keychain.list()
    ]);

    set({
      portForwards: sortPortForwards(snapshot.rules),
      portForwardRuntimes: snapshot.runtimes,
      knownHosts: sortKnownHosts(knownHosts),
      activityLogs: sortLogs(activityLogs),
      keychainEntries: sortKeychainEntries(keychainEntries)
    });
  };

  const loadPaneListing = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    get: () => AppState,
    paneId: SftpPaneId,
    targetPath: string,
    options: { pushToHistory: boolean }
  ) => {
    const pane = getPane(get(), paneId);

    set((state) => ({
      sftp: updatePaneState(state, paneId, {
        ...pane,
        isLoading: true,
        errorMessage: undefined
      })
    }));

    try {
      const listing =
        pane.sourceKind === 'local'
          ? await api.files.list(targetPath)
          : await api.sftp.list({
              endpointId: pane.endpoint?.id ?? '',
              path: targetPath
            });

      set((state) => {
        const latestPane = getPane(state, paneId);
        const historyPatch = options.pushToHistory ? pushHistory(latestPane, listing.path) : { history: latestPane.history, historyIndex: latestPane.historyIndex };
        const nextPane: SftpPaneState = {
          ...latestPane,
          currentPath: listing.path,
          lastLocalPath: latestPane.sourceKind === 'local' ? listing.path : latestPane.lastLocalPath,
          entries: listing.entries,
          selectedPaths: [],
          isLoading: false,
          errorMessage: undefined,
          ...historyPatch,
          endpoint:
            latestPane.sourceKind === 'host' && latestPane.endpoint
              ? {
                  ...latestPane.endpoint,
                  path: listing.path
                }
              : latestPane.endpoint
        };

        return {
          sftp: updatePaneState(state, paneId, nextPane)
        };
      });
    } catch (error) {
      set((state) => ({
        sftp: updatePaneState(state, paneId, {
          ...getPane(state, paneId),
          isLoading: false,
          errorMessage: error instanceof Error ? error.message : 'SFTP 목록을 읽지 못했습니다.'
        })
      }));
    }
  };

  const runTrustedAction = async (
    get: () => AppState,
    action: PendingHostKeyPrompt['action'],
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void
  ) => {
    if (action.kind === 'ssh') {
      const host = get().hosts.find((item) => item.id === action.hostId);
      if (!host) {
        return;
      }
      const title = buildSessionTitle(host.label, action.hostId, get().tabs);
      const { sessionId } = await api.ssh.connect({
        hostId: action.hostId,
        title,
        cols: action.cols,
        rows: action.rows
      });
      const tab: TerminalTab = {
        id: sessionId,
        title,
        hostId: action.hostId,
        sessionId,
        status: 'connecting',
        lastEventAt: new Date().toISOString()
      };
      set((state) => ({
        tabs: [...state.tabs.filter((item) => item.id !== sessionId), tab],
        tabStrip: [...state.tabStrip.filter((item) => !(item.kind === 'session' && item.sessionId === sessionId)), { kind: 'session', sessionId }],
        activeWorkspaceTab: asSessionTabId(sessionId),
        homeSection: 'hosts',
        hostDrawer: { mode: 'closed' }
      }));
      return;
    }

    if (action.kind === 'sftp') {
      const pane = getPane(get(), action.paneId);
      if (pane.endpoint) {
        await api.sftp.disconnect(pane.endpoint.id);
      }
      set((state) => ({
        activeWorkspaceTab: 'sftp',
        sftp: updatePaneState(state, action.paneId, {
          ...getPane(state, action.paneId),
          sourceKind: 'host',
          endpoint: null,
          entries: [],
          isLoading: true,
          errorMessage: undefined,
          selectedHostId: action.hostId
        })
      }));
      try {
        const endpoint = await api.sftp.connect({ hostId: action.hostId });
        set((state) => ({
          sftp: updatePaneState(state, action.paneId, {
            ...getPane(state, action.paneId),
            sourceKind: 'host',
            endpoint,
            currentPath: endpoint.path,
            history: [endpoint.path],
            historyIndex: 0,
            selectedPaths: [],
            errorMessage: undefined
          })
        }));
        await loadPaneListing(set, get, action.paneId, endpoint.path, { pushToHistory: false });
      } catch (error) {
        set((state) => ({
          sftp: updatePaneState(state, action.paneId, {
            ...getPane(state, action.paneId),
            sourceKind: 'host',
            endpoint: null,
            entries: [],
            isLoading: false,
            errorMessage: error instanceof Error ? error.message : 'SFTP 연결에 실패했습니다.'
          })
        }));
      }
      return;
    }

    try {
      const runtime = await api.portForwards.start(action.ruleId);
      set((state) => ({
        homeSection: 'portForwarding',
        portForwardRuntimes: upsertForwardRuntime(state.portForwardRuntimes, runtime)
      }));
    } catch {
      // 시작 실패는 main/core가 런타임 에러 이벤트와 활동 로그로 전달하므로 여기서는 중복 예외를 올리지 않는다.
    }
  };

  const ensureTrustedHost = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    input: { hostId: string; action: PendingHostKeyPrompt['action'] }
  ): Promise<boolean> => {
    const probe = await api.knownHosts.probeHost({ hostId: input.hostId });
    if (probe.status === 'trusted') {
      return true;
    }
    set({
      pendingHostKeyPrompt: {
        probe,
        action: input.action
      }
    });
    return false;
  };

  const store = createStore<AppState>((set, get) => {
    return {
      hosts: [],
      groups: [],
      tabs: [],
      workspaces: [],
      tabStrip: [],
      portForwards: [],
      portForwardRuntimes: [],
      knownHosts: [],
      activityLogs: [],
      keychainEntries: [],
      activeWorkspaceTab: 'home',
      homeSection: 'hosts',
      hostDrawer: { mode: 'closed' },
      currentGroupPath: null,
      searchQuery: '',
      settings: defaultSettings,
      isReady: false,
      sftp: defaultSftpState,
      pendingHostKeyPrompt: null,
      setSearchQuery: (value) => set({ searchQuery: value }),
      activateHome: () => set({ activeWorkspaceTab: 'home' }),
      activateSftp: () => set({ activeWorkspaceTab: 'sftp' }),
      activateSession: (sessionId) => set({ activeWorkspaceTab: asSessionTabId(sessionId) }),
      activateWorkspace: (workspaceId) => set({ activeWorkspaceTab: asWorkspaceTabId(workspaceId) }),
      openHomeSection: (section) =>
        set({
          activeWorkspaceTab: 'home',
          homeSection: section,
          hostDrawer: section === 'hosts' ? get().hostDrawer : { mode: 'closed' }
        }),
      openCreateHostDrawer: () =>
        set({
          activeWorkspaceTab: 'home',
          homeSection: 'hosts',
          hostDrawer: { mode: 'create', defaultGroupPath: get().currentGroupPath }
        }),
      openEditHostDrawer: (hostId) =>
        set({
          activeWorkspaceTab: 'home',
          homeSection: 'hosts',
          hostDrawer: { mode: 'edit', hostId }
        }),
      closeHostDrawer: () => set({ hostDrawer: { mode: 'closed' } }),
      navigateGroup: (path) =>
        set({
          activeWorkspaceTab: 'home',
          homeSection: 'hosts',
          currentGroupPath: normalizeGroupPath(path),
          hostDrawer: { mode: 'closed' }
        }),
      bootstrap: async () => {
        const [hosts, groups, tabs, settings, localHomePath, snapshot, knownHosts, activityLogs, keychainEntries] = await Promise.all([
          api.hosts.list(),
          api.groups.list(),
          api.tabs.list(),
          api.settings.get(),
          api.files.getHomeDirectory(),
          api.portForwards.list(),
          api.knownHosts.list(),
          api.logs.list(),
          api.keychain.list()
        ]);
        const localListing = await api.files.list(localHomePath);
        set({
          hosts: sortHosts(hosts),
          groups: sortGroups(groups),
          tabs,
          workspaces: [],
          tabStrip: tabs.map((tab) => ({ kind: 'session' as const, sessionId: tab.sessionId })),
          portForwards: sortPortForwards(snapshot.rules),
          portForwardRuntimes: snapshot.runtimes,
          knownHosts: sortKnownHosts(knownHosts),
          activityLogs: sortLogs(activityLogs),
          keychainEntries: sortKeychainEntries(keychainEntries),
          activeWorkspaceTab: 'home',
          homeSection: 'hosts',
          hostDrawer: { mode: 'closed' },
          currentGroupPath: null,
          settings,
          isReady: true,
          pendingHostKeyPrompt: null,
          sftp: {
            localHomePath,
            leftPane: {
              ...createEmptyPane('left'),
              sourceKind: 'local',
              currentPath: localListing.path,
              lastLocalPath: localListing.path,
              history: [localListing.path],
              historyIndex: 0,
              entries: localListing.entries
            },
            rightPane: createEmptyPane('right'),
            transfers: [],
            pendingConflictDialog: null
          }
        });
      },
      refreshOperationalData: async () => {
        await syncOperationalData(set);
      },
      createGroup: async (name) => {
        const next = await api.groups.create(name, get().currentGroupPath);
        set((state) => ({
          groups: sortGroups([...state.groups.filter((group) => group.id !== next.id), next])
        }));
      },
      saveHost: async (hostId, draft, secrets) => {
        const next = hostId ? await api.hosts.update(hostId, draft, secrets) : await api.hosts.create(draft, secrets);
        const hosts = sortHosts([...get().hosts.filter((host) => host.id !== next.id), next]);
        set({
          hosts,
          hostDrawer: { mode: 'edit', hostId: next.id }
        });
        await syncOperationalData(set);
      },
      moveHostToGroup: async (hostId, groupPath) => {
        const current = get().hosts.find((host) => host.id === hostId);
        if (!current) {
          return;
        }

        const next = await api.hosts.update(hostId, {
          label: current.label,
          hostname: current.hostname,
          port: current.port,
          username: current.username,
          authType: current.authType,
          privateKeyPath: current.privateKeyPath ?? null,
          secretRef: current.secretRef ?? null,
          groupName: groupPath
        });

        set((state) => ({
          hosts: sortHosts([...state.hosts.filter((host) => host.id !== next.id), next])
        }));
        await syncOperationalData(set);
      },
      removeHost: async (hostId) => {
        await api.hosts.remove(hostId);
        const currentDrawer = get().hostDrawer;
        set({
          hosts: get().hosts.filter((host) => host.id !== hostId),
          hostDrawer: currentDrawer.mode === 'edit' && currentDrawer.hostId === hostId ? { mode: 'closed' } : currentDrawer
        });
        await syncOperationalData(set);
      },
      connectHost: async (hostId, cols, rows) => {
        const trusted = await ensureTrustedHost(set, {
          hostId,
          action: {
            kind: 'ssh',
            hostId,
            cols,
            rows
          }
        });
        if (!trusted) {
          return;
        }
        await runTrustedAction(get, { kind: 'ssh', hostId, cols, rows }, set);
      },
      disconnectTab: async (sessionId) => {
        await api.ssh.disconnect(sessionId);
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.sessionId === sessionId
              ? {
                  ...tab,
                  status: 'disconnecting',
                  lastEventAt: new Date().toISOString()
                }
              : tab
          )
        }));
      },
      closeWorkspace: async (workspaceId) => {
        const workspace = get().workspaces.find((item) => item.id === workspaceId);
        if (!workspace) {
          return;
        }

        const sessionIds = listWorkspaceSessionIds(workspace.layout);
        await Promise.all(sessionIds.map((sessionId) => api.ssh.disconnect(sessionId)));
        set((state) => {
          const workspaceIndex = state.tabStrip.findIndex((item) => item.kind === 'workspace' && item.workspaceId === workspaceId);
          const nextTabStrip = state.tabStrip.filter((item) => !(item.kind === 'workspace' && item.workspaceId === workspaceId));
          const nextActive =
            state.activeWorkspaceTab === asWorkspaceTabId(workspaceId)
              ? resolveNextVisibleTab(nextTabStrip, workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length)
              : state.activeWorkspaceTab;

          return {
            workspaces: state.workspaces.filter((item) => item.id !== workspaceId),
            tabStrip: nextTabStrip,
            tabs: state.tabs.map((tab) =>
              sessionIds.includes(tab.sessionId)
                ? {
                    ...tab,
                    status: 'disconnecting',
                    lastEventAt: new Date().toISOString()
                  }
                : tab
            ),
            activeWorkspaceTab: nextActive
          };
        });
      },
      splitSessionIntoWorkspace: (sessionId, direction, targetSessionId) => {
        const state = get();
        const adjacent = resolveAdjacentTarget(state.tabStrip, state.workspaces, sessionId);
        if (!adjacent) {
          return false;
        }

        if (adjacent.kind === 'session') {
          const currentIndex = state.tabStrip.findIndex((item) => item.kind === 'session' && item.sessionId === sessionId);
          const adjacentIndex = state.tabStrip.findIndex((item) => item.kind === 'session' && item.sessionId === adjacent.sessionId);
          if (currentIndex < 0 || adjacentIndex < 0) {
            return false;
          }

          const workspaceId = globalThis.crypto.randomUUID();
          const workspace: WorkspaceTab = {
            id: workspaceId,
            title: buildWorkspaceTitle(state.workspaces),
            layout: createWorkspaceSplit(adjacent.sessionId, sessionId, direction),
            activeSessionId: sessionId
          };
          const nextTabStrip = state.tabStrip.filter(
            (item) =>
              !(
                item.kind === 'session' &&
                (item.sessionId === sessionId || item.sessionId === adjacent.sessionId)
              )
          );
          const insertIndex = Math.min(currentIndex, adjacentIndex);
          nextTabStrip.splice(insertIndex, 0, { kind: 'workspace', workspaceId });

          set({
            workspaces: [...state.workspaces, workspace],
            tabStrip: nextTabStrip,
            activeWorkspaceTab: asWorkspaceTabId(workspaceId)
          });
          return true;
        }

        const workspace = state.workspaces.find((item) => item.id === adjacent.workspaceId);
        if (!workspace || countWorkspaceSessions(workspace.layout) >= 4) {
          return false;
        }

        const resolvedTargetSessionId =
          targetSessionId && listWorkspaceSessionIds(workspace.layout).includes(targetSessionId)
            ? targetSessionId
            : listWorkspaceSessionIds(workspace.layout).includes(workspace.activeSessionId)
              ? workspace.activeSessionId
              : findFirstWorkspaceSessionId(workspace.layout);
        const nextLayout = insertSessionIntoWorkspaceLayout(workspace.layout, resolvedTargetSessionId, sessionId, direction);
        if (!nextLayout.inserted) {
          return false;
        }

        set({
          workspaces: state.workspaces.map((item) =>
            item.id === workspace.id
              ? {
                  ...item,
                  layout: nextLayout.layout,
                  activeSessionId: sessionId
                }
              : item
          ),
          tabStrip: state.tabStrip.filter((item) => !(item.kind === 'session' && item.sessionId === sessionId)),
          activeWorkspaceTab: asWorkspaceTabId(workspace.id)
        });
        return true;
      },
      detachSessionFromWorkspace: (workspaceId, sessionId) => {
        const state = get();
        const workspace = state.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) {
          return;
        }

        const workspaceIndex = state.tabStrip.findIndex((item) => item.kind === 'workspace' && item.workspaceId === workspaceId);
        const reducedLayout = removeSessionFromWorkspaceLayout(workspace.layout, sessionId);
        if (!reducedLayout) {
          return;
        }

        const insertIndex = workspaceIndex < 0 ? state.tabStrip.length : workspaceIndex + 1;

        if (reducedLayout.kind === 'leaf') {
          const nextTabStrip = state.tabStrip.filter((item) => !(item.kind === 'workspace' && item.workspaceId === workspaceId));
          nextTabStrip.splice(workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length, 0, { kind: 'session', sessionId: reducedLayout.sessionId });
          nextTabStrip.splice(
            workspaceIndex >= 0 ? workspaceIndex + 1 : nextTabStrip.length,
            0,
            { kind: 'session', sessionId }
          );

          set({
            workspaces: state.workspaces.filter((item) => item.id !== workspaceId),
            tabStrip: nextTabStrip,
            activeWorkspaceTab: asSessionTabId(sessionId)
          });
          return;
        }

        const nextTabStrip = [...state.tabStrip];
        nextTabStrip.splice(insertIndex, 0, { kind: 'session', sessionId });
        set({
          workspaces: state.workspaces.map((item) =>
            item.id === workspaceId
              ? {
                  ...item,
                  layout: reducedLayout,
                  activeSessionId:
                    item.activeSessionId === sessionId ? findFirstWorkspaceSessionId(reducedLayout) : item.activeSessionId
                }
              : item
          ),
          tabStrip: nextTabStrip,
          activeWorkspaceTab: asSessionTabId(sessionId)
        });
      },
      focusWorkspaceSession: (workspaceId, sessionId) => {
        set((state) => ({
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === workspaceId
              ? {
                  ...workspace,
                  activeSessionId: sessionId
                }
              : workspace
          ),
          activeWorkspaceTab: asWorkspaceTabId(workspaceId)
        }));
      },
      resizeWorkspaceSplit: (workspaceId, splitId, ratio) => {
        set((state) => ({
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === workspaceId
              ? {
                  ...workspace,
                  layout: updateWorkspaceSplitRatio(workspace.layout, splitId, ratio)
                }
              : workspace
          )
        }));
      },
      updateSettings: async (input) => {
        const settings = await api.settings.update(input);
        set({ settings });
        if (input.globalTerminalThemeId) {
          void api.sync.pushDirty();
        }
      },
      savePortForward: async (ruleId, draft) => {
        const next = ruleId ? await api.portForwards.update(ruleId, draft) : await api.portForwards.create(draft);
        set((state) => ({
          homeSection: 'portForwarding',
          portForwards: sortPortForwards([...state.portForwards.filter((rule) => rule.id !== next.id), next])
        }));
      },
      removePortForward: async (ruleId) => {
        await api.portForwards.remove(ruleId);
        set((state) => ({
          portForwards: state.portForwards.filter((rule) => rule.id !== ruleId),
          portForwardRuntimes: state.portForwardRuntimes.filter((runtime) => runtime.ruleId !== ruleId)
        }));
        await syncOperationalData(set);
      },
      startPortForward: async (ruleId) => {
        const rule = get().portForwards.find((item) => item.id === ruleId);
        if (!rule) {
          return;
        }
        const trusted = await ensureTrustedHost(set, {
          hostId: rule.hostId,
          action: {
            kind: 'portForward',
            ruleId,
            hostId: rule.hostId
          }
        });
        if (!trusted) {
          return;
        }
        await runTrustedAction(get, { kind: 'portForward', ruleId, hostId: rule.hostId }, set);
      },
      stopPortForward: async (ruleId) => {
        await api.portForwards.stop(ruleId);
        set((state) => ({
          portForwardRuntimes: upsertForwardRuntime(state.portForwardRuntimes, {
            ...(state.portForwardRuntimes.find((runtime) => runtime.ruleId === ruleId) ?? {
              ruleId,
              hostId: '',
              mode: 'local',
              bindAddress: '127.0.0.1',
              bindPort: 0
            }),
            status: 'stopped',
            updatedAt: new Date().toISOString(),
            message: undefined
          })
        }));
      },
      removeKnownHost: async (id) => {
        await api.knownHosts.remove(id);
        set((state) => ({
          knownHosts: state.knownHosts.filter((record) => record.id !== id)
        }));
        await syncOperationalData(set);
      },
      clearLogs: async () => {
        await api.logs.clear();
        set({ activityLogs: [] });
      },
      removeKeychainSecret: async (secretRef) => {
        await api.keychain.remove(secretRef);
        await syncOperationalData(set);
      },
      updateKeychainSecret: async (secretRef, secrets) => {
        await api.keychain.update({ secretRef, secrets });
        await syncOperationalData(set);
      },
      cloneKeychainSecretForHost: async (hostId, sourceSecretRef, secrets) => {
        await api.keychain.cloneForHost({
          hostId,
          sourceSecretRef,
          secrets
        });
        await syncOperationalData(set);
      },
      acceptPendingHostKeyPrompt: async (mode) => {
        const pending = get().pendingHostKeyPrompt;
        if (!pending) {
          return;
        }
        if (mode === 'replace') {
          await api.knownHosts.replace(toTrustInput(pending.probe));
        } else {
          await api.knownHosts.trust(toTrustInput(pending.probe));
        }
        set({ pendingHostKeyPrompt: null });
        await syncOperationalData(set);
        await runTrustedAction(get, pending.action, set);
      },
      dismissPendingHostKeyPrompt: () => set({ pendingHostKeyPrompt: null }),
      handleCoreEvent: (event) => {
        const sessionId = event.sessionId;
        void api.logs.list().then((activityLogs) => {
          set({ activityLogs: sortLogs(activityLogs) });
        });
        if (!sessionId) {
          return;
        }
        set((state) => {
          if (event.type === 'closed') {
            const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId);
            const standaloneIndex = state.tabStrip.findIndex((item) => item.kind === 'session' && item.sessionId === sessionId);
            let nextTabStrip = state.tabStrip.filter((item) => !(item.kind === 'session' && item.sessionId === sessionId));
            let nextWorkspaces = state.workspaces;
            let nextActive = state.activeWorkspaceTab;

            const owningWorkspace = state.workspaces.find((workspace) => listWorkspaceSessionIds(workspace.layout).includes(sessionId));
            if (owningWorkspace) {
              const reducedLayout = removeSessionFromWorkspaceLayout(owningWorkspace.layout, sessionId);
              if (!reducedLayout) {
                nextWorkspaces = state.workspaces.filter((workspace) => workspace.id !== owningWorkspace.id);
                const workspaceIndex = state.tabStrip.findIndex((item) => item.kind === 'workspace' && item.workspaceId === owningWorkspace.id);
                nextTabStrip = state.tabStrip.filter((item) => !(item.kind === 'workspace' && item.workspaceId === owningWorkspace.id));
                if (nextActive === asWorkspaceTabId(owningWorkspace.id)) {
                  nextActive = resolveNextVisibleTab(nextTabStrip, workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length);
                }
              } else if (reducedLayout.kind === 'leaf') {
                const workspaceIndex = state.tabStrip.findIndex((item) => item.kind === 'workspace' && item.workspaceId === owningWorkspace.id);
                nextWorkspaces = state.workspaces.filter((workspace) => workspace.id !== owningWorkspace.id);
                nextTabStrip = state.tabStrip.filter((item) => !(item.kind === 'workspace' && item.workspaceId === owningWorkspace.id));
                nextTabStrip.splice(workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length, 0, {
                  kind: 'session',
                  sessionId: reducedLayout.sessionId
                });
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
                          workspace.activeSessionId === sessionId ? findFirstWorkspaceSessionId(reducedLayout) : workspace.activeSessionId
                      }
                    : workspace
                );
              }
            } else if (nextActive === asSessionTabId(sessionId)) {
              nextActive = resolveNextVisibleTab(nextTabStrip, standaloneIndex >= 0 ? standaloneIndex : nextTabStrip.length);
            }

            return {
              tabs,
              workspaces: nextWorkspaces,
              tabStrip: nextTabStrip,
              activeWorkspaceTab: nextActive
            };
          }

          const tabs = state.tabs.map((tab) => {
            if (tab.sessionId !== sessionId) {
              return tab;
            }

            let nextStatus: TabStatus = tab.status;
            if (event.type === 'connected') {
              nextStatus = 'connected';
            }
            let errorMessage = tab.errorMessage;
            if (event.type === 'error') {
              nextStatus = 'error';
              errorMessage = String(event.payload.message ?? 'SSH error');
            }
            return {
              ...tab,
              status: nextStatus,
              errorMessage,
              lastEventAt: new Date().toISOString()
            };
          });

          return { tabs };
        });
      },
      handleTransferEvent: (event) => {
        set((state) => ({
          sftp: {
            ...state.sftp,
            transfers: upsertTransferJob(state.sftp.transfers, event.job)
          }
        }));

        void api.logs.list().then((activityLogs) => {
          set({ activityLogs: sortLogs(activityLogs) });
        });

        if (event.job.status === 'completed' && event.job.request) {
          const request = event.job.request;
          const state = get();
          for (const paneId of ['left', 'right'] as const) {
            const pane = getPane(state, paneId);
            const paneRef =
              pane.sourceKind === 'local'
                ? { kind: 'local' as const, path: pane.currentPath }
                : pane.endpoint
                  ? { kind: 'remote' as const, endpointId: pane.endpoint.id, path: pane.currentPath }
                  : null;
            if (!paneRef) {
              continue;
            }
            if (
              paneRef.kind === request.target.kind &&
              paneRef.path === request.target.path &&
              (paneRef.kind === 'local' || (request.target.kind === 'remote' && paneRef.endpointId === request.target.endpointId))
            ) {
              void get().refreshSftpPane(paneId);
            }
          }
        }
      },
      handlePortForwardEvent: (event) => {
        set((state) => ({
          portForwardRuntimes: upsertForwardRuntime(state.portForwardRuntimes, event.runtime)
        }));
        void api.logs.list().then((activityLogs) => {
          set({ activityLogs: sortLogs(activityLogs) });
        });
      },
      setSftpPaneSource: async (paneId, sourceKind) => {
        const pane = getPane(get(), paneId);
        if (pane.sourceKind === sourceKind) {
          return;
        }
        if (pane.endpoint) {
          await api.sftp.disconnect(pane.endpoint.id);
        }

        const nextBasePane: SftpPaneState = {
          ...pane,
          sourceKind,
          endpoint: null,
          currentPath: sourceKind === 'local' ? pane.lastLocalPath || get().sftp.localHomePath : '',
          history: sourceKind === 'local' ? [pane.lastLocalPath || get().sftp.localHomePath] : [],
          historyIndex: sourceKind === 'local' ? 0 : -1,
          entries: [],
          selectedPaths: [],
          errorMessage: undefined,
          isLoading: false
        };

        set((state) => ({
          sftp: updatePaneState(state, paneId, nextBasePane)
        }));

        if (sourceKind === 'local') {
          await loadPaneListing(set, get, paneId, nextBasePane.currentPath, { pushToHistory: false });
        }
      },
      setSftpPaneFilter: (paneId, query) =>
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            filterQuery: query
          })
        })),
      setSftpHostSearchQuery: (paneId, query) =>
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            hostSearchQuery: query
          })
        })),
      selectSftpHost: (paneId, hostId) =>
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            selectedHostId: hostId
          })
        })),
      connectSftpHost: async (paneId, hostId) => {
        const trusted = await ensureTrustedHost(set, {
          hostId,
          action: {
            kind: 'sftp',
            paneId,
            hostId
          }
        });
        if (!trusted) {
          return;
        }
        await runTrustedAction(get, { kind: 'sftp', paneId, hostId }, set);
      },
      openSftpEntry: async (paneId, entryPath) => {
        const pane = getPane(get(), paneId);
        const entry = pane.entries.find((item) => item.path === entryPath);
        if (!entry || !entry.isDirectory) {
          return;
        }
        await loadPaneListing(set, get, paneId, entry.path, { pushToHistory: true });
      },
      refreshSftpPane: async (paneId) => {
        const pane = getPane(get(), paneId);
        if (pane.sourceKind === 'host' && !pane.endpoint) {
          return;
        }
        await loadPaneListing(set, get, paneId, pane.currentPath, { pushToHistory: false });
      },
      navigateSftpBack: async (paneId) => {
        const pane = getPane(get(), paneId);
        if (pane.historyIndex <= 0) {
          return;
        }
        const nextPath = pane.history[pane.historyIndex - 1];
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            historyIndex: getPane(state, paneId).historyIndex - 1
          })
        }));
        await loadPaneListing(set, get, paneId, nextPath, { pushToHistory: false });
      },
      navigateSftpForward: async (paneId) => {
        const pane = getPane(get(), paneId);
        if (pane.historyIndex >= pane.history.length - 1) {
          return;
        }
        const nextPath = pane.history[pane.historyIndex + 1];
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            historyIndex: getPane(state, paneId).historyIndex + 1
          })
        }));
        await loadPaneListing(set, get, paneId, nextPath, { pushToHistory: false });
      },
      navigateSftpParent: async (paneId) => {
        const pane = getPane(get(), paneId);
        if (!pane.currentPath) {
          return;
        }
        await loadPaneListing(set, get, paneId, parentPath(pane.currentPath), { pushToHistory: true });
      },
      navigateSftpBreadcrumb: async (paneId, nextPath) => {
        await loadPaneListing(set, get, paneId, nextPath, { pushToHistory: true });
      },
      selectSftpEntry: (paneId, entryPath) =>
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            selectedPaths: [entryPath]
          })
        })),
      createSftpDirectory: async (paneId, name) => {
        const pane = getPane(get(), paneId);
        if (!name.trim()) {
          return;
        }
        if (pane.sourceKind === 'local') {
          await api.files.mkdir(pane.currentPath, name.trim());
        } else if (pane.endpoint) {
          await api.sftp.mkdir({
            endpointId: pane.endpoint.id,
            path: pane.currentPath,
            name: name.trim()
          });
        }
        await get().refreshSftpPane(paneId);
      },
      renameSftpSelection: async (paneId, nextName) => {
        const pane = getPane(get(), paneId);
        const targetPath = pane.selectedPaths[0];
        if (!targetPath || !nextName.trim()) {
          return;
        }
        if (pane.sourceKind === 'local') {
          await api.files.rename(targetPath, nextName.trim());
        } else if (pane.endpoint) {
          await api.sftp.rename({
            endpointId: pane.endpoint.id,
            path: targetPath,
            nextName: nextName.trim()
          });
        }
        await get().refreshSftpPane(paneId);
      },
      deleteSftpSelection: async (paneId) => {
        const pane = getPane(get(), paneId);
        if (pane.selectedPaths.length === 0) {
          return;
        }
        if (pane.sourceKind === 'local') {
          await api.files.delete(pane.selectedPaths);
        } else if (pane.endpoint) {
          await api.sftp.delete({
            endpointId: pane.endpoint.id,
            paths: pane.selectedPaths
          });
        }
        await get().refreshSftpPane(paneId);
      },
      prepareSftpTransfer: async (sourcePaneId, targetPaneId, targetPath, draggedPath) => {
        const state = get();
        const sourcePane = getPane(state, sourcePaneId);
        const targetPane = getPane(state, targetPaneId);
        const items = resolveTargetItems(sourcePane, draggedPath);
        if (items.length === 0) {
          return;
        }

        const sourceRef =
          sourcePane.sourceKind === 'local'
            ? { kind: 'local' as const, path: sourcePane.currentPath }
            : sourcePane.endpoint
              ? { kind: 'remote' as const, endpointId: sourcePane.endpoint.id, path: sourcePane.currentPath }
              : null;
        const targetRef =
          targetPane.sourceKind === 'local'
            ? { kind: 'local' as const, path: targetPath }
            : targetPane.endpoint
              ? { kind: 'remote' as const, endpointId: targetPane.endpoint.id, path: targetPath }
              : null;
        if (!sourceRef || !targetRef) {
          return;
        }

        const destinationListing: DirectoryListing =
          targetPane.sourceKind === 'local'
            ? await api.files.list(targetPath)
            : await api.sftp.list({
                endpointId: targetPane.endpoint?.id ?? '',
                path: targetPath
              });

        const conflicts = items
          .filter((item) => destinationListing.entries.some((entry) => entry.name === item.name))
          .map((item) => item.name);
        const input: TransferStartInput = {
          source: sourceRef,
          target: targetRef,
          items: items.map((item) => ({
            name: item.name,
            path: item.path,
            isDirectory: item.isDirectory,
            size: item.size
          })),
          conflictResolution: conflicts.length > 0 ? 'skip' : 'overwrite'
        };

        if (conflicts.length > 0) {
          set((current) => ({
            activeWorkspaceTab: 'sftp',
            sftp: {
              ...current.sftp,
              pendingConflictDialog: {
                input,
                names: conflicts
              }
            }
          }));
          return;
        }

        const job = await api.sftp.startTransfer(input);
        set((current) => ({
          activeWorkspaceTab: 'sftp',
          sftp: {
            ...current.sftp,
            transfers: upsertTransferJob(current.sftp.transfers, job)
          }
        }));
      },
      resolveSftpConflict: async (resolution) => {
        const pending = get().sftp.pendingConflictDialog;
        if (!pending) {
          return;
        }
        const job = await api.sftp.startTransfer({
          ...pending.input,
          conflictResolution: resolution
        });
        set((state) => ({
          activeWorkspaceTab: 'sftp',
          sftp: {
            ...state.sftp,
            pendingConflictDialog: null,
            transfers: upsertTransferJob(state.sftp.transfers, job)
          }
        }));
      },
      dismissSftpConflict: () =>
        set((state) => ({
          sftp: {
            ...state.sftp,
            pendingConflictDialog: null
          }
        })),
      cancelTransfer: async (jobId) => {
        await api.sftp.cancelTransfer(jobId);
      },
      retryTransfer: async (jobId) => {
        const job = get().sftp.transfers.find((item) => item.id === jobId);
        if (!job?.request) {
          return;
        }
        const nextJob = await api.sftp.startTransfer(job.request);
        set((state) => ({
          sftp: {
            ...state.sftp,
            transfers: upsertTransferJob(state.sftp.transfers, nextJob)
          }
        }));
      }
    };
  });

  return store;
}
