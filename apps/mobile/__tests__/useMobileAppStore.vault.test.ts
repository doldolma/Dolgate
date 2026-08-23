import { AppState } from 'react-native';
import { act } from 'react-test-renderer';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import type {
  AuthSession,
  AuthState,
  SshHostRecord,
  SyncRecord,
} from '@dolssh/shared-core';
import {
  computeVaultDekVerifier,
  createVaultKdfDescriptor,
  unwrapVaultDek,
  wrapVaultDek,
} from '@dolssh/shared-core';
import { fromByteArray, toByteArray } from 'base64-js';
import { Buffer } from 'buffer';
import {
  buildEmptySyncPayload,
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from '../src/lib/mobile';
import {
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from '../src/store/useMobileAppStore';

// 결정적 가짜 Argon2 — 같은 (암호, salt)에는 같은 KEK, 다른 암호에는 다른 KEK.
// 실제 Argon2id 구현 일치는 Rust 테스트(vault_kdf.rs)와 공유 벡터가 검증한다.
function mockFakeArgon2(passphrase: Uint8Array, salt: Uint8Array): Uint8Array {
  const kek = new Uint8Array(32);
  for (let index = 0; index < kek.length; index += 1) {
    kek[index] =
      (passphrase[index % passphrase.length] ?? 7) ^
      (salt[index % salt.length] ?? 13) ^
      index;
  }
  return kek;
}

// 이 파일의 픽스처는 위 가짜 Argon2 로 DEK 을 감싼다. 스토어도 같은 가짜를 써야
// unwrap 이 성립하므로, 엔진 네이티브 모듈의 KDF 를 여기에 맞춰 덮어쓴다.
// (예전에는 삭제된 russh 모킹이 이 역할을 했다. 엔진 표면은 base64 문자열을
// 주고받으므로 경계에서 인코딩만 맞춰준다.)
import { NativeModules } from 'react-native';

(
  NativeModules.GoSshEngineModule as {
    deriveArgon2idKey: jest.Mock;
  }
).deriveArgon2idKey = jest.fn(
  async (passphraseBase64: string, saltBase64: string) =>
    fromByteArray(
      mockFakeArgon2(toByteArray(passphraseBase64), toByteArray(saltBase64)),
    ),
);

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

const VAULT_DEK_SERVICE = 'dolgate.mobile.vault-dek';
const VAULT_CACHE_V2_SERVICE = 'dolgate.mobile.vault-cache-v2';
const AUTH_SESSION_SERVICE = 'dolgate.mobile.auth-session';

function deriveFakeKekForPassphrase(
  passphrase: string,
  saltBase64: string,
): Uint8Array {
  return mockFakeArgon2(
    utf8ToBytes(passphrase.normalize('NFC')),
    toByteArray(saltBase64),
  );
}

function createV2AuthSession(
  wrappedDekBase64: string,
  kdf: ReturnType<typeof createVaultKdfDescriptor>,
  options?: {
    epoch?: number;
    wrapRevision?: number;
    dekVerifierBase64?: string;
    userId?: string;
  },
): AuthSession {
  return {
    user: {
      id: options?.userId ?? 'user-1',
      email: 'vault@example.com',
    },
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 900,
    },
    vaultBootstrap: {
      version: 2,
      wrappedDekBase64,
      ...(options?.epoch !== undefined ? { epoch: options.epoch } : {}),
      ...(options?.wrapRevision !== undefined
        ? { wrapRevision: options.wrapRevision }
        : {}),
      ...(options?.dekVerifierBase64
        ? { dekVerifierBase64: options.dekVerifierBase64 }
        : {}),
      kdf,
    },
    offlineLease: {
      token: 'offline-token',
      issuedAt: '2026-07-11T00:00:00.000Z',
      expiresAt: '2026-07-12T00:00:00.000Z',
      verificationPublicKeyPem: 'public-key',
    },
    syncServerTime: '2026-07-11T00:00:00.000Z',
  };
}

function createLegacyAuthSession(keyBase64: string): AuthSession {
  const session = createV2AuthSession('', createVaultKdfDescriptor());
  return {
    ...session,
    vaultBootstrap: { version: 1, keyBase64 },
  };
}

function createSetupRequiredAuthSession(): AuthSession {
  const session = createV2AuthSession('', createVaultKdfDescriptor());
  return {
    ...session,
    vaultBootstrap: { version: 0 },
  };
}

function createAuthenticatedState(session: AuthSession): AuthState {
  return {
    status: 'authenticated',
    session,
    offline: null,
    errorMessage: null,
  };
}

function createJsonResponse(
  body: unknown,
  status = 200,
  etag?: string,
): Response {
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

function createEncryptedRecord<T>(
  id: string,
  value: T,
  keyBase64: string,
): SyncRecord {
  const key = toByteArray(keyBase64);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const sealed = gcm(key, iv).encrypt(plaintext);
  const tag = sealed.slice(sealed.length - 16);
  const ciphertext = sealed.slice(0, sealed.length - 16);
  return {
    id,
    encrypted_payload: JSON.stringify({
      v: 1,
      iv: fromByteArray(iv),
      tag: fromByteArray(tag),
      ciphertext: fromByteArray(ciphertext),
    }),
    updated_at: '2026-07-11T00:00:00.000Z',
  };
}

function createHostRecord(): SshHostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'Vault host',
    hostname: 'example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

function mockVaultDekInKeychain(
  dekBase64: string | null,
  epoch?: number,
): void {
  keychainMock.getGenericPassword.mockImplementation(
    async ({ service }: { service: string }) => {
      if (service === VAULT_DEK_SERVICE && dekBase64) {
        return {
          username: epoch !== undefined ? `epoch:${epoch}` : 'dolgate',
          password: dekBase64,
        };
      }
      return null;
    },
  );
}

function mockVaultCacheInKeychain(input: {
  dekBase64: string;
  epoch: number;
  owner: { serverUrl: string; userId: string };
  wrappedDekBase64: string;
  kdf: ReturnType<typeof createVaultKdfDescriptor>;
  dekVerifierBase64: string;
}): void {
  keychainMock.getGenericPassword.mockImplementation(
    async ({ service }: { service: string }) => {
      if (service === VAULT_CACHE_V2_SERVICE) {
        return {
          username: 'vault-cache:2',
          password: JSON.stringify({ version: 2, ...input }),
        };
      }
      if (service === VAULT_DEK_SERVICE) {
        return {
          username: `epoch:${input.epoch}`,
          password: input.dekBase64,
        };
      }
      return null;
    },
  );
}

function serverInfoResponse() {
  return createJsonResponse({
    serverVersion: 'test',
    capabilities: {
      sync: { awsProfiles: true },
      sessions: { awsSsm: true },
      vault: { e2ee: true },
    },
  });
}

function offlineEditedHost(): SshHostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'Offline edit',
    hostname: 'offline.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    secretRef: null,
    groupName: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function resetStore(overrides?: {
  auth?: AuthState;
  vault?: ReturnType<typeof useMobileAppStore.getState>['vault'];
}): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: overrides?.auth ?? createUnauthenticatedState(),
    vault: overrides?.vault ?? { status: 'none' },
    vaultMigrationDeferred: false,
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    groups: [],
    hosts: [],
    awsProfiles: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    activeSessionTabId: null,
    activeConnectionTab: null,
    secretsByRef: {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
    pendingCredentialRetry: null,
    syncOutbox: [],
    syncOutboxFailure: null,
  });
}

