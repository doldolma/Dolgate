import { createStore } from 'zustand/vanilla';
import type {
  AppSettings,
  CoreEvent,
  DesktopApi,
  DirectoryListing,
  FileEntry,
  GroupRecord,
  HostDraft,
  HostRecord,
  HostSecretInput,
  SftpEndpointSummary,
  SftpPaneId,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput
} from '@keyterm/shared';

export type WorkspaceTabId = 'home' | 'sftp' | string;
export type HomeSection = 'hosts' | 'settings';
export type SftpSourceKind = 'local' | 'host';
export type HostDrawerState =
  | { mode: 'closed' }
  | { mode: 'create'; defaultGroupPath: string | null }
  | { mode: 'edit'; hostId: string };

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
  activeWorkspaceTab: WorkspaceTabId;
  homeSection: HomeSection;
  hostDrawer: HostDrawerState;
  currentGroupPath: string | null;
  searchQuery: string;
  settings: AppSettings;
  isReady: boolean;
  sftp: SftpState;
  setSearchQuery: (value: string) => void;
  activateHome: () => void;
  activateSftp: () => void;
  activateSession: (sessionId: string) => void;
  openHomeSection: (section: HomeSection) => void;
  openCreateHostDrawer: () => void;
  openEditHostDrawer: (hostId: string) => void;
  closeHostDrawer: () => void;
  navigateGroup: (path: string | null) => void;
  bootstrap: () => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  saveHost: (hostId: string | null, draft: HostDraft, secrets?: HostSecretInput) => Promise<void>;
  removeHost: (hostId: string) => Promise<void>;
  connectHost: (hostId: string, cols: number, rows: number) => Promise<void>;
  disconnectTab: (sessionId: string) => Promise<void>;
  updateSettings: (input: Partial<AppSettings>) => Promise<void>;
  handleCoreEvent: (event: CoreEvent<Record<string, unknown>>) => void;
  handleTransferEvent: (event: TransferJobEvent) => void;
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

export function createAppStore(api: DesktopApi) {
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

  return createStore<AppState>((set, get) => ({
    hosts: [],
    groups: [],
    tabs: [],
    activeWorkspaceTab: 'home',
    homeSection: 'hosts',
    hostDrawer: { mode: 'closed' },
    currentGroupPath: null,
    searchQuery: '',
    settings: defaultSettings,
    isReady: false,
    sftp: defaultSftpState,
    setSearchQuery: (value) => set({ searchQuery: value }),
    activateHome: () => set({ activeWorkspaceTab: 'home' }),
    activateSftp: () => set({ activeWorkspaceTab: 'sftp' }),
    activateSession: (sessionId) => set({ activeWorkspaceTab: sessionId }),
    openHomeSection: (section) =>
      set({
        activeWorkspaceTab: 'home',
        homeSection: section,
        hostDrawer: section === 'settings' ? { mode: 'closed' } : get().hostDrawer
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
      // 앱 시작 시 로컬 DB의 호스트, 살아 있는 SSH 탭, 설정과 SFTP 기본 로컬 경로를 함께 읽어 초기 워크스페이스를 구성한다.
      const [hosts, groups, tabs, settings, localHomePath] = await Promise.all([
        api.hosts.list(),
        api.groups.list(),
        api.tabs.list(),
        api.settings.get(),
        api.files.getHomeDirectory()
      ]);
      const localListing = await api.files.list(localHomePath);
      set({
        hosts: sortHosts(hosts),
        groups: sortGroups(groups),
        tabs,
        activeWorkspaceTab: 'home',
        homeSection: 'hosts',
        hostDrawer: { mode: 'closed' },
        currentGroupPath: null,
        settings,
        isReady: true,
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
    createGroup: async (name) => {
      const next = await api.groups.create(name, get().currentGroupPath);
      set((state) => ({
        groups: sortGroups([...state.groups.filter((group) => group.id !== next.id), next])
      }));
    },
    saveHost: async (hostId, draft, secrets) => {
      // 생성/수정 경로를 하나의 액션으로 유지해 우측 드로어가 단일 폼만 재사용하게 한다.
      const next = hostId ? await api.hosts.update(hostId, draft, secrets) : await api.hosts.create(draft, secrets);
      const hosts = sortHosts([...get().hosts.filter((host) => host.id !== next.id), next]);
      set({
        hosts,
        hostDrawer: { mode: 'edit', hostId: next.id }
      });
    },
    removeHost: async (hostId) => {
      await api.hosts.remove(hostId);
      const currentDrawer = get().hostDrawer;
      set({
        hosts: get().hosts.filter((host) => host.id !== hostId),
        hostDrawer: currentDrawer.mode === 'edit' && currentDrawer.hostId === hostId ? { mode: 'closed' } : currentDrawer
      });
    },
    connectHost: async (hostId, cols, rows) => {
      // 연결 성공 전에도 세션 탭을 즉시 띄워 사용자가 진행 상황을 놓치지 않게 한다.
      const host = get().hosts.find((item) => item.id === hostId);
      if (!host) {
        return;
      }
      const { sessionId } = await api.ssh.connect({ hostId, cols, rows });
      const tab: TerminalTab = {
        id: sessionId,
        title: host.label,
        hostId,
        sessionId,
        status: 'connecting',
        lastEventAt: new Date().toISOString()
      };
      set((state) => ({
        tabs: [...state.tabs.filter((item) => item.id !== sessionId), tab],
        activeWorkspaceTab: sessionId,
        homeSection: 'hosts',
        hostDrawer: { mode: 'closed' }
      }));
    },
    disconnectTab: async (sessionId) => {
      // 탭 닫기는 곧 세션 종료 요청이므로, 실제 closed 이벤트를 받을 때까지 상태를 남겨둔다.
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
    updateSettings: async (input) => {
      const settings = await api.settings.update(input);
      set({ settings });
    },
    handleCoreEvent: (event) => {
      const sessionId = event.sessionId;
      if (!sessionId) {
        return;
      }
      set((state) => {
        if (event.type === 'closed') {
          const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId);
          return {
            tabs,
            activeWorkspaceTab: state.activeWorkspaceTab === sessionId ? 'home' : state.activeWorkspaceTab
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
      set((state) => {
        const pane = getPane(state, paneId);
        return {
          sftp: updatePaneState(state, paneId, {
            ...pane,
            filterQuery: query
          })
        };
      }),
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
      const pane = getPane(get(), paneId);
      if (pane.endpoint) {
        await api.sftp.disconnect(pane.endpoint.id);
      }
      set((state) => ({
        activeWorkspaceTab: 'sftp',
        sftp: updatePaneState(state, paneId, {
          ...getPane(state, paneId),
          sourceKind: 'host',
          endpoint: null,
          entries: [],
          isLoading: true,
          errorMessage: undefined,
          selectedHostId: hostId
        })
      }));

      try {
        const endpoint = await api.sftp.connect({ hostId });
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            sourceKind: 'host',
            endpoint,
            currentPath: endpoint.path,
            history: [endpoint.path],
            historyIndex: 0,
            selectedPaths: [],
            errorMessage: undefined
          })
        }));
        await loadPaneListing(set, get, paneId, endpoint.path, { pushToHistory: false });
      } catch (error) {
        set((state) => ({
          sftp: updatePaneState(state, paneId, {
            ...getPane(state, paneId),
            sourceKind: 'host',
            endpoint: null,
            entries: [],
            isLoading: false,
            errorMessage: error instanceof Error ? error.message : 'SFTP 연결에 실패했습니다.'
          })
        }));
      }
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

      const destinationListing =
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
  }));
}
