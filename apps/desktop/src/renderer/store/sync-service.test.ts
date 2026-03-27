import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncAuthenticationError, SyncService, isSyncAuthenticationError } from '../../main/sync-service';
import { getDesktopStateStorage, resetDesktopStateStorageForTests } from '../../main/state-storage';

let tempDir = '';

function encodeEncryptedPayload(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

function createRemoteSnapshotWithPreferences(keyBase64: string) {
  return {
    groups: [],
    hosts: [],
    secrets: [],
    knownHosts: [],
    portForwards: [],
    preferences: [
      {
        id: 'global-terminal',
        encrypted_payload: encodeEncryptedPayload(
          JSON.stringify({
            id: 'global-terminal',
            globalTerminalThemeId: 'dolssh-dark',
            updatedAt: '2026-03-22T00:00:00.000Z'
          }),
          keyBase64
        ),
        updated_at: '2026-03-22T00:00:00.000Z'
      }
    ]
  };
}

function createSyncService() {
  const authService = {
    getState: vi.fn().mockReturnValue({
      status: 'authenticated'
    }),
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
  const settings = {
    getSyncedTerminalPreferences: vi.fn().mockReturnValue({
      id: 'global-terminal',
      globalTerminalThemeId: 'dolssh-dark',
      updatedAt: '2026-03-22T00:00:00.000Z'
    }),
    replaceSyncedTerminalPreferences: vi.fn(),
    clearSyncedTerminalPreferences: vi.fn()
  };
  const outboxRecords: Array<{ kind: 'groups' | 'hosts' | 'secrets' | 'knownHosts' | 'portForwards' | 'preferences'; recordId: string; deletedAt: string }> = [];
  const outbox = {
    clearAll: vi.fn(() => {
      outboxRecords.splice(0, outboxRecords.length);
    }),
    clearMany: vi.fn(
      (records: Array<{ kind: 'groups' | 'hosts' | 'secrets' | 'knownHosts' | 'portForwards' | 'preferences'; recordId: string; deletedAt?: string }>) => {
        const exactKeys = new Set(
          records
            .filter((record) => typeof record.deletedAt === 'string')
            .map((record) => `${record.kind}:${record.recordId}:${record.deletedAt}`)
        );
        const fallbackKeys = new Set(
          records
            .filter((record) => typeof record.deletedAt !== 'string')
            .map((record) => `${record.kind}:${record.recordId}`)
        );
        const remaining = outboxRecords.filter((entry) => {
          if (exactKeys.has(`${entry.kind}:${entry.recordId}:${entry.deletedAt}`)) {
            return false;
          }
          if (fallbackKeys.has(`${entry.kind}:${entry.recordId}`)) {
            return false;
          }
          return true;
        });
        outboxRecords.splice(0, outboxRecords.length, ...remaining);
      }
    ),
    list: vi.fn(() => [...outboxRecords]),
    upsertDeletion: vi.fn(
      (
        kind: 'groups' | 'hosts' | 'secrets' | 'knownHosts' | 'portForwards' | 'preferences',
        recordId: string,
        deletedAt: string
      ) => {
        const currentIndex = outboxRecords.findIndex((entry) => entry.kind === kind && entry.recordId === recordId);
        const nextRecord = { kind, recordId, deletedAt };
        if (currentIndex >= 0) {
          outboxRecords[currentIndex] = nextRecord;
          return;
        }
        outboxRecords.push(nextRecord);
      }
    ),
    records: outboxRecords
  };
  const service = new SyncService(
    authService as never,
    hosts as never,
    groups as never,
    portForwards as never,
    knownHosts as never,
    secretMetadata as never,
    settings as never,
    secretStore as never,
    outbox as never
  );

  return {
    service,
    authService,
    hosts,
    groups,
    portForwards,
    knownHosts,
    secretMetadata,
    settings,
    secretStore,
    outbox
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolssh-sync-service-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  resetDesktopStateStorageForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDesktopStateStorageForTests();
  delete process.env.DOLSSH_USER_DATA_DIR;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('SyncService', () => {
  it('purges all synced cache and every local secret on logout', async () => {
    const { service, hosts, groups, portForwards, knownHosts, secretMetadata, settings, secretStore, outbox } = createSyncService();

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
    expect(settings.clearSyncedTerminalPreferences).toHaveBeenCalledWith();
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
              portForwards: [],
              preferences: []
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json'
              }
            }
          )
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status: 202,
            headers: {
              'content-type': 'application/json'
            }
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(createRemoteSnapshotWithPreferences(authService.getVaultKeyBase64())),
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

  it('pauses remote sync while offline-authenticated and preserves pending work', async () => {
    const { service, authService, outbox } = createSyncService();
    authService.getState.mockReturnValue({
      status: 'offline-authenticated'
    });
    outbox.list.mockReturnValue([{ kind: 'hosts', recordId: 'host-1', deletedAt: '2026-03-22T00:00:00.000Z' }]);

    const state = await service.pushDirty();

    expect(state.status).toBe('paused');
    expect(state.pendingPush).toBe(true);
  });

  it('marks pending push for offline local upserts even without deletion tombstones', async () => {
    const { service, authService } = createSyncService();
    authService.getState.mockReturnValue({
      status: 'offline-authenticated'
    });

    const state = await service.pushDirty();

    expect(state.status).toBe('paused');
    expect(state.pendingPush).toBe(true);
    expect(getDesktopStateStorage().getState().sync.pendingPush).toBe(true);
  });

  it('pushes pending local data before fetching the remote snapshot after restart', async () => {
    const { service } = createSyncService();
    getDesktopStateStorage().updateSyncState({
      pendingPush: true,
      lastSuccessfulSyncAt: '2026-03-22T00:00:00.000Z',
      errorMessage: null
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 202,
          headers: {
            'content-type': 'application/json'
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(createRemoteSnapshotWithPreferences(Buffer.alloc(32, 1).toString('base64'))),
          {
            status: 200,
            headers: {
              'content-type': 'application/json'
            }
          }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const state = await service.bootstrap();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST'
    });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBeUndefined();
    expect(state.status).toBe('ready');
    expect(state.pendingPush).toBe(false);
  });

  it('keeps tombstones added during an in-flight push and sends them in a follow-up push', async () => {
    const { service, outbox } = createSyncService();
    outbox.records.push({ kind: 'hosts', recordId: 'host-1', deletedAt: '2026-03-22T00:00:00.000Z' });

    let resolveFirstPush: ((value: Response) => void) | null = null;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstPush = resolve;
          })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 202,
          headers: {
            'content-type': 'application/json'
          }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const firstPushPromise = service.pushDirty();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    outbox.records.push({ kind: 'hosts', recordId: 'host-2', deletedAt: '2026-03-22T00:00:01.000Z' });
    outbox.records.push({ kind: 'hosts', recordId: 'host-3', deletedAt: '2026-03-22T00:00:02.000Z' });

    const secondPushPromise = service.pushDirty();

    await expect(Promise.race([secondPushPromise, Promise.resolve('still-pending')])).resolves.toBe('still-pending');
    expect(resolveFirstPush).not.toBeNull();
    if (!resolveFirstPush) {
      throw new Error('Expected first push resolver to be available');
    }
    const releaseFirstPush: (value: Response) => void = resolveFirstPush;
    releaseFirstPush(
      new Response(null, {
        status: 202,
        headers: {
          'content-type': 'application/json'
        }
      })
    );

    const state = await firstPushPromise;

    expect(state.status).toBe('ready');
    expect(state.pendingPush).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outbox.clearMany).toHaveBeenCalledTimes(2);
    expect(outbox.clearMany).toHaveBeenNthCalledWith(1, [
      { kind: 'hosts', recordId: 'host-1', deletedAt: '2026-03-22T00:00:00.000Z' }
    ]);
    expect(outbox.clearMany).toHaveBeenNthCalledWith(2, [
      { kind: 'hosts', recordId: 'host-2', deletedAt: '2026-03-22T00:00:01.000Z' },
      { kind: 'hosts', recordId: 'host-3', deletedAt: '2026-03-22T00:00:02.000Z' }
    ]);
    expect(outbox.records).toEqual([]);

    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { hosts: Array<{ id: string; deleted_at?: string }> };
    const secondPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { hosts: Array<{ id: string; deleted_at?: string }> };

    expect(firstPayload.hosts.filter((record) => record.deleted_at).map((record) => record.id)).toEqual(['host-1']);
    expect(secondPayload.hosts.filter((record) => record.deleted_at).map((record) => record.id)).toEqual(['host-2', 'host-3']);
  });

  it('does not clear tombstones when the push fails', async () => {
    const { service, outbox } = createSyncService();
    outbox.records.push({ kind: 'hosts', recordId: 'host-1', deletedAt: '2026-03-22T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sync failed')));

    const state = await service.pushDirty();

    expect(state.status).toBe('error');
    expect(state.pendingPush).toBe(true);
    expect(outbox.clearMany).not.toHaveBeenCalled();
    expect(outbox.records).toEqual([{ kind: 'hosts', recordId: 'host-1', deletedAt: '2026-03-22T00:00:00.000Z' }]);
  });
});
