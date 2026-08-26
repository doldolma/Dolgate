import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const mocks = vi.hoisted(() => ({
  storeState: {} as any,
  desktopApi: null as any,
  appStoreSetState: vi.fn(),
  loginGateProps: [] as any[],
  terminalWorkspaceProps: [] as any[],
  containersWorkspaceProps: [] as any[],
  awsEcsWorkspaceProps: [] as any[],
}));

function stubComponent(testId: string) {
  return function StubComponent() {
    return <div data-testid={testId} />;
  };
}

vi.mock('./store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(mocks.storeState),
  get desktopApi() {
    return mocks.desktopApi;
  },
  appStore: {
    setState: mocks.appStoreSetState,
  },
}));

vi.mock('./components/AppTitleBar', () => ({ AppTitleBar: stubComponent('app-title-bar') }));
vi.mock('./components/AwsImportDialog', () => ({ AwsImportDialog: stubComponent('aws-import-dialog') }));
vi.mock('./components/AwsEcsWorkspace', () => ({
  AwsEcsWorkspace: (props: any) => {
    mocks.awsEcsWorkspaceProps.push(props);
    return <div data-testid="aws-ecs-workspace" />;
  },
}));
vi.mock('./components/CredentialRetryDialog', () => ({
  CredentialRetryDialog: stubComponent('credential-retry-dialog'),
}));
vi.mock('./components/HostBrowser', () => ({ HostBrowser: stubComponent('host-browser') }));
vi.mock('./components/HostDrawer', () => ({ HostDrawer: stubComponent('host-drawer') }));
vi.mock('./components/KnownHostPromptDialog', () => ({
  KnownHostPromptDialog: stubComponent('known-host-prompt'),
}));
vi.mock('./components/LogsPanel', () => ({ LogsPanel: stubComponent('logs-panel') }));
vi.mock('./components/DesktopWindowControls', () => ({
  DesktopWindowControls: stubComponent('desktop-window-controls'),
}));
vi.mock('./components/ContainersWorkspace', () => ({
  ContainersWorkspace: (props: any) => {
    mocks.containersWorkspaceProps.push(props);
    return <div data-testid="containers-workspace" />;
  },
}));
vi.mock('./components/OpenSshImportDialog', () => ({
  OpenSshImportDialog: stubComponent('openssh-import-dialog'),
}));
vi.mock('./components/PortForwardingPanel', () => ({
  PortForwardingPanel: stubComponent('port-forwarding-panel'),
}));
vi.mock('./components/SecretEditDialog', () => ({
  SecretEditDialog: stubComponent('secret-edit-dialog'),
}));
vi.mock('./components/SettingsPanel', () => ({
  SettingsPanel: stubComponent('settings-panel'),
}));
vi.mock('./components/SftpWorkspace', () => ({
  SftpWorkspace: stubComponent('sftp-workspace'),
}));
vi.mock('./components/RemoteFileEditorModal', () => ({
  RemoteFileEditorModal: stubComponent('remote-file-editor-modal'),
}));
vi.mock('./components/TermiusImportDialog', () => ({
  TermiusImportDialog: stubComponent('termius-import-dialog'),
}));
vi.mock('./components/UpdateInstallConfirmDialog', () => ({
  UpdateInstallConfirmDialog: stubComponent('update-install-confirm-dialog'),
}));
vi.mock('./components/WarpgateImportDialog', () => ({
  WarpgateImportDialog: stubComponent('warpgate-import-dialog'),
}));
vi.mock('./components/XshellImportDialog', () => ({
  XshellImportDialog: stubComponent('xshell-import-dialog'),
}));

vi.mock('./components/LoginGate', () => ({
  LoginGate: (props: any) => {
    mocks.loginGateProps.push(props);
    return <div data-testid="login-gate">{props.authState.status}</div>;
  },
}));

vi.mock('./components/TerminalWorkspace', () => ({
  TerminalWorkspace: (props: any) => {
    mocks.terminalWorkspaceProps.push(props);
    return <div data-testid="terminal-workspace" />;
  },
}));

