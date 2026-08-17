import {
  AppState,
  DeviceEventEmitter,
  Linking,
  NativeModules,
} from "react-native";
import { act } from "react-test-renderer";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import type {
  AwsEc2HostRecord,
  AuthSession,
  AuthState,
  GroupRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  MobileSessionRecord,
  ManagedAwsProfilePayload,
  SshHostRecord,
  SyncPayloadV2,
  SyncRecord,
  TailnetPayload,
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
  resetReportedTerminalGridForTests,
  setReportedTerminalGrid,
} from "../src/lib/terminal-size";
import { configureSyncedTailnets } from "../src/lib/tailnet-runtime";
import {
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from "../src/store/useMobileAppStore";

const REPORTED_TEST_GRID = { cols: 57, rows: 46 };

// The SSH engine's native module, installed once by jest.setup.js. The store
// reaches the engine through it, so connection assertions are made here rather
// than on a stand-in connection object.
const engineNative = NativeModules.GoSshEngineModule as Record<
  string,
  jest.Mock
>;

// 계정 로그인은 앱 안의 브라우저 시트(iOS SFSafariViewController / Android Custom Tabs)에서
// 이뤄진다. 네이티브 모듈이 없으면 시스템 브라우저로 폴백하므로, 시트를 쓰는지 자체를
// 단정하려면 모듈이 붙어 있어야 한다.
const inAppBrowserNative = {
  openBrowser: jest.fn<Promise<void>, [string]>(),
  closeBrowser: jest.fn<Promise<void>, []>(),
};
(NativeModules as Record<string, unknown>).AwsSsoBridgeModule =
  inAppBrowserNative;

// connect and startShell take their arguments as JSON, the same wire format the
// desktop sends ssh-core, so a test has to decode before it can assert.
function lastConnectRequest(): Record<string, unknown> {
  const { calls } = engineNative.connect.mock;
  return JSON.parse(calls[calls.length - 1][1] as string) as Record<
    string,
    unknown
  >;
}

function lastStartShellOptions(): Record<string, unknown> {
  const { calls } = engineNative.startShell.mock;
  return JSON.parse(calls[calls.length - 1][1] as string) as Record<
    string,
    unknown
  >;
}

/**
 * A known-host record matching the key the engine's probe reports.
 *
 * The engine probes the host key first and the store only connects once that
 * key is trusted, so a connection test that starts with an empty known-hosts
 * list stops at the approval prompt and never reaches the engine at all. The
 * key is read back from the probe mock rather than restated here, so the two
 * cannot drift apart.
 */
async function trustedHostKey(
  hostname: string,
  port: number,
  tailnetId?: string,
): Promise<KnownHostRecord> {
  const probed = JSON.parse(
    (await engineNative.probeHostKey("{}")) as string,
  ) as {
    algorithm: string;
    publicKeyBase64: string;
    fingerprintSha256: string;
  };
  engineNative.probeHostKey.mockClear();

  return {
    id: `known-host-${hostname}-${port}`,
    ...(tailnetId ? { tailnetId } : {}),
    host: hostname,
    port,
    algorithm: probed.algorithm,
    publicKeyBase64: probed.publicKeyBase64,
    fingerprintSha256: probed.fingerprintSha256,
    createdAt: "2026-04-13T00:00:00.000Z",
    lastSeenAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  };
}

async function createPasswordSshFixture(id = "host-lifecycle") {
  const host: SshHostRecord = {
    id,
    kind: "ssh",
    label: "Lifecycle SSH",
    hostname: "lifecycle.example.com",
    port: 22,
    username: "deploy",
    authType: "password",
    secretRef: `${id}-secret`,
    privateKeyPath: null,
    certificatePath: null,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  };
  const secret: LoadedManagedSecretPayload = {
    secretRef: host.secretRef as string,
    label: "Lifecycle credentials",
    password: "super-secret",
    updatedAt: "2026-04-13T00:00:00.000Z",
  };
  const knownHost = await trustedHostKey(host.hostname, host.port);
  return { host, secret, knownHost };
}

jest.mock("@aws-sdk/client-sts", () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(async () => ({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/test",
      UserId: "test",
    })),
    destroy: jest.fn(),
  })),
  GetCallerIdentityCommand: jest.fn(),
  AssumeRoleCommand: jest.fn(),
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
const asyncStorageMock = jest.requireMock(
  "@react-native-async-storage/async-storage",
) as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
  clear: jest.Mock;
};

