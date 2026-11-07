import { Platform } from 'react-native';
import {
  createVaultKdfDescriptor,
  type AuthSession,
  type LoadedManagedSecretPayload,
} from '@dolssh/shared-core';
import { APP_VERSION } from '../src/lib/app-metadata';
import {
  buildBrowserLoginUrl,
  changeRemoteAccountPassword,
  decodeAwsProfiles,
  deriveSecretMetadata,
  fetchExchangeSession,
  fetchSyncSnapshot,
  getOrCreateClientInstallationId,
  refreshAuthSession,
  resetClientInstallationIdCacheForTests,
  saveStoredAuthSession,
  putVaultRewrap,
  watchSyncChanges,
  ApiError,
} from '../src/lib/mobile';

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

const keychainMock = jest.requireMock('react-native-keychain') as {
  getGenericPassword: jest.Mock;
  setGenericPassword: jest.Mock;
  resetGenericPassword: jest.Mock;
};

const platformOsDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');

function setPlatformOs(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    get: () => os,
  });
}

function createAuthSession(): AuthSession {
  return {
    user: {
      id: 'user-1',
      email: 'mobile@example.com',
    },
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 900,
    },
    vaultBootstrap: {
      keyBase64: 'a2V5',
    },
    offlineLease: {
      token: 'offline-token',
      issuedAt: '2026-04-26T00:00:00.000Z',
      expiresAt: '2026-04-27T00:00:00.000Z',
      verificationPublicKeyPem: 'public-key',
    },
    syncServerTime: '2026-04-26T00:00:00.000Z',
  };
}

function createFetchResponse<T>(payload: T) {
  return {
    ok: true,
    json: jest.fn(async () => payload),
    text: jest.fn(async () => JSON.stringify(payload)),
  } as unknown as Response;
}

