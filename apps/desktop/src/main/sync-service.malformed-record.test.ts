import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord, SyncRecord } from "@shared";
import type { AuthSyncContext } from "./auth-service";

// 2026-10-23 사고: 옛 빌드가 지움 기록의 id 자리에 배열을 썼다. 서버는 그런 기록 하나로 push 전체를 400 으로 거절하고
// 앱은 같은 것을 다시 보내, 그 뒤의 변경이 하나도 올라가지 않았다(개인 부트스트랩이 실패해 팀 동기화도 시작하지 않았다).
// 실제 서버로 돌리는 것은 team-sync.e2e.test.ts 의 같은 이름 시험이다. 여기서는 평소 시험에서 같은 길을 본다.

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => (name === "userData" ? tempDir : os.tmpdir())),
    getVersion: vi.fn(() => "1.9.14-test"),
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

const host = (id: string, updatedAt: string) =>
  ({
    id,
    kind: "ssh",
    label: id,
    hostname: `${id}.internal`,
    port: 22,
    username: "ubuntu",
    authType: "password",
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt,
  }) as unknown as HostRecord;

// 옛 메인이 쓴 모양 그대로 — 인증 정보 지움 기록의 id 자리에 배열.
const POISONED = { kind: "secrets", recordId: ["secret:a", "secret:b"], deletedAt: "2026-10-23T08:20:00.000Z" };
const VALID_DELETION = { kind: "secrets", recordId: "secret:gone", deletedAt: "2026-10-23T08:32:00.000Z" };

async function createHarness(options: { hosts: HostRecord[]; outbox: unknown[] }) {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const stateStorageModule = await import("./state-storage");
  stateStorageModule.resetDesktopStateStorageForTests();
  const { SyncService } = await import("./sync-service");

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
  };
  const emptyRepository = { list: vi.fn(() => []), listPayloads: vi.fn(() => []), replaceAll: vi.fn() };
  const settings = {
    getSyncedTerminalPreferences: vi.fn(() => ({
      id: "global-terminal",
      globalTerminalThemeId: "dolssh-dark",
      updatedAt: "2026-10-23T00:00:00.000Z",
    })),
    clearSyncedTerminalPreferences: vi.fn(),
  };
  // 실제 대기열처럼 올린 것은 지운다 — 안 지우면 "지움 기록이 남았으면 다시 올린다" 가 끝나지 않는다.
  let entries = [...options.outbox];
  const outbox = {
    list: vi.fn(() => [...entries]),
    clearMany: vi.fn((records: unknown[]) => {
      entries = entries.filter((entry) => !records.includes(entry));
    }),
    clearAll: vi.fn(),
  };

  // 인자 순서는 SyncService 선언 순서다(hosts 가 두 번째).
  const service = new SyncService(
    authService as never,
    { list: vi.fn(() => options.hosts), replaceAll: vi.fn() } as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    { list: vi.fn(() => []), remove: vi.fn() } as never,
    emptyRepository as never,
    settings as never,
    { load: vi.fn(), remove: vi.fn() } as never,
    outbox as never,
    emptyRepository as never,
    emptyRepository as never,
  );
  return { service, outbox };
}

/** push 본문을 잡아 둔다. rejectPush 면 실제 서버처럼 400 으로 거절한다. */
function stubFetch(options: { rejectPush?: boolean } = {}) {
  const pushed: Array<Record<string, SyncRecord[]>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === "/api/info") {
        return new Response(JSON.stringify({ capabilities: { sync: { awsProfiles: true }, vault: { e2ee: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        pushed.push(JSON.parse(String(init.body)) as Record<string, SyncRecord[]>);
        return options.rejectPush
          ? new Response(JSON.stringify({ error: "잘못된 요청입니다." }), {
              status: 400,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ revision: 2 }), { status: 202, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ hosts: [] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"2"' },
      });
    }),
  );
  return pushed;
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolssh-sync-malformed-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("서버가 받지 않을 레코드", () => {
  it("빼고 올린다 — 배열 id 의 지움 기록·시각이 어긋난 레코드 하나가 push 전체를 막지 않는다", async () => {
    const { service, outbox } = await createHarness({
      hosts: [host("good", "2026-10-23T09:29:00.000Z"), host("bad-time", "2026-10-23 09:29:00")],
      outbox: [POISONED, VALID_DELETION],
    });
    const pushed = stubFetch();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(service.pushDirty()).resolves.toMatchObject({ status: "ready", errorMessage: null });

    const body = pushed.at(-1)!;
    const ids = Object.values(body).flat().map((record) => record.id);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(body.hosts!.map((record) => record.id)).toEqual(["good"]);
    expect(body.secrets!.map((record) => [record.id, record.deleted_at])).toEqual([["secret:gone", VALID_DELETION.deletedAt]]);
    // 올린 뒤 대기열을 치울 때 잘못된 기록도 함께 치운다 — 다음 push 에 다시 실리지 않는다.
    expect(outbox.clearMany).toHaveBeenCalledWith(expect.arrayContaining([POISONED, VALID_DELETION]));
  });

  it("부트스트랩이 실패하면 알린다 — main 이 이것으로 팀 동기화를 따로 띄운다", async () => {
    const { service } = await createHarness({ hosts: [host("good", "2026-10-23T09:29:00.000Z")], outbox: [VALID_DELETION] });
    const onFailed = vi.fn();
    service.setOnBootstrapFailed(onFailed);

    stubFetch({ rejectPush: true });
    await expect(service.bootstrap()).rejects.toThrow("잘못된 요청입니다.");
    expect(onFailed).toHaveBeenCalledTimes(1);

    stubFetch();
    await service.bootstrap();
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});

describe("지움 기록 대기열", () => {
  it("문자열이 아닌 id 는 받지 않는다 — 하나라도 어긋나면 아무것도 쓰지 않는다", async () => {
    process.env.DOLSSH_USER_DATA_DIR = tempDir;
    vi.resetModules();
    const stateStorageModule = await import("./state-storage");
    stateStorageModule.resetDesktopStateStorageForTests();
    const { SyncOutboxRepository } = await import("./database");
    const outbox = new SyncOutboxRepository();

    expect(() => outbox.upsertDeletions("secrets", ["secret:ok", ["secret:a"] as unknown as string])).toThrow(TypeError);
    expect(() => outbox.upsertDeletion("secrets", ["secret:a", "secret:b"] as unknown as string)).toThrow(TypeError);
    expect(() => outbox.upsertDeletions("hosts", [""])).toThrow(TypeError);
    expect(outbox.list()).toEqual([]);

    outbox.upsertDeletions("secrets", ["secret:ok"]);
    expect(outbox.list().map((entry) => entry.recordId)).toEqual(["secret:ok"]);
  });
});
