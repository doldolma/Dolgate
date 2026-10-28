import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import type {
  AuthSession,
  SyncPayloadV2,
  SyncRecord,
  SyncWatchLoopOptions,
} from '@dolssh/shared-core';
import {
  computeVaultDekVerifier,
  createVaultKdfDescriptor,
  normalizeTeamHostCredentials,
  normalizeTeamHostPrefsRecord,
  openTeamEventBody,
  wrapTeamDek,
  wrapVaultDek,
} from '@dolssh/shared-core';
import { fromByteArray, toByteArray } from 'base64-js';
import { Buffer } from 'buffer';
import {
  buildEmptySyncPayload,
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  decodeSyncRecords,
} from '../src/lib/mobile';
import {
  createTeamSync,
  type PersonalVaultRecords,
  type TeamSyncAccess,
  type TeamSyncStoreState,
} from '../src/store/team-sync';
import {
  registerSftpRuntimeForTests,
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from '../src/store/useMobileAppStore';

// 폰의 팀 받기(작업 8-2). 서버는 실제 규약대로 흉내 낸다 — 팀 목록, 팀마다 레코드·내 개인 칸·감시(조건부 GET 과
// 리비전 셋), 빠진 사람에게 404(team_not_found), 낡은 앱에게 426(team_client_outdated).

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));

