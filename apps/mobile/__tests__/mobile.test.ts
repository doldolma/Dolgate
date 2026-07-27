import { Platform } from 'react-native';
import { createVaultKdfDescriptor, type AuthSession } from '@dolssh/shared-core';
import { APP_VERSION } from '../src/lib/app-metadata';
import {
  buildBrowserLoginUrl,
  changeRemoteAccountPassword,
  fetchExchangeSession,
  getOrCreateClientInstallationId,
  refreshAuthSession,
  resetClientInstallationIdCacheForTests,
  saveStoredAuthSession,
  putVaultRewrap,
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
