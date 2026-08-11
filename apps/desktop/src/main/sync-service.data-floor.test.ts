import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord } from "@shared";
import type { AuthSyncContext } from "./auth-service";

// 계정의 데이터 수준을 서버에 알리는 헤더. 서버는 페이로드가 암호문이라 안을 볼 수 없어서, 이
// 헤더가 없으면 옛 클라이언트가 RDP 호스트를 받아 화면이 비거나 레코드를 SSH 로 고쳐 되올린다.
// 반대로 이 값을 RDP 가 없는 계정에서도 보내면, 그 사용자까지 업데이트를 강요받는다.

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
  vaultKeyBase64: Buffer.alloc(32, 1).toString("base64"),
  vaultEpoch: 1,
};

const SSH_HOST = {
  id: "ssh-1",
  kind: "ssh",
  label: "linuxbox",
  hostname: "10.0.0.9",
  port: 22,
  username: "ubuntu",
  authType: "agent",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
} as unknown as HostRecord;

const RDP_HOST = {
  id: "rdp-1",
  kind: "rdp",
  label: "winbox",
  hostname: "10.0.2.181",
  port: 3389,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
} as unknown as HostRecord;

async function createHarness(hosts: HostRecord[]) {
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
    { list: vi.fn(() => hosts), replaceAll: vi.fn() } as never,
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
  );
  return service;
}

/**
 * push 요청의 헤더를 잡아 둔다.
 *
 * `withAccessToken` 이 헤더를 `Headers` 인스턴스로 다시 만들어 넘기므로, 객체 스프레드로 읽으면
 * 항상 비어 보인다. Headers 로 감싸 읽는다.
 */
function stubFetch() {
  const pushHeaders: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === "/api/info") {
        return new Response(
          JSON.stringify({ capabilities: { sync: { awsProfiles: true }, vault: { e2ee: true } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "POST") {
        pushHeaders.push(new Headers(init.headers ?? {}));
        return new Response(JSON.stringify({ revision: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ hosts: [] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"2"' },
      });
    }),
  );
  return pushHeaders;
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolssh-sync-floor-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("계정 데이터 수준 헤더", () => {
  it("RDP 호스트가 있으면 수준 1 을 알린다", async () => {
    const service = await createHarness([SSH_HOST, RDP_HOST]);
    const headers = stubFetch();

    await service.pushDirty();

    expect(headers.at(-1)?.get("X-Dolgate-Sync-Data-Floor")).toBe("1");
  });

  // 이게 이 판정의 핵심이다. 종류 이름을 나열하는 방식이면 새 종류를 만들 때마다
  // resolveSyncDataFloor 를 고쳐야 하고, 한 번 잊으면 그 종류를 저장한 계정에서 1.8.10 이 흰
  // 화면이 된다(RDP 때 그랬다). 이 빌드가 아직 모르는 종류라도 하한은 올라가야 한다.
  it("옛 버전이 모르는 종류이면 RDP 가 아니어도 수준 1 을 알린다", async () => {
    const futureHost = {
      ...SSH_HOST,
      id: "host-future",
      kind: "will-not-exist-in-1.8.10",
    } as unknown as typeof SSH_HOST;
    const service = await createHarness([SSH_HOST, futureHost]);
    const headers = stubFetch();

    await service.pushDirty();

    expect(headers.at(-1)?.get("X-Dolgate-Sync-Data-Floor")).toBe("1");
  });

  it("옛 버전이 알던 종류만 있으면 0 을 알린다", async () => {
    // 0 을 보내는 것과 안 보내는 것은 서버에서 같지만(둘 다 요구 없음), 모든 클라이언트가 자기
    // 수준을 선언하게 해 "안 보낸 것" 과 "0" 을 구분할 일을 없앤다. 0 이 계정 수준을 내리지는
    // 않는다 — 서버가 올리기만 한다.
    const service = await createHarness([SSH_HOST]);
    const headers = stubFetch();

    await service.pushDirty();

    expect(headers.at(-1)?.get("X-Dolgate-Sync-Data-Floor")).toBe("0");
  });
});