// Keychain 을 진짜처럼 흉내 낸다 — service 별 저장소.
const mockKeychainStore = new Map<string, string>();

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  },
  getGenericPassword: jest.fn(async (options?: { service?: string }) => {
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

const TEAM_SECRETS_SERVICE = 'dolgate.mobile.team-secrets';
const SERVER_URL = 'https://sync.example.com';
const UPDATED_AT = '2026-10-27T00:00:00.000Z';
const PERSONAL_DEK = randomBytes(32);
const PERSONAL_DEK_BASE64 = fromByteArray(PERSONAL_DEK);

function json(body: unknown, status = 200, etag?: string): Response {
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

/** 클라이언트가 쓰는 봉투로 잠근 레코드 한 건. */
function sealed<T>(
  id: string,
  value: T,
  keyBase64: string,
  updatedAt = UPDATED_AT,
): SyncRecord {
  const iv = randomBytes(12);
  const box = gcm(toByteArray(keyBase64), iv).encrypt(
    Buffer.from(JSON.stringify(value), 'utf8'),
  );
  return {
    id,
    encrypted_payload: JSON.stringify({
      v: 1,
      iv: fromByteArray(iv),
      tag: fromByteArray(box.slice(box.length - 16)),
      ciphertext: fromByteArray(box.slice(0, box.length - 16)),
    }),
    updated_at: updatedAt,
  };
}

function sshHost(
  id: string,
  label: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind: 'ssh',
    label,
    hostname: `${label}.internal`,
    port: 22,
    username: 'ops',
    authType: 'password',
    groupName: null,
    tags: [],
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...extra,
  };
}

interface FakeTeam {
  id: string;
  name: string;
  role: string;
  wrappedTeamDek: string | null;
  dekBase64: string;
  records: Record<string, SyncRecord[]>;
  private: Record<string, SyncRecord[]>;
  revision: number;
  infoRevision: number;
  privateRevision: number;
  /** false 면 그 팀 경로가 404(team_not_found)다 — 빠진 사람. */
  member: boolean;
  /** true 면 그 팀 경로가 426(team_client_outdated)이다. */
  outdated: boolean;
}

function newTeam(
  id: string,
  name: string,
  options?: { wrapWith?: Uint8Array | null },
): FakeTeam {
  const dek = randomBytes(32);
  const wrapWith =
    options?.wrapWith === undefined ? PERSONAL_DEK : options.wrapWith;
  return {
    id,
    name,
    role: 'member',
    wrappedTeamDek: wrapWith ? wrapTeamDek(dek, wrapWith, id) : null,
    dekBase64: fromByteArray(dek),
    records: {},
    private: {},
    revision: 1,
    infoRevision: 1,
    privateRevision: 1,
    member: true,
    outdated: false,
  };
}

class FakeTeamServer {
  teamsEnabled = true;
  /** false 면 /api/info 가 팀 기록을 모른다(옛 자체 호스팅). */
  historyEnabled = true;
  /** 팀 기록에 올라온 줄 — 팀마다, 같은 id 는 한 번만(실제 서버처럼). */
  events = new Map<
    string,
    Array<{ id: string; createdAt: string; payload: string }>
  >();
  /** true 면 팀 기록 올리기가 네트워크에서 끊긴다(오프라인). */
  eventsOffline = false;
  /** true 면 팀 기록 올리기가 400 이다(서버가 받을 수 없는 묶음). */
  rejectEvents = false;
  teams: FakeTeam[] = [];
  requests: string[] = [];
  /** 이 토큰이면 401 이다(만료). */
  expiredToken: string | null = null;
  /** 있으면 팀 레코드(/sync) 응답을 이것이 풀릴 때까지 붙든다. */
  holdRecords: Promise<void> | null = null;
  /** 개인 /sync 에 올라온 것. */
  pushedPersonal: SyncPayloadV2[] = [];
  /** true 면 개인 /sync 와 토큰 갱신이 401 이다(세션 만료). */
  personalExpired = false;
  /** true 면 바뀐 것이 없는 감시를 실제 서버처럼 붙들고 있다(끊길 때까지). */
  holdWatch = false;
  /** 붙들고 있는 감시 — 끊겼는지(aborted)까지. */
  heldWatches: Array<{ path: string; aborted: boolean }> = [];
  /** true 면 내 개인 칸 올리기(PUT /me)가 네트워크에서 끊긴다(오프라인). */
  privateOffline = false;
  /** 있으면 내 개인 칸 올리기(PUT /me)를 이것이 풀릴 때까지 붙든다(받은 뒤 답하기 전). */
  holdPrivatePush: Promise<void> | null = null;
  /** 내 개인 칸에 올라온 것 — 팀·내용·세대 헤더. */
  pushedPrivate: Array<{
    teamId: string;
    payload: Record<string, SyncRecord[]>;
    epoch: string | undefined;
  }> = [];

  private hold(path: string, signal?: AbortSignal | null): Promise<Response> {
    const held = { path, aborted: false };
    this.heldWatches.push(held);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        held.aborted = true;
        reject(new Error('aborted'));
      };
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener('abort', abort);
      }
    });
  }

  team(id: string): FakeTeam {
    const team = this.teams.find(item => item.id === id);
    if (!team) {
      throw new Error(`no team ${id}`);
    }
    return team;
  }

  async handle(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${path}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (path === '/api/info') {
      return json({
        serverVersion: 'test',
        capabilities: {
          sync: { awsProfiles: true },
          sessions: { awsSsm: true },
          vault: { e2ee: true },
          ...(this.teamsEnabled
            ? {
                teams: {
                  enabled: true,
                  ...(this.historyEnabled
                    ? {
                        history: {
                          replayMaxCount: 100,
                          replayMaxBytes: 1 << 30,
                          replayMaxBytesPerRecording: 1 << 28,
                          segmentMaxBytes: 1 << 20,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        },
      });
    }
    if (path === '/sync') {
      if (this.personalExpired) {
        return json(
          { error: '세션이 만료되었습니다.', code: 'auth_expired' },
          401,
        );
      }
      if (method === 'POST') {
        this.pushedPersonal.push(
          JSON.parse(String(init?.body)) as SyncPayloadV2,
        );
        return json({ revision: 2 }, 202);
      }
      return json(buildEmptySyncPayload(), 200, '"1"');
    }
    if (path === '/auth/logout') {
      return json({}, 200);
    }
    if (path === '/sync/watch') {
      // 개인 감시 — 이 시험들은 팀만 본다. 끊길 때까지 붙든다.
      return this.hold(path, init?.signal);
    }
    if (path === '/auth/refresh') {
      return json(
        { error: '세션이 만료되었습니다.', code: 'auth_expired' },
        401,
      );
    }
    if (path === '/auth/vault/reset' && method === 'POST') {
      return json({ epoch: 2 });
    }
    const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (this.expiredToken && token === this.expiredToken) {
      return json({ error: '만료', code: 'auth_expired' }, 401);
    }
    if (path === '/teams') {
      return json({
        teams: this.teams
          .filter(team => team.member)
          .map(team => ({
            id: team.id,
            name: team.name,
            role: team.role,
            wrappedTeamDek: team.wrappedTeamDek ?? '',
            dataFloor: 0,
            memberCount: 2,
            createdAt: UPDATED_AT,
          })),
      });
    }
    const match = path.match(
      /^\/teams\/([^/]+)\/(sync|me|sync\/watch|events)$/,
    );
    if (!match) {
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }
    const team = this.teams.find(
      item => item.id === decodeURIComponent(match[1]),
    );
    if (!team || !team.member) {
      return json(
        { error: '팀을 찾을 수 없습니다.', code: 'team_not_found' },
        404,
      );
    }
    if (team.outdated) {
      return json(
        { error: '앱을 업데이트해 주세요.', code: 'team_client_outdated' },
        426,
      );
    }
    const ifNoneMatch = headers['If-None-Match'];
    if (match[2] === 'events' && method === 'POST') {
      if (this.eventsOffline) {
        throw new TypeError('Network request failed');
      }
      const body = JSON.parse(String(init?.body)) as {
        events: Array<{ id: string; createdAt: string; payload: string }>;
      };
      const canonical =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      if (
        this.rejectEvents ||
        body.events.length === 0 ||
        body.events.length > 100 ||
        body.events.some(
          event =>
            !canonical.test(event.id) ||
            Number.isNaN(Date.parse(event.createdAt)) ||
            !event.payload,
        )
      ) {
        return json({ error: '잘못된 요청입니다.' }, 400);
      }
      const kept = this.events.get(team.id) ?? [];
      let accepted = 0;
      for (const event of body.events) {
        if (!kept.some(item => item.id === event.id)) {
          kept.push(event);
          accepted += 1;
        }
      }
      this.events.set(team.id, kept);
      return json({ accepted });
    }
    if (match[2] === 'sync') {
      if (this.holdRecords) {
        await this.holdRecords;
      }
      const etag = `"${team.revision}"`;
      return ifNoneMatch === etag
        ? json(null, 304, etag)
        : json(team.records, 200, etag);
    }
    if (match[2] === 'me' && method === 'PUT') {
      if (this.privateOffline) {
        throw new TypeError('Network request failed');
      }
      const payload = JSON.parse(String(init?.body)) as Record<
        string,
        SyncRecord[]
      >;
      this.pushedPrivate.push({
        teamId: team.id,
        payload,
        epoch: headers['X-Dolgate-Vault-Epoch'],
      });
      // 실제 서버처럼 레코드마다 나중 것만 받는다(updated_at).
      for (const [kind, records] of Object.entries(payload)) {
        const kept = [...(team.private[kind] ?? [])];
        for (const record of records) {
          const at = kept.findIndex(item => item.id === record.id);
          if (at < 0) {
            kept.push(record);
          } else if (
            Date.parse(kept[at].updated_at) <= Date.parse(record.updated_at)
          ) {
            kept[at] = record;
          }
        }
        team.private[kind] = kept;
      }
      team.privateRevision += 1;
      if (this.holdPrivatePush) {
        await this.holdPrivatePush;
      }
      return json({ revision: team.privateRevision }, 202);
    }
    if (match[2] === 'me') {
      const etag = `"${team.privateRevision}"`;
      return ifNoneMatch === etag
        ? json(null, 304, etag)
        : json(team.private, 200, etag);
    }
    const etag = `"${team.revision}.${team.infoRevision}.${team.privateRevision}"`;
    if (this.holdWatch && ifNoneMatch === etag) {
      return this.hold(path, init?.signal);
    }
    return ifNoneMatch === etag
      ? json(null, 304, etag)
      : json(
          {
            revision: team.revision,
            infoRevision: team.infoRevision,
            privateRevision: team.privateRevision,
          },
          200,
          etag,
        );
  }
}

let server: FakeTeamServer;
const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
  (input, init) => server.handle(input, init),
);

/** 데스크톱이 올린 것 같은 팀 하나 — 호스트·그룹·호스트 키·비밀값·AWS·tailnet·스니펫과 내 개인 칸. */
function acmeTeam(): FakeTeam {
  const team = newTeam('team-acme', 'Acme Infra');
  const key = team.dekBase64;
  team.records = {
    hosts: [
      // 옛 앱이 레코드에 남긴 사람마다 다른 값(별표·agent forwarding)은 받을 때 뺀다.
      sealed(
        'acme-app',
        sshHost('acme-app', 'app', {
          secretRef: 'acme-secret',
          jumpHostIds: ['acme-bastion'],
          favorite: true,
          agentForwarding: true,
        }),
        key,
      ),
      sealed('acme-bastion', sshHost('acme-bastion', 'bastion'), key),
    ],
    groups: [
      sealed(
        'acme-group',
        {
          id: 'acme-group',
          name: 'prod',
          path: 'prod',
          parentPath: null,
          createdAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
        key,
      ),
    ],
    knownHosts: [
      sealed(
        'acme-known',
        {
          id: 'acme-known',
          host: 'app.internal',
          port: 22,
          algorithm: 'ssh-ed25519',
          publicKeyBase64: 'TEAM-KEY',
          fingerprintSha256: 'SHA256:team',
          createdAt: UPDATED_AT,
          lastSeenAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
        key,
      ),
    ],
    secrets: [
      sealed(
        'acme-secret',
        {
          secretRef: 'acme-secret',
          label: 'app',
          password: 'team-pw',
          updatedAt: UPDATED_AT,
        },
        key,
      ),
    ],
    awsProfiles: [
      // 사람의 키가 섞여 왔어도 담지 않는다.
      sealed(
        'acme-aws',
        {
          id: 'acme-aws',
          name: 'acme',
          kind: 'static',
          region: 'ap-northeast-2',
          accessKeyId: 'AKIA-LEAK',
          secretAccessKey: 'leak',
          updatedAt: UPDATED_AT,
        },
        key,
      ),
    ],
    tailnets: [
      sealed(
        'acme-tailnet',
        {
          id: 'acme-tailnet',
          label: 'acme',
          authKey: 'tskey-leak',
          loginName: 'someone@acme',
          createdAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
        key,
      ),
    ],
    snippets: [
      sealed(
        'acme-snippet',
        {
          id: 'acme-snippet',
          label: 'deploy',
          command: './deploy.sh',
          createdAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
        key,
      ),
    ],
    // 모바일이 모르는 종류는 그대로 둔다(담지 않을 뿐).
    portForwards: [sealed('acme-forward', { id: 'acme-forward' }, key)],
  };
  team.private = {
    hostPrefs: [
      sealed(
        'acme-app',
        {
          id: 'acme-app',
          favorite: true,
          agentForwarding: true,
          rdpCertificateFingerprint: null,
          knownHosts: [],
          updatedAt: UPDATED_AT,
        },
        PERSONAL_DEK_BASE64,
      ),
    ],
    hostCredentials: [
      sealed(
        'acme-bastion',
        {
          id: 'acme-bastion',
          updatedAt: UPDATED_AT,
          credentials: { username: 'me', password: 'my-pw' },
        },
        PERSONAL_DEK_BASE64,
      ),
    ],
  };
  return team;
}

function emptyPersonal(): PersonalVaultRecords {
  return {
    hosts: [],
    groups: [],
    knownHosts: [],
    awsProfiles: [],
    tailnets: [],
    snippets: [],
    secretsByRef: {},
  };
}

function harness(options?: {
  foreground?: boolean;
  personal?: Partial<PersonalVaultRecords>;
  onTeamForgotten?: (teamId: string, hostIds: ReadonlySet<string>) => void;
}) {
  const state: TeamSyncStoreState = {
    ...emptyPersonal(),
    ...options?.personal,
    teamVaults: [],
    teamSecrets: {},
  };
  let access: TeamSyncAccess | null = {
    serverUrl: SERVER_URL,
    accessToken: 'access-token',
    personalDekBase64: PERSONAL_DEK_BASE64,
    vaultEpoch: 7,
    generation: 1,
  };
  const loops: SyncWatchLoopOptions[] = [];
  const refreshAccessToken = jest.fn(async () => 'fresh-token');
  const sync = createTeamSync({
    readAccess: () => (access ? { ...access } : null),
    refreshAccessToken,
    getState: () => state,
    setState: patch => Object.assign(state, patch),
    isForeground: () => options?.foreground ?? true,
    onTeamForgotten: options?.onTeamForgotten,
    startLoop: loopOptions => {
      loops.push(loopOptions);
      return { stop: jest.fn(), retryNow: jest.fn() };
    },
  });
  return {
    state,
    sync,
    loops,
    refreshAccessToken,
    setAccess(next: TeamSyncAccess | null) {
      access = next;
    },
    access: () => access,
  };
}

/** 감시 한 바퀴 — 기다렸다 바뀌었으면 당긴다(루프가 하는 것과 같다). */
async function watchOnce(loop: SyncWatchLoopOptions): Promise<string> {
  const outcome = await loop.watch(new AbortController().signal);
  if (outcome === 'changed') {
    await loop.onChange();
  }
  return outcome;
}

function storedTeamSecrets(): Record<string, unknown> {
  const raw = mockKeychainStore.get(TEAM_SECRETS_SERVICE);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe('team sync', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    server = new FakeTeamServer();
    mockKeychainStore.clear();
    fetchMock.mockClear();
  });

  it('팀 목록을 받아 팀마다 레코드와 내 개인 칸을 풀어 따로 담는다', async () => {
    server.teams = [acmeTeam()];
    const { state, sync } = harness();

    await sync.refresh();

    expect(state.teamVaults).toHaveLength(1);
    const vault = state.teamVaults[0];
    expect(vault).toMatchObject({
      id: 'team-acme',
      name: 'Acme Infra',
      role: 'member',
      state: 'ready',
    });
    expect(vault.hosts.map(host => host.id)).toEqual([
      'acme-app',
      'acme-bastion',
    ]);
    // 레코드에 남은 사람마다 다른 값은 뺐다.
    expect(vault.hosts[0]).toMatchObject({
      favorite: null,
      agentForwarding: null,
    });
    expect(vault.groups.map(group => group.id)).toEqual(['acme-group']);
    expect(vault.knownHosts.map(record => record.publicKeyBase64)).toEqual([
      'TEAM-KEY',
    ]);
    // 사람의 키는 담지 않는다.
    expect(vault.awsProfiles[0]).toMatchObject({
      id: 'acme-aws',
      accessKeyId: '',
      secretAccessKey: '',
    });
    expect(vault.tailnets[0]).not.toHaveProperty('authKey');
    expect(vault.tailnets[0]).not.toHaveProperty('loginName');
    expect(vault.snippets.map(snippet => snippet.id)).toEqual(['acme-snippet']);
    // 내 개인 칸.
    expect(vault.hostPrefs).toEqual([
      expect.objectContaining({
        id: 'acme-app',
        favorite: true,
        agentForwarding: true,
      }),
    ]);
    expect(state.teamSecrets['team-acme']).toEqual({
      secretsByRef: {
        'acme-secret': expect.objectContaining({ password: 'team-pw' }),
      },
      hostCredentials: {
        'acme-bastion': { username: 'me', password: 'my-pw' },
      },
    });
    // 비밀값은 키체인에, 개인 칸은 그대로다.
    expect(storedTeamSecrets()).toEqual(state.teamSecrets);
    expect(state.hosts).toEqual([]);
    expect(state.secretsByRef).toEqual({});
  });

  it('팀 키 사본이 없거나 안 풀리면 그 팀만 다시 들어와야 함이다', async () => {
    const noCopy = newTeam('team-no-copy', 'No copy', { wrapWith: null });
    const oldDek = newTeam('team-old-dek', 'Old DEK', {
      wrapWith: randomBytes(32),
    });
    const fine = acmeTeam();
    server.teams = [noCopy, oldDek, fine];
    const { state, sync } = harness();

    await sync.refresh();

    expect(state.teamVaults.map(vault => [vault.id, vault.state])).toEqual([
      ['team-no-copy', 'needs-rejoin'],
      ['team-old-dek', 'needs-rejoin'],
      ['team-acme', 'ready'],
    ]);
    expect(state.teamVaults[2].hosts).toHaveLength(2);
    expect(server.requests).not.toContain('GET /teams/team-no-copy/sync');
    expect(server.requests).not.toContain('GET /teams/team-old-dek/sync');
  });

  it('다른 볼트와 id 가 겹치는 팀 레코드는 버린다 — 개인이 이긴다', async () => {
    server.teams = [acmeTeam()];
    const { state, sync } = harness({
      personal: {
        hosts: [sshHost('acme-bastion', 'mine') as never],
        secretsByRef: {
          'acme-secret': {
            secretRef: 'acme-secret',
            label: 'mine',
            password: 'mine',
            updatedAt: UPDATED_AT,
          } as never,
        },
      },
    });

    await sync.refresh();

    expect(state.teamVaults[0].hosts.map(host => host.id)).toEqual([
      'acme-app',
    ]);
    expect(state.teamSecrets['team-acme']?.secretsByRef).toEqual({});
  });

  it('먼저 받은 팀이 가진 id 는 다른 팀에서 버린다', async () => {
    const first = acmeTeam();
    const second = newTeam('team-second', 'Second');
    second.records = {
      hosts: [
        sealed('acme-app', sshHost('acme-app', 'copycat'), second.dekBase64),
      ],
    };
    server.teams = [first, second];
    const { state, sync } = harness();

    await sync.refresh();

    expect(state.teamVaults[0].hosts.map(host => host.id)).toContain(
      'acme-app',
    );
    expect(state.teamVaults[1].hosts).toEqual([]);
  });

  it('감시는 바뀐 몫만 다시 받는다', async () => {
    const team = acmeTeam();
    server.teams = [team];
    const { state, sync, loops } = harness();
    await sync.refresh();
    expect(loops).toHaveLength(1);

    // 첫 감시는 바로 답한다(아는 리비전이 없다) — 다시 물어도 바뀐 것이 없다(304).
    expect(await watchOnce(loops[0])).toBe('changed');
    expect(await watchOnce(loops[0])).toBe('unchanged');

    server.requests = [];
    team.records.snippets = [
      sealed(
        'acme-snippet-2',
        {
          id: 'acme-snippet-2',
          label: 'uptime',
          command: 'uptime',
          createdAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
        team.dekBase64,
      ),
    ];
    team.revision += 1;
    expect(await watchOnce(loops[0])).toBe('changed');
    expect(server.requests).toEqual([
      'GET /teams/team-acme/sync/watch',
      'GET /teams/team-acme/sync',
    ]);
    expect(state.teamVaults[0].snippets.map(snippet => snippet.id)).toEqual([
      'acme-snippet-2',
    ]);

    server.requests = [];
    team.private.hostPrefs = [];
    team.privateRevision += 1;
    await watchOnce(loops[0]);
    expect(server.requests).toEqual([
      'GET /teams/team-acme/sync/watch',
      'GET /teams/team-acme/me',
    ]);
    expect(state.teamVaults[0].hostPrefs).toEqual([]);

    server.requests = [];
    team.name = 'Acme Platform';
    team.infoRevision += 1;
    await watchOnce(loops[0]);
    expect(server.requests).toEqual(
      expect.arrayContaining(['GET /teams/team-acme/sync/watch', 'GET /teams']),
    );
    expect(server.requests).not.toContain('GET /teams/team-acme/sync');
    expect(state.teamVaults[0].name).toBe('Acme Platform');
  });

  it('팀에서 빠지면(감시가 404) 그 팀 것을 모두 지운다', async () => {
    const team = acmeTeam();
    server.teams = [team, newTeam('team-other', 'Other')];
    const { state, sync, loops } = harness();
    await sync.refresh();
    expect(Object.keys(storedTeamSecrets())).toEqual([
      'team-acme',
      'team-other',
    ]);

    team.member = false;
    await watchOnce(loops[0]);

    expect(state.teamVaults.map(vault => vault.id)).toEqual(['team-other']);
    expect(state.teamSecrets).not.toHaveProperty('team-acme');
    await Promise.resolve();
    expect(Object.keys(storedTeamSecrets())).toEqual(['team-other']);
  });

  it('팀 목록에서 사라진 팀도 지운다', async () => {
    const team = acmeTeam();
    server.teams = [team];
    const { state, sync } = harness();
    await sync.refresh();

    team.member = false;
    await sync.refresh();

    expect(state.teamVaults).toEqual([]);
    expect(state.teamSecrets).toEqual({});
  });

  it('426 이면 그 팀만 업데이트 필요로 두고 담아 둔 것은 그대로다', async () => {
    const team = acmeTeam();
    server.teams = [team];
    const { state, sync, loops } = harness();
    await sync.refresh();

    team.outdated = true;
    team.revision += 1;
    await watchOnce(loops[0]);

    expect(state.teamVaults[0]).toMatchObject({ state: 'outdated' });
    expect(state.teamVaults[0].hosts).toHaveLength(2);
  });

  it('401 이면 토큰을 갱신해 다시 부른다', async () => {
    server.teams = [acmeTeam()];
    server.expiredToken = 'access-token';
    const { state, sync, refreshAccessToken } = harness();

    await sync.refresh();

    expect(refreshAccessToken).toHaveBeenCalled();
    expect(state.teamVaults[0].hosts).toHaveLength(2);
  });

  it('받는 사이 볼트 세대가 바뀌면(잠금·초기화) 그 결과를 버린다', async () => {
    server.teams = [acmeTeam()];
    let release: () => void = () => undefined;
    server.holdRecords = new Promise(resolve => {
      release = resolve;
    });
    const { state, sync, setAccess, access } = harness();

    const refreshing = sync.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));
    const current = access();
    setAccess(current ? { ...current, generation: 2 } : null);
    release();
    await refreshing;

    expect(state.teamVaults[0]?.hosts ?? []).toEqual([]);
    expect(state.teamSecrets['team-acme']?.secretsByRef ?? {}).toEqual({});
  });

  it('잠겼거나 로그아웃했으면 받지 않는다', async () => {
    server.teams = [acmeTeam()];
    const { state, sync, setAccess } = harness();
    setAccess(null);

    await sync.refresh();

    expect(server.requests).toEqual([]);
    expect(state.teamVaults).toEqual([]);
  });

  it('팀을 모르는 서버면 팀 목록을 묻지 않는다', async () => {
    server.teamsEnabled = false;
    server.teams = [acmeTeam()];
    const { state, sync } = harness();

    await sync.refresh();

    expect(server.requests).toEqual(['GET /api/info']);
    expect(state.teamVaults).toEqual([]);
  });

  it('앱이 뒤에 있으면 받기만 하고 감시는 시작하지 않는다', async () => {
    server.teams = [acmeTeam()];
    const { state, sync, loops } = harness({ foreground: false });

    await sync.refresh();

    expect(state.teamVaults[0].hosts).toHaveLength(2);
    expect(loops).toEqual([]);
  });

  it('모두 지우면 담아 둔 것과 키체인을 비운다', async () => {
    server.teams = [acmeTeam()];
    const { state, sync } = harness();
    await sync.refresh();

    await sync.purge();

    expect(state.teamVaults).toEqual([]);
    expect(state.teamSecrets).toEqual({});
    expect(mockKeychainStore.has(TEAM_SECRETS_SERVICE)).toBe(false);
  });

  it('다시 켤 때 키체인의 팀 비밀값을 읽어 온다 — 모르는 팀 것은 버린다', async () => {
    server.teams = [acmeTeam()];
    const first = harness();
    await first.sync.refresh();
    const persistedVaults = first.state.teamVaults;
    mockKeychainStore.set(
      TEAM_SECRETS_SERVICE,
      JSON.stringify({
        ...storedTeamSecrets(),
        'team-gone': {
          secretsByRef: { x: { secretRef: 'x' } },
          hostCredentials: {},
        },
      }),
    );

    const restarted = harness();
    restarted.state.teamVaults = persistedVaults;
    await restarted.sync.restoreSecrets();

    expect(Object.keys(restarted.state.teamSecrets)).toEqual(['team-acme']);
    expect(
      restarted.state.teamSecrets['team-acme']?.secretsByRef['acme-secret']
        ?.password,
    ).toBe('team-pw');
  });
});

// ─── 스토어 배관 ──────────────────────────────────────────────────────────────

function v2Session(dek: Uint8Array): AuthSession {
  const kdf = createVaultKdfDescriptor();
  return {
    user: { id: 'user-1', email: 'member@example.com' },
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 900,
    },
    vaultBootstrap: {
      version: 2,
      wrappedDekBase64: wrapVaultDek(dek, randomBytes(32)),
      epoch: 1,
      dekVerifierBase64: computeVaultDekVerifier(dek),
      kdf,
    },
    offlineLease: {
      token: 'offline-token',
      issuedAt: '2026-10-27T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      verificationPublicKeyPem: 'public-key',
    },
    syncServerTime: '2026-10-27T00:00:00.000Z',
  } as AuthSession;
}

function bootUnlocked(options?: { keepRuntime?: boolean }): void {
  if (!options?.keepRuntime) {
    resetMobileStoreRuntimeForTests();
  }
  const session = v2Session(PERSONAL_DEK);
  const bootstrap = session.vaultBootstrap as {
    wrappedDekBase64: string;
    kdf: ReturnType<typeof createVaultKdfDescriptor>;
  };
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: {
      status: 'authenticated',
      session,
      offline: null,
      errorMessage: null,
    },
    vault: {
      status: 'unlocked',
      dekBase64: PERSONAL_DEK_BASE64,
      wrappedDekBase64: bootstrap.wrappedDekBase64,
      kdf: bootstrap.kdf,
      epoch: 1,
      wrapRevision: 0,
      dekVerifierBase64: computeVaultDekVerifier(PERSONAL_DEK),
    },
    settings: { ...createDefaultMobileSettings(), serverUrl: SERVER_URL },
    syncStatus: createDefaultSyncStatus(),
    groups: [],
    hosts: [],
    awsProfiles: [],
    tailnets: [],
    snippets: [],
    knownHosts: [],
    secretMetadata: [],
    secretsByRef: {},
    teamVaults: [],
    teamSecrets: {},
    syncOutbox: [],
    syncOutboxFailure: null,
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    activeSessionTabId: null,
    activeConnectionTab: null,
  });
}

/** 개인 당기기 뒤에 도는 팀 받기는 기다려 주지 않는다(void) — 담길 때까지 한 박자씩 돌려 본다. */
async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !predicate(); index += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

// ── 내 개인 칸 쓰기(작업 8-4) ─────────────────────────────────────────────────
// 폰에서 생긴 내 것(별표·신뢰한 호스트 키·RDP 인증서·내 자격 증명)을 내 개인 칸에 올린다. 데스크톱이 받는 모양
// (shared-core 정규화)으로 풀려야 한다 — 다르면 데스크톱이 내 설정을 잃는다.

describe('team sync — 내 개인 칸 쓰기', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    server = new FakeTeamServer();
    mockKeychainStore.clear();
    fetchMock.mockClear();
    server.teams = [acmeTeam()];
  });

  /** 올라온 내 개인 칸 레코드를 데스크톱처럼 푼다(내 개인 DEK → shared-core 정규화). */
  function pushedPrefs(index = 0) {
    return decodeSyncRecords<unknown>(
      server.pushedPrivate[index]?.payload.hostPrefs ?? [],
      PERSONAL_DEK_BASE64,
    ).map(normalizeTeamHostPrefsRecord);
  }

  function pushedCredentials(index = 0) {
    return decodeSyncRecords<{
      id: string;
      updatedAt: string;
      credentials: unknown;
    }>(
      server.pushedPrivate[index]?.payload.hostCredentials ?? [],
      PERSONAL_DEK_BASE64,
    ).map(record => ({
      id: record.id,
      updatedAt: record.updatedAt,
      credentials: normalizeTeamHostCredentials(record.credentials),
    }));
  }

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  it('내 설정을 고치면 폰에 먼저 반영하고, 그 레코드만 내 개인 DEK 로 잠가 세대 헤더와 함께 올린다', async () => {
    const { state, sync } = harness();
    await sync.refresh();

    sync.updateHostPrefs('team-acme', 'acme-bastion', prefs => ({
      ...prefs,
      favorite: true,
    }));
    // 화면은 바로 바뀐다.
    const vault = () => state.teamVaults[0];
    expect(
      vault().hostPrefs.find(prefs => prefs.id === 'acme-bastion')?.favorite,
    ).toBe(true);

    await settle();
    expect(server.pushedPrivate).toHaveLength(1);
    expect(server.pushedPrivate[0]).toMatchObject({
      teamId: 'team-acme',
      epoch: '7',
    });
    expect(Object.keys(server.pushedPrivate[0].payload)).toEqual(['hostPrefs']);
    expect(pushedPrefs()).toEqual([
      expect.objectContaining({ id: 'acme-bastion', favorite: true }),
    ]);
    expect(vault().privateOutbox).toEqual([]);
    // 다른 호스트의 내 설정(받아 둔 것)은 그대로다.
    expect(
      vault().hostPrefs.find(prefs => prefs.id === 'acme-app'),
    ).toMatchObject({ favorite: true, agentForwarding: true });
  });

  it('못 올리면 남겨 두고, 받기가 그것을 덮지 않으며, 다음 받기 때 올린다', async () => {
    const { state, sync, loops } = harness();
    await sync.refresh();
    // 첫 감시 한 바퀴 — 아는 리비전을 맞춘다.
    await watchOnce(loops[0]);
    server.privateOffline = true;

    sync.updateHostPrefs('team-acme', 'acme-app', prefs => ({
      ...prefs,
      favorite: null,
    }));
    await settle();
    const vault = () => state.teamVaults[0];
    expect(vault().privateOutbox).toEqual([
      expect.objectContaining({ kind: 'hostPrefs', id: 'acme-app' }),
    ]);

    // 다른 기기가 내 개인 칸을 바꿔 리비전이 올랐다 — 감시가 받아도(서버에는 아직 별표가 있다) 못 올린 내 변경은
    // 그대로다.
    server.team('team-acme').privateRevision += 1;
    const privatePulls = () =>
      server.requests.filter(line => line === 'GET /teams/team-acme/me').length;
    const before = privatePulls();
    await watchOnce(loops[0]);
    expect(privatePulls()).toBe(before + 1);
    expect(
      vault().hostPrefs.find(prefs => prefs.id === 'acme-app')?.favorite,
    ).toBeNull();
    expect(vault().privateOutbox).toHaveLength(1);

    // 다시 온라인 — 개인 동기화가 끝나면 부르는 refresh 가 올린다(감시는 내 변경으로 깨지 않는다).
    server.privateOffline = false;
    await sync.refresh();
    expect(vault().privateOutbox).toEqual([]);
    expect(pushedPrefs(server.pushedPrivate.length - 1)).toEqual([
      expect.objectContaining({ id: 'acme-app', favorite: null }),
    ]);
  });

  it('올리는 사이 다시 고친 것은 줄에 남았다가 다음에 올라간다 — 줄에는 레코드마다 하나다', async () => {
    const { state, sync } = harness();
    await sync.refresh();
    let release = () => {};
    server.holdPrivatePush = new Promise<void>(resolve => {
      release = resolve;
    });

    sync.updateHostPrefs('team-acme', 'acme-bastion', prefs => ({
      ...prefs,
      favorite: true,
    }));
    await settle();
    expect(server.pushedPrivate).toHaveLength(1);
    // 첫 올리기가 답을 기다리는 사이 같은 호스트를 다시 고친다.
    sync.updateHostPrefs('team-acme', 'acme-bastion', prefs => ({
      ...prefs,
      favorite: null,
    }));
    const vault = () => state.teamVaults[0];
    expect(vault().privateOutbox).toEqual([
      expect.objectContaining({ kind: 'hostPrefs', id: 'acme-bastion' }),
    ]);

    server.holdPrivatePush = null;
    release();
    await settle();
    expect(server.pushedPrivate).toHaveLength(2);
    expect(pushedPrefs(1)).toEqual([
      expect.objectContaining({ id: 'acme-bastion', favorite: null }),
    ]);
    expect(vault().privateOutbox).toEqual([]);
  });

  it('못 올린 내 자격 증명도 받기가 덮지 않는다', async () => {
    server.team('team-acme').private.hostCredentials = [
      sealed(
        'acme-bastion',
        {
          id: 'acme-bastion',
          updatedAt: UPDATED_AT,
          credentials: { username: 'me', password: 'old-pw' },
        },
        PERSONAL_DEK_BASE64,
        UPDATED_AT,
      ),
    ];
    const { state, sync, loops } = harness();
    await sync.refresh();
    await watchOnce(loops[0]);
    server.privateOffline = true;

    await sync.updateHostCredentials('team-acme', 'acme-bastion', current => ({
      ...current,
      password: 'new-pw',
    }));
    await settle();
    // 다른 기기가 내 개인 칸을 바꿔 감시가 다시 받아도(서버에는 아직 옛 비밀번호다) 못 올린 것은 그대로다.
    server.team('team-acme').privateRevision += 1;
    await watchOnce(loops[0]);
    const mine = () =>
      state.teamSecrets['team-acme'].hostCredentials['acme-bastion'];
    expect(mine()).toEqual({ username: 'me', password: 'new-pw' });

    server.privateOffline = false;
    await sync.refresh();
    expect(pushedCredentials(server.pushedPrivate.length - 1)).toEqual([
      expect.objectContaining({
        id: 'acme-bastion',
        credentials: { username: 'me', password: 'new-pw' },
      }),
    ]);
    expect(mine()).toEqual({ username: 'me', password: 'new-pw' });
  });

  it('내 자격 증명은 키체인에 두고 {id·updatedAt·credentials} 로 올린다 — 시각은 마지막으로 받은 것보다 뒤다', async () => {
    const future = '2099-01-01T00:00:00.000Z';
    server.team('team-acme').private.hostCredentials = [
      sealed(
        'acme-bastion',
        {
          id: 'acme-bastion',
          updatedAt: future,
          credentials: { username: 'me', password: 'my-pw' },
        },
        PERSONAL_DEK_BASE64,
        future,
      ),
    ];
    const { state, sync } = harness();
    await sync.refresh();
    expect(state.teamVaults[0].credentialsUpdatedAt).toEqual({
      'acme-bastion': future,
    });

    await sync.updateHostCredentials('team-acme', 'acme-bastion', current => ({
      ...current,
      password: 'new-pw',
    }));
    await settle();

    expect(
      state.teamSecrets['team-acme'].hostCredentials['acme-bastion'],
    ).toEqual({ username: 'me', password: 'new-pw' });
    expect(
      (storedTeamSecrets()['team-acme'] as { hostCredentials: unknown })
        .hostCredentials,
    ).toEqual({ 'acme-bastion': { username: 'me', password: 'new-pw' } });
    const [pushed] = pushedCredentials();
    expect(pushed).toEqual({
      id: 'acme-bastion',
      updatedAt: expect.any(String),
      credentials: { username: 'me', password: 'new-pw' },
    });
    expect(Date.parse(pushed.updatedAt)).toBeGreaterThan(Date.parse(future));
    expect(server.pushedPrivate[0].payload.hostCredentials[0].updated_at).toBe(
      pushed.updatedAt,
    );
  });

  it('올리다 팀에서 빠졌으면(404) 그 팀을 지운다', async () => {
    const { state, sync } = harness();
    await sync.refresh();
    server.team('team-acme').member = false;

    sync.updateHostPrefs('team-acme', 'acme-app', prefs => ({
      ...prefs,
      favorite: null,
    }));
    await settle();
    expect(state.teamVaults).toEqual([]);
    expect(state.teamSecrets).toEqual({});
  });

  it('받기 전(팀을 아직 안 열었을 때)의 변경은 남았다가 팀을 열 때 올라간다', async () => {
    const { state, sync } = harness();
    await sync.refresh();
    sync.resetRuntime();

    sync.updateHostPrefs('team-acme', 'acme-app', prefs => ({
      ...prefs,
      favorite: null,
    }));
    await settle();
    expect(server.pushedPrivate).toHaveLength(0);
    expect(state.teamVaults[0].privateOutbox).toHaveLength(1);

    await sync.refresh();
    expect(server.pushedPrivate).toHaveLength(1);
    expect(state.teamVaults[0].privateOutbox).toEqual([]);
  });
});

