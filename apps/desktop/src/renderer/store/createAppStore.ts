import { createStore } from 'zustand/vanilla';
import {
  getParentGroupPath,
  isAwsEc2HostRecord,
  isGroupWithinPath,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  normalizeGroupPath,
  stripRemovedGroupSegment
} from '@shared';
import type {
  ActivityLogRecord,
  AppSettings,
  CoreEvent,
  DesktopApi,
  DirectoryListing,
  FileEntry,
  GroupRecord,
  GroupRemoveMode,
  HostDraft,
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
  SessionShareEvent,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  SessionShareState,
  SftpEndpointSummary,
  SftpPaneId,
  SecretMetadataRecord,
  TerminalConnectionProgress,
  TerminalFontFamilyId,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput
} from '@shared';

export type SessionWorkspaceTabId = `session:${string}`;
export type SplitWorkspaceTabId = `workspace:${string}`;
export type WorkspaceTabId = 'home' | 'sftp' | SessionWorkspaceTabId | SplitWorkspaceTabId;
export type HomeSection = 'hosts' | 'portForwarding' | 'logs' | 'settings';
export type SettingsSection = 'general' | 'security' | 'secrets';
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
        kind: 'ssh';
        hostId: string;
        cols: number;
        rows: number;
        secrets?: HostSecretInput;
      }
    | {
        kind: 'sftp';
        paneId: SftpPaneId;
        hostId: string;
        secrets?: HostSecretInput;
      }
    | {
        kind: 'portForward';
        ruleId: string;
        hostId: string;
      };
}

export interface PendingCredentialRetry {
  sessionId?: string | null;
  hostId: string;
  source: 'ssh' | 'sftp';
  credentialKind: 'password' | 'passphrase';
  message: string;
  paneId?: SftpPaneId;
}

export interface PendingInteractiveAuth {
  sessionId: string;
  challengeId: string;
  name?: string | null;
  instruction: string;
  prompts: KeyboardInteractivePrompt[];
  provider: 'generic' | 'warpgate';
  approvalUrl?: string | null;
  authCode?: string | null;
  autoSubmitted: boolean;
}

interface PendingConnectionAttempt {
  sessionId: string;
  source: 'host' | 'local';
  hostId: string | null;
  title: string;
  latestCols: number;
  latestRows: number;
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
  pendingInteractiveAuth: PendingInteractiveAuth | null;
  pendingConnectionAttempts: PendingConnectionAttempt[];
  setSearchQuery: (value: string) => void;
  toggleHostTag: (tag: string) => void;
  clearHostTagFilter: () => void;
  activateHome: () => void;
  activateSftp: () => void;
  activateSession: (sessionId: string) => void;
  activateWorkspace: (workspaceId: string) => void;
  openHomeSection: (section: HomeSection) => void;
  openSettingsSection: (section: SettingsSection) => void;
  openCreateHostDrawer: () => void;
  openEditHostDrawer: (hostId: string) => void;
  closeHostDrawer: () => void;
  navigateGroup: (path: string | null) => void;
  bootstrap: () => Promise<void>;
  refreshHostCatalog: () => Promise<void>;
  refreshOperationalData: () => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  removeGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  saveHost: (hostId: string | null, draft: HostDraft, secrets?: HostSecretInput) => Promise<void>;
  moveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  removeHost: (hostId: string) => Promise<void>;
  openLocalTerminal: (cols: number, rows: number) => Promise<void>;
  connectHost: (hostId: string, cols: number, rows: number, secrets?: HostSecretInput) => Promise<void>;
  retrySessionConnection: (sessionId: string, secrets?: HostSecretInput) => Promise<void>;
  startSessionShare: (input: SessionShareStartInput) => Promise<void>;
  updateSessionShareSnapshot: (input: SessionShareSnapshotInput) => Promise<void>;
  setSessionShareInputEnabled: (sessionId: string, inputEnabled: boolean) => Promise<void>;
  stopSessionShare: (sessionId: string) => Promise<void>;
  disconnectTab: (sessionId: string) => Promise<void>;
  closeWorkspace: (workspaceId: string) => Promise<void>;
  splitSessionIntoWorkspace: (sessionId: string, direction: WorkspaceDropDirection, targetSessionId?: string) => boolean;
  detachSessionFromWorkspace: (workspaceId: string, sessionId: string) => void;
  reorderDynamicTab: (source: DynamicTabStripItem, target: DynamicTabStripItem, placement: 'before' | 'after') => void;
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
  dismissPendingCredentialRetry: () => void;
  submitCredentialRetry: (secrets: HostSecretInput) => Promise<void>;
  respondInteractiveAuth: (challengeId: string, responses: string[]) => Promise<void>;
  reopenInteractiveAuthUrl: () => Promise<void>;
  clearPendingInteractiveAuth: () => void;
  updatePendingConnectionSize: (sessionId: string, cols: number, rows: number) => void;
  markSessionOutput: (sessionId: string) => void;
  handleCoreEvent: (event: CoreEvent<Record<string, unknown>>) => void;
  handleSessionShareEvent: (event: SessionShareEvent) => void;
  handleTransferEvent: (event: TransferJobEvent) => void;
  handlePortForwardEvent: (event: PortForwardRuntimeEvent) => void;
  setSftpPaneSource: (paneId: SftpPaneId, sourceKind: SftpSourceKind) => Promise<void>;
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
  navigateSftpBreadcrumb: (paneId: SftpPaneId, nextPath: string) => Promise<void>;
  selectSftpEntry: (paneId: SftpPaneId, input: SftpEntrySelectionInput) => void;
  createSftpDirectory: (paneId: SftpPaneId, name: string) => Promise<void>;
  renameSftpSelection: (paneId: SftpPaneId, nextName: string) => Promise<void>;
  changeSftpSelectionPermissions: (paneId: SftpPaneId, mode: number) => Promise<void>;
  deleteSftpSelection: (paneId: SftpPaneId) => Promise<void>;
  downloadSftpSelection: (paneId: SftpPaneId) => Promise<void>;
  prepareSftpTransfer: (
    sourcePaneId: SftpPaneId,
    targetPaneId: SftpPaneId,
    targetPath: string,
    draggedPath?: string | null
  ) => Promise<void>;
  prepareSftpExternalTransfer: (targetPaneId: SftpPaneId, targetPath: string, droppedPaths: string[]) => Promise<void>;
  transferSftpSelectionToPane: (sourcePaneId: SftpPaneId, targetPaneId: SftpPaneId) => Promise<void>;
  resolveSftpConflict: (resolution: 'overwrite' | 'skip' | 'keepBoth') => Promise<void>;
  dismissSftpConflict: () => void;
  cancelTransfer: (jobId: string) => Promise<void>;
  retryTransfer: (jobId: string) => Promise<void>;
  dismissTransfer: (jobId: string) => void;
}

function normalizeHomeSectionInput(section: HomeSection | 'knownHosts' | 'keychain'): {
  homeSection: HomeSection;
  settingsSection?: SettingsSection;
} {
  if (section === 'knownHosts') {
    return {
      homeSection: 'settings',
      settingsSection: 'security'
    };
  }

  if (section === 'keychain') {
    return {
      homeSection: 'settings',
      settingsSection: 'secrets'
    };
  }

  return {
    homeSection: section
  };
}

type TabStatus = TerminalTab['status'];

function detectRendererPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
  if (typeof navigator === 'undefined') {
    return 'unknown';
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const userAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = (userAgentData.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();

  if (platform.includes('mac') || userAgent.includes('mac os')) {
    return 'darwin';
  }
  if (platform.includes('win') || userAgent.includes('windows')) {
    return 'win32';
  }
  if (platform.includes('linux') || userAgent.includes('linux')) {
    return 'linux';
  }
  return 'unknown';
}

function resolveRendererDefaultTerminalFontFamily(): TerminalFontFamilyId {
  const platform = detectRendererPlatform();
  if (platform === 'win32') {
    return 'consolas';
  }
  if (platform === 'linux') {
    return 'jetbrains-mono';
  }
  return 'sf-mono';
}

const defaultSettings: AppSettings = {
  theme: 'system',
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: resolveRendererDefaultTerminalFontFamily(),
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  serverUrl: 'https://ssh.doldolma.com',
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: new Date(0).toISOString()
};

function createEmptyPane(id: SftpPaneId): SftpPaneState {
  return {
    id,
    sourceKind: id === 'left' ? 'local' : 'host',
    endpoint: null,
    hostGroupPath: null,
    currentPath: '',
    lastLocalPath: '',
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: '',
    selectedHostId: null,
    hostSearchQuery: '',
    isLoading: false,
    warningMessages: []
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

function normalizeTagValue(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

function matchesSelectedTags(host: HostRecord, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) {
    return true;
  }
  const hostTags = host.tags ?? [];
  if (hostTags.length === 0) {
    return false;
  }
  const normalizedHostTags = new Set(hostTags.map(normalizeTagValue));
  return selectedTags.some((tag) => normalizedHostTags.has(normalizeTagValue(tag)));
}

function hasProvidedSecrets(secrets?: HostSecretInput): boolean {
  return Boolean(secrets?.password || secrets?.passphrase || secrets?.privateKeyPem);
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

function buildSessionTitle(
  label: string,
  scope: { source: 'host'; hostId: string } | { source: 'local' },
  tabs: TerminalTab[]
): string {
  const existingTitles = new Set(
    tabs
      .filter((tab) =>
        scope.source === 'local' ? tab.source === 'local' : tab.source === 'host' && tab.hostId === scope.hostId
      )
      .map((tab) => tab.title)
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

const PENDING_SESSION_PREFIX = 'pending:';

function createPendingSessionId(): string {
  return `${PENDING_SESSION_PREFIX}${globalThis.crypto.randomUUID()}`;
}

function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_SESSION_PREFIX);
}

function createConnectionProgress(
  stage: TerminalConnectionProgress['stage'],
  message: string,
  options: Partial<Pick<TerminalConnectionProgress, 'blockingKind' | 'retryable'>> = {}
): TerminalConnectionProgress {
  return {
    stage,
    message,
    blockingKind: options.blockingKind ?? 'none',
    retryable: options.retryable ?? false
  };
}

function createInactiveSessionShareState(): SessionShareState {
  return {
    status: 'inactive',
    shareUrl: null,
    inputEnabled: false,
    viewerCount: 0,
    errorMessage: null
  };
}

function normalizeSessionShareState(state?: SessionShareState | null): SessionShareState {
  return state ?? createInactiveSessionShareState();
}

function setSessionShareState(
  tabs: TerminalTab[],
  sessionId: string,
  nextState: SessionShareState
): TerminalTab[] {
  return tabs.map((tab) =>
    tab.sessionId === sessionId
      ? {
          ...tab,
          sessionShare: nextState
        }
      : tab
  );
}

function createPendingSessionTab(input: {
  sessionId: string;
  source: 'host' | 'local';
  hostId: string | null;
  title: string;
  progress: TerminalConnectionProgress;
}): TerminalTab {
  return {
    id: input.sessionId,
    sessionId: input.sessionId,
    source: input.source,
    hostId: input.hostId,
    title: input.title,
    status: 'pending',
    connectionProgress: input.progress,
    sessionShare: createInactiveSessionShareState(),
    hasReceivedOutput: false,
    lastEventAt: new Date().toISOString()
  };
}

function findPendingConnectionAttempt(state: AppState, sessionId: string): PendingConnectionAttempt | null {
  return state.pendingConnectionAttempts.find((attempt) => attempt.sessionId === sessionId) ?? null;
}

function findPendingConnectionAttemptByHost(state: AppState, hostId: string): PendingConnectionAttempt | null {
  return state.pendingConnectionAttempts.find((attempt) => attempt.source === 'host' && attempt.hostId === hostId) ?? null;
}

function replaceSessionIdInLayout(node: WorkspaceLayoutNode, previousSessionId: string, nextSessionId: string): WorkspaceLayoutNode {
  if (node.kind === 'leaf') {
    return node.sessionId === previousSessionId
      ? {
          ...node,
          sessionId: nextSessionId
        }
      : node;
  }

  return {
    ...node,
    first: replaceSessionIdInLayout(node.first, previousSessionId, nextSessionId),
    second: replaceSessionIdInLayout(node.second, previousSessionId, nextSessionId)
  };
}

function replaceSessionReferencesInState(
  state: AppState,
  previousSessionId: string,
  nextSessionId: string,
  transformTab?: (tab: TerminalTab) => TerminalTab
): Partial<AppState> {
  return {
    tabs: state.tabs.map((tab) => {
      if (tab.sessionId !== previousSessionId) {
        return tab;
      }
      const nextTab: TerminalTab = {
        ...tab,
        id: nextSessionId,
        sessionId: nextSessionId
      };
      return transformTab ? transformTab(nextTab) : nextTab;
    }),
    tabStrip: state.tabStrip.map((item) =>
      item.kind === 'session' && item.sessionId === previousSessionId ? { kind: 'session', sessionId: nextSessionId } : item
    ),
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      layout: replaceSessionIdInLayout(workspace.layout, previousSessionId, nextSessionId),
      activeSessionId: workspace.activeSessionId === previousSessionId ? nextSessionId : workspace.activeSessionId
    })),
    activeWorkspaceTab:
      state.activeWorkspaceTab === asSessionTabId(previousSessionId) ? asSessionTabId(nextSessionId) : state.activeWorkspaceTab,
    pendingHostKeyPrompt:
      state.pendingHostKeyPrompt?.sessionId === previousSessionId
        ? {
            ...state.pendingHostKeyPrompt,
            sessionId: nextSessionId
          }
        : state.pendingHostKeyPrompt,
    pendingCredentialRetry:
      state.pendingCredentialRetry?.sessionId === previousSessionId
        ? {
            ...state.pendingCredentialRetry,
            sessionId: nextSessionId
          }
        : state.pendingCredentialRetry,
    pendingInteractiveAuth:
      state.pendingInteractiveAuth?.sessionId === previousSessionId
        ? {
            ...state.pendingInteractiveAuth,
            sessionId: nextSessionId
          }
        : state.pendingInteractiveAuth
  };
}

function removeSessionFromState(state: AppState, sessionId: string): Partial<AppState> {
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
    activeWorkspaceTab: nextActive,
    pendingHostKeyPrompt: state.pendingHostKeyPrompt?.sessionId === sessionId ? null : state.pendingHostKeyPrompt,
    pendingCredentialRetry: state.pendingCredentialRetry?.sessionId === sessionId ? null : state.pendingCredentialRetry,
    pendingInteractiveAuth: state.pendingInteractiveAuth?.sessionId === sessionId ? null : state.pendingInteractiveAuth,
    pendingConnectionAttempts: state.pendingConnectionAttempts.filter((attempt) => attempt.sessionId !== sessionId)
  };
}

function activateSessionContextInState(state: AppState, sessionId: string): Partial<AppState> {
  const owningWorkspace = state.workspaces.find((workspace) => listWorkspaceSessionIds(workspace.layout).includes(sessionId));
  if (!owningWorkspace) {
    return {
      activeWorkspaceTab: asSessionTabId(sessionId)
    };
  }

  return {
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === owningWorkspace.id
        ? {
            ...workspace,
            activeSessionId: sessionId
          }
        : workspace
    ),
    activeWorkspaceTab: asWorkspaceTabId(owningWorkspace.id)
  };
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

function resolveCurrentGroupPathAfterGroupRemoval(
  currentGroupPath: string | null,
  removedGroupPath: string,
  mode: GroupRemoveMode
): string | null {
  const normalizedCurrentPath = normalizeGroupPath(currentGroupPath);
  const normalizedRemovedPath = normalizeGroupPath(removedGroupPath);
  if (!normalizedCurrentPath || !normalizedRemovedPath || !isGroupWithinPath(normalizedCurrentPath, normalizedRemovedPath)) {
    return normalizedCurrentPath;
  }

  if (mode === 'delete-subtree') {
    return getParentGroupPath(normalizedRemovedPath);
  }

  return stripRemovedGroupSegment(normalizedCurrentPath, normalizedRemovedPath);
}

function resolveCredentialRetryKind(host: HostRecord | undefined, message: string): 'password' | 'passphrase' | null {
  if (!host || !isSshHostRecord(host)) {
    return null;
  }

  if (host.authType === 'password') {
    return /requires a password|password required|permission denied|unable to authenticate|authentication failed|ssh handshake failed/i.test(message)
      ? 'password'
      : null;
  }

  return /passphrase|private key|unable to authenticate|authentication failed|ssh handshake failed|parse private key/i.test(message)
    ? 'passphrase'
    : null;
}

function resolveHostKeyCheckProgress(host: HostRecord): TerminalConnectionProgress {
  return createConnectionProgress('host-key-check', `${host.label} 호스트 키를 확인하는 중입니다.`);
}

function resolveAwaitingHostTrustProgress(host: HostRecord): TerminalConnectionProgress {
  return createConnectionProgress('awaiting-host-trust', `${host.label} 호스트 키 확인이 필요합니다.`, {
    blockingKind: 'dialog'
  });
}

function resolveConnectingProgress(host: HostRecord): TerminalConnectionProgress {
  if (isAwsEc2HostRecord(host)) {
    return createConnectionProgress('connecting', `${host.label} SSM 세션을 시작하는 중입니다.`);
  }
  if (isWarpgateSshHostRecord(host)) {
    return createConnectionProgress('connecting', `${host.label} Warpgate SSH 세션을 연결하는 중입니다.`);
  }
  return createConnectionProgress('connecting', `${host.label} SSH 세션을 연결하는 중입니다.`);
}

function resolveLocalStartingProgress(): TerminalConnectionProgress {
  return createConnectionProgress('connecting', '로컬 터미널을 시작하는 중입니다.');
}

function resolveWaitingShellProgress(host: HostRecord): TerminalConnectionProgress {
  return createConnectionProgress('waiting-shell', `${host.label} 원격 셸이 첫 출력을 보내는 중입니다.`);
}

function resolveLocalWaitingShellProgress(): TerminalConnectionProgress {
  return createConnectionProgress('waiting-shell', '셸이 준비되는 중입니다.');
}

