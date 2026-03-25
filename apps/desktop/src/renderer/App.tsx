import { useEffect, useMemo, useRef, useState } from 'react';
import { buildGroupOptions, getHostSecretRef, isSshHostRecord } from '@shared';
import type { AppTheme, AuthState, DesktopWindowState, HostRecord, LinkedHostSummary, UpdateState } from '@shared';
import { AppTitleBar } from './components/AppTitleBar';
import { AwsImportDialog } from './components/AwsImportDialog';
import { CredentialRetryDialog } from './components/CredentialRetryDialog';
import { HomeNavigation } from './components/HomeNavigation';
import { HostBrowser } from './components/HostBrowser';
import { HostDrawer } from './components/HostDrawer';
import { KeychainPanel } from './components/KeychainPanel';
import { KnownHostPromptDialog } from './components/KnownHostPromptDialog';
import { KnownHostsPanel } from './components/KnownHostsPanel';
import { LoginGate } from './components/LoginGate';
import { LogsPanel } from './components/LogsPanel';
import { DesktopWindowControls } from './components/DesktopWindowControls';
import { PortForwardingPanel } from './components/PortForwardingPanel';
import { SecretEditDialog, type SecretCredentialKind, type SecretEditDialogRequest } from './components/SecretEditDialog';
import { SettingsPanel } from './components/SettingsPanel';
import { SftpWorkspace } from './components/SftpWorkspace';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { TermiusImportDialog } from './components/TermiusImportDialog';
import { WarpgateImportDialog } from './components/WarpgateImportDialog';
import { appStore } from './store/appStore';
import type { DynamicTabStripItem, WorkspaceDropDirection, WorkspaceTab } from './store/createAppStore';
import { useAppStore } from './store/appStore';

function findHost(hosts: HostRecord[], hostId: string | null): HostRecord | null {
  return hostId ? hosts.find((host) => host.id === hostId) ?? null : null;
}

function resolveTheme(theme: AppTheme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') {
    return theme;
  }
  return prefersDark ? 'dark' : 'light';
}

function detectDesktopPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
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

function toLinkedHostSummary(host: Extract<HostRecord, { kind: 'ssh' }>): LinkedHostSummary {
  return {
    id: host.id,
    label: host.label,
    hostname: host.hostname,
    username: host.username
  };
}

function createDefaultUpdateState(): UpdateState {
  return {
    enabled: false,
    status: 'idle',
    currentVersion: '0.0.0',
    dismissedVersion: null,
    release: null,
    progress: null,
    checkedAt: null,
    errorMessage: null
  };
}

function createDefaultWindowState(): DesktopWindowState {
  return {
    isMaximized: false
  };
}

interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

function resolveAdjacentTabCandidate(
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
      const paneCount = workspace.layout.kind === 'leaf' ? 1 : undefined;
      const sessionCount = paneCount ?? countWorkspacePanes(workspace);
      if (sessionCount >= 4) {
        continue;
      }
    }
    return candidate;
  }

  return null;
}

function countWorkspacePanes(workspace: WorkspaceTab): number {
  const stack = [workspace.layout];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'leaf') {
      count += 1;
      continue;
    }
    stack.push(node.first, node.second);
  }
  return count;
}