// ── 이 기기의 팀 AWS 키(작업 8-4b) ──────────────────────────────────────────────
// 팀 정적 프로필의 키는 기기마다 넣는다(데스크톱과 같다). 키체인의 팀 비밀값 칸에만 두고 어디로도 올리지 않는다.

describe('team sync — 이 기기의 팀 AWS 키', () => {
  const originalFetch = globalThis.fetch;
  const MINE = { accessKeyId: 'AKIAMINE', secretAccessKey: 'mine-secret' };
  const DEV = { accessKeyId: 'AKIADEV', secretAccessKey: 'dev-secret' };

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    server = new FakeTeamServer();
    mockKeychainStore.clear();
    fetchMock.mockClear();
    server.teams = [acmeTeam()];
  });

  it('키는 키체인의 팀 칸에만 두고 서버에는 아무것도 보내지 않는다', async () => {
    const { state, sync } = harness();
    await sync.refresh();
    const before = server.requests.length;

    await sync.setAwsKey('team-acme', 'acme-aws', MINE);

    expect(state.teamSecrets['team-acme'].awsKeys).toEqual({
      'acme-aws': MINE,
    });
    expect(
      (storedTeamSecrets()['team-acme'] as { awsKeys: unknown }).awsKeys,
    ).toEqual({ 'acme-aws': MINE });
    // 팀 레코드에는 여전히 키가 없고, 내 개인 칸 올릴 줄에도 안 들어간다.
    expect(state.teamVaults[0].awsProfiles[0]).toMatchObject({
      accessKeyId: '',
      secretAccessKey: '',
    });
    expect(state.teamVaults[0].privateOutbox ?? []).toEqual([]);
    expect(server.requests.slice(before)).toEqual([]);
  });

  it('팀이 정적 프로필을 지우면 그 키도 지우고, 남은 프로필의 키는 둔다', async () => {
    const team = server.team('team-acme');
    team.records.awsProfiles = [
      ...(team.records.awsProfiles ?? []),
      sealed(
        'acme-aws-dev',
        {
          id: 'acme-aws-dev',
          name: 'acme-dev',
          kind: 'static',
          region: 'us-east-1',
          accessKeyId: '',
          secretAccessKey: '',
          updatedAt: UPDATED_AT,
        },
        team.dekBase64,
      ),
    ];
    const { state, sync, loops } = harness();
    await sync.refresh();
    await watchOnce(loops[0]);
    await sync.setAwsKey('team-acme', 'acme-aws', MINE);
    await sync.setAwsKey('team-acme', 'acme-aws-dev', DEV);

    team.records.awsProfiles = (team.records.awsProfiles ?? []).filter(
      record => record.id !== 'acme-aws',
    );
    team.revision += 1;
    await watchOnce(loops[0]);

    expect(state.teamVaults[0].awsProfiles.map(profile => profile.id)).toEqual([
      'acme-aws-dev',
    ]);
    expect(state.teamSecrets['team-acme'].awsKeys).toEqual({
      'acme-aws-dev': DEV,
    });
    expect(
      (storedTeamSecrets()['team-acme'] as { awsKeys: unknown }).awsKeys,
    ).toEqual({ 'acme-aws-dev': DEV });
  });

  it('팀에서 빠지면 그 팀의 키도 지운다', async () => {
    const { state, sync } = harness();
    await sync.refresh();
    await sync.setAwsKey('team-acme', 'acme-aws', MINE);

    server.team('team-acme').member = false;
    await sync.refresh();

    expect(state.teamSecrets).toEqual({});
    expect(storedTeamSecrets()).toEqual({});
    // 창이 열려 있던 사이 빠졌어도 없는 팀에는 키를 두지 않는다.
    await sync.setAwsKey('team-acme', 'acme-aws', MINE);
    expect(state.teamSecrets).toEqual({});
  });

  it('다시 켤 때 키체인의 키를 그대로 되살린다', async () => {
    const { state, sync } = harness();
    await sync.refresh();
    await sync.setAwsKey('team-acme', 'acme-aws', MINE);

    // 앱을 다시 켠 것처럼 — 팀 칸은 앱 저장소에서, 비밀값은 키체인에서 온다.
    state.teamSecrets = {};
    await sync.restoreSecrets();
    expect(state.teamSecrets['team-acme'].awsKeys).toEqual({
      'acme-aws': MINE,
    });
  });
});

