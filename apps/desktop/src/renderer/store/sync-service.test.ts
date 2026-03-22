import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncAuthenticationError, SyncService, isSyncAuthenticationError } from '../../main/sync-service';

function createSyncService() {
  const authService = {
    getAccessToken: vi.fn().mockReturnValue('access-token'),
    getServerUrl: vi.fn().mockReturnValue('https://ssh.doldolma.com'),
    getVaultKeyBase64: vi.fn().mockReturnValue(Buffer.alloc(32, 1).toString('base64')),
    refreshSession: vi.fn().mockResolvedValue({
      status: 'authenticated'
    })
  };
  const hosts = {
    list: vi.fn().mockReturnValue([]),
    replaceAll: vi.fn()
  };
  const groups = {
    list: vi.fn().mockReturnValue([]),
    replaceAll: vi.fn()
  };
  const portForwards = {
    list: vi.fn().mockReturnValue([]),
    replaceAll: vi.fn()
  };
  const knownHosts = {
    list: vi.fn().mockReturnValue([]),
    replaceAll: vi.fn()
  };
  const secretMetadata = {
    list: vi.fn().mockReturnValue([
      {
        secretRef: 'secret:local',
        label: 'Local Secret',
        hasPassword: true,
        hasPassphrase: false,
        hasManagedPrivateKey: false,
        source: 'local_keychain',
        linkedHostCount: 1,
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      {
        secretRef: 'secret:server',
        label: 'Server Secret',
        hasPassword: false,
        hasPassphrase: true,
        hasManagedPrivateKey: true,
        source: 'server_managed',
        linkedHostCount: 2,
        updatedAt: '2026-03-22T00:00:00.000Z'
      }
    ]),
    listBySource: vi.fn().mockReturnValue([]),
    remove: vi.fn(),
    replaceAll: vi.fn(),
    upsert: vi.fn()
  };
  const secretStore = {
    remove: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined)
  };
  const outbox = {
    clearAll: vi.fn(),
    list: vi.fn().mockReturnValue([])
  };
  const activityLogs = {
    append: vi.fn()
  };

  const service = new SyncService(
    authService as never,
    hosts as never,
    groups as never,
    portForwards as never,
    knownHosts as never,
    secretMetadata as never,
    secretStore as never,
    outbox as never,
    activityLogs as never
  );

  return {
    service,
    authService,
    hosts,
    groups,
    portForwards,
    knownHosts,
    secretMetadata,
    secretStore,
    outbox
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SyncService', () => {
  it('purges all synced cache and every local secret on logout', async () => {
    const { service, hosts, groups, portForwards, knownHosts, secretMetadata, secretStore, outbox } = createSyncService();

    await service.purgeSyncedCache();

    expect(secretStore.remove).toHaveBeenCalledTimes(2);
    expect(secretStore.remove).toHaveBeenCalledWith('secret:local');
    expect(secretStore.remove).toHaveBeenCalledWith('secret:server');
    expect(secretMetadata.remove).toHaveBeenCalledTimes(2);
    expect(secretMetadata.remove).toHaveBeenCalledWith('secret:local');
    expect(secretMetadata.remove).toHaveBeenCalledWith('secret:server');
    expect(hosts.replaceAll).toHaveBeenCalledWith([]);
    expect(groups.replaceAll).toHaveBeenCalledWith([]);
    expect(knownHosts.replaceAll).toHaveBeenCalledWith([]);
    expect(portForwards.replaceAll).toHaveBeenCalledWith([]);
    expect(outbox.clearAll).toHaveBeenCalledWith();
    expect(service.getState()).toEqual({
      status: 'idle',
      lastSuccessfulSyncAt: null,
      pendingPush: false,
      errorMessage: null
    });
  });

  it('refreshes the access token and retries sync when /sync returns expired token', async () => {
    const { service, authService } = createSyncService();
    authService.getAccessToken
      .mockReturnValueOnce('expired-access-token')
      .mockReturnValueOnce('fresh-access-token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'token has invalid claims: token is expired' }), {
            status: 401,
            headers: {
              'content-type': 'application/json'
            }
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              groups: [],
              hosts: [],
              secrets: [],
              knownHosts: [],
              portForwards: []
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json'
              }
            }
          )
        )
    );

    const state = await service.bootstrap();

    expect(authService.refreshSession).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('ready');
  });

  it('treats sync as auth failure when refresh cannot restore the session', async () => {
    const { service, authService } = createSyncService();
    authService.refreshSession.mockResolvedValue({
      status: 'unauthenticated'
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'token has invalid claims: token is expired' }), {
          status: 401,
          headers: {
            'content-type': 'application/json'
          }
        })
      )
    );

    let thrown: unknown;
    try {
      await service.bootstrap();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SyncAuthenticationError);
    expect(isSyncAuthenticationError(thrown)).toBe(true);
  });
});
