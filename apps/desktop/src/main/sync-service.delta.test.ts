import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord, ManagedSecretPayload, SnippetRecord, SyncRecord } from "@shared";
import type { AuthSyncContext } from "./auth-service";

/*
 * ④(11-13) 데스크톱 개인 올리기 — 바뀐 것만, 묶음으로 나눠, 너무 큰 레코드는 빼고.
 *
 * 실제 저장소(HostRepository 등)와 실제 상태 파일에 붙이고, 서버는 services/sync-api 의 규칙을 그대로 흉내 낸다:
 * 레코드마다 시각이 늦은 쪽이 이기고(같은 시각이면 내용이 다를 때만 쓴다), 요청 하나에 실제로 쓴 것이 있으면 리비전이
 * 하나 오른다. 앞단(nginx)처럼 본문이 한도를 넘으면 서버에 닿기 전에 413(HTML)을 준다.
 */

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => (name === "userData" ? tempDir : os.tmpdir())),
    getVersion: vi.fn(() => "1.9.0-test"),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
  },
}));

const CONTEXT: AuthSyncContext = {
  userId: "user-1",
  serverUrl: "https://sync.example.com/",
  accessToken: "access-1",
  vaultKeyBase64: Buffer.alloc(32, 7).toString("base64"),
  vaultEpoch: 1,
};

const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T00:00:00.000Z";
const T2 = "2026-11-03T00:00:00.000Z";

function host(id: string, updatedAt: string, extra: Record<string, unknown> = {}): HostRecord {
  return {
    id,
    kind: "ssh",
    label: id,
    hostname: "10.0.0.1",
    port: 22,
    username: "ec2-user",
    authType: "password",
    secretRef: null,
    groupName: null,
    tags: [],
    createdAt: T0,
    updatedAt,
    ...extra,
  } as unknown as HostRecord;
}

function secret(ref: string, updatedAt: string, password = `pw-${ref}`): ManagedSecretPayload {
  return { secretRef: ref, label: `${ref} 비밀번호`, password, updatedAt } as ManagedSecretPayload;
}

function snippet(id: string, updatedAt: string, command: string): SnippetRecord {
  return { id, label: id, command, keyword: null, createdAt: T0, updatedAt };
}

interface PostLog {
  status: number;
  bytes: number;
  /** `종류:id` — 지움은 뒤에 `(지움)`. */
  ids: string[];
}