// ── 팀 기록 올리기(작업 8-5) ──────────────────────────────────────────────────
// 폰의 접속 줄을 그 팀 키로 잠가 올린다. 데스크톱은 같은 키로 푼다(shared-core openTeamEventBody).

describe('team sync — 팀 기록 올리기', () => {
  const originalFetch = globalThis.fetch;
  const EVENT_ID = '3f0c8a52-6a1e-4c7b-9d0e-2b6a1f9c4e7d';
  const body = {
    v: 1,
    phase: 'start' as const,
    client: 'mobile' as const,
    record: {
      id: 'session:one',
      level: 'info' as const,
      category: 'session' as const,
      kind: 'session-lifecycle' as const,
      message: 'SSH 세션',
      messageKey: 'core.sessionLog',
      messageParams: { kind: 'SSH' },
      metadata: { hostId: 'acme-app', status: 'connected' },
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    },
  };
  const draft = { id: EVENT_ID, createdAt: UPDATED_AT, body };

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    server = new FakeTeamServer();
    mockKeychainStore.clear();
    fetchMock.mockClear();
    server.teams = [acmeTeam()];
  });

  it('그 팀 키로 잠가 올리고, 데스크톱이 같은 키로 풀면 같은 줄이다', async () => {
    const { sync } = harness();
    await sync.refresh();

    await expect(sync.sendTeamEvents('team-acme', [draft])).resolves.toBe(
      'sent',
    );
    // 답을 못 받아 다시 보내도 서버에는 한 줄이다.
    await expect(sync.sendTeamEvents('team-acme', [draft])).resolves.toBe(
      'sent',
    );

    const events = server.events.get('team-acme') ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: EVENT_ID, createdAt: UPDATED_AT });
    expect(events[0]?.payload).not.toContain('SSH');
    const team = server.team('team-acme');
    expect(
      openTeamEventBody(
        toByteArray(team.dekBase64),
        team.id,
        EVENT_ID,
        events[0]!.payload,
      ),
    ).toEqual(body);
  });

  it('팀을 아직 열지 않았거나 잠겼으면 not-open 이고 아무것도 보내지 않는다', async () => {
    const { sync, setAccess } = harness();
    await expect(sync.sendTeamEvents('team-acme', [draft])).resolves.toBe(
      'not-open',
    );

    await sync.refresh();
    setAccess(null);
    await expect(sync.sendTeamEvents('team-acme', [draft])).resolves.toBe(
      'not-open',
    );
    expect(server.events.size).toBe(0);
  });

  it('팀에서 빠졌으면(404) gone 이고, 그 팀을 지우기 직전 그 팀 호스트를 알린다', async () => {
    const onTeamForgotten = jest.fn();
    const { state, sync } = harness({ onTeamForgotten });
    await sync.refresh();
    server.team('team-acme').member = false;

    await expect(sync.sendTeamEvents('team-acme', [draft])).resolves.toBe(
      'gone',
    );

    expect(state.teamVaults).toEqual([]);
    expect(onTeamForgotten).toHaveBeenCalledTimes(1);
    expect(onTeamForgotten).toHaveBeenCalledWith(
      'team-acme',
      new Set(['acme-app', 'acme-bastion']),
    );
  });

  it('서버가 받을 수 없다고 하면(400) rejected, 팀 기록을 모르는 서버면 unsupported, 오프라인이면 던진다', async () => {
    const { sync } = harness();
    await sync.refresh();

    server.rejectEvents = true;
    await expect(sync.sendTeamEvents('team-acme', [draft])).resolves.toBe(
      'rejected',
    );
    server.rejectEvents = false;

    server.eventsOffline = true;
    await expect(sync.sendTeamEvents('team-acme', [draft])).rejects.toThrow(
      'Network request failed',
    );
    server.eventsOffline = false;

    const old = harness();
    server.historyEnabled = false;
    await old.sync.refresh();
    await expect(old.sync.sendTeamEvents('team-acme', [draft])).resolves.toBe(
      'unsupported',
    );
    expect(server.events.size).toBe(0);
  });

  it('팀 목록에서 사라져도, 모두 지워도(볼트 초기화) 그 팀 호스트를 알린다', async () => {
    const onTeamForgotten = jest.fn();
    const { sync } = harness({ onTeamForgotten });
    server.teams = [acmeTeam(), newTeam('team-empty', 'Empty')];
    await sync.refresh();

    server.team('team-acme').member = false;
    await sync.refresh();
    expect(onTeamForgotten).toHaveBeenCalledWith(
      'team-acme',
      new Set(['acme-app', 'acme-bastion']),
    );

    server.team('team-acme').member = true;
    await sync.refresh();
    onTeamForgotten.mockClear();
    await sync.purge();
    // 호스트가 없는 팀은 닫을 것이 없다.
    expect(onTeamForgotten.mock.calls).toEqual([
      ['team-acme', new Set(['acme-app', 'acme-bastion'])],
    ]);
  });
});

