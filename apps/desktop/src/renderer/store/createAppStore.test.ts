import { describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '@shared';
import { createAppStore } from './createAppStore';

function createMockApi(): DesktopApi {
  let sessionCounter = 0;

  return {
    auth: {
      getState: vi.fn().mockResolvedValue({
        status: 'authenticated',
        session: {
          user: { id: 'user-1', email: 'user@example.com' },
          tokens: {
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresInSeconds: 900
          },
          vaultBootstrap: {
            keyBase64: 'ZmFrZS12YXVsdC1rZXk='
          },
          syncServerTime: '2025-01-01T00:00:00.000Z'
        },
        errorMessage: null
      }),
      bootstrap: vi.fn().mockResolvedValue({
        status: 'authenticated',
        session: {
          user: { id: 'user-1', email: 'user@example.com' },
          tokens: {
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresInSeconds: 900
          },
          vaultBootstrap: {
            keyBase64: 'ZmFrZS12YXVsdC1rZXk='
          },
          syncServerTime: '2025-01-01T00:00:00.000Z'
        },
        errorMessage: null
      }),
      beginBrowserLogin: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn().mockReturnValue(() => undefined)
    },
    sync: {
      bootstrap: vi.fn().mockResolvedValue({
        status: 'ready',
        lastSuccessfulSyncAt: '2025-01-01T00:00:00.000Z',
        pendingPush: false,
        errorMessage: null
      }),
      pushDirty: vi.fn().mockResolvedValue({
        status: 'ready',
        lastSuccessfulSyncAt: '2025-01-01T00:00:00.000Z',
        pendingPush: false,
        errorMessage: null
      }),
      status: vi.fn().mockResolvedValue({
        status: 'ready',
        lastSuccessfulSyncAt: '2025-01-01T00:00:00.000Z',
        pendingPush: false,
        errorMessage: null
      }),
      exportDecryptedSnapshot: vi.fn().mockResolvedValue({
        groups: [],
        hosts: [],
        secrets: [],
        knownHosts: [],
        portForwards: [],
        preferences: []
      })
    },
    hosts: {
      list: vi.fn().mockResolvedValue([
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
          terminalThemeId: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    aws: {
      listProfiles: vi.fn().mockResolvedValue([]),
      getProfileStatus: vi.fn().mockResolvedValue({
        profileName: 'default',
        available: true,
        isSsoProfile: false,
        isAuthenticated: false,
        accountId: null,
        arn: null,
        errorMessage: null,
        missingTools: []
      }),
      login: vi.fn().mockResolvedValue(undefined),
      listRegions: vi.fn().mockResolvedValue([]),
      listEc2Instances: vi.fn().mockResolvedValue([])
    },
    warpgate: {
      testConnection: vi.fn().mockResolvedValue({
        baseUrl: 'https://warpgate.example.com',
        sshHost: 'warpgate.example.com',
        sshPort: 2222,
        username: 'example.user'
      }),
      getConnectionInfo: vi.fn().mockResolvedValue({
        baseUrl: 'https://warpgate.example.com',
        sshHost: 'warpgate.example.com',
        sshPort: 2222,
        username: 'example.user'
      }),
      listSshTargets: vi.fn().mockResolvedValue([])
    },
    groups: {
      list: vi.fn().mockResolvedValue([
        {
          id: 'group-1',
          name: 'Servers',
          path: 'Servers',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]),
      create: vi.fn().mockImplementation(async (name: string, parentPath?: string | null) => ({
        id: 'group-2',
        name,
        path: parentPath ? `${parentPath}/${name}` : name,
        parentPath: parentPath ?? null,
        createdAt: '2025-01-03T00:00:00.000Z',
        updatedAt: '2025-01-03T00:00:00.000Z'
      }))
    },
    ssh: {
      connect: vi.fn().mockImplementation(async () => {
        sessionCounter += 1;
        return { sessionId: `session-${sessionCounter}` };
      }),
      write: vi.fn().mockResolvedValue(undefined),
      writeBinary: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      respondKeyboardInteractive: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      onData: vi.fn()
    },
    shell: {
      pickPrivateKey: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined)
    },
    tabs: {
      list: vi.fn().mockResolvedValue([])
    },
    updater: {
      getState: vi.fn().mockResolvedValue({
        enabled: false,
        status: 'idle',
        currentVersion: '0.1.0',
        dismissedVersion: null,
        release: null,
        progress: null,
        checkedAt: null,
        errorMessage: null
      }),
      check: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined),
      installAndRestart: vi.fn().mockResolvedValue(undefined),
      dismissAvailable: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn()
    },
    settings: {
      get: vi.fn().mockResolvedValue({
        theme: 'system',
        globalTerminalThemeId: 'dolssh-dark',
        terminalFontFamily: 'sf-mono',
        terminalFontSize: 13,
        dismissedUpdateVersion: null,
        updatedAt: '2025-01-01T00:00:00.000Z'
      }),
      update: vi.fn().mockImplementation(async (input) => ({
        theme: input.theme ?? 'system',
        globalTerminalThemeId: input.globalTerminalThemeId ?? 'dolssh-dark',
        terminalFontFamily: input.terminalFontFamily ?? 'sf-mono',
        terminalFontSize: input.terminalFontSize ?? 13,
        dismissedUpdateVersion: input.dismissedUpdateVersion ?? null,
        updatedAt: '2025-01-02T00:00:00.000Z'
      }))
    },
    portForwards: {
      list: vi.fn().mockResolvedValue({
        rules: [],
        runtimes: []
      }),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue({
        ruleId: 'forward-1',
        hostId: 'host-1',
        mode: 'local',
        bindAddress: '127.0.0.1',
        bindPort: 9000,
        status: 'running',
        updatedAt: '2025-01-01T00:00:00.000Z'
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn()
    },
    knownHosts: {
      list: vi.fn().mockResolvedValue([]),
      probeHost: vi.fn().mockResolvedValue({
        hostId: 'host-1',
        hostLabel: 'Prod',
        host: 'prod.example.com',
        port: 22,
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'AAAATEST',
        fingerprintSha256: 'SHA256:test',
        status: 'trusted',
        existing: null
      }),
      trust: vi.fn().mockResolvedValue({
        id: 'known-1',
        host: 'prod.example.com',
        port: 22,
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'AAAATEST',
        fingerprintSha256: 'SHA256:test',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastSeenAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z'
      }),
      replace: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    logs: {
      list: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined)
    },
    keychain: {
      list: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      cloneForHost: vi.fn().mockResolvedValue(undefined)
    },
    files: {
      getHomeDirectory: vi.fn().mockResolvedValue('/Users/tester'),
      getParentPath: vi.fn().mockImplementation(async (targetPath: string) => {
        if (targetPath === '/Users/tester') {
          return '/Users';
        }
        return '/Users/tester';
      }),
      list: vi.fn().mockResolvedValue({
        path: '/Users/tester',
        entries: [
          {
            name: 'Desktop',
            path: '/Users/tester/Desktop',
            isDirectory: true,
            size: 0,
            mtime: '2025-01-01T00:00:00.000Z',
            kind: 'folder',
            permissions: 'rwxr-xr-x'
          }
        ]
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    },
    sftp: {
      connect: vi.fn().mockResolvedValue({
        id: 'endpoint-1',
        kind: 'remote',
        hostId: 'host-1',
        title: 'Prod',
        path: '/home/ubuntu',
        connectedAt: '2025-01-01T00:00:00.000Z'
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        path: '/home/ubuntu',
        entries: []
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      startTransfer: vi.fn().mockResolvedValue({
        id: 'job-1',
        sourceLabel: 'Local',
        targetLabel: 'Prod',
        itemCount: 1,
        bytesTotal: 12,
        bytesCompleted: 0,
        status: 'queued',
        startedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z'
      }),
      cancelTransfer: vi.fn().mockResolvedValue(undefined),
      onTransferEvent: vi.fn()
    }
  };
}

describe('createAppStore', () => {
  it('bootstraps home workspace and settings from desktop api', async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();

    expect(store.getState().hosts).toHaveLength(1);
    expect(store.getState().groups).toHaveLength(1);
    expect(store.getState().activeWorkspaceTab).toBe('home');
    expect(store.getState().homeSection).toBe('hosts');
    expect(store.getState().currentGroupPath).toBeNull();
    expect(store.getState().settings.theme).toBe('system');
    expect(store.getState().sftp.leftPane.currentPath).toBe('/Users/tester');
    expect(store.getState().sftp.rightPane.sourceKind).toBe('host');
    expect(store.getState().portForwards).toHaveLength(0);
    expect(store.getState().knownHosts).toHaveLength(0);
  });

  it('opens create and edit drawers from home', async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openCreateHostDrawer();
    expect(store.getState().hostDrawer).toEqual({ mode: 'create', defaultGroupPath: null });

    store.getState().openEditHostDrawer('host-1');
    expect(store.getState().hostDrawer).toEqual({ mode: 'edit', hostId: 'host-1' });
  });

  it('navigates groups and creates a group at the current location', async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().navigateGroup('Servers');
    store.getState().openCreateHostDrawer();

    expect(store.getState().currentGroupPath).toBe('Servers');
    expect(store.getState().hostDrawer).toEqual({ mode: 'create', defaultGroupPath: 'Servers' });

    await store.getState().createGroup('Production');

    expect(api.groups.create).toHaveBeenCalledWith('Production', 'Servers');
    expect(store.getState().groups.some((group) => group.path === 'Servers/Production')).toBe(true);
  });

  it('opens a new session tab and moves to focus mode on connect', async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost('host-1', 120, 32);

    expect(store.getState().tabs[0]?.sessionId).toBe('session-1');
    expect(store.getState().tabs[0]?.title).toBe('Prod');
    expect(store.getState().tabStrip).toEqual([{ kind: 'session', sessionId: 'session-1' }]);
    expect(store.getState().activeWorkspaceTab).toBe('session:session-1');
    expect(store.getState().hostDrawer).toEqual({ mode: 'closed' });
  });

  it('creates a new titled session each time the same host is connected', async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost('host-1', 120, 32);
    await store.getState().connectHost('host-1', 120, 32);

    expect(store.getState().tabs.map((tab) => tab.title)).toEqual(['Prod', 'Prod (1)']);
    expect(store.getState().activeWorkspaceTab).toBe('session:session-2');
  });

  it('waits for host key trust when the server is not trusted yet', async () => {
    const api = createMockApi();
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'prod.example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAAATEST',
      fingerprintSha256: 'SHA256:test',
      status: 'untrusted',
      existing: null
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost('host-1', 120, 32);

    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe('untrusted');
    expect(api.ssh.connect).not.toHaveBeenCalled();

    await store.getState().acceptPendingHostKeyPrompt('trust');

    expect(api.knownHosts.trust).toHaveBeenCalled();
    expect(api.ssh.connect).toHaveBeenCalled();
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
  });

  it('returns to home when the last session closes', async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost('host-1', 120, 32);
    await store.getState().disconnectTab('session-1');

    expect(store.getState().tabs[0]?.status).toBe('disconnecting');

    store.getState().handleCoreEvent({
      type: 'closed',
      sessionId: 'session-1',
      payload: {}
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe('home');
  });

  it('updates theme settings through the desktop api', async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().updateSettings({ theme: 'dark' });

    expect(api.settings.update).toHaveBeenCalledWith({ theme: 'dark' });
    expect(store.getState().settings.theme).toBe('dark');
  });

  it('keeps a fixed sftp workspace with local bootstrap and host connect', async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost('right', 'host-1');

    expect(store.getState().activeWorkspaceTab).toBe('sftp');
    expect(store.getState().sftp.rightPane.endpoint?.id).toBe('endpoint-1');
    expect(store.getState().sftp.rightPane.currentPath).toBe('/home/ubuntu');
  });

  it('creates and expands a workspace from adjacent tabs', async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost('host-1', 120, 32);
    await store.getState().connectHost('host-1', 120, 32);
    await store.getState().connectHost('host-1', 120, 32);

    const created = store.getState().splitSessionIntoWorkspace('session-1', 'right');
    expect(created).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([
      { kind: 'workspace', workspaceId: store.getState().workspaces[0]?.id },
      { kind: 'session', sessionId: 'session-3' }
    ]);

    const expanded = store.getState().splitSessionIntoWorkspace('session-3', 'bottom', 'session-2');
    expect(expanded).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([{ kind: 'workspace', workspaceId: store.getState().workspaces[0]?.id }]);
  });

  it('detaches a workspace pane back into standalone tabs and collapses single-pane workspaces', async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost('host-1', 120, 32);
    await store.getState().connectHost('host-1', 120, 32);

    store.getState().splitSessionIntoWorkspace('session-1', 'right');
    const workspaceId = store.getState().workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    store.getState().detachSessionFromWorkspace(workspaceId!, 'session-1');

    expect(store.getState().workspaces).toHaveLength(0);
    expect(store.getState().tabStrip).toEqual([
      { kind: 'session', sessionId: 'session-2' },
      { kind: 'session', sessionId: 'session-1' }
    ]);
    expect(store.getState().activeWorkspaceTab).toBe('session:session-1');
  });
});