/** services/sync-api 의 /sync 를 흉내 낸다. */
function createServer(keyBase64: string, encode: (plaintext: string, key: string) => string) {
  const records = new Map<string, Map<string, SyncRecord>>();
  const server = {
    revision: 0,
    /** 앞단 본문 한도(바이트). 넘으면 413. */
    limit: Number.POSITIVE_INFINITY,
    /** 다음 POST 들을 이 상태로 실패시킨다(앞에서부터 하나씩). */
    failPosts: [] as number[],
    posts: [] as PostLog[],
    gets: [] as Array<{ inm: string | null; status: number }>,
    /** 다른 기기가 올린 것처럼 넣는다(리비전 +1). */
    put(kind: string, id: string, value: unknown, updatedAt: string) {
      const bucket = records.get(kind) ?? new Map<string, SyncRecord>();
      records.set(kind, bucket);
      bucket.set(id, { id, encrypted_payload: encode(JSON.stringify(value), keyBase64), updated_at: updatedAt });
      server.revision += 1;
    },
    remove(kind: string, id: string, deletedAt: string) {
      const bucket = records.get(kind) ?? new Map<string, SyncRecord>();
      records.set(kind, bucket);
      bucket.set(id, { id, encrypted_payload: "", updated_at: deletedAt, deleted_at: deletedAt });
      server.revision += 1;
    },
    /** 서버가 데이터를 잃었다(지움 기록도 없이 비었다). */
    wipe() {
      records.clear();
      server.revision += 1;
    },
    get(kind: string, id: string): SyncRecord | undefined {
      return records.get(kind)?.get(id);
    },
    ids(kind: string): string[] {
      return [...(records.get(kind)?.values() ?? [])].filter((item) => !item.deleted_at).map((item) => item.id).sort();
    },
    /** 올린 레코드(`종류:id`)를 모두 — 성공한 POST 만. */
    pushedIds(): string[] {
      return server.posts.filter((post) => post.status === 202).flatMap((post) => post.ids);
    },
    fetch: vi.fn(async (input: URL | string, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
      if (url.pathname === "/api/info") {
        return json(200, {
          serverVersion: "test",
          capabilities: { sync: { awsProfiles: true, watch: true, dataFloor: true }, vault: { e2ee: true }, auth: { webauthn: false } },
        });
      }
      if (url.pathname === "/sync" && method === "GET") {
        const etag = `"${server.revision}"`;
        const inm = new Headers(init?.headers).get("If-None-Match");
        if (inm && inm.replace(/^W\//, "") === etag) {
          server.gets.push({ inm, status: 304 });
          return new Response(null, { status: 304, headers: { etag } });
        }
        server.gets.push({ inm, status: 200 });
        const payload: Record<string, SyncRecord[]> = {};
        for (const [kind, bucket] of records) {
          payload[kind] = [...bucket.values()];
        }
        return json(200, payload, { etag });
      }
      if (url.pathname === "/sync" && method === "POST") {
        const body = String(init?.body ?? "");
        const bytes = Buffer.byteLength(body);
        if (bytes > server.limit) {
          server.posts.push({ status: 413, bytes, ids: [] });
          return new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", {
            status: 413,
            headers: { "content-type": "text/html" },
          });
        }
        const failure = server.failPosts.shift();
        if (failure) {
          server.posts.push({ status: failure, bytes, ids: [] });
          return json(failure, { error: "잠깐 실패" });
        }
        const payload = JSON.parse(body) as Record<string, SyncRecord[]>;
        const ids: string[] = [];
        let written = 0;
        for (const [kind, incoming] of Object.entries(payload)) {
          const bucket = records.get(kind) ?? new Map<string, SyncRecord>();
          records.set(kind, bucket);
          for (const record of incoming) {
            ids.push(`${kind}:${record.id}${record.deleted_at ? "(지움)" : ""}`);
            const current = bucket.get(record.id);
            if (current) {
              const currentAt = Date.parse(current.updated_at);
              const incomingAt = Date.parse(record.updated_at);
              if (currentAt > incomingAt) {
                continue;
              }
              if (
                currentAt === incomingAt &&
                current.encrypted_payload === record.encrypted_payload &&
                (current.deleted_at ?? null) === (record.deleted_at ?? null)
              ) {
                continue;
              }
            }
            bucket.set(record.id, { ...record });
            written += 1;
          }
        }
        if (written > 0) {
          server.revision += 1;
        }
        server.posts.push({ status: 202, bytes, ids });
        return json(202, { revision: server.revision });
      }
      throw new Error(`예상하지 않은 요청 ${method} ${url.pathname}`);
    }),
  };
  return server;
}