describe('team sync — 스토어 배관', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    resetMobileStoreRuntimeForTests();
  });

  beforeEach(() => {
    server = new FakeTeamServer();
    mockKeychainStore.clear();
    fetchMock.mockClear();
  });

  it('개인 당기기가 끝나면 팀을 받고, 개인 올리기에는 팀 것이 섞이지 않는다', async () => {
    server.teams = [acmeTeam()];
    bootUnlocked();

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(
      () => useMobileAppStore.getState().teamVaults[0]?.hosts.length === 2,
    );
    expect(useMobileAppStore.getState().teamVaults[0]?.hosts).toHaveLength(2);

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        label: 'mine',
        hostname: 'mine.example.com',
        port: 22,
        username: 'me',
        authType: 'password',
        groupName: null,
        credentials: { password: 'mine-pw' },
      });
    });
    await settleUntil(() => server.pushedPersonal.length > 0);

    const pushed = server.pushedPersonal.flatMap(payload => [
      ...payload.hosts.map(record => record.id),
      ...payload.secrets.map(record => record.id),
      ...payload.knownHosts.map(record => record.id),
    ]);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.some(id => id.startsWith('acme-'))).toBe(false);
  });

  it('팀 호스트 별표는 내 개인 칸으로 지금 볼트 세대와 함께 올라가고, 개인 올리기에는 섞이지 않는다', async () => {
    server.teams = [acmeTeam()];
    bootUnlocked();
    act(() => {
      useMobileAppStore.setState(state => ({
        vault: { ...state.vault, epoch: 3 },
      }));
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(
      () => useMobileAppStore.getState().teamVaults[0]?.hosts.length === 2,
    );

    await act(async () => {
      await useMobileAppStore.getState().toggleHostFavorite('acme-bastion');
    });
    await settleUntil(() => server.pushedPrivate.length > 0);
    expect(server.pushedPrivate).toEqual([
      expect.objectContaining({ teamId: 'team-acme', epoch: '3' }),
    ]);
    expect(
      server.pushedPersonal.flatMap(payload =>
        payload.hosts.map(record => record.id),
      ),
    ).not.toContain('acme-bastion');
  });

  it('앱 저장소에는 팀 칸만 남기고 비밀값은 남기지 않는다', async () => {
    server.teams = [acmeTeam()];
    bootUnlocked();
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(
      () => useMobileAppStore.getState().teamVaults.length === 1,
    );

    const persisted = useMobileAppStore.persist
      .getOptions()
      .partialize?.(useMobileAppStore.getState()) as Record<string, unknown>;

    expect(persisted.teamVaults).toEqual(
      useMobileAppStore.getState().teamVaults,
    );
    expect(persisted).not.toHaveProperty('teamSecrets');
  });

  it('로그아웃하면 팀 것도 지운다', async () => {
    server.teams = [acmeTeam()];
    bootUnlocked();
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(() => mockKeychainStore.has(TEAM_SECRETS_SERVICE));

    await act(async () => {
      await useMobileAppStore.getState().logout();
    });

    expect(useMobileAppStore.getState().teamVaults).toEqual([]);
    expect(useMobileAppStore.getState().teamSecrets).toEqual({});
    expect(mockKeychainStore.has(TEAM_SECRETS_SERVICE)).toBe(false);
  });

  it('볼트를 초기화하면 팀 것도 지운다', async () => {
    server.teams = [acmeTeam()];
    bootUnlocked();
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(() => mockKeychainStore.has(TEAM_SECRETS_SERVICE));

    await act(async () => {
      await useMobileAppStore.getState().resetVault();
    });

    expect(useMobileAppStore.getState().vault.status).toBe('setup-required');
    expect(useMobileAppStore.getState().teamVaults).toEqual([]);
    expect(useMobileAppStore.getState().teamSecrets).toEqual({});
    expect(mockKeychainStore.has(TEAM_SECRETS_SERVICE)).toBe(false);
  });

  it('세션이 만료되면 팀 것도 지운다', async () => {
    server.teams = [acmeTeam()];
    bootUnlocked();
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(() => mockKeychainStore.has(TEAM_SECRETS_SERVICE));

    server.personalExpired = true;
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(() => !mockKeychainStore.has(TEAM_SECRETS_SERVICE));

    expect(useMobileAppStore.getState().auth.status).not.toBe('authenticated');
    expect(useMobileAppStore.getState().teamVaults).toEqual([]);
    expect(useMobileAppStore.getState().teamSecrets).toEqual({});
    expect(mockKeychainStore.has(TEAM_SECRETS_SERVICE)).toBe(false);
  });

  it('다시 켤 때 남겨 둔 팀 칸에 키체인의 팀 비밀값을 채운다', async () => {
    server.teams = [acmeTeam()];
    bootUnlocked();
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(() => mockKeychainStore.has(TEAM_SECRETS_SERVICE));
    const persistedVaults = useMobileAppStore.getState().teamVaults;

    // 앱을 다시 켠다 — 앱 저장소의 팀 칸은 남고, 비밀값은 키체인에만 있다.
    bootUnlocked();
    useMobileAppStore.setState({
      teamVaults: persistedVaults,
      secureStateReady: false,
    });
    await act(async () => {
      useMobileAppStore.getState().ensureSecureStateRestored();
    });
    await settleUntil(() =>
      Boolean(useMobileAppStore.getState().teamSecrets['team-acme']),
    );

    expect(
      useMobileAppStore.getState().teamSecrets['team-acme']?.secretsByRef[
        'acme-secret'
      ]?.password,
    ).toBe('team-pw');
  });

  it('앱이 뒤로 가면 팀 감시를 멈춘다', async () => {
    server.teams = [acmeTeam()];
    server.holdWatch = true;
    // RN 시험 환경의 AppState 는 흉내라 앞에 있다고 하지 않는다 — 이 시험만 앞에 있게 한다.
    const appState = AppState as unknown as { currentState: unknown };
    const currentState = appState.currentState;
    appState.currentState = 'active';
    const appStateSpy = jest.spyOn(AppState, 'addEventListener');
    try {
      bootUnlocked();
      await act(async () => {
        await useMobileAppStore.getState().syncNow();
      });
      const teamWatch = '/teams/team-acme/sync/watch';
      await settleUntil(() =>
        server.heldWatches.some(held => held.path === teamWatch),
      );
      expect(server.heldWatches.some(held => held.path === teamWatch)).toBe(
        true,
      );

      const onAppStateChange = appStateSpy.mock.calls.find(
        ([event]) => event === 'change',
      )?.[1] as ((state: string) => void) | undefined;
      expect(onAppStateChange).toBeDefined();
      await act(async () => {
        onAppStateChange?.('background');
      });
      await settleUntil(() =>
        server.heldWatches
          .filter(held => held.path === teamWatch)
          .every(held => held.aborted),
      );

      expect(
        server.heldWatches
          .filter(held => held.path === teamWatch)
          .every(held => held.aborted),
      ).toBe(true);
    } finally {
      appState.currentState = currentState;
      appStateSpy.mockRestore();
      resetMobileStoreRuntimeForTests();
    }
  });
});