function createMockStoreState(overrides: Record<string, unknown> = {}) {
  const fn = () => vi.fn();
  return {
    hosts: [],
    groups: [],
    tabs: [
      {
        id: 'tab-1',
        sessionId: 'session-1',
        source: 'local',
        hostId: null,
        title: 'Session 1',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2026-03-28T00:00:00.000Z',
      },
    ],
    sessionShareChatNotifications: {},
    // 세션 패널(오른쪽) 상태. 접힌 상태로 시작하므로 목록은 읽지 않는다.
    sessionPanelOpen: false,
    sessionPanelWidth: 340,
    sessionPanelSectionBySessionId: {},
    toggleSessionPanel: fn(),
    setSessionPanelWidth: fn(),
    selectSessionPanelSection: fn(),
    toggleSessionPanelSection: fn(),
    workspaces: [],
    containerTabs: [],
    activeContainerHostId: null,
    tabStrip: [{ kind: 'session', sessionId: 'session-1' }],
    portForwards: [],
    dnsOverrides: [],
    portForwardRuntimes: [],
    knownHosts: [],
    activityLogs: [],
    keychainEntries: [],
    activeWorkspaceTab: 'session:session-1',
    homeSection: 'hosts',
    settingsSection: 'general',
    savedCredentialsSearchQuery: '',
    hostDrawer: { mode: 'closed' },
    currentGroupPath: null,
    searchQuery: '',
    settings: {
      theme: 'system',
      globalTerminalThemeId: 'dolssh-dark',
      terminalFontFamily: 'sf-mono',
      terminalFontSize: 13,
      terminalScrollbackLines: 5000,
      terminalLineHeight: 1,
      terminalLetterSpacing: 0,
      terminalMinimumContrastRatio: 1,
      terminalAltIsMeta: false,
      terminalWebglEnabled: true,
      sftpBrowserColumnWidths: {
        name: 360,
        dateModified: 168,
        size: 96,
        kind: 96,
      },
      sessionReplayRetentionCount: 100,
      serverUrl: 'https://example.test',
      serverUrlOverride: null,
      updatedAt: '2026-03-28T00:00:00.000Z',
    },
    pendingHostKeyPrompt: null,
    pendingCredentialRetry: null,
    activeCredentialRetryAttempt: null,
    pendingAwsSftpConfigRetry: null,
    pendingInteractiveAuths: [],
    sftp: {
      localHomePath: '/',
      leftPane: null,
      rightPane: null,
      transfers: [],
    pendingConflictDialog: null,
    },
    bootstrap: fn(),
    refreshHostCatalog: fn(),
    refreshSyncedWorkspaceData: fn(),
    clearSyncedWorkspaceData: fn(),
    setSearchQuery: fn(),
    setSavedCredentialsSearchQuery: fn(),
    activateHome: fn(),
    activateSession: fn(),
    activateWorkspace: fn(),
    activateContainers: fn(),
    focusHostContainersTab: fn(),
    openHomeSection: fn(),
    openSettingsSection: fn(),
    openCreateHostDrawer: fn(),
    openEditHostDrawer: fn(),
    closeHostDrawer: fn(),
    navigateGroup: fn(),
    createGroup: fn(),
    removeGroup: fn(),
    moveGroup: fn(),
    renameGroup: fn(),
    saveHost: fn(),
    duplicateHosts: fn(),
    moveHostToGroup: fn(),
    removeHost: fn(),
    openLocalTerminal: fn(),
    connectHost: fn(),
    retrySessionConnection: fn(),
    startSessionShare: fn(),
    updateSessionShareSnapshot: fn(),
    setSessionShareInputEnabled: fn(),
    stopSessionShare: fn(),
    disconnectTab: fn(),
    closeWorkspace: fn(),
    openHostContainersTab: fn(),
    closeHostContainersTab: fn(),
    reorderContainerTab: fn(),
    refreshHostContainers: fn(),
    refreshEcsClusterUtilization: fn(),
    openEcsExecShell: fn(),
    selectHostContainer: fn(),
    setHostContainersPanel: fn(),
    refreshHostContainerLogs: fn(),
    setHostContainerLogsFollow: fn(),
    openHostContainerShell: fn(),
    splitSessionIntoWorkspace: fn(),
    moveWorkspaceSession: fn(),
    detachSessionFromWorkspace: fn(),
    reorderDynamicTab: fn(),
    focusWorkspaceSession: fn(),
    tmuxNewWindowInWorkspace: fn(),
    toggleSessionBroadcast: fn(),
    resizeWorkspaceSplit: fn(),
    activateSftp: fn(),
    loadSettings: vi.fn().mockResolvedValue(undefined),
    updateSettings: fn(),
    savePortForward: fn(),
    saveDnsOverride: fn(),
    setStaticDnsOverrideActive: fn(),
    removeDnsOverride: fn(),
    removePortForward: fn(),
    startPortForward: fn(),
    stopPortForward: fn(),
    removeKnownHost: fn(),
    clearLogs: fn(),
    removeKeychainSecret: fn(),
    updateKeychainSecret: fn(),
    cloneKeychainSecretForHost: fn(),
    generateSshKey: fn(),
    copySshPublicKey: fn(),
    installSshPublicKey: fn(),
    acceptPendingHostKeyPrompt: fn(),
    dismissPendingHostKeyPrompt: fn(),
    dismissPendingCredentialRetry: fn(),
    submitCredentialRetry: fn(),
    dismissPendingAwsSftpConfigRetry: fn(),
    submitAwsSftpConfigRetry: fn(),
    respondInteractiveAuth: fn(),
    reopenInteractiveAuthUrl: fn(),
    clearPendingInteractiveAuth: fn(),
    handleCoreEvent: fn(),
    handleContainerConnectionProgressEvent: fn(),
    handleSftpConnectionProgressEvent: fn(),
    handleTransferEvent: fn(),
    handlePortForwardEvent: fn(),
    handleSessionShareEvent: fn(),
    setSftpPaneSource: fn(),
    disconnectSftpPane: fn(),
    setSftpPaneFilter: fn(),
    setSftpHostSearchQuery: fn(),
    navigateSftpHostGroup: fn(),
    selectSftpHost: fn(),
    connectSftpHost: fn(),
    openSftpEntry: fn(),
    refreshSftpPane: fn(),
    navigateSftpBack: fn(),
    navigateSftpForward: fn(),
    navigateSftpParent: fn(),
    navigateSftpBreadcrumb: fn(),
    selectSftpEntry: fn(),
    createSftpDirectory: fn(),
    renameSftpSelection: fn(),
    changeSftpSelectionPermissions: fn(),
    deleteSftpSelection: fn(),
    downloadSftpSelection: fn(),
    prepareSftpTransfer: fn(),
    prepareSftpExternalTransfer: fn(),
    transferSftpSelectionToPane: fn(),
    resolveSftpConflict: fn(),
    dismissSftpConflict: fn(),
    cancelTransfer: fn(),
    retryTransfer: fn(),
    dismissTransfer: fn(),
    handleSessionShareChatEvent: fn(),
    ...overrides,
  };
}