function workspaceContainsSession(workspace: WorkspaceTab, sessionId: string): boolean {
  const stack = [workspace.layout];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'leaf') {
      if (node.sessionId === sessionId) {
        return true;
      }
      continue;
    }
    stack.push(node.first, node.second);
  }
  return false;
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>({
    status: 'loading',
    session: null,
    errorMessage: null
  });
  const [isSyncBootstrapping, setIsSyncBootstrapping] = useState(false);
  const [syncBootstrapError, setSyncBootstrapError] = useState<string | null>(null);
  const [hydratedSessionUserId, setHydratedSessionUserId] = useState<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [isAwsImportOpen, setIsAwsImportOpen] = useState(false);
  const [isTermiusImportOpen, setIsTermiusImportOpen] = useState(false);
  const [isWarpgateImportOpen, setIsWarpgateImportOpen] = useState(false);
  const [hostBrowserError, setHostBrowserError] = useState<string | null>(null);
  const [hostBrowserStatus, setHostBrowserStatus] = useState<string | null>(null);
  const [draggedSession, setDraggedSession] = useState<DraggedSessionPayload | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>(createDefaultUpdateState);
  const [windowState, setWindowState] = useState<DesktopWindowState>(createDefaultWindowState);
  const [isLoginServerSettingsLoading, setIsLoginServerSettingsLoading] = useState(true);
  const [isUpdateInstallConfirmOpen, setIsUpdateInstallConfirmOpen] = useState(false);
  const [secretEditRequest, setSecretEditRequest] = useState<SecretEditDialogRequest | null>(null);
  const authBootstrapStartedRef = useRef(false);
  const activeHydrationUserIdRef = useRef<string | null>(null);
  const hosts = useAppStore((state) => state.hosts);
  const groups = useAppStore((state) => state.groups);
  const tabs = useAppStore((state) => state.tabs);
  const workspaces = useAppStore((state) => state.workspaces);
  const tabStrip = useAppStore((state) => state.tabStrip);
  const portForwards = useAppStore((state) => state.portForwards);
  const portForwardRuntimes = useAppStore((state) => state.portForwardRuntimes);
  const knownHosts = useAppStore((state) => state.knownHosts);
  const activityLogs = useAppStore((state) => state.activityLogs);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const activeWorkspaceTab = useAppStore((state) => state.activeWorkspaceTab);
  const homeSection = useAppStore((state) => state.homeSection);
  const hostDrawer = useAppStore((state) => state.hostDrawer);
  const currentGroupPath = useAppStore((state) => state.currentGroupPath);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const settings = useAppStore((state) => state.settings);
  const pendingHostKeyPrompt = useAppStore((state) => state.pendingHostKeyPrompt);
  const pendingCredentialRetry = useAppStore((state) => state.pendingCredentialRetry);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refreshHostCatalog = useAppStore((state) => state.refreshHostCatalog);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const activateHome = useAppStore((state) => state.activateHome);
  const activateSession = useAppStore((state) => state.activateSession);
  const activateWorkspace = useAppStore((state) => state.activateWorkspace);
  const openHomeSection = useAppStore((state) => state.openHomeSection);
  const openCreateHostDrawer = useAppStore((state) => state.openCreateHostDrawer);
  const openEditHostDrawer = useAppStore((state) => state.openEditHostDrawer);
  const closeHostDrawer = useAppStore((state) => state.closeHostDrawer);
  const navigateGroup = useAppStore((state) => state.navigateGroup);
  const createGroup = useAppStore((state) => state.createGroup);
  const removeGroup = useAppStore((state) => state.removeGroup);
  const saveHost = useAppStore((state) => state.saveHost);
  const moveHostToGroup = useAppStore((state) => state.moveHostToGroup);
  const removeHost = useAppStore((state) => state.removeHost);
  const openLocalTerminal = useAppStore((state) => state.openLocalTerminal);
  const connectHost = useAppStore((state) => state.connectHost);
  const retrySessionConnection = useAppStore((state) => state.retrySessionConnection);
  const startSessionShare = useAppStore((state) => state.startSessionShare);
  const updateSessionShareSnapshot = useAppStore((state) => state.updateSessionShareSnapshot);
  const setSessionShareInputEnabled = useAppStore((state) => state.setSessionShareInputEnabled);
  const stopSessionShare = useAppStore((state) => state.stopSessionShare);
  const disconnectTab = useAppStore((state) => state.disconnectTab);
  const closeWorkspace = useAppStore((state) => state.closeWorkspace);
  const splitSessionIntoWorkspace = useAppStore((state) => state.splitSessionIntoWorkspace);
  const detachSessionFromWorkspace = useAppStore((state) => state.detachSessionFromWorkspace);
  const reorderDynamicTab = useAppStore((state) => state.reorderDynamicTab);
  const focusWorkspaceSession = useAppStore((state) => state.focusWorkspaceSession);
  const resizeWorkspaceSplit = useAppStore((state) => state.resizeWorkspaceSplit);
  const activateSftp = useAppStore((state) => state.activateSftp);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const savePortForward = useAppStore((state) => state.savePortForward);
  const removePortForward = useAppStore((state) => state.removePortForward);
  const startPortForward = useAppStore((state) => state.startPortForward);
  const stopPortForward = useAppStore((state) => state.stopPortForward);
  const removeKnownHost = useAppStore((state) => state.removeKnownHost);
  const clearLogs = useAppStore((state) => state.clearLogs);
  const removeKeychainSecret = useAppStore((state) => state.removeKeychainSecret);
  const updateKeychainSecret = useAppStore((state) => state.updateKeychainSecret);
  const cloneKeychainSecretForHost = useAppStore((state) => state.cloneKeychainSecretForHost);
  const acceptPendingHostKeyPrompt = useAppStore((state) => state.acceptPendingHostKeyPrompt);
  const dismissPendingHostKeyPrompt = useAppStore((state) => state.dismissPendingHostKeyPrompt);
  const dismissPendingCredentialRetry = useAppStore((state) => state.dismissPendingCredentialRetry);
  const submitCredentialRetry = useAppStore((state) => state.submitCredentialRetry);
  const handleCoreEvent = useAppStore((state) => state.handleCoreEvent);
  const handleTransferEvent = useAppStore((state) => state.handleTransferEvent);
  const handlePortForwardEvent = useAppStore((state) => state.handlePortForwardEvent);
  const handleSessionShareEvent = useAppStore((state) => state.handleSessionShareEvent);
  const sftp = useAppStore((state) => state.sftp);
  const setSftpPaneSource = useAppStore((state) => state.setSftpPaneSource);
  const setSftpPaneFilter = useAppStore((state) => state.setSftpPaneFilter);
  const setSftpHostSearchQuery = useAppStore((state) => state.setSftpHostSearchQuery);
  const navigateSftpHostGroup = useAppStore((state) => state.navigateSftpHostGroup);
  const selectSftpHost = useAppStore((state) => state.selectSftpHost);
  const connectSftpHost = useAppStore((state) => state.connectSftpHost);
  const openSftpEntry = useAppStore((state) => state.openSftpEntry);
  const refreshSftpPane = useAppStore((state) => state.refreshSftpPane);
  const navigateSftpBack = useAppStore((state) => state.navigateSftpBack);
  const navigateSftpForward = useAppStore((state) => state.navigateSftpForward);
  const navigateSftpParent = useAppStore((state) => state.navigateSftpParent);
  const navigateSftpBreadcrumb = useAppStore((state) => state.navigateSftpBreadcrumb);
  const selectSftpEntry = useAppStore((state) => state.selectSftpEntry);
  const createSftpDirectory = useAppStore((state) => state.createSftpDirectory);
  const renameSftpSelection = useAppStore((state) => state.renameSftpSelection);
  const changeSftpSelectionPermissions = useAppStore((state) => state.changeSftpSelectionPermissions);
  const deleteSftpSelection = useAppStore((state) => state.deleteSftpSelection);
  const downloadSftpSelection = useAppStore((state) => state.downloadSftpSelection);
  const prepareSftpTransfer = useAppStore((state) => state.prepareSftpTransfer);
  const prepareSftpExternalTransfer = useAppStore((state) => state.prepareSftpExternalTransfer);
  const transferSftpSelectionToPane = useAppStore((state) => state.transferSftpSelectionToPane);
  const resolveSftpConflict = useAppStore((state) => state.resolveSftpConflict);
  const dismissSftpConflict = useAppStore((state) => state.dismissSftpConflict);
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);
  const retryTransfer = useAppStore((state) => state.retryTransfer);
  const dismissTransfer = useAppStore((state) => state.dismissTransfer);
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const desktopPlatform = useMemo(() => detectDesktopPlatform(), []);

  async function hydrateAuthenticatedWorkspace(nextState: AuthState): Promise<void> {
    if (nextState.status !== 'authenticated' || !nextState.session) {
      return;
    }
    const userId = nextState.session.user.id;
    if (hydratedSessionUserId === userId || activeHydrationUserIdRef.current === userId) {
      return;
    }

    activeHydrationUserIdRef.current = userId;
    setIsSyncBootstrapping(true);
    setSyncBootstrapError(null);
    try {
      await window.dolssh.sync.bootstrap();
      await bootstrap();
      setHydratedSessionUserId(userId);
    } catch (error) {
      const latestAuthState = await window.dolssh.auth.getState();
      setHydratedSessionUserId(null);
      if (latestAuthState.status !== 'authenticated') {
        setSyncBootstrapError(null);
        return;
      }
      setSyncBootstrapError(error instanceof Error ? error.message : '초기 동기화에 실패했습니다.');
    } finally {
      activeHydrationUserIdRef.current = null;
      setIsSyncBootstrapping(false);
    }
  }

  useEffect(() => {
    const offCore = window.dolssh.ssh.onEvent(handleCoreEvent);
    const offTransfer = window.dolssh.sftp.onTransferEvent(handleTransferEvent);
    const offForward = window.dolssh.portForwards.onEvent(handlePortForwardEvent);
    const offSessionShare = window.dolssh.sessionShares.onEvent(handleSessionShareEvent);
    const offAuth = window.dolssh.auth.onEvent((state) => {
      setAuthState(state);
      if (state.status === 'authenticated') {
        void hydrateAuthenticatedWorkspace(state);
        return;
      }
      if (state.status === 'unauthenticated' || state.status === 'error') {
        setHydratedSessionUserId(null);
        setSyncBootstrapError(null);
        activeHydrationUserIdRef.current = null;
      }
    });

    return () => {
      offCore();
      offTransfer();
      offForward();
      offSessionShare();
      offAuth();
    };
  }, [bootstrap, handleCoreEvent, handlePortForwardEvent, handleSessionShareEvent, handleTransferEvent, hydratedSessionUserId]);

  useEffect(() => {
    let isMounted = true;
    void window.dolssh.settings
      .get()
      .then((nextSettings) => {
        if (!isMounted) {
          return;
        }
        appStore.setState({ settings: nextSettings });
      })
      .finally(() => {
        if (isMounted) {
          setIsLoginServerSettingsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (authBootstrapStartedRef.current) {
      return;
    }
    authBootstrapStartedRef.current = true;

    void window.dolssh.auth.bootstrap().then((state) => {
      setAuthState(state);
      if (state.status === 'authenticated') {
        void hydrateAuthenticatedWorkspace(state);
      }
    });
  }, [bootstrap, hydratedSessionUserId]);

  useEffect(() => {
    let isMounted = true;
    void window.dolssh.updater.getState().then((state) => {
      if (isMounted) {
        setUpdateState(state);
      }
    });

    const offUpdater = window.dolssh.updater.onEvent((event) => {
      setUpdateState(event.state);
    });

    return () => {
      isMounted = false;
      offUpdater();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    void window.dolssh.window.getState().then((state) => {
      if (isMounted) {
        setWindowState(state);
      }
    });

    const offWindowState = window.dolssh.window.onStateChanged((state) => {
      setWindowState(state);
    });

    return () => {
      isMounted = false;
      offWindowState();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    media.addEventListener('change', handleChange);
    return () => {
      media.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    if (selectedHostId && !hosts.some((host) => host.id === selectedHostId)) {
      setSelectedHostId(null);
    }
  }, [hosts, selectedHostId]);

  const resolvedTheme = useMemo(() => resolveTheme(settings.theme, prefersDark), [prefersDark, settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = settings.theme;
    document.documentElement.dataset.platform = desktopPlatform;
  }, [desktopPlatform, resolvedTheme, settings.theme]);

  const isHomeActive = activeWorkspaceTab === 'home';
  const isSftpActive = activeWorkspaceTab === 'sftp';
  const activeSessionId = activeWorkspaceTab.startsWith('session:') ? activeWorkspaceTab.slice('session:'.length) : null;
  const activeWorkspace =
    activeWorkspaceTab.startsWith('workspace:')
      ? workspaces.find((workspace) => workspace.id === activeWorkspaceTab.slice('workspace:'.length)) ?? null
      : null;
  const isSessionViewActive = !isHomeActive && !isSftpActive;
  const editingHostId = hostDrawer.mode === 'edit' ? hostDrawer.hostId : null;
  const currentHost = findHost(hosts, editingHostId);
  const groupOptions = useMemo(
    () => buildGroupOptions(groups, hosts, [currentHost?.groupName, hostDrawer.mode === 'create' ? hostDrawer.defaultGroupPath : currentGroupPath]),
    [currentGroupPath, currentHost?.groupName, groups, hostDrawer, hosts]
  );
  const isDrawerOpen = isHomeActive && homeSection === 'hosts' && hostDrawer.mode !== 'closed';
  const highlightedHostId = editingHostId ?? selectedHostId;
  const hasActiveTransfers = sftp.transfers.some((job) => job.status === 'queued' || job.status === 'running');
  const hasActivePortForwards = portForwardRuntimes.some((runtime) => runtime.status === 'starting' || runtime.status === 'running');
  const hasBlockingUpdateInstall = tabs.length > 0 || hasActiveTransfers || hasActivePortForwards;

  const isAuthReady = authState.status === 'authenticated' && hydratedSessionUserId === authState.session?.user.id && !isSyncBootstrapping;
  const needsSyncRetry = authState.status === 'authenticated' && !isSyncBootstrapping && Boolean(syncBootstrapError);
  const adjacentDropCandidate =
    draggedSession?.source === 'standalone-tab'
      ? resolveAdjacentTabCandidate(tabStrip, workspaces, draggedSession.sessionId)
      : null;
  const canDropDraggedSession = Boolean(adjacentDropCandidate);

  useEffect(() => {
    if (pendingHostKeyPrompt?.sessionId) {
      const owningWorkspace = workspaces.find((workspace) => workspaceContainsSession(workspace, pendingHostKeyPrompt.sessionId!));
      if (owningWorkspace) {
        if (activeWorkspaceTab === `workspace:${owningWorkspace.id}` && owningWorkspace.activeSessionId === pendingHostKeyPrompt.sessionId) {
          return;
        }
        focusWorkspaceSession(owningWorkspace.id, pendingHostKeyPrompt.sessionId);
        return;
      }
      if (activeWorkspaceTab === `session:${pendingHostKeyPrompt.sessionId}`) {
        return;
      }
      activateSession(pendingHostKeyPrompt.sessionId);
    }
  }, [activateSession, activeWorkspaceTab, focusWorkspaceSession, pendingHostKeyPrompt?.sessionId, workspaces]);

  useEffect(() => {
    if (pendingCredentialRetry?.sessionId) {
      const owningWorkspace = workspaces.find((workspace) => workspaceContainsSession(workspace, pendingCredentialRetry.sessionId!));
      if (owningWorkspace) {
        if (activeWorkspaceTab === `workspace:${owningWorkspace.id}` && owningWorkspace.activeSessionId === pendingCredentialRetry.sessionId) {
          return;
        }
        focusWorkspaceSession(owningWorkspace.id, pendingCredentialRetry.sessionId);
        return;
      }
      if (activeWorkspaceTab === `session:${pendingCredentialRetry.sessionId}`) {
        return;
      }
      activateSession(pendingCredentialRetry.sessionId);
    }
  }, [activateSession, activeWorkspaceTab, focusWorkspaceSession, pendingCredentialRetry?.sessionId, workspaces]);

  if (!isAuthReady) {
    async function saveLoginServerUrl(nextServerUrl: string): Promise<void> {
      const nextSettings = await window.dolssh.settings.update({
        serverUrlOverride: nextServerUrl
      });
      appStore.setState({ settings: nextSettings });
    }

    async function resetLoginServerUrl(): Promise<void> {
      const nextSettings = await window.dolssh.settings.update({
        serverUrlOverride: null
      });
      appStore.setState({ settings: nextSettings });
    }

    return (
      <div className="app-frame app-frame--login">
        <div className="login-window-chrome">
          <div className="login-window-chrome__spacer" />
          <DesktopWindowControls
            desktopPlatform={desktopPlatform}
            windowState={windowState}
            onMinimizeWindow={async () => {
              await window.dolssh.window.minimize();
            }}
            onMaximizeWindow={async () => {
              await window.dolssh.window.maximize();
            }}
            onRestoreWindow={async () => {
              await window.dolssh.window.restore();
            }}
            onCloseWindow={async () => {
              await window.dolssh.window.close();
            }}
          />
        </div>
        <LoginGate
          authState={
            needsSyncRetry
              ? {
                  ...authState,
                  errorMessage: syncBootstrapError
                }
              : authState
          }
          isSyncBootstrapping={isSyncBootstrapping}
          serverUrl={settings.serverUrl}
          hasServerUrlOverride={Boolean(settings.serverUrlOverride)}
          isLoadingServerUrl={isLoginServerSettingsLoading}
          onBeginLogin={async () => {
            await window.dolssh.auth.beginBrowserLogin();
          }}
          onSaveServerUrl={saveLoginServerUrl}
          onResetServerUrl={resetLoginServerUrl}
          actionLabel={needsSyncRetry ? '동기화 다시 시도' : undefined}
          onAction={
            needsSyncRetry
              ? async () => {
                  if (authState.status === 'authenticated') {
                    await hydrateAuthenticatedWorkspace(authState);
                  }
                }
              : undefined
          }
        />
      </div>
    );
  }

  function handleSelectHost(hostId: string) {
    setHostBrowserError(null);
    setHostBrowserStatus(null);
    setSelectedHostId(hostId);
    if (hostDrawer.mode === 'edit') {
      openEditHostDrawer(hostId);
    }
  }

  function handleEditHost(hostId: string) {
    setHostBrowserError(null);
    setHostBrowserStatus(null);
    setSelectedHostId(hostId);
    openEditHostDrawer(hostId);
  }

  async function runUpdaterAction(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      setUpdateState((current) => ({
        ...current,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '업데이트 작업 중 오류가 발생했습니다.'
      }));
    }
  }

  async function handleInstallUpdate() {
    if (hasBlockingUpdateInstall) {
      setIsUpdateInstallConfirmOpen(true);
      return;
    }

    await runUpdaterAction(() => window.dolssh.updater.installAndRestart());
  }

  function openHostSecretEditor(secretRef: string, credentialKind: SecretCredentialKind) {
    if (!currentHost || !isSshHostRecord(currentHost)) {
      return;
    }

    const entry = keychainEntries.find((item) => item.secretRef === secretRef);
    setSecretEditRequest({
      source: 'host',
      secretRef,
      label: entry?.label ?? currentHost.label,
      credentialKind,
      linkedHosts: hosts
        .filter(isSshHostRecord)
        .filter((host) => getHostSecretRef(host) === secretRef)
        .map(toLinkedHostSummary),
      initialMode: 'clone-for-host',
      initialHostId: currentHost.id
    });
  }

  function openKeychainSecretEditor(secretRef: string, credentialKind: SecretCredentialKind) {
    const entry = keychainEntries.find((item) => item.secretRef === secretRef);
    if (!entry) {
      return;
    }

    setSecretEditRequest({
      source: 'keychain',
      secretRef,
      label: entry.label,
      credentialKind,
      linkedHosts: hosts
        .filter(isSshHostRecord)
        .filter((host) => getHostSecretRef(host) === secretRef)
        .map(toLinkedHostSummary),
      initialMode: 'update-shared',
      initialHostId: null
    });
  }

  async function handleRemoveSecret(secretRef: string) {
    const entry = keychainEntries.find((item) => item.secretRef === secretRef);
    const linkedHostCount = entry?.linkedHostCount ?? 0;
    const confirmed = window.confirm(
      linkedHostCount > 0
        ? `이 secret을 삭제하면 ${linkedHostCount}개 호스트와의 키체인 연결이 해제됩니다. 호스트 자체는 삭제되지 않습니다. 계속할까요?`
        : '이 secret을 삭제할까요?'
    );
    if (!confirmed) {
      return;
    }
    await removeKeychainSecret(secretRef);
  }

  return (
    <div className={`app-frame ${isHomeActive ? 'home-active' : 'session-active'}`}>
      <AppTitleBar
        desktopPlatform={desktopPlatform}
        tabs={tabs}
        workspaces={workspaces}
        tabStrip={tabStrip}
        activeWorkspaceTab={activeWorkspaceTab}
        draggedSession={draggedSession}
        updateState={updateState}
        windowState={windowState}
        onSelectHome={activateHome}
        onSelectSftp={activateSftp}
        onSelectSession={activateSession}
        onSelectWorkspace={activateWorkspace}
        onCloseSession={disconnectTab}
        onCloseWorkspace={closeWorkspace}
        onStartSessionDrag={(sessionId) => {
          setDraggedSession({
            sessionId,
            source: 'standalone-tab'
          });
        }}
        onEndSessionDrag={() => {
          setDraggedSession(null);
        }}
        onDetachSessionToStandalone={(workspaceId, sessionId) => {
          detachSessionFromWorkspace(workspaceId, sessionId);
        }}
        onReorderDynamicTab={reorderDynamicTab}
        onCheckForUpdates={async () => runUpdaterAction(() => window.dolssh.updater.check())}
        onDownloadUpdate={async () => runUpdaterAction(() => window.dolssh.updater.download())}
        onInstallUpdate={handleInstallUpdate}
        onDismissUpdate={async (version) => {
          await runUpdaterAction(() => window.dolssh.updater.dismissAvailable(version));
        }}
        onOpenReleasePage={async (url) => {
          await runUpdaterAction(() => window.dolssh.shell.openExternal(url));
        }}
        onMinimizeWindow={async () => {
          await window.dolssh.window.minimize();
        }}
        onMaximizeWindow={async () => {
          await window.dolssh.window.maximize();
        }}
        onRestoreWindow={async () => {
          await window.dolssh.window.restore();
        }}
        onCloseWindow={async () => {
          await window.dolssh.window.close();
        }}
      />

      <div className="workspace-shell">
        <section className={`home-shell ${isHomeActive ? 'active' : 'hidden'} ${isDrawerOpen ? 'drawer-open' : ''}`}>
          <HomeNavigation activeSection={homeSection} onSelectSection={openHomeSection} />

          <main className="home-main">
            {homeSection === 'hosts' ? (
              <HostBrowser
                hosts={hosts}
                groups={groups}
                currentGroupPath={currentGroupPath}
                searchQuery={searchQuery}
                selectedHostId={highlightedHostId}
                errorMessage={hostBrowserError}
                statusMessage={hostBrowserStatus}
                onSearchChange={setSearchQuery}
                onOpenLocalTerminal={() => {
                  setHostBrowserError(null);
                  setHostBrowserStatus(null);
                  setSelectedHostId(null);
                  void openLocalTerminal(120, 32).catch((error) => {
                    setHostBrowserError(error instanceof Error ? error.message : '로컬 터미널을 시작하지 못했습니다.');
                  });
                }}
                onCreateHost={() => {
                  setHostBrowserError(null);
                  setHostBrowserStatus(null);
                  setSelectedHostId(null);
                  openCreateHostDrawer();
                }}
                onOpenAwsImport={() => {
                  setHostBrowserError(null);
                  setHostBrowserStatus(null);
                  setSelectedHostId(null);
                  setIsAwsImportOpen(true);
                }}
                onOpenTermiusImport={() => {
                  setHostBrowserError(null);
                  setHostBrowserStatus(null);
                  setSelectedHostId(null);
                  setIsTermiusImportOpen(true);
                }}
                onOpenWarpgateImport={() => {
                  setHostBrowserError(null);
                  setHostBrowserStatus(null);
                  setSelectedHostId(null);
                  setIsWarpgateImportOpen(true);
                }}
                onCreateGroup={createGroup}
                onRemoveGroup={removeGroup}
                onNavigateGroup={(path) => {
                  setHostBrowserError(null);
                  setHostBrowserStatus(null);
                  setSelectedHostId(null);
                  navigateGroup(path);
                }}
                onSelectHost={handleSelectHost}
                onEditHost={handleEditHost}
                onMoveHostToGroup={moveHostToGroup}
                onRemoveHost={removeHost}
                onConnectHost={async (hostId) => {
                  try {
                    setHostBrowserError(null);
                    setSelectedHostId(hostId);
                    await connectHost(hostId, 120, 32);
                  } catch (error) {
                    setHostBrowserError(error instanceof Error ? error.message : '호스트 연결을 시작하지 못했습니다.');
                  }
                }}
              />
            ) : null}

            {homeSection === 'portForwarding' ? (
              <PortForwardingPanel
                hosts={hosts}
                rules={portForwards}
                runtimes={portForwardRuntimes}
                onSave={savePortForward}
                onRemove={removePortForward}
                onStart={startPortForward}
                onStop={stopPortForward}
              />
            ) : null}

            {homeSection === 'knownHosts' ? <KnownHostsPanel records={knownHosts} onRemove={removeKnownHost} /> : null}

            {homeSection === 'logs' ? <LogsPanel logs={activityLogs} onClear={clearLogs} /> : null}

            {homeSection === 'keychain' ? (
              <KeychainPanel entries={keychainEntries} onRemoveSecret={handleRemoveSecret} onEditSecret={openKeychainSecretEditor} />
            ) : null}

            {homeSection === 'settings' ? (
              <SettingsPanel
                settings={settings}
                desktopPlatform={desktopPlatform}
                onUpdateSettings={updateSettings}
                onLogout={async () => {
                  await window.dolssh.auth.logout();
                }}
              />
            ) : null}
          </main>

          <HostDrawer
            open={isDrawerOpen}
            mode={hostDrawer.mode === 'create' ? 'create' : 'edit'}
            host={currentHost}
            keychainEntries={keychainEntries}
            groupOptions={groupOptions}
            defaultGroupPath={hostDrawer.mode === 'create' ? hostDrawer.defaultGroupPath : currentGroupPath}
            onClose={closeHostDrawer}
            onSubmit={async (draft, secrets) => {
              await saveHost(hostDrawer.mode === 'edit' ? currentHost?.id ?? null : null, draft, secrets);
            }}
            onEditExistingSecret={openHostSecretEditor}
            onDelete={
              currentHost
                ? async () => {
                    await removeHost(currentHost.id);
                    setSelectedHostId(null);
                    closeHostDrawer();
                  }
                : undefined
            }
          />

          <AwsImportDialog
            open={isAwsImportOpen}
            currentGroupPath={currentGroupPath}
            onClose={() => setIsAwsImportOpen(false)}
            onImport={async (draft) => {
              await saveHost(null, draft);
            }}
          />

          <TermiusImportDialog
            open={isTermiusImportOpen}
            onClose={() => setIsTermiusImportOpen(false)}
            onImported={async (result) => {
              await refreshHostCatalog();
              setHostBrowserStatus(
                `Termius에서 ${result.createdHostCount}개 호스트, ${result.createdGroupCount}개 그룹, ${result.createdSecretCount}개 secret을 가져왔습니다.${result.skippedHostCount > 0 ? ` 기존/불완전 호스트 ${result.skippedHostCount}개는 건너뛰었습니다.` : ''}`
              );
              setHostBrowserError(result.warnings[0]?.message ?? null);
            }}
          />

          <WarpgateImportDialog
            open={isWarpgateImportOpen}
            currentGroupPath={currentGroupPath}
            onClose={() => setIsWarpgateImportOpen(false)}
            onImport={async (draft) => {
              await saveHost(null, draft);
            }}
          />
        </section>

        <section className={`sftp-shell ${isSftpActive ? 'active' : 'hidden'}`}>
          <SftpWorkspace
            hosts={hosts}
            groups={groups}
            sftp={sftp}
            onActivatePaneSource={setSftpPaneSource}
            onPaneFilterChange={setSftpPaneFilter}
            onHostSearchChange={setSftpHostSearchQuery}
            onNavigateHostGroup={navigateSftpHostGroup}
            onSelectHost={selectSftpHost}
            onConnectHost={connectSftpHost}
            onOpenEntry={openSftpEntry}
            onRefreshPane={refreshSftpPane}
            onNavigateBack={navigateSftpBack}
            onNavigateForward={navigateSftpForward}
            onNavigateParent={navigateSftpParent}
            onNavigateBreadcrumb={navigateSftpBreadcrumb}
            onSelectEntry={selectSftpEntry}
            onCreateDirectory={createSftpDirectory}
            onRenameSelection={renameSftpSelection}
            onChangeSelectionPermissions={changeSftpSelectionPermissions}
            onDeleteSelection={deleteSftpSelection}
            onDownloadSelection={downloadSftpSelection}
            onPrepareTransfer={prepareSftpTransfer}
            onPrepareExternalTransfer={prepareSftpExternalTransfer}
            onTransferSelectionToPane={transferSftpSelectionToPane}
            onResolveConflict={resolveSftpConflict}
            onDismissConflict={dismissSftpConflict}
            onCancelTransfer={cancelTransfer}
            onRetryTransfer={retryTransfer}
            onDismissTransfer={dismissTransfer}
          />
        </section>

        <section className={`session-shell ${isSessionViewActive ? 'active' : 'hidden'}`}>
          <TerminalWorkspace
            tabs={tabs}
            hosts={hosts}
            settings={settings}
            activeSessionId={activeSessionId}
            activeWorkspace={activeWorkspace}
            draggedSession={draggedSession}
            canDropDraggedSession={canDropDraggedSession}
            onCloseSession={disconnectTab}
            onRetryConnection={retrySessionConnection}
            onStartSessionShare={startSessionShare}
            onUpdateSessionShareSnapshot={updateSessionShareSnapshot}
            onSetSessionShareInputEnabled={setSessionShareInputEnabled}
            onStopSessionShare={stopSessionShare}
            onStartPaneDrag={(workspaceId, sessionId) => {
              setDraggedSession({
                sessionId,
                source: 'workspace-pane',
                workspaceId
              });
            }}
            onEndSessionDrag={() => {
              setDraggedSession(null);
            }}
            onSplitSessionDrop={(sessionId, direction, targetSessionId) =>
              splitSessionIntoWorkspace(sessionId, direction, targetSessionId)
            }
            onFocusWorkspaceSession={focusWorkspaceSession}
            onResizeWorkspaceSplit={resizeWorkspaceSplit}
          />
        </section>
      </div>

      <KnownHostPromptDialog pending={pendingHostKeyPrompt} onAccept={acceptPendingHostKeyPrompt} onCancel={dismissPendingHostKeyPrompt} />

      <CredentialRetryDialog
        request={
          pendingCredentialRetry
            ? {
                ...pendingCredentialRetry,
                hostLabel: findHost(hosts, pendingCredentialRetry.hostId)?.label ?? 'Host'
              }
            : null
        }
        onClose={dismissPendingCredentialRetry}
        onSubmit={submitCredentialRetry}
      />

      <SecretEditDialog
        request={secretEditRequest}
        onClose={() => setSecretEditRequest(null)}
        onSubmit={async (input) => {
          if (input.mode === 'update-shared') {
            await updateKeychainSecret(input.secretRef, input.secrets);
            return;
          }
          if (!input.hostId) {
            throw new Error('대상 호스트를 선택해 주세요.');
          }
          await cloneKeychainSecretForHost(input.hostId, input.secretRef, input.secrets);
        }}
      />

      {isUpdateInstallConfirmOpen ? (
        <div className="modal-backdrop">
          <div className="modal-card update-install-dialog" role="dialog" aria-modal="true" aria-labelledby="update-install-title">
            <div className="modal-card__header">
              <div>
                <div className="eyebrow">Update Ready</div>
                <h3 id="update-install-title">업데이트를 적용하려면 재시작이 필요합니다.</h3>
              </div>
            </div>
            <div className="modal-card__body">
              <p className="update-install-dialog__message">
                현재 열려 있는 SSH 세션, 진행 중인 전송, 활성 포트 포워딩은 모두 종료됩니다. 계속하면 dolssh가 정리 후 재시작되며 새 버전이
                적용됩니다.
              </p>
            </div>
            <div className="modal-card__footer">
              <button type="button" className="secondary-button" onClick={() => setIsUpdateInstallConfirmOpen(false)}>
                취소
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={async () => {
                  setIsUpdateInstallConfirmOpen(false);
                  await runUpdaterAction(() => window.dolssh.updater.installAndRestart());
                }}
              >
                재시작 후 업데이트
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
