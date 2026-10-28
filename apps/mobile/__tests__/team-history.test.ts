import type {
  HostRecord,
  MobileRemoteDesktopSessionRecord,
  MobileSessionRecord,
  MobileSftpSessionRecord,
  MobileSftpTransferRecord,
  TeamActivityBody,
} from '@dolssh/shared-core';
import {
  createTeamHistory,
  type TeamHistorySource,
  type TeamHistoryStorage,
} from '../src/store/team-history';
import type {
  MobileTeamVault,
  TeamEventDraft,
  TeamEventsOutcome,
} from '../src/store/team-sync';

// 폰의 팀 기록(작업 8-5) — 팀 호스트 접속의 시작·끝 줄, 대기열, 앱이 꺼져 남은 줄, 빠진 팀·로그아웃·지우기.
// 스토어 대신 작은 가짜 스토어를 지켜보게 하고, 보내기·앱 저장소·타이머를 손으로 돌린다.

// lib/mobile 이 저장소·키체인을 딸고 온다. 이 시험은 그것을 쓰지 않는다.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));

const OUTBOX_KEY = 'dolgate-mobile-team-history';
const OPEN_LINES_KEY = 'dolgate-mobile-team-history-open';
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONNECTED_AT = '2026-10-27T01:00:00.000Z';

function sshHost(id: string, label: string, kind = 'ssh'): HostRecord {
  return {
    id,
    kind,
    label,
    hostname: `${label}.internal`,
    port: kind === 'vnc' ? 5901 : 22,
    username: 'ops',
    authType: 'password',
    groupName: null,
    tags: [],
    createdAt: CONNECTED_AT,
    updatedAt: CONNECTED_AT,
  } as HostRecord;
}

function teamVault(id: string, hosts: HostRecord[]): MobileTeamVault {
  return {
    id,
    name: id,
    role: 'member',
    wrappedTeamDek: 'wrapped',
    state: 'ready',
    errorMessage: null,
    hosts,
    groups: [],
    knownHosts: [],
    awsProfiles: [],
    tailnets: [],
    snippets: [],
    hostPrefs: [],
  };
}

function terminal(
  id: string,
  hostId: string,
  status: MobileSessionRecord['status'],
  extra: Partial<MobileSessionRecord> = {},
): MobileSessionRecord {
  return {
    id,
    sessionId: id,
    hostId,
    title: 'tab title',
    status,
    connectionKind: 'ssh',
    connectionDetails: 'ops@app.internal:22',
    hasReceivedOutput: true,
    isRestorable: true,
    lastViewportSnapshot: '',
    lastEventAt: CONNECTED_AT,
    lastConnectedAt: status === 'connected' ? CONNECTED_AT : null,
    ...extra,
  };
}

function sftp(
  id: string,
  hostId: string,
  status: MobileSftpSessionRecord['status'],
  currentPath = '/home/ops',
): MobileSftpSessionRecord {
  return {
    id,
    hostId,
    title: 'app SFTP',
    status,
    currentPath,
    lastEventAt: CONNECTED_AT,
    lastConnectedAt: status === 'connected' ? CONNECTED_AT : null,
  };
}

function desktop(
  id: string,
  hostId: string,
  status: MobileRemoteDesktopSessionRecord['status'],
  extra: Partial<MobileRemoteDesktopSessionRecord> = {},
): MobileRemoteDesktopSessionRecord {
  return {
    id,
    hostId,
    protocol: 'vnc',
    title: 'desk',
    status,
    inputMode: 'touch',
    scaleMode: 'fit',
    lastEventAt: CONNECTED_AT,
    lastConnectedAt: status === 'connected' ? CONNECTED_AT : null,
    ...extra,
  };
}

function transfer(
  id: string,
  sftpSessionId: string,
  direction: MobileSftpTransferRecord['direction'],
  status: MobileSftpTransferRecord['status'],
  bytesTransferred: number,
): MobileSftpTransferRecord {
  return {
    id,
    sftpSessionId,
    direction,
    remotePath: `/home/ops/${id}`,
    localName: id,
    status,
    bytesTransferred,
    createdAt: CONNECTED_AT,
    updatedAt: CONNECTED_AT,
  };
}