async function createHarness() {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const stateStorageModule = await import("./state-storage");
  stateStorageModule.resetDesktopStateStorageForTests();
  const syncModule = await import("./sync-service");
  const db = await import("./database");
  const secretStoreModule = await import("./secret-store");
  const storage = stateStorageModule.getDesktopStateStorage();

  const authService = {
    captureSyncContext: vi.fn(() => ({ ...CONTEXT })),
    isSyncContextCurrent: vi.fn(() => true),
    getState: vi.fn(() => ({ status: "authenticated" })),
    isVaultReadyForSync: vi.fn(() => true),
    getClientIdentificationHeaders: vi.fn(() => ({})),
    getAccessToken: vi.fn(() => CONTEXT.accessToken),
    refreshSession: vi.fn(),
    handleVaultDekRejected: vi.fn(),
    getVaultStatus: vi.fn(() => "unlocked"),
    noteServerVaultSupport: vi.fn(),
    noteServerWebauthnSupport: vi.fn(),
    noteServerDataFloorSupport: vi.fn(),
  };
  const repos = {
    hosts: new db.HostRepository(),
    groups: new db.GroupRepository(),
    portForwards: new db.PortForwardRepository(),
    dnsOverrides: new db.DnsOverrideRepository(),
    snippets: new db.SnippetRepository(),
    knownHosts: new db.KnownHostRepository(),
    secretMetadata: new db.SecretMetadataRepository(),
    awsProfiles: new db.AwsProfileRepository(),
    settings: new db.SettingsRepository(),
    outbox: new db.SyncOutboxRepository(),
    tailnets: new db.TailnetRepository(),
    workspaces: new db.SavedWorkspaceRepository(),
  };
  const service = new syncModule.SyncService(
    authService as never,
    repos.hosts,
    repos.groups,
    repos.portForwards,
    repos.dnsOverrides,
    repos.snippets,
    repos.knownHosts,
    repos.secretMetadata,
    repos.awsProfiles,
    repos.settings,
    new secretStoreModule.SecretStore(),
    repos.outbox,
    repos.tailnets,
    repos.workspaces,
  );
  const server = createServer(CONTEXT.vaultKeyBase64, syncModule.encodeEncryptedPayload);
  vi.stubGlobal("fetch", server.fetch);

  /** 로컬 상태를 바로 채운다(받기가 적용하는 모양 그대로). */
  const seed = (input: { hosts?: HostRecord[]; secrets?: ManagedSecretPayload[]; snippets?: SnippetRecord[] }) => {
    storage.updateState((state) => {
      if (input.hosts) state.data.hosts = input.hosts;
      if (input.snippets) state.data.snippets = input.snippets;
      if (input.secrets) {
        state.data.secretMetadata = input.secrets.map(syncModule.secretMetadataFromSyncedSecret);
        state.secure.managedSecretsByRef = Object.fromEntries(
          input.secrets.map((item) => [item.secretRef, secretStoreModule.encodeSecretForStorage(JSON.stringify(item))]),
        );
      }
    });
  };
  /** 로컬 앱 설정(터미널 테마) 레코드를 서버에도 같게 둔다 — 시험이 호스트·비밀값만 보게. */
  const seedServerPreferences = () => {
    const preferences = repos.settings.getSyncedTerminalPreferences();
    server.put("preferences", preferences.id, preferences, preferences.updatedAt);
  };
  return { service, storage, repos, server, seed, seedServerPreferences, syncModule };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolssh-sync-delta-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("syncContentFingerprint", () => {
  it("does not depend on key order and drops undefined fields like JSON does", async () => {
    vi.resetModules();
    const { syncContentFingerprint } = await import("./sync-service");
    expect(syncContentFingerprint({ a: 1, b: { c: [1, 2], d: null } })).toBe(
      syncContentFingerprint({ b: { d: null, c: [1, 2] }, a: 1, e: undefined }),
    );
    expect(syncContentFingerprint({ a: 1 })).not.toBe(syncContentFingerprint({ a: 2 }));
    expect(syncContentFingerprint({ list: [1, 2] })).not.toBe(syncContentFingerprint({ list: [2, 1] }));
  });
});

describe("SyncService personal push — only what differs from the server copy", () => {
  it("pushes records missing on the server, newer than it, or same time with other content — not older or equal ones", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    // 서버: 같은 것, 서버가 더 새것, 같은 시각 다른 내용, 서버가 더 옛것.
    harness.server.put("hosts", "h-same", host("h-same", T1), T1);
    harness.server.put("hosts", "h-server-newer", host("h-server-newer", T2, { hostname: "server" }), T2);
    harness.server.put("hosts", "h-same-time", host("h-same-time", T1, { hostname: "server" }), T1);
    harness.server.put("hosts", "h-local-newer", host("h-local-newer", T0), T0);
    harness.seed({
      hosts: [
        host("h-same", T1),
        host("h-server-newer", T1, { hostname: "local-old" }),
        host("h-same-time", T1, { hostname: "local" }),
        host("h-local-newer", T2, { hostname: "local-new" }),
        host("h-new", T1),
      ],
    });

    harness.service.markLocalChangesPendingPush();
    await harness.service.bootstrap();

    expect(harness.server.pushedIds().sort()).toEqual(["hosts:h-local-newer", "hosts:h-new", "hosts:h-same-time"]);
    expect(harness.service.getState()).toMatchObject({ status: "ready", pendingPush: false, errorMessage: null });
    // 받은 뒤 로컬은 서버와 같다 — 서버가 더 새것이던 것은 서버 것으로.
    const local = Object.fromEntries(
      harness.repos.hosts.list().map((item) => [item.id, (item as { hostname?: string }).hostname]),
    );
    expect(local).toEqual({
      "h-same": "10.0.0.1",
      "h-server-newer": "server",
      "h-same-time": "local",
      "h-local-newer": "local-new",
      "h-new": "10.0.0.1",
    });
  });

  it("sends nothing when the personal vault did not change (a team edit calls pushDirty too)", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "h1", host("h1", T1), T1);
    harness.server.put("secrets", "secret:1", secret("secret:1", T1), T1);
    await harness.service.bootstrap();
    const postsBefore = harness.server.posts.length;

    await harness.service.pushDirty();
    await harness.service.pushDirty();

    expect(harness.server.posts).toHaveLength(postsBefore);
    expect(postsBefore).toBe(0);
    expect(harness.service.getState()).toMatchObject({ status: "ready", pendingPush: false });
  });

  it("uploads a renamed host alone — kilobytes, not the whole vault", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    for (let n = 0; n < 300; n += 1) {
      harness.server.put("hosts", `h${n}`, host(`h${n}`, T1), T1);
      harness.server.put("secrets", `secret:${n}`, secret(`secret:${n}`, T1), T1);
    }
    await harness.service.bootstrap();
    expect(harness.repos.hosts.list()).toHaveLength(300);

    const target = harness.repos.hosts.getById("h42") as HostRecord;
    harness.repos.hosts.update("h42", { ...target, label: "renamed" } as never, null);
    await harness.service.pushDirty();

    expect(harness.server.posts).toHaveLength(1);
    expect(harness.server.posts[0].ids).toEqual(["hosts:h42"]);
    expect(harness.server.posts[0].bytes).toBeLessThan(4 * 1024);
    // 받은 사본으로 기준을 만들었으니 다시 받지 않았고, 올린 것은 기준에 들어가 다시 올리지 않는다.
    expect(harness.server.gets).toHaveLength(1);
    await harness.service.pushDirty();
    expect(harness.server.posts).toHaveLength(1);
  });

  it("does not bring back a record the server deleted at the same time as the local copy", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "h1", host("h1", T1), T1);
    harness.server.put("hosts", "h2", host("h2", T1), T1);
    harness.server.remove("hosts", "h1", T2);
    await harness.service.bootstrap();
    expect(harness.repos.hosts.list().map((item) => item.id)).toEqual(["h2"]);

    // 같은 시각의 옛 사본이 로컬에 돌아왔다(예: 다른 경로로 되살림). 서버의 지움과 시각이 같으면 지움이 이긴다.
    harness.seed({ hosts: [host("h1", T2), host("h2", T1)] });
    await harness.service.pushDirty();

    expect(harness.server.posts).toHaveLength(0);
    expect(harness.server.get("hosts", "h1")?.deleted_at).toBe(T2);
  });

  it("drops the server copy it knows when the vault is reset, and reads it again before pushing", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "h1", host("h1", T1), T1);
    await harness.service.bootstrap();
    expect(harness.server.gets).toHaveLength(1);

    harness.service.resetVaultRecoveryState();
    await harness.service.pushDirty();

    expect(harness.server.gets).toHaveLength(2);
    expect(harness.server.gets[1]).toEqual({ inm: null, status: 200 });
  });

  it("also uploads a same-time content change (fillRdpAwsSsmProfileId keeps updatedAt on purpose)", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    const rdp = {
      id: "rdp-1",
      kind: "rdp",
      label: "win",
      hostname: "i-0abc",
      port: 3389,
      awsSsm: { profileName: "prod", region: "ap-northeast-2", instanceId: "i-0abc" },
      createdAt: T0,
      updatedAt: T1,
    };
    harness.server.put("hosts", "rdp-1", rdp, T1);
    await harness.service.bootstrap();

    harness.repos.hosts.fillRdpAwsSsmProfileId("rdp-1", "aws-profile-1");
    expect(harness.repos.hosts.getById("rdp-1")?.updatedAt).toBe(T1);
    await harness.service.pushDirty();

    expect(harness.server.pushedIds()).toEqual(["hosts:rdp-1"]);
    const pushed = harness.syncModule.decodeEncryptedPayload<{ awsSsm: { profileId?: string } }>(
      harness.server.get("hosts", "rdp-1")?.encrypted_payload as string,
      CONTEXT.vaultKeyBase64,
    );
    expect(pushed.awsSsm.profileId).toBe("aws-profile-1");
  });

  it("without a server copy yet, pulls once first and applies that pull when there is nothing to push", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "h1", host("h1", T1), T1);
    // 이 기기는 아직 받은 적 없이 올릴 것이 있다고 적혀 있다(예: 팀 편집이 남긴 표시).
    harness.service.markLocalChangesPendingPush();

    await harness.service.bootstrap();

    expect(harness.server.posts).toHaveLength(0);
    // 기준을 만든 그 받기를 그대로 적용했다 — 받기는 한 번.
    expect(harness.server.gets).toEqual([{ inm: null, status: 200 }]);
    expect(harness.repos.hosts.list().map((item) => item.id)).toEqual(["h1"]);
    expect(harness.service.getState()).toMatchObject({ status: "ready", pendingPush: false });
  });

  it("pushes local changes before pulling when there is no server copy yet (pending at start)", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "h-remote", host("h-remote", T1), T1);
    harness.seed({ hosts: [host("h-offline-edit", T2)] });
    harness.service.markLocalChangesPendingPush();

    await harness.service.bootstrap();

    expect(harness.server.pushedIds()).toEqual(["hosts:h-offline-edit"]);
    // 기준용 받기, 올린 뒤 받기 — 둘 다 전체(이 기기는 아직 적용한 리비전이 없다).
    expect(harness.server.gets.map((get) => get.status)).toEqual([200, 200]);
    expect(harness.repos.hosts.list().map((item) => item.id).sort()).toEqual(["h-offline-edit", "h-remote"]);
  });
});