function createDolsshApi(options: {
  authBootstrapState?: any;
  authGetStateState?: any;
  syncBootstrapError?: Error | null;
  includeSessionShareChatEvent?: boolean;
}) {
  const listeners = {
    auth: null as ((state: any) => void) | null,
  };
  const off = {
    core: vi.fn(),
    containersProgress: vi.fn(),
    logsChanged: vi.fn(),
    transfer: vi.fn(),
    forward: vi.fn(),
    sessionShare: vi.fn(),
    sessionShareChat: vi.fn(),
    auth: vi.fn(),
    updater: vi.fn(),
    windowState: vi.fn(),
    zoom: vi.fn(),
  };

  const api: any = {
    __listeners: listeners,
    __off: off,
    ssh: {
      onEvent: vi.fn(() => off.core),
    },
    rdp: {
      onEvent: vi.fn(() => vi.fn()),
    },
    vnc: {
      onEvent: vi.fn(() => vi.fn()),
    },
    containers: {
      onConnectionProgress: vi.fn(() => off.containersProgress),
    },
    logs: {
      onChanged: vi.fn(() => off.logsChanged),
    },
    sftp: {
      onConnectionProgress: vi.fn(() => vi.fn()),
      onTransferEvent: vi.fn(() => off.transfer),
    },
    portForwards: {
      onEvent: vi.fn(() => off.forward),
    },
    sessionShares: {
      onEvent: vi.fn(() => off.sessionShare),
      onChatEvent: options.includeSessionShareChatEvent === false ? undefined : vi.fn(() => off.sessionShareChat),
      openOwnerChatWindow: vi.fn().mockResolvedValue(undefined),
    },
    auth: {
      bootstrap: vi.fn().mockResolvedValue(
        options.authBootstrapState ?? {
          status: 'authenticated',
          session: { user: { id: 'user-1', email: 'user@example.com' } },
          offline: null,
          errorMessage: null,
        },
      ),
      getState: vi.fn().mockResolvedValue(
        options.authGetStateState ?? {
          status: 'authenticated',
          session: { user: { id: 'user-1', email: 'user@example.com' } },
          offline: null,
          errorMessage: null,
        },
      ),
      retryOnline: vi.fn().mockResolvedValue(undefined),
      beginBrowserLogin: vi.fn().mockResolvedValue(undefined),
      reopenBrowserLogin: vi.fn().mockResolvedValue(undefined),
      cancelBrowserLogin: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn((listener: (state: any) => void) => {
        listeners.auth = listener;
        return off.auth;
      }),
    },
    sync: {
      bootstrap:
        options.syncBootstrapError == null
          ? vi.fn().mockResolvedValue({
              status: 'ready',
              lastSuccessfulSyncAt: '2026-03-28T00:00:00.000Z',
              pendingPush: false,
              errorMessage: null,
            })
          : vi.fn().mockRejectedValue(options.syncBootstrapError),
    },
    updater: {
      getState: vi.fn().mockResolvedValue({
        enabled: false,
        status: 'idle',
        currentVersion: '1.0.0',
        dismissedVersion: null,
        release: null,
        progress: null,
        checkedAt: null,
        errorMessage: null,
      }),
      onEvent: vi.fn(() => off.updater),
    },
    window: {
      getState: vi.fn().mockResolvedValue({ isMaximized: false }),
      onStateChanged: vi.fn(() => off.windowState),
      onZoomChanged: vi.fn(() => off.zoom),
      consumeLaunchIntent: vi.fn().mockResolvedValue(null),
      minimize: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    settings: {
      get: vi.fn().mockResolvedValue(createMockStoreState().settings),
      update: vi.fn().mockResolvedValue(createMockStoreState().settings),
    },
    shell: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    tailnet: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      cancel: vi.fn(),
      disconnect: vi.fn(),
      forget: vi.fn(),
      snapshot: vi.fn().mockResolvedValue({ statuses: [] }),
      onStatus: vi.fn(() => () => undefined),
    },
  };

  return api;
}

