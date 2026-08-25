import { act } from "react-test-renderer";
import { gcm } from "@noble/ciphers/aes.js";
import type {
  AuthSession,
  AuthState,
  LoadedManagedSecretPayload,
  SshHostRecord,
  SyncPayloadV2,
} from "@dolssh/shared-core";
import { isSshHostRecord, normalizeJumpHostIds } from "@dolssh/shared-core";
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
    startupCommand: { type: "command", command: "cd /srv" },
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
    pendingCredentialRetry: null,
    syncOutbox: [],
    syncOutboxFailure: null,
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

  // 인증서 인증은 개인 키와 인증서를 한 시크릿에 함께 담아야 한다 — 엔진이 둘을 같이 받는다.
  it("stores a certificate credential with its private key", async () => {
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
        label: "Cert host",
        hostname: "cert.example.com",
        port: 22,
        username: "ubuntu",
        authType: "certificate",
        credentials: {
          privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----",
          certificateText: "ssh-ed25519-cert-v01@openssh.com AAAA",
          passphrase: "pass",
        },
      });
    });

    const payload = pushedPayloads[0];
    const pushedHost = decryptRecord<SshHostRecord>(
      payload.hosts[0].encrypted_payload,
    );
    expect(pushedHost.authType).toBe("certificate");
    const pushedSecret = decryptRecord<LoadedManagedSecretPayload>(
      payload.secrets[0].encrypted_payload,
    );
    expect(pushedSecret.privateKeyPem).toBe(
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    );
    expect(pushedSecret.certificateText).toBe(
      "ssh-ed25519-cert-v01@openssh.com AAAA",
    );
    expect(pushedSecret.passphrase).toBe("pass");
    expect(
      useMobileAppStore
        .getState()
        .secretMetadata.find(
          (entry) => entry.secretRef === pushedHost.secretRef,
        )?.hasCertificate,
    ).toBe(true);
  });

  // 인증서 없이 개인 키만 오면 자격 증명이 성립하지 않는다 — 반쪽 시크릿을 만들지 않는다.
  it("rejects a certificate credential that is missing the certificate", async () => {
    await act(async () => {
      resetStore({ auth: createAuthenticatedState() });
    });

    await expect(
      useMobileAppStore.getState().saveHost({
        hostId: undefined,
        label: "Cert host",
        hostname: "cert.example.com",
        port: 22,
        username: "ubuntu",
        authType: "certificate",
        credentialMode: "replace",
        credentials: {
          privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----",
        },
      }),
    ).rejects.toThrow();
    expect(useMobileAppStore.getState().hosts).toHaveLength(0);
  });

  // 쓰기는 로컬 우선이다 — 서버가 죽어 있어도 호스트는 저장되고, 못 민 변경은 아웃박스에
  // 남아 다음 기회에 나간다. 예전에는 push 가 실패하면 로컬도 안 바뀌어 오프라인에서
  // 아무것도 할 수 없었다.
  it("keeps the local change and queues it when the push fails", async () => {
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

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        label: "Broken push",
        hostname: "example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
      });
    });

    expect(useMobileAppStore.getState().hosts).toHaveLength(1);
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(1);
    expect(useMobileAppStore.getState().syncStatus.pendingPush).toBe(true);
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
    // 필드를 생략하면 보존이다. undefined 를 그대로 쓰면 직렬화에서 키가 빠져 지워진다.
    expect(pushedHost.startupCommand).toEqual({
      type: "command",
      command: "cd /srv",
    });
    // 자격증명을 안 넣었으니 시크릿은 push 되지 않는다.
    expect(pushedPayloads[0].secrets).toHaveLength(0);

    expect(useMobileAppStore.getState().hosts[0].label).toBe("Renamed host");
  });

  // 읽는 쪽(normalizeJumpHostIds)은 배열이 비면 레거시 jumpHostId 로 폴백한다. 배열만 비우면
  // 방금 지운 홉을 계속 경유하고, 데스크톱이 그것을 배열로 되살려 모든 기기에 되밀었다.
  it("clears the legacy jumpHostId mirror when the chain is emptied", async () => {
    const existing: SshHostRecord = {
      ...createExistingHost(),
      jumpHostIds: ["jump-1"],
      jumpHostId: "jump-1",
    } as SshHostRecord;
    await act(async () => {
      resetStore({ hosts: [existing] });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId: existing.id,
        label: existing.label,
        hostname: existing.hostname,
        port: existing.port,
        username: existing.username,
        authType: "password",
        groupName: existing.groupName,
        jumpHostIds: null,
      });
    });

    const saved = useMobileAppStore.getState().hosts[0] as SshHostRecord & {
      jumpHostId?: string | null;
    };
    expect(saved.jumpHostIds).toBeNull();
    expect(saved.jumpHostId).toBeNull();
    expect(
      normalizeJumpHostIds(saved.jumpHostIds, saved.jumpHostId),
    ).toEqual([]);
  });

  // 반대 방향도 맞아야 한다 — 첫 홉이 미러에 들어가야 옛 클라이언트가 같은 경로를 쓴다.
  it("mirrors the first hop into the legacy jumpHostId field", async () => {
    const existing = createExistingHost();
    await act(async () => {
      resetStore({ hosts: [existing] });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId: existing.id,
        label: existing.label,
        hostname: existing.hostname,
        port: existing.port,
        username: existing.username,
        authType: "password",
        groupName: existing.groupName,
        jumpHostIds: ["jump-2", "jump-3"],
      });
    });

    const saved = useMobileAppStore.getState().hosts[0] as SshHostRecord & {
      jumpHostId?: string | null;
    };
    expect(saved.jumpHostIds).toEqual(["jump-2", "jump-3"]);
    expect(saved.jumpHostId).toBe("jump-2");
  });

  // 화면이 종류 칸을 막는 것은 UI 뿐이다 — 폼을 열어 둔 사이 서버 판정이 떨어지거나 라우트로
  // 종류가 들어오면 그대로 저장됐다. 이 레코드는 같은 계정의 옛 클라이언트가 받아 조용히
  // 망가지므로 저장 자리에서 한 번 더 본다.
  it("rejects creating an RDP host when the server cannot judge the data floor", async () => {
    await act(async () => {
      resetStore();
    });
    useMobileAppStore.setState(state => ({
      syncStatus: {
        ...state.syncStatus,
        dataFloorServerSupport: "unsupported",
      },
    }));

    await expect(
      useMobileAppStore.getState().saveRemoteDesktopHost({
        kind: "rdp",
        label: "Office PC",
        hostname: "pc.example.com",
        port: 3389,
        credentialMode: "replace",
        credentials: { username: "Administrator", password: "hunter2" },
      }),
    ).rejects.toThrow();
    expect(useMobileAppStore.getState().hosts).toHaveLength(0);
  });

  // 고치는 것은 막지 않는다 — 다른 기기에서 만들어 동기화된 호스트를 손볼 길이 없어진다.
  it("still edits an existing RDP host on a server without the data floor", async () => {
    const existing = {
      id: "rdp-1",
      kind: "rdp",
      label: "Office PC",
      hostname: "10.0.0.5",
      port: 3389,
      secretRef: null,
      groupName: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    } as unknown as SshHostRecord;
    await act(async () => {
      resetStore({ hosts: [existing] });
    });
    useMobileAppStore.setState(state => ({
      syncStatus: {
        ...state.syncStatus,
        dataFloorServerSupport: "unsupported",
      },
    }));

    await act(async () => {
      await useMobileAppStore.getState().saveRemoteDesktopHost({
        hostId: existing.id,
        kind: "rdp",
        label: "Renamed",
        hostname: existing.hostname,
        port: existing.port,
      });
    });

    expect(useMobileAppStore.getState().hosts[0].label).toBe("Renamed");
  });

  // 비운 것과 안 보낸 것을 같게 다루면, 도메인을 지우고 저장해도 옛 값이 되살아난다 —
  // 폼은 저장됐다고 말하는데 로그인은 계속 그 도메인으로 나간다.
  it("clears the RDP domain when the field is emptied", async () => {
    const existing = {
      id: "rdp-1",
      kind: "rdp",
      label: "Office PC",
      hostname: "10.0.0.5",
      port: 3389,
      secretRef: "secret-rdp",
      groupName: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    } as unknown as SshHostRecord;
    const secret: LoadedManagedSecretPayload = {
      secretRef: "secret-rdp",
      label: "Office PC credentials",
      username: "Administrator",
      domain: "CORP",
      password: "hunter2",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    await act(async () => {
      resetStore({ hosts: [existing], secretsByRef: { "secret-rdp": secret } });
    });

    await act(async () => {
      await useMobileAppStore.getState().saveRemoteDesktopHost({
        hostId: existing.id,
        kind: "rdp",
        label: existing.label,
        hostname: existing.hostname,
        port: existing.port,
        credentialMode: "replace",
        credentials: { username: "Administrator", domain: "", password: "" },
      });
    });

    const saved = useMobileAppStore.getState().secretsByRef["secret-rdp"];
    expect(saved?.domain).toBeUndefined();
    // 손대지 않은 것은 그대로다 — 지운 것은 도메인뿐이다.
    expect(saved?.username).toBe("Administrator");
    expect(saved?.password).toBe("hunter2");
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

  // 로그아웃 상태에서도 저장된다. 서버로 밀 수 없을 뿐이라 큐에 남고, 로그인하면 나간다.
  it("saves locally while signed out and queues the push", async () => {
    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        label: "Offline",
        hostname: "example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
      });
    });

    expect(useMobileAppStore.getState().hosts).toHaveLength(1);
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(1);
    // 세션이 없으니 서버에 닿지도 않는다.
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sets and clears the startup command", async () => {
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
      resetStore({ auth: createAuthenticatedState(), hosts: [existing] });
    });

    const base = {
      hostId: existing.id,
      label: "Existing host",
      hostname: "old.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password" as const,
      groupName: "work",
    };

    // 스니펫으로 바꾼다.
    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        ...base,
        startupCommand: { type: "snippet", snippetId: "snippet-1" },
      });
    });
    expect(
      decryptRecord<SshHostRecord>(pushedPayloads[0].hosts[0].encrypted_payload)
        .startupCommand,
    ).toEqual({ type: "snippet", snippetId: "snippet-1" });

    // null 은 해제다 — 보존(생략)과 구분돼야 한다.
    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        ...base,
        startupCommand: null,
      });
    });
    expect(
      decryptRecord<SshHostRecord>(pushedPayloads[1].hosts[0].encrypted_payload)
        .startupCommand,
    ).toBeNull();
  });

  it("rejects a startup command over the length limit", async () => {
    await act(async () => {
      resetStore({ auth: createAuthenticatedState() });
    });

    await expect(
      useMobileAppStore.getState().saveHost({
        label: "Host",
        hostname: "example.com",
        port: 22,
        username: "root",
        authType: "password",
        startupCommand: {
          type: "command",
          command: "x".repeat(32 * 1024 + 1),
        },
      }),
    ).rejects.toThrow();
  });
  // ── 인증 실패 재시도 ────────────────────────────────────────────────────────
  // 데스크톱 CredentialRetryDialog 와 같은 자리다. 여기서 고친 사용자명은 호스트에 남고,
  // 다시 넣은 비밀은 **저장된 값을 덮어** 다음 연결에 쓰인다.

  it("saves the corrected username and retries with the new credentials", async () => {
    const resumeSession = jest.fn(async () => "session-1");
    resetStore({
      auth: createAuthenticatedState(),
      hosts: [createExistingHost()],
      secretsByRef: {
        "secret-1": {
          secretRef: "secret-1",
          label: "Existing host",
          updatedAt: "2026-07-01T00:00:00.000Z",
          password: "stale-password",
        },
      },
    });
    useMobileAppStore.setState({
      resumeSession,
      pendingCredentialRetry: {
        hostId: "host-1",
        hostLabel: "Existing host",
        target: { kind: "terminal", recordId: "session-1" },
        authType: "password",
        message: "인증에 실패했습니다.",
        initialUsername: "ubuntu",
      },
    });

    await act(async () => {
      await useMobileAppStore
        .getState()
        .submitCredentialRetry({ username: "  admin  ", password: "fresh" });
    });

    const host = useMobileAppStore
      .getState()
      .hosts.find((item) => item.id === "host-1");
    expect(host).toMatchObject({ username: "admin" });
    // 로컬 우선 + 아웃박스 — 로그인·네트워크 없이도 고쳐져야 한다.
    expect(useMobileAppStore.getState().syncOutbox).toContainEqual(
      expect.objectContaining({ kind: "hosts", id: "host-1", op: "upsert" }),
    );

    // 저장된(틀린) 비밀번호가 아니라 방금 넣은 것으로 다시 붙는다. 이 덮어쓰기가 없으면
    // 서버에서 비번을 바꾼 호스트는 모바일에서 영영 못 고친다.
    expect(resumeSession).toHaveBeenCalledWith("session-1", {
      credentialOverride: expect.objectContaining({ password: "fresh" }),
    });
    expect(useMobileAppStore.getState().pendingCredentialRetry).toBeNull();

    // 비밀은 아직 저장하지 않는다 — 연결이 성공해야 저장한다.
    expect(
      useMobileAppStore.getState().secretsByRef["secret-1"]?.password,
    ).toBe("stale-password");
  });

  it("keeps the window open when the username is blank", async () => {
    const resumeSession = jest.fn(async () => null);
    resetStore({
      auth: createAuthenticatedState(),
      hosts: [createExistingHost()],
    });
    const pending = {
      hostId: "host-1",
      hostLabel: "Existing host",
      target: { kind: "terminal" as const, recordId: "session-1" },
      authType: "password" as const,
      message: null,
      initialUsername: "ubuntu",
    };
    useMobileAppStore.setState({ resumeSession, pendingCredentialRetry: pending });

    await act(async () => {
      await expect(
        useMobileAppStore
          .getState()
          .submitCredentialRetry({ username: "   ", password: "fresh" }),
      ).rejects.toThrow();
    });

    expect(resumeSession).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().pendingCredentialRetry).toEqual(pending);
  });

  it("leaves the username alone when it did not change", async () => {
    const resumeSession = jest.fn(async () => "session-1");
    resetStore({
      auth: createAuthenticatedState(),
      hosts: [createExistingHost()],
    });
    useMobileAppStore.setState({
      resumeSession,
      syncOutbox: [],
      pendingCredentialRetry: {
        hostId: "host-1",
        hostLabel: "Existing host",
        target: { kind: "terminal", recordId: "session-1" },
        authType: "password",
        message: null,
        initialUsername: "ubuntu",
      },
    });

    await act(async () => {
      await useMobileAppStore
        .getState()
        .submitCredentialRetry({ username: "ubuntu", password: "fresh" });
    });

    // 비밀번호만 고친 경우다. 호스트를 건드리지 않아야 updatedAt 이 튀지 않고, 아웃박스에도
    // 올릴 것이 없다.
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
    expect(
      useMobileAppStore.getState().hosts.find((item) => item.id === "host-1")
        ?.updatedAt,
    ).toBe("2026-07-01T00:00:00.000Z");
    expect(resumeSession).toHaveBeenCalled();
  });
  it("saves a username corrected in the pre-connect window", async () => {
    resetStore({
      auth: createAuthenticatedState(),
      hosts: [createExistingHost()],
    });
    useMobileAppStore.setState({
      syncOutbox: [],
      pendingCredentialPrompt: {
        hostId: "host-1",
        hostLabel: "Existing host",
        authType: "password",
        message: null,
        initialValue: {},
        initialUsername: "ubuntu",
      },
    });

    await act(async () => {
      await useMobileAppStore
        .getState()
        .submitCredentialPrompt({ username: "admin", password: "fresh" });
    });

    // 이 창에서 고친 사용자명도 호스트에 남아야 한다 — 안 그러면 붙어 보고 실패할 때까지
    // 기다렸다 재시도 창에서 다시 고쳐야 한다.
    expect(
      useMobileAppStore.getState().hosts.find((item) => item.id === "host-1"),
    ).toMatchObject({ username: "admin" });
    expect(useMobileAppStore.getState().syncOutbox).toContainEqual(
      expect.objectContaining({ kind: "hosts", id: "host-1", op: "upsert" }),
    );
    expect(useMobileAppStore.getState().pendingCredentialPrompt).toBeNull();
  });

  it("rejects a blank username in the pre-connect window", async () => {
    resetStore({
      auth: createAuthenticatedState(),
      hosts: [createExistingHost()],
    });
    const prompt = {
      hostId: "host-1",
      hostLabel: "Existing host",
      authType: "password" as const,
      message: null,
      initialValue: {},
      initialUsername: "ubuntu",
    };
    useMobileAppStore.setState({ pendingCredentialPrompt: prompt });

    await act(async () => {
      await expect(
        useMobileAppStore
          .getState()
          .submitCredentialPrompt({ username: "  ", password: "fresh" }),
      ).rejects.toThrow();
    });

    expect(useMobileAppStore.getState().pendingCredentialPrompt).toEqual(prompt);
  });
  it("does not push before the keychain secrets are restored", async () => {
    // 비밀은 앱 시작 후 뒤늦게 복원된다. 그 전에 밀면 secrets 항목이 보낼 것을 못 찾아
    // 큐에서 조용히 빠지고, 호스트만 올라가고 **비밀번호는 영영 안 올라간다.**
    const pushed: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        pushed.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    resetStore({
      auth: createAuthenticatedState(),
      hosts: [createExistingHost()],
    });
    useMobileAppStore.setState({
      secureStateReady: false,
      secretsByRef: {},
      syncOutbox: [
        { kind: "hosts", id: "host-1", op: "upsert" },
        { kind: "secrets", id: "secret-1", op: "upsert" },
      ],
    });

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    // 아무것도 밀지 않고, 큐를 그대로 둔다.
    expect(pushed).toHaveLength(0);
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(2);

    // 복원이 끝나면 그때 함께 올라간다.
    useMobileAppStore.setState({
      secureStateReady: true,
      secretsByRef: {
        "secret-1": {
          secretRef: "secret-1",
          label: "Existing host",
          updatedAt: "2026-07-01T00:00:00.000Z",
          password: "hunter2",
        },
      },
    });
    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.secrets).toHaveLength(1);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });
  it("retries the keychain restore instead of stalling sync forever", async () => {
    // 비밀 복원이 실패하면 secureStateReady 가 false 로 남고, 그동안은 큐를 밀지 않는다
    // (비밀 값 없이 밀면 secrets 항목이 버려져 비밀번호가 사라진다). 그대로 두면 앱을 껐다
    // 켜기 전까지 동기화가 멈춘 채이므로, 포그라운드 복귀 때 다시 시도해 스스로 풀린다.
    const pushed: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        pushed.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    resetStore({
      auth: createAuthenticatedState(),
      hosts: [createExistingHost()],
    });
    useMobileAppStore.setState({
      secureStateReady: false,
      syncOutbox: [{ kind: "hosts", id: "host-1", op: "upsert" }],
    });

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });
    expect(pushed).toHaveLength(0);

    // 복원 재시도가 성공하면 secureStateReady 가 켜지고, 그때부터 큐가 나간다.
    await act(async () => {
      useMobileAppStore.getState().ensureSecureStateRestored();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useMobileAppStore.getState().secureStateReady).toBe(true);

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });
    expect(pushed).toHaveLength(1);
  });
  it("uploads the password created while offline once the network returns", async () => {
    // 오프라인에서 만든 자격증명이 나중에 실제로 서버로 나가는지 — 호스트만 올라가고
    // 비밀 본문이 빠지면 다른 기기에서 연결이 안 된다.
    const pushed: SyncPayloadV2[] = [];
    let online = false;
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        if (!online) {
          throw new Error("offline");
        }
        pushed.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    resetStore({ auth: createAuthenticatedState() });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        label: "Offline host",
        hostname: "offline.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        groupName: null,
        credentials: { password: "hunter2" },
      });
    });

    // 로컬에는 비밀이 들어갔고, 큐에는 호스트와 비밀이 함께 대기한다.
    const created = useMobileAppStore
      .getState()
      .hosts.filter(isSshHostRecord)
      .find((host) => host.hostname === "offline.example.com");
    expect(created?.secretRef).toBeTruthy();
    expect(
      useMobileAppStore.getState().secretsByRef[created!.secretRef!]?.password,
    ).toBe("hunter2");
    expect(
      useMobileAppStore
        .getState()
        .syncOutbox.map((entry) => entry.kind)
        .sort(),
    ).toEqual(["hosts", "secrets"]);

    online = true;
    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.hosts).toHaveLength(1);
    // 비밀 본문이 함께 올라가야 한다.
    expect(pushed[0]!.secrets).toHaveLength(1);
    expect(
      decryptRecord<{ password?: string }>(
        pushed[0]!.secrets[0]!.encrypted_payload,
      ).password,
    ).toBe("hunter2");
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });
  it("uploads a credential added to an existing host while offline", async () => {
    // 이미 있던 호스트에 오프라인에서 자격증명을 붙인 경우. 호스트만 올라가고 비밀 본문이
    // 빠지면, 다른 기기에는 "자격증명이 달린 호스트" 만 생기고 실제 비밀번호는 없다.
    const pushed: SyncPayloadV2[] = [];
    let online = false;
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        if (!online) {
          throw new Error("offline");
        }
        pushed.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const bare: SshHostRecord = {
      ...createExistingHost(),
      secretRef: null,
      jumpHostIds: undefined,
      env: undefined,
      startupCommand: undefined,
    };
    resetStore({ auth: createAuthenticatedState(), hosts: [bare] });

    await act(async () => {
      await useMobileAppStore.getState().saveHost({
        hostId: bare.id,
        label: bare.label,
        hostname: bare.hostname,
        port: bare.port,
        username: bare.username,
        authType: "password",
        groupName: bare.groupName,
        credentials: { password: "hunter2" },
      });
    });

    const updated = useMobileAppStore
      .getState()
      .hosts.filter(isSshHostRecord)
      .find((host) => host.id === bare.id);
    expect(updated?.secretRef).toBeTruthy();

    online = true;
    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.secrets).toHaveLength(1);
    expect(
      decryptRecord<{ password?: string }>(
        pushed[0]!.secrets[0]!.encrypted_payload,
      ).password,
    ).toBe("hunter2");
  });
});
