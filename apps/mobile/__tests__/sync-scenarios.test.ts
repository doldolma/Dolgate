import { act } from 'react-test-renderer';
import type {
  AuthSession,
  AuthState,
  SyncPayloadV2,
  SyncRecord,
} from '@dolssh/shared-core';
import { isSshHostRecord } from '@dolssh/shared-core';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';
import { Buffer } from 'buffer';
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from '../src/lib/mobile';
import {
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from '../src/store/useMobileAppStore';

// 동기화가 **사용자 손 없이** 버텨야 하는 조건들을 조합해 돌린다.
//
// 조각마다 단위 테스트는 있었는데도 기기에서 두 번 데이터를 잃었다. 둘 다 조각이 아니라
// **조합**에서 났다 — "Keychain 복원 지연 + 콜드스타트 + 전체 스냅샷", "밀기 실패 + 당기기
// 성공". 그래서 여기서는 순서를 바꿔 가며 굴리고, 매번 두 가지만 확인한다.
//
//   1. 만든 로컬 변경은 사라지지 않는다.
//   2. 온라인이 되면 결국 서버에 올라간다.

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));

// Keychain 을 진짜처럼 흉내 낸다 — service 별 저장소 + 지연·실패 스위치.
const mockKeychainStore = new Map<string, string>();
const mockKeychainFlags = { readFails: false };

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  },
  getGenericPassword: jest.fn(async (options?: { service?: string }) => {
    if (mockKeychainFlags.readFails) {
      throw new Error('keychain unavailable');
    }
    const value = mockKeychainStore.get(options?.service ?? 'default');
    return value ? { username: 'dolgate', password: value } : false;
  }),
  setGenericPassword: jest.fn(
    async (_user: string, value: string, options?: { service?: string }) => {
      mockKeychainStore.set(options?.service ?? 'default', value);
      return true;
    },
  ),
  resetGenericPassword: jest.fn(async (options?: { service?: string }) => {
    mockKeychainStore.delete(options?.service ?? 'default');
    return true;
  }),
}));

const VAULT_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');
const SYNC_KINDS = [
  'groups',
  'hosts',
  'secrets',
  'knownHosts',
  'portForwards',
  'dnsOverrides',
  'preferences',
  'awsProfiles',
  'snippets',
  'tailnets',
] as const;
type SyncKind = (typeof SYNC_KINDS)[number];

/**
 * 서버를 실제 규약대로 흉내 낸다 — 레코드 단위 upsert, 계정 단위 리비전, 조건부 GET.
 *
 * 암호화된 본문은 **그대로 보관했다 그대로 돌려준다**. 클라이언트가 민 것을 서버가 읽을
 * 이유가 없고(E2EE), 그래야 테스트가 키 관리에 끌려다니지 않는다.
 */
class FakeSyncServer {
  revision = 0;
  private records = new Map<string, SyncRecord>();

  push(payload: SyncPayloadV2): number {
    let written = 0;
    for (const kind of SYNC_KINDS) {
      for (const record of payload[kind] ?? []) {
        const key = `${kind}:${record.id}`;
        const current = this.records.get(key);
        if (
          current &&
          current.updated_at === record.updated_at &&
          current.encrypted_payload === record.encrypted_payload &&
          (current.deleted_at ?? null) === (record.deleted_at ?? null)
        ) {
          continue;
        }
        this.records.set(key, { ...record });
        written += 1;
      }
    }
    if (written > 0) {
      this.revision += 1;
    }
    return this.revision;
  }

  snapshot(): SyncPayloadV2 {
    const payload = Object.fromEntries(
      SYNC_KINDS.map(kind => [kind, [] as SyncRecord[]]),
    ) as unknown as SyncPayloadV2;
    for (const [key, record] of this.records) {
      const kind = key.slice(0, key.indexOf(':')) as SyncKind;
      payload[kind].push(record);
    }
    return payload;
  }

