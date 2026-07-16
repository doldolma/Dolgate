import { act } from "react-test-renderer";
import { gcm } from "@noble/ciphers/aes.js";
import type {
  AuthSession,
  AuthState,
  LoadedManagedSecretPayload,
  SshHostRecord,
  SyncPayloadV2,
} from "@dolssh/shared-core";
import { toByteArray } from "base64-js";
import { Buffer } from "buffer";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import {
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from "../src/store/useMobileAppStore";

jest.mock("@fressh/react-native-uniffi-russh", () => ({
  RnRussh: {
    uniffiInitAsync: jest.fn(async () => undefined),
    connect: jest.fn(),
    connectSftp: jest.fn(),
    validatePrivateKey: jest.fn(() => ({ valid: true })),
    validateCertificate: jest.fn(() => ({ valid: true })),
    deriveArgon2idKey: jest.fn(() => new Uint8Array(32)),
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

const VAULT_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");

function createAuthSession(): AuthSession {
  return {
    user: { id: "user-1", email: "hosts@example.com" },
    tokens: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 900,
    },
    vaultBootstrap: { keyBase64: VAULT_KEY_BASE64 },
    offlineLease: {
      token: "offline-token",
      issuedAt: "2026-07-11T00:00:00.000Z",
      expiresAt: "2026-07-12T00:00:00.000Z",
      verificationPublicKeyPem: "public-key",
    },
    syncServerTime: "2026-07-11T00:00:00.000Z",
  };
}

function createAuthenticatedState(): AuthState {
  return {
    status: "authenticated",
    session: createAuthSession(),
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
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  } as unknown as Response;
}

// push 페이로드의 암호화 레코드를 열어서 실제 내용까지 검증한다.
function decryptRecord<T>(encryptedPayload: string): T {
  const envelope = JSON.parse(encryptedPayload) as {
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const key = toByteArray(VAULT_KEY_BASE64);
  const iv = toByteArray(envelope.iv);
  const tag = toByteArray(envelope.tag);
  const ciphertext = toByteArray(envelope.ciphertext);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  const plaintext = gcm(key, iv).decrypt(sealed);
  return JSON.parse(Buffer.from(plaintext).toString("utf8")) as T;
}

function createExistingHost(): SshHostRecord {
  return {
    id: "host-1",
    kind: "ssh",
    label: "Existing host",
    hostname: "old.example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    secretRef: "secret-1",
    groupName: "work",
    // 모바일 폼이 다루지 않는 데스크톱 관리 필드 — 수정 후에도 보존돼야 한다.
    jumpHostIds: ["jump-1"],
    env: [{ key: "FOO", value: "bar" }],
    favorite: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function resetStore(overrides?: {
  auth?: AuthState;
  hosts?: SshHostRecord[];
  secretsByRef?: Record<string, LoadedManagedSecretPayload>;
}): void {
  const auth = overrides?.auth ?? createUnauthenticatedState();
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth,
    vault: auth.session?.vaultBootstrap.keyBase64
      ? { status: "legacy", epoch: 0, migrationRequired: false }
      : { status: "none" },
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    groups: [],
    hosts: overrides?.hosts ?? [],
    awsProfiles: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    activeSessionTabId: null,
    activeConnectionTab: null,
    secretsByRef: overrides?.secretsByRef ?? {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
  });
}

describe("useMobileAppStore host mutations", () => {
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

  it("creates a host with credentials and pushes both records before updating local state", async () => {
    const pushedPayloads: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        pushedPayloads.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState() });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        label: "  New host  ",
        hostname: " new.example.com ",
        port: 2222,
        username: " deploy ",
        authType: "password",
        groupName: "work/aws",
        credentials: { password: "hunter2" },
      });
    });

    // push 내용 검증 — 호스트와 시크릿이 같은 요청에 담긴다.
    expect(pushedPayloads).toHaveLength(1);
    const payload = pushedPayloads[0];
    expect(payload.hosts).toHaveLength(1);
    expect(payload.secrets).toHaveLength(1);
    const pushedHost = decryptRecord<SshHostRecord>(
      payload.hosts[0].encrypted_payload,
    );
    expect(pushedHost.label).toBe("New host");
    expect(pushedHost.hostname).toBe("new.example.com");
    expect(pushedHost.port).toBe(2222);
    expect(pushedHost.username).toBe("deploy");
    expect(pushedHost.groupName).toBe("work/aws");
    expect(pushedHost.secretRef).toBeTruthy();
    const pushedSecret = decryptRecord<LoadedManagedSecretPayload>(
      payload.secrets[0].encrypted_payload,
    );
    expect(payload.secrets[0].id).toBe(pushedHost.secretRef);
    expect(pushedSecret.password).toBe("hunter2");

    // 로컬 반영 검증.
    const state = useMobileAppStore.getState();
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0].label).toBe("New host");
    const secretRef = pushedHost.secretRef ?? "";
    expect(state.secretsByRef[secretRef]?.password).toBe("hunter2");
    expect(
      state.secretMetadata.find((entry) => entry.secretRef === secretRef)
        ?.linkedHostCount,
    ).toBe(1);
  });

  it("keeps local state untouched when the push fails", async () => {
    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync") {
        return createJsonResponse({ error: "서버 오류가 발생했습니다." }, 500);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    await act(async () => {
      resetStore({ auth: createAuthenticatedState() });
    });

    await expect(
      useMobileAppStore.getState().saveHost({
        label: "Broken push",
        hostname: "example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
      }),
    ).rejects.toThrow("서버 오류가 발생했습니다.");

    expect(useMobileAppStore.getState().hosts).toHaveLength(0);
  });

  it("preserves desktop-managed fields and identity when editing", async () => {
    const pushedPayloads: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        pushedPayloads.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    const existing = createExistingHost();
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [existing],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId: existing.id,
        label: "Renamed host",
        hostname: "new.example.com",
        port: 2200,
        username: "deploy",
        authType: "password",
        groupName: null,
      });
    });

    const pushedHost = decryptRecord<SshHostRecord>(
      pushedPayloads[0].hosts[0].encrypted_payload,
    );
    // 폼 필드는 갱신되고
    expect(pushedHost.label).toBe("Renamed host");
    expect(pushedHost.authType).toBe("password");
    expect(pushedHost.groupName).toBeNull();
    // 정체성과 데스크톱 관리 필드는 보존된다.
    expect(pushedHost.id).toBe(existing.id);
    expect(pushedHost.secretRef).toBe(existing.secretRef);
    expect(pushedHost.createdAt).toBe(existing.createdAt);
    expect(pushedHost.jumpHostIds).toEqual(["jump-1"]);
    expect(pushedHost.env).toEqual([{ key: "FOO", value: "bar" }]);
    expect(pushedHost.favorite).toBe(true);
    // 자격증명을 안 넣었으니 시크릿은 push 되지 않는다.
    expect(pushedPayloads[0].secrets).toHaveLength(0);

    expect(useMobileAppStore.getState().hosts[0].label).toBe("Renamed host");
  });

  it("replaces an existing host credential only when explicitly requested", async () => {
    const pushedPayloads: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/sync" && init?.method === "POST") {
        pushedPayloads.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch path: ${String(input)}`);
    });
    const existing = createExistingHost();
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-1",
      label: "Existing credentials",
      password: "old-password",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [existing],
        secretsByRef: { "secret-1": secret },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId: existing.id,
        label: existing.label,
        hostname: existing.hostname,
        port: existing.port,
        username: existing.username,
        authType: "password",
        credentialMode: "replace",
        credentials: { password: "new-password" },
      });
    });

    expect(pushedPayloads[0].secrets).toHaveLength(1);
    expect(
      decryptRecord<LoadedManagedSecretPayload>(
        pushedPayloads[0].secrets[0].encrypted_payload,
      ).password,
    ).toBe("new-password");
    expect(useMobileAppStore.getState().secretsByRef["secret-1"]?.password).toBe(
      "new-password",
    );
  });

  it("preserves leading and trailing whitespace in SSH passwords", async () => {
    let pushedPayload: SyncPayloadV2 | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/sync" && init?.method === "POST") {
        pushedPayload = JSON.parse(String(init.body)) as SyncPayloadV2;
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch path: ${String(input)}`);
    });
    await act(async () => {
      resetStore({ auth: createAuthenticatedState() });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        label: "Whitespace password",
        hostname: "example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        credentials: { password: "  secret with spaces  " },
      });
    });

    const secret = decryptRecord<LoadedManagedSecretPayload>(
      pushedPayload!.secrets[0].encrypted_payload,
    );
    expect(secret.password).toBe("  secret with spaces  ");
  });

  it("rejects preserving a credential after changing the authentication type", async () => {
    const existing = createExistingHost();
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [existing],
      });
    });

    await expect(
      useMobileAppStore.getState().saveHost({
        hostId: existing.id,
        label: existing.label,
        hostname: existing.hostname,
        port: existing.port,
        username: existing.username,
        authType: "privateKey",
        credentialMode: "preserve",
      }),
    ).rejects.toThrow("인증 방식을 변경할 때");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty replacement instead of silently unlinking the credential", async () => {
    const existing = createExistingHost();
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [existing],
      });
    });

    await expect(
      useMobileAppStore.getState().saveHost({
        hostId: existing.id,
        label: existing.label,
        hostname: existing.hostname,
        port: existing.port,
        username: existing.username,
        authType: "password",
        credentialMode: "replace",
      }),
    ).rejects.toThrow("교체할 자격 증명");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unlinks a credential from one host without deleting the shared secret", async () => {
    const pushedPayloads: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/sync" && init?.method === "POST") {
        pushedPayloads.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch path: ${String(input)}`);
    });
    const existing = createExistingHost();
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-1",
      label: "Shared credentials",
      password: "shared-password",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [existing],
        secretsByRef: { "secret-1": secret },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId: existing.id,
        label: existing.label,
        hostname: existing.hostname,
        port: existing.port,
        username: existing.username,
        authType: "password",
        credentialMode: "remove",
      });
    });

    const pushedHost = decryptRecord<SshHostRecord>(
      pushedPayloads[0].hosts[0].encrypted_payload,
    );
    expect(pushedHost.secretRef).toBeUndefined();
    expect(pushedPayloads[0].secrets).toHaveLength(0);
    const state = useMobileAppStore.getState();
    expect(state.secretsByRef["secret-1"]?.password).toBe("shared-password");
    expect(
      state.secretMetadata.find((entry) => entry.secretRef === "secret-1")
        ?.linkedHostCount,
    ).toBe(0);
  });

  it("deletes a host with a tombstone push and keeps the shared secret", async () => {
    const pushedPayloads: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        pushedPayloads.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });

    const existing = createExistingHost();
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-1",
      label: "Existing credentials",
      password: "hunter2",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        hosts: [existing],
        secretsByRef: { "secret-1": secret },
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().deleteHost(existing.id);
    });

    expect(pushedPayloads).toHaveLength(1);
    const tombstone = pushedPayloads[0].hosts[0];
    expect(tombstone.id).toBe(existing.id);
    expect(tombstone.encrypted_payload).toBe("");
    expect(tombstone.deleted_at).toBeTruthy();
    expect(tombstone.updated_at).toBe(tombstone.deleted_at);

    const state = useMobileAppStore.getState();
    expect(state.hosts).toHaveLength(0);
    // 시크릿은 남고 linkedHostCount 만 0 으로 갱신된다.
    expect(state.secretsByRef["secret-1"]).toBeDefined();
    expect(
      state.secretMetadata.find((entry) => entry.secretRef === "secret-1")
        ?.linkedHostCount,
    ).toBe(0);
  });

  it("refuses to save while unauthenticated", async () => {
    await expect(
      useMobileAppStore.getState().saveHost({
        label: "Nope",
        hostname: "example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
      }),
    ).rejects.toThrow("온라인 로그인 상태에서만 사용할 수 있습니다.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