describe('useMobileAppStore vault flows', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn<
    Promise<Response>,
    [RequestInfo | URL, RequestInit?]
  >();

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    resetMobileStoreRuntimeForTests();
    fetchMock.mockReset();
    jest.clearAllMocks();
    keychainMock.getGenericPassword.mockResolvedValue(null);
    keychainMock.setGenericPassword.mockResolvedValue(true);
    keychainMock.resetGenericPassword.mockResolvedValue(true);
    await act(async () => {
      resetStore();
    });
  });

  afterEach(async () => {
    resetMobileStoreRuntimeForTests();
    await act(async () => {
      resetStore();
    });
  });

  it('sets up a new vault, caches the DEK and starts syncing', async () => {
    const session = createSetupRequiredAuthSession();
    interface CapturedVaultBody {
      wrappedDekBase64?: string;
      kdf?: { algorithm?: string };
      expectedEpoch?: number;
    }
    const captured: { setupBody?: CapturedVaultBody } = {};

    const refreshKdf = createVaultKdfDescriptor();
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        captured.setupBody = JSON.parse(String(init.body)) as CapturedVaultBody;
        return createJsonResponse({ epoch: 1 });
      }
      if (path === '/auth/refresh') {
        // 설정 직후 세션 갱신 — descriptor 를 v2(새 epoch)로 맞춘다.
        return createJsonResponse(
          createV2AuthSession('cmVmcmVzaC13cmFwcGVk', refreshKdf, {
            epoch: 1,
          }),
        );
      }
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'setup-required', epoch: 0 },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().setupVault('correct horse battery');
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    expect(captured.setupBody?.wrappedDekBase64).toBeTruthy();
    expect(captured.setupBody?.kdf?.algorithm).toBe('argon2id');
    expect(captured.setupBody?.expectedEpoch).toBe(0);
    // 다른 기기들의 로컬 검증 근거 — 설정 요청에 verifier 가 반드시 실린다.
    expect(
      (captured.setupBody as { dekVerifierBase64?: string })?.dekVerifierBase64,
    ).toBeTruthy();
    // epoch 을 keychain username 에 실어 DEK 와 한 엔트리로 저장한다.
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      'epoch:1',
      expect.any(String),
      expect.objectContaining({ service: VAULT_DEK_SERVICE }),
    );
    const v2CacheCall = keychainMock.setGenericPassword.mock.calls.find(
      ([, , options]) => options?.service === VAULT_CACHE_V2_SERVICE,
    );
    expect(v2CacheCall?.[0]).toBe('vault-cache:2');
    expect(JSON.parse(v2CacheCall?.[1] as string)).toMatchObject({
      version: 2,
      owner: {
        serverUrl: createDefaultMobileSettings().serverUrl,
        userId: 'user-1',
      },
      epoch: 1,
      wrappedDekBase64: captured.setupBody?.wrappedDekBase64,
      dekVerifierBase64: (captured.setupBody as { dekVerifierBase64?: string })
        ?.dekVerifierBase64,
    });
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(['/auth/vault', '/auth/refresh', '/api/info', '/sync']);
  });

  it('does not apply an in-flight vault setup after the server changes', async () => {
    const session = createSetupRequiredAuthSession();
    let resolveVaultResponse!: (response: Response) => void;
    const vaultResponse = new Promise<Response>(resolve => {
      resolveVaultResponse = resolve;
    });
    let markVaultRequestStarted!: () => void;
    const vaultRequestStarted = new Promise<void>(resolve => {
      markVaultRequestStarted = resolve;
    });
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        markVaultRequestStarted();
        return vaultResponse;
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'setup-required', epoch: 0 },
      });
    });

    const setupPromise = useMobileAppStore
      .getState()
      .setupVault('correct horse battery');
    await vaultRequestStarted;
    await act(async () => {
      useMobileAppStore.setState(state => ({
        settings: {
          ...state.settings,
          serverUrl: 'https://other.example.com',
        },
      }));
    });
    resolveVaultResponse(createJsonResponse({ epoch: 1, wrapRevision: 0 }));

    await expect(setupPromise).rejects.toThrow(
      '로그인 계정 또는 서버가 변경되어 동기화 볼트 작업을 취소했습니다.',
    );
    expect(useMobileAppStore.getState().vault.status).toBe('setup-required');
    expect(keychainMock.setGenericPassword).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ service: VAULT_DEK_SERVICE }),
    );
  });

  it('does not swallow a server change during post-reset recovery upload', async () => {
    const session = createSetupRequiredAuthSession();
    let resolveSyncResponse!: (response: Response) => void;
    const syncResponse = new Promise<Response>(resolve => {
      resolveSyncResponse = resolve;
    });
    let markSyncRequestStarted!: () => void;
    const syncRequestStarted = new Promise<void>(resolve => {
      markSyncRequestStarted = resolve;
    });
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        return createJsonResponse({ epoch: 3, wrapRevision: 0 });
      }
      if (path === '/sync' && init?.method === 'POST') {
        markSyncRequestStarted();
        return syncResponse;
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'setup-required', epoch: 2 },
      });
      useMobileAppStore.setState({ hosts: [createHostRecord()] });
    });

    const setupPromise = useMobileAppStore
      .getState()
      .setupVault('correct horse battery');
    await syncRequestStarted;
    await act(async () => {
      useMobileAppStore.setState(state => ({
        settings: {
          ...state.settings,
          serverUrl: 'https://other.example.com',
        },
      }));
    });
    resolveSyncResponse(createJsonResponse({ revision: 4 }, 202));

    await expect(setupPromise).rejects.toThrow(
      '로그인 계정 또는 서버가 변경되어 동기화 볼트 작업을 취소했습니다.',
    );
    expect(useMobileAppStore.getState().syncStatus.status).not.toBe('error');
  });

  it('switches to the unlock flow when another device already set the vault up', async () => {
    const kdf = createVaultKdfDescriptor();
    const otherDeviceWrapped = wrapVaultDek(
      randomBytes(32),
      deriveFakeKekForPassphrase('other-device-passphrase', kdf.saltBase64),
    );
    const refreshedSession = createV2AuthSession(otherDeviceWrapped, kdf);

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        return createJsonResponse({ error: '이미 설정되었습니다.' }, 409);
      }
      if (path === '/auth/refresh') {
        return createJsonResponse(refreshedSession);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(createSetupRequiredAuthSession()),
        vault: { status: 'setup-required', epoch: 0 },
      });
    });

    await expect(
      useMobileAppStore.getState().setupVault('my-new-passphrase'),
    ).rejects.toThrow();

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('locked');
    if (state.vault.status === 'locked') {
      expect(state.vault.wrappedDekBase64).toBe(otherDeviceWrapped);
    }
  });

  it('does not cache the revision while locked, so unlock still downloads data (C1)', async () => {
    // 회귀(C1): 잠긴 상태의 fetch(200)에서 lastSyncRevision 을 저장하면, 잠금해제 후
    // 폴링이 304 를 받아 디코드를 건너뛰고 워크스페이스가 빈 채로 남는다.
    const passphrase = 'pass';
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase(passphrase, kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });

    const ifNoneMatchSeen: (string | null)[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        const ifNoneMatch =
          (init?.headers as Record<string, string> | undefined)?.[
            'If-None-Match'
          ] ?? null;
        ifNoneMatchSeen.push(ifNoneMatch);
        // 서버는 항상 etag "5" 의 데이터를 준다. C1 버그가 있으면 잠긴 상태에서 "5" 를
        // 저장해 두 번째 요청이 If-None-Match "5" 를 보내고 서버가 304 를 준다(빈 상태).
        if (ifNoneMatch === '"5"') {
          return createJsonResponse(null, 304, '"5"');
        }
        return createJsonResponse(
          {
            ...buildEmptySyncPayload(),
            hosts: [
              createEncryptedRecord(
                'host-1',
                createHostRecord(),
                fromByteArray(dek),
              ),
            ],
          },
          200,
          '"5"',
        );
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    // 캐시된 DEK 없음 → 첫 동기화는 잠긴 상태로 끝난다(데이터는 서버에 있음).
    mockVaultDekInKeychain(null);
    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    expect(useMobileAppStore.getState().vault.status).toBe('locked');
    expect(useMobileAppStore.getState().hosts).toHaveLength(0);

    // 올바른 암호로 잠금해제 → 두 번째 요청은 If-None-Match 를 보내면 안 되고(잠긴 fetch
    // 가 revision 을 저장하지 않았으므로) 200 으로 데이터를 받아 디코드한다.
    await act(async () => {
      await useMobileAppStore.getState().unlockVault(passphrase);
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    expect(state.hosts).toHaveLength(1);
    // 두 요청 모두 If-None-Match 없이(null) 나가야 한다 — 잠긴 fetch 가 "5" 를 저장하지 않음.
    expect(ifNoneMatchSeen).toEqual([null, null]);
  });

  it('unlocks with the correct passphrase and rejects a wrong one', async () => {
    const passphrase = '동기화-암호-123';
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase(passphrase, kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'locked',
          wrappedDekBase64,
          kdf,
          epoch: 2,
          wrapRevision: 0,
          dekVerifierBase64: computeVaultDekVerifier(dek),
        },
      });
    });

    await expect(
      useMobileAppStore.getState().unlockVault('wrong-passphrase'),
    ).rejects.toThrow('동기화 암호가 올바르지 않습니다.');
    expect(useMobileAppStore.getState().vault.status).toBe('locked');

    await act(async () => {
      await useMobileAppStore.getState().unlockVault(passphrase);
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    if (state.vault.status === 'unlocked') {
      expect(state.vault.dekBase64).toBe(fromByteArray(dek));
      expect(state.vault.epoch).toBe(2);
    }
    // DEK 와 epoch 이 한 엔트리로 원자적으로 저장된다.
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      'epoch:2',
      fromByteArray(dek),
      expect.objectContaining({ service: VAULT_DEK_SERVICE }),
    );
  });

  it('rejects a successfully unwrapped DEK when its verifier does not match', async () => {
    const passphrase = 'correct-passphrase';
    const kdf = createVaultKdfDescriptor();
    const wrappedDek = randomBytes(32);
    const differentDek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      wrappedDek,
      deriveFakeKekForPassphrase(passphrase, kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 4,
      dekVerifierBase64: computeVaultDekVerifier(differentDek),
    });

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/refresh') {
        return createJsonResponse(session);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'locked',
          wrappedDekBase64,
          kdf,
          epoch: 4,
          wrapRevision: 0,
          dekVerifierBase64: computeVaultDekVerifier(differentDek),
        },
      });
    });

    await expect(
      useMobileAppStore.getState().unlockVault(passphrase),
    ).rejects.toThrow('동기화 키 검증에 실패했습니다.');
    expect(useMobileAppStore.getState().vault.status).toBe('locked');
    expect(
      keychainMock.setGenericPassword.mock.calls.some(
        ([, , options]) =>
          options?.service === VAULT_CACHE_V2_SERVICE ||
          options?.service === VAULT_DEK_SERVICE,
      ),
    ).toBe(false);
  });

  it('keeps the unlocked memory state when Keychain persistence fails', async () => {
    const passphrase = 'correct-passphrase';
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase(passphrase, kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 2,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });
    keychainMock.setGenericPassword.mockResolvedValue(false);
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'locked',
          wrappedDekBase64,
          kdf,
          epoch: 2,
          wrapRevision: 0,
          dekVerifierBase64: computeVaultDekVerifier(dek),
        },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().unlockVault(passphrase);
    });

    expect(useMobileAppStore.getState().vault.status).toBe('unlocked');
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to persist the mobile vault cache.',
      expect.any(Error),
    );
  });

  it('sends If-None-Match and keeps local data on a 304 (unchanged) poll', async () => {
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('pass', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });

    mockVaultDekInKeychain(fromByteArray(dek));
    const ifNoneMatchSeen: (string | null)[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        const ifNoneMatch =
          (init?.headers as Record<string, string> | undefined)?.[
            'If-None-Match'
          ] ?? null;
        ifNoneMatchSeen.push(ifNoneMatch);
        if (ifNoneMatch === '"7"') {
          return createJsonResponse(null, 304, '"7"');
        }
        return createJsonResponse(
          {
            ...buildEmptySyncPayload(),
            hosts: [
              createEncryptedRecord(
                'host-1',
                createHostRecord(),
                fromByteArray(dek),
              ),
            ],
          },
          200,
          '"7"',
        );
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    expect(useMobileAppStore.getState().hosts).toHaveLength(1);

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });
    // 첫 요청은 If-None-Match 없이, 둘째는 첫 응답의 ETag 를 실어 보내 304 를 받는다.
    expect(ifNoneMatchSeen).toEqual([null, '"7"']);
    // 304 이므로 로컬 데이터는 그대로 유지된다.
    expect(useMobileAppStore.getState().hosts).toHaveLength(1);
    expect(useMobileAppStore.getState().vault.status).toBe('unlocked');
  });

  it('clears the previous server ETag before syncing a newly selected server', async () => {
    const keyBase64 = Buffer.alloc(32, 9).toString('base64');
    const session = createLegacyAuthSession(keyBase64);
    const ifNoneMatchSeen: (string | null)[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        ifNoneMatchSeen.push(
          (init?.headers as Record<string, string> | undefined)?.[
            'If-None-Match'
          ] ?? null,
        );
        return createJsonResponse(buildEmptySyncPayload(), 200, '"7"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      await useMobileAppStore.getState().syncNow();
      await useMobileAppStore
        .getState()
        .updateSettings({ serverUrl: 'https://next.example.com' });
      useMobileAppStore.setState({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      await useMobileAppStore.getState().syncNow();
    });

    expect(ifNoneMatchSeen).toEqual([null, null]);
  });

  it('discards a previous server sync that completes after the server changes', async () => {
    const keyBase64 = Buffer.alloc(32, 5).toString('base64');
    const session = createLegacyAuthSession(keyBase64);
    let resolveOldSync: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return await new Promise<Response>(resolve => {
          resolveOldSync = resolve;
        });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      useMobileAppStore.setState({ vaultMigrationDeferred: true });
    });
    const pendingSync = useMobileAppStore.getState().syncNow();
    for (let attempt = 0; attempt < 10 && !resolveOldSync; attempt += 1) {
      await Promise.resolve();
    }
    expect(resolveOldSync).not.toBeNull();

    await act(async () => {
      await useMobileAppStore
        .getState()
        .updateSettings({ serverUrl: 'https://next.example.com' });
    });
    resolveOldSync!(createJsonResponse(buildEmptySyncPayload(), 200, '"9"'));
    await act(async () => {
      await pendingSync;
    });

    const state = useMobileAppStore.getState();
    expect(state.settings.serverUrl).toBe('https://next.example.com');
    expect(state.auth.status).toBe('unauthenticated');
    expect(state.hosts).toHaveLength(0);
    expect(state.vaultMigrationDeferred).toBe(false);
  });

  it('does not rewrite a coherent vault cache when the descriptor is unchanged', async () => {
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const dekBase64 = fromByteArray(dek);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('pass', kdf.saltBase64),
    );
    const dekVerifierBase64 = computeVaultDekVerifier(dek);
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 4,
      dekVerifierBase64,
    });

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'unlocked',
          dekBase64,
          wrappedDekBase64,
          kdf,
          epoch: 4,
          wrapRevision: 0,
          owner: {
            serverUrl: createDefaultMobileSettings().serverUrl,
            userId: 'user-1',
          },
        },
      });
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    expect(useMobileAppStore.getState().vault.status).toBe('unlocked');
    const vaultCacheWrites = keychainMock.setGenericPassword.mock.calls.filter(
      ([, , options]) =>
        options?.service === VAULT_DEK_SERVICE ||
        options?.service === VAULT_CACHE_V2_SERVICE,
    );
    expect(vaultCacheWrites).toEqual([]);
  });

  it('gates sync into the locked state when no DEK is cached', async () => {
    const kdf = createVaultKdfDescriptor();
    const wrappedDekBase64 = wrapVaultDek(
      randomBytes(32),
      deriveFakeKekForPassphrase('some-passphrase', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf);
    const dek = randomBytes(32);

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse({
          ...buildEmptySyncPayload(),
          hosts: [
            createEncryptedRecord(
              'host-1',
              createHostRecord(),
              fromByteArray(dek),
            ),
          ],
        });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('locked');
    expect(state.hosts).toEqual([]);
    expect(state.syncStatus.status).toBe('ready');
  });

  it('falls back to the locked state when Keychain cannot be read', async () => {
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('some-passphrase', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 1,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });
    keychainMock.getGenericPassword.mockRejectedValue(
      new Error('Keychain temporarily unavailable'),
    );
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      return path === '/api/info'
        ? serverInfoResponse()
        : createJsonResponse(buildEmptySyncPayload());
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });

    expect(useMobileAppStore.getState().vault.status).toBe('locked');
  });

  it('decodes sync data with a cached DEK and recovers to locked when the DEK is stale', async () => {
    const kdf = createVaultKdfDescriptor();
    const cachedDek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      cachedDek,
      deriveFakeKekForPassphrase('pass', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      dekVerifierBase64: computeVaultDekVerifier(cachedDek),
    });

    mockVaultDekInKeychain(fromByteArray(cachedDek));
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse({
          ...buildEmptySyncPayload(),
          hosts: [
            createEncryptedRecord(
              'host-1',
              createHostRecord(),
              fromByteArray(cachedDek),
            ),
          ],
        });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
      });
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    let state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]?.label).toBe('Vault host');

    // 다른 기기에서 볼트 초기화 후 재설정 — 레코드가 새 DEK 로 암호화되어 내려온다.
    // 복호화 실패 → 세션 갱신으로 재판정 → 새 verifier 불일치 → 캐시 폐기 + 잠금.
    const rotatedDek = randomBytes(32);
    const rotatedKdf = createVaultKdfDescriptor();
    const rotatedWrapped = wrapVaultDek(
      rotatedDek,
      deriveFakeKekForPassphrase('new-pass', rotatedKdf.saltBase64),
    );
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/auth/refresh') {
        return createJsonResponse(
          createV2AuthSession(rotatedWrapped, rotatedKdf, {
            epoch: 3,
            dekVerifierBase64: computeVaultDekVerifier(rotatedDek),
          }),
        );
      }
      if (path === '/sync') {
        return createJsonResponse({
          ...buildEmptySyncPayload(),
          hosts: [
            createEncryptedRecord(
              'host-1',
              createHostRecord(),
              fromByteArray(rotatedDek),
            ),
          ],
        });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('locked');
    if (state.vault.status === 'locked') {
      // 재판정된 잠금 화면은 갱신된 descriptor(새 wrapped/epoch)를 기준으로 한다 —
      // 사용자가 입력할 새 동기화 암호가 실제로 통하는 화면이다.
      expect(state.vault.wrappedDekBase64).toBe(rotatedWrapped);
      expect(state.vault.epoch).toBe(3);
    }
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledWith({
      service: VAULT_DEK_SERVICE,
    });
  });

  it('stays unlocked when the local state is fresh but the session descriptor epoch lags (own re-setup)', async () => {
    // 회귀: 이 기기에서 방금 설정을 마쳐 로컬은 새 세대(epoch 5)인데 currentSession
    // descriptor 는 아직 옛 세대(epoch 3)다(초기화 후 재설정 직후). epoch 규칙(낮으면
    // 무시)이 방금 만든 DEK 를 보호한다 — 재잠금하면 무한 재입력에 빠진다.
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const staleDek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('pass', kdf.saltBase64),
    );
    const staleSession = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 3,
      dekVerifierBase64: computeVaultDekVerifier(staleDek),
    });

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse({
          ...buildEmptySyncPayload(),
          hosts: [
            createEncryptedRecord(
              'host-1',
              createHostRecord(),
              fromByteArray(dek),
            ),
          ],
        });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(staleSession),
        // 로컬은 새 세대로 잠금해제된 신뢰 상태.
        vault: {
          status: 'unlocked',
          dekBase64: fromByteArray(dek),
          wrappedDekBase64,
          kdf,
          epoch: 5,
          wrapRevision: 0,
          owner: {
            serverUrl: createDefaultMobileSettings().serverUrl,
            userId: 'user-1',
          },
        },
      });
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    if (state.vault.status === 'unlocked') {
      expect(state.vault.epoch).toBe(5);
    }
    expect(state.hosts).toHaveLength(1);
    // 방금 만든 DEK 를 절대 지우면 안 된다.
    expect(keychainMock.resetGenericPassword).not.toHaveBeenCalled();
  });

  it('keeps the latest wrapper when the session has an older wrap revision', async () => {
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const currentWrapped = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('latest-pass', kdf.saltBase64),
    );
    const staleWrapped = wrapVaultDek(
      randomBytes(32),
      deriveFakeKekForPassphrase('stale-pass', kdf.saltBase64),
    );
    const staleSession = createV2AuthSession(staleWrapped, kdf, {
      epoch: 5,
      wrapRevision: 1,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(staleSession),
        vault: {
          status: 'unlocked',
          dekBase64: fromByteArray(dek),
          wrappedDekBase64: currentWrapped,
          kdf,
          epoch: 5,
          wrapRevision: 2,
          owner: {
            serverUrl: createDefaultMobileSettings().serverUrl,
            userId: 'user-1',
          },
        },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    const state = useMobileAppStore.getState().vault;
    expect(state.status).toBe('unlocked');
    if (state.status === 'unlocked') {
      expect(state.wrappedDekBase64).toBe(currentWrapped);
      expect(state.wrapRevision).toBe(2);
    }
    expect(keychainMock.resetGenericPassword).not.toHaveBeenCalled();
  });

  it('relocks before decoding when the descriptor verifier changed (reset on another device)', async () => {
    const kdf = createVaultKdfDescriptor();
    const cachedDek = randomBytes(32);
    const liveDek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      liveDek,
      deriveFakeKekForPassphrase('new-pass', kdf.saltBase64),
    );
    // 서버 descriptor 는 초기화 후 재설정된 볼트(새 DEK 의 verifier, epoch 3),
    // 캐시는 그 이전 세대(epoch 1)의 죽은 DEK 다.
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 3,
      dekVerifierBase64: computeVaultDekVerifier(liveDek),
    });

    mockVaultDekInKeychain(fromByteArray(cachedDek), 1);
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
      });
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    // 복호화 시도(GCM 실패) 이전에 verifier 불일치만으로 잠금으로 되돌리고 캐시를 지운다.
    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('locked');
    if (state.vault.status === 'locked') {
      expect(state.vault.epoch).toBe(3);
    }
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledWith({
      service: VAULT_DEK_SERVICE,
    });
  });

  it('resets the vault, keeps local data for recovery and returns to the setup flow', async () => {
    const kdf = createVaultKdfDescriptor();
    const wrappedDekBase64 = wrapVaultDek(
      randomBytes(32),
      deriveFakeKekForPassphrase('forgotten', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf);
    let resetExpectedEpoch: number | undefined;

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault/reset' && init?.method === 'POST') {
        resetExpectedEpoch = (
          JSON.parse(String(init.body)) as { expectedEpoch?: number }
        ).expectedEpoch;
        return createJsonResponse({ epoch: 2 });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'locked',
          wrappedDekBase64,
          kdf,
          epoch: 1,
          wrapRevision: 0,
        },
      });
      useMobileAppStore.setState({
        hosts: [createHostRecord()],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().resetVault();
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('setup-required');
    expect(resetExpectedEpoch).toBe(1);
    // 로컬 데이터는 지우지 않는다 — 재설정 직후 setupVault 가 새 DEK 로 재암호화해
    // 서버로 재업로드하는 자연 복구 경로(데스크톱과 동일 시맨틱).
    expect(state.hosts).toHaveLength(1);
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledWith({
      service: VAULT_DEK_SERVICE,
    });
    expect(state.auth.session?.vaultBootstrap).toEqual({
      version: 0,
      epoch: 2,
    });
    const storedResetSession = keychainMock.setGenericPassword.mock.calls.find(
      ([, , options]) => options?.service === AUTH_SESSION_SERVICE,
    );
    expect(storedResetSession).toBeDefined();
    expect(JSON.parse(String(storedResetSession?.[1])).vaultBootstrap).toEqual({
      version: 0,
      epoch: 2,
    });
  });

  it('keeps the committed reset state when local Keychain cleanup fails', async () => {
    const kdf = createVaultKdfDescriptor();
    const wrappedDekBase64 = wrapVaultDek(
      randomBytes(32),
      deriveFakeKekForPassphrase('forgotten', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, { epoch: 1 });
    fetchMock.mockResolvedValue(createJsonResponse({ epoch: 2 }));
    keychainMock.resetGenericPassword.mockRejectedValue(
      new Error('Keychain unavailable'),
    );
    keychainMock.setGenericPassword.mockRejectedValue(
      new Error('Keychain unavailable'),
    );

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'locked',
          wrappedDekBase64,
          kdf,
          epoch: 1,
          wrapRevision: 0,
        },
      });
      useMobileAppStore.setState({ hosts: [createHostRecord()] });
    });

    await expect(
      useMobileAppStore.getState().resetVault(),
    ).resolves.toBeUndefined();
    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('setup-required');
    expect(state.auth.session?.vaultBootstrap).toEqual({
      version: 0,
      epoch: 2,
    });
    expect(state.hosts).toHaveLength(1);
  });

  it('rejects a cached DEK owned by another account before comparing epochs', async () => {
    const kdf = createVaultKdfDescriptor();
    const cachedDek = randomBytes(32);
    const liveDek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      liveDek,
      deriveFakeKekForPassphrase('account-b-pass', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 2,
      dekVerifierBase64: computeVaultDekVerifier(liveDek),
      userId: 'user-b',
    });
    mockVaultCacheInKeychain({
      dekBase64: fromByteArray(cachedDek),
      epoch: 99,
      owner: {
        serverUrl: createDefaultMobileSettings().serverUrl,
        userId: 'user-a',
      },
      wrappedDekBase64,
      kdf,
      dekVerifierBase64: computeVaultDekVerifier(cachedDek),
    });
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      return path === '/api/info'
        ? serverInfoResponse()
        : createJsonResponse(buildEmptySyncPayload());
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });

    expect(useMobileAppStore.getState().vault.status).toBe('locked');
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledWith({
      service: VAULT_CACHE_V2_SERVICE,
    });
  });

  it('rejects a cached DEK owned by the same user on another server', async () => {
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('server-b-pass', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 3,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });
    mockVaultCacheInKeychain({
      dekBase64: fromByteArray(dek),
      epoch: 3,
      owner: { serverUrl: 'https://other.example.com', userId: 'user-1' },
      wrappedDekBase64,
      kdf,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      return path === '/api/info'
        ? serverInfoResponse()
        : createJsonResponse(buildEmptySyncPayload());
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });

    expect(useMobileAppStore.getState().vault.status).toBe('locked');
  });

  it('uses an explicit error state for an unsupported future vault descriptor', async () => {
    const session = {
      ...createSetupRequiredAuthSession(),
      vaultBootstrap: { version: 99 },
    } as unknown as AuthSession;
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      return path === '/api/info'
        ? serverInfoResponse()
        : createJsonResponse(buildEmptySyncPayload());
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('error');
    if (state.vault.status === 'error') {
      expect(state.vault.errorMessage).toContain('앱을 업데이트');
    }
    expect(state.hosts).toEqual([]);
  });

  it('re-uploads surviving local data on setup right after a reset', async () => {
    // 초기화 → 재설정의 자연 복구: setupVault 가 첫 pull 전에 로컬 데이터를 새 DEK 로
    // 재암호화해 push 한다(안 하면 빈 서버 스냅샷이 로컬을 통째로 비운다).
    const session = createSetupRequiredAuthSession();
    const pushedPayloads: Array<{ hosts?: SyncRecord[] }> = [];
    const refreshKdf = createVaultKdfDescriptor();

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        return createJsonResponse({ epoch: 3 });
      }
      if (path === '/sync' && init?.method === 'POST') {
        pushedPayloads.push(
          JSON.parse(String(init.body)) as { hosts?: SyncRecord[] },
        );
        return createJsonResponse({ revision: 9 }, 202);
      }
      if (path === '/auth/refresh') {
        return createJsonResponse(
          createV2AuthSession('cmVmcmVzaC13cmFwcGVk', refreshKdf, {
            epoch: 3,
          }),
        );
      }
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        // 실제 서버처럼 push 이후의 pull 은 방금 push 된 데이터를 돌려준다 —
        // 계속 빈 스냅샷을 주면 빈서버-재업로드 규칙이 반복 발동한다(정상 동작).
        return createJsonResponse({
          ...buildEmptySyncPayload(),
          hosts: pushedPayloads[pushedPayloads.length - 1]?.hosts ?? [],
        });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'setup-required', epoch: 0 },
      });
      // 초기화에서 살아남은 로컬 데이터.
      useMobileAppStore.setState({ hosts: [createHostRecord()] });
    });

    await act(async () => {
      await useMobileAppStore.getState().setupVault('fresh-passphrase');
    });

    // 복구 push 가 pull 이전에 나가고, 로컬 호스트가 담겨 있다.
    expect(pushedPayloads).toHaveLength(1);
    expect(pushedPayloads[0]?.hosts).toHaveLength(1);
    const pushIndex = fetchMock.mock.calls.findIndex(
      ([input, init]) =>
        new URL(String(input)).pathname === '/sync' && init?.method === 'POST',
    );
    const pullIndex = fetchMock.mock.calls.findIndex(
      ([input, init]) =>
        new URL(String(input)).pathname === '/sync' && !init?.method,
    );
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(pushIndex);
  });

  it('floors a stale post-setup refresh descriptor to the synthesized epoch', async () => {
    // 서버 epoch 은 단조 — 설정(epoch 3) 직후 도착한 낡은 v0 응답(epoch 1)을 그대로
    // 저장하면 저장 세션이 keychain 보다 낡아진다. floor 가 합성 descriptor 로 치환한다.
    const session = createSetupRequiredAuthSession();

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        return createJsonResponse({ epoch: 3 });
      }
      if (path === '/auth/refresh') {
        // reset/setup 경계에서 늦게 도착한 "볼트 없음" 응답(이전 세대 epoch 1).
        return createJsonResponse({
          ...session,
          vaultBootstrap: { version: 0, epoch: 1 },
        });
      }
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'setup-required', epoch: 0 },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().setupVault('fresh-passphrase');
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    if (state.vault.status === 'unlocked') {
      expect(state.vault.epoch).toBe(3);
    }
    // 게시된 세션 descriptor 가 낡은 epoch 1 이 아니라 floor 된 epoch 3 이어야 한다.
    expect(state.auth.session?.vaultBootstrap.epoch).toBe(3);
    expect(state.auth.session?.vaultBootstrap.version).toBe(2);
  });

  it('re-uploads local data instead of applying an empty server snapshot', async () => {
    // 서버가 진짜 비어 있으면(tombstone 0 = 초기화 직후/유실) 빈 스냅샷으로 로컬을
    // 비우는 대신 로컬을 재업로드한다 — 데스크톱과 같은 자연 복구 규칙. 재설정 직후
    // 복구 push 가 실패했어도 폴링이 이 경로로 스스로 치유한다.
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('pass', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 3,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });

    const pushedPayloads: Array<{ hosts?: unknown[] }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync' && init?.method === 'POST') {
        pushedPayloads.push(
          JSON.parse(String(init.body)) as { hosts?: unknown[] },
        );
        return createJsonResponse({ revision: 4 }, 202);
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload(), 200, '"3"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'unlocked',
          dekBase64: fromByteArray(dek),
          wrappedDekBase64,
          kdf,
          epoch: 3,
          wrapRevision: 0,
        },
      });
      useMobileAppStore.setState({ hosts: [createHostRecord()] });
    });

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    const state = useMobileAppStore.getState();
    // 로컬이 비워지지 않고 재업로드됐다.
    expect(state.hosts).toHaveLength(1);
    expect(pushedPayloads).toHaveLength(1);
    expect(pushedPayloads[0]?.hosts).toHaveLength(1);
    expect(state.syncStatus.status).toBe('ready');
  });

  it('reconciles a vault-reset 409 from empty-server recovery without wiping local data', async () => {
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('pass', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 1,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });
    const resetSession: AuthSession = {
      ...session,
      vaultBootstrap: { version: 0, epoch: 2 },
    };
    let recoveryPushes = 0;

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/auth/refresh') {
        return createJsonResponse(resetSession);
      }
      if (path === '/sync' && init?.method === 'POST') {
        recoveryPushes += 1;
        return createJsonResponse(
          {
            error: '동기화 볼트가 없습니다.',
            code: 'vault_reset',
          },
          409,
        );
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload(), 200, '"2"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'unlocked',
          dekBase64: fromByteArray(dek),
          wrappedDekBase64,
          kdf,
          epoch: 1,
          wrapRevision: 0,
        },
      });
      useMobileAppStore.setState({ hosts: [createHostRecord()] });
    });

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    const state = useMobileAppStore.getState();
    expect(recoveryPushes).toBe(1);
    expect(state.vault.status).toBe('setup-required');
    expect(state.auth.session?.vaultBootstrap).toEqual({
      version: 0,
      epoch: 2,
    });
    expect(state.hosts).toHaveLength(1);
    expect(state.syncStatus.pendingPush).toBe(true);
  });

  it('aborts setup recovery when the re-upload push fails (no wipe-by-pull)', async () => {
    // 복구 push 가 실패하면 pull 로 이어가지 않는다 — 빈 서버 스냅샷이 로컬(복구 원본)
    // 을 비워버리는 것을 막는다. 폴링의 빈서버-재업로드 규칙이 이후 재시도한다.
    const session = createSetupRequiredAuthSession();
    let pullAttempted = false;

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        return createJsonResponse({ epoch: 3 });
      }
      if (path === '/sync' && init?.method === 'POST') {
        return createJsonResponse({ error: '서버 오류' }, 500);
      }
      if (path === '/sync') {
        pullAttempted = true;
        return createJsonResponse(buildEmptySyncPayload());
      }
      if (path === '/auth/refresh' || path === '/api/info') {
        return createJsonResponse({ error: 'unexpected' }, 500);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'setup-required', epoch: 0 },
      });
      useMobileAppStore.setState({ hosts: [createHostRecord()] });
    });

    await act(async () => {
      await useMobileAppStore.getState().setupVault('fresh-passphrase');
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    // 로컬 데이터가 살아 있고, pull 은 시도되지 않았다.
    expect(state.hosts).toHaveLength(1);
    expect(pullAttempted).toBe(false);
    expect(state.syncStatus.status).toBe('error');
    expect(state.syncStatus.pendingPush).toBe(true);
  });

  it('changes the passphrase by rewrapping the same DEK', async () => {
    const currentPassphrase = 'current-passphrase';
    const kdf = createVaultKdfDescriptor();
    const dek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase(currentPassphrase, kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf);
    interface CapturedRewrapBody {
      wrappedDekBase64?: string;
      expectedEpoch?: number;
      expectedDekVerifierBase64?: string;
      expectedWrapRevision?: number;
    }
    const captured: { rewrapBody?: CapturedRewrapBody } = {};

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'PUT') {
        captured.rewrapBody = JSON.parse(
          String(init.body),
        ) as CapturedRewrapBody;
        return createJsonResponse('', 204);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'unlocked',
          dekBase64: fromByteArray(dek),
          wrappedDekBase64,
          kdf,
          epoch: 1,
          wrapRevision: 0,
        },
      });
    });

    await expect(
      useMobileAppStore
        .getState()
        .changeVaultPassphrase('wrong-current', 'next-passphrase'),
    ).rejects.toThrow('현재 동기화 암호가 올바르지 않습니다.');
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await useMobileAppStore
        .getState()
        .changeVaultPassphrase(currentPassphrase, 'next-passphrase');
    });

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    if (state.vault.status === 'unlocked') {
      // DEK 는 그대로, wrapped 만 교체된다. epoch 도 유지된다.
      expect(state.vault.dekBase64).toBe(fromByteArray(dek));
      expect(state.vault.wrappedDekBase64).not.toBe(wrappedDekBase64);
      expect(state.vault.wrappedDekBase64).toBe(
        captured.rewrapBody?.wrappedDekBase64,
      );
      expect(state.vault.epoch).toBe(1);
      expect(state.vault.wrapRevision).toBe(1);
    }
    // rewrap 은 verifier 를 함께 실어 verifier 이전 볼트에 지연 백필할 기회를 준다.
    expect(
      (captured.rewrapBody as { dekVerifierBase64?: string })
        ?.dekVerifierBase64,
    ).toBe(computeVaultDekVerifier(dek));
    expect(captured.rewrapBody?.expectedEpoch).toBe(1);
    expect(captured.rewrapBody?.expectedDekVerifierBase64).toBe('');
    expect(captured.rewrapBody?.expectedWrapRevision).toBe(0);
  });

  it('refuses to rewrap when the cached DEK and wrapped descriptor disagree', async () => {
    const passphrase = 'descriptor-passphrase';
    const kdf = createVaultKdfDescriptor();
    const cachedDek = randomBytes(32);
    const descriptorDek = randomBytes(32);
    const wrappedDekBase64 = wrapVaultDek(
      descriptorDek,
      deriveFakeKekForPassphrase(passphrase, kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      epoch: 2,
      dekVerifierBase64: computeVaultDekVerifier(cachedDek),
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: {
          status: 'unlocked',
          dekBase64: fromByteArray(cachedDek),
          wrappedDekBase64,
          kdf,
          epoch: 2,
          wrapRevision: 0,
        },
      });
    });

    await expect(
      useMobileAppStore
        .getState()
        .changeVaultPassphrase(passphrase, 'next-passphrase'),
    ).rejects.toThrow('로컬 볼트 캐시와 서버 키가 일치하지 않습니다.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pre-seeds the legacy vault key into the DEK cache during sync', async () => {
    const keyBase64 = fromByteArray(randomBytes(32));
    const session = createLegacyAuthSession(keyBase64);

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
    });
    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    expect(useMobileAppStore.getState().vault.status).toBe('legacy');
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      'epoch:0',
      keyBase64,
      expect.objectContaining({ service: VAULT_DEK_SERVICE }),
    );
    // 서버 vault 지원 플래그도 sync 에서 채워진다(전환 프롬프트 게이트 조건).
    expect(useMobileAppStore.getState().syncStatus.vaultE2eeServerSupport).toBe(
      'supported',
    );
  });

  it('migrates a legacy vault by wrapping the existing DEK', async () => {
    const keyBase64 = fromByteArray(randomBytes(32));
    const session = createLegacyAuthSession(keyBase64);
    const passphrase = 'migration-passphrase';
    let capturedWrapped = '';
    let capturedSalt = '';
    let capturedExpectedEpoch: number | undefined;
    let refreshCalled = false;

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          wrappedDekBase64: string;
          kdf: { saltBase64: string };
          expectedEpoch?: number;
        };
        capturedWrapped = body.wrappedDekBase64;
        capturedSalt = body.kdf.saltBase64;
        capturedExpectedEpoch = body.expectedEpoch;
        return createJsonResponse('', 204);
      }
      if (path === '/auth/refresh') {
        refreshCalled = true;
        return createJsonResponse(
          createV2AuthSession(capturedWrapped, {
            ...createVaultKdfDescriptor(),
            saltBase64: capturedSalt,
          }),
        );
      }
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().migrateVault(passphrase);
    });

    // 업로드된 wrapped 를 같은 암호로 풀면 기존 DEK 가 나와야 한다(로테이션 없음).
    const kek = deriveFakeKekForPassphrase(passphrase, capturedSalt);
    expect(fromByteArray(unwrapVaultDek(capturedWrapped, kek))).toBe(keyBase64);
    expect(capturedExpectedEpoch).toBe(0);

    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    if (state.vault.status === 'unlocked') {
      expect(state.vault.dekBase64).toBe(keyBase64);
    }
    expect(refreshCalled).toBe(true);
    // 구서버(204, epoch 없음)는 epoch 0 으로 저장된다.
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      'epoch:0',
      keyBase64,
      expect.objectContaining({ service: VAULT_DEK_SERVICE }),
    );
  });

  it('recovers into unlocked when another device migrated first (409 + pre-seeded DEK)', async () => {
    const keyBase64 = fromByteArray(randomBytes(32));
    const session = createLegacyAuthSession(keyBase64);
    const otherKdf = createVaultKdfDescriptor();
    const otherWrapped = wrapVaultDek(
      toByteArray(keyBase64),
      deriveFakeKekForPassphrase('other-device-pass', otherKdf.saltBase64),
    );

    // pre-seeding 된 DEK 캐시가 있다고 가정.
    mockVaultDekInKeychain(keyBase64);
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/vault' && init?.method === 'POST') {
        return createJsonResponse({ error: '이미 설정되었습니다.' }, 409);
      }
      if (path === '/auth/refresh') {
        return createJsonResponse(
          createV2AuthSession(otherWrapped, otherKdf, {
            dekVerifierBase64: computeVaultDekVerifier(toByteArray(keyBase64)),
          }),
        );
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
    });

    await expect(
      useMobileAppStore.getState().migrateVault('my-passphrase'),
    ).rejects.toThrow('다른 기기에서 이미');

    // pre-seeded DEK 로 곧바로 unlocked — 암호 재입력이 필요 없다.
    const state = useMobileAppStore.getState();
    expect(state.vault.status).toBe('unlocked');
    if (state.vault.status === 'unlocked') {
      expect(state.vault.dekBase64).toBe(keyBase64);
    }
  });

  it('defers the migration prompt for the current run', () => {
    expect(useMobileAppStore.getState().vaultMigrationDeferred).toBe(false);
    useMobileAppStore.getState().deferVaultMigration();
    expect(useMobileAppStore.getState().vaultMigrationDeferred).toBe(true);
  });

  it('does not defer a mandatory legacy migration', () => {
    useMobileAppStore.setState({
      vault: { status: 'legacy', epoch: 3, migrationRequired: true },
      vaultMigrationDeferred: false,
    });

    useMobileAppStore.getState().deferVaultMigration();

    expect(useMobileAppStore.getState().vaultMigrationDeferred).toBe(false);
  });

  // 이 두 갈래는 사용자에게 할 말이 다르다. 복호화 실패는 데이터 쪽, 그 외(응답 모양이 안 맞아
  // 던진 것)는 앱을 올리면 풀린다 — 한 문구로 뭉뚱그리면 진단이 엉뚱한 데로 간다.
  it('separates a real decrypt failure from an unreadable payload', async () => {
    const dek = new Uint8Array(32).fill(3);
    const otherDek = new Uint8Array(32).fill(4);
    const kdf = createVaultKdfDescriptor();
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('passphrase-1234', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });

    const respondWithHosts = (hosts: unknown[]) => {
      fetchMock.mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/info') {
          return serverInfoResponse();
        }
        if (path === '/auth/refresh') {
          return createJsonResponse(session);
        }
        return createJsonResponse(
          { ...buildEmptySyncPayload(), hosts },
          200,
          '"3"',
        );
      });
    };

    // 남의 DEK 로 봉인된 레코드 — 태그 검증이 실패한다(진짜 복호화 실패).
    mockVaultDekInKeychain(fromByteArray(dek));
    respondWithHosts([
      createEncryptedRecord(
        'host-1',
        createHostRecord(),
        fromByteArray(otherDek),
      ),
    ]);
    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });
    expect(useMobileAppStore.getState().syncStatus.errorMessage).toContain(
      '복호화할 수 없습니다',
    );

    // 레코드 자리에 엉뚱한 값 — 복호화까지 가지도 못한 구조 오류다.
    resetMobileStoreRuntimeForTests();
    respondWithHosts([null]);
    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });
    const message = useMobileAppStore.getState().syncStatus.errorMessage;
    expect(message).toContain('읽을 수 없습니다');
    expect(message).not.toContain('손상');
  });

  // 오류로 끝난 동기화도 폴링을 살려 둬야 한다. 안 그러면 서버가 고쳐져도 앱을 강제 종료했다
  // 켜기 전까지 그 화면에 갇힌다 — 타이머와 포그라운드 복귀 리스너가 여기서만 만들어진다.
  it('keeps polling alive after a decode failure so it can recover', async () => {
    const dek = new Uint8Array(32).fill(5);
    const otherDek = new Uint8Array(32).fill(6);
    const kdf = createVaultKdfDescriptor();
    const wrappedDekBase64 = wrapVaultDek(
      dek,
      deriveFakeKekForPassphrase('passphrase-1234', kdf.saltBase64),
    );
    const session = createV2AuthSession(wrappedDekBase64, kdf, {
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });
    mockVaultDekInKeychain(fromByteArray(dek));
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/auth/refresh') {
        return createJsonResponse(session);
      }
      return createJsonResponse(
        {
          ...buildEmptySyncPayload(),
          hosts: [
            createEncryptedRecord(
              'host-1',
              createHostRecord(),
              fromByteArray(otherDek),
            ),
          ],
        },
        200,
        '"3"',
      );
    });

    const appStateSpy = jest.spyOn(AppState, 'addEventListener');
    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });

    expect(useMobileAppStore.getState().syncStatus.status).toBe('error');
    expect(appStateSpy).toHaveBeenCalledWith('change', expect.any(Function));
    appStateSpy.mockRestore();
  });
  it('pushes the outbox before pulling so an offline edit is not overwritten', async () => {
    // 앱을 켜 둔 채 네트워크가 돌아오면 30초 폴링이 pull 만 했다 — 큐는 영영 안 밀리고,
    // 화면은 "동기화 최신" 이라고 말하면서 대기 건수만 남았다. 더 나쁜 것은 순서다:
    // pull 이 먼저 로컬을 덮으면 큐에 남은 항목이 방금 덮인 서버 값을 되돌려 보낸다.
    const keyBase64 = Buffer.alloc(32, 3).toString('base64');
    const session = createLegacyAuthSession(keyBase64);
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        calls.push(init?.method === 'POST' ? 'push' : 'pull');
        if (init?.method === 'POST') {
          return createJsonResponse('', 202);
        }
        return createJsonResponse(buildEmptySyncPayload(), 200, '"9"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      useMobileAppStore.setState({
        hosts: [offlineEditedHost()],
        syncOutbox: [{ kind: 'hosts', id: 'host-1', op: 'upsert' }],
      });
      await useMobileAppStore.getState().syncNow();
    });

    // 미는 것이 먼저다. (뒤에 push 가 하나 더 붙는 것은 별개의 기존 동작 — 서버 스냅샷이
    // 통째로 비어 있으면 로컬을 지우는 대신 재업로드한다. 이 시험의 서버가 빈 응답이라 걸린다.)
    expect(calls.slice(0, 2)).toEqual(['push', 'pull']);
    // 밀고 나면 대기 표시가 사라져야 한다 — 이 줄이 안 사라지는 것이 사용자가 본 증상이다.
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
    expect(useMobileAppStore.getState().syncStatus.pendingPush).toBe(false);
  });

  it('keeps unpushed local changes on top of a pulled snapshot', async () => {
    // 밀지 못해도 **당기기를 막지 않는다** — 못 미는 이유가 볼트가 아직 확정되지 않아서일
    // 수 있고(그 확정을 pull 이 한다), 그때 pull 까지 멈추면 서로를 기다리다 동기화가 죽는다.
    // 대신 아직 못 올린 변경은 서버 값 위에 다시 얹어 지킨다.
    const keyBase64 = Buffer.alloc(32, 4).toString('base64');
    const session = createLegacyAuthSession(keyBase64);
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        calls.push(init?.method === 'POST' ? 'push' : 'pull');
        if (init?.method === 'POST') {
          throw new Error('network down');
        }
        return createJsonResponse(buildEmptySyncPayload(), 200, '"9"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      useMobileAppStore.setState({
        hosts: [offlineEditedHost()],
        syncOutbox: [{ kind: 'hosts', id: 'host-1', op: 'upsert' }],
      });
      await useMobileAppStore.getState().syncNow();
    });

    // 밀기가 실패해도 당기기는 돈다.
    expect(calls.slice(0, 2)).toEqual(['push', 'pull']);
    // 서버에 없는 로컬 변경이 살아남아야 한다. 지워지면 큐도 그 레코드를 못 찾아 버려진다.
    expect(useMobileAppStore.getState().hosts).toHaveLength(1);
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(1);
    // 이유는 남기되 화면에 떠벌리지 않는다 — 상태 한 줄이 말해 준다.
    expect(useMobileAppStore.getState().syncOutboxFailure?.message).toContain(
      'network down',
    );
  });
  it('keeps an unpushed secret from being wiped by a pulled snapshot', async () => {
    // pull 은 비밀 맵을 서버 것으로 통째로 덮는다. 아직 못 올린 비밀이 여기서 사라지면
    // 큐 항목은 보낼 것을 못 찾아 조용히 버려진다 — 호스트만 남고 비밀번호가 증발한다.
    const keyBase64 = Buffer.alloc(32, 6).toString('base64');
    const session = createLegacyAuthSession(keyBase64);
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        if (init?.method === 'POST') {
          throw new Error('network down');
        }
        return createJsonResponse(buildEmptySyncPayload(), 200, '"9"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      useMobileAppStore.setState({
        hosts: [{ ...offlineEditedHost(), secretRef: 'secret-1' }],
        secretsByRef: {
          'secret-1': {
            secretRef: 'secret-1',
            label: 'Offline edit',
            updatedAt: '2026-08-01T00:00:00.000Z',
            password: 'hunter2',
          },
        },
        syncOutbox: [
          { kind: 'hosts', id: 'host-1', op: 'upsert' },
          { kind: 'secrets', id: 'secret-1', op: 'upsert' },
        ],
      });
      await useMobileAppStore.getState().syncNow();
    });

    expect(
      useMobileAppStore.getState().secretsByRef['secret-1']?.password,
    ).toBe('hunter2');
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(2);
  });

  it('shows a sync error once retrying the push did not help', async () => {
    // 밀기가 계속 실패해도 당기기만 되면 화면이 "최신" 이라고 말하던 것을 막는다.
    const keyBase64 = Buffer.alloc(32, 7).toString('base64');
    const session = createLegacyAuthSession(keyBase64);
    let pushFails = true;
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        if (init?.method === 'POST') {
          if (pushFails) {
            throw new Error('push rejected');
          }
          return createJsonResponse('', 202);
        }
        return createJsonResponse(buildEmptySyncPayload(), 200, '"9"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      useMobileAppStore.setState({
        hosts: [offlineEditedHost()],
        syncOutbox: [{ kind: 'hosts', id: 'host-1', op: 'upsert' }],
      });
      // 밀기만 시킨다. syncNow 로 돌리면 당기기 쪽 실패까지 섞여 무엇이 상태를 바꿨는지
      // 가려진다(서버 스냅샷이 비면 로컬 재업로드가 따로 돌아 그것도 실패한다).
      await useMobileAppStore.getState().flushSyncOutbox();
    });
    // 한 번 실패로는 오류라고 하지 않는다.
    expect(useMobileAppStore.getState().syncStatus.status).not.toBe('error');

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });
    expect(useMobileAppStore.getState().syncStatus.status).toBe('error');
    expect(useMobileAppStore.getState().syncStatus.errorMessage).toContain(
      'push rejected',
    );

    // 올라가고 나면 오류 표시가 걷히고 마지막 동기화 시각이 움직인다.
    pushFails = false;
    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });
    expect(useMobileAppStore.getState().syncStatus.status).toBe('ready');
    expect(useMobileAppStore.getState().syncStatus.errorMessage).toBeNull();
    expect(
      useMobileAppStore.getState().syncStatus.lastSuccessfulSyncAt,
    ).toBeTruthy();
  });
  it('does not apply a pulled snapshot before the keychain secrets are restored', async () => {
    // 콜드스타트에서는 Keychain 복원과 동기화가 같이 시작된다. 복원 전에 적용하면 그 시점의
    // secretsByRef 가 비어 있어 병합이 "로컬에 없다" 고 보고, 서버 것으로 Keychain 까지
    // 덮어쓴다 — 오프라인에서 만든 비밀이 지워지고 큐 항목은 보낼 것을 못 찾아 버려진다.
    // 그래서 호스트만 올라가고 비밀번호는 사라졌다.
    const keyBase64 = Buffer.alloc(32, 8).toString('base64');
    const session = createLegacyAuthSession(keyBase64);
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') {
        return serverInfoResponse();
      }
      if (path === '/sync') {
        if (init?.method === 'POST') {
          throw new Error('offline');
        }
        return createJsonResponse(buildEmptySyncPayload(), 200, '"9"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        vault: { status: 'legacy', epoch: 0, migrationRequired: false },
      });
      useMobileAppStore.setState({
        secureStateReady: false,
        hosts: [{ ...offlineEditedHost(), secretRef: 'secret-1' }],
        secretsByRef: {
          'secret-1': {
            secretRef: 'secret-1',
            label: 'Offline edit',
            updatedAt: '2026-08-01T00:00:00.000Z',
            password: 'hunter2',
          },
        },
        syncOutbox: [
          { kind: 'hosts', id: 'host-1', op: 'upsert' },
          { kind: 'secrets', id: 'secret-1', op: 'upsert' },
        ],
      });
      await useMobileAppStore.getState().syncNow();
    });

    // 비밀도 큐도 그대로 살아 있어야 한다.
    expect(
      useMobileAppStore.getState().secretsByRef['secret-1']?.password,
    ).toBe('hunter2');
    expect(
      useMobileAppStore
        .getState()
        .syncOutbox.map(entry => entry.kind)
        .sort(),
    ).toEqual(['hosts', 'secrets']);
  });
});