describe('mobile auth client headers', () => {
  let storedInstallationId: string | null;

  beforeEach(() => {
    storedInstallationId = null;
    // 설치 ID 는 프로세스 수명 동안 메모이즈되므로 테스트 간에는 캐시를 비운다.
    resetClientInstallationIdCacheForTests();
    setPlatformOs('ios');
    keychainMock.getGenericPassword.mockReset();
    keychainMock.setGenericPassword.mockReset();
    keychainMock.resetGenericPassword.mockReset();
    keychainMock.getGenericPassword.mockImplementation(
      async ({ service }: { service: string }) => {
        if (
          service === 'dolgate.mobile.client-installation-id' &&
          storedInstallationId
        ) {
          return {
            username: 'dolgate',
            password: storedInstallationId,
          };
        }
        return null;
      },
    );
    keychainMock.setGenericPassword.mockImplementation(
      async (
        _username: string,
        password: string,
        input: { service: string },
      ) => {
        if (input.service === 'dolgate.mobile.client-installation-id') {
          storedInstallationId = password;
        }
        return true;
      },
    );
    keychainMock.resetGenericPassword.mockResolvedValue(true);
  });

  afterAll(() => {
    if (platformOsDescriptor) {
      Object.defineProperty(Platform, 'OS', platformOsDescriptor);
    }
  });

  it('creates and reuses the installation id across auth requests', async () => {
    const session = createAuthSession();
    const fetchMock = jest.fn().mockResolvedValue(createFetchResponse(session));
    globalThis.fetch = fetchMock as typeof fetch;

    await fetchExchangeSession('https://ssh.doldolma.com', 'exchange-code');
    await refreshAuthSession('https://ssh.doldolma.com', session);

    const exchangeHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const refreshHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    const installationId = exchangeHeaders['X-Dolgate-Client-Installation-Id'];

    expect(exchangeHeaders['X-Dolgate-Client']).toBe('mobile');
    expect(exchangeHeaders['X-Dolgate-Client-Version']).toBe(APP_VERSION);
    expect(exchangeHeaders['X-Dolgate-Platform']).toBe('ios');
    expect(installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(refreshHeaders['X-Dolgate-Client-Installation-Id']).toBe(
      installationId,
    );
    expect(keychainMock.setGenericPassword).toHaveBeenCalledTimes(1);
  });

  it('returns a previously stored installation id without regenerating it', async () => {
    storedInstallationId = 'existing-installation-id';

    await expect(getOrCreateClientInstallationId()).resolves.toBe(
      'existing-installation-id',
    );
    expect(keychainMock.setGenericPassword).not.toHaveBeenCalled();
  });

  it('rejects when Keychain reports that the auth session was not saved', async () => {
    keychainMock.setGenericPassword.mockResolvedValueOnce(false);

    await expect(saveStoredAuthSession(createAuthSession())).rejects.toThrow(
      '인증 세션을 보안 저장소에 저장하지 못했습니다.',
    );
  });
});

describe('buildBrowserLoginUrl', () => {
  afterEach(() => {
    if (platformOsDescriptor) {
      Object.defineProperty(Platform, 'OS', platformOsDescriptor);
    }
  });

  // 서버는 platform=ios 일 때만(OIDC_HIDE_ON_IOS 서버에서) OIDC 버튼을 숨기므로,
  // 로그인 URL 이 플랫폼을 정확히 실어 보내야 한다.
  it.each(['ios', 'android'] as const)(
    'includes platform=%s in the browser login url',
    (os) => {
      setPlatformOs(os);
      const url = new URL(
        buildBrowserLoginUrl('https://ssh.doldolma.com', 'state-token'),
      );
      expect(url.pathname).toBe('/login');
      expect(url.searchParams.get('client')).toBe('dolgate-mobile');
      expect(url.searchParams.get('state')).toBe('state-token');
      expect(url.searchParams.get('platform')).toBe(os);
      // 로그인 페이지가 앱과 같은 언어로 뜨게 하는 값(서버는 없으면 브라우저 언어를 따른다).
      expect(url.searchParams.get('lang')).toBe('ko');
    },
  );
});

describe('mobile account password mutation', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('times out when the password change request never settles', async () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    const request = changeRemoteAccountPassword(
      'https://ssh.doldolma.com',
      'access-token',
      'refresh-token',
      'old-password',
      'new-password',
    );
    const rejection = expect(request).rejects.toThrow(
      '비밀번호 변경 요청 시간이 초과되었습니다.',
    );

    await jest.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});

describe('mobile vault mutations', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('times out even when the native fetch promise never settles', async () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const request = putVaultRewrap(
      'https://ssh.doldolma.com',
      'access-token',
      {
        wrappedDekBase64: 'wrapped-dek',
        dekVerifierBase64: 'verifier',
        kdf: createVaultKdfDescriptor(),
        expectedEpoch: 1,
      },
    );
    const rejection = expect(request).rejects.toThrow(
      '동기화 암호 요청 시간이 초과되었습니다.',
    );

    await jest.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});

// 페이로드→메타데이터 투영이 kind/계정을 빠뜨리면 RDP 자격증명이 SSH 취급으로 강등된다.
// 데스크톱 sync-service 의 같은 투영에서 실제로 났던 사고라, 모바일 쪽도 같이 잠근다.
describe('deriveSecretMetadata', () => {
  it('keeps kind and account fields of an RDP credential', () => {
    const metadata = deriveSecretMetadata([], {
      'secret:rdp-cred': {
        secretRef: 'secret:rdp-cred',
        label: 'Work PC admin',
        kind: 'rdp',
        username: ' admin ',
        domain: 'WORKGROUP',
        password: 'hunter2',
        updatedAt: '2026-08-11T00:00:00.000Z',
      } as LoadedManagedSecretPayload,
    });

    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      kind: 'rdp',
      username: 'admin',
      domain: 'WORKGROUP',
      hasPassword: true,
    });
  });

  it('leaves a legacy credential without kind as null', () => {
    const metadata = deriveSecretMetadata([], {
      'secret:ssh-cred': {
        secretRef: 'secret:ssh-cred',
        label: 'old key',
        privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----',
        updatedAt: '2026-08-11T00:00:00.000Z',
      } as LoadedManagedSecretPayload,
    });

    expect(metadata[0]).toMatchObject({
      kind: null,
      username: null,
      domain: null,
      hasManagedPrivateKey: true,
    });
  });
});

describe('sync snapshot payload shape', () => {
  // 서버는 레코드가 0개인 kind 를 키째로 뺀다. 그걸 그대로 디코드에 넘기면
  // `undefined.filter` 가 던지고, 그 예외는 복호화 실패와 구분되지 않아 사용자에게는
  // "데이터가 손상됐다"로 보인다 — 그룹·AWS 프로필을 안 쓰는 계정이 그렇게 깨졌다.
  it('fills in the kinds the server omits when they have no records', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '"7"' },
      json: async () => ({
        hosts: [
          {
            id: 'host-1',
            encrypted_payload: 'ciphertext',
            updated_at: '2026-08-18T00:00:00.000Z',
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const snapshot = await fetchSyncSnapshot(
      'https://ssh.doldolma.com',
      'access-token',
    );

    if (snapshot.notModified) {
      throw new Error('expected a full snapshot');
    }
    expect(snapshot.payload.hosts).toHaveLength(1);
    expect(snapshot.payload.groups).toEqual([]);
    expect(snapshot.payload.knownHosts).toEqual([]);
    expect(snapshot.payload.secrets).toEqual([]);
    expect(snapshot.payload.awsProfiles).toEqual([]);
    // 디코드가 던지지 않는 것까지 확인한다 — 사용자가 실제로 만난 지점이다.
    expect(decodeAwsProfiles(snapshot.payload, 'a2V5')).toEqual([]);
  });

  it('keeps kinds this build does not know about', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '"7"' },
      json: async () => ({ hosts: [], somethingNewer: [{ id: 'x' }] }),
    })) as unknown as typeof fetch;

    const snapshot = await fetchSyncSnapshot(
      'https://ssh.doldolma.com',
      'access-token',
    );

    if (snapshot.notModified) {
      throw new Error('expected a full snapshot');
    }
    expect(
      (snapshot.payload as unknown as Record<string, unknown[]>).somethingNewer,
    ).toHaveLength(1);
  });
});

