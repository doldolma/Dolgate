import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { RnRussh } from "@fressh/react-native-uniffi-russh";
import type {
  AuthSession,
  AuthState,
  LoadedManagedSecretPayload,
  SshHostRecord,
} from "@dolssh/shared-core";
import {
  buildEmptySyncPayload,
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
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
      | "settings"
      | "syncStatus"
      | "hosts"
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
    auth: createUnauthenticatedState(),
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    hosts: [],
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

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
      .toEqual(["/auth/exchange", "/sync"]);
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
      .toEqual(["/sync", "/auth/refresh", "/sync"]);
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

    expect(RnRussh.connect).toHaveBeenCalledTimes(1);
    expect(connection.startShell).toHaveBeenCalledTimes(1);

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
});
