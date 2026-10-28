import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import type { SyncRecord, SyncWatchLoopOptions } from '@dolssh/shared-core';
import {
  createTeamDek,
  createTeamInviteSecret,
  deriveTeamInviteJoinToken,
  hashTeamInviteJoinToken,
  normalizeTeamHostCredentials,
  normalizeTeamHostPrefsRecord,
  openTeamEventBody,
  openTeamInviteBox,
  sealTeamInviteBox,
  sealTeamInviteSecret,
  wrapTeamDek,
} from '@dolssh/shared-core';
import { fromByteArray } from 'base64-js';
import { Buffer } from 'buffer';
import { decodeSyncRecords } from '../src/lib/mobile';
import {
  createTeamSync,
  type TeamSyncStoreState,
} from '../src/store/team-sync';
import {
  createTeamHistory,
  type TeamHistorySource,
} from '../src/store/team-history';

/*
 * 폰의 팀 받기를 실제 서버(services/sync-api)에 붙여 본다(작업 8-2).
 *
 * 다른 팀 받기 시험은 가짜 서버에 붙는다. 그 가짜는 실제 서버를 보고 따라 만든 것이라, 필드 이름·머리·ETag·감시
 * 응답이 어긋나도 통과한다. 여기서는 서버를 빌드해 임시 SQLite 로 띄우고 계정 둘(A·B)을 API 로 만든다. A 는
 * 데스크톱이 하는 대로 팀을 만들어 레코드를 올리고 링크로 B 를 들인다. B 의 폰은 모바일의 실제 받기 코드
 * (store/team-sync.ts·lib/team-api.ts)로 받고, 내 개인 칸에 쓴 것을 올린다(작업 8-4). 팀 호스트 접속 줄은 팀 기록에
 * 올리고, A 가 같은 팀 키로 푼다(작업 8-5).
 *
 * Go 가 있어야 하고 빌드까지 1분 안팎이라 평소 시험에서는 건너뛴다. 돌리려면:
 *   DOLGATE_TEAM_E2E=1 npm run test:mobile -- --runInBand __tests__/team-sync.e2e.test.ts
 */

// 모바일 tsconfig 는 node 타입을 싣지 않는다. 쓰는 것만 적어 jest 로 받는다.
interface ChildLike {
  kill(signal?: string): void;
  stdout: {
    on(event: 'data', listener: (chunk: unknown) => void): void;
  } | null;
  stderr: {
    on(event: 'data', listener: (chunk: unknown) => void): void;
  } | null;
}
interface NodeChildProcess {
  execFileSync(
    file: string,
    args: string[],
    options: { cwd: string; stdio: string; timeout: number },
  ): unknown;
  spawn(
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      stdio: string[];
    },
  ): ChildLike;
}
interface NodeFs {
  mkdtempSync(prefix: string): string;
  rmSync(target: string, options: { recursive: boolean; force: boolean }): void;
}
interface NodeNet {
  createServer(): {
    once(event: 'error', listener: (error: unknown) => void): void;
    listen(port: number, host: string, listener: () => void): void;
    address(): { port: number } | string | null;
    close(listener: () => void): void;
  };
}
interface NodePath {
  dirname(file: string): string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

const nodeProcess = jest.requireActual<{
  env: Record<string, string | undefined>;
}>('process');
const childProcess = jest.requireActual<NodeChildProcess>('child_process');
const fs = jest.requireActual<NodeFs>('fs');
const net = jest.requireActual<NodeNet>('net');
const os = jest.requireActual<{ tmpdir(): string }>('os');
const path = jest.requireActual<NodePath>('path');

const RUN = nodeProcess.env.DOLGATE_TEAM_E2E === '1';
const PASSWORD = 'team-e2e-password-1234';
const DESKTOP_HEADERS = {
  'X-Dolgate-Client': 'desktop',
  'X-Dolgate-Client-Version': '1.9.14',
};
const UPDATED_AT = '2026-10-27T00:00:00.000Z';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));

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

interface Account {
  email: string;
  userId: string;
  accessToken: string;
  /** 개인 DEK. 서버는 모른다 — 서버에는 감싼 것(여기서는 아무 바이트)만 올라간다. */
  dek: Uint8Array;
  epoch: number;
}

function uuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 클라이언트가 쓰는 봉투로 잠근 레코드 한 건. */
function sealed<T>(id: string, value: T, key: Uint8Array): SyncRecord {
  const iv = randomBytes(12);
  const box = gcm(key, iv).encrypt(Buffer.from(JSON.stringify(value), 'utf8'));
  return {
    id,
    encrypted_payload: JSON.stringify({
      v: 1,
      iv: fromByteArray(iv),
      tag: fromByteArray(box.slice(box.length - 16)),
      ciphertext: fromByteArray(box.slice(0, box.length - 16)),
    }),
    updated_at: UPDATED_AT,
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === 'object' && address ? address.port : 0),
      );
    });
  });
}

/** 감시 한 바퀴 — 기다렸다 바뀌었으면 당긴다(루프가 하는 것과 같다). */
async function watchOnce(loop: SyncWatchLoopOptions): Promise<string> {
  const outcome = await loop.watch(new AbortController().signal);
  if (outcome === 'changed') {
    await loop.onChange();
  }
  return outcome;
}

(RUN ? describe : describe.skip)(
  'team sync against the real sync server',
  () => {
    let workDir = '';
    let baseUrl = '';
    let server: ChildLike | null = null;
    let serverLog = '';
    let accountA: Account;
    let accountB: Account;
    let teamId = '';
    let teamDek: Uint8Array;

    async function api(
      token: string | null,
      method: string,
      route: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await fetch(new URL(route, baseUrl).toString(), {
        method,
        headers: {
          'content-type': 'application/json',
          ...DESKTOP_HEADERS,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
    }

    async function createAccount(email: string): Promise<Account> {
      const signup = await api(null, 'POST', '/auth/signup', {
        email,
        password: PASSWORD,
      });
      expect(signup.status).toBe(201);
      const session = signup.body as {
        user: { id: string };
        tokens: { accessToken: string };
        vaultBootstrap?: { epoch?: number };
      };
      const vault = await api(
        session.tokens.accessToken,
        'POST',
        '/auth/vault',
        {
          wrappedDekBase64: fromByteArray(randomBytes(60)),
          dekVerifierBase64: fromByteArray(randomBytes(32)),
          kdf: {
            algorithm: 'argon2id',
            saltBase64: fromByteArray(randomBytes(16)),
            memoryKib: 64 * 1024,
            timeCost: 3,
            parallelism: 1,
          },
          expectedEpoch: session.vaultBootstrap?.epoch ?? 0,
        },
      );
      expect(vault.status).toBe(200);
      return {
        email,
        userId: session.user.id,
        accessToken: session.tokens.accessToken,
        dek: randomBytes(32),
        epoch: Number(vault.body.epoch),
      };
    }

    /** B 의 폰 — 모바일의 실제 받기 코드. 감시 루프는 시험이 한 바퀴씩 돌린다. */
    function phoneOf(account: Account) {
      const state: TeamSyncStoreState = {
        hosts: [],
        groups: [],
        knownHosts: [],
        awsProfiles: [],
        tailnets: [],
        snippets: [],
        secretsByRef: {},
        teamVaults: [],
        teamSecrets: {},
      };
      const loops: SyncWatchLoopOptions[] = [];
      const sync = createTeamSync({
        readAccess: () => ({
          serverUrl: baseUrl,
          accessToken: account.accessToken,
          personalDekBase64: fromByteArray(account.dek),
          vaultEpoch: account.epoch,
          generation: 1,
        }),
        refreshAccessToken: async () => null,
        getState: () => state,
        setState: patch => Object.assign(state, patch),
        isForeground: () => true,
        startLoop: options => {
          loops.push(options);
          return { stop: () => undefined, retryNow: () => undefined };
        },
      });
      return { state, sync, loops };
    }

    beforeAll(async () => {
      const syncApiDir = path.resolve(
        path.dirname(expect.getState().testPath ?? ''),
        '../../../services/sync-api',
      );
      workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'dolgate-mobile-team-e2e-'),
      );
      const binary = path.join(workDir, 'sync-api');
      childProcess.execFileSync('go', ['build', '-o', binary, './cmd/api'], {
        cwd: syncApiDir,
        stdio: 'pipe',
        timeout: 240_000,
      });
      const port = await freePort();
      baseUrl = `http://127.0.0.1:${port}`;
      server = childProcess.spawn(binary, [], {
        cwd: workDir,
        env: {
          ...nodeProcess.env,
          PORT: String(port),
          DATABASE_URL: `file:${path.join(workDir, 'sync.db')}`,
          AUTH_SIGNING_PRIVATE_KEY_PATH: path.join(workDir, 'signing.pem'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      server.stdout?.on('data', chunk => (serverLog += String(chunk)));
      server.stderr?.on('data', chunk => (serverLog += String(chunk)));
      const deadline = Date.now() + 30_000;
      for (;;) {
        const healthy = await fetch(new URL('/healthz', baseUrl).toString())
          .then(response => response.ok)
          .catch(() => false);
        if (healthy) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`sync-api did not start:\n${serverLog}`);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      accountA = await createAccount('a@mobile-team-e2e.test');
      accountB = await createAccount('b@mobile-team-e2e.test');
    }, 300_000);

    afterAll(() => {
      server?.kill('SIGTERM');
      if (workDir) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('A 가 팀을 만들어 올리고 링크로 B 를 들이면, B 의 폰이 팀 것을 받는다', async () => {
      // A — 데스크톱이 하는 대로: 팀 키를 만들어 내 개인 DEK 로 감싸 올리고, 레코드를 팀 키로 잠가 올린다.
      teamId = uuid();
      teamDek = createTeamDek();
      const created = await api(
        accountA.accessToken,
        'POST',
        '/teams',
        {
          id: teamId,
          name: 'Acme',
          wrappedTeamDek: wrapTeamDek(teamDek, accountA.dek, teamId),
        },
        { 'X-Dolgate-Vault-Epoch': String(accountA.epoch) },
      );
      expect(created.status).toBe(201);
      const pushed = await api(
        accountA.accessToken,
        'POST',
        `/teams/${teamId}/sync`,
        {
          hosts: [
            sealed(
              'e2e-app',
              sshHost('e2e-app', 'app', {
                secretRef: 'e2e-secret',
                favorite: true,
              }),
              teamDek,
            ),
            sealed('e2e-bastion', sshHost('e2e-bastion', 'bastion'), teamDek),
          ],
          secrets: [
            sealed(
              'e2e-secret',
              {
                secretRef: 'e2e-secret',
                label: 'app',
                password: 'team-pw',
                updatedAt: UPDATED_AT,
              },
              teamDek,
            ),
          ],
        },
        { 'X-Dolgate-Sync-Data-Floor': '1' },
      );
      expect(pushed.status).toBeLessThan(300);

      // 링크 — 상자에 팀 키, 서버에는 참여 토큰의 해시.
      const secret = createTeamInviteSecret();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const invite = await api(
        accountA.accessToken,
        'POST',
        `/teams/${teamId}/invites`,
        {
          inviteBox: sealTeamInviteBox({ secret, teamId, teamDek, expiresAt }),
          sealedSecret: sealTeamInviteSecret({ secret, teamId, teamDek }),
          joinTokenHash: hashTeamInviteJoinToken(
            deriveTeamInviteJoinToken(secret),
          ),
          expiresAt,
          role: 'member',
        },
      );
      expect(invite.status).toBeLessThan(300);

      // B — 데스크톱에서 링크로 들어와 팀 키를 내 개인 DEK 로 감싸 올린다(폰은 참여하지 않는다).
      const joined = await api(
        accountB.accessToken,
        'POST',
        `/invite/${String(invite.body.code)}/join`,
        undefined,
        { 'X-Dolgate-Invite-Token': deriveTeamInviteJoinToken(secret) },
      );
      expect(joined.status).toBeLessThan(300);
      const opened = openTeamInviteBox({
        secret,
        teamId,
        box: String(joined.body.inviteBox),
      });
      const keyed = await api(
        accountB.accessToken,
        'PUT',
        `/teams/${teamId}/key`,
        { wrappedTeamDek: wrapTeamDek(opened.teamDek, accountB.dek, teamId) },
        { 'X-Dolgate-Vault-Epoch': String(accountB.epoch) },
      );
      expect(keyed.status).toBeLessThan(300);
      // B 의 데스크톱이 남긴 내 개인 칸 — 내 개인 DEK 로 잠갔다.
      const privateSlot = await api(
        accountB.accessToken,
        'PUT',
        `/teams/${teamId}/me`,
        {
          hostPrefs: [
            sealed(
              'e2e-app',
              {
                id: 'e2e-app',
                favorite: true,
                agentForwarding: null,
                rdpCertificateFingerprint: null,
                knownHosts: [],
                updatedAt: UPDATED_AT,
              },
              accountB.dek,
            ),
          ],
          hostCredentials: [
            sealed(
              'e2e-bastion',
              {
                id: 'e2e-bastion',
                updatedAt: UPDATED_AT,
                credentials: { username: 'b', password: 'b-pw' },
              },
              accountB.dek,
            ),
          ],
        },
        { 'X-Dolgate-Vault-Epoch': String(accountB.epoch) },
      );
      expect(privateSlot.status).toBeLessThan(300);

      const phone = phoneOf(accountB);
      await phone.sync.refresh();

      expect(phone.state.teamVaults).toHaveLength(1);
      const vault = phone.state.teamVaults[0];
      expect(vault).toMatchObject({
        id: teamId,
        name: 'Acme',
        role: 'member',
        state: 'ready',
      });
      expect(vault.hosts.map(host => host.id)).toEqual([
        'e2e-app',
        'e2e-bastion',
      ]);
      expect(vault.hosts[0]).toMatchObject({ favorite: null });
      expect(vault.hostPrefs).toEqual([
        expect.objectContaining({ id: 'e2e-app', favorite: true }),
      ]);
      expect(phone.state.teamSecrets[teamId]).toEqual({
        secretsByRef: {
          'e2e-secret': expect.objectContaining({ password: 'team-pw' }),
        },
        hostCredentials: { 'e2e-bastion': { username: 'b', password: 'b-pw' } },
      });
    }, 60_000);

    it('B 의 폰이 별표·호스트 키·자격 증명을 고치면 내 개인 칸에 올라가고, 데스크톱이 푸는 그대로 나온다', async () => {
      const phone = phoneOf(accountB);
      await phone.sync.refresh();
      const trusted = {
        id: 'known-e2e-bastion',
        host: 'bastion.internal',
        port: 22,
        algorithm: 'ssh-ed25519',
        publicKeyBase64: fromByteArray(randomBytes(51)),
        fingerprintSha256: 'SHA256:e2e-bastion',
        createdAt: UPDATED_AT,
        lastSeenAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
      };

      phone.sync.updateHostPrefs(teamId, 'e2e-bastion', prefs => ({
        ...prefs,
        favorite: true,
        knownHosts: [trusted],
      }));
      await phone.sync.updateHostCredentials(teamId, 'e2e-app', current => ({
        ...current,
        username: 'b-app',
        password: 'b-app-pw',
      }));
      // 올리기는 팀마다 한 줄로 돈다 — 다시 받기가 그 줄 끝까지 기다린다.
      await phone.sync.refresh();

      const slot = await api(
        accountB.accessToken,
        'GET',
        `/teams/${teamId}/me`,
      );
      expect(slot.status).toBe(200);
      const prefs = decodeSyncRecords<unknown>(
        (slot.body.hostPrefs ?? []) as SyncRecord[],
        fromByteArray(accountB.dek),
      ).map(normalizeTeamHostPrefsRecord);
      const credentials = decodeSyncRecords<{
        id: string;
        updatedAt: string;
        credentials: unknown;
      }>(
        (slot.body.hostCredentials ?? []) as SyncRecord[],
        fromByteArray(accountB.dek),
      ).map(record => ({
        id: record.id,
        credentials: normalizeTeamHostCredentials(record.credentials),
      }));

      // 데스크톱이 남긴 것(e2e-app 별표·e2e-bastion 자격 증명)은 그대로 있고, 폰이 쓴 것이 더해졌다.
      expect(prefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'e2e-app', favorite: true }),
          expect.objectContaining({
            id: 'e2e-bastion',
            favorite: true,
            knownHosts: [trusted],
          }),
        ]),
      );
      expect(credentials).toEqual(
        expect.arrayContaining([
          {
            id: 'e2e-bastion',
            credentials: { username: 'b', password: 'b-pw' },
          },
          {
            id: 'e2e-app',
            credentials: { username: 'b-app', password: 'b-app-pw' },
          },
        ]),
      );
      // 폰에도 그대로 남는다 — 받아도 덮이지 않았다.
      expect(
        phone.state.teamSecrets[teamId]?.hostCredentials['e2e-app'],
      ).toEqual({
        username: 'b-app',
        password: 'b-app-pw',
      });
    }, 60_000);

    it('B 의 폰이 팀 호스트에 붙었다 끊으면 그 줄이 팀 기록에 오르고, A 가 같은 팀 키로 풀면 모바일 줄이다', async () => {
      const phone = phoneOf(accountB);
      await phone.sync.refresh();

      // 스토어 대신 세션 칸만 가진 작은 스토어 — 팀 칸은 폰이 받은 것이다.
      let state: TeamHistorySource = {
        hosts: [],
        teamVaults: phone.state.teamVaults,
        teamSecrets: phone.state.teamSecrets,
        sessions: [],
        sftpSessions: [],
        remoteDesktopSessions: [],
        sftpTransfers: [],
      };
      const listeners: Array<
        (next: TeamHistorySource, previous: TeamHistorySource) => void
      > = [];
      const setSessions = (status: 'connected' | 'closed') => {
        const previous = state;
        state = {
          ...state,
          sessions: [
            {
              id: 'e2e-tab',
              sessionId: 'e2e-tab',
              hostId: 'e2e-app',
              title: 'app',
              status,
              connectionKind: 'ssh',
              connectionDetails: 'b-app@app.internal:22',
              hasReceivedOutput: true,
              isRestorable: true,
              lastViewportSnapshot: '',
              lastEventAt: UPDATED_AT,
              lastConnectedAt: UPDATED_AT,
            },
          ],
        };
        listeners.forEach(listener => listener(state, previous));
      };
      const storage = new Map<string, string>();
      const history = createTeamHistory({
        subscribe: listener => {
          listeners.push(listener);
          return () => undefined;
        },
        send: (teamIdToSend, events) =>
          phone.sync.sendTeamEvents(teamIdToSend, events),
        storage: {
          getItem: async key => storage.get(key) ?? null,
          setItem: async (key, value) => {
            storage.set(key, value);
          },
          removeItem: async key => {
            storage.delete(key);
          },
        },
      });
      history.start();
      setSessions('connected');
      setSessions('closed');
      // 로그아웃 직전과 같은 길 — 남은 것을 바로 올린다.
      await history.finishBeforeLogout(10_000);
      await new Promise(resolve => setTimeout(resolve, 50));

      const listed = await api(
        accountA.accessToken,
        'GET',
        `/teams/${teamId}/events`,
      );
      expect(listed.status).toBe(200);
      const appEvents = (
        listed.body.events as Array<{
          id: string;
          source: string;
          authorEmail: string;
          payload: string;
        }>
      ).filter(event => event.source === 'app');
      expect(appEvents).toHaveLength(2);
      expect(
        appEvents.every(event => event.authorEmail === accountB.email),
      ).toBe(true);
      const lines = appEvents.map(event =>
        openTeamEventBody<{
          v: number;
          phase: string;
          client: string;
          record: {
            id: string;
            kind: string;
            metadata: Record<string, unknown>;
          };
        }>(teamDek, teamId, event.id, event.payload),
      );
      expect(lines.map(line => line.phase).sort()).toEqual(['end', 'start']);
      expect(
        lines.every(line => line.v === 1 && line.client === 'mobile'),
      ).toBe(true);
      expect(lines[0]?.record.id).toBe(lines[1]?.record.id);
      expect(lines.map(line => line.record.metadata.status).sort()).toEqual([
        'closed',
        'connected',
      ]);
      expect(lines[0]?.record).toMatchObject({
        kind: 'session-lifecycle',
        metadata: {
          hostId: 'e2e-app',
          connectionDetails: 'b-app@app.internal:22',
          recordingId: null,
        },
      });
      expect(storage.size).toBe(0);
    }, 60_000);

    it('감시로 A 가 올린 것을 받고, A 가 B 를 빼면 B 의 폰에서 그 팀이 지워진다', async () => {
      const phone = phoneOf(accountB);
      await phone.sync.refresh();
      expect(phone.loops).toHaveLength(1);
      // 첫 감시는 바로 답한다(아는 리비전이 없다).
      expect(await watchOnce(phone.loops[0])).toBe('changed');

      const pushed = await api(
        accountA.accessToken,
        'POST',
        `/teams/${teamId}/sync`,
        { hosts: [sealed('e2e-db', sshHost('e2e-db', 'db'), teamDek)] },
        { 'X-Dolgate-Sync-Data-Floor': '1' },
      );
      expect(pushed.status).toBeLessThan(300);
      expect(await watchOnce(phone.loops[0])).toBe('changed');
      expect(phone.state.teamVaults[0].hosts.map(host => host.id)).toContain(
        'e2e-db',
      );

      const removed = await api(
        accountA.accessToken,
        'POST',
        `/teams/${teamId}/members/${accountB.userId}/remove`,
      );
      expect(removed.status).toBeLessThan(300);
      await watchOnce(phone.loops[0]);
      expect(phone.state.teamVaults).toEqual([]);
      expect(phone.state.teamSecrets).toEqual({});
    }, 60_000);
  },
);