/** 지켜보는 칸만 가진 작은 스토어 — 고치면 지켜보는 쪽에 지금 것과 앞의 것을 준다(zustand 와 같다). */
function fakeStore() {
  let state: TeamHistorySource = {
    hosts: [sshHost('mine', 'mine')],
    teamVaults: [
      teamVault('team-acme', [
        sshHost('acme-app', 'app'),
        sshHost('acme-desk', 'desk', 'vnc'),
      ]),
      teamVault('team-beta', [sshHost('beta-db', 'db')]),
    ],
    teamSecrets: {},
    sessions: [],
    sftpSessions: [],
    remoteDesktopSessions: [],
    sftpTransfers: [],
  };
  const listeners = new Set<
    (next: TeamHistorySource, previous: TeamHistorySource) => void
  >();
  return {
    get: () => state,
    set(patch: Partial<TeamHistorySource>) {
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of listeners) {
        listener(state, previous);
      }
    },
    subscribe(
      listener: (next: TeamHistorySource, previous: TeamHistorySource) => void,
    ) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 앱 저장소 — 키마다 문자열. */
function memoryStorage(): TeamHistoryStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async key => {
      data.delete(key);
    },
  };
}

/** 손으로 돌리는 타이머. */
function manualTimers() {
  const pending: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  return {
    setTimer(callback: () => void, delayMs: number) {
      const timer = { callback, delayMs, cancelled: false };
      pending.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    /** 걸려 있는 타이머의 시간들. */
    delays: () =>
      pending.filter(timer => !timer.cancelled).map(timer => timer.delayMs),
    /** 걸려 있는 것을 모두 울리고 그 뒤의 일을 마저 돌린다. */
    async fire() {
      const due = pending.splice(0).filter(timer => !timer.cancelled);
      for (const timer of due) {
        timer.callback();
      }
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  }
}

function harness(options?: {
  storage?: ReturnType<typeof memoryStorage>;
  send?: (
    teamId: string,
    events: TeamEventDraft[],
  ) => Promise<TeamEventsOutcome>;
}) {
  const store = fakeStore();
  const storage = options?.storage ?? memoryStorage();
  const timers = manualTimers();
  const sent: Array<{ teamId: string; events: TeamEventDraft[] }> = [];
  const send = jest.fn(
    options?.send ??
      (async (teamId: string, events: TeamEventDraft[]) => {
        sent.push({ teamId, events });
        return 'sent' as const;
      }),
  );
  const history = createTeamHistory({
    subscribe: listener => store.subscribe(listener),
    send,
    storage,
    setTimer: (callback, delayMs) => timers.setTimer(callback, delayMs),
  });
  history.start();
  return { store, storage, timers, sent, send, history };
}

/** 보낸 줄의 본문(보낸 차례대로). */
function bodies(sent: Array<{ events: TeamEventDraft[] }>): TeamActivityBody[] {
  return sent.flatMap(batch =>
    batch.events.map(event => event.body as TeamActivityBody),
  );
}

function storedOutbox(storage: ReturnType<typeof memoryStorage>) {
  const raw = storage.data.get(OUTBOX_KEY);
  return raw
    ? (
        JSON.parse(raw) as {
          teams: Record<
            string,
            Array<{ eventId: string; body: TeamActivityBody }>
          >;
        }
      ).teams
    : {};
}

describe('team history — 줄 만들기', () => {
  it('팀 호스트 세션이 붙으면 시작, 닫히면 끝 — 같은 줄 id, 모바일 표시, 데스크톱 번역 키', async () => {
    const { store, timers, sent } = harness();
    await settle();

    store.set({ sessions: [terminal('t1', 'acme-app', 'connecting')] });
    expect(timers.delays()).toEqual([]);
    store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    store.set({ sessions: [terminal('t1', 'acme-app', 'disconnecting')] });
    store.set({ sessions: [terminal('t1', 'acme-app', 'closed')] });
    await timers.fire();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.teamId).toBe('team-acme');
    const [start, end] = bodies(sent);
    expect(sent[0]?.events.every(event => CANONICAL_UUID.test(event.id))).toBe(
      true,
    );
    expect(start).toMatchObject({
      v: 1,
      phase: 'start',
      client: 'mobile',
      record: {
        level: 'info',
        category: 'session',
        kind: 'session-lifecycle',
        message: 'SSH 세션',
        messageKey: 'core.sessionLog',
        messageParams: { kind: 'SSH' },
        createdAt: CONNECTED_AT,
        metadata: {
          sessionId: 't1',
          hostId: 'acme-app',
          hostLabel: 'app',
          title: 'tab title',
          connectionDetails: 'ops@app.internal:22',
          connectionKind: 'ssh',
          connectedAt: CONNECTED_AT,
          disconnectedAt: null,
          durationMs: null,
          status: 'connected',
          recordingId: null,
          hasReplay: false,
        },
      },
    });
    expect(start?.record.id).toMatch(/^session:/);
    expect(end).toMatchObject({
      phase: 'end',
      client: 'mobile',
      record: {
        id: start?.record.id,
        level: 'info',
        createdAt: CONNECTED_AT,
        metadata: { status: 'closed', disconnectReason: null },
      },
    });
    const metadata = end?.record.metadata as Record<string, unknown>;
    expect(typeof metadata.disconnectedAt).toBe('string');
    expect(metadata.durationMs).toBe(
      Date.parse(metadata.disconnectedAt as string) - Date.parse(CONNECTED_AT),
    );
    expect(sent[0]?.events[1]?.createdAt).toBe(metadata.disconnectedAt);
  });

  it('개인 호스트 세션은 남기지 않는다', async () => {
    const { store, timers, send, storage } = harness();
    await settle();

    store.set({ sessions: [terminal('t1', 'mine', 'connected')] });
    store.set({
      sftpSessions: [sftp('s1', 'mine', 'connected')],
      remoteDesktopSessions: [desktop('d1', 'mine', 'connected')],
    });
    store.set({ sessions: [terminal('t1', 'mine', 'closed')] });
    await timers.fire();

    expect(send).not.toHaveBeenCalled();
    expect(storage.data.has(OUTBOX_KEY)).toBe(false);
    expect(storage.data.has(OPEN_LINES_KEY)).toBe(false);
  });

  it('끊겼다 다시 붙으면 새 줄이다 — 끊긴 까닭은 앞 줄의 끝에 남는다', async () => {
    const { store, timers, sent } = harness();
    await settle();

    store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    store.set({
      sessions: [
        terminal('t1', 'acme-app', 'error', {
          errorMessage: '연결이 끊겼습니다.',
          disconnectReason: 'dropped',
        }),
      ],
    });
    store.set({ sessions: [terminal('t1', 'acme-app', 'connecting')] });
    store.set({
      sessions: [
        terminal('t1', 'acme-app', 'connected', {
          lastConnectedAt: '2026-10-27T02:00:00.000Z',
        }),
      ],
    });
    await timers.fire();

    const lines = bodies(sent);
    expect(lines.map(body => body.phase)).toEqual(['start', 'end', 'start']);
    expect(lines[1]).toMatchObject({
      record: {
        id: lines[0]?.record.id,
        level: 'error',
        metadata: { status: 'error', disconnectReason: '연결이 끊겼습니다.' },
      },
    });
    expect(lines[2]?.record.id).not.toBe(lines[0]?.record.id);
    expect(lines[2]?.record.createdAt).toBe('2026-10-27T02:00:00.000Z');
  });

  it('탭을 지워 목록에서 빠져도 닫힌 것으로 끝낸다', async () => {
    const { store, timers, sent } = harness();
    await settle();

    store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    store.set({ sessions: [] });
    await timers.fire();

    expect(bodies(sent).map(body => body.phase)).toEqual(['start', 'end']);
    expect(bodies(sent)[1]?.record.metadata).toMatchObject({
      status: 'closed',
    });
  });

  it('원격 데스크톱은 RDP·VNC 로 남고, 붙었다는 소식이 여러 번 와도 한 줄이다', async () => {
    const { store, timers, sent } = harness();
    await settle();

    store.set({
      remoteDesktopSessions: [desktop('d1', 'acme-desk', 'connected')],
    });
    // 크기가 바뀔 때마다 connected 가 다시 온다(붙은 시각도 바뀐다).
    store.set({
      remoteDesktopSessions: [
        desktop('d1', 'acme-desk', 'connected', {
          lastConnectedAt: '2026-10-27T01:05:00.000Z',
          desktopWidth: 1280,
        }),
      ],
    });
    store.set({
      remoteDesktopSessions: [desktop('d1', 'acme-desk', 'closed')],
    });
    await timers.fire();

    const lines = bodies(sent);
    expect(lines.map(body => body.phase)).toEqual(['start', 'end']);
    expect(lines[0]?.record).toMatchObject({
      message: 'VNC 세션',
      messageParams: { kind: 'VNC' },
      metadata: {
        sessionId: 'd1',
        connectionKind: 'vnc',
        hostLabel: 'desk',
        connectionDetails: 'desk.internal · 5901',
      },
    });
  });

  it('AWS SSM 터미널은 AWS SSM 으로 남는다', async () => {
    const { store, timers, sent } = harness();
    await settle();

    store.set({
      sessions: [
        terminal('t1', 'acme-app', 'connected', {
          connectionKind: 'aws-ssm',
          connectionDetails: 'acme · ap-northeast-2 · i-0abc',
        }),
      ],
    });
    await timers.fire();

    expect(bodies(sent)[0]?.record).toMatchObject({
      messageParams: { kind: 'AWS SSM' },
      metadata: {
        connectionKind: 'aws-ssm',
        connectionDetails: 'acme · ap-northeast-2 · i-0abc',
      },
    });
  });

  it('SFTP 는 들른 곳·전송·고친 것·실패를 세어 끝 줄에 싣는다', async () => {
    const { store, timers, sent, history } = harness();
    await settle();

    store.set({ sftpSessions: [sftp('s1', 'acme-app', 'connected')] });
    store.set({
      sftpSessions: [sftp('s1', 'acme-app', 'connected', '/var/log')],
    });
    store.set({
      sftpSessions: [sftp('s1', 'acme-app', 'connected', '/home/ops')],
    });
    // 마지막으로 연 곳은 처음과 다른 곳이다 — 마지막 경로가 따라오는지 본다.
    store.set({
      sftpSessions: [sftp('s1', 'acme-app', 'connected', '/tmp')],
    });
    store.set({
      sftpTransfers: [
        transfer('x1', 's1', 'download', 'running', 10),
        transfer('x2', 's1', 'upload', 'running', 0),
      ],
    });
    store.set({
      sftpTransfers: [
        transfer('x1', 's1', 'download', 'completed', 100),
        transfer('x2', 's1', 'upload', 'completed', 50),
        transfer('x3', 's1', 'copy', 'completed', 10),
        transfer('x4', 's1', 'download', 'error', 3),
      ],
    });
    // 끝난 전송을 다시 고쳐 써도(내려받은 이름 등) 두 번 세지 않는다.
    store.set({
      sftpTransfers: [
        transfer('x1', 's1', 'download', 'completed', 100),
        transfer('x2', 's1', 'upload', 'completed', 50),
        transfer('x3', 's1', 'copy', 'completed', 10),
        transfer('x4', 's1', 'download', 'error', 3),
      ],
    });
    history.countSftp('s1', { mkdirCount: 1 });
    history.countSftp('s1', { renameCount: 1 });
    history.countSftp('s1', { chmodCount: 1 });
    history.countSftp('s1', { deleteCount: 2 });
    history.countSftp('s1', { errorCount: 1 });
    // 개인 호스트의 SFTP·없는 SFTP 는 세지 않는다.
    history.countSftp('other', { mkdirCount: 1 });
    store.set({ sftpSessions: [sftp('s1', 'acme-app', 'closed')] });
    await timers.fire();

    const [start, end] = bodies(sent);
    expect(start?.record).toMatchObject({
      kind: 'sftp-lifecycle',
      message: 'SFTP 세션',
      messageKey: 'core.sftpSession',
      metadata: {
        endpointId: 's1',
        hostLabel: 'app',
        title: 'app SFTP',
        startedAt: CONNECTED_AT,
        connectedAt: CONNECTED_AT,
        status: 'connected',
        uploadedCount: 0,
        errorCount: 0,
        visitedPathCount: 1,
        lastPath: '/home/ops',
      },
    });
    expect(start?.record.id).toMatch(/^sftp:/);
    expect(end?.record).toMatchObject({
      id: start?.record.id,
      level: 'error',
      metadata: {
        status: 'closed',
        endReason: null,
        downloadedCount: 1,
        downloadedBytes: 100,
        uploadedCount: 1,
        uploadedBytes: 50,
        remoteCopyCount: 1,
        remoteCopyBytes: 10,
        mkdirCount: 1,
        renameCount: 1,
        chmodCount: 1,
        chownCount: 0,
        deleteCount: 2,
        errorCount: 2,
        visitedPathCount: 3,
        lastPath: '/tmp',
      },
    });
    expect(
      typeof (end?.record.metadata as Record<string, unknown>).endedAt,
    ).toBe('string');
  });

  it('긴 오류 문구는 줄여 본문을 11KB 안에 둔다', async () => {
    const { store, timers, sent } = harness();
    await settle();

    store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    store.set({
      sessions: [
        terminal('t1', 'acme-app', 'error', {
          errorMessage: 'x'.repeat(20_000),
        }),
      ],
    });
    await timers.fire();

    const end = bodies(sent)[1];
    expect(
      new TextEncoder().encode(JSON.stringify(end)).length,
    ).toBeLessThanOrEqual(11 * 1024);
    expect(
      (end?.record.metadata as Record<string, unknown>).disconnectReason,
    ).toBe(`${'x'.repeat(300)}…`);
  });
});

describe('team history — 대기열', () => {
  /** 팀 호스트 접속 count 번(시작·끝 두 줄씩). 붙은 시각은 from 번째 초부터 1초씩 늦다. */
  function connectTimes(
    store: ReturnType<typeof fakeStore>,
    count: number,
    hostId = 'acme-app',
    from = 0,
  ) {
    for (let index = 0; index < count; index += 1) {
      const at = new Date(
        Date.parse(CONNECTED_AT) + (from + index) * 1000,
      ).toISOString();
      store.set({
        sessions: [
          terminal(`t${index}`, hostId, 'connected', { lastConnectedAt: at }),
        ],
      });
      store.set({ sessions: [] });
    }
  }

  it('100줄씩 보내고 보낸 것만 뺀다 — 다 보내면 앱 저장소에서도 지운다', async () => {
    const { store, timers, sent, storage } = harness();
    await settle();

    connectTimes(store, 75);
    await settle();
    expect(storedOutbox(storage)['team-acme']).toHaveLength(150);
    await timers.fire();

    expect(sent.map(batch => batch.events.length)).toEqual([100, 50]);
    expect(storage.data.has(OUTBOX_KEY)).toBe(false);
  });

  it('오프라인이면 남겨 두고 늦춰 가며 다시 보낸다', async () => {
    let online = false;
    const sent: TeamEventDraft[] = [];
    const { store, timers, storage } = harness({
      send: async (_teamId, events) => {
        if (!online) {
          throw new TypeError('Network request failed');
        }
        sent.push(...events);
        return 'sent';
      },
    });
    await settle();

    connectTimes(store, 1);
    await timers.fire();
    expect(timers.delays()).toEqual([2000]);
    await timers.fire();
    expect(timers.delays()).toEqual([4000]);
    expect(storedOutbox(storage)['team-acme']).toHaveLength(2);

    online = true;
    await timers.fire();
    expect(sent).toHaveLength(2);
    expect(timers.delays()).toEqual([]);
    expect(storage.data.has(OUTBOX_KEY)).toBe(false);
  });

  it('팀을 지금 열 수 없으면 남겨 두고, 팀 목록을 다시 읽으면(kick) 보낸다', async () => {
    let open = false;
    const sent: TeamEventDraft[] = [];
    const { store, timers, history } = harness({
      send: async (_teamId, events) => {
        if (!open) {
          return 'not-open';
        }
        sent.push(...events);
        return 'sent';
      },
    });
    await settle();

    connectTimes(store, 1);
    await timers.fire();
    // 열 수 없으면 되풀이하지 않는다 — 팀 목록이 바뀌어 kick 이 올 때까지.
    expect(timers.delays()).toEqual([]);

    open = true;
    history.kick();
    expect(timers.delays()).toEqual([0]);
    await timers.fire();
    expect(sent).toHaveLength(2);
  });

  it('팀에서 빠졌거나 팀 기록을 모르는 서버면 그 팀 것을 버리고, 다른 팀 것은 보낸다', async () => {
    const outcomes: Record<string, TeamEventsOutcome> = {
      'team-acme': 'gone',
      'team-beta': 'sent',
    };
    const sentTeams: string[] = [];
    const { store, timers, storage, send } = harness({
      send: async teamId => {
        sentTeams.push(teamId);
        return outcomes[teamId]!;
      },
    });
    await settle();

    // 한 묶음(100줄)을 넘게 쌓아 둔다 — 빠진 팀이면 그 묶음만이 아니라 팀 것을 모두 버린다.
    connectTimes(store, 60, 'acme-app');
    connectTimes(store, 1, 'beta-db');
    await timers.fire();
    expect(sentTeams).toEqual(['team-acme', 'team-beta']);
    expect(storage.data.has(OUTBOX_KEY)).toBe(false);

    outcomes['team-acme'] = 'unsupported';
    connectTimes(store, 60, 'acme-app');
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(3);
    expect(storage.data.has(OUTBOX_KEY)).toBe(false);
    expect(timers.delays()).toEqual([]);
  });

  it('서버가 받을 수 없다고 한 묶음(rejected)만 버리고 다음 묶음을 보낸다', async () => {
    const sizes: number[] = [];
    const { store, timers, storage } = harness({
      send: async (_teamId, events) => {
        sizes.push(events.length);
        return sizes.length === 1 ? 'rejected' : 'sent';
      },
    });
    await settle();

    connectTimes(store, 60);
    await timers.fire();

    expect(sizes).toEqual([100, 20]);
    expect(storage.data.has(OUTBOX_KEY)).toBe(false);
  });

  it('모두 합쳐 1,000줄을 넘으면 먼저 넣은 줄부터 버린다 — 줄의 시각이 아니라 넣은 차례로', async () => {
    const now = jest.spyOn(Date, 'now');
    let clock = Date.parse('2026-10-27T03:00:00.000Z');
    now.mockImplementation(() => (clock += 1));
    try {
      const { store, storage } = harness({ send: async () => 'not-open' });
      await settle();

      connectTimes(store, 500, 'acme-app');
      // 붙은 시각은 이른 접속이다(앱을 켜기 전에 붙어 있던 것 등) — 그래도 나중에 넣었으니 남는다.
      connectTimes(store, 1, 'beta-db', -3600);
      await settle();

      const outbox = storedOutbox(storage);
      const acme = outbox['team-acme'] ?? [];
      expect(acme.length + (outbox['team-beta']?.length ?? 0)).toBe(1000);
      expect(outbox['team-beta']).toHaveLength(2);
      // 먼저 넣은 두 줄(첫 접속의 시작·끝)이 빠졌다.
      expect(
        (acme[0]?.body.record.metadata as { sessionId: string }).sessionId,
      ).toBe('t1');
      expect(acme[0]?.body.phase).toBe('start');
    } finally {
      now.mockRestore();
    }
  });

  it('다시 켜면 앞서 못 보낸 것을 먼저 보낸다', async () => {
    const storage = memoryStorage();
    const first = harness({ storage, send: async () => 'not-open' });
    await settle();
    connectTimes(first.store, 1);
    await first.timers.fire();
    first.history.resetRuntime();

    const second = harness({ storage });
    await settle();
    connectTimes(second.store, 1);
    await second.timers.fire();

    const lines = bodies(second.sent);
    expect(lines.map(body => body.phase)).toEqual([
      'start',
      'end',
      'start',
      'end',
    ]);
    expect(lines[0]?.record.metadata).toMatchObject({ sessionId: 't0' });
    expect(lines[0]?.record.id).not.toBe(lines[2]?.record.id);
    expect(storage.data.has(OUTBOX_KEY)).toBe(false);
  });
});

describe('team history — 앱이 꺼져 남은 줄', () => {
  it('끝을 못 적은 줄은 다음에 켤 때 앱이 꺼져 끊긴 것으로 닫는다 — 끝 시각은 비우고, 센 숫자는 남긴다', async () => {
    const storage = memoryStorage();
    const first = harness({ storage, send: async () => 'not-open' });
    await settle();
    first.store.set({
      sessions: [terminal('t1', 'acme-app', 'connected')],
      sftpSessions: [sftp('s1', 'acme-app', 'connected')],
    });
    first.history.countSftp('s1', { mkdirCount: 2 });
    await settle();
    // 앱이 꺼졌다 — 끝을 적지 못했다.
    first.history.resetRuntime();
    expect(storage.data.has(OPEN_LINES_KEY)).toBe(true);

    const second = harness({ storage });
    await settle();
    await second.timers.fire();

    const lines = bodies(second.sent);
    const starts = lines.filter(body => body.phase === 'start');
    const ends = lines.filter(body => body.phase === 'end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    const sessionEnd = ends.find(
      body => body.record.kind === 'session-lifecycle',
    );
    expect(sessionEnd?.record).toMatchObject({
      id: starts.find(body => body.record.kind === 'session-lifecycle')?.record
        .id,
      level: 'info',
      metadata: {
        status: 'closed',
        disconnectedAt: null,
        durationMs: null,
        disconnectReason: '앱이 꺼져 끊겼습니다.',
      },
    });
    const sftpEnd = ends.find(body => body.record.kind === 'sftp-lifecycle');
    expect(sftpEnd?.record.metadata).toMatchObject({
      status: 'closed',
      endedAt: null,
      durationMs: null,
      endReason: '앱이 꺼져 끊겼습니다.',
      mkdirCount: 2,
    });
    expect(storage.data.has(OPEN_LINES_KEY)).toBe(false);
  });

  it('이번 실행에서 연 줄은 닫지 않는다 — 앞선 실행의 것을 읽기 전에 붙었어도', async () => {
    const storage = memoryStorage();
    const first = harness({ storage, send: async () => 'not-open' });
    await settle();
    first.store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    await settle();
    first.history.resetRuntime();

    // 읽기를 붙든 채로 새 실행이 시작되고, 그 사이 같은 탭 id 로 다시 붙는다.
    let releaseRead!: () => void;
    const held = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    const slowStorage = {
      ...storage,
      getItem: async (key: string) => {
        await held;
        return storage.getItem(key);
      },
    };
    const second = harness({ storage: slowStorage as typeof storage });
    second.store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    releaseRead();
    await settle();
    await second.timers.fire();

    const lines = bodies(second.sent);
    // 앞선 실행이 못 보낸 시작 줄이 먼저 간다 — 새 실행이 읽기 전에 쓴 것이 그것을 덮지 않았다.
    expect(lines[0]?.record.metadata).toMatchObject({ status: 'connected' });
    const fresh = lines.filter(
      body => body.phase === 'start' && body.record.id !== lines[0]?.record.id,
    );
    expect(fresh).toHaveLength(1);
    // 새 줄은 열려 있다(끝 줄이 없다). 앞선 실행의 줄만 닫혔다.
    expect(
      lines.filter(body => body.record.id === fresh[0]?.record.id),
    ).toHaveLength(1);
    expect(
      lines.filter(
        body => body.phase === 'end' && body.record.id === lines[0]?.record.id,
      ),
    ).toHaveLength(1);
    expect(storage.data.has(OPEN_LINES_KEY)).toBe(true);
  });
});

describe('team history — 빠진 팀·로그아웃·지우기', () => {
  it('빠진 팀의 열린 줄과 대기열만 버린다 — 그 뒤에 닫혀도 끝 줄이 없다', async () => {
    const { store, timers, sent, history, storage } = harness({
      send: async () => 'not-open',
    });
    await settle();

    store.set({
      sessions: [
        terminal('t1', 'acme-app', 'connected'),
        terminal('t2', 'beta-db', 'connected'),
      ],
    });
    history.forgetTeam('team-acme');
    store.set({
      sessions: [
        terminal('t1', 'acme-app', 'error', {
          errorMessage: '팀에서 빠져 이 연결을 닫았습니다.',
        }),
        terminal('t2', 'beta-db', 'connected'),
      ],
    });
    await timers.fire();

    expect(sent).toEqual([]);
    expect(Object.keys(storedOutbox(storage))).toEqual(['team-beta']);
    const open = JSON.parse(storage.data.get(OPEN_LINES_KEY) ?? '{}') as {
      lines: Array<{ teamId: string }>;
    };
    expect(open.lines.map(line => line.teamId)).toEqual(['team-beta']);
  });

  it('로그아웃 직전에는 열린 줄을 닫아 올려 본다 — 서버가 늦으면 정한 시간에 끝낸다', async () => {
    const sent: TeamEventDraft[] = [];
    let respond = true;
    const { store, timers, history } = harness({
      send: (_teamId, events) =>
        respond
          ? (sent.push(...events), Promise.resolve('sent'))
          : new Promise<TeamEventsOutcome>(() => undefined),
    });
    await settle();

    store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    await timers.fire();
    expect(sent).toHaveLength(1);

    await history.finishBeforeLogout(2000);
    expect(sent.map(event => (event.body as TeamActivityBody).phase)).toEqual([
      'start',
      'end',
    ]);
    expect((sent[1]?.body as TeamActivityBody).record.metadata).toMatchObject({
      status: 'closed',
      disconnectReason: null,
    });

    // 서버가 답하지 않으면 정한 시간에 끝낸다.
    respond = false;
    store.set({ sessions: [terminal('t2', 'acme-app', 'connected')] });
    let finished = false;
    const finishing = history.finishBeforeLogout(2000).then(() => {
      finished = true;
    });
    await settle();
    expect(finished).toBe(false);
    expect(timers.delays()).toContain(2000);
    await timers.fire();
    await finishing;
    expect(finished).toBe(true);
  });

  it('지우면 대기열·열린 줄·저장한 것을 버리고, 늦게 끝난 보내기가 되살리지 않는다 — 지켜보기는 이어진다', async () => {
    let release!: (outcome: TeamEventsOutcome) => void;
    const calls: TeamEventDraft[][] = [];
    const { store, timers, history, storage } = harness({
      send: (_teamId, events) => {
        calls.push(events);
        return calls.length === 1
          ? new Promise<TeamEventsOutcome>(resolve => {
              release = resolve;
            })
          : Promise.resolve('not-open');
      },
    });
    await settle();

    store.set({ sessions: [terminal('t1', 'acme-app', 'connected')] });
    void timers.fire();
    await settle();
    expect(calls).toHaveLength(1);
    store.set({ sessions: [terminal('t1', 'acme-app', 'closed')] });

    await history.purge();
    release('sent');
    await settle();

    expect(storage.data.has(OUTBOX_KEY)).toBe(false);
    expect(storage.data.has(OPEN_LINES_KEY)).toBe(false);
    expect(timers.delays()).toEqual([]);

    // 다음 계정의 접속도 남긴다.
    store.set({ sessions: [terminal('t9', 'acme-app', 'connected')] });
    await settle();
    expect(storedOutbox(storage)['team-acme']).toHaveLength(1);
  });
});