describe('App integration', () => {
  beforeEach(() => {
    mocks.loginGateProps.length = 0;
    mocks.terminalWorkspaceProps.length = 0;
    mocks.containersWorkspaceProps.length = 0;
    mocks.awsEcsWorkspaceProps.length = 0;
    mocks.appStoreSetState.mockReset();
    mocks.storeState = createMockStoreState();
    mocks.desktopApi = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      writable: true,
      value: vi.fn(() => true),
    });
  });

  it('hydrates the authenticated workspace and mounts safely without duplicate crashes', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    render(<App />);

    await waitFor(() => {
      expect(mocks.storeState.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.sync.bootstrap).toHaveBeenCalledTimes(1);
      expect(mocks.storeState.refreshSyncedWorkspaceData).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
    });
  });

  // 계정 없이 쓰는 상태로 켜면 로그인 화면 대신 워크스페이스가 뜬다. 그리고 **올리고 내릴 곳이
  // 없으므로** 로컬 부트스트랩만 돈다 — 동기화를 건드리면 볼트가 없다고 멈춰 서서, 신경 쓸 것이
  // 없는 사람의 화면에 동기화 상태가 뜬다.
  it('계정 없이 쓰는 상태로 켜면 동기화 없이 워크스페이스를 연다', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'local-only',
        session: null,
        offline: null,
        errorMessage: null,
      },
      authGetStateState: {
        status: 'local-only',
        session: null,
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    render(<App />);

    await waitFor(() => {
      expect(mocks.storeState.bootstrap).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
    });
    expect(api.sync.bootstrap).not.toHaveBeenCalled();
  });

  // 계정 없이 쓰다가 로그인을 시작하면 상태가 'authenticating' 이 된다. 그때 워크스페이스를
  // 내리면 열어 둔 터미널이 통째로 사라진다 — 로그인 창은 그 위에 떠 있는 것이다.
  it('계정 없이 쓰다가 로그인을 시작해도 워크스페이스를 내리지 않는다', async () => {
    const localOnly = {
      status: 'local-only',
      session: null,
      offline: null,
      errorMessage: null,
    };
    const api = createDolsshApi({
      authBootstrapState: localOnly,
      authGetStateState: localOnly,
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
    });

    // 브라우저 로그인이 시작된 것과 같다.
    await act(async () => {
      api.__listeners.auth?.({
        status: 'authenticating',
        session: null,
        offline: null,
        errorMessage: null,
      });
    });

    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
  });

  it('connects the requested host after a new window finishes authentication', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    api.window.consumeLaunchIntent.mockResolvedValue({
      type: 'connect-host',
      hostId: 'host-new-window',
    });
    mocks.desktopApi = api;

    render(<App />);

    await waitFor(() => {
      expect(api.window.consumeLaunchIntent).toHaveBeenCalledTimes(1);
      expect(mocks.storeState.connectHost).toHaveBeenCalledWith(
        'host-new-window',
        120,
        32,
      );
    });
  });

  it('keeps other workspace shells mounted in the background while the session view is active', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;
    mocks.storeState = createMockStoreState({
      activeWorkspaceTab: 'session:session-1',
      hosts: [
        {
          id: 'host-1',
          kind: 'ssh',
          label: 'Prod',
          hostname: 'prod.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: 'host:host-1',
          groupName: 'Servers',
          tags: [],
          terminalThemeId: null,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
        },
      ],
      containerTabs: [
        {
          hostId: 'host-1',
          title: 'Prod · Containers',
          runtime: 'docker',
          unsupportedReason: null,
          connectionProgress: null,
          items: [],
          selectedContainerId: null,
          activePanel: 'overview',
          isLoading: false,
          details: null,
          detailsLoading: false,
          logs: null,
          logsState: 'idle',
          logsLoading: false,
          logsFollowEnabled: false,
        },
      ],
      activeContainerHostId: 'host-1',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
    });

    expect(screen.getByTestId('host-browser')).toBeInTheDocument();
    expect(screen.getByTestId('sftp-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('containers-workspace')).toBeInTheDocument();
    expect(mocks.containersWorkspaceProps.at(-1)).toMatchObject({
      isActive: false,
    });
  });

  it('keeps the terminal workspace mounted while SFTP is active', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;
    mocks.storeState = createMockStoreState({
      activeWorkspaceTab: 'sftp',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('sftp-workspace')).toBeInTheDocument();
    });

    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
  });

  it('keeps the terminal workspace mounted in the background when a session share is active', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;
    mocks.storeState = createMockStoreState({
      activeWorkspaceTab: 'sftp',
      tabs: [
        {
          id: 'tab-1',
          sessionId: 'session-1',
          source: 'local',
          hostId: null,
          title: 'Session 1',
          status: 'connected',
          sessionShare: {
            status: 'active',
            shareUrl: 'https://example.test/share/session-1',
            inputEnabled: true,
            viewerCount: 1,
          },
          hasReceivedOutput: true,
          lastEventAt: '2026-03-28T00:00:00.000Z',
        },
      ],
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('sftp-workspace')).toBeInTheDocument();
    });

    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
  });

  it('rehydrates synced workspace data after logging back in from the login gate', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'unauthenticated',
        session: null,
        offline: null,
        errorMessage: null,
      },
      authGetStateState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    render(<App />);
    await screen.findByTestId('login-gate');

    await act(async () => {
      api.__listeners.auth?.({
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      });
    });

    await waitFor(() => {
      expect(mocks.storeState.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.sync.bootstrap).toHaveBeenCalledTimes(1);
      expect(mocks.storeState.refreshSyncedWorkspaceData).toHaveBeenCalledTimes(1);
    });
  });

  it('refreshes synced workspace data without re-running local bootstrap when offline auth returns online', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'offline-authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: {
          token: 'offline-token',
          issuedAt: '2026-03-28T00:00:00.000Z',
          expiresAt: '2026-03-30T00:00:00.000Z',
          verificationPublicKeyPem: 'pubkey',
        },
        errorMessage: null,
      },
      authGetStateState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    render(<App />);

    await waitFor(() => {
      expect(mocks.storeState.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.sync.bootstrap).toHaveBeenCalledTimes(0);
    });

    await act(async () => {
      api.__listeners.auth?.({
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      });
    });

    await waitFor(() => {
      expect(mocks.storeState.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.sync.bootstrap).toHaveBeenCalledTimes(1);
      expect(mocks.storeState.refreshSyncedWorkspaceData).toHaveBeenCalledTimes(1);
    });
  });

  it('renders the containers section when the fixed containers tab is active', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;
    mocks.storeState = createMockStoreState({
      hosts: [
        {
          id: 'host-1',
          kind: 'ssh',
          label: 'Prod',
          hostname: 'prod.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: 'host:host-1',
          groupName: 'Servers',
          tags: [],
          terminalThemeId: null,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
        },
      ],
      containerTabs: [
        {
          hostId: 'host-1',
          title: 'Prod · Containers',
          runtime: 'docker',
          unsupportedReason: null,
          connectionProgress: null,
          items: [],
          selectedContainerId: null,
          activePanel: 'overview',
          isLoading: false,
          details: null,
          detailsLoading: false,
          logs: null,
          logsState: 'idle',
          logsLoading: false,
          logsFollowEnabled: false,
        },
      ],
      activeContainerHostId: 'host-1',
      activeWorkspaceTab: 'containers',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('containers-workspace')).toBeInTheDocument();
    });
    expect(mocks.containersWorkspaceProps.at(-1)).toMatchObject({
      isActive: true,
    });
  });

  it('keeps all opened container host workspaces mounted and marks only the active one as interactive', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;
    mocks.storeState = createMockStoreState({
      hosts: [
        {
          id: 'host-1',
          kind: 'ssh',
          label: 'Prod',
          hostname: 'prod.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: 'host:host-1',
          groupName: 'Servers',
          tags: [],
          terminalThemeId: null,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
        },
        {
          id: 'ecs-host-1',
          kind: 'aws-ecs',
          label: 'prod cluster',
          awsProfileName: 'default',
          awsRegion: 'ap-northeast-2',
          awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
          awsEcsClusterName: 'prod',
          groupName: 'Servers',
          tags: [],
          terminalThemeId: null,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
        },
      ],
      containerTabs: [
        {
          hostId: 'host-1',
          title: 'Prod · Containers',
          runtime: 'docker',
          unsupportedReason: null,
          connectionProgress: null,
          items: [],
          selectedContainerId: null,
          activePanel: 'overview',
          isLoading: false,
          details: null,
          detailsLoading: false,
          logs: null,
          logsState: 'idle',
          logsLoading: false,
          logsFollowEnabled: false,
        },
        {
          kind: 'ecs-cluster',
          hostId: 'ecs-host-1',
          title: 'prod cluster · ECS',
          runtime: null,
          unsupportedReason: null,
          connectionProgress: null,
          items: [],
          selectedContainerId: null,
          activePanel: 'overview',
          isLoading: false,
          details: null,
          detailsLoading: false,
          logs: null,
          logsState: 'idle',
          logsLoading: false,
          logsFollowEnabled: false,
          logsTailWindow: 200,
          logsRangeMode: 'recent',
          logsRelativeRange: {
            presetKey: '30m',
            amount: '30',
            unit: 'minute',
          },
          logsAbsoluteRange: null,
          logsSearchQuery: '',
          logsSearchMode: null,
          logsSearchLoading: false,
          logsSearchResult: null,
          metricsSamples: [],
          metricsState: 'idle',
          metricsLoading: false,
          pendingAction: null,
          ecsSnapshot: {
            profileName: 'default',
            region: 'ap-northeast-2',
            cluster: {
              clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
              clusterName: 'prod',
              status: 'ACTIVE',
              activeServicesCount: 2,
              runningTasksCount: 3,
              pendingTasksCount: 1,
            },
            services: [],
            loadedAt: '2026-03-28T00:00:00.000Z',
          },
          ecsMetricsWarning: null,
          ecsMetricsLoadedAt: '2026-03-28T00:00:10.000Z',
          ecsMetricsLoading: false,
          ecsUtilizationHistoryByServiceName: {},
          ecsLogsByServiceName: {},
        },
      ],
      activeContainerHostId: 'host-1',
      activeWorkspaceTab: 'containers',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('containers-workspace')).toBeInTheDocument();
      expect(screen.getByTestId('aws-ecs-workspace')).toBeInTheDocument();
    });

    const latestContainerWorkspace = mocks.containersWorkspaceProps.at(-1);
    const latestEcsWorkspace = mocks.awsEcsWorkspaceProps.at(-1);
    expect(latestContainerWorkspace).toMatchObject({
      host: expect.objectContaining({ id: 'host-1' }),
      isActive: true,
    });
    expect(latestEcsWorkspace).toMatchObject({
      host: expect.objectContaining({ id: 'ecs-host-1' }),
      isActive: false,
    });
  });

  it('renders the ECS workspace inside the fixed containers section for aws-ecs hosts', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;
    mocks.storeState = createMockStoreState({
      hosts: [
        {
          id: 'ecs-host-1',
          kind: 'aws-ecs',
          label: 'prod cluster',
          awsProfileName: 'default',
          awsRegion: 'ap-northeast-2',
          awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
          awsEcsClusterName: 'prod',
          groupName: 'Servers',
          tags: [],
          terminalThemeId: null,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
        },
      ],
      containerTabs: [
        {
          kind: 'ecs-cluster',
          hostId: 'ecs-host-1',
          title: 'prod cluster · ECS',
          runtime: null,
          unsupportedReason: null,
          connectionProgress: null,
          items: [],
          selectedContainerId: null,
          activePanel: 'overview',
          isLoading: false,
          details: null,
          detailsLoading: false,
          logs: null,
          logsState: 'idle',
          logsLoading: false,
          logsFollowEnabled: false,
          logsTailWindow: 200,
          logsRangeMode: 'recent',
          logsRelativeRange: {
            presetKey: '30m',
            amount: '30',
            unit: 'minute',
          },
          logsAbsoluteRange: null,
          logsSearchQuery: '',
          logsSearchMode: null,
          logsSearchLoading: false,
          logsSearchResult: null,
          metricsSamples: [],
          metricsState: 'idle',
          metricsLoading: false,
          pendingAction: null,
          ecsSnapshot: {
            profileName: 'default',
            region: 'ap-northeast-2',
            cluster: {
              clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
              clusterName: 'prod',
              status: 'ACTIVE',
              activeServicesCount: 2,
              runningTasksCount: 3,
              pendingTasksCount: 1,
            },
            services: [],
            loadedAt: '2026-03-28T00:00:00.000Z',
          },
          ecsMetricsWarning: null,
          ecsMetricsLoadedAt: '2026-03-28T00:00:10.000Z',
          ecsMetricsLoading: false,
          ecsUtilizationHistoryByServiceName: {},
          ecsLogsByServiceName: {},
        },
      ],
      activeContainerHostId: 'ecs-host-1',
      activeWorkspaceTab: 'containers',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('aws-ecs-workspace')).toBeInTheDocument();
    });
    expect(mocks.awsEcsWorkspaceProps.at(-1)).toMatchObject({
      isActive: true,
    });
    expect(typeof mocks.awsEcsWorkspaceProps.at(-1)?.onRefreshUtilization).toBe('function');
    expect(typeof mocks.awsEcsWorkspaceProps.at(-1)?.onOpenEcsExecShell).toBe('function');
  });

  it('falls back safely when sessionShares.onChatEvent is missing', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'unauthenticated',
        session: null,
        offline: null,
        errorMessage: null,
      },
      authGetStateState: {
        status: 'unauthenticated',
        session: null,
        offline: null,
        errorMessage: null,
      },
      includeSessionShareChatEvent: false,
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    render(<App />);

    expect(await screen.findByTestId('login-gate')).toHaveTextContent('unauthenticated');
  });

  it('resets back to the login gate when auth events become unauthenticated', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    render(<App />);

    await screen.findByTestId('terminal-workspace');

    await act(async () => {
      api.__listeners.auth?.({
        status: 'unauthenticated',
        session: null,
        offline: null,
        errorMessage: null,
      });
    });

    expect(mocks.storeState.clearSyncedWorkspaceData).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('login-gate')).toHaveTextContent('unauthenticated');
  });

  it('cleans up subscriptions on unmount and survives sync bootstrap fallback', async () => {
    const api = createDolsshApi({
      authBootstrapState: {
        status: 'authenticated',
        session: { user: { id: 'user-1', email: 'user@example.com' } },
        offline: null,
        errorMessage: null,
      },
      authGetStateState: {
        status: 'unauthenticated',
        session: null,
        offline: null,
        errorMessage: null,
      },
      syncBootstrapError: new Error('sync failed'),
      includeSessionShareChatEvent: false,
    });
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      writable: true,
      value: api,
    });
    mocks.desktopApi = api;

    const { unmount } = render(<App />);

    expect(await screen.findByTestId('login-gate')).toBeInTheDocument();

    unmount();

    expect(api.__off.core).toHaveBeenCalled();
    expect(api.__off.transfer).toHaveBeenCalled();
    expect(api.__off.forward).toHaveBeenCalled();
    expect(api.__off.sessionShare).toHaveBeenCalled();
    expect(api.__off.auth).toHaveBeenCalled();
    expect(api.__off.updater).toHaveBeenCalled();
    expect(api.__off.windowState).toHaveBeenCalled();
  });
});