describe("SyncService personal push — batches", () => {
  function bigVault(count: number) {
    return {
      hosts: Array.from({ length: count }, (_, n) => host(`h${String(n).padStart(4, "0")}`, T1, { secretRef: `secret:${n}` })),
      secrets: Array.from({ length: count }, (_, n) => secret(`secret:${n}`, T1, `pw-${n}-${"x".repeat(24)}`)),
    };
  }

  it("uploads a vault bigger than nginx's 1MB limit in batches and chains the revision", async () => {
    const harness = await createHarness();
    harness.server.limit = 1024 * 1024;
    harness.seed(bigVault(801));
    harness.service.markLocalChangesPendingPush();

    await harness.service.bootstrap();

    const accepted = harness.server.posts.filter((post) => post.status === 202);
    expect(harness.server.posts.every((post) => post.status === 202)).toBe(true);
    expect(accepted.length).toBeGreaterThan(1);
    expect(Math.max(...accepted.map((post) => post.bytes))).toBeLessThanOrEqual(256 * 1024);
    expect(harness.server.ids("hosts")).toHaveLength(801);
    expect(harness.server.ids("secrets")).toHaveLength(801);
    // 비밀값이 호스트보다 먼저 간다(가리킴을 받는 것 먼저) — 비밀값이 든 마지막 묶음이 호스트가 든 첫 묶음보다 늦지
    // 않다. 묶음 하나는 서버에서 한 번에 들어가므로 묶음 안 순서는 상관없다.
    const batches = accepted.map((post) => post.ids);
    const lastSecretBatch = batches.reduce((last, ids, index) => (ids.some((id) => id.startsWith("secrets:")) ? index : last), -1);
    const firstHostBatch = batches.findIndex((ids) => ids.some((id) => id.startsWith("hosts:")));
    expect(lastSecretBatch).toBeGreaterThanOrEqual(0);
    expect(firstHostBatch).toBeGreaterThanOrEqual(lastSecretBatch);
    expect(harness.service.getState()).toMatchObject({ status: "ready", pendingPush: false });

    // 받은 뒤 리비전을 안다 — 다음 받기는 304.
    await harness.service.bootstrap();
    expect(harness.server.gets.at(-1)?.status).toBe(304);
  });

  it("chains the revision batch by batch, so the pull after the upload is a 304", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "seed", host("seed", T0), T0);
    await harness.service.bootstrap();
    harness.seed({ ...bigVault(400), hosts: [host("seed", T0), ...bigVault(400).hosts] });

    await harness.service.pushDirty();
    const batches = harness.server.posts.filter((post) => post.status === 202).length;
    expect(batches).toBeGreaterThan(1);
    await harness.service.bootstrap();

    // 묶음마다 '직전+1' 이라 이어 받았다 — 자기 올리기를 다시 받지 않는다.
    expect(harness.server.gets.at(-1)).toEqual({ inm: `"${harness.server.revision}"`, status: 304 });
  });

  it("halves the batches when the proxy limit is smaller (413) and still uploads everything", async () => {
    const harness = await createHarness();
    harness.server.limit = 100 * 1024;
    harness.seed(bigVault(300));
    harness.service.markLocalChangesPendingPush();

    await harness.service.bootstrap();

    expect(harness.server.posts.filter((post) => post.status === 413).length).toBeGreaterThan(0);
    expect(harness.server.ids("hosts")).toHaveLength(300);
    expect(harness.server.ids("secrets")).toHaveLength(300);
    expect(harness.service.getState()).toMatchObject({ status: "ready", pendingPush: false });
  });

  it("stops at a failed batch, keeps what went in, and sends only the rest next time", async () => {
    const harness = await createHarness();
    harness.seed(bigVault(801));
    harness.service.markLocalChangesPendingPush();
    // 둘째 묶음에서 502.
    let posted = 0;
    const realFetch = harness.server.fetch.getMockImplementation() as NonNullable<
      ReturnType<typeof harness.server.fetch.getMockImplementation>
    >;
    harness.server.fetch.mockImplementation(async (input, init) => {
      if (init?.method === "POST" && ++posted === 2) {
        harness.server.failPosts.push(502);
      }
      return realFetch(input, init);
    });

    await expect(harness.service.bootstrap()).rejects.toThrow();
    expect(harness.service.getState()).toMatchObject({ status: "error", pendingPush: true });
    const firstRound = harness.server.pushedIds();
    expect(firstRound.length).toBeGreaterThan(0);
    // 실패한 동안 받기는 하지 않았다(기준용 받기 하나뿐).
    expect(harness.server.gets).toHaveLength(1);

    await harness.service.bootstrap();

    const secondRound = harness.server.pushedIds().slice(firstRound.length);
    expect(secondRound.filter((id) => firstRound.includes(id))).toEqual([]);
    expect(harness.server.ids("hosts")).toHaveLength(801);
    expect(harness.server.ids("secrets")).toHaveLength(801);
    expect(harness.service.getState()).toMatchObject({ status: "ready", pendingPush: false });
  });
});

