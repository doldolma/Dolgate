import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { RnRussh } from "@fressh/react-native-uniffi-russh";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import type {
  AwsEc2HostRecord,
  AuthSession,
  AuthState,
  GroupRecord,
  LoadedManagedSecretPayload,
  MobileSessionRecord,
  ManagedAwsProfilePayload,
  SshHostRecord,
  SyncPayloadV2,
  SyncRecord,
} from "@dolssh/shared-core";
import { fromByteArray, toByteArray } from "base64-js";
import { Buffer } from "buffer";
import {
  buildEmptySyncPayload,
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import {
  getCurrentWindowTerminalGridSize,
  toRusshTerminalSize,
} from "../src/lib/terminal-size";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

jest.mock("@fressh/react-native-uniffi-russh", () => ({
  RnRussh: {
    uniffiInitAsync: jest.fn(async () => undefined),
    connect: jest.fn(),
    validatePrivateKey: jest.fn(() => ({ valid: true })),
  },
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));

const keychainMock = jest.requireMock("react-native-keychain") as {
  getGenericPassword: jest.Mock;
  setGenericPassword: jest.Mock;
  resetGenericPassword: jest.Mock;
};

function createAuthSession(
  overrides?: Partial<AuthSession>,
): AuthSession {
  return {
    user: {
      id: "user-1",
      email: "mobile@example.com",
    },
    tokens: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 900,
    },
    vaultBootstrap: {
      keyBase64: "a2V5",
    },
    offlineLease: {
      token: "offline-token",
      issuedAt: "2026-04-13T00:00:00.000Z",
      expiresAt: "2026-04-14T00:00:00.000Z",
      verificationPublicKeyPem: "public-key",
    },
    syncServerTime: "2026-04-13T00:00:00.000Z",
    ...overrides,
  };
}

function createAuthenticatedState(
  session: AuthSession = createAuthSession(),
): AuthState {
  return {
    status: "authenticated",
    session,
    offline: null,
    errorMessage: null,
  };
}

function createJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

function resetStore(
  overrides?: Partial<
    Pick<
      ReturnType<typeof useMobileAppStore.getState>,
      | "auth"
      | "authGateResolved"
      | "settings"
      | "secureStateReady"
      | "syncStatus"
      | "groups"
      | "hosts"
      | "awsProfiles"
      | "knownHosts"
      | "secretMetadata"
      | "sessions"
      | "secretsByRef"
      | "pendingBrowserLoginState"
      | "pendingServerKeyPrompt"
      | "pendingCredentialPrompt"
    >
  >,
): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: createUnauthenticatedState(),
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    groups: [],
    hosts: [],
    awsProfiles: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    secretsByRef: {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
    ...overrides,
  });
}

function mockStoredCredentials(input?: {
  session?: AuthSession | null;
  secretsByRef?: Record<string, LoadedManagedSecretPayload> | null;
  awsProfiles?: ManagedAwsProfilePayload[] | null;
}): void {
  const values = new Map<string, string>();

  if (input?.session) {
    values.set(
      "dolgate.mobile.auth-session",
      JSON.stringify(input.session),
    );
  }
  if (input?.secretsByRef) {
    values.set(
      "dolgate.mobile.managed-secrets",
      JSON.stringify(input.secretsByRef),
    );
  }
  if (input?.awsProfiles) {
    values.set(
      "dolgate.mobile.managed-aws-profiles",
      JSON.stringify(input.awsProfiles),
    );
  }

  keychainMock.getGenericPassword.mockImplementation(
    async ({ service }: { service: string }) => {
      const password = values.get(service);
      if (!password) {
        return null;
      }
      return {
        username: "dolgate",
        password,
      };
    },
  );
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createEncryptedRecord<T>(
  id: string,
  value: T,
  keyBase64: string,
  updatedAt = "2026-04-13T00:00:00.000Z",
): SyncRecord {
  const key = toByteArray(keyBase64);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
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
    updated_at: updatedAt,
  };
}

