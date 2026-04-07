import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv } from 'node:crypto';
import type { SyncPayloadV2 } from '@shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncAuthenticationError, SyncService, isSyncAuthenticationError } from '../../main/sync-service';
import { getDesktopStateStorage, resetDesktopStateStorageForTests } from '../../main/state-storage';

let tempDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? tempDir : os.tmpdir())),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value).toString('utf8'))
  }
}));

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

function createRemoteSnapshotWithPreferences(keyBase64: string): SyncPayloadV2 {
  return {
    groups: [],
    hosts: [],
    secrets: [],
    knownHosts: [],
    portForwards: [],
    dnsOverrides: [],
    awsProfiles: [],
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

function createServerInfoResponse(awsProfiles = true, version = '2026.04.07-test') {
  return new Response(
    JSON.stringify({
      serverVersion: version,
      capabilities: {
        sync: {
          awsProfiles,
        },
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }
  );
}

function createRemoteSnapshotWithManagedSecrets(keyBase64: string, secretCount = 220): SyncPayloadV2 {
  return {
    groups: [
      {
        id: 'group-remote',
        encrypted_payload: encodeEncryptedPayload(
          JSON.stringify({
            id: 'group-remote',
            name: 'Remote',
            path: 'Remote',
            parentPath: null,
            createdAt: '2026-03-22T00:00:00.000Z',
            updatedAt: '2026-03-22T00:00:00.000Z'
          }),
          keyBase64
        ),
        updated_at: '2026-03-22T00:00:00.000Z'
      }
    ],
    hosts: Array.from({ length: secretCount }, (_value, index) => ({
      id: `host-${index + 1}`,
      encrypted_payload: encodeEncryptedPayload(
        JSON.stringify({
          id: `host-${index + 1}`,
          kind: 'ssh',
          label: `Remote Host ${index + 1}`,
          hostname: `remote-${index + 1}.example.com`,
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: `secret:server-${index + 1}`,
          groupName: 'Remote',
          terminalThemeId: null,
          createdAt: '2026-03-22T00:00:00.000Z',
          updatedAt: '2026-03-22T00:00:00.000Z'
        }),
        keyBase64
      ),
      updated_at: '2026-03-22T00:00:00.000Z'
    })),
    secrets: Array.from({ length: secretCount }, (_value, index) => ({
      id: `secret:server-${index + 1}`,
      encrypted_payload: encodeEncryptedPayload(
        JSON.stringify({
          secretRef: `secret:server-${index + 1}`,
          label: `Server Secret ${index + 1}`,
          password: `pw-${index + 1}`,
          source: 'server_managed',
          updatedAt: `2026-03-22T00:00:${String(index % 60).padStart(2, '0')}.000Z`
        }),
        keyBase64
      ),
      updated_at: `2026-03-22T00:00:${String(index % 60).padStart(2, '0')}.000Z`
    })),
    knownHosts: [],
    portForwards: [],
    dnsOverrides: [],
    awsProfiles: [],
    preferences: [
      {
        id: 'global-terminal',
        encrypted_payload: encodeEncryptedPayload(
          JSON.stringify({
            id: 'global-terminal',
            globalTerminalThemeId: 'kanagawa-wave',
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
  const dnsOverrides = {
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
  const awsProfiles = {
    listPayloads: vi.fn().mockReturnValue([]),
    replaceAll: vi.fn()
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
  const outboxRecords: Array<{ kind: 'groups' | 'hosts' | 'secrets' | 'knownHosts' | 'portForwards' | 'preferences' | 'awsProfiles'; recordId: string; deletedAt: string }> = [];
  const outbox = {
    clearAll: vi.fn(() => {
      outboxRecords.splice(0, outboxRecords.length);
    }),
    clearMany: vi.fn(
      (records: Array<{ kind: 'groups' | 'hosts' | 'secrets' | 'knownHosts' | 'portForwards' | 'preferences' | 'awsProfiles'; recordId: string; deletedAt?: string }>) => {
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
        kind: 'groups' | 'hosts' | 'secrets' | 'knownHosts' | 'portForwards' | 'preferences' | 'awsProfiles',
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
    dnsOverrides as never,
    knownHosts as never,
    secretMetadata as never,
    awsProfiles as never,
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
    dnsOverrides,
    knownHosts,
    secretMetadata,
    awsProfiles,
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
  delete process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('SyncService', () => {
  it('purges all synced cache and every local secret on logout', async () => {
    const { service, hosts, groups, portForwards, dnsOverrides, knownHosts, secretMetadata, settings, secretStore, outbox } = createSyncService();

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
    expect(dnsOverrides.replaceAll).toHaveBeenCalledWith([]);
    expect(settings.clearSyncedTerminalPreferences).toHaveBeenCalledWith();
    expect(outbox.clearAll).toHaveBeenCalledWith();
    expect(service.getState()).toEqual({
      status: 'idle',
      lastSuccessfulSyncAt: null,
      pendingPush: false,
      errorMessage: null,
      awsProfilesServerSupport: 'unknown'
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
        .mockResolvedValueOnce(createServerInfoResponse())
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
              dnsOverrides: [],
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
    expect((thrown as Error).message).toBe(
      '세션이 만료되었거나 로그인 정보가 유효하지 않습니다. 다시 로그인해 주세요.'
    );
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
      .mockResolvedValueOnce(createServerInfoResponse())
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/info');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST'
    });
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBeUndefined();
    expect(state.status).toBe('ready');
    expect(state.pendingPush).toBe(false);
    expect(state.awsProfilesServerSupport).toBe('supported');
  });

  it('applies remote snapshots with many managed secrets in a bounded number of state writes', async () => {
    process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = 'true';
    const { service, authService } = createSyncService();
    const stateStorage = getDesktopStateStorage();
    stateStorage.updateState((state) => {
      state.data.secretMetadata = [
        {
          secretRef: 'secret:local',
          label: 'Local Secret',
          hasPassword: true,
          hasPassphrase: false,
          hasManagedPrivateKey: false,
          source: 'local_keychain',
          linkedHostCount: 0,
          updatedAt: '2026-03-21T00:00:00.000Z'
        },
        {
          secretRef: 'secret:server-stale',
          label: 'Old Server Secret',
          hasPassword: true,
          hasPassphrase: false,
          hasManagedPrivateKey: false,
          source: 'server_managed',
          linkedHostCount: 0,
          updatedAt: '2026-03-21T00:00:00.000Z'
        }
      ];
      state.secure.managedSecretsByRef['secret:local'] = {
        encrypted: false,
        value: Buffer.from(
          '{"secretRef":"secret:local","label":"Local Secret","password":"local","source":"local_keychain","updatedAt":"2026-03-21T00:00:00.000Z"}',
          'utf8'
        ).toString('base64')
      };
      state.secure.managedSecretsByRef['secret:server-stale'] = {
        encrypted: false,
        value: Buffer.from(
          '{"secretRef":"secret:server-stale","label":"Old Server Secret","password":"stale","source":"server_managed","updatedAt":"2026-03-21T00:00:00.000Z"}',
          'utf8'
        ).toString('base64')
      };
    });
    const updateStateSpy = vi.spyOn(stateStorage, 'updateState');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(createServerInfoResponse())
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              createRemoteSnapshotWithManagedSecrets(authService.getVaultKeyBase64())
            ),
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
    const persistedState = stateStorage.getState();
    const serverMetadata = persistedState.data.secretMetadata.filter(
      (record) => record.source === 'server_managed'
    );

    expect(state.status).toBe('ready');
    expect(updateStateSpy).toHaveBeenCalledTimes(4);
    expect(serverMetadata).toHaveLength(220);
    expect(
      persistedState.data.secretMetadata.some(
        (record) => record.secretRef === 'secret:local'
      )
    ).toBe(true);
    expect(
      persistedState.data.secretMetadata.some(
        (record) => record.secretRef === 'secret:server-stale'
      )
    ).toBe(false);
    expect(persistedState.secure.managedSecretsByRef['secret:local']).toBeDefined();
    expect(
      persistedState.secure.managedSecretsByRef['secret:server-stale']
    ).toBeUndefined();
    expect(Object.keys(persistedState.secure.managedSecretsByRef)).toHaveLength(221);
    expect(persistedState.data.hosts).toHaveLength(220);
    expect(persistedState.data.groups).toHaveLength(1);
    expect(persistedState.data.dnsOverrides).toHaveLength(0);
    expect(persistedState.terminal.globalThemeId).toBe('kanagawa-wave');
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

  it('skips awsProfiles payload and tombstones while the server is unsupported', async () => {
    getDesktopStateStorage().updateSyncState({
      pendingPush: false,
      errorMessage: null,
      awsProfilesServerSupport: 'unsupported',
    });
    const { service, outbox } = createSyncService();
    outbox.records.push({
      kind: 'awsProfiles',
      recordId: 'profile-1',
      deletedAt: '2026-04-07T00:00:00.000Z',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 202,
        headers: {
          'content-type': 'application/json',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const state = await service.pushDirty();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      awsProfiles: Array<{ id: string; deleted_at?: string }>;
    };

    expect(state.status).toBe('ready');
    expect(payload.awsProfiles).toEqual([]);
    expect(outbox.records).toEqual([
      {
        kind: 'awsProfiles',
        recordId: 'profile-1',
        deletedAt: '2026-04-07T00:00:00.000Z',
      },
    ]);
  });

  it('treats missing /api/info support as unsupported and keeps local aws profiles untouched', async () => {
    const { service, awsProfiles } = createSyncService();
    const stateStorage = getDesktopStateStorage();
    stateStorage.updateState((state) => {
      state.data.awsProfiles = [
        {
          id: 'profile-1',
          name: 'default',
          kind: 'sso',
          updatedAt: '2026-04-07T00:00:00.000Z',
        },
      ];
      state.secure.managedAwsProfilesById['profile-1'] = {
        encrypted: false,
        value: Buffer.from(
          JSON.stringify({
            id: 'profile-1',
            name: 'default',
            kind: 'sso',
            region: 'ap-southeast-1',
            updatedAt: '2026-04-07T00:00:00.000Z',
            ssoStartUrl: 'https://example.awsapps.com/start',
            ssoRegion: 'ap-northeast-2',
            ssoAccountId: '123456789012',
            ssoRoleName: 'developer',
          }),
          'utf8'
        ).toString('base64'),
      };
    });
    const remoteSnapshot = createRemoteSnapshotWithPreferences(
      Buffer.alloc(32, 1).toString('base64')
    );
    remoteSnapshot.awsProfiles = [
      {
        id: 'remote-profile',
        encrypted_payload: encodeEncryptedPayload(
          JSON.stringify({
            id: 'remote-profile',
            name: 'remote-default',
            kind: 'static',
            region: 'us-east-1',
            updatedAt: '2026-04-07T01:00:00.000Z',
            accessKeyId: 'AKIAREMOTE',
            secretAccessKey: 'secret',
          }),
          Buffer.alloc(32, 1).toString('base64')
        ),
        updated_at: '2026-04-07T01:00:00.000Z',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('not found', { status: 404 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(remoteSnapshot), {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          })
        )
    );

    const state = await service.bootstrap();

    expect(state.awsProfilesServerSupport).toBe('unsupported');
    expect(stateStorage.getState().data.awsProfiles).toEqual([
      {
        id: 'profile-1',
        name: 'default',
        kind: 'sso',
        updatedAt: '2026-04-07T00:00:00.000Z',
      },
    ]);
    expect(awsProfiles.replaceAll).not.toHaveBeenCalled();
  });
});