  liveIds(kind: SyncKind): string[] {
    return [...this.records.entries()]
      .filter(([key, record]) => key.startsWith(`${kind}:`) && !record.deleted_at)
      .map(([, record]) => record.id)
      .sort();
  }

  /** 다른 기기가 지운 것처럼 tombstone 을 심는다. */
  deleteRecord(kind: SyncKind, id: string, deletedAt: string): void {
    this.records.set(`${kind}:${id}`, {
      id,
      encrypted_payload: '',
      updated_at: deletedAt,
      deleted_at: deletedAt,
    });
    this.revision += 1;
  }
}

let server: FakeSyncServer;
let pushBlocked = false;
let pullBlocked = false;
const pushedPayloads: SyncPayloadV2[] = [];

function jsonResponse(body: unknown, status = 200, etag?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'etag' ? (etag ?? null) : null,
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
  async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/info') {
      return jsonResponse({
        serverVersion: 'test',
        capabilities: {
          sync: { awsProfiles: true },
          sessions: { awsSsm: true },
          vault: { e2ee: true },
        },
      });
    }
    if (path !== '/sync') {
      throw new Error(`unexpected fetch path: ${path}`);
    }
    if (init?.method === 'POST') {
      if (pushBlocked) {
        throw new Error('network request failed');
      }
      const payload = JSON.parse(String(init.body)) as SyncPayloadV2;
      pushedPayloads.push(payload);
      return jsonResponse({ revision: server.push(payload) }, 202);
    }
    if (pullBlocked) {
      throw new Error('network request failed');
    }
    const etag = `"${server.revision}"`;
    const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.[
      'If-None-Match'
    ];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return jsonResponse(null, 304, etag);
    }
    return jsonResponse(server.snapshot(), 200, etag);
  },
);

/** 다른 기기가 올린 레코드를 흉내 낸다 — 본문까지 만들어야 병합이 시각을 제대로 읽는다. */
function remoteRecord<T>(id: string, value: T, updatedAt: string): SyncRecord {
  const key = toByteArray(VAULT_KEY_BASE64);
  const iv = randomBytes(12);
  const sealed = gcm(key, iv).encrypt(
    Buffer.from(JSON.stringify(value), 'utf8'),
  );
  return {
    id,
    encrypted_payload: JSON.stringify({
      v: 1,
      iv: fromByteArray(iv),
      tag: fromByteArray(sealed.slice(sealed.length - 16)),
      ciphertext: fromByteArray(sealed.slice(0, sealed.length - 16)),
    }),
    updated_at: updatedAt,
  };
}

function authSession(): AuthSession {
  return {
    user: { id: 'user-1', email: 'scenario@example.com' },
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 900,
    },
    vaultBootstrap: { version: 1, keyBase64: VAULT_KEY_BASE64 },
    offlineLease: {
      token: 'offline-token',
      issuedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      verificationPublicKeyPem: 'public-key',
    },
    syncServerTime: '2026-08-01T00:00:00.000Z',
  };
}

function authenticated(): AuthState {
  return {
    status: 'authenticated',
    session: authSession(),
    offline: null,
    errorMessage: null,
  };
}

/** 앱을 처음 켠 상태. Keychain 은 그대로 두고(기기에 남아 있으므로) 메모리만 비운다. */
function bootApp(persisted?: {
  hosts?: ReturnType<typeof useMobileAppStore.getState>['hosts'];
  groups?: ReturnType<typeof useMobileAppStore.getState>['groups'];
  knownHosts?: ReturnType<typeof useMobileAppStore.getState>['knownHosts'];
  syncOutbox?: ReturnType<typeof useMobileAppStore.getState>['syncOutbox'];
}): void {
  resetMobileStoreRuntimeForTests();
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    // 콜드스타트는 비밀이 아직 없다 — Keychain 복원이 뒤따라 채운다.
    secureStateReady: false,
    auth: authenticated(),
    vault: { status: 'legacy', epoch: 0, migrationRequired: false },
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    groups: persisted?.groups ?? [],
    hosts: persisted?.hosts ?? [],
    awsProfiles: [],
    tailnets: [],
    snippets: [],
    knownHosts: persisted?.knownHosts ?? [],
    secretMetadata: [],
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    activeSessionTabId: null,
    activeConnectionTab: null,
    secretsByRef: {},
    syncOutbox: persisted?.syncOutbox ?? [],
    syncOutboxFailure: null,
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
    pendingCredentialRetry: null,
  });
}

