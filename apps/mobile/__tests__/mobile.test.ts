import { Platform } from 'react-native';
import type { AuthSession } from '@dolssh/shared-core';
import { APP_VERSION } from '../src/lib/app-metadata';
import {
  fetchExchangeSession,
  getOrCreateClientInstallationId,
  refreshAuthSession,
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
});
