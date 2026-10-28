import {
  fetchTeamPrivate,
  fetchTeamRecords,
  fetchTeams,
  watchTeamChanges,
} from '../src/lib/team-api';

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
  getGenericPassword: jest.fn(async () => false),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));

const SERVER_URL = 'https://sync.example.com';

function json(body: unknown, status = 200, etag?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'etag' ? etag ?? null : null,
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = jest.fn<
  Promise<Response>,
  [RequestInfo | URL, RequestInit?]
>();

function lastRequest(): { path: string; headers: Record<string, string> } {
  const [input, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return {
    path: new URL(String(input)).pathname,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

describe('team-api', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('팀 목록을 토큰과 클라이언트 머리로 부르고 빠진 칸을 채운다', async () => {
    fetchMock.mockResolvedValue(
      json({
        teams: [
          {
            id: 'team-1',
            name: 'Acme',
            role: 'something-new',
            wrappedTeamDek: '',
          },
        ],
      }),
    );

    const teams = await fetchTeams(SERVER_URL, 'access-token');

    const request = lastRequest();
    expect(request.path).toBe('/teams');
    expect(request.headers.authorization).toBe('Bearer access-token');
    // 서버는 팀 데이터 수준을 이 머리(앱 이름·버전)로 가른다(426).
    expect(request.headers['X-Dolgate-Client']).toBe('mobile');
    expect(request.headers['X-Dolgate-Client-Version']).toEqual(
      expect.any(String),
    );
    // 모르는 역할은 가장 좁은 읽기 전용으로, 빈 사본은 없음으로 읽는다.
    expect(teams).toEqual([
      expect.objectContaining({
        id: 'team-1',
        role: 'viewer',
        wrappedTeamDek: null,
        dataFloor: 0,
      }),
    ]);
  });

  it('레코드·개인 칸은 조건부로 받고 304 면 지난번 그대로다', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ hosts: [], other: 'x' }, 200, '"3"'),
    );
    const first = await fetchTeamRecords(
      SERVER_URL,
      'access-token',
      'team/1',
      null,
    );
    expect(lastRequest().path).toBe('/teams/team%2F1/sync');
    expect(first).toEqual({
      notModified: false,
      payload: { hosts: [] },
      etag: '"3"',
    });

    fetchMock.mockResolvedValueOnce(json(null, 304, '"3"'));
    const second = await fetchTeamPrivate(
      SERVER_URL,
      'access-token',
      'team-1',
      '"3"',
    );
    expect(lastRequest()).toEqual({
      path: '/teams/team-1/me',
      headers: expect.objectContaining({ 'If-None-Match': '"3"' }),
    });
    expect(second).toEqual({ notModified: true, payload: null, etag: null });
  });

  it('실패는 상태와 code 를 실은 오류로 던진다', async () => {
    fetchMock.mockResolvedValue(
      json({ error: '팀을 찾을 수 없습니다.', code: 'team_not_found' }, 404),
    );

    await expect(
      fetchTeamRecords(SERVER_URL, 'access-token', 'team-1', null),
    ).rejects.toMatchObject({ status: 404, code: 'team_not_found' });
  });

  it('감시는 리비전 셋을 읽고, 바뀐 것이 없으면 304 다', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { revision: 4, infoRevision: 2, privateRevision: 7 },
        200,
        '"4.2.7"',
      ),
    );
    const changed = await watchTeamChanges(
      SERVER_URL,
      'access-token',
      'team-1',
      null,
      new AbortController().signal,
    );
    expect(lastRequest().path).toBe('/teams/team-1/sync/watch');
    expect(changed).toEqual({
      changed: true,
      etag: '"4.2.7"',
      revisions: { revision: 4, infoRevision: 2, privateRevision: 7 },
    });

    fetchMock.mockResolvedValueOnce(json(null, 304, '"4.2.7"'));
    const unchanged = await watchTeamChanges(
      SERVER_URL,
      'access-token',
      'team-1',
      '"4.2.7"',
      new AbortController().signal,
    );
    expect(lastRequest().headers['If-None-Match']).toBe('"4.2.7"');
    expect(unchanged).toEqual({ changed: false });
  });
});
