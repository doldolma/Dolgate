import { act } from "react-test-renderer";
import type {
  AuthSession,
  AuthState,
  LoadedManagedSecretPayload,
  SshHostRecord,
} from "@dolssh/shared-core";
import { resetSyncPushBatchBytes } from "@dolssh/shared-core";
import { Buffer } from "buffer";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from "../src/lib/mobile";
import type { SyncOutboxEntry } from "../src/lib/sync-outbox";
import {
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from "../src/store/useMobileAppStore";

/*
 * ④(2026-11-13) 모바일 대기열 올리기 — 묶음으로 나눠, 너무 큰 항목은 남겨 두고.
 *
 * 서버 앞의 리버스 프록시(nginx 기본 1MB)는 본문이 크면 서버에 닿기 전에 413 을 준다. 대기열이 크면(오프라인에서 많이
 * 고쳤을 때) 요청 하나가 그것을 넘어, 대기열이 통째로 못 올라갔다.
 */

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
const T1 = "2026-11-13T00:00:00.000Z";

function createAuthenticatedState(): AuthState {
  const session: AuthSession = {
    user: { id: "user-1", email: "batches@example.com" },
    tokens: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 900,
    },
    vaultBootstrap: { keyBase64: VAULT_KEY_BASE64 },
    offlineLease: {
      token: "offline-token",
      issuedAt: "2026-11-13T00:00:00.000Z",
      expiresAt: "2026-11-14T00:00:00.000Z",
      verificationPublicKeyPem: "public-key",
    },
    syncServerTime: "2026-11-13T00:00:00.000Z",
  };
  return { status: "authenticated", session, offline: null, errorMessage: null };
}

function response(body: unknown, status: number): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

function host(n: number, label = `bulk-${n}`): SshHostRecord {
  return {
    id: `host-${n}`,
    kind: "ssh",
    label,
    hostname: `10.60.0.${n % 250}`,
    port: 22,
    username: "ec2-user",
    authType: "password",
    secretRef: `secret-${n}`,
    groupName: null,
    createdAt: T1,
    updatedAt: T1,
  } as SshHostRecord;
}

function secret(n: number, password: string, updatedAt = T1): LoadedManagedSecretPayload {
  return { secretRef: `secret-${n}`, label: `bulk-${n} credentials`, password, updatedAt };
}

/** 본문이 limit 을 넘으면 413(HTML)을 주는 앞단 뒤의 서버. 받은 POST 를 적는다. */
function createServer(limit = 1024 * 1024) {
  const posts: Array<{ status: number; bytes: number; ids: string[] }> = [];
  const failures: number[] = [];
  let revision = 1;
  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/sync" && init?.method === "POST") {
      const body = String(init.body);
      const bytes = Buffer.byteLength(body);
      if (bytes > limit) {
        posts.push({ status: 413, bytes, ids: [] });
        return response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", 413);
      }
      const failure = failures.shift();
      if (failure) {
        posts.push({ status: failure, bytes, ids: [] });
        return response({ error: "서버 오류가 발생했습니다." }, failure);
      }
      const payload = JSON.parse(body) as Record<string, Array<{ id: string; deleted_at?: string }>>;
      const ids = Object.entries(payload).flatMap(([kind, records]) =>
        records.map(record => `${kind}:${record.id}${record.deleted_at ? "(지움)" : ""}`),
      );
      revision += 1;
      posts.push({ status: 202, bytes, ids });
      return response({ revision }, 202);
    }
    throw new Error(`unexpected fetch path: ${path}`);
  };
  const sentIds = () => posts.filter(post => post.status === 202).flatMap(post => post.ids);
  return { posts, failures, handle, sentIds };
}

function seed(input: {
  hosts: SshHostRecord[];
  secrets: LoadedManagedSecretPayload[];
  outbox: SyncOutboxEntry[];
}): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: createAuthenticatedState(),
    vault: { status: "legacy", epoch: 0, migrationRequired: false },
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    groups: [],
    hosts: input.hosts,
    awsProfiles: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    teamVaults: [],
    teamSecrets: {},
    secretsByRef: Object.fromEntries(input.secrets.map(item => [item.secretRef, item])),
    syncOutbox: input.outbox,
    syncOutboxFailure: null,
  });
}

function outboxFor(count: number): SyncOutboxEntry[] {
  return Array.from({ length: count }, (_, n) => [
    { kind: "hosts" as const, id: `host-${n}`, op: "upsert" as const },
    { kind: "secrets" as const, id: `secret-${n}`, op: "upsert" as const },
  ]).flat();
}