describe('fetchSyncSnapshot request', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubSnapshotResponse(etag: string) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null),
        },
        json: async () => ({ hosts: [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  // 안드로이드 기본 HTTP 캐시(OkHttp)가 v1.9.4 전 서버에서 저장한 응답에 제 ETag 를 붙여 304 를 받고,
  // 그 옛 본문을 200 인 척 넘기지 못하게 한다.
  it('keeps the platform HTTP cache from answering with a stored response', async () => {
    const calls = stubSnapshotResponse('"7"');

    await fetchSyncSnapshot('https://ssh.doldolma.com', 'access-token', '"6"');

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers['If-None-Match']).toBe('"6"');
  });

  // 압축 프록시(nginx gzip·Cloudflare)는 ETag 를 W/"7" 로 약하게 바꾼다. 리비전은 같다.
  it('reads a proxy-weakened ETag in the form the server sent', async () => {
    stubSnapshotResponse('W/"7"');

    const snapshot = await fetchSyncSnapshot(
      'https://ssh.doldolma.com',
      'access-token',
    );

    expect(snapshot.etag).toBe('"7"');
  });
});

// 다른 기기의 변경을 기다리는 요청(GET /sync/watch). 서버는 바뀌면 그 순간 200, 아니면 대기가
// 끝나 304 로 답한다.
describe('watchSyncChanges', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubWatchResponse(response: {
    status: number;
    etag?: string;
    body?: unknown;
  }) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'etag' ? (response.etag ?? null) : null,
        },
        json: async () => response.body ?? {},
        text: async () => JSON.stringify(response.body ?? {}),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it('waits with the last applied revision and reports no change on 304', async () => {
    const calls = stubWatchResponse({ status: 304 });

    const result = await watchSyncChanges(
      'https://ssh.doldolma.com',
      'access-token',
      '"5"',
      new AbortController().signal,
    );

    expect(result).toEqual({ changed: false, etag: '"5"' });
    expect(calls[0].url).toBe('https://ssh.doldolma.com/sync/watch');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"5"');
    expect(headers.authorization).toBe('Bearer access-token');
  });

  it('reports the new revision when it changed', async () => {
    stubWatchResponse({ status: 200, etag: '"6"', body: { revision: 6 } });

    await expect(
      watchSyncChanges(
        'https://ssh.doldolma.com',
        'access-token',
        '"5"',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ changed: true, etag: '"6"' });
  });

  // 그대로 두면 이미 적용한 리비전("6")과 달라 보여 자기 push 를 다시 당긴다.
  it('reads a proxy-weakened ETag in the form the server sent', async () => {
    stubWatchResponse({ status: 200, etag: 'W/"6"', body: { revision: 6 } });

    await expect(
      watchSyncChanges(
        'https://ssh.doldolma.com',
        'access-token',
        '"5"',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ changed: true, etag: '"6"' });
  });

  it('throws an ApiError with the status on failure', async () => {
    stubWatchResponse({ status: 401, body: { error: 'unauthorized' } });

    const failure = await watchSyncChanges(
      'https://ssh.doldolma.com',
      'access-token',
      '"5"',
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);
  });

  // 앱이 백그라운드로 가면 대기 루프가 멈추며 신호를 abort 한다 — 요청도 같이 끊겨야 한다.
  it('aborts the request when the caller stops waiting', async () => {
    const calls = stubWatchResponse({ status: 304 });
    const controller = new AbortController();

    await watchSyncChanges(
      'https://ssh.doldolma.com',
      'access-token',
      null,
      controller.signal,
    );
    const requestSignal = calls[0].init?.signal as AbortSignal;
    expect(requestSignal.aborted).toBe(false);
    expect(
      (calls[0].init?.headers as Record<string, string>)['If-None-Match'],
    ).toBeUndefined();

    const pending = stubWatchResponse({ status: 304 });
    const stopped = new AbortController();
    stopped.abort();
    await watchSyncChanges(
      'https://ssh.doldolma.com',
      'access-token',
      '"5"',
      stopped.signal,
    );
    expect((pending[0].init?.signal as AbortSignal).aborted).toBe(true);
  });
});
