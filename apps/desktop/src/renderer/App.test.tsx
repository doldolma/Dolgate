import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const mocks = vi.hoisted(() => ({
  storeState: {} as any,
  appStoreSetState: vi.fn(),
  loginGateProps: [] as any[],
  terminalWorkspaceProps: [] as any[],
}));

function stubComponent(testId: string) {
  return function StubComponent() {
    return <div data-testid={testId} />;
  };
}

vi.mock('./store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(mocks.storeState),
  appStore: {
    setState: mocks.appStoreSetState,
  },
}));

vi.mock('./components/AppTitleBar', () => ({ AppTitleBar: stubComponent('app-title-bar') }));
vi.mock('./components/AwsImportDialog', () => ({ AwsImportDialog: stubComponent('aws-import-dialog') }));
vi.mock('./components/CredentialRetryDialog', () => ({
  CredentialRetryDialog: stubComponent('credential-retry-dialog'),
}));
vi.mock('./components/HomeNavigation', () => ({ HomeNavigation: stubComponent('home-navigation') }));
vi.mock('./components/HostBrowser', () => ({ HostBrowser: stubComponent('host-browser') }));
vi.mock('./components/HostDrawer', () => ({ HostDrawer: stubComponent('host-drawer') }));
vi.mock('./components/KnownHostPromptDialog', () => ({
  KnownHostPromptDialog: stubComponent('known-host-prompt'),
}));
vi.mock('./components/LogsPanel', () => ({ LogsPanel: stubComponent('logs-panel') }));
vi.mock('./components/DesktopWindowControls', () => ({
  DesktopWindowControls: stubComponent('desktop-window-controls'),
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
    workspaces: [],
    tabStrip: [{ kind: 'session', sessionId: 'session-1' }],
    portForwards: [],
    portForwardRuntimes: [],
    knownHosts: [],
    activityLogs: [],
    keychainEntries: [],
    activeWorkspaceTab: 'session:session-1',
    homeSection: 'hosts',
    settingsSection: 'general',
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
      serverUrl: 'https://example.test',
      serverUrlOverride: null,
      updatedAt: '2026-03-28T00:00:00.000Z',
    },
    pendingHostKeyPrompt: null,
    pendingCredentialRetry: null,
    pendingInteractiveAuth: null,
    sftp: {
      localHomePath: '/',
      leftPane: null,
      rightPane: null,
      transfers: [],
      pendingConflictDialog: null,
    },
    bootstrap: fn(),
    refreshHostCatalog: fn(),
    setSearchQuery: fn(),
    activateHome: fn(),
    activateSession: fn(),
    activateWorkspace: fn(),
    openHomeSection: fn(),
    openSettingsSection: fn(),
    openCreateHostDrawer: fn(),
    openEditHostDrawer: fn(),
    closeHostDrawer: fn(),
    navigateGroup: fn(),
    createGroup: fn(),
    removeGroup: fn(),
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
    splitSessionIntoWorkspace: fn(),
    moveWorkspaceSession: fn(),
    detachSessionFromWorkspace: fn(),
    reorderDynamicTab: fn(),
    focusWorkspaceSession: fn(),
    toggleWorkspaceBroadcast: fn(),
    resizeWorkspaceSplit: fn(),
    activateSftp: fn(),
    updateSettings: fn(),
    savePortForward: fn(),
    removePortForward: fn(),
    startPortForward: fn(),
    stopPortForward: fn(),
    removeKnownHost: fn(),
    clearLogs: fn(),
    removeKeychainSecret: fn(),
    updateKeychainSecret: fn(),
    cloneKeychainSecretForHost: fn(),
    acceptPendingHostKeyPrompt: fn(),
    dismissPendingHostKeyPrompt: fn(),
    dismissPendingCredentialRetry: fn(),
    submitCredentialRetry: fn(),
    respondInteractiveAuth: fn(),
    reopenInteractiveAuthUrl: fn(),
    clearPendingInteractiveAuth: fn(),
    handleCoreEvent: fn(),
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
    transfer: vi.fn(),
    forward: vi.fn(),
    sessionShare: vi.fn(),
    sessionShareChat: vi.fn(),
    auth: vi.fn(),
    updater: vi.fn(),
    windowState: vi.fn(),
  };

  const api: any = {
    __listeners: listeners,
    __off: off,
    ssh: {
      onEvent: vi.fn(() => off.core),
    },
    sftp: {
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
  };

  return api;
}

describe('App integration', () => {
  beforeEach(() => {
    mocks.loginGateProps.length = 0;
    mocks.terminalWorkspaceProps.length = 0;
    mocks.appStoreSetState.mockReset();
    mocks.storeState = createMockStoreState();
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

    render(<App />);

    await waitFor(() => {
      expect(mocks.storeState.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.sync.bootstrap).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
    });
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