describe("mobile outbox push in batches", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    resetMobileStoreRuntimeForTests();
    resetSyncPushBatchBytes();
    fetchMock.mockReset();
  });

  afterEach(() => {
    resetMobileStoreRuntimeForTests();
  });

  it("uploads a queue bigger than the proxy limit in batches and empties it", async () => {
    const server = createServer();
    fetchMock.mockImplementation(server.handle);
    const count = 900;
    seed({
      hosts: Array.from({ length: count }, (_, n) => host(n)),
      secrets: Array.from({ length: count }, (_, n) => secret(n, `pw-${n}-${"x".repeat(1200)}`)),
      outbox: outboxFor(count),
    });

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    expect(server.posts.every(post => post.status === 202)).toBe(true);
    expect(server.posts.length).toBeGreaterThan(1);
    expect(Math.max(...server.posts.map(post => post.bytes))).toBeLessThanOrEqual(256 * 1024 + 1024);
    expect(new Set(server.sentIds()).size).toBe(count * 2);
    const state = useMobileAppStore.getState();
    expect(state.syncOutbox).toEqual([]);
    expect(state.syncOutboxFailure).toBeNull();
    expect(state.syncStatus.pendingPush).toBe(false);
  });

  it("keeps only what did not go in when a later batch fails, and never sends a record twice", async () => {
    const server = createServer();
    fetchMock.mockImplementation(server.handle);
    const count = 900;
    seed({
      hosts: Array.from({ length: count }, (_, n) => host(n)),
      secrets: Array.from({ length: count }, (_, n) => secret(n, `pw-${n}-${"x".repeat(1200)}`)),
      outbox: outboxFor(count),
    });
    // 첫 묶음은 들어가고 둘째 묶음에서 500.
    let posted = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST" && ++posted === 2) {
        server.failures.push(500);
      }
      return server.handle(input, init);
    });

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    const firstRound = server.sentIds();
    expect(firstRound.length).toBeGreaterThan(0);
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(count * 2 - firstRound.length);

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    const all = server.sentIds();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(count * 2);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });

  it("after a token refresh in the middle, sends only the batches that had not gone in", async () => {
    const server = createServer();
    const count = 900;
    seed({
      hosts: Array.from({ length: count }, (_, n) => host(n)),
      secrets: Array.from({ length: count }, (_, n) => secret(n, `pw-${n}-${"x".repeat(1200)}`)),
      outbox: outboxFor(count),
    });
    const refreshed = createAuthenticatedState().session as AuthSession;
    let posted = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/refresh") {
        return response(
          { ...refreshed, tokens: { accessToken: "access-2", refreshToken: "refresh-2", expiresInSeconds: 900 } },
          200,
        );
      }
      // 둘째 묶음에서 토큰이 만료됐다(401) — 갱신한 뒤 같은 회차가 이어 보낸다.
      if (path === "/sync" && init?.method === "POST" && ++posted === 2) {
        return response({ error: "로그인이 필요합니다." }, 401);
      }
      return server.handle(input, init);
    });

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    const all = server.sentIds();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(count * 2);
    expect(useMobileAppStore.getState().syncOutbox).toEqual([]);
  });

  it("leaves a record too large for the proxy in the queue, names it, does not resend it, and sends it once it shrinks", async () => {
    const server = createServer();
    fetchMock.mockImplementation(server.handle);
    seed({
      hosts: [host(0, "web-1"), host(1, "jump-box")],
      secrets: [secret(0, "short"), secret(1, "k".repeat(1_200_000))],
      outbox: outboxFor(2),
    });

    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });

    expect(server.sentIds().sort()).toEqual(["hosts:host-0", "hosts:host-1", "secrets:secret-0"]);
    expect(server.posts.filter(post => post.status === 413)).toHaveLength(1);
    let state = useMobileAppStore.getState();
    expect(state.syncOutbox).toEqual([{ kind: "secrets", id: "secret-1", op: "upsert" }]);
    expect(state.syncStatus.status).toBe("error");
    expect(state.syncStatus.errorMessage).toContain("bulk-1 credentials");
    expect(state.syncStatus.pendingPush).toBe(true);

    // 그대로면 다시 보내지 않는다.
    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });
    expect(server.posts.filter(post => post.status === 413)).toHaveLength(1);
    expect(useMobileAppStore.getState().syncOutbox).toHaveLength(1);

    // 줄이면(새 시각) 다시 간다.
    useMobileAppStore.setState(current => ({
      secretsByRef: {
        ...current.secretsByRef,
        "secret-1": secret(1, "now-short", "2026-11-13T01:00:00.000Z"),
      },
    }));
    await act(async () => {
      await useMobileAppStore.getState().flushSyncOutbox();
    });
    state = useMobileAppStore.getState();
    expect(server.sentIds()).toContain("secrets:secret-1");
    expect(state.syncOutbox).toEqual([]);
    expect(state.syncStatus.status).toBe("ready");
    expect(state.syncStatus.errorMessage).toBeNull();
  });
});
