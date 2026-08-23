import { act } from "react-test-renderer";
import { gcm } from "@noble/ciphers/aes.js";
import type {
  AuthSession,
  AuthState,
  GroupRecord,
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
    user: { id: "user-1", email: "groups@example.com" },
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

function createJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

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
  return JSON.parse(
    Buffer.from(gcm(key, iv).decrypt(sealed)).toString("utf8"),
  ) as T;
}

function group(path: string): GroupRecord {
  return {
    id: `group:${path}`,
    name: path.split("/").at(-1)!,
    path,
    parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function host(id: string, groupName: string | null): SshHostRecord {
  return {
    id,
    kind: "ssh",
    label: id,
    hostname: "example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    groupName,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function resetStore(overrides?: {
  auth?: AuthState;
  groups?: GroupRecord[];
  hosts?: SshHostRecord[];
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
    groups: overrides?.groups ?? [],
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
    secretsByRef: {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
  });
}

describe("useMobileAppStore group mutations", () => {
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

  function capturePushes(): SyncPayloadV2[] {
    const pushed: SyncPayloadV2[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sync" && init?.method === "POST") {
        pushed.push(JSON.parse(String(init.body)) as SyncPayloadV2);
        return createJsonResponse("", 202);
      }
      throw new Error(`unexpected fetch path: ${path}`);
    });
    return pushed;
  }

  // 그룹 이름은 호스트의 groupName(경로 문자열) 안에도 들어 있다. 그래서 이름을 바꾸면
  // 그 아래 호스트가 전부 다시 쓰이고, **한 번의 push 에 함께 실려야 한다** —
  // 나눠 보내면 중간에 실패했을 때 그룹만 바뀌고 호스트는 옛 경로에 남는다.
  it("renames a group and pushes the rewritten hosts in the same request", async () => {
    const pushed = capturePushes();
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        groups: [group("work"), group("work/aws")],
        hosts: [host("h1", "work/aws"), host("h2", "personal")],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().renameGroup("work", "office");
    });

    expect(pushed).toHaveLength(1);
    const payload = pushed[0]!;
    expect(
      payload.groups.map((record) =>
        decryptRecord<GroupRecord>(record.encrypted_payload).path,
      ).sort(),
    ).toEqual(["office", "office/aws"]);
    // 바뀐 호스트만 실린다 — 다른 그룹의 호스트까지 밀면 쓸데없이 커진다.
    expect(payload.hosts).toHaveLength(1);
    expect(
      decryptRecord<SshHostRecord>(payload.hosts[0]!.encrypted_payload).groupName,
    ).toBe("office/aws");

    expect(
      useMobileAppStore.getState().hosts.find((record) => record.id === "h1")
        ?.groupName,
    ).toBe("office/aws");
  });

  // push 가 실패하면 로컬도 그대로여야 한다. 폰만 바뀌면 되돌릴 방법이 없다.
  // 로컬 우선이다 — 서버가 죽어 있어도 이름은 바뀌고, 못 민 변경은 큐에 남는다.
  it("keeps the rename locally and queues it when the push fails", async () => {
    fetchMock.mockImplementation(async () => createJsonResponse("nope", 500));
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        groups: [group("work")],
        hosts: [host("h1", "work")],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().renameGroup("work", "office");
    });

    expect(useMobileAppStore.getState().groups[0]?.path).toBe("office");
    expect(useMobileAppStore.getState().hosts[0]?.groupName).toBe("office");
    expect(useMobileAppStore.getState().syncOutbox.length).toBeGreaterThan(0);
  });

  // 하위 항목까지 삭제하면 그룹과 호스트 모두 삭제 표식(deleted_at)으로 나가야 한다.
  it("marks both groups and hosts deleted when removing the whole subtree", async () => {
    const pushed = capturePushes();
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        groups: [group("work"), group("work/aws")],
        hosts: [host("h1", "work/aws"), host("h2", "personal")],
      });
    });

    await act(async () => {
      await useMobileAppStore.getState().removeGroup("work", "delete-subtree");
    });

    const payload = pushed[0]!;
    expect(payload.groups.every((record) => Boolean(record.deleted_at))).toBe(true);
    expect(payload.groups).toHaveLength(2);
    expect(payload.hosts).toHaveLength(1);
    expect(payload.hosts[0]?.deleted_at).toBeTruthy();

    expect(useMobileAppStore.getState().groups).toHaveLength(0);
    expect(useMobileAppStore.getState().hosts.map((record) => record.id)).toEqual([
      "h2",
    ]);
  });

  // 하위 항목 유지 = 한 단계 끌어올리기. 호스트는 하나도 지워지지 않는다.
  it("keeps every host when reparenting descendants", async () => {
    const pushed = capturePushes();
    await act(async () => {
      resetStore({
        auth: createAuthenticatedState(),
        groups: [group("work"), group("work/aws")],
        hosts: [host("h1", "work/aws")],
      });
    });

    await act(async () => {
      await useMobileAppStore
        .getState()
        .removeGroup("work", "reparent-descendants");
    });

    expect(pushed[0]!.hosts.every((record) => !record.deleted_at)).toBe(true);
    expect(useMobileAppStore.getState().hosts[0]?.groupName).toBe("aws");
    expect(
      useMobileAppStore.getState().groups.map((record) => record.path),
    ).toEqual(["aws"]);
  });

  // 로그아웃 상태에서도 편집된다. 서버에는 닿지 않고 큐에만 남는다.
  it("edits locally while signed out without touching the server", async () => {
    await act(async () => {
      resetStore({ groups: [group("work")], hosts: [host("h1", "work")] });
    });

    await act(async () => {
      await useMobileAppStore.getState().renameGroup("work", "office");
    });

    expect(useMobileAppStore.getState().groups[0]?.path).toBe("office");
    expect(useMobileAppStore.getState().syncOutbox.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
