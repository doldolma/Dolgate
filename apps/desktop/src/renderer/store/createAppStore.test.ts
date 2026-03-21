import { describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '@keyterm/shared';
import { createAppStore } from './createAppStore';

function createMockApi(): DesktopApi {
  return {
    hosts: {
      list: vi.fn().mockResolvedValue([
        {
          id: 'host-1',
          label: 'Prod',
          hostname: 'prod.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: 'host:host-1',
          groupName: 'Servers',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined)
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
      connect: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      write: vi.fn().mockResolvedValue(undefined),
      writeBinary: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      onData: vi.fn()
    },
    shell: {
      pickPrivateKey: vi.fn()
    },
    tabs: {
      list: vi.fn().mockResolvedValue([])
    },
    settings: {
      get: vi.fn().mockResolvedValue({
        theme: 'system',
        updatedAt: '2025-01-01T00:00:00.000Z'
      }),
      update: vi.fn().mockImplementation(async (input) => ({
        theme: input.theme ?? 'system',
        updatedAt: '2025-01-02T00:00:00.000Z'
      }))
    },
    files: {
      getHomeDirectory: vi.fn().mockResolvedValue('/Users/tester'),
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
    expect(store.getState().activeWorkspaceTab).toBe('session-1');
    expect(store.getState().hostDrawer).toEqual({ mode: 'closed' });
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
});