function resolveCredentialRetryProgress(
  host: HostRecord,
  credentialKind: PendingCredentialRetry['credentialKind']
): TerminalConnectionProgress {
  return createConnectionProgress(
    'awaiting-credentials',
    credentialKind === 'password'
      ? `${host.label} 비밀번호를 다시 입력해 주세요.`
      : `${host.label} passphrase를 다시 입력해 주세요.`,
    {
      blockingKind: 'dialog',
      retryable: true
    }
  );
}

function resolveErrorProgress(message: string, retryable = true): TerminalConnectionProgress {
  return createConnectionProgress('connecting', message, {
    retryable
  });
}

function normalizeInteractiveText(value: string | undefined | null): string {
  return (value ?? '').trim();
}

function parseWarpgateApprovalUrl(...parts: Array<string | undefined | null>): string | null {
  const combined = parts.map(normalizeInteractiveText).filter(Boolean).join('\n');
  const match = combined.match(/https?:\/\/[^\s<>"')]+/i);
  return match ? match[0] : null;
}

function parseWarpgateAuthCode(...parts: Array<string | undefined | null>): string | null {
  const combined = parts.map(normalizeInteractiveText).filter(Boolean).join('\n');
  const labeledMatch = combined.match(
    /(?:auth(?:entication)?|verification|security|device)?\s*code\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{3,})/i
  );
  if (labeledMatch) {
    return labeledMatch[1];
  }
  const tokenMatch = combined.match(/([A-Z0-9]{4,}(?:-[A-Z0-9]{2,})+)/i);
  return tokenMatch ? tokenMatch[1] : null;
}

function isWarpgateCompletionPrompt(label: string, instruction: string): boolean {
  return /press enter when done|press enter to continue|once authorized|after authoriz|after logging in|after completing authentication|hit enter|return to continue/i.test(
    `${label}\n${instruction}`
  );
}

function isWarpgateCodePrompt(label: string, instruction: string): boolean {
  return /code|verification|security|token|device/i.test(label) || (/code/i.test(instruction) && !/press enter/i.test(label));
}

function shouldTreatAsWarpgate(host: HostRecord | undefined, challenge: KeyboardInteractiveChallenge): boolean {
  if (!host || !isWarpgateSshHostRecord(host)) {
    return false;
  }
  const sourceText = `${challenge.name ?? ''}\n${challenge.instruction}\n${challenge.prompts.map((prompt) => prompt.label).join('\n')}`;
  return /warpgate|authorize|device authorization|device code|verification code/i.test(sourceText);
}

export function upsertTransferJob(transfers: TransferJob[], job: TransferJob): TransferJob[] {
  const existingIndex = transfers.findIndex((item) => item.id === job.id);
  if (existingIndex >= 0) {
    return transfers.map((item, index) => (index === existingIndex ? job : item));
  }
  return [job, ...transfers].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

function upsertForwardRuntime(runtimes: PortForwardRuntimeRecord[], runtime: PortForwardRuntimeRecord): PortForwardRuntimeRecord[] {
  const next = [runtime, ...runtimes.filter((item) => item.ruleId !== runtime.ruleId)];
  return next.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

function basenameFromPath(targetPath: string): string {
  const normalized = targetPath.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

function resolveSftpVisibleEntryPaths(pane: SftpPaneState, provided?: string[]): string[] {
  if (provided && provided.length > 0) {
    const available = new Set(pane.entries.map((entry) => entry.path));
    return provided.filter((entryPath) => available.has(entryPath));
  }
  return pane.entries
    .filter((entry) => {
      if (!pane.filterQuery.trim()) {
        return true;
      }
      return entry.name.toLowerCase().includes(pane.filterQuery.trim().toLowerCase());
    })
    .map((entry) => entry.path);
}

function resolveNextSftpSelection(
  pane: SftpPaneState,
  input: SftpEntrySelectionInput,
): Pick<SftpPaneState, "selectedPaths" | "selectionAnchorPath"> {
  if (!input.entryPath) {
    return {
      selectedPaths: [],
      selectionAnchorPath: null,
    };
  }

  const entryExists = pane.entries.some((entry) => entry.path === input.entryPath);
  if (!entryExists) {
    return {
      selectedPaths: pane.selectedPaths,
      selectionAnchorPath: pane.selectionAnchorPath,
    };
  }

  if (input.range) {
    const visiblePaths = resolveSftpVisibleEntryPaths(pane, input.visibleEntryPaths);
    const anchorPath =
      pane.selectionAnchorPath && visiblePaths.includes(pane.selectionAnchorPath)
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

function resolveTransferItemsFromPane(
  pane: SftpPaneState,
  draggedPath?: string | null,
): FileEntry[] {
  if (!draggedPath) {
    return pane.entries.filter((entry) => pane.selectedPaths.includes(entry.path));
  }
  const selected = pane.entries.filter((entry) => pane.selectedPaths.includes(entry.path));
  if (selected.some((entry) => entry.path === draggedPath)) {
    return selected;
  }
  return pane.entries.filter((entry) => entry.path === draggedPath);
}

function isBrowsableSftpPane(pane: SftpPaneState): boolean {
  return pane.sourceKind === "local" || Boolean(pane.endpoint);
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
  const openedInteractiveBrowserChallenges = new Set<string>();

  const ensureAwsHostAuthentication = async (
    host: Extract<HostRecord, { kind: 'aws-ec2' }>,
    onStageChange: (progress: TerminalConnectionProgress) => void
  ) => {
    onStageChange(createConnectionProgress('checking-profile', `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`));
    const status = await api.aws.getProfileStatus(host.awsProfileName);
    if (status.isAuthenticated) {
      return;
    }

    if (!status.isSsoProfile) {
      throw new Error(status.errorMessage || `${host.awsProfileName} 프로필에 AWS CLI 자격 증명이 필요합니다.`);
    }

    onStageChange(
      createConnectionProgress('browser-login', `브라우저에서 ${host.awsProfileName} AWS 로그인을 진행하는 중입니다.`, {
        blockingKind: 'browser'
      })
    );
    try {
      await api.aws.login(host.awsProfileName);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'AWS SSO 로그인을 시작하지 못했습니다.');
    }

    onStageChange(createConnectionProgress('checking-profile', `${host.awsProfileName} 프로필 로그인 결과를 확인하는 중입니다.`));
    const refreshedStatus = await api.aws.getProfileStatus(host.awsProfileName);
    if (!refreshedStatus.isAuthenticated) {
      throw new Error(refreshedStatus.errorMessage || 'AWS SSO 로그인 후에도 인증이 확인되지 않았습니다.');
    }
  };

  const updateSessionProgress = (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    sessionId: string,
    progress: TerminalConnectionProgress,
    status: TerminalTab['status'] = 'pending'
  ) => {
    set((state) => {
      if (!state.tabs.some((tab) => tab.sessionId === sessionId)) {
        return state;
      }
      return {
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                status,
                errorMessage: undefined,
                connectionProgress: progress,
                lastEventAt: new Date().toISOString()
              }
            : tab
        )
      };
    });
  };

  const markSessionError = (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    sessionId: string,
    message: string,
    options: {
      progress?: TerminalConnectionProgress | null;
      retryable?: boolean;
    } = {}
  ) => {
    set((state) => {
      if (!state.tabs.some((tab) => tab.sessionId === sessionId)) {
        return {
          pendingConnectionAttempts: state.pendingConnectionAttempts.filter((attempt) => attempt.sessionId !== sessionId)
        };
      }
      return {
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                status: 'error',
                errorMessage: message,
                connectionProgress: options.progress ?? resolveErrorProgress(message, options.retryable ?? true),
                lastEventAt: new Date().toISOString()
              }
            : tab
        ),
        pendingConnectionAttempts: state.pendingConnectionAttempts.filter((attempt) => attempt.sessionId !== sessionId)
      };
    });
  };

  const createPendingSessionTabForHost = (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    get: () => AppState,
    host: HostRecord,
    cols: number,
    rows: number,
    progress: TerminalConnectionProgress,
    existingSessionId?: string
  ): string => {
    const sessionId = existingSessionId ?? createPendingSessionId();
    const existingTab = existingSessionId ? get().tabs.find((tab) => tab.sessionId === existingSessionId) ?? null : null;
    const title = existingTab?.title ?? buildSessionTitle(host.label, { source: 'host', hostId: host.id }, get().tabs);
    const tab = createPendingSessionTab({
      sessionId,
      source: 'host',
      hostId: host.id,
      title,
      progress
    });

    set((state) => {
      const nextAttempts = [
        ...state.pendingConnectionAttempts.filter((attempt) => attempt.sessionId !== sessionId),
        {
          sessionId,
          source: 'host' as const,
          hostId: host.id,
          title,
          latestCols: cols,
          latestRows: rows
        }
      ];

      if (existingTab) {
        return {
          tabs: state.tabs.map((item) => (item.sessionId === sessionId ? tab : item)),
          pendingConnectionAttempts: nextAttempts,
          ...activateSessionContextInState(state, sessionId)
        };
      }

      return {
        tabs: [...state.tabs.filter((item) => item.sessionId !== sessionId), tab],
        tabStrip: [...state.tabStrip.filter((item) => !(item.kind === 'session' && item.sessionId === sessionId)), { kind: 'session', sessionId }],
        activeWorkspaceTab: asSessionTabId(sessionId),
        homeSection: 'hosts',
        hostDrawer: { mode: 'closed' },
        pendingConnectionAttempts: nextAttempts
      };
    });

    return sessionId;
  };

  const createPendingSessionTabForLocal = (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    get: () => AppState,
    cols: number,
    rows: number,
    progress: TerminalConnectionProgress,
    existingSessionId?: string
  ): string => {
    const sessionId = existingSessionId ?? createPendingSessionId();
    const existingTab = existingSessionId ? get().tabs.find((tab) => tab.sessionId === existingSessionId) ?? null : null;
    const title = existingTab?.title ?? buildSessionTitle('Terminal', { source: 'local' }, get().tabs);
    const tab = createPendingSessionTab({
      sessionId,
      source: 'local',
      hostId: null,
      title,
      progress
    });

    set((state) => {
      const nextAttempts = [
        ...state.pendingConnectionAttempts.filter((attempt) => attempt.sessionId !== sessionId),
        {
          sessionId,
          source: 'local' as const,
          hostId: null,
          title,
          latestCols: cols,
          latestRows: rows
        }
      ];

      if (existingTab) {
        return {
          tabs: state.tabs.map((item) => (item.sessionId === sessionId ? tab : item)),
          pendingConnectionAttempts: nextAttempts,
          ...activateSessionContextInState(state, sessionId)
        };
      }

      return {
        tabs: [...state.tabs.filter((item) => item.sessionId !== sessionId), tab],
        tabStrip: [...state.tabStrip.filter((item) => !(item.kind === 'session' && item.sessionId === sessionId)), { kind: 'session', sessionId }],
        activeWorkspaceTab: asSessionTabId(sessionId),
        homeSection: 'hosts',
        hostDrawer: { mode: 'closed' },
        pendingConnectionAttempts: nextAttempts
      };
    });

    return sessionId;
  };

  const startPendingSessionConnect = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    get: () => AppState,
    sessionId: string,
    hostId: string,
    secrets?: HostSecretInput
  ) => {
    const state = get();
    const attempt = findPendingConnectionAttempt(state, sessionId);
    const host = state.hosts.find((item) => item.id === hostId);
    if (!attempt || !host) {
      return;
    }

    const currentProgressStage = state.tabs.find((tab) => tab.sessionId === sessionId)?.connectionProgress?.stage;
    if (currentProgressStage !== 'retrying-session') {
      updateSessionProgress(set, sessionId, resolveConnectingProgress(host));
    }

    try {
      const connection = await api.ssh.connect({
        hostId,
        title: attempt.title,
        cols: attempt.latestCols,
        rows: attempt.latestRows,
        secrets
      });
      const latestAttempt = findPendingConnectionAttempt(get(), sessionId);
      if (!latestAttempt) {
        await api.ssh.disconnect(connection.sessionId).catch(() => undefined);
        return;
      }

      set((currentState) => ({
        ...replaceSessionReferencesInState(currentState, sessionId, connection.sessionId, (tab) => ({
          ...tab,
          status: 'connecting',
          errorMessage: undefined,
          connectionProgress: resolveConnectingProgress(host),
          hasReceivedOutput: false,
          lastEventAt: new Date().toISOString()
        })),
        pendingConnectionAttempts: currentState.pendingConnectionAttempts.filter((attemptItem) => attemptItem.sessionId !== sessionId)
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '호스트 연결을 시작하지 못했습니다.';
      markSessionError(set, sessionId, message);
    }
  };

  const startPendingLocalSessionConnect = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    get: () => AppState,
    sessionId: string
  ) => {
    const state = get();
    const attempt = findPendingConnectionAttempt(state, sessionId);
    if (!attempt || attempt.source !== 'local') {
      return;
    }

    const currentProgressStage = state.tabs.find((tab) => tab.sessionId === sessionId)?.connectionProgress?.stage;
    if (currentProgressStage !== 'retrying-session') {
      updateSessionProgress(set, sessionId, resolveLocalStartingProgress());
    }

    try {
      const connection = await api.ssh.connectLocal({
        title: attempt.title,
        cols: attempt.latestCols,
        rows: attempt.latestRows
      });
      const latestAttempt = findPendingConnectionAttempt(get(), sessionId);
      if (!latestAttempt) {
        await api.ssh.disconnect(connection.sessionId).catch(() => undefined);
        return;
      }

      set((currentState) => ({
        ...replaceSessionReferencesInState(currentState, sessionId, connection.sessionId, (tab) => ({
          ...tab,
          source: 'local',
          hostId: null,
          status: 'connecting',
          errorMessage: undefined,
          connectionProgress: resolveLocalStartingProgress(),
          hasReceivedOutput: false,
          lastEventAt: new Date().toISOString()
        })),
        pendingConnectionAttempts: currentState.pendingConnectionAttempts.filter((attemptItem) => attemptItem.sessionId !== sessionId)
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '로컬 터미널을 시작하지 못했습니다.';
      markSessionError(set, sessionId, message);
    }
  };

  const startSessionConnectionFlow = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    get: () => AppState,
    hostId: string,
    cols: number,
    rows: number,
    secrets?: HostSecretInput,
    reuseSessionId?: string
  ) => {
    const host = get().hosts.find((item) => item.id === hostId);
    if (!host) {
      return;
    }

    const initialProgress = isAwsEc2HostRecord(host)
      ? createConnectionProgress('checking-profile', `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`)
      : resolveHostKeyCheckProgress(host);
    const sessionId = createPendingSessionTabForHost(set, get, host, cols, rows, initialProgress, reuseSessionId);

    try {
      if (isAwsEc2HostRecord(host)) {
        await ensureAwsHostAuthentication(host, (progress) => {
          updateSessionProgress(set, sessionId, progress);
        });
        updateSessionProgress(
          set,
          sessionId,
          createConnectionProgress('retrying-session', `${host.label} SSM 연결을 다시 시도하는 중입니다.`)
        );
        await startPendingSessionConnect(set, get, sessionId, host.id, secrets);
        return;
      }

      const trusted = await ensureTrustedHost(set, {
        hostId,
        sessionId,
        action: {
          kind: 'ssh',
          hostId,
          cols,
          rows,
          secrets
        }
      });
      if (!trusted) {
        updateSessionProgress(set, sessionId, resolveAwaitingHostTrustProgress(host));
        return;
      }

      await startPendingSessionConnect(set, get, sessionId, host.id, secrets);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : '호스트 연결을 시작하지 못했습니다. AWS SSM 연결에는 session-manager-plugin이 필요할 수 있습니다.';
      markSessionError(set, sessionId, message);
    }
  };

  const startLocalTerminalFlow = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    get: () => AppState,
    cols: number,
    rows: number,
    reuseSessionId?: string
  ) => {
    const sessionId = createPendingSessionTabForLocal(set, get, cols, rows, resolveLocalStartingProgress(), reuseSessionId);

    try {
      await startPendingLocalSessionConnect(set, get, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '로컬 터미널을 시작하지 못했습니다.';
      markSessionError(set, sessionId, message);
    }
  };

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

  const refreshHostAndKeychainState = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void
  ) => {
    const [hosts, keychainEntries] = await Promise.all([api.hosts.list(), api.keychain.list()]);
    set({
      hosts: sortHosts(hosts),
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
        errorMessage: undefined,
        warningMessages: []
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
        const preserveSelection = !options.pushToHistory && latestPane.currentPath === listing.path;
        const availablePaths = new Set(listing.entries.map((entry) => entry.path));
        const selectedPaths = preserveSelection
          ? latestPane.selectedPaths.filter((entryPath) => availablePaths.has(entryPath))
          : [];
        const nextFilterQuery = latestPane.currentPath === listing.path ? latestPane.filterQuery : '';
        const selectionAnchorPath =
          preserveSelection &&
          latestPane.selectionAnchorPath &&
          availablePaths.has(latestPane.selectionAnchorPath)
            ? latestPane.selectionAnchorPath
            : null;
        const nextPane: SftpPaneState = {
          ...latestPane,
          currentPath: listing.path,
          lastLocalPath: latestPane.sourceKind === 'local' ? listing.path : latestPane.lastLocalPath,
          entries: listing.entries,
          selectedPaths,
          selectionAnchorPath,
          filterQuery: nextFilterQuery,
          isLoading: false,
          errorMessage: undefined,
          warningMessages: listing.warnings ?? [],
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
          errorMessage: error instanceof Error ? error.message : 'SFTP 목록을 읽지 못했습니다.',
          warningMessages: []
        })
      }));
    }
  };

  const setSftpPaneWarnings = (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    paneId: SftpPaneId,
    warnings: string[],
  ) => {
    set((state) => ({
      sftp: updatePaneState(state, paneId, {
        ...getPane(state, paneId),
        warningMessages: warnings,
      }),
    }));
  };

  const buildSftpTransferEndpoint = (
    pane: SftpPaneState,
    targetPath: string,
  ) => {
    if (pane.sourceKind === "local") {
      return {
        kind: "local" as const,
        path: targetPath,
      };
    }
    if (!pane.endpoint) {
      return null;
    }
    return {
      kind: "remote" as const,
      endpointId: pane.endpoint.id,
      path: targetPath,
    };
  };

  const startSftpTransferForItems = async (
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void,
    input: {
      sourcePane: SftpPaneState;
      targetPane: SftpPaneState;
      targetPath: string;
      items: FileEntry[];
    },
  ) => {
    if (input.items.length === 0) {
      return;
    }

    const source = buildSftpTransferEndpoint(input.sourcePane, input.sourcePane.currentPath);
    const target = buildSftpTransferEndpoint(input.targetPane, input.targetPath);
    if (!source || !target) {
      return;
    }

    const destinationListing: DirectoryListing =
      input.targetPane.sourceKind === "local"
        ? await api.files.list(input.targetPath)
        : await api.sftp.list({
            endpointId: input.targetPane.endpoint?.id ?? "",
            path: input.targetPath,
          });

    const conflicts = input.items
      .filter((item) =>
        destinationListing.entries.some((entry) => entry.name === item.name),
      )
      .map((item) => item.name);

    const transferInput: TransferStartInput = {
      source,
      target,
      items: input.items.map((item) => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
        size: item.size,
      })),
      conflictResolution: conflicts.length > 0 ? "skip" : "overwrite",
    };

    if (conflicts.length > 0) {
      set((state) => ({
        activeWorkspaceTab: "sftp",
        sftp: {
          ...state.sftp,
          pendingConflictDialog: {
            input: transferInput,
            names: conflicts,
          },
        },
      }));
      return;
    }

    const job = await api.sftp.startTransfer(transferInput);
    set((state) => ({
      activeWorkspaceTab: "sftp",
      sftp: {
        ...state.sftp,
        transfers: upsertTransferJob(state.sftp.transfers, job),
      },
    }));
  };

  const resolveLocalTransferItemsFromPaths = async (paths: string[]) => {
    const uniquePaths = Array.from(
      new Set(paths.map((targetPath) => targetPath.trim()).filter(Boolean)),
    );
    const listingCache = new Map<string, DirectoryListing>();
    const items: FileEntry[] = [];
    const warnings: string[] = [];

    for (const targetPath of uniquePaths) {
      const parent = await api.files.getParentPath(targetPath);
      const cacheKey = parent;
      let listing = listingCache.get(cacheKey);
      if (!listing) {
        listing = await api.files.list(parent);
        listingCache.set(cacheKey, listing);
      }
      const matched = listing.entries.find((entry) => entry.path === targetPath);
      if (!matched) {
        warnings.push(`${basenameFromPath(targetPath)} 항목을 읽지 못했습니다.`);
        continue;
      }
      items.push(matched);
    }

    return { items, warnings };
  };

  const runTrustedAction = async (
    get: () => AppState,
    sessionId: string | null,
    action: PendingHostKeyPrompt['action'],
    set: (next: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>)) => void
  ) => {
    if (action.kind === 'ssh') {
      if (!sessionId) {
        return;
      }
      await startPendingSessionConnect(set, get, sessionId, action.hostId, action.secrets);
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
            selectedPaths: [],
            selectionAnchorPath: null,
            selectedHostId: action.hostId
          })
        }));
      try {
        const endpoint = await api.sftp.connect({ hostId: action.hostId, secrets: action.secrets });
        set((state) => ({
          sftp: updatePaneState(state, action.paneId, {
            ...getPane(state, action.paneId),
            sourceKind: 'host',
            endpoint,
            currentPath: endpoint.path,
            history: [endpoint.path],
            historyIndex: 0,
            selectedPaths: [],
            selectionAnchorPath: null,
            errorMessage: undefined,
            warningMessages: []
          })
        }));
        await loadPaneListing(set, get, action.paneId, endpoint.path, { pushToHistory: false });
        if (hasProvidedSecrets(action.secrets)) {
          await refreshHostAndKeychainState(set);
        }
      } catch (error) {
        const host = get().hosts.find((item) => item.id === action.hostId);
        const message = error instanceof Error ? error.message : 'SFTP 연결에 실패했습니다.';
        const credentialKind = resolveCredentialRetryKind(host, message);
        if (credentialKind) {
          set({
            pendingCredentialRetry: {
              hostId: action.hostId,
              source: 'sftp',
              credentialKind,
              paneId: action.paneId,
              message
            }
          });
        }
        set((state) => ({
          sftp: updatePaneState(state, action.paneId, {
            ...getPane(state, action.paneId),
            sourceKind: 'host',
            endpoint: null,
            entries: [],
            isLoading: false,
            errorMessage: credentialKind ? undefined : message,
            warningMessages: []
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
    input: { hostId: string; sessionId?: string | null; action: PendingHostKeyPrompt['action'] }
  ): Promise<boolean> => {
    const probe = await api.knownHosts.probeHost({ hostId: input.hostId });
    if (probe.status === 'trusted') {
      return true;
    }
    set({
      pendingHostKeyPrompt: {
        sessionId: input.sessionId ?? null,
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
      settingsSection: 'general',
      hostDrawer: { mode: 'closed' },
      currentGroupPath: null,
      searchQuery: '',
      selectedHostTags: [],
      settings: defaultSettings,
      isReady: false,
      sftp: defaultSftpState,
      pendingHostKeyPrompt: null,
      pendingCredentialRetry: null,
      pendingInteractiveAuth: null,
      pendingConnectionAttempts: [],
      setSearchQuery: (value) => set({ searchQuery: value }),
      toggleHostTag: (tag) =>
        set((state) => {
          const key = normalizeTagValue(tag);
          const alreadySelected = state.selectedHostTags.some((value) => normalizeTagValue(value) === key);
          return {
            selectedHostTags: alreadySelected
              ? state.selectedHostTags.filter((value) => normalizeTagValue(value) !== key)
              : [...state.selectedHostTags, tag]
          };
        }),
      clearHostTagFilter: () => set({ selectedHostTags: [] }),
      activateHome: () => set({ activeWorkspaceTab: 'home' }),
      activateSftp: () => set({ activeWorkspaceTab: 'sftp' }),
      activateSession: (sessionId) => set({ activeWorkspaceTab: asSessionTabId(sessionId) }),
      activateWorkspace: (workspaceId) => set({ activeWorkspaceTab: asWorkspaceTabId(workspaceId) }),
      openHomeSection: (section) =>
        set((state) => {
          const nextSection = normalizeHomeSectionInput(section);
          return {
            activeWorkspaceTab: 'home',
            homeSection: nextSection.homeSection,
            settingsSection:
              nextSection.homeSection === 'settings' ? (nextSection.settingsSection ?? state.settingsSection) : state.settingsSection,
            hostDrawer: nextSection.homeSection === 'hosts' ? get().hostDrawer : { mode: 'closed' }
          };
        }),
      openSettingsSection: (section) =>
        set({
          activeWorkspaceTab: 'home',
          homeSection: 'settings',
          settingsSection: section,
          hostDrawer: { mode: 'closed' }
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
          tabs: tabs.map((tab) => ({
            ...tab,
            sessionShare: normalizeSessionShareState(tab.sessionShare),
            hasReceivedOutput: tab.status === 'connected' ? true : (tab.hasReceivedOutput ?? false)
          })),
          workspaces: [],
          tabStrip: tabs.map((tab) => ({ kind: 'session' as const, sessionId: tab.sessionId })),
          portForwards: sortPortForwards(snapshot.rules),
          portForwardRuntimes: snapshot.runtimes,
          knownHosts: sortKnownHosts(knownHosts),
          activityLogs: sortLogs(activityLogs),
          keychainEntries: sortKeychainEntries(keychainEntries),
          activeWorkspaceTab: 'home',
          homeSection: 'hosts',
          settingsSection: 'general',
          hostDrawer: { mode: 'closed' },
          currentGroupPath: null,
          selectedHostTags: [],
          settings,
          isReady: true,
          pendingHostKeyPrompt: null,
          pendingCredentialRetry: null,
          pendingInteractiveAuth: null,
          pendingConnectionAttempts: [],
          sftp: {
            localHomePath,
            leftPane: {
              ...createEmptyPane('left'),
              sourceKind: 'local',
              currentPath: localListing.path,
              lastLocalPath: localListing.path,
              history: [localListing.path],
              historyIndex: 0,
              entries: localListing.entries,
              warningMessages: localListing.warnings ?? []
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
      refreshHostCatalog: async () => {
        const [nextHosts, nextGroups, nextKeychainEntries] = await Promise.all([api.hosts.list(), api.groups.list(), api.keychain.list()]);
        set({
          hosts: sortHosts(nextHosts),
          groups: sortGroups(nextGroups),
          keychainEntries: sortKeychainEntries(nextKeychainEntries)
        });
      },
      createGroup: async (name) => {
        const next = await api.groups.create(name, get().currentGroupPath);
        set((state) => ({
          groups: sortGroups([...state.groups.filter((group) => group.id !== next.id), next])
        }));
      },
      removeGroup: async (path, mode) => {
        const result = await api.groups.remove(path, mode);
        set((state) => ({
          groups: sortGroups(result.groups),
          hosts: sortHosts(result.hosts),
          currentGroupPath: resolveCurrentGroupPathAfterGroupRemoval(state.currentGroupPath, path, mode)
        }));
      },
      saveHost: async (hostId, draft, secrets) => {
        const next = hostId ? await api.hosts.update(hostId, draft, secrets) : await api.hosts.create(draft, secrets);
        set({
          hosts: sortHosts([...get().hosts.filter((host) => host.id !== next.id), next]),
          hostDrawer: { mode: 'edit', hostId: next.id }
        });
        await refreshHostAndKeychainState(set);
        await syncOperationalData(set);
      },
      moveHostToGroup: async (hostId, groupPath) => {
        const current = get().hosts.find((host) => host.id === hostId);
        if (!current) {
          return;
        }

        const next = await api.hosts.update(
          hostId,
          isAwsEc2HostRecord(current)
            ? {
                kind: 'aws-ec2',
                label: current.label,
                groupName: groupPath,
                tags: current.tags ?? [],
                terminalThemeId: current.terminalThemeId ?? null,
                awsProfileName: current.awsProfileName,
                awsRegion: current.awsRegion,
                awsInstanceId: current.awsInstanceId,
                awsInstanceName: current.awsInstanceName ?? null,
                awsPlatform: current.awsPlatform ?? null,
                awsPrivateIp: current.awsPrivateIp ?? null,
                awsState: current.awsState ?? null
              }
            : isWarpgateSshHostRecord(current)
              ? {
                  kind: 'warpgate-ssh',
                  label: current.label,
                  groupName: groupPath,
                  tags: current.tags ?? [],
                  terminalThemeId: current.terminalThemeId ?? null,
                  warpgateBaseUrl: current.warpgateBaseUrl,
                  warpgateSshHost: current.warpgateSshHost,
                  warpgateSshPort: current.warpgateSshPort,
                  warpgateTargetId: current.warpgateTargetId,
                  warpgateTargetName: current.warpgateTargetName,
                  warpgateUsername: current.warpgateUsername
                }
            : {
                kind: 'ssh',
                label: current.label,
                hostname: current.hostname,
                port: current.port,
                username: current.username,
                authType: current.authType,
                privateKeyPath: current.privateKeyPath ?? null,
                secretRef: current.secretRef ?? null,
                groupName: groupPath,
                tags: current.tags ?? [],
                terminalThemeId: current.terminalThemeId ?? null
              }
        );

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
      openLocalTerminal: async (cols, rows) => {
        await startLocalTerminalFlow(set, get, cols, rows);
      },
      connectHost: async (hostId, cols, rows, secrets) => {
        const host = get().hosts.find((item) => item.id === hostId);
        if (!host) {
          return;
        }
        const existingPendingAttempt = findPendingConnectionAttemptByHost(get(), hostId);
        if (existingPendingAttempt) {
          set((state) => activateSessionContextInState(state, existingPendingAttempt.sessionId));
          return;
        }
        await startSessionConnectionFlow(set, get, hostId, cols, rows, secrets);
      },
      retrySessionConnection: async (sessionId, secrets) => {
        const currentTab = get().tabs.find((tab) => tab.sessionId === sessionId);
        if (!currentTab) {
          return;
        }

        if (currentTab.source === 'local') {
          const pendingSessionId = createPendingSessionId();
          const currentAttempt = findPendingConnectionAttempt(get(), sessionId);
          const latestCols = currentAttempt?.latestCols ?? 120;
          const latestRows = currentAttempt?.latestRows ?? 32;

          set((state) => ({
            ...replaceSessionReferencesInState(state, sessionId, pendingSessionId, (tab) =>
              createPendingSessionTab({
                sessionId: pendingSessionId,
                source: 'local',
                hostId: null,
                title: tab.title,
                progress: createConnectionProgress('retrying-session', '로컬 터미널을 다시 시작하는 중입니다.')
              })
            ),
            pendingConnectionAttempts: [
              ...state.pendingConnectionAttempts.filter((attempt) => attempt.sessionId !== sessionId),
              {
                sessionId: pendingSessionId,
                source: 'local' as const,
                hostId: null,
                title: currentTab.title,
                latestCols,
                latestRows
              }
            ]
          }));

          if (!isPendingSessionId(sessionId)) {
            await api.ssh.disconnect(sessionId).catch(() => undefined);
          }

          await startLocalTerminalFlow(set, get, latestCols, latestRows, pendingSessionId);
          return;
        }

        const host = currentTab.hostId ? get().hosts.find((item) => item.id === currentTab.hostId) : null;
        if (!host) {
          return;
        }

        const pendingSessionId = createPendingSessionId();
        const currentAttempt = findPendingConnectionAttempt(get(), sessionId);
        const latestCols = currentAttempt?.latestCols ?? 120;
        const latestRows = currentAttempt?.latestRows ?? 32;

        set((state) => ({
          ...replaceSessionReferencesInState(state, sessionId, pendingSessionId, (tab) =>
            createPendingSessionTab({
              sessionId: pendingSessionId,
              source: 'host',
              hostId: tab.hostId,
              title: tab.title,
              progress: isAwsEc2HostRecord(host)
                ? createConnectionProgress('checking-profile', `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`)
                : resolveHostKeyCheckProgress(host)
            })
          ),
          pendingConnectionAttempts: [
            ...state.pendingConnectionAttempts.filter((attempt) => attempt.sessionId !== sessionId),
            {
              sessionId: pendingSessionId,
              source: 'host' as const,
              hostId: host.id,
              title: currentTab.title,
              latestCols,
              latestRows
            }
          ]
        }));

        if (!isPendingSessionId(sessionId)) {
          await api.ssh.disconnect(sessionId).catch(() => undefined);
        }

        await startSessionConnectionFlow(set, get, host.id, latestCols, latestRows, secrets, pendingSessionId);
      },
      startSessionShare: async (input) => {
        const { sessionId } = input;
        const tab = get().tabs.find((item) => item.sessionId === sessionId);
        if (!tab || tab.source !== 'host' || tab.status !== 'connected') {
          return;
        }

        set((state) => ({
          tabs: setSessionShareState(state.tabs, sessionId, {
            status: 'starting',
            shareUrl: tab.sessionShare?.shareUrl ?? null,
            inputEnabled: tab.sessionShare?.inputEnabled ?? false,
            viewerCount: tab.sessionShare?.viewerCount ?? 0,
            errorMessage: null
          })
        }));

        const nextState = await api.sessionShares.start(input);
        set((state) => ({
          tabs: setSessionShareState(state.tabs, sessionId, nextState)
        }));
      },
      updateSessionShareSnapshot: async (input) => {
        const { sessionId } = input;
        const tab = get().tabs.find((item) => item.sessionId === sessionId);
        if (!tab || tab.sessionShare?.status !== 'active') {
          return;
        }
        await api.sessionShares.updateSnapshot(input);
      },
      setSessionShareInputEnabled: async (sessionId, inputEnabled) => {
        const tab = get().tabs.find((item) => item.sessionId === sessionId);
        if (!tab || tab.sessionShare?.status === 'inactive') {
          return;
        }
        const nextState = await api.sessionShares.setInputEnabled({
          sessionId,
          inputEnabled
        });
        set((state) => ({
          tabs: setSessionShareState(state.tabs, sessionId, nextState)
        }));
      },
      stopSessionShare: async (sessionId) => {
        await api.sessionShares.stop(sessionId);
        set((state) => ({
          tabs: setSessionShareState(state.tabs, sessionId, createInactiveSessionShareState())
        }));
      },
      disconnectTab: async (sessionId) => {
        const currentShare = get().tabs.find((tab) => tab.sessionId === sessionId)?.sessionShare;
        if (currentShare && currentShare.status !== 'inactive') {
          await api.sessionShares.stop(sessionId).catch(() => undefined);
        }
        if (isPendingSessionId(sessionId)) {
          set((state) => removeSessionFromState(state, sessionId));
          return;
        }

        const currentTab = get().tabs.find((tab) => tab.sessionId === sessionId);
        if (currentTab?.status === 'error') {
          await api.ssh.disconnect(sessionId).catch(() => undefined);
          set((state) => removeSessionFromState(state, sessionId));
          return;
        }

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
      reorderDynamicTab: (source, target, placement) => {
        if (source.kind === 'session' && target.kind === 'session' && source.sessionId === target.sessionId) {
          return;
        }
        if (source.kind === 'workspace' && target.kind === 'workspace' && source.workspaceId === target.workspaceId) {
          return;
        }

        set((state) => {
          const sourceIndex = state.tabStrip.findIndex((item) =>
            source.kind === 'session'
              ? item.kind === 'session' && item.sessionId === source.sessionId
              : item.kind === 'workspace' && item.workspaceId === source.workspaceId
          );
          const targetIndex = state.tabStrip.findIndex((item) =>
            target.kind === 'session'
              ? item.kind === 'session' && item.sessionId === target.sessionId
              : item.kind === 'workspace' && item.workspaceId === target.workspaceId
          );
          if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
            return state;
          }

          const nextTabStrip = [...state.tabStrip];
          const [moved] = nextTabStrip.splice(sourceIndex, 1);
          const nextTargetIndex = nextTabStrip.findIndex((item) =>
            target.kind === 'session'
              ? item.kind === 'session' && item.sessionId === target.sessionId
              : item.kind === 'workspace' && item.workspaceId === target.workspaceId
          );

          if (nextTargetIndex < 0) {
            return state;
          }

          nextTabStrip.splice(placement === 'after' ? nextTargetIndex + 1 : nextTargetIndex, 0, moved);
          return { tabStrip: nextTabStrip };
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
        if (rule.transport === 'ssh') {
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
        }
        await runTrustedAction(get, null, { kind: 'portForward', ruleId, hostId: rule.hostId }, set);
      },
      stopPortForward: async (ruleId) => {
        await api.portForwards.stop(ruleId);
        const rule = get().portForwards.find((item) => item.id === ruleId);
        set((state) => ({
          portForwardRuntimes: upsertForwardRuntime(state.portForwardRuntimes, {
            ...(state.portForwardRuntimes.find((runtime) => runtime.ruleId === ruleId) ?? {
              ruleId,
              hostId: '',
              transport: rule?.transport ?? 'ssh',
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
        await runTrustedAction(get, pending.sessionId ?? null, pending.action, set);
      },
      dismissPendingHostKeyPrompt: () => {
        const pending = get().pendingHostKeyPrompt;
        if (pending?.sessionId) {
          const message = `${pending.probe.hostLabel} 호스트 키 확인이 취소되었습니다.`;
          markSessionError(set, pending.sessionId, message, {
            progress: resolveErrorProgress(message)
          });
          set({ pendingHostKeyPrompt: null });
          return;
        }
        set({ pendingHostKeyPrompt: null });
      },
      dismissPendingCredentialRetry: () => {
        const pending = get().pendingCredentialRetry;
        if (pending?.sessionId) {
          const host = get().hosts.find((item) => item.id === pending.hostId);
          const message = `${host?.label ?? '세션'} 인증 입력이 취소되었습니다.`;
          markSessionError(set, pending.sessionId, message, {
            progress: resolveErrorProgress(message)
          });
          set({ pendingCredentialRetry: null });
          return;
        }
        set({ pendingCredentialRetry: null });
      },
      respondInteractiveAuth: async (challengeId, responses) => {
        const pending = get().pendingInteractiveAuth;
        if (!pending || pending.challengeId !== challengeId) {
          return;
        }
        await api.ssh.respondKeyboardInteractive({
          sessionId: pending.sessionId,
          challengeId,
          responses
        });
      },
      reopenInteractiveAuthUrl: async () => {
        const pending = get().pendingInteractiveAuth;
        if (!pending?.approvalUrl) {
          return;
        }
        await api.shell.openExternal(pending.approvalUrl);
      },
      clearPendingInteractiveAuth: () => set({ pendingInteractiveAuth: null }),
      updatePendingConnectionSize: (sessionId, cols, rows) => {
        set((state) => ({
          pendingConnectionAttempts: state.pendingConnectionAttempts.map((attempt) =>
            attempt.sessionId === sessionId
              ? {
                  ...attempt,
                  latestCols: cols,
                  latestRows: rows
                }
              : attempt
          )
        }));
      },
      markSessionOutput: (sessionId) => {
        set((state) => {
          const tabIndex = state.tabs.findIndex((tab) => tab.sessionId === sessionId);
          if (tabIndex < 0) {
            return state;
          }

          const currentTab = state.tabs[tabIndex];
          if (!currentTab) {
            return state;
          }

          const nextConnectionProgress = currentTab.status === 'connected' ? null : currentTab.connectionProgress;
          if (currentTab.hasReceivedOutput === true && nextConnectionProgress === currentTab.connectionProgress) {
            return state;
          }

          const nextTabs = state.tabs.slice();
          nextTabs[tabIndex] = {
            ...currentTab,
            hasReceivedOutput: true,
            connectionProgress: nextConnectionProgress
          };

          return {
            tabs: nextTabs
          };
        });
      },
      submitCredentialRetry: async (secrets) => {
        const pending = get().pendingCredentialRetry;
        if (!pending) {
          return;
        }

        set({ pendingCredentialRetry: null });
        if (pending.source === 'ssh') {
          if (pending.sessionId) {
            await get().retrySessionConnection(pending.sessionId, secrets);
          } else {
            await get().connectHost(pending.hostId, 120, 32, secrets);
          }
          return;
        }

        if (!pending.paneId) {
          return;
        }

        const host = get().hosts.find((item) => item.id === pending.hostId);
        if (!host || !isSshHostRecord(host)) {
          return;
        }

        const trusted = await ensureTrustedHost(set, {
          hostId: pending.hostId,
          action: {
            kind: 'sftp',
            paneId: pending.paneId,
            hostId: pending.hostId,
            secrets
          }
        });
        if (!trusted) {
          return;
        }
        await runTrustedAction(get, null, { kind: 'sftp', paneId: pending.paneId, hostId: pending.hostId, secrets }, set);
      },
      handleCoreEvent: (event) => {
        const sessionId = event.sessionId;
        const pendingRetryBeforeUpdate = get().pendingCredentialRetry;
        void api.logs.list().then((activityLogs) => {
          set({ activityLogs: sortLogs(activityLogs) });
        });
        if (!sessionId) {
          return;
        }

        if (event.type === 'keyboardInteractiveChallenge') {
          const payload = event.payload as Record<string, unknown>;
          const challenge: KeyboardInteractiveChallenge = {
            sessionId,
            challengeId: String(payload.challengeId ?? ''),
            attempt: Number(payload.attempt ?? 1),
            name: typeof payload.name === 'string' ? payload.name : null,
            instruction: String(payload.instruction ?? ''),
            prompts: Array.isArray(payload.prompts)
              ? payload.prompts.map((prompt) => {
                  const candidate = prompt as Record<string, unknown>;
                  return {
                    label: String(candidate.label ?? ''),
                    echo: Boolean(candidate.echo)
                  } satisfies KeyboardInteractivePrompt;
                })
              : []
          };
          const currentTab = get().tabs.find((tab) => tab.sessionId === sessionId);
          const currentHost =
            currentTab?.source === 'host' && currentTab.hostId
              ? get().hosts.find((host) => host.id === currentTab.hostId)
              : undefined;
          const isWarpgateChallenge = shouldTreatAsWarpgate(currentHost, challenge);
          const approvalUrl = isWarpgateChallenge
            ? parseWarpgateApprovalUrl(challenge.instruction, challenge.name, ...challenge.prompts.map((prompt) => prompt.label))
            : null;
          const authCode = isWarpgateChallenge
            ? parseWarpgateAuthCode(challenge.instruction, challenge.name, ...challenge.prompts.map((prompt) => prompt.label))
            : null;
          const shouldUseWarpgateUi = isWarpgateChallenge && Boolean(approvalUrl || authCode);

          if (approvalUrl && !openedInteractiveBrowserChallenges.has(challenge.challengeId)) {
            openedInteractiveBrowserChallenges.add(challenge.challengeId);
            void api.shell.openExternal(approvalUrl).catch(() => undefined);
          }

          const autoResponses: string[] = [];
          let canAutoRespond = challenge.prompts.length > 0;
          for (const prompt of challenge.prompts) {
            if (shouldUseWarpgateUi && authCode && isWarpgateCodePrompt(prompt.label, challenge.instruction)) {
              autoResponses.push(authCode);
              continue;
            }
            if (shouldUseWarpgateUi && isWarpgateCompletionPrompt(prompt.label, challenge.instruction)) {
              autoResponses.push('');
              continue;
            }
            canAutoRespond = false;
            break;
          }

          set((state) => {
            const currentTab = state.tabs.find((tab) => tab.sessionId === sessionId);
            const progress = createConnectionProgress(
              'waiting-interactive-auth',
              shouldUseWarpgateUi
                ? `${currentHost?.label ?? '세션'} Warpgate 승인을 기다리는 중입니다.`
                : `${currentHost?.label ?? '세션'} 추가 인증 응답이 필요합니다.`,
              {
                blockingKind: 'panel'
              }
            );

            return {
              tabs: currentTab
                ? state.tabs.map((tab) =>
                    tab.sessionId === sessionId
                      ? {
                          ...tab,
                          status: 'connecting',
                          connectionProgress: progress,
                          lastEventAt: new Date().toISOString()
                        }
                      : tab
                  )
                : state.tabs,
              pendingInteractiveAuth: {
                sessionId,
                challengeId: challenge.challengeId,
                name: challenge.name ?? null,
                instruction: challenge.instruction,
                prompts: challenge.prompts,
                provider: shouldUseWarpgateUi ? 'warpgate' : 'generic',
                approvalUrl,
                authCode,
                autoSubmitted: canAutoRespond && autoResponses.length === challenge.prompts.length && challenge.prompts.length > 0
              },
              ...activateSessionContextInState(state, sessionId)
            };
          });

          if (canAutoRespond && autoResponses.length === challenge.prompts.length && challenge.prompts.length > 0) {
            void api.ssh
              .respondKeyboardInteractive({
                sessionId,
                challengeId: challenge.challengeId,
                responses: autoResponses
              })
              .catch(() => undefined);
          }
          return;
        }

        if (event.type === 'keyboardInteractiveResolved') {
          set((state) => {
            const currentTab = state.tabs.find((tab) => tab.sessionId === sessionId);
            const currentHost =
              currentTab?.source === 'host' && currentTab.hostId
                ? state.hosts.find((host) => host.id === currentTab.hostId)
                : undefined;

            if (!state.pendingInteractiveAuth || state.pendingInteractiveAuth.sessionId !== sessionId) {
              return state;
            }
            if (state.pendingInteractiveAuth.provider === 'warpgate') {
              return state;
            }
            return {
              pendingInteractiveAuth: null,
              tabs: currentTab
                ? state.tabs.map((tab) =>
                    tab.sessionId === sessionId
                      ? {
                          ...tab,
                          connectionProgress: currentHost ? resolveConnectingProgress(currentHost) : tab.connectionProgress,
                          lastEventAt: new Date().toISOString()
                        }
                      : tab
                  )
                : state.tabs
            };
          });
          return;
        }

        set((state) => {
          if (event.type === 'closed') {
            return removeSessionFromState(state, sessionId);
          }

          const currentTab = state.tabs.find((tab) => tab.sessionId === sessionId);
          if (!currentTab) {
            return state;
          }
          const currentHost =
            currentTab.source === 'host' && currentTab.hostId
              ? state.hosts.find((host) => host.id === currentTab.hostId)
              : undefined;
          const errorMessage = String(event.payload.message ?? 'SSH error');
          const retryKind = event.type === 'error' ? resolveCredentialRetryKind(currentHost, errorMessage) : null;
          const nextProgress =
            event.type === 'connected'
              ? currentTab.source === 'local'
                ? resolveLocalWaitingShellProgress()
                : currentHost
                  ? resolveWaitingShellProgress(currentHost)
                  : createConnectionProgress('waiting-shell', '원격 셸이 첫 출력을 보내는 중입니다.')
              : event.type === 'error'
                ? retryKind && currentHost
                  ? resolveCredentialRetryProgress(currentHost, retryKind)
                  : resolveErrorProgress(errorMessage)
                : currentTab.connectionProgress;

          const tabs = state.tabs.map((tab) => {
            if (tab.sessionId !== sessionId) {
              return tab;
            }

            let nextStatus: TabStatus = tab.status;
            if (event.type === 'connected') {
              nextStatus = 'connected';
            }
            if (event.type === 'error') {
              nextStatus = 'error';
            }
            return {
              ...tab,
              status: nextStatus,
              errorMessage: event.type === 'error' ? errorMessage : undefined,
              connectionProgress: nextProgress,
              hasReceivedOutput: event.type === 'connected' ? false : tab.hasReceivedOutput,
              lastEventAt: new Date().toISOString()
            };
          });

          return {
            tabs,
            pendingInteractiveAuth:
              event.type === 'connected' || event.type === 'error'
                ? state.pendingInteractiveAuth?.sessionId === sessionId
                  ? null
                  : state.pendingInteractiveAuth
                : state.pendingInteractiveAuth,
            pendingCredentialRetry:
              retryKind && currentHost
                ? {
                    sessionId,
                    hostId: currentHost.id,
                    source: 'ssh',
                    credentialKind: retryKind,
                    message: errorMessage
                  }
                : event.type === 'connected' &&
                    state.pendingCredentialRetry?.source === 'ssh' &&
                    (
                      state.pendingCredentialRetry.sessionId
                        ? state.pendingCredentialRetry.sessionId === sessionId
                        : state.pendingCredentialRetry.hostId === currentHost?.id
                    )
                  ? null
                  : state.pendingCredentialRetry
          };
        });

        if (event.type === 'connected' && pendingRetryBeforeUpdate?.source === 'ssh') {
          const currentTab = get().tabs.find((tab) => tab.sessionId === sessionId);
          const currentHost =
            currentTab?.source === 'host' && currentTab.hostId
              ? get().hosts.find((host) => host.id === currentTab.hostId) ?? null
              : null;
          if (currentHost && currentHost.id === pendingRetryBeforeUpdate.hostId) {
            void refreshHostAndKeychainState(set);
          }
        }
      },
      handleSessionShareEvent: (event) => {
        set((state) => ({
          tabs: setSessionShareState(state.tabs, event.sessionId, event.state)
        }));
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
          hostGroupPath: null,
          currentPath: sourceKind === 'local' ? pane.lastLocalPath || get().sftp.localHomePath : '',
          history: sourceKind === 'local' ? [pane.lastLocalPath || get().sftp.localHomePath] : [],
          historyIndex: sourceKind === 'local' ? 0 : -1,
          entries: [],
          selectedPaths: [],
          selectionAnchorPath: null,
          errorMessage: undefined,
          warningMessages: [],
          selectedHostId: null,
          hostSearchQuery: '',
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
      navigateSftpHostGroup: (paneId, path) =>
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            hostGroupPath: normalizeGroupPath(path),
            selectedHostId: null
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
        const host = get().hosts.find((item) => item.id === hostId);
        if (!host || !isSshHostRecord(host)) {
          return;
        }
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
        await runTrustedAction(get, null, { kind: 'sftp', paneId, hostId }, set);
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
        const nextPath = pane.sourceKind === 'local' ? await api.files.getParentPath(pane.currentPath) : parentPath(pane.currentPath);
        await loadPaneListing(set, get, paneId, nextPath, { pushToHistory: true });
      },
      navigateSftpBreadcrumb: async (paneId, nextPath) => {
        await loadPaneListing(set, get, paneId, nextPath, { pushToHistory: true });
      },
      selectSftpEntry: (paneId, input) =>
        set((state) => {
          const pane = getPane(state, paneId);
          return {
            sftp: updatePaneState(state, paneId, {
              ...pane,
              ...resolveNextSftpSelection(pane, input)
            })
          };
        }),
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
        if (!targetPath || pane.selectedPaths.length !== 1 || !nextName.trim()) {
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
      changeSftpSelectionPermissions: async (paneId, mode) => {
        const pane = getPane(get(), paneId);
        const targetPath = pane.selectedPaths[0];
        if (!targetPath || pane.selectedPaths.length !== 1) {
          return;
        }
        if (pane.sourceKind === "local") {
          await api.files.chmod(targetPath, mode);
        } else if (pane.endpoint) {
          await api.sftp.chmod({
            endpointId: pane.endpoint.id,
            path: targetPath,
            mode,
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
      downloadSftpSelection: async (paneId) => {
        const state = get();
        const sourcePane = getPane(state, paneId);
        if (sourcePane.sourceKind !== "host" || !sourcePane.endpoint || sourcePane.selectedPaths.length !== 1) {
          return;
        }
        const selectedItem = sourcePane.entries.find((entry) => entry.path === sourcePane.selectedPaths[0]);
        if (!selectedItem || selectedItem.isDirectory) {
          return;
        }
        const downloadsPath = await api.files.getDownloadsDirectory();
        const targetPane: SftpPaneState = {
          ...createEmptyPane("left"),
          sourceKind: "local",
          currentPath: downloadsPath,
          lastLocalPath: downloadsPath,
        };
        await startSftpTransferForItems(set, {
          sourcePane,
          targetPane,
          targetPath: downloadsPath,
          items: [selectedItem],
        });
      },
      prepareSftpTransfer: async (sourcePaneId, targetPaneId, targetPath, draggedPath = null) => {
        const state = get();
        const sourcePane = getPane(state, sourcePaneId);
        const targetPane = getPane(state, targetPaneId);
        const items = resolveTransferItemsFromPane(sourcePane, draggedPath);
        await startSftpTransferForItems(set, {
          sourcePane,
          targetPane,
          targetPath,
          items,
        });
      },
      prepareSftpExternalTransfer: async (targetPaneId, targetPath, droppedPaths) => {
        const targetPane = getPane(get(), targetPaneId);
        if (targetPane.sourceKind !== "host" || !targetPane.endpoint) {
          return;
        }
        const { items, warnings } = await resolveLocalTransferItemsFromPaths(droppedPaths);
        if (warnings.length > 0) {
          setSftpPaneWarnings(set, targetPaneId, warnings);
        }
        if (items.length === 0) {
          if (warnings.length === 0) {
            setSftpPaneWarnings(set, targetPaneId, ["드롭한 항목 경로를 읽지 못했습니다."]);
          }
          return;
        }
        const sourcePane: SftpPaneState = {
          ...createEmptyPane("left"),
          sourceKind: "local",
          currentPath: "",
          lastLocalPath: "",
          entries: items,
          selectedPaths: items.map((item) => item.path),
          selectionAnchorPath: items[0]?.path ?? null,
        };
        await startSftpTransferForItems(set, {
          sourcePane,
          targetPane,
          targetPath,
          items,
        });
      },
      transferSftpSelectionToPane: async (sourcePaneId, targetPaneId) => {
        const state = get();
        const sourcePane = getPane(state, sourcePaneId);
        const targetPane = getPane(state, targetPaneId);
        if (!isBrowsableSftpPane(sourcePane) || !isBrowsableSftpPane(targetPane)) {
          return;
        }
        const items = resolveTransferItemsFromPane(sourcePane);
        await startSftpTransferForItems(set, {
          sourcePane,
          targetPane,
          targetPath: targetPane.currentPath,
          items,
        });
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
      },
      dismissTransfer: (jobId) => {
        set((state) => ({
          sftp: {
            ...state.sftp,
            transfers: state.sftp.transfers.filter((job) => job.id !== jobId)
          }
        }));
      }
    };
  });

  return store;
}