describe("useMobileAppStore auth and sync flows", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
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
    await act(async () => {
      resetStore();
    });
  });

  it("restores unauthenticated state when opening the browser login fails", async () => {
    const openUrlSpy = jest
      .spyOn(Linking, "openURL")
      .mockRejectedValue(new Error("브라우저를 열 수 없습니다."));

    await act(async () => {
      await useMobileAppStore.getState().startBrowserLogin();
    });

    expect(openUrlSpy).toHaveBeenCalledTimes(1);
    expect(useMobileAppStore.getState().auth.status).toBe("unauthenticated");
    expect(useMobileAppStore.getState().pendingBrowserLoginState).toBeNull();
    expect(useMobileAppStore.getState().auth.errorMessage).toContain(
      "브라우저를 열 수 없습니다.",
    );
  });

  it("cancels a pending browser login and clears the pending state", async () => {
    await act(async () => {
      resetStore({
        auth: {
          status: "authenticating",
          session: null,
          offline: null,
          errorMessage: null,
        },
        pendingBrowserLoginState: "expected-state",
      });
    });

    act(() => {
      useMobileAppStore.getState().cancelBrowserLogin();
    });

    expect(useMobileAppStore.getState().auth.status).toBe("unauthenticated");
    expect(useMobileAppStore.getState().pendingBrowserLoginState).toBeNull();
    expect(useMobileAppStore.getState().auth.errorMessage).toBeNull();
  });

  it("ignores a late auth callback after browser login was cancelled", async () => {
    await act(async () => {
      resetStore();
    });

    await act(async () => {
      await useMobileAppStore
        .getState()
        .handleAuthCallbackUrl(
          "dolgate://auth/callback?code=exchange-code&state=late-state",
        );
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().auth.status).toBe("unauthenticated");
    expect(useMobileAppStore.getState().auth.errorMessage).toBeNull();
  });

  it("rejects auth callbacks whose state does not match the pending login request", async () => {
    await act(async () => {
      resetStore({
        auth: {
          status: "authenticating",
          session: null,
          offline: null,
          errorMessage: null,
        },
        pendingBrowserLoginState: "expected-state",
      });
    });

    await act(async () => {
      await useMobileAppStore
        .getState()
        .handleAuthCallbackUrl(
          "dolgate://auth/callback?code=exchange-code&state=wrong-state",
        );
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().auth.status).toBe("unauthenticated");
    expect(useMobileAppStore.getState().auth.errorMessage).toContain(
      "일치하지 않습니다",
    );
  });

  it("exchanges a verified login callback and syncs hosts successfully", async () => {
    const session = createAuthSession();
    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/info") {
        return createJsonResponse({
          serverVersion: "test",
          capabilities: {
            sync: {
              awsProfiles: true,
            },
            sessions: {
              awsSsm: true,
            },
          },
        });
      }
      if (path === "/auth/exchange") {
        return createJsonResponse(session);
      }
      if (path === "/sync") {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: {
          status: "authenticating",
          session: null,
          offline: null,
          errorMessage: null,
        },
        pendingBrowserLoginState: "expected-state",
      });
    });

    await act(async () => {
      await useMobileAppStore
        .getState()
        .handleAuthCallbackUrl(
          "dolgate://auth/callback?code=exchange-code&state=expected-state",
        );
    });

    const state = useMobileAppStore.getState();
    expect(state.auth.status).toBe("authenticated");
    expect(state.auth.session?.tokens.accessToken).toBe("access-token");
    expect(state.pendingBrowserLoginState).toBeNull();
    expect(state.syncStatus.status).toBe("ready");
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(["/auth/exchange", "/api/info", "/sync"]);
  });

  it("refreshes an expired access token and retries sync once", async () => {
    const staleSession = createAuthSession();
    const refreshedSession = createAuthSession({
      tokens: {
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
        expiresInSeconds: 900,
      },
    });
    let syncAttemptCount = 0;

    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/info") {
        return createJsonResponse({
          serverVersion: "test",
          capabilities: {
            sync: {
              awsProfiles: true,
            },
            sessions: {
              awsSsm: true,
            },
          },
        });
      }
      if (path === "/sync") {
        syncAttemptCount += 1;
        if (syncAttemptCount === 1) {
          return createJsonResponse({ error: "expired" }, 401);
        }
        return createJsonResponse(buildEmptySyncPayload());
      }
      if (path === "/auth/refresh") {
        return createJsonResponse(refreshedSession);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(staleSession),
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().syncNow();
    });

    const state = useMobileAppStore.getState();
    expect(state.auth.status).toBe("authenticated");
    expect(state.auth.session?.tokens.accessToken).toBe("fresh-access-token");
    expect(state.syncStatus.status).toBe("ready");
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(["/api/info", "/sync", "/auth/refresh", "/sync"]);
  });

  it("resolves startup auth gating without waiting for sync to finish", async () => {
    const storedSession = createAuthSession({
      offlineLease: {
        token: "offline-token",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: "public-key",
      },
    });
    const refreshedSession = createAuthSession({
      offlineLease: storedSession.offlineLease,
      tokens: {
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
        expiresInSeconds: 900,
      },
    });

    mockStoredCredentials({
      session: storedSession,
      secretsByRef: {
        "secret-1": {
          secretRef: "secret-1",
          label: "Stored SSH secret",
          password: "super-secret",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      },
      awsProfiles: [
        {
          id: "profile-prod",
          name: "prod",
          kind: "static",
          region: "ap-northeast-2",
          accessKeyId: "AKIAPROD",
          secretAccessKey: "prod-secret",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      ],
    });
    let resolveSyncSnapshot: ((response: Response) => void) | null = null;

    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/refresh") {
        return createJsonResponse(refreshedSession);
      }
      if (path === "/api/info") {
        return createJsonResponse({
          serverVersion: "test",
          capabilities: {
            sync: {
              awsProfiles: true,
            },
            sessions: {
              awsSsm: true,
            },
          },
        });
      }
      if (path === "/sync") {
        return await new Promise<Response>((resolve) => {
          resolveSyncSnapshot = resolve;
        });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        authGateResolved: false,
        secureStateReady: false,
      });
      await useMobileAppStore.getState().initializeApp();
      await flushAsyncWork();
    });

    const state = useMobileAppStore.getState();
    expect(state.auth.status).toBe("authenticated");
    expect(state.auth.session?.tokens.accessToken).toBe("fresh-access-token");
    expect(state.authGateResolved).toBe(true);
    expect(state.secureStateReady).toBe(true);
    expect(state.syncStatus.status).toBe("syncing");
    expect(state.awsProfiles[0]?.name).toBe("prod");
    expect(state.secretsByRef["secret-1"]?.password).toBe("super-secret");
    expect(RnRussh.uniffiInitAsync).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(["/auth/refresh", "/api/info", "/sync"]);

    await act(async () => {
      resolveSyncSnapshot?.(createJsonResponse(buildEmptySyncPayload()));
      await flushAsyncWork();
    });
  });

  it("falls back to offline mode when startup refresh times out and the offline lease is still valid", async () => {
    jest.useFakeTimers();
    const storedSession = createAuthSession({
      offlineLease: {
        token: "offline-token",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: "public-key",
      },
    });

    mockStoredCredentials({
      session: storedSession,
    });

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path !== "/auth/refresh") {
        throw new Error(`unexpected fetch path: ${path}`);
      }

      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const error = Object.assign(new Error("aborted"), {
            name: "AbortError",
          });
          reject(error);
        });
      });
    });

    try {
      await act(async () => {
        resetStore({
          authGateResolved: false,
          secureStateReady: false,
        });
        const initializePromise = useMobileAppStore.getState().initializeApp();
        await jest.advanceTimersByTimeAsync(3_000);
        await initializePromise;
      });

      const state = useMobileAppStore.getState();
      expect(state.auth.status).toBe("offline-authenticated");
      expect(state.auth.session?.tokens.accessToken).toBe("access-token");
      expect(state.authGateResolved).toBe(true);
      expect(state.secureStateReady).toBe(true);
      expect(state.syncStatus.status).toBe("paused");
      expect(state.syncStatus.errorMessage).toContain("지연");
    } finally {
      jest.useRealTimers();
    }
  });

  it("recovers back to authenticated mode after a startup timeout fallback when refresh later succeeds", async () => {
    jest.useFakeTimers();
    const storedSession = createAuthSession({
      offlineLease: {
        token: "offline-token",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: "public-key",
      },
    });
    const refreshedSession = createAuthSession({
      offlineLease: storedSession.offlineLease,
      tokens: {
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
        expiresInSeconds: 900,
      },
    });
    let refreshAttempt = 0;

    mockStoredCredentials({
      session: storedSession,
    });

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/refresh") {
        refreshAttempt += 1;
        if (refreshAttempt === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            signal?.addEventListener("abort", () => {
              const error = Object.assign(new Error("aborted"), {
                name: "AbortError",
              });
              reject(error);
            });
          });
        }

        return createJsonResponse(refreshedSession);
      }
      if (path === "/api/info") {
        return createJsonResponse({
          serverVersion: "test",
          capabilities: {
            sync: {
              awsProfiles: true,
            },
            sessions: {
              awsSsm: true,
            },
          },
        });
      }
      if (path === "/sync") {
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    try {
      await act(async () => {
        resetStore({
          authGateResolved: false,
          secureStateReady: false,
        });
        const initializePromise = useMobileAppStore.getState().initializeApp();
        await jest.advanceTimersByTimeAsync(3_000);
        await initializePromise;
        await flushAsyncWork();
        await flushAsyncWork();
      });

      const state = useMobileAppStore.getState();
      expect(state.auth.status).toBe("authenticated");
      expect(state.auth.session?.tokens.accessToken).toBe("fresh-access-token");
      expect(state.auth.offline).toBeNull();
      expect(state.syncStatus.status).toBe("ready");
      expect(state.syncStatus.errorMessage).toBeNull();
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname))
        .toEqual(["/auth/refresh", "/auth/refresh", "/api/info", "/sync"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("clears protected cached data when startup refresh reports the session as invalid", async () => {
    const storedSession = createAuthSession({
      offlineLease: {
        token: "offline-token",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: "public-key",
      },
    });
    const cachedHost: SshHostRecord = {
      id: "cached-host",
      kind: "ssh",
      label: "Cached SSH",
      hostname: "cached.example.com",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: "secret-1",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    mockStoredCredentials({
      session: storedSession,
      secretsByRef: {
        "secret-1": {
          secretRef: "secret-1",
          label: "Stored SSH secret",
          password: "super-secret",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      },
      awsProfiles: [
        {
          id: "profile-prod",
          name: "prod",
          kind: "static",
          region: "ap-northeast-2",
          accessKeyId: "AKIAPROD",
          secretAccessKey: "prod-secret",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/refresh") {
        return createJsonResponse({ error: "expired" }, 401);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        authGateResolved: false,
        secureStateReady: false,
        groups: [
          {
            id: "group-1",
            path: "Servers",
            name: "Servers",
            createdAt: "2026-04-13T00:00:00.000Z",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
        hosts: [cachedHost],
        sessions: [
          {
            id: "session-1",
            sessionId: "session-1",
            hostId: cachedHost.id,
            title: cachedHost.label,
            status: "closed",
            hasReceivedOutput: true,
            isRestorable: true,
            lastViewportSnapshot: "prompt",
            lastEventAt: "2026-04-13T00:00:00.000Z",
            lastConnectedAt: "2026-04-13T00:00:00.000Z",
            lastDisconnectedAt: "2026-04-13T00:00:00.000Z",
            errorMessage: null,
          },
        ],
      });
      await useMobileAppStore.getState().initializeApp();
      await flushAsyncWork();
    });

    const state = useMobileAppStore.getState();
    expect(state.auth.status).toBe("unauthenticated");
    expect(state.auth.errorMessage).toContain("expired");
    expect(state.authGateResolved).toBe(true);
    expect(state.hosts).toHaveLength(0);
    expect(state.groups).toHaveLength(0);
    expect(state.awsProfiles).toHaveLength(0);
    expect(state.secretsByRef).toEqual({});
    expect(state.sessions).toHaveLength(0);
    expect(keychainMock.resetGenericPassword).toHaveBeenCalled();
  });

  it("hydrates groups from sync payloads and keeps them sorted by path", async () => {
    const keyBase64 = Buffer.from(
      "12345678901234567890123456789012",
      "utf8",
    ).toString("base64");
    const session = createAuthSession({
      vaultBootstrap: {
        keyBase64,
      },
    });
    const groups: GroupRecord[] = [
      {
        id: "group-nas",
        path: "Servers/NAS",
        name: "NAS",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
      {
        id: "group-servers",
        path: "Servers",
        name: "Servers",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ];
    const host: SshHostRecord = {
      id: "host-nas",
      kind: "ssh",
      label: "NAS SSH",
      hostname: "nas.example.com",
      port: 22,
      username: "admin",
      authType: "password",
      secretRef: null,
      groupName: "Servers/NAS",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const payload: SyncPayloadV2 = {
      ...buildEmptySyncPayload(),
      groups: groups.map((group) =>
        createEncryptedRecord(group.id, group, keyBase64),
      ),
      hosts: [createEncryptedRecord(host.id, host, keyBase64)],
    };

    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/info") {
        return createJsonResponse({
          serverVersion: "test",
          capabilities: {
            sync: {
              awsProfiles: true,
            },
            sessions: {
              awsSsm: true,
            },
          },
        });
      }
      if (path === "/sync") {
        return createJsonResponse(payload);
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
    expect(state.groups.map((group) => group.path)).toEqual([
      "Servers",
      "Servers/NAS",
    ]);
    expect(state.hosts[0]?.groupName).toBe("Servers/NAS");
    expect(state.syncStatus.status).toBe("ready");
  });

  it("hydrates AWS profiles and aws-ec2 hosts from sync payloads", async () => {
    const keyBase64 = Buffer.from(
      "12345678901234567890123456789012",
      "utf8",
    ).toString("base64");
    const session = createAuthSession({
      vaultBootstrap: {
        keyBase64,
      },
    });
    const awsHost: AwsEc2HostRecord = {
      id: "host-aws-1",
      kind: "aws-ec2",
      label: "Production EC2",
      awsProfileId: "profile-prod",
      awsProfileName: "prod",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-0123456789",
      awsInstanceName: "prod-web-1",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const awsProfile: ManagedAwsProfilePayload = {
      id: "profile-prod",
      name: "prod",
      kind: "static",
      region: "ap-northeast-2",
      accessKeyId: "AKIAPROD",
      secretAccessKey: "prod-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const payload: SyncPayloadV2 = {
      ...buildEmptySyncPayload(),
      hosts: [createEncryptedRecord(awsHost.id, awsHost, keyBase64)],
      awsProfiles: [
        createEncryptedRecord(awsProfile.id, awsProfile, keyBase64),
      ],
    };

    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/info") {
        return createJsonResponse({
          serverVersion: "test",
          capabilities: {
            sync: {
              awsProfiles: true,
            },
            sessions: {
              awsSsm: true,
            },
          },
        });
      }
      if (path === "/sync") {
        return createJsonResponse(payload);
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
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]?.kind).toBe("aws-ec2");
    expect(state.awsProfiles).toHaveLength(1);
    expect(state.awsProfiles[0]?.name).toBe("prod");
    expect(state.syncStatus.awsProfilesServerSupport).toBe("supported");
    expect(state.syncStatus.awsSsmServerSupport).toBe("supported");
  });

  it("reconnects an existing live host tab instead of only focusing stale state", async () => {
    const host: SshHostRecord = {
      id: "host-synology",
      kind: "ssh",
      label: "Synology",
      hostname: "doldolma.com",
      port: 2788,
      username: "doyoung",
      authType: "password",
      secretRef: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const session: MobileSessionRecord = {
      id: "session-synology",
      sessionId: "session-synology",
      hostId: host.id,
      title: host.label,
      status: "connected",
      hasReceivedOutput: true,
      isRestorable: true,
      lastViewportSnapshot: "prompt",
      lastEventAt: "2026-04-13T00:00:00.000Z",
      lastConnectedAt: "2026-04-13T00:00:00.000Z",
      lastDisconnectedAt: null,
      errorMessage: null,
    };
    const resumeSession = jest.fn(async () => session.id);
    const originalResumeSession = useMobileAppStore.getState().resumeSession;

    try {
      await act(async () => {
        resetStore({
          hosts: [host],
          sessions: [session],
        });
        useMobileAppStore.setState({
          resumeSession,
        });
      });

      let connectedSessionId: string | null = null;
      await act(async () => {
        connectedSessionId = await useMobileAppStore
          .getState()
          .connectToHost(host.id);
      });

      expect(connectedSessionId).toBe(session.id);
      expect(resumeSession).toHaveBeenCalledWith(session.id);
      expect(useMobileAppStore.getState().activeSessionTabId).toBe(session.id);
    } finally {
      useMobileAppStore.setState({
        resumeSession: originalResumeSession,
      });
    }
  });

  it("blocks AWS host connections when the server reports SSM support is unavailable", async () => {
    const awsHost: AwsEc2HostRecord = {
      id: "host-aws-1",
      kind: "aws-ec2",
      label: "Production EC2",
      awsProfileId: "profile-prod",
      awsProfileName: "prod",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-0123456789",
      awsInstanceName: "prod-web-1",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const awsProfile: ManagedAwsProfilePayload = {
      id: "profile-prod",
      name: "prod",
      kind: "static",
      region: "ap-northeast-2",
      accessKeyId: "AKIAPROD",
      secretAccessKey: "prod-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [awsHost],
        awsProfiles: [awsProfile],
        syncStatus: {
          ...createDefaultSyncStatus(),
          awsProfilesServerSupport: "supported",
          awsSsmServerSupport: "unsupported",
        },
      });
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(awsHost.id);
      await flushAsyncWork();
    });

    expect(sessionId).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const session = useMobileAppStore
      .getState()
      .sessions.find((item) => item.id === sessionId);
    expect(session?.connectionKind).toBe("aws-ssm");
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toContain("지원하지 않습니다");
  });

  it("disconnects live runtime sessions and clears synced state when the server changes", async () => {
    const host: SshHostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Dev SSH",
      hostname: "host.example.com",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: "secret-1",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-1",
      label: "Dev SSH credentials",
      password: "super-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const disconnect = jest.fn(async () => undefined);
    const shell = {
      addListener: jest.fn(() => 1n),
      removeListener: jest.fn(),
      sendData: jest.fn(async () => undefined),
      readBuffer: jest.fn(() => ({ chunks: [], nextSeq: 0 })),
    };
    const connection = {
      startShell: jest.fn(async () => shell),
      disconnect,
    };

    (RnRussh.connect as jest.Mock).mockResolvedValue(connection);

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        secretsByRef: {
          [secret.secretRef]: secret,
        },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(RnRussh.uniffiInitAsync).toHaveBeenCalledTimes(1);
    expect(RnRussh.connect).toHaveBeenCalledTimes(1);
    expect(connection.startShell).toHaveBeenCalledTimes(1);
    expect(connection.startShell).toHaveBeenCalledWith(
      expect.objectContaining({
        term: "Xterm",
        terminalSize: toRusshTerminalSize(getCurrentWindowTerminalGridSize()),
      }),
    );

    await act(async () => {
      await useMobileAppStore
        .getState()
        .updateSettings({ serverUrl: "https://next.example.com" });
    });

    const state = useMobileAppStore.getState();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(state.auth.status).toBe("unauthenticated");
    expect(state.hosts).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.secretsByRef).toEqual({});
    expect(state.pendingBrowserLoginState).toBeNull();
  });

  it("does not open a duplicate SSH connection while a session is already connecting", async () => {
    const host: SshHostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Dev SSH",
      hostname: "host.example.com",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: "secret-1",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-1",
      label: "Dev SSH credentials",
      password: "super-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const shell = {
      addListener: jest.fn(() => 1n),
      removeListener: jest.fn(),
      sendData: jest.fn(async () => undefined),
      readBuffer: jest.fn(() => ({ chunks: [], nextSeq: 0 })),
    };
    const connection = {
      startShell: jest.fn(async () => shell),
      disconnect: jest.fn(async () => undefined),
    };

    let resolveConnect: ((value: typeof connection) => void) | null = null;
    (RnRussh.connect as jest.Mock).mockImplementation(
      async () =>
        await new Promise<typeof connection>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        secretsByRef: {
          [secret.secretRef]: secret,
        },
      });
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
    });

    await act(async () => {
      const resumedSessionId = await useMobileAppStore
        .getState()
        .resumeSession(sessionId as string);
      expect(resumedSessionId).toBe(sessionId);
      await flushAsyncWork();
    });

    expect(RnRussh.connect).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConnect?.(connection);
      await flushAsyncWork();
    });

    expect(connection.startShell).toHaveBeenCalledTimes(1);
    expect(connection.startShell).toHaveBeenCalledWith(
      expect.objectContaining({
        term: "Xterm",
        terminalSize: toRusshTerminalSize(getCurrentWindowTerminalGridSize()),
      }),
    );
    expect(useMobileAppStore.getState().sessions[0]?.status).toBe("connected");
  });
});