function createAuthSession(overrides?: Partial<AuthSession>): AuthSession {
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
        name.toLowerCase() === "etag" ? (etag ?? null) : null,
    },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
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
      | "tailnets"
      | "knownHosts"
      | "secretMetadata"
      | "sessions"
      | "sftpSessions"
      | "sftpTransfers"
      | "sftpCopyBuffer"
      | "activeConnectionTab"
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
    tailnets: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    activeConnectionTab: null,
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
  tailnets?: TailnetPayload[] | null;
}): void {
  const values = new Map<string, string>();

  if (input?.session) {
    values.set("dolgate.mobile.auth-session", JSON.stringify(input.session));
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
  if (input?.tailnets) {
    values.set(
      "dolgate.mobile.managed-tailnets",
      JSON.stringify(input.tailnets),
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

async function flushAsyncWorkDeep(): Promise<void> {
  await flushAsyncWork();
  await flushAsyncWork();
  await flushAsyncWork();
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
    // 접속은 xterm 이 보고한 실제 그리드를 기다린다(없으면 추정값으로 폴백하며 대기).
    // 테스트는 보고된 상태를 전제로 PTY 크기 전달을 검증한다.
    resetReportedTerminalGridForTests();
    setReportedTerminalGrid(REPORTED_TEST_GRID);
    fetchMock.mockReset();
    jest.clearAllMocks();
    asyncStorageMock.setItem.mockClear();
    // 앞 테스트가 심어둔 거부/해결 구현이 남지 않게 매번 기본 성공으로 되돌린다.
    inAppBrowserNative.openBrowser.mockReset();
    inAppBrowserNative.openBrowser.mockResolvedValue(undefined);
    inAppBrowserNative.closeBrowser.mockReset();
    inAppBrowserNative.closeBrowser.mockResolvedValue(undefined);
    (Linking.openURL as jest.Mock).mockResolvedValue(undefined);
    engineNative.startTailnet.mockResolvedValue(undefined);
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

  it("restores unauthenticated state when opening the sign-in sheet fails", async () => {
    const openUrlSpy = jest.spyOn(Linking, "openURL");
    inAppBrowserNative.openBrowser.mockRejectedValue(
      new Error("브라우저를 표시할 화면을 찾지 못했습니다."),
    );

    await act(async () => {
      await useMobileAppStore.getState().startBrowserLogin();
    });

    expect(inAppBrowserNative.openBrowser).toHaveBeenCalledTimes(1);
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().auth.status).toBe("unauthenticated");
    expect(useMobileAppStore.getState().pendingBrowserLoginState).toBeNull();
    // 네이티브 reject 문구는 지역화돼 있지 않고 시트를 공유하는 여러 맥락에서 오므로, 사용자는
    // 이 경로의 문구만 봐야 한다 — 원문이 그대로 새면 영어 사용자에게 한국어가 뜬다.
    expect(useMobileAppStore.getState().auth.errorMessage).toBe(
      "로그인 창을 열지 못했습니다.",
    );
  });

  // 시스템 브라우저로 내보내면 App Store 심사 Guideline 4.0("앱을 벗어나 로그인")에 걸린다 —
  // 1.8.5 가 그 이유로 리젝됐으므로 시트 경로를 회귀 테스트로 못박는다.
  it("opens the sign-in page in the in-app sheet instead of the system browser", async () => {
    const openUrlSpy = jest.spyOn(Linking, "openURL");

    await act(async () => {
      await useMobileAppStore.getState().startBrowserLogin();
    });

    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(inAppBrowserNative.openBrowser).toHaveBeenCalledTimes(1);

    const openedUrl = new URL(inAppBrowserNative.openBrowser.mock.calls[0][0]);
    expect(openedUrl.pathname).toBe("/login");
    expect(openedUrl.searchParams.get("redirect_uri")).toBe(
      "dolgate://auth/callback",
    );
    expect(openedUrl.searchParams.get("state")).toBe(
      useMobileAppStore.getState().pendingBrowserLoginState,
    );
    expect(useMobileAppStore.getState().auth.status).toBe("authenticating");
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
    // 취소했으면 떠 있던 시트도 닫혀야 한다.
    expect(inAppBrowserNative.closeBrowser).toHaveBeenCalled();
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
    // 거부된 콜백이어도 앱으로 돌아왔으니 시트는 닫아야 오류 문구가 보인다.
    expect(inAppBrowserNative.closeBrowser).toHaveBeenCalled();
  });

  it("exchanges a verified login callback and syncs hosts successfully", async () => {
    const session = createAuthSession();
    fetchMock.mockImplementation(async input => {
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
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/auth/exchange", "/api/info", "/sync"]);
    // 로그인이 성공했어도 시트는 네이티브에 그대로 떠 있다 — 딥링크가 앱을 앞으로 끌어올릴
    // 뿐이라, 닫아주지 않으면 로그인 페이지가 홈 화면을 덮은 채 남는다.
    expect(inAppBrowserNative.closeBrowser).toHaveBeenCalled();
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

    fetchMock.mockImplementation(async input => {
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
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/api/info", "/sync", "/auth/refresh", "/sync"]);
  });

  it("changes the account password and persists the updated password state", async () => {
    const session = createAuthSession({
      user: {
        id: "user-1",
        email: "mobile@example.com",
        passwordState: "unset",
      },
    });
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/account/password" && init?.method === "PUT") {
        expect(init.headers).toMatchObject({
          authorization: "Bearer access-token",
        });
        expect(JSON.parse(String(init.body))).toEqual({
          currentPassword: "",
          newPassword: "new-password",
          refreshToken: "refresh-token",
        });
        return createJsonResponse({ passwordState: "set" });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
    });
    await act(async () => {
      await useMobileAppStore
        .getState()
        .changeAccountPassword("", "new-password");
    });

    expect(useMobileAppStore.getState().auth.session?.user.passwordState).toBe(
      "set",
    );
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      "dolgate",
      expect.stringContaining('\"passwordState\":\"set\"'),
      expect.objectContaining({ service: "dolgate.mobile.auth-session" }),
    );
  });

  it("deletes the account remotely and clears local state without a logout call", async () => {
    const session = createAuthSession();
    const host: SshHostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Test host",
      hostname: "example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/account" && init?.method === "DELETE") {
        return createJsonResponse("", 204);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
        hosts: [host],
        tailnets: [
          {
            id: "tailnet-work",
            label: "Work",
            createdAt: "2026-04-13T00:00:00.000Z",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().deleteAccount();
    });

    const state = useMobileAppStore.getState();
    expect(state.auth.status).toBe("unauthenticated");
    expect(state.auth.session).toBeNull();
    expect(state.hosts).toEqual([]);
    expect(state.tailnets).toEqual([]);
    expect(engineNative.forgetTailnet).toHaveBeenCalledWith("tailnet-work");
    expect(engineNative.closeTailnets).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/auth/account"]);
    for (const service of [
      "dolgate.mobile.auth-session",
      "dolgate.mobile.managed-secrets",
      "dolgate.mobile.managed-aws-profiles",
      "dolgate.mobile.aws-sso-tokens",
      "dolgate.mobile.managed-tailnets",
    ]) {
      expect(keychainMock.resetGenericPassword).toHaveBeenCalledWith({
        service,
      });
    }
  });

  it("retries account deletion once after refreshing an expired access token", async () => {
    const staleSession = createAuthSession();
    const refreshedSession = createAuthSession({
      tokens: {
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
        expiresInSeconds: 900,
      },
    });
    const deleteAuthHeaders: Array<string | undefined> = [];

    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/account") {
        const headers = init?.headers as Record<string, string> | undefined;
        deleteAuthHeaders.push(headers?.authorization);
        if (deleteAuthHeaders.length === 1) {
          return createJsonResponse({ error: "expired" }, 401);
        }
        return createJsonResponse("", 204);
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
      await useMobileAppStore.getState().deleteAccount();
    });

    expect(deleteAuthHeaders).toEqual([
      "Bearer access-token",
      "Bearer fresh-access-token",
    ]);
    expect(useMobileAppStore.getState().auth.status).toBe("unauthenticated");
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/auth/account", "/auth/refresh", "/auth/account"]);
  });

  it("keeps the current session when account deletion fails on the server", async () => {
    const session = createAuthSession();
    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/account") {
        return createJsonResponse({ error: "서버 오류가 발생했습니다." }, 500);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(session),
      });
    });

    await expect(useMobileAppStore.getState().deleteAccount()).rejects.toThrow(
      "서버 오류가 발생했습니다.",
    );

    const state = useMobileAppStore.getState();
    expect(state.auth.status).toBe("authenticated");
    expect(state.auth.session?.tokens.accessToken).toBe("access-token");
    expect(keychainMock.resetGenericPassword).not.toHaveBeenCalled();
  });

  it("rejects account deletion while running on the offline cache", async () => {
    await act(async () => {
      resetStore({
        auth: {
          status: "offline-authenticated",
          session: createAuthSession(),
          offline: {
            expiresAt: "2026-04-14T00:00:00.000Z",
            lastOnlineAt: "2026-04-13T00:00:00.000Z",
            reason: "network",
          },
          errorMessage: null,
        },
      });
    });

    await expect(useMobileAppStore.getState().deleteAccount()).rejects.toThrow(
      "온라인 로그인 상태에서만 회원 탈퇴할 수 있습니다.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().auth.status).toBe(
      "offline-authenticated",
    );
  });

  it("resolves startup auth gating without waiting for refresh to finish", async () => {
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
    const storedSecrets = {
      "secret-1": {
        secretRef: "secret-1",
        label: "Stored SSH secret",
        password: "super-secret",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    } satisfies Record<string, LoadedManagedSecretPayload>;
    const storedAwsProfiles: ManagedAwsProfilePayload[] = [
      {
        id: "profile-prod",
        name: "prod",
        kind: "static",
        region: "ap-northeast-2",
        accessKeyId: "AKIAPROD",
        secretAccessKey: "prod-secret",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ];
    const storedTailnets: TailnetPayload[] = [
      {
        id: "tailnet-work",
        label: "Work",
        controlUrl: "https://control.example.com",
        authKey: "tskey-cached",
        hasAuthKey: true,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ];
    let resolveStoredSecrets: (
      value: {
        username: string;
        password: string;
      } | null,
    ) => void = () => undefined;
    let resolveStoredAwsProfiles: (
      value: {
        username: string;
        password: string;
      } | null,
    ) => void = () => undefined;

    keychainMock.getGenericPassword.mockImplementation(
      async ({ service }: { service: string }) => {
        if (service === "dolgate.mobile.auth-session") {
          return {
            username: "dolgate",
            password: JSON.stringify(storedSession),
          };
        }
        if (service === "dolgate.mobile.managed-secrets") {
          return await new Promise(resolve => {
            resolveStoredSecrets = resolve;
          });
        }
        if (service === "dolgate.mobile.managed-aws-profiles") {
          return await new Promise(resolve => {
            resolveStoredAwsProfiles = resolve;
          });
        }
        if (service === "dolgate.mobile.managed-tailnets") {
          return {
            username: "dolgate",
            password: JSON.stringify(storedTailnets),
          };
        }
        return null;
      },
    );
    let resolveRefresh: ((response: Response) => void) | null = null;
    let resolveSyncSnapshot: ((response: Response) => void) | null = null;

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/refresh") {
        return await new Promise<Response>(resolve => {
          resolveRefresh = resolve;
        });
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
        return await new Promise<Response>(resolve => {
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
    expect(state.auth.session?.tokens.accessToken).toBe("access-token");
    expect(state.authGateResolved).toBe(true);
    expect(state.secureStateReady).toBe(false);
    expect(state.syncStatus.status).toBe("syncing");
    expect(state.awsProfiles).toEqual([]);
    expect(state.secretsByRef).toEqual({});
    expect(NativeModules.GoSshEngineModule.connect).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/auth/refresh"]);

    await act(async () => {
      resolveStoredSecrets({
        username: "dolgate",
        password: JSON.stringify(storedSecrets),
      });
      resolveStoredAwsProfiles({
        username: "dolgate",
        password: JSON.stringify(storedAwsProfiles),
      });
      await flushAsyncWorkDeep();
    });

    expect(useMobileAppStore.getState().secureStateReady).toBe(true);
    expect(useMobileAppStore.getState().awsProfiles[0]?.name).toBe("prod");
    expect(useMobileAppStore.getState().tailnets[0]?.id).toBe("tailnet-work");
    expect(engineNative.configureTailnets).toHaveBeenCalledWith(
      "https://ssh.doldolma.com\nuser-1",
      JSON.stringify({
        configs: [
          {
            id: "tailnet-work",
            controlUrl: "https://control.example.com",
            authKey: "tskey-cached",
            ephemeral: false,
          },
        ],
      }),
    );
    expect(
      useMobileAppStore.getState().secretsByRef["secret-1"]?.password,
    ).toBe("super-secret");

    await act(async () => {
      resolveRefresh?.(createJsonResponse(refreshedSession));
      await flushAsyncWorkDeep();
    });

    expect(useMobileAppStore.getState().auth.session?.tokens.accessToken).toBe(
      "fresh-access-token",
    );
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/auth/refresh", "/api/info", "/sync"]);

    await act(async () => {
      resolveSyncSnapshot?.(createJsonResponse(buildEmptySyncPayload()));
      await flushAsyncWork();
    });
  });

  it("blocks host connections until secure state restore finishes", async () => {
    const host: SshHostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Delayed SSH",
      hostname: "host.example.com",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        secureStateReady: false,
        hosts: [host],
      });
    });

    let sessionId: string | null = "placeholder";
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(sessionId).toBeNull();
    expect(useMobileAppStore.getState().sessions).toHaveLength(0);
    expect(useMobileAppStore.getState().syncStatus.errorMessage).toContain(
      "저장된 보안 정보를 복구하는 중입니다.",
    );
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
        await useMobileAppStore.getState().initializeApp();
        await flushAsyncWork();
      });

      let state = useMobileAppStore.getState();
      expect(state.auth.status).toBe("authenticated");
      expect(state.auth.session?.tokens.accessToken).toBe("access-token");
      expect(state.authGateResolved).toBe(true);
      expect(state.secureStateReady).toBe(true);
      expect(state.syncStatus.status).toBe("syncing");

      await act(async () => {
        await jest.advanceTimersByTimeAsync(3_000);
        await flushAsyncWorkDeep();
      });

      state = useMobileAppStore.getState();
      expect(state.auth.status).toBe("offline-authenticated");
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
        await useMobileAppStore.getState().initializeApp();
        await flushAsyncWork();
      });

      expect(useMobileAppStore.getState().auth.status).toBe("authenticated");

      await act(async () => {
        await jest.advanceTimersByTimeAsync(3_000);
        await flushAsyncWorkDeep();
      });

      const state = useMobileAppStore.getState();
      expect(state.auth.status).toBe("authenticated");
      expect(state.auth.session?.tokens.accessToken).toBe("fresh-access-token");
      expect(state.auth.offline).toBeNull();
      expect(state.syncStatus.status).toBe("ready");
      expect(state.syncStatus.errorMessage).toBeNull();
      expect(
        fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
      ).toEqual(["/auth/refresh", "/auth/refresh", "/api/info", "/sync"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps retrying startup offline recovery until the network comes back", async () => {
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
        if (refreshAttempt === 2) {
          throw new Error("Network request failed");
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
        await useMobileAppStore.getState().initializeApp();
        await flushAsyncWork();
      });

      expect(useMobileAppStore.getState().auth.status).toBe("authenticated");

      await act(async () => {
        await jest.advanceTimersByTimeAsync(3_000);
        await flushAsyncWorkDeep();
      });

      expect(useMobileAppStore.getState().auth.status).toBe(
        "offline-authenticated",
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_000);
        await flushAsyncWorkDeep();
      });

      const state = useMobileAppStore.getState();
      expect(state.auth.status).toBe("authenticated");
      expect(state.auth.session?.tokens.accessToken).toBe("fresh-access-token");
      expect(state.syncStatus.status).toBe("ready");
      expect(
        fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
      ).toEqual([
        "/auth/refresh",
        "/auth/refresh",
        "/auth/refresh",
        "/api/info",
        "/sync",
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("returns from offline-authenticated to authenticated after a later recovery retry succeeds", async () => {
    jest.useFakeTimers();
    const session = createAuthSession({
      offlineLease: {
        token: "offline-token",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: "public-key",
      },
    });
    const refreshedSession = createAuthSession({
      offlineLease: session.offlineLease,
      tokens: {
        accessToken: "fresh-access-token",
        refreshToken: "fresh-refresh-token",
        expiresInSeconds: 900,
      },
    });
    let syncAttempt = 0;

    fetchMock.mockImplementation(async input => {
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
        syncAttempt += 1;
        if (syncAttempt === 1) {
          throw new Error("Network request failed");
        }
        return createJsonResponse(buildEmptySyncPayload());
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    try {
      await act(async () => {
        resetStore({
          auth: createAuthenticatedState(session),
        });
        await useMobileAppStore.getState().syncNow();
        await flushAsyncWorkDeep();
      });

      expect(useMobileAppStore.getState().auth.status).toBe(
        "offline-authenticated",
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_000);
        await flushAsyncWorkDeep();
      });

      const state = useMobileAppStore.getState();
      expect(state.auth.status).toBe("authenticated");
      expect(state.auth.session?.tokens.accessToken).toBe("fresh-access-token");
      expect(state.syncStatus.status).toBe("ready");
      expect(
        fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
      ).toEqual(["/api/info", "/sync", "/auth/refresh", "/api/info", "/sync"]);
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

    fetchMock.mockImplementation(async input => {
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

  it("persists lightweight startup cache without secret metadata or terminal snapshots", async () => {
    await act(async () => {
      resetStore({
        secretMetadata: [
          {
            secretRef: "secret-1",
            label: "Stored SSH secret",
            hasPassword: true,
            hasManagedPrivateKey: false,
            hasPassphrase: false,
            hasCertificate: false,
            linkedHostCount: 1,
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
        tailnets: [
          {
            id: "tailnet-secret",
            label: "Secret Tailnet",
            authKey: "tskey-must-not-enter-async-storage",
            createdAt: "2026-04-13T00:00:00.000Z",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
        sessions: [
          {
            id: "session-1",
            sessionId: "session-1",
            hostId: "host-1",
            title: "Persisted Session",
            status: "closed",
            hasReceivedOutput: true,
            isRestorable: true,
            lastViewportSnapshot: "user@host:~$ prompt",
            lastEventAt: "2026-04-13T00:00:00.000Z",
            lastConnectedAt: "2026-04-13T00:00:00.000Z",
            lastDisconnectedAt: "2026-04-13T00:00:00.000Z",
            errorMessage: null,
          },
        ],
      });
      await flushAsyncWorkDeep();
    });

    const lastPersistCall = asyncStorageMock.setItem.mock.calls.at(-1);
    expect(lastPersistCall).toBeDefined();

    const persistedPayload = JSON.parse(lastPersistCall?.[1] as string) as {
      state: {
        secretMetadata?: unknown;
        tailnets?: unknown;
        sessions: Array<{ lastViewportSnapshot: string }>;
      };
    };

    expect(persistedPayload.state.secretMetadata).toBeUndefined();
    expect(persistedPayload.state.tailnets).toBeUndefined();
    expect(lastPersistCall?.[1]).not.toContain(
      "tskey-must-not-enter-async-storage",
    );
    expect(persistedPayload.state.sessions[0]?.lastViewportSnapshot).toBe("");
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
      groups: groups.map(group =>
        createEncryptedRecord(group.id, group, keyBase64),
      ),
      hosts: [createEncryptedRecord(host.id, host, keyBase64)],
    };

    fetchMock.mockImplementation(async input => {
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
    expect(state.groups.map(group => group.path)).toEqual([
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

    fetchMock.mockImplementation(async input => {
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

  it("hydrates Tailnet settings into Keychain and the account-scoped native runtime", async () => {
    const keyBase64 = Buffer.from(
      "12345678901234567890123456789012",
      "utf8",
    ).toString("base64");
    const session = createAuthSession({
      vaultBootstrap: { keyBase64 },
    });
    const tailnet: TailnetPayload = {
      id: "tailnet-corp",
      label: "Corp",
      controlUrl: " https://control.example.com ",
      authKey: " tskey-secret ",
      ephemeral: true,
      hasAuthKey: true,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const payload: SyncPayloadV2 = {
      ...buildEmptySyncPayload(),
      tailnets: [createEncryptedRecord(tailnet.id, tailnet, keyBase64)],
    };

    fetchMock.mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/info") {
        return createJsonResponse({
          serverVersion: "test",
          capabilities: {
            sync: { awsProfiles: true },
            sessions: { awsSsm: true },
          },
        });
      }
      if (path === "/sync") {
        return createJsonResponse(payload, 200, '"12"');
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState(session) });
      await useMobileAppStore.getState().syncNow();
    });

    expect(useMobileAppStore.getState().tailnets).toEqual([tailnet]);
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      "dolgate",
      JSON.stringify([tailnet]),
      expect.objectContaining({ service: "dolgate.mobile.managed-tailnets" }),
    );
    expect(engineNative.configureTailnets).toHaveBeenCalledWith(
      "https://ssh.doldolma.com\nuser-1",
      JSON.stringify({
        configs: [
          {
            id: "tailnet-corp",
            controlUrl: "https://control.example.com",
            authKey: "tskey-secret",
            ephemeral: false,
          },
        ],
      }),
    );

    const appStateListener = (AppState.addEventListener as jest.Mock).mock
      .calls[0]?.[1] as ((state: string) => void) | undefined;
    expect(appStateListener).toBeDefined();
    appStateListener?.("background");
    expect(engineNative.cancelTailnet).not.toHaveBeenCalled();
    expect(engineNative.closeTailnets).not.toHaveBeenCalled();
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
      .sessions.find(item => item.id === sessionId);
    expect(session?.connectionKind).toBe("aws-ssm");
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toContain("지원하지 않습니다");
  });

  it("connects private key SSH hosts with passphrase-backed saved credentials", async () => {
    const host: SshHostRecord = {
      id: "host-key",
      kind: "ssh",
      label: "Key SSH",
      hostname: "host.example.com",
      port: 22,
      username: "deploy",
      authType: "privateKey",
      secretRef: "secret-key",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-key",
      label: "Key SSH credentials",
      privateKeyPem: "PRIVATE KEY",
      passphrase: "key-passphrase",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    const knownHost = await trustedHostKey(host.hostname, host.port);

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        secretsByRef: {
          [secret.secretRef]: secret,
        },
      });
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(sessionId).not.toBeNull();
    expect(engineNative.inspectPrivateKey).toHaveBeenCalledWith(
      "PRIVATE KEY",
      "key-passphrase",
    );
    expect(lastConnectRequest()).toEqual(
      expect.objectContaining({
        host: host.hostname,
        port: host.port,
        username: host.username,
        authType: "privateKey",
        privateKeyPem: "PRIVATE KEY",
        passphrase: "key-passphrase",
      }),
    );
    expect(engineNative.startShell).toHaveBeenCalledTimes(1);
  });

  // 데스크톱에서 agent 인증으로 설정한 호스트. 모바일에는 ssh-agent 가 없어 연결할 수 없다.
  // 예전에는 "이 인증 방식은 지원하지 않습니다"만 떠서 무엇을 바꿔야 하는지 알 수 없었다.
  it("explains why an ssh-agent host cannot connect from mobile", async () => {
    const host: SshHostRecord = {
      id: "host-agent",
      kind: "ssh",
      label: "Agent SSH",
      hostname: "agent.example.com",
      port: 22,
      username: "deploy",
      authType: "agent",
      secretRef: null,
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const knownHost = await trustedHostKey(host.hostname, host.port);

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    const session = useMobileAppStore
      .getState()
      .sessions.find(entry => entry.hostId === host.id);
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toContain("SSH Agent");
    // 무엇을 바꿔야 하는지까지 말해 준다 — "지원하지 않습니다"만으로는 알 수 없다.
    expect(session?.errorMessage).toContain("데스크톱");
    expect(engineNative.connect).not.toHaveBeenCalled();
  });

  // Probing costs a whole extra TCP connection and key exchange, so a host that
  // was approved once must not pay for it again.
  it("connects without probing when the host key is already on file", async () => {
    const host: SshHostRecord = {
      id: "host-known",
      kind: "ssh",
      label: "Known SSH",
      hostname: "host.example.com",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: "secret-known",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-known",
      label: "Known SSH credentials",
      password: "super-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const knownHost = await trustedHostKey(host.hostname, host.port);

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(engineNative.probeHostKey).not.toHaveBeenCalled();
    expect(engineNative.startTailnet).not.toHaveBeenCalled();
    expect(engineNative.connect).toHaveBeenCalledTimes(1);
    // The key on file is what the connect is checked against.
    expect(lastConnectRequest().trustedHostKeysBase64).toEqual([
      knownHost.publicKeyBase64,
    ]);
    expect(useMobileAppStore.getState().pendingServerKeyPrompt).toBeNull();
  });

  it("routes SSH through its synced Tailnet and only trusts keys from that scope", async () => {
    const host: SshHostRecord = {
      id: "host-tailnet",
      kind: "ssh",
      label: "Tailnet SSH",
      tailnetId: "corp",
      hostname: "shared-name",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: "secret-tailnet",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-tailnet",
      label: "Tailnet SSH credentials",
      password: "super-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const scopedKey = await trustedHostKey(host.hostname, host.port, "corp");
    const directKey: KnownHostRecord = {
      ...scopedKey,
      id: "known-host-direct",
      tailnetId: undefined,
      publicKeyBase64: "DIRECT-NETWORK-KEY",
    };
    const tailnet: TailnetPayload = {
      id: "corp",
      label: "Corp",
      tailnetName: "example.com",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        tailnets: [tailnet],
        knownHosts: [directKey, scopedKey],
        secretsByRef: { [secret.secretRef]: secret },
      });
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(engineNative.probeHostKey).not.toHaveBeenCalled();
    expect(engineNative.startTailnet).toHaveBeenCalledTimes(1);
    expect(engineNative.startTailnet.mock.invocationCallOrder[0]).toBeLessThan(
      engineNative.connect.mock.invocationCallOrder[0],
    );
    expect(lastConnectRequest()).toEqual(
      expect.objectContaining({
        tailnetId: "corp",
        tailnetName: "example.com",
        trustedHostKeysBase64: [scopedKey.publicKeyBase64],
      }),
    );
  });

  it("opens Tailnet authorization and continues the SSH connection after it becomes ready", async () => {
    const { host, secret } =
      await createPasswordSshFixture("host-tailnet-auth");
    host.tailnetId = "corp";
    const knownHost = await trustedHostKey(host.hostname, host.port, "corp");
    const tailnet: TailnetPayload = {
      id: "corp",
      label: "Corp",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    await configureSyncedTailnets({
      serverUrl: "https://sync.example.com",
      userId: "user-1",
      tailnets: [tailnet],
    });
    let finishTailnet: (() => void) | undefined;
    engineNative.startTailnet.mockImplementationOnce(
      requestId =>
        new Promise<void>(resolve => {
          finishTailnet = resolve;
          DeviceEventEmitter.emit("GoSshEngine:tailnet", {
            eventJson: JSON.stringify({
              type: "tailnetStatus",
              requestId,
              payload: {
                id: "corp",
                state: "needsAuth",
                authUrl: "https://login.tailscale.com/a/mobile",
              },
            }),
          });
        }),
    );

    let sessionId: string | null = null;
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        tailnets: [tailnet],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWorkDeep();
    });

    expect(inAppBrowserNative.openBrowser).toHaveBeenCalledWith(
      "https://login.tailscale.com/a/mobile",
    );
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(
      useMobileAppStore
        .getState()
        .sessions.find(session => session.id === sessionId)
        ?.connectionStatusMessage,
    ).toContain("브라우저");
    expect(engineNative.connect).not.toHaveBeenCalled();

    await act(async () => {
      finishTailnet?.();
      await flushAsyncWorkDeep();
    });

    const session = useMobileAppStore
      .getState()
      .sessions.find(record => record.id === sessionId);
    expect(engineNative.connect).toHaveBeenCalledTimes(1);
    expect(session?.status).toBe("connected");
    expect(session?.connectionStatusMessage).toBeNull();
    expect(inAppBrowserNative.closeBrowser).not.toHaveBeenCalled();
  });

  it("cancels Tailnet preparation when its SSH tab is closed", async () => {
    const { host, secret } = await createPasswordSshFixture(
      "host-tailnet-cancel",
    );
    host.tailnetId = "corp";
    const knownHost = await trustedHostKey(host.hostname, host.port, "corp");
    const tailnet: TailnetPayload = {
      id: "corp",
      label: "Corp",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    let finishTailnet: (() => void) | undefined;
    engineNative.startTailnet.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishTailnet = resolve;
        }),
    );
    engineNative.cancelTailnet.mockImplementationOnce(async () => {
      finishTailnet?.();
    });

    let sessionId: string | null = null;
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        tailnets: [tailnet],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWorkDeep();
    });
    expect(sessionId).not.toBeNull();
    expect(engineNative.startTailnet).toHaveBeenCalledTimes(1);

    await act(async () => {
      await useMobileAppStore.getState().disconnectSession(sessionId as string);
      await flushAsyncWorkDeep();
    });

    expect(engineNative.cancelTailnet).toHaveBeenCalledWith(
      expect.stringContaining("mobile-terminal-"),
      "corp",
    );
    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(
      useMobileAppStore
        .getState()
        .sessions.find(record => record.id === sessionId)?.status,
    ).toBe("closed");
  });

  it("keeps a second Tailnet authorization from replacing the active browser", async () => {
    const firstFixture = await createPasswordSshFixture("host-tailnet-first");
    const secondFixture = await createPasswordSshFixture("host-tailnet-second");
    firstFixture.host.tailnetId = "corp";
    secondFixture.host.tailnetId = "personal";
    const tailnets: TailnetPayload[] = [
      {
        id: "corp",
        label: "Corp",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
      {
        id: "personal",
        label: "Personal",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ];
    const finishes = new Map<string, () => void>();
    engineNative.startTailnet.mockImplementation(
      (requestId: string, payloadJson: string) =>
        new Promise<void>(resolve => {
          finishes.set(requestId, resolve);
          const payload = JSON.parse(payloadJson) as {
            config: { id: string };
          };
          DeviceEventEmitter.emit("GoSshEngine:tailnet", {
            eventJson: JSON.stringify({
              type: "tailnetStatus",
              requestId,
              payload: {
                id: payload.config.id,
                state: "needsAuth",
                authUrl: `https://login.tailscale.com/a/${payload.config.id}`,
              },
            }),
          });
        }),
    );
    engineNative.cancelTailnet.mockImplementation(async requestId => {
      finishes.get(requestId)?.();
    });

    let firstSessionId: string | null = null;
    let secondSessionId: string | null = null;
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [firstFixture.host, secondFixture.host],
        tailnets,
        secretsByRef: {
          [firstFixture.secret.secretRef]: firstFixture.secret,
          [secondFixture.secret.secretRef]: secondFixture.secret,
        },
      });
      firstSessionId = await useMobileAppStore
        .getState()
        .connectToHost(firstFixture.host.id);
      await flushAsyncWorkDeep();
      secondSessionId = await useMobileAppStore
        .getState()
        .connectToHost(secondFixture.host.id);
      await flushAsyncWorkDeep();
    });

    expect(inAppBrowserNative.openBrowser).toHaveBeenCalledTimes(1);
    expect(inAppBrowserNative.openBrowser).toHaveBeenCalledWith(
      "https://login.tailscale.com/a/corp",
    );
    expect(
      useMobileAppStore
        .getState()
        .sessions.find(record => record.id === secondSessionId)?.errorMessage,
    ).toContain("다른 Tailnet 인증");

    await act(async () => {
      await useMobileAppStore
        .getState()
        .disconnectSession(firstSessionId as string);
      await flushAsyncWorkDeep();
    });
  });

  it("does not open SSH with a stale Tailnet route after synced settings change", async () => {
    const { host, secret } = await createPasswordSshFixture(
      "host-tailnet-generation",
    );
    host.tailnetId = "corp";
    const knownHost = await trustedHostKey(host.hostname, host.port, "corp");
    const original: TailnetPayload = {
      id: "corp",
      label: "Corp",
      authKey: "old-key",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const changed: TailnetPayload = {
      ...original,
      authKey: "new-key",
      updatedAt: "2026-04-14T00:00:00.000Z",
    };

    await configureSyncedTailnets({
      serverUrl: "https://sync.example.com",
      userId: "user-1",
      tailnets: [original],
    });
    let finishTailnet: (() => void) | undefined;
    engineNative.startTailnet.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishTailnet = resolve;
        }),
    );
    engineNative.cancelTailnet.mockImplementationOnce(async () => {
      finishTailnet?.();
    });

    let sessionId: string | null = null;
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        tailnets: [original],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWorkDeep();
    });

    await act(async () => {
      // Model the narrow sync window: the runtime has received the new
      // generation, but Zustand has not committed the decoded snapshot yet.
      await configureSyncedTailnets({
        serverUrl: "https://sync.example.com",
        userId: "user-1",
        tailnets: [changed],
      });
      await flushAsyncWorkDeep();
    });

    expect(engineNative.cancelTailnet).toHaveBeenCalledWith(
      expect.stringContaining("mobile-terminal-"),
      "corp",
    );
    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(
      useMobileAppStore
        .getState()
        .sessions.find(record => record.id === sessionId)?.errorMessage,
    ).toContain("변경");
  });

  it("normalizes a Tailnet administrator approval timeout", async () => {
    const { host, secret } = await createPasswordSshFixture(
      "host-tailnet-approval",
    );
    host.tailnetId = "corp";
    const knownHost = await trustedHostKey(host.hostname, host.port, "corp");
    const tailnet: TailnetPayload = {
      id: "corp",
      label: "Corp",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    await configureSyncedTailnets({
      serverUrl: "https://sync.example.com",
      userId: "user-1",
      tailnets: [tailnet],
    });
    engineNative.startTailnet.mockImplementationOnce(async requestId => {
      DeviceEventEmitter.emit("GoSshEngine:tailnet", {
        eventJson: JSON.stringify({
          type: "tailnetStatus",
          requestId,
          payload: { id: "corp", state: "needsApproval" },
        }),
      });
      throw new Error("native timeout detail");
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        tailnets: [tailnet],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWorkDeep();
    });

    const session = useMobileAppStore.getState().sessions[0];
    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toContain("관리자");
    expect(session?.errorMessage).not.toContain("native timeout detail");
  });

  it("refuses a Tailnet host when its synced network configuration is missing", async () => {
    const { host, secret } = await createPasswordSshFixture(
      "host-missing-tailnet",
    );
    host.tailnetId = "deleted-tailnet";

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        tailnets: [],
        secretsByRef: { [secret.secretRef]: secret },
      });
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(engineNative.probeHostKey).not.toHaveBeenCalled();
    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().sessions[0]?.errorMessage).toContain(
      "Tailnet",
    );
  });

  // The other side of that skip: nothing on file means the user still decides,
  // and no connection is opened until they do.
  // 모바일은 점프 체인을 아예 보내지 않았다 — 데스크톱에서 설정해 동기화해도 폰은 대상 주소로
  // 직접 붙었고, 베스천 경유만 가능한 호스트는 타임아웃으로 끝났다. 다단 TOFU·중간 홉 OTP 도
  // 이것이 없으면 성립하지 않는다.
  // tailnet 준비는 붙는 시간의 대부분이고, 사람이 브라우저에서 승인해야 하는 구간이 그 안에 있다.
  // 그 구간이 화면에 보이려면 연결 뷰가 준비 **전에** 서 있어야 한다 — 뒤에 세우면 그때까지 올라온
  // 상태가 버려지고 화면은 "노드 시작 중" 에 얼어붙는다(실기기에서 그렇게 보였다).
  it("shows the tailnet layer while the node is still coming up", async () => {
    const host: SshHostRecord = {
      id: "host-tailnet",
      kind: "ssh",
      label: "Tailnet host",
      hostname: "oracle1",
      port: 22,
      username: "ubuntu",
      authType: "password",
      secretRef: "secret-tailnet",
      privateKeyPath: null,
      certificatePath: null,
      tailnetId: "tailnet-1",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    } as SshHostRecord;

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [],
        tailnets: [
          {
            id: "tailnet-1",
            label: "corp",
            authKey: "tskey-abc",
            hasAuthKey: true,
            createdAt: "2026-04-13T00:00:00.000Z",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
        secretsByRef: {
          "secret-tailnet": {
            secretRef: "secret-tailnet",
            label: "Tailnet host credentials",
            password: "pw",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        },
      });
    });

    // 노드가 올라오는 동안 붙잡는다. startTailnet 이 끝나지 않으면 그 구간에 멈춘 상태가 된다.
    let releaseTailnet: (() => void) | null = null;
    engineNative.startTailnet.mockImplementationOnce(
      async () =>
        new Promise<void>(resolve => {
          releaseTailnet = () => resolve();
        }),
    );

    await act(async () => {
      void useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    const state = useMobileAppStore.getState();
    const session = state.sessions.find(entry => entry.hostId === host.id);
    expect(session).toBeDefined();
    const view = state.connectionViews[session!.id];
    expect(view).toBeDefined();
    expect(view?.hasTailnet).toBe(true);
    expect(view?.targetAddress).toBe("oracle1");

    await act(async () => {
      releaseTailnet?.();
      await flushAsyncWork();
    });
  });

  it("sends the jump chain, innermost first", async () => {
    const bastion: SshHostRecord = {
      id: "host-bastion",
      kind: "ssh",
      label: "Bastion",
      hostname: "gw.example.com",
      port: 2222,
      username: "jump",
      authType: "password",
      secretRef: "secret-bastion",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const target: SshHostRecord = {
      ...bastion,
      id: "host-behind",
      label: "Behind",
      hostname: "10.1.1.9",
      port: 22,
      username: "deploy",
      secretRef: "secret-behind",
      jumpHostIds: [bastion.id],
    } as SshHostRecord;

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [bastion, target],
        knownHosts: [],
        secretsByRef: {
          "secret-bastion": {
            secretRef: "secret-bastion",
            label: "Bastion credentials",
            password: "bastion-pw",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
          "secret-behind": {
            secretRef: "secret-behind",
            label: "Behind credentials",
            password: "behind-pw",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().connectToHost(target.id);
      await flushAsyncWork();
    });

    const request = lastConnectRequest();
    expect(request.host).toBe("10.1.1.9");
    // 홉은 자기 주소·사용자·자격증명을 그대로 들고 간다. 대상의 것을 물려받으면 베스천 인증이
    // 실패하고, 그 실패는 "연결할 수 없음" 으로만 보인다.
    expect(request.jump).toEqual(
      expect.objectContaining({
        host: "gw.example.com",
        port: 2222,
        username: "jump",
        authType: "password",
        password: "bastion-pw",
      }),
    );
    // 한 홉짜리 체인이므로 그 안쪽은 없다 — 그것이 이 기기에서 직접 소켓을 여는 홉이다.
    expect((request.jump as Record<string, unknown>).jump).toBeUndefined();
  });

  // 점프 호스트에 tailnet 이 설정돼 있고 대상에는 없는 경우. 소켓을 여는 것은 첫 홉뿐이라 올려야
  // 하는 노드도 그쪽이다 — 대상에서 읽으면 베스천을 일반 네트워크로 찾다 실패한다.
  it("brings up the first hop's tailnet, not the target's", async () => {
    const bastion: SshHostRecord = {
      id: "host-bastion",
      kind: "ssh",
      label: "Bastion",
      hostname: "gw",
      port: 22,
      username: "jump",
      authType: "password",
      secretRef: "secret-bastion",
      privateKeyPath: null,
      certificatePath: null,
      tailnetId: "tailnet-1",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    } as SshHostRecord;
    const target: SshHostRecord = {
      ...bastion,
      id: "host-behind",
      label: "Behind",
      hostname: "192.168.50.10",
      secretRef: "secret-behind",
      tailnetId: null,
      jumpHostIds: [bastion.id],
    } as SshHostRecord;

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [bastion, target],
        knownHosts: [],
        tailnets: [
          {
            id: "tailnet-1",
            label: "corp",
            authKey: "tskey-abc",
            hasAuthKey: true,
            createdAt: "2026-04-13T00:00:00.000Z",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
        secretsByRef: {
          "secret-bastion": {
            secretRef: "secret-bastion",
            label: "Bastion credentials",
            password: "bastion-pw",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
          "secret-behind": {
            secretRef: "secret-behind",
            label: "Behind credentials",
            password: "behind-pw",
            updatedAt: "2026-04-13T00:00:00.000Z",
          },
        },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().connectToHost(target.id);
      await flushAsyncWork();
    });

    // 대상에는 tailnet 설정이 없지만 첫 홉의 것으로 노드가 올라가야 한다.
    expect(engineNative.startTailnet).toHaveBeenCalled();
    const startPayload = JSON.parse(
      engineNative.startTailnet.mock.calls[0][1] as string,
    ) as { config?: { id?: string } };
    expect(startPayload.config?.id).toBe("tailnet-1");

    // 그리고 실제로 붙어야 한다. 노드를 올린 것만 확인하면, 준비가 끝난 뒤 "설정이 바뀌었나" 를
    // 다시 판정하는 곳이 대상 기준으로 검사해 매번 거절하는 것을 놓친다 — 실기기에서 그랬다.
    expect(engineNative.connect).toHaveBeenCalledTimes(1);
    expect(lastConnectRequest().tailnetId).toBe("tailnet-1");
    expect(
      useMobileAppStore.getState().sessions.find(s => s.hostId === target.id)
        ?.errorMessage,
    ).toBeNull();
  });

  it("prompts for an unknown host key instead of connecting", async () => {
    const host: SshHostRecord = {
      id: "host-unknown",
      kind: "ssh",
      label: "Unknown SSH",
      hostname: "fresh.example.com",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: "secret-unknown",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-unknown",
      label: "Unknown SSH credentials",
      password: "super-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [],
        secretsByRef: { [secret.secretRef]: secret },
      });
    });

    // 코어가 연결 **도중에** 묻는다. 별도 프로브 연결은 없다 — 그것이 있으면 OTP 를 요구하는
    // 호스트에서 코드를 두 번 넣어야 하고, 30초마다 바뀌는 값이라 통과하지 못한다.
    // Once 로 심는다 — 이 스위트의 beforeEach 는 clearAllMocks 만 해서 구현은 남고, 뒤 테스트의
    // 연결이 여기서 심은 물음을 받게 된다.
    engineNative.connect.mockImplementationOnce(async (connectionId: string) => {
      const decided = new Promise<boolean>(resolve => {
        engineNative.respondHostKeyTrust.mockImplementationOnce(
          async (_challengeId: string, trust: boolean) => {
            resolve(trust);
          },
        );
      });
      DeviceEventEmitter.emit("GoSshEngine:connection", {
        eventJson: JSON.stringify({
          type: "hostKeyTrustChallenge",
          sessionId: connectionId,
          payload: {
            challengeId: "hostkey-trust-1",
            algorithm: "ssh-ed25519",
            fingerprintSha256: "SHA256:fresh",
            publicKeyBase64: "AAAAC3NzaC1lZDI1NTE5fresh",
            mismatch: false,
          },
        }),
      });
      if (!(await decided)) {
        throw new Error("connect: trusted host key is required");
      }
      return JSON.stringify({ id: connectionId });
    });

    await act(async () => {
      void useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(engineNative.probeHostKey).not.toHaveBeenCalled();
    // 물음이 떠 있고, 아직 아무 답도 가지 않았다.
    expect(useMobileAppStore.getState().pendingServerKeyPrompt).not.toBeNull();
    expect(engineNative.respondHostKeyTrust).not.toHaveBeenCalled();

    // 사용자가 승낙하면 그 답이 그 물음으로 돌아가고 연결이 이어진다.
    await act(async () => {
      await useMobileAppStore.getState().acceptServerKeyPrompt();
      await flushAsyncWork();
    });

    expect(engineNative.respondHostKeyTrust).toHaveBeenCalledWith(
      "hostkey-trust-1",
      true,
    );
    expect(useMobileAppStore.getState().pendingServerKeyPrompt).toBeNull();
  });

  it("connects certificate SSH hosts with synced private key and certificate", async () => {
    const host: SshHostRecord = {
      id: "host-cert",
      kind: "ssh",
      label: "Cert SSH",
      hostname: "host.example.com",
      port: 22,
      username: "deploy",
      authType: "certificate",
      secretRef: "secret-cert",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-cert",
      label: "Cert SSH credentials",
      privateKeyPem: "PRIVATE KEY",
      certificateText: "SSH CERTIFICATE",
      passphrase: "cert-passphrase",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    const knownHost = await trustedHostKey(host.hostname, host.port);

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        secretsByRef: {
          [secret.secretRef]: secret,
        },
      });
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(sessionId).not.toBeNull();
    expect(engineNative.inspectPrivateKey).toHaveBeenCalledWith(
      "PRIVATE KEY",
      "cert-passphrase",
    );
    expect(engineNative.inspectCertificate).toHaveBeenCalledWith(
      "SSH CERTIFICATE",
    );
    expect(lastConnectRequest()).toEqual(
      expect.objectContaining({
        host: host.hostname,
        port: host.port,
        username: host.username,
        authType: "certificate",
        privateKeyPem: "PRIVATE KEY",
        certificateText: "SSH CERTIFICATE",
        passphrase: "cert-passphrase",
      }),
    );
    expect(engineNative.startShell).toHaveBeenCalledTimes(1);
  });

  it("connects certificate SFTP tabs with the same SSH credential material", async () => {
    const host: SshHostRecord = {
      id: "host-cert-sftp",
      kind: "ssh",
      label: "Cert SFTP",
      tailnetId: "corp",
      hostname: "host.example.com",
      port: 22,
      username: "deploy",
      authType: "certificate",
      secretRef: "secret-cert-sftp",
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-cert-sftp",
      label: "Cert SFTP credentials",
      privateKeyPem: "PRIVATE KEY",
      certificateText: "SSH CERTIFICATE",
      passphrase: "cert-passphrase",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const session: MobileSessionRecord = {
      id: "session-cert-sftp",
      sessionId: "session-cert-sftp",
      hostId: host.id,
      title: host.label,
      status: "connected",
      hasReceivedOutput: true,
      isRestorable: true,
      lastViewportSnapshot: "",
      lastEventAt: "2026-04-13T00:00:00.000Z",
      lastConnectedAt: "2026-04-13T00:00:00.000Z",
      lastDisconnectedAt: null,
      errorMessage: null,
    };
    const knownHost = await trustedHostKey(host.hostname, host.port, "corp");
    const tailnet: TailnetPayload = {
      id: "corp",
      label: "Corp",
      tailnetName: "example.com",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        tailnets: [tailnet],
        knownHosts: [knownHost],
        sessions: [session],
        secretsByRef: {
          [secret.secretRef]: secret,
        },
      });
    });

    let sftpSessionId: string | null = null;
    await act(async () => {
      sftpSessionId = await useMobileAppStore
        .getState()
        .openSftpForSession(session.id);
      await flushAsyncWorkDeep();
    });

    expect(sftpSessionId).not.toBeNull();
    expect(engineNative.startTailnet).toHaveBeenCalledTimes(1);
    expect(engineNative.startTailnet.mock.invocationCallOrder[0]).toBeLessThan(
      engineNative.connect.mock.invocationCallOrder[0],
    );
    expect(lastConnectRequest()).toEqual(
      expect.objectContaining({
        host: host.hostname,
        port: host.port,
        username: host.username,
        authType: "certificate",
        privateKeyPem: "PRIVATE KEY",
        certificateText: "SSH CERTIFICATE",
        passphrase: "cert-passphrase",
        tailnetId: "corp",
        tailnetName: "example.com",
      }),
    );
    // A file-transfer tab rides its own connection, so the subsystem is opened
    // on the id that connection was made with.
    expect(engineNative.startSftp).toHaveBeenCalledWith(
      engineNative.connect.mock.calls[0][0],
    );
    expect(engineNative.sftpList).toHaveBeenCalledWith("test-sftp", ".");
  });

  it("opens AWS EC2 SFTP tabs through the sync-api proxy", async () => {
    const host: AwsEc2HostRecord = {
      id: "host-aws-sftp",
      kind: "aws-ec2",
      label: "AWS SFTP",
      awsProfileId: "profile-prod",
      awsProfileName: "prod",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-0123456789abcdef0",
      awsAvailabilityZone: "ap-northeast-2a",
      awsSshUsername: "ec2-user",
      awsSshPort: 22,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const profile: ManagedAwsProfilePayload = {
      id: "profile-prod",
      name: "prod",
      kind: "static",
      region: "ap-northeast-2",
      accessKeyId: "AKIAPROD",
      secretAccessKey: "prod-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const session: MobileSessionRecord = {
      id: "session-aws-sftp",
      sessionId: "session-aws-sftp",
      hostId: host.id,
      title: host.label,
      connectionKind: "aws-ssm",
      status: "connected",
      hasReceivedOutput: true,
      isRestorable: true,
      lastViewportSnapshot: "",
      lastEventAt: "2026-04-13T00:00:00.000Z",
      lastConnectedAt: "2026-04-13T00:00:00.000Z",
      lastDisconnectedAt: null,
      errorMessage: null,
    };
    const knownHosts: KnownHostRecord[] = [
      {
        id: "known-host-ed25519",
        host: "aws-ssm:prod:ap-northeast-2:i-0123456789abcdef0",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAED25519",
        fingerprintSha256: "SHA256:ed25519",
        createdAt: "2026-04-13T00:00:00.000Z",
        lastSeenAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
      {
        id: "known-host-ecdsa",
        host: "aws-ssm:prod:ap-northeast-2:i-0123456789abcdef0",
        port: 22,
        algorithm: "ecdsa-sha2-nistp256",
        publicKeyBase64: "AAAECDSA",
        fingerprintSha256: "SHA256:ecdsa",
        createdAt: "2026-04-13T00:00:00.000Z",
        lastSeenAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ];

    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/api/aws-sftp/sessions" &&
        init?.method === "POST"
      ) {
        return createJsonResponse(
          {
            sessionId: "aws-sftp-session-1",
            path: "/home/ec2-user",
            connectedAt: "2026-04-13T00:00:01.000Z",
          },
          201,
        );
      }
      if (url.pathname === "/api/aws-sftp/sessions/aws-sftp-session-1/list") {
        return createJsonResponse({
          path: "/home/ec2-user",
          entries: [
            {
              name: "app.log",
              path: "/home/ec2-user/app.log",
              isDirectory: false,
              size: 12,
              mtime: "2026-04-13T00:00:00Z",
              kind: "file",
              permissions: "-rw-r--r--",
            },
          ],
        });
      }
      if (
        url.pathname === "/api/aws-sftp/sessions/aws-sftp-session-1" &&
        init?.method === "DELETE"
      ) {
        return createJsonResponse({}, 204);
      }
      throw new Error(`unexpected fetch path: ${url.pathname}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        awsProfiles: [profile],
        knownHosts,
        sessions: [session],
        syncStatus: {
          ...createDefaultSyncStatus(),
          awsProfilesServerSupport: "supported",
          awsSsmServerSupport: "supported",
          awsSftpServerSupport: "supported",
        },
      });
    });

    let sftpSessionId: string | null = null;
    await act(async () => {
      sftpSessionId = await useMobileAppStore
        .getState()
        .openSftpForSession(session.id);
      await flushAsyncWorkDeep();
    });

    expect(sftpSessionId).not.toBeNull();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        new URL(String(input)).pathname === "/api/aws-sftp/sessions" &&
        init?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual(
      expect.objectContaining({
        hostId: host.id,
        profileName: "prod",
        region: "ap-northeast-2",
        instanceId: host.awsInstanceId,
        availabilityZone: "ap-northeast-2a",
        sshUsername: "ec2-user",
        sshPort: 22,
        env: expect.objectContaining({
          AWS_ACCESS_KEY_ID: "AKIAPROD",
          AWS_SECRET_ACCESS_KEY: "prod-secret",
        }),
        trustedHostKeyBase64: "AAAED25519",
        trustedHostKeysBase64: ["AAAED25519", "AAAECDSA"],
      }),
    );
    const sftpSession = useMobileAppStore
      .getState()
      .sftpSessions.find(item => item.id === sftpSessionId);
    expect(sftpSession?.status).toBe("connected");
    expect(sftpSession?.listing?.entries[0]?.name).toBe("app.log");
  });

  it("returns to login when AWS SFTP token refresh is expired", async () => {
    const host: AwsEc2HostRecord = {
      id: "host-aws-sftp-expired",
      kind: "aws-ec2",
      label: "Expired AWS SFTP",
      awsProfileId: "profile-prod",
      awsProfileName: "prod",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-0123456789abcdef0",
      awsAvailabilityZone: "ap-northeast-2a",
      awsSshUsername: "ec2-user",
      awsSshPort: 22,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const profile: ManagedAwsProfilePayload = {
      id: "profile-prod",
      name: "prod",
      kind: "static",
      region: "ap-northeast-2",
      accessKeyId: "AKIAPROD",
      secretAccessKey: "prod-secret",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const session: MobileSessionRecord = {
      id: "session-aws-sftp-expired",
      sessionId: "session-aws-sftp-expired",
      hostId: host.id,
      title: host.label,
      connectionKind: "aws-ssm",
      status: "connected",
      hasReceivedOutput: true,
      isRestorable: true,
      lastViewportSnapshot: "",
      lastEventAt: "2026-04-13T00:00:00.000Z",
      lastConnectedAt: "2026-04-13T00:00:00.000Z",
      lastDisconnectedAt: null,
      errorMessage: null,
    };

    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/api/aws-sftp/sessions" &&
        init?.method === "POST"
      ) {
        return createJsonResponse(
          { error: "token has invalid claims: token is expired" },
          401,
        );
      }
      if (url.pathname === "/auth/refresh") {
        return createJsonResponse({ error: "refresh token is expired" }, 401);
      }
      throw new Error(`unexpected fetch path: ${url.pathname}`);
    });

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        awsProfiles: [profile],
        sessions: [session],
        syncStatus: {
          ...createDefaultSyncStatus(),
          awsProfilesServerSupport: "supported",
          awsSsmServerSupport: "supported",
          awsSftpServerSupport: "supported",
        },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().openSftpForSession(session.id);
      await flushAsyncWorkDeep();
    });

    const state = useMobileAppStore.getState();
    expect(state.auth.status).toBe("unauthenticated");
    expect(state.auth.errorMessage).toContain("세션이 만료");
    expect(state.hosts).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.sftpSessions).toEqual([]);
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/api/aws-sftp/sessions", "/auth/refresh"]);
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
    const knownHost = await trustedHostKey(host.hostname, host.port);

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        secretsByRef: {
          [secret.secretRef]: secret,
        },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(engineNative.connect).toHaveBeenCalledTimes(1);
    expect(engineNative.startShell).toHaveBeenCalledTimes(1);
    expect(lastStartShellOptions()).toEqual(
      expect.objectContaining({
        term: "xterm",
        cols: REPORTED_TEST_GRID.cols,
        rows: REPORTED_TEST_GRID.rows,
      }),
    );

    await act(async () => {
      await useMobileAppStore
        .getState()
        .updateSettings({ serverUrl: "https://next.example.com" });
    });

    const state = useMobileAppStore.getState();
    expect(engineNative.disconnect).toHaveBeenCalledTimes(1);
    expect(state.auth.status).toBe("unauthenticated");
    expect(state.hosts).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.secretsByRef).toEqual({});
    expect(state.pendingBrowserLoginState).toBeNull();
  });

  it("releases the shell and connection when a remote SSH shell closes", async () => {
    const { host, secret, knownHost } = await createPasswordSshFixture();
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWorkDeep();
    });

    await act(async () => {
      DeviceEventEmitter.emit("GoSshEngine:shellClosed", {
        shellId: "test-shell",
      });
      await flushAsyncWorkDeep();
    });

    expect(engineNative.unfollowOutput).toHaveBeenCalledWith("test-shell", 1);
    expect(engineNative.closeShell).toHaveBeenCalledWith("test-shell");
    expect(engineNative.disconnect).toHaveBeenCalledWith(
      expect.stringContaining("session-"),
    );
    expect(useMobileAppStore.getState().sessions[0]?.status).toBe("closed");
  });

  it("rolls back the SSH connection when shell startup fails", async () => {
    const { host, secret, knownHost } =
      await createPasswordSshFixture("host-shell-failure");
    engineNative.startShell.mockRejectedValueOnce(new Error("shell refused"));
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWorkDeep();
    });

    expect(engineNative.disconnect).toHaveBeenCalledTimes(1);
    expect(engineNative.closeShell).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().sessions[0]?.status).toBe("error");
  });

  it("rolls back the shell and connection when output follow fails", async () => {
    const { host, secret, knownHost } = await createPasswordSshFixture(
      "host-follow-failure",
    );
    engineNative.followOutput.mockRejectedValueOnce(
      new Error("follow refused"),
    );
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        secretsByRef: { [secret.secretRef]: secret },
      });
      await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWorkDeep();
    });

    expect(engineNative.closeShell).toHaveBeenCalledWith("test-shell");
    expect(engineNative.disconnect).toHaveBeenCalledTimes(1);
    expect(useMobileAppStore.getState().sessions[0]?.status).toBe("error");
  });

  it("closes SFTP and SSH when the initial directory listing fails", async () => {
    const { host, secret, knownHost } = await createPasswordSshFixture(
      "host-sftp-list-failure",
    );
    const sourceSession: MobileSessionRecord = {
      id: "source-sftp-list-failure",
      sessionId: "source-sftp-list-failure",
      hostId: host.id,
      title: host.label,
      status: "connected",
      hasReceivedOutput: true,
      isRestorable: true,
      lastViewportSnapshot: "",
      lastEventAt: "2026-04-13T00:00:00.000Z",
      lastConnectedAt: "2026-04-13T00:00:00.000Z",
      lastDisconnectedAt: null,
      errorMessage: null,
    };
    engineNative.sftpList.mockRejectedValueOnce(new Error("permission denied"));
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
        sessions: [sourceSession],
        secretsByRef: { [secret.secretRef]: secret },
      });
      await useMobileAppStore.getState().openSftpForSession(sourceSession.id);
      await flushAsyncWorkDeep();
    });

    expect(engineNative.closeSftp).toHaveBeenCalledWith("test-sftp");
    expect(engineNative.disconnect).toHaveBeenCalledTimes(1);
    expect(useMobileAppStore.getState().sftpSessions[0]?.status).toBe("error");
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
    // Held open so the second attempt lands while the first is still in flight.
    // Only the first call is stubbed: were the guard to let a second through, it
    // would fall back to the default mock and connect for real, which is exactly
    // what the call count below catches.
    let resolveConnect: (() => void) | null = null;
    engineNative.connect.mockImplementationOnce(
      async () =>
        await new Promise<void>(resolve => {
          resolveConnect = () => resolve();
        }),
    );

    const knownHost = await trustedHostKey(host.hostname, host.port);

    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [host],
        knownHosts: [knownHost],
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

    expect(engineNative.connect).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConnect?.();
      await flushAsyncWork();
    });

    expect(engineNative.startShell).toHaveBeenCalledTimes(1);
    expect(lastStartShellOptions()).toEqual(
      expect.objectContaining({
        term: "xterm",
        cols: REPORTED_TEST_GRID.cols,
        rows: REPORTED_TEST_GRID.rows,
      }),
    );
    expect(useMobileAppStore.getState().sessions[0]?.status).toBe("connected");
  });
});