/** 기기에 남아 있는 것(저장소 + Keychain)만 들고 앱을 다시 켠다. */
function restartApp(): void {
  const state = useMobileAppStore.getState();
  bootApp({
    hosts: state.hosts,
    groups: state.groups,
    knownHosts: state.knownHosts,
    syncOutbox: state.syncOutbox,
  });
}

async function restoreSecrets(): Promise<void> {
  await act(async () => {
    useMobileAppStore.getState().ensureSecureStateRestored();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function sync(): Promise<void> {
  await act(async () => {
    await useMobileAppStore.getState().syncNow();
  });
}

/** 네트워크가 살아 있으면 큐가 빌 때까지 몇 회차 돌려 본다(폴링을 대신한다). */
async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (useMobileAppStore.getState().syncOutbox.length === 0) {
      break;
    }
    await sync();
  }
}

function localHostIds(): string[] {
  return useMobileAppStore
    .getState()
    .hosts.map(host => host.id)
    .sort();
}

function localSecretPassword(secretRef: string): string | undefined {
  return useMobileAppStore.getState().secretsByRef[secretRef]?.password;
}

async function addHostWithPassword(
  label: string,
  password: string,
): Promise<{ hostId: string; secretRef: string }> {
  await act(async () => {
    await useMobileAppStore.getState().saveHost({
      label,
      hostname: `${label}.example.com`,
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      groupName: null,
      credentials: { password },
    });
  });
  const created = useMobileAppStore
    .getState()
    .hosts.filter(isSshHostRecord)
    .find(host => host.hostname === `${label}.example.com`);
  if (!created?.secretRef) {
    throw new Error(`host was not created with a credential: ${label}`);
  }
  return { hostId: created.id, secretRef: created.secretRef };
}

describe('sync survives the awkward orders', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    resetMobileStoreRuntimeForTests();
  });

  beforeEach(async () => {
    server = new FakeSyncServer();
    pushBlocked = false;
    pullBlocked = false;
    pushedPayloads.length = 0;
    mockKeychainStore.clear();
    mockKeychainFlags.readFails = false;
    jest.clearAllMocks();
    bootApp();
    await restoreSecrets();
  });

  it('오프라인에서 만든 호스트와 비밀번호가 복귀 후 올라간다', async () => {
    pushBlocked = true;
    pullBlocked = true;
    const { hostId, secretRef } = await addHostWithPassword('nas', 'hunter2');
    await sync();

    expect(localHostIds()).toEqual([hostId]);
    expect(localSecretPassword(secretRef)).toBe('hunter2');

    pushBlocked = false;
    pullBlocked = false;
    await settle();

    expect(server.liveIds('hosts')).toEqual([hostId]);
    expect(server.liveIds('secrets')).toEqual([secretRef]);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
    expect(localSecretPassword(secretRef)).toBe('hunter2');
  });

  it('밀기만 막히고 당기기가 되는 동안에도 로컬이 남는다', async () => {
    // 서버에는 다른 기기가 올려 둔 것이 있다 — 그래서 당기기가 200 을 준다.
    pushBlocked = true;
    const { hostId, secretRef } = await addHostWithPassword('lab', 'lab-pass');
    await sync();
    await sync();

    expect(localHostIds()).toEqual([hostId]);
    expect(localSecretPassword(secretRef)).toBe('lab-pass');

    pushBlocked = false;
    await settle();
    expect(server.liveIds('hosts')).toEqual([hostId]);
    expect(server.liveIds('secrets')).toEqual([secretRef]);
  });

  it('오프라인 편집 후 앱을 껐다 켜도(비밀 복원이 늦어도) 잃지 않는다', async () => {
    pushBlocked = true;
    pullBlocked = true;
    const { hostId, secretRef } = await addHostWithPassword('rtu', 'rtu-pass');

    // 앱 종료 → 재실행. ETag 는 메모리라 사라지고, 첫 당기기는 전체 스냅샷을 받는다.
    restartApp();
    pushBlocked = false;
    pullBlocked = false;

    // 복원이 아직인 채로 동기화가 먼저 돈다(콜드스타트의 실제 순서).
    await sync();
    await restoreSecrets();
    await settle();

    expect(localHostIds()).toEqual([hostId]);
    expect(localSecretPassword(secretRef)).toBe('rtu-pass');
    expect(server.liveIds('secrets')).toEqual([secretRef]);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });

  it('Keychain 을 못 읽는 동안에는 아무것도 잃지 않고, 읽히면 회복한다', async () => {
    const { hostId, secretRef } = await addHostWithPassword('gw', 'gw-pass');
    await settle();
    expect(server.liveIds('secrets')).toEqual([secretRef]);

    // 다음 실행에서 Keychain 이 실패한다.
    mockKeychainFlags.readFails = true;
    restartApp();
    await restoreSecrets();
    await sync();

    // 비밀을 못 읽는 채로 서버 값을 얹어 로컬을 망가뜨리지 않는다.
    expect(localHostIds()).toEqual([hostId]);
    expect(useMobileAppStore.getState().secureStateReady).toBe(false);

    mockKeychainFlags.readFails = false;
    await restoreSecrets();
    await settle();
    expect(localSecretPassword(secretRef)).toBe('gw-pass');
  });

  it('다른 기기가 지운 호스트는 따라 지운다', async () => {
    const { hostId } = await addHostWithPassword('old', 'old-pass');
    await settle();
    expect(server.liveIds('hosts')).toEqual([hostId]);

    server.deleteRecord('hosts', hostId, '2099-01-01T00:00:00.000Z');
    await sync();

    expect(localHostIds()).toEqual([]);
  });

  it('서버가 그대로면 당겨도 아무것도 바뀌지 않는다', async () => {
    const { hostId, secretRef } = await addHostWithPassword('idle', 'idle-pass');
    await settle();

    const revisionBefore = server.revision;
    await sync();
    await sync();

    expect(server.revision).toBe(revisionBefore);
    expect(localHostIds()).toEqual([hostId]);
    expect(localSecretPassword(secretRef)).toBe('idle-pass');
  });

  it('밀기가 반복해서 실패해도 큐는 남고, 회복되면 전부 올라간다', async () => {
    pushBlocked = true;
    const first = await addHostWithPassword('a', 'pass-a');
    await sync();
    const second = await addHostWithPassword('b', 'pass-b');
    await sync();
    await sync();

    expect(localHostIds()).toEqual([first.hostId, second.hostId].sort());

    pushBlocked = false;
    await settle();

    expect(server.liveIds('hosts')).toEqual(
      [first.hostId, second.hostId].sort(),
    );
    expect(server.liveIds('secrets')).toEqual(
      [first.secretRef, second.secretRef].sort(),
    );
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });
  it('빈 서버로 복구할 때도 비밀을 함께 올린다', async () => {
    // 서버가 초기화된 계정. 로컬을 재업로드하는 경로가 도는데, 그때 비밀이 빠지면
    // 다른 기기에는 "자격증명이 달린 호스트" 만 생기고 실제 비밀번호는 없다.
    const { hostId, secretRef } = await addHostWithPassword('reset', 'reset-pass');
    await settle();
    expect(server.liveIds('secrets')).toEqual([secretRef]);

    // 서버가 통째로 비워졌다(초기화/유실). 클라이언트는 로컬로 복구해야 한다.
    server = new FakeSyncServer();
    restartApp();
    await restoreSecrets();
    await sync();
    await settle();

    expect(server.liveIds('hosts')).toEqual([hostId]);
    expect(server.liveIds('secrets')).toEqual([secretRef]);
  });

  it('큐가 사라져도 다음 동기화가 스스로 올린다', async () => {
    // 로컬에는 남았는데 큐 항목만 없어진 경우(저장 직후 앱이 죽는 등). 예전에는 올라가지도
    // 지워지지도 않는 유령이 됐다 — 병합이 "서버에 없는 로컬" 을 찾아 다시 큐에 넣는다.
    pushBlocked = true;
    const { hostId, secretRef } = await addHostWithPassword('ghost', 'ghost-pass');
    useMobileAppStore.setState({ syncOutbox: [] });

    pushBlocked = false;
    await sync();
    await settle();

    expect(server.liveIds('hosts')).toEqual([hostId]);
    expect(server.liveIds('secrets')).toEqual([secretRef]);
  });

  it('다른 기기가 같은 호스트를 더 늦게 고쳤으면 그쪽이 이긴다', async () => {
    const { hostId } = await addHostWithPassword('shared', 'shared-pass');
    await settle();

    // 데스크톱이 라벨을 바꿔 올린 것처럼, 서버 레코드를 더 최신 타임스탬프로 바꾼다.
    const snapshot = server.snapshot();
    const remoteHost = snapshot.hosts.find(record => record.id === hostId)!;
    server.push({
      ...snapshot,
      hosts: [
        {
          ...remoteHost,
          updated_at: '2099-01-01T00:00:00.000Z',
        },
      ],
    });

    await sync();

    // 로컬이 더 오래됐으므로 서버 것을 따른다 — 그리고 그것을 다시 밀어 올리지 않는다.
    expect(useMobileAppStore.getState().hosts).toHaveLength(1);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });

  it('오프라인에서 지운 호스트는 복귀 후 서버에서도 지워진다', async () => {
    const { hostId, secretRef } = await addHostWithPassword('gone', 'gone-pass');
    await settle();
    expect(server.liveIds('hosts')).toEqual([hostId]);

    pushBlocked = true;
    pullBlocked = true;
    await act(async () => {
      await useMobileAppStore.getState().deleteHost(hostId);
    });
    expect(localHostIds()).toEqual([]);

    pushBlocked = false;
    pullBlocked = false;
    await settle();

    expect(server.liveIds('hosts')).toEqual([]);
    // 되살아나지 않는다.
    await sync();
    expect(localHostIds()).toEqual([]);
    expect(secretRef).toBeTruthy();
  });

  it('오프라인에서 같은 호스트를 여러 번 고쳐도 마지막 값만 올라간다', async () => {
    pushBlocked = true;
    pullBlocked = true;
    const { hostId } = await addHostWithPassword('multi', 'first');

    for (const password of ['second', 'third']) {
      await act(async () => {
        await useMobileAppStore.getState().saveHost({
          hostId,
          label: 'multi',
          hostname: 'multi.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          groupName: null,
          credentialMode: 'replace',
          credentials: { password },
        });
      });
    }

    pushBlocked = false;
    pullBlocked = false;
    await settle();

    const secretRef = useMobileAppStore
      .getState()
      .hosts.filter(isSshHostRecord)
      .find(host => host.id === hostId)?.secretRef;
    expect(secretRef).toBeTruthy();
    expect(localSecretPassword(secretRef!)).toBe('third');
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
    expect(server.liveIds('secrets')).toEqual([secretRef]);
  });
  it('오프라인에서 만든 그룹과 그 안의 호스트가 함께 올라간다', async () => {
    pushBlocked = true;
    pullBlocked = true;
    await act(async () => {
      await useMobileAppStore.getState().createGroup('work', null);
    });
    const { hostId } = await addHostWithPassword('in-group', 'pw');
    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId,
        label: 'in-group',
        hostname: 'in-group.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
        groupName: 'work',
        credentialMode: 'preserve',
      });
    });

    pushBlocked = false;
    pullBlocked = false;
    await settle();

    expect(server.liveIds('groups')).toHaveLength(1);
    expect(server.liveIds('hosts')).toEqual([hostId]);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
    expect(
      useMobileAppStore.getState().groups.map(group => group.path),
    ).toEqual(['work']);
  });

  it('오프라인에서 그룹 이름을 바꾸면 그 아래 호스트도 함께 올라간다', async () => {
    await act(async () => {
      await useMobileAppStore.getState().createGroup('old', null);
    });
    const { hostId } = await addHostWithPassword('member', 'pw');
    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId,
        label: 'member',
        hostname: 'member.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
        groupName: 'old',
        credentialMode: 'preserve',
      });
    });
    await settle();

    pushBlocked = true;
    pullBlocked = true;
    await act(async () => {
      await useMobileAppStore.getState().renameGroup('old', 'new');
    });

    pushBlocked = false;
    pullBlocked = false;
    await settle();

    // 그룹 경로가 바뀌면 그 아래 호스트의 groupName 도 바뀐다 — 둘이 어긋나면 안 된다.
    expect(
      useMobileAppStore.getState().groups.map(group => group.path),
    ).toEqual(['new']);
    const host = useMobileAppStore
      .getState()
      .hosts.find(record => record.id === hostId);
    expect(host?.groupName).toBe('new');
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);

    // 서버도 같은 상태여야 한다 — 다시 당겨도 되돌아가지 않는다.
    await sync();
    expect(
      useMobileAppStore.getState().groups.map(group => group.path),
    ).toEqual(['new']);
  });

  it('오프라인에서 그룹을 지우면 하위 호스트까지 서버에 반영된다', async () => {
    await act(async () => {
      await useMobileAppStore.getState().createGroup('doomed', null);
    });
    const { hostId } = await addHostWithPassword('child', 'pw');
    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId,
        label: 'child',
        hostname: 'child.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
        groupName: 'doomed',
        credentialMode: 'preserve',
      });
    });
    await settle();
    expect(server.liveIds('hosts')).toEqual([hostId]);

    pushBlocked = true;
    pullBlocked = true;
    await act(async () => {
      await useMobileAppStore.getState().removeGroup('doomed', 'delete-subtree');
    });
    expect(localHostIds()).toEqual([]);

    pushBlocked = false;
    pullBlocked = false;
    await settle();

    expect(server.liveIds('hosts')).toEqual([]);
    expect(server.liveIds('groups')).toEqual([]);
    await sync();
    expect(localHostIds()).toEqual([]);
  });
  it('로그아웃하면 큐도 함께 비운다', async () => {
    // 계정 경계가 바뀌면 로컬 데이터도 큐도 비운다. 큐만 남기면 다음에 **다른 계정**으로
    // 로그인했을 때 그 계정으로 밀려 나간다 — 삭제 항목은 로컬 레코드 없이도 스스로 밀린다.
    // 대신 아직 안 올린 변경은 함께 사라진다. 로컬 데이터를 비우는 것과 같은 대가다.
    pushBlocked = true;
    await addHostWithPassword('doomed', 'pw');
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(2);

    await act(async () => {
      await useMobileAppStore.getState().logout();
    });

    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
    expect(useMobileAppStore.getState().hosts).toEqual([]);
  });

  it('동기화가 겹쳐 돌아도 큐를 두 번 밀지 않는다', async () => {
    const { hostId, secretRef } = await addHostWithPassword('race', 'race-pass');

    await act(async () => {
      await Promise.all([
        useMobileAppStore.getState().syncNow(),
        useMobileAppStore.getState().syncNow(),
        useMobileAppStore.getState().flushSyncOutbox(),
      ]);
    });
    await settle();

    expect(server.liveIds('hosts')).toEqual([hostId]);
    expect(server.liveIds('secrets')).toEqual([secretRef]);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });

  it('오프라인에서 신뢰한 호스트 키가 복귀 후 올라간다', async () => {
    pushBlocked = true;
    pullBlocked = true;
    const knownHost = {
      id: 'known-1',
      host: 'nas.example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAAA',
      fingerprintSha256: 'abc',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    act(() => {
      useMobileAppStore.setState(state => ({
        knownHosts: [...state.knownHosts, knownHost],
        syncOutbox: [
          ...state.syncOutbox,
          { kind: 'knownHosts', id: knownHost.id, op: 'upsert' },
        ],
      }));
    });

    pushBlocked = false;
    pullBlocked = false;
    await settle();

    expect(server.liveIds('knownHosts')).toEqual(['known-1']);
    expect(useMobileAppStore.getState().knownHosts).toHaveLength(1);
  });
  it('서버를 바꾸면 큐도 함께 비운다', async () => {
    // 로그아웃과 같은 계정 경계다. 큐만 남기면 **새 서버**로 옛 서버의 변경이 밀려 나간다 —
    // 삭제 항목은 로컬 레코드 없이도 스스로 밀리므로 남의 서버에 툼스톤을 쓴다.
    pushBlocked = true;
    await addHostWithPassword('old-server', 'pw');
    expect(useMobileAppStore.getState().syncOutbox.length).toBeGreaterThan(0);

    await act(async () => {
      await useMobileAppStore
        .getState()
        .updateSettings({ serverUrl: 'https://other.example.com' });
    });

    expect(useMobileAppStore.getState().hosts).toEqual([]);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });
  it('서버에 더 최신 값이 있으면 큐에 남은 옛 값이 그것을 되돌리지 않는다', async () => {
    // 서버 upsert 는 타임스탬프를 비교하지 않고 덮어쓴다. 그래서 밀기가 실패해 큐에 남은
    // 옛 값이, 적용 도중에 밀려 나가면 다른 기기의 최신 편집을 지운다.
    const { hostId } = await addHostWithPassword('contested', 'pw');
    await settle();

    // 밀기를 막아 큐에 옛 값이 남게 한 뒤, 데스크톱이 더 최신으로 고친 것처럼 만든다.
    pushBlocked = true;
    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId,
        label: 'local older',
        hostname: 'contested.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
        groupName: null,
        credentialMode: 'preserve',
      });
    });
    const desktopEdit = {
      id: hostId,
      kind: 'ssh',
      label: 'desktop newer',
      hostname: 'contested.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      secretRef: null,
      groupName: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    server.push({
      ...server.snapshot(),
      hosts: [
        remoteRecord(hostId, desktopEdit, '2099-01-01T00:00:00.000Z'),
      ],
    });
    const remoteRevision = server.revision;

    // 당기기만 되는 상태에서 적용한다.
    await sync();

    // 서버 레코드가 옛 값으로 되돌아가지 않았다.
    const afterPull = server
      .snapshot()
      .hosts.find(record => record.id === hostId)!;
    expect(afterPull.updated_at).toBe('2099-01-01T00:00:00.000Z');
    expect(server.revision).toBe(remoteRevision);
    // 로컬도 서버의 최신을 따랐다.
    expect(
      useMobileAppStore
        .getState()
        .hosts.find(record => record.id === hostId)?.label,
    ).toBe('desktop newer');

    // 밀기가 살아나도 마찬가지다 — 로컬은 이미 서버의 최신을 따랐다.
    pushBlocked = false;
    await settle();
    const settled = server
      .snapshot()
      .hosts.find(record => record.id === hostId)!;
    expect(settled.updated_at).toBe('2099-01-01T00:00:00.000Z');
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });
});
