import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSyncContext } from "./auth-service";

// 다른 기기의 변경을 기다리는 길(GET /sync/watch). 서버가 지원하면 롱폴링, 아니면 예전 30초
// 폴링과 같게 물러선다. 기다리는 동안 로컬 편집 업로드를 막으면 안 된다.

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === "userData" ? tempDir : os.tmpdir(),
    ),
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
  vaultKeyBase64: Buffer.alloc(32, 1).toString("base64"),
  vaultEpoch: 1,
};

async function createHarness(options: { authStatus?: string } = {}) {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const stateStorageModule = await import("./state-storage");
  stateStorageModule.resetDesktopStateStorageForTests();
  const { SyncService } = await import("./sync-service");

  const authService = {
    captureSyncContext: vi.fn(() => ({ ...CONTEXT })),
    isSyncContextCurrent: vi.fn(() => true),
    getState: vi.fn(() => ({ status: options.authStatus ?? "authenticated" })),
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
  const emptyRepository = {
    list: vi.fn(() => []),
    listPayloads: vi.fn(() => []),
    replaceAll: vi.fn(),
  };
  const settings = {
    getSyncedTerminalPreferences: vi.fn(() => ({
      id: "global-terminal",
      globalTerminalThemeId: "dolssh-dark",
      updatedAt: "2026-08-11T00:00:00.000Z",
    })),
    clearSyncedTerminalPreferences: vi.fn(),
  };

  // 인자 순서는 SyncService 선언 순서다(hosts 가 두 번째).
  const service = new SyncService(
    authService as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    { list: vi.fn(() => []), remove: vi.fn() } as never,
    emptyRepository as never,
    settings as never,
    { load: vi.fn(), remove: vi.fn() } as never,
    { list: vi.fn(() => []), clearMany: vi.fn(), clearAll: vi.fn() } as never,
    emptyRepository as never,
    emptyRepository as never,
  );
  return service;
}

function setLastSyncRevision(service: unknown, revision: string | null) {
  (service as { lastSyncRevision: string | null }).lastSyncRevision = revision;
}

/** 당기기(bootstrap)가 하는 것처럼 /api/info 를 다시 읽는다. */
async function rereadServerInfo(service: unknown) {
  const internals = service as {
    captureSyncLease(): unknown;
    fetchAwsProfilesServerSupport(lease: unknown): Promise<unknown>;
  };
  await internals.fetchAwsProfilesServerSupport(internals.captureSyncLease());
}

interface WatchRequest {
  headers: Headers;
  signal: AbortSignal | null | undefined;
}

/**
 * 서버를 흉내 낸다. watch 는 요청마다 응답을 고를 수 있고, 'hang' 이면 abort 될 때까지 답하지 않는다
 * (롱폴링 대기 중).
 */
function stubServer(options: {
  info?: Record<string, unknown> | "network-error";
  watch?: (request: WatchRequest) => Response | "hang";
  snapshotEtag?: string;
}) {
  const calls: string[] = [];
  const watchRequests: WatchRequest[] = [];
  const pushes: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(`${init?.method ?? "GET"} ${pathname}`);
      if (pathname === "/api/info") {
        if (options.info === "network-error") {
          throw new TypeError("fetch failed");
        }
        return Response.json(options.info ?? { capabilities: { sync: { awsProfiles: true, watch: true } } });
      }
      if (pathname === "/sync/watch") {
        const request = { headers: new Headers(init?.headers ?? {}), signal: init?.signal };
        watchRequests.push(request);
        const answer = options.watch?.(request) ?? new Response(null, { status: 304 });
        if (answer !== "hang") {
          return answer;
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (init?.method === "POST") {
        pushes.push(new Headers(init.headers ?? {}));
        return Response.json({ revision: 2 });
      }
      return new Response(JSON.stringify({ hosts: [] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: options.snapshotEtag ?? '"2"' },
      });
    }),
  );
  return { calls, watchRequests, pushes };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolssh-sync-watch-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("변경 대기 (watchForChanges)", () => {
  it("마지막으로 적용한 리비전을 들고 기다리고, 바뀐 것이 없으면 unchanged", async () => {
    const service = await createHarness();
    const server = stubServer({});
    setLastSyncRevision(service, '"5"');

    await expect(service.watchForChanges()).resolves.toEqual({ outcome: "unchanged", live: true });
    await expect(service.watchForChanges()).resolves.toEqual({ outcome: "unchanged", live: true });

    expect(server.watchRequests[0].headers.get("If-None-Match")).toBe('"5"');
    expect(server.watchRequests[0].headers.get("Authorization")).toBe("Bearer access-1");
    // 서버 지원 여부는 한 번 알면 다시 묻지 않는다.
    expect(server.calls.filter((call) => call === "GET /api/info")).toHaveLength(1);
  });

  it("리비전이 바뀌었으면 changed", async () => {
    const service = await createHarness();
    stubServer({
      watch: () => Response.json({ revision: 6 }, { headers: { etag: '"6"' } }),
    });
    setLastSyncRevision(service, '"5"');

    await expect(service.watchForChanges()).resolves.toEqual({ outcome: "changed", live: true });
  });

  // 자기 push 직후에는 그 리비전을 이미 갖고 있다 — 되받으면 쓸데없이 한 번 더 당긴다.
  it("이미 적용한 리비전이면(자기 push 의 메아리) 당기지 않는다", async () => {
    const service = await createHarness();
    stubServer({
      watch: () => Response.json({ revision: 5 }, { headers: { etag: '"5"' } }),
    });
    setLastSyncRevision(service, '"5"');

    await expect(service.watchForChanges()).resolves.toEqual({ outcome: "unchanged", live: true });
  });

  // 압축 프록시(nginx gzip·Cloudflare)는 ETag 를 W/"5" 로 약하게 바꾼다. 리비전은 같다.
  it("프록시가 ETag 를 약하게 바꿔도 이미 적용한 리비전이면 당기지 않는다", async () => {
    const service = await createHarness();
    stubServer({
      watch: () => Response.json({ revision: 5 }, { headers: { etag: 'W/"5"' } }),
    });
    setLastSyncRevision(service, '"5"');

    await expect(service.watchForChanges()).resolves.toEqual({ outcome: "unchanged", live: true });
  });

  // 약한 모양을 그대로 저장하면 자기 push 의 리비전을 못 읽어 편집마다 전체를 다시 받고, 이 모양을
  // 같은 리비전으로 보지 못하는 옛 서버에서는 당기기가 끝없이 되풀이된다.
  it("당겨 온 ETag 가 약하게 바뀌어 있어도 서버가 낸 모양으로 읽는다", async () => {
    const service = await createHarness();
    stubServer({ snapshotEtag: 'W/"2"' });
    const internals = service as unknown as {
      captureSyncLease(): unknown;
      fetchAwsProfilesServerSupport(lease: unknown): Promise<unknown>;
      fetchRemoteSnapshot(support: unknown, lease: unknown): Promise<{ etag: string | null }>;
    };
    const lease = internals.captureSyncLease();
    const support = await internals.fetchAwsProfilesServerSupport(lease);

    await expect(internals.fetchRemoteSnapshot(support, lease)).resolves.toMatchObject({ etag: '"2"' });
  });

  // 이 설계의 핵심이다. 대기를 동기화 큐 안에서 하면 그동안 로컬 편집이 25초씩 서버에 못 간다.
  it("기다리는 동안에도 로컬 편집은 바로 올라간다", async () => {
    const service = await createHarness();
    const server = stubServer({ watch: () => "hang" });
    setLastSyncRevision(service, '"5"');

    const waiting = service.watchForChanges();
    await vi.waitFor(() => expect(server.watchRequests).toHaveLength(1));

    await service.pushDirty();
    expect(server.pushes).toHaveLength(1);

    service.interruptWatch();
    await expect(waiting).resolves.toEqual({ outcome: "unchanged", live: true });
  });

  it("잠자기 복귀는 진행 중인 대기를 끊어 바로 다시 붙게 한다", async () => {
    const service = await createHarness();
    const server = stubServer({ watch: () => "hang" });
    setLastSyncRevision(service, '"5"');

    const waiting = service.watchForChanges();
    await vi.waitFor(() => expect(server.watchRequests).toHaveLength(1));
    service.interruptWatch();

    await expect(waiting).resolves.toEqual({ outcome: "unchanged", live: true });
    expect(server.watchRequests[0].signal?.aborted).toBe(true);
  });

  // 옛 자체 호스팅 서버: 예전처럼 30초마다 당긴다. /sync/watch 를 두드리지 않는다.
  it("서버가 대기를 모르면 30초 기다렸다 changed 를 준다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = await createHarness();
    const server = stubServer({ info: { capabilities: { sync: { awsProfiles: true } } } });

    let settled: unknown = null;
    void service.watchForChanges().then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toEqual({ outcome: "changed", live: false });
    expect(server.watchRequests).toHaveLength(0);
  });

  // /api/info 가 안 읽히면 지원 여부를 모른다. 모르는 채로 롱폴링을 하지 않고 예전 폴링으로
  // 물러섰다가, 다음에 다시 묻는다.
  it("서버 정보를 못 읽으면 폴링으로 물러서고 다음에 다시 묻는다", async () => {
    const service = await createHarness();
    const server = stubServer({ info: "network-error" });

    const waiting = service.watchForChanges();
    await vi.waitFor(() => expect(server.calls).toContain("GET /api/info"));
    service.interruptWatch();
    await expect(waiting).resolves.toEqual({ outcome: "changed", live: false });

    const again = service.watchForChanges();
    await vi.waitFor(() =>
      expect(server.calls.filter((call) => call === "GET /api/info")).toHaveLength(2),
    );
    service.interruptWatch();
    await again;
    expect(server.watchRequests).toHaveLength(0);
  });

  // 서버를 옛 버전으로 되돌리면 /sync/watch 가 404 다. 일시 오류로 보고 재시도만 하면 그동안
  // 아무것도 당기지 않는다(앱을 다시 켤 때까지). 옛 서버처럼 30초 폴링으로 물러선다.
  it("서버가 대기를 모른다고 하면(404) 30초 폴링으로 물러선다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const service = await createHarness();
    const server = stubServer({
      watch: () => new Response("404 page not found", { status: 404 }),
    });
    setLastSyncRevision(service, '"5"');

    let settled: unknown = null;
    void service.watchForChanges().then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ outcome: "changed", live: false });

    // 그 뒤로는 대기를 두드리지 않는다.
    void service.watchForChanges();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.watchRequests).toHaveLength(1);

    // 서버가 다시 올라와 /api/info 가 지원한다고 하면(당기기가 다시 읽는다) 롱폴링으로 돌아온다.
    await rereadServerInfo(service);
    void service.watchForChanges();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.watchRequests).toHaveLength(2);
  });

  // 서버 오류는 던져서 루프가 물러서게 한다. 기능이 없다는 뜻은 아니므로 지원 여부는 버리지 않는다.
  it("서버 오류(500)는 던지되 지원 여부는 버리지 않는다", async () => {
    const service = await createHarness();
    const server = stubServer({
      watch: () => Response.json({ error: "서버 오류가 발생했습니다." }, { status: 500 }),
    });

    await expect(service.watchForChanges()).rejects.toThrow();
    await expect(service.watchForChanges()).rejects.toThrow();
    expect(server.watchRequests).toHaveLength(2);
  });

  it("당길 수 없는 상태(로그인 안 됨)면 서버에 묻지 않고 쉰다", async () => {
    const service = await createHarness({ authStatus: "unauthenticated" });
    const server = stubServer({});

    const waiting = service.watchForChanges();
    service.interruptWatch();

    await expect(waiting).resolves.toEqual({ outcome: "unchanged", live: false });
    expect(server.calls).toHaveLength(0);
  });
});