describe("SyncService personal push — a record too large for the proxy", () => {
  it("uploads the rest, names the record, blocks pulls, does not resend it, and recovers once it shrinks", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.limit = 1024 * 1024;
    harness.seed({
      hosts: [host("h1", T1)],
      snippets: [snippet("deploy-script", T1, "y".repeat(1_200_000)), snippet("small", T1, "ls")],
    });
    harness.service.markLocalChangesPendingPush();

    await expect(harness.service.bootstrap()).rejects.toThrow(/deploy-script/);

    expect(harness.server.ids("hosts")).toEqual(["h1"]);
    expect(harness.server.ids("snippets")).toEqual(["small"]);
    expect(harness.server.posts.filter((post) => post.status === 413)).toHaveLength(1);
    expect(harness.service.getState()).toMatchObject({ status: "error", pendingPush: true });
    expect(harness.service.getState().errorMessage).toMatch(/deploy-script/);
    // 그 레코드가 남아 있는 동안 받지 않는다 — 받으면 서버 사본으로 갈아 끼워 그것을 잃는다.
    const getsAfterFirst = harness.server.gets.length;

    // 그대로면 다시 보내지 않는다(받기도 여전히 막힘).
    await expect(harness.service.bootstrap()).rejects.toThrow(/deploy-script/);
    await harness.service.pushDirty();
    expect(harness.server.posts.filter((post) => post.status === 413)).toHaveLength(1);
    expect(harness.server.gets).toHaveLength(getsAfterFirst);
    expect(harness.repos.snippets.list().map((item) => item.id).sort()).toEqual(["deploy-script", "small"]);

    // 줄이면 다시 골라 올리고 받기도 돌아온다.
    harness.repos.snippets.update("deploy-script", { label: "deploy-script", command: "./deploy.sh", keyword: null });
    await harness.service.pushDirty();
    expect(harness.server.ids("snippets")).toEqual(["deploy-script", "small"]);
    await harness.service.bootstrap();
    expect(harness.service.getState()).toMatchObject({ status: "ready", pendingPush: false, errorMessage: null });
  });
});