// ── 팀 기록의 스토어 배관(작업 8-5) ───────────────────────────────────────────────
// 앱을 켜면 지켜보기가 시작되고, 팀 호스트 접속의 줄이 그 팀 키로 서버에 올라간다. 빠진 팀은 연결을 닫고, 로그아웃은
// 끝 줄을 올려 본 뒤 정리한다. SFTP 동작은 그 줄의 숫자로 센다.

describe('team history — 스토어 배관', () => {
  const originalFetch = globalThis.fetch;
  const NOTICE = '팀에서 빠져 이 연결을 닫았습니다.';
  const CONNECTED_AT = '2026-10-27T01:00:00.000Z';

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    resetMobileStoreRuntimeForTests();
  });

  beforeEach(() => {
    server = new FakeTeamServer();
    mockKeychainStore.clear();
    fetchMock.mockClear();
    server.teams = [acmeTeam()];
  });

  /** 앱을 켤 때처럼 팀 기록을 지켜보게 한 뒤(저장된 로그인이 없어 계정 칸은 한 번 비워진다) 풀린 볼트로 팀을 받는다. */
  async function bootWithTeamHistory(): Promise<void> {
    resetMobileStoreRuntimeForTests();
    await act(async () => {
      await useMobileAppStore.getState().initializeApp();
    });
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    }
    bootUnlocked({ keepRuntime: true });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(
      () => useMobileAppStore.getState().teamVaults[0]?.hosts.length === 2,
    );
  }

  function terminal(id: string, hostId: string, status: string) {
    return {
      id,
      sessionId: id,
      hostId,
      title: hostId,
      status,
      connectionKind: 'ssh',
      connectionDetails: `ops@${hostId}:22`,
      hasReceivedOutput: true,
      isRestorable: true,
      lastViewportSnapshot: '',
      lastEventAt: CONNECTED_AT,
      lastConnectedAt: CONNECTED_AT,
    } as never;
  }

  function sftp(id: string, hostId: string) {
    return {
      id,
      hostId,
      title: `${hostId} SFTP`,
      status: 'connected',
      currentPath: '/home/ops',
      lastEventAt: CONNECTED_AT,
      lastConnectedAt: CONNECTED_AT,
    } as never;
  }

  /** 서버에 올라온 팀 기록을 데스크톱처럼 푼다. */
  function teamLines(teamId = 'team-acme') {
    const team = server.team(teamId);
    return (server.events.get(teamId) ?? []).map(event =>
      openTeamEventBody<{
        v: number;
        phase: string;
        client: string;
        record: { id: string; kind: string; metadata: Record<string, unknown> };
      }>(toByteArray(team.dekBase64), team.id, event.id, event.payload),
    );
  }

  it('앱을 켜면 팀 호스트 접속의 시작·끝이 그 팀 키로 올라간다 — 개인 호스트 것은 없다', async () => {
    await bootWithTeamHistory();

    act(() => {
      useMobileAppStore.setState({
        sessions: [
          terminal('t-team', 'acme-app', 'connected'),
          terminal('t-mine', 'mine', 'connected'),
        ],
      });
    });
    act(() => {
      useMobileAppStore.setState({
        sessions: [
          terminal('t-team', 'acme-app', 'closed'),
          terminal('t-mine', 'mine', 'closed'),
        ],
      });
    });
    // 팀 목록을 다시 읽으면 기다리던 기록을 바로 올린다.
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(() => (server.events.get('team-acme')?.length ?? 0) >= 2);

    const lines = teamLines();
    expect(lines.map(line => line.phase)).toEqual(['start', 'end']);
    expect(lines.every(line => line.client === 'mobile')).toBe(true);
    expect(lines[0]?.record.id).toBe(lines[1]?.record.id);
    expect(lines[0]?.record.metadata).toMatchObject({
      hostId: 'acme-app',
      hostLabel: 'app',
      status: 'connected',
    });
    expect(lines[1]?.record.metadata).toMatchObject({ status: 'closed' });
  });

  it('팀에서 빠지면 그 팀 호스트의 연결(터미널·SFTP·원격 데스크톱)을 닫고 까닭을 남긴다 — 개인 호스트 것은 그대로다', async () => {
    await bootWithTeamHistory();
    act(() => {
      useMobileAppStore.setState({
        sessions: [
          terminal('t-team', 'acme-app', 'connected'),
          // 앱 전환으로 끊겨 다시 붙기를 기다리던 것도 닫는다(다시 붙지 않게).
          {
            ...(terminal('t-dropped', 'acme-bastion', 'error') as object),
            disconnectReason: 'dropped',
          } as never,
          terminal('t-mine', 'mine', 'connected'),
        ],
        sftpSessions: [sftp('s-team', 'acme-bastion')],
        remoteDesktopSessions: [
          {
            id: 'd-team',
            hostId: 'acme-app',
            protocol: 'vnc',
            title: 'desk',
            status: 'connected',
            inputMode: 'touch',
            scaleMode: 'fit',
            lastEventAt: CONNECTED_AT,
            lastConnectedAt: CONNECTED_AT,
          },
        ],
      });
    });

    const writesBefore = (AsyncStorage.setItem as jest.Mock).mock.calls.length;
    server.team('team-acme').member = false;
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(
      () =>
        useMobileAppStore
          .getState()
          .remoteDesktopSessions.find(session => session.id === 'd-team')
          ?.status === 'error',
    );
    // 그 팀에는 더 올릴 수 없다 — 닫은 연결의 끝 줄을 대기열에 남기지 않는다.
    const historyWrites = (AsyncStorage.setItem as jest.Mock).mock.calls
      .slice(writesBefore)
      .filter(([key]) => key === 'dolgate-mobile-team-history');
    expect(
      historyWrites.some(([, value]) => String(value).includes('"end"')),
    ).toBe(false);

    const state = useMobileAppStore.getState();
    expect(state.teamVaults).toEqual([]);
    const byId = (id: string) =>
      state.sessions.find(session => session.id === id);
    expect(byId('t-team')).toMatchObject({
      status: 'error',
      errorMessage: NOTICE,
    });
    expect(byId('t-dropped')).toMatchObject({
      status: 'error',
      errorMessage: NOTICE,
    });
    expect(byId('t-dropped')?.disconnectReason).toBeUndefined();
    expect(byId('t-mine')?.status).toBe('connected');
    expect(state.sftpSessions[0]).toMatchObject({
      status: 'error',
      errorMessage: NOTICE,
    });
    expect(state.remoteDesktopSessions[0]).toMatchObject({
      status: 'error',
      errorMessage: NOTICE,
    });
  });

  it('로그아웃하면 열린 팀 호스트 연결의 끝 줄까지 올린 뒤 정리한다', async () => {
    await bootWithTeamHistory();
    act(() => {
      useMobileAppStore.setState({
        sessions: [terminal('t-team', 'acme-app', 'connected')],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().logout();
    });

    const lines = teamLines();
    expect(lines.map(line => line.phase)).toEqual(['start', 'end']);
    expect(lines[1]?.record.metadata).toMatchObject({
      status: 'closed',
      disconnectReason: null,
    });
    expect(useMobileAppStore.getState().auth.status).toBe('unauthenticated');
  });

  it('팀 호스트 SFTP 의 폴더 만들기·이름 바꾸기·권한·지우기와 실패를 그 줄에 센다', async () => {
    await bootWithTeamHistory();
    const mkdir = jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Permission denied'));
    registerSftpRuntimeForTests('s-team', 'acme-app', {
      mkdir,
      rename: jest.fn(async () => undefined),
      chmod: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      listDirectory: jest.fn(async (path: string) => ({ path, entries: [] })),
      close: jest.fn(async () => undefined),
    } as never);
    act(() => {
      useMobileAppStore.setState({
        sftpSessions: [sftp('s-team', 'acme-app')],
      });
    });

    const store = () => useMobileAppStore.getState();
    await act(async () => {
      await store().createSftpDirectory('s-team', 'logs');
    });
    await act(async () => {
      await expect(
        store().createSftpDirectory('s-team', 'secret'),
      ).rejects.toThrow('Permission denied');
    });
    await act(async () => {
      await store().renameSftpEntry('s-team', '/home/ops/a.txt', 'b.txt');
      await store().chmodSftpEntry('s-team', '/home/ops/b.txt', '640');
      await store().deleteSftpEntries('s-team', [
        '/home/ops/old-1.log',
        '/home/ops/old-2.log',
      ]);
    });
    await act(async () => {
      await store().logout();
    });

    const end = teamLines().find(line => line.phase === 'end');
    expect(end?.record.kind).toBe('sftp-lifecycle');
    expect(end?.record.metadata).toMatchObject({
      mkdirCount: 1,
      renameCount: 1,
      chmodCount: 1,
      deleteCount: 2,
      errorCount: 1,
    });
  });

  /** 앱 저장소의 그 키에 마지막으로 한 일 — 썼으면 그 값, 지웠으면 null. */
  function lastStored(key: string): string | null | undefined {
    const setItem = AsyncStorage.setItem as jest.Mock;
    const removeItem = AsyncStorage.removeItem as jest.Mock;
    const ops = [
      ...setItem.mock.calls.map((call, index) => ({
        order: setItem.mock.invocationCallOrder[index] ?? 0,
        key: call[0] as string,
        value: call[1] as string | null,
      })),
      ...removeItem.mock.calls.map((call, index) => ({
        order: removeItem.mock.invocationCallOrder[index] ?? 0,
        key: call[0] as string,
        value: null,
      })),
    ]
      .filter(op => op.key === key)
      .sort((left, right) => left.order - right.order);
    return ops.at(-1)?.value;
  }

  it('로그아웃 때 못 올린 팀 기록은 버린다(오프라인) — 다음 계정으로 가지 않는다', async () => {
    await bootWithTeamHistory();
    server.eventsOffline = true;
    act(() => {
      useMobileAppStore.setState({
        sessions: [terminal('t-team', 'acme-app', 'connected')],
      });
    });
    await settleUntil(
      () => typeof lastStored('dolgate-mobile-team-history') === 'string',
    );
    expect(lastStored('dolgate-mobile-team-history')).toContain('"start"');

    await act(async () => {
      await useMobileAppStore.getState().logout();
    });
    await settleUntil(() => lastStored('dolgate-mobile-team-history') === null);

    expect(server.events.size).toBe(0);
    expect(lastStored('dolgate-mobile-team-history')).toBeNull();
    expect(lastStored('dolgate-mobile-team-history-open')).toBeNull();
  });

  it('세션이 만료되면 못 올린 팀 기록도 버린다', async () => {
    await bootWithTeamHistory();
    server.eventsOffline = true;
    act(() => {
      useMobileAppStore.setState({
        sessions: [terminal('t-team', 'acme-app', 'connected')],
      });
    });
    await settleUntil(
      () => typeof lastStored('dolgate-mobile-team-history') === 'string',
    );

    server.personalExpired = true;
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    await settleUntil(() => lastStored('dolgate-mobile-team-history') === null);

    expect(useMobileAppStore.getState().auth.status).not.toBe('authenticated');
    expect(lastStored('dolgate-mobile-team-history')).toBeNull();
    expect(lastStored('dolgate-mobile-team-history-open')).toBeNull();
  });
});