describe("SyncService personal push — deletions and an emptied server", () => {
  it("pushes queued deletions and clears only the ones it sent", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "h1", host("h1", T1), T1);
    harness.server.put("hosts", "h2", host("h2", T1), T1);
    await harness.service.bootstrap();

    harness.repos.hosts.remove("h1");
    harness.service.markDeleted("hosts", "h1");
    let deletedDuringPull = false;
    const realFetch = harness.server.fetch.getMockImplementation() as NonNullable<
      ReturnType<typeof harness.server.fetch.getMockImplementation>
    >;
    harness.server.fetch.mockImplementation(async (input, init) => {
      // 받는 사이에 h2 를 지운다 — 그 지움은 이번에 안 올렸으니 대기열에 남아야 한다.
      if ((init?.method ?? "GET") === "GET" && new URL(String(input)).pathname === "/sync" && !deletedDuringPull) {
        deletedDuringPull = true;
        harness.repos.hosts.remove("h2");
        harness.service.markDeleted("hosts", "h2");
      }
      return realFetch(input, init);
    });
    await harness.service.bootstrap();

    expect(harness.server.pushedIds()).toEqual(["hosts:h1(지움)"]);
    expect(harness.repos.outbox.list().map((entry) => `${entry.kind}:${entry.recordId}`)).toEqual(["hosts:h2"]);

    await harness.service.pushDirty();
    expect(harness.server.pushedIds()).toEqual(["hosts:h1(지움)", "hosts:h2(지움)"]);
    expect(harness.repos.outbox.list()).toEqual([]);
    expect(harness.server.ids("hosts")).toEqual([]);
  });

  it("re-uploads everything when the server loses its data, even with a server copy already known", async () => {
    const harness = await createHarness();
    harness.seedServerPreferences();
    harness.server.put("hosts", "h1", host("h1", T1), T1);
    harness.server.put("hosts", "h2", host("h2", T1), T1);
    await harness.service.bootstrap();

    harness.server.wipe();
    await harness.service.bootstrap();

    expect(harness.server.ids("hosts")).toEqual(["h1", "h2"]);
    expect(harness.repos.hosts.list().map((item) => item.id).sort()).toEqual(["h1", "h2"]);
  });

  it("re-uploads everything, in batches, when the server copy comes back empty", async () => {
    const harness = await createHarness();
    harness.server.limit = 1024 * 1024;
    harness.seed({
      hosts: Array.from({ length: 801 }, (_, n) => host(`h${n}`, T1, { secretRef: `secret:${n}` })),
      secrets: Array.from({ length: 801 }, (_, n) => secret(`secret:${n}`, T1, `pw-${n}-${"x".repeat(24)}`)),
    });

    // 올릴 것이 있다는 표시 없이도(서버만 비었다) — 예: 다른 기기가 초기화했다.
    await harness.service.bootstrap();

    expect(harness.server.posts.length).toBeGreaterThan(1);
    expect(harness.server.posts.every((post) => post.status === 202)).toBe(true);
    expect(harness.server.ids("hosts")).toHaveLength(801);
    expect(harness.repos.hosts.list()).toHaveLength(801);
  });
});
