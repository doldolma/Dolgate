import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedWorkspaceRecord, SyncPayloadV2 } from "@shared";
import type { AuthSyncContext } from "./auth-service";

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === "userData" ? tempDir : os.tmpdir(),
    ),
    getVersion: vi.fn(() => "1.8.0-test"),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptySyncPayload() {
  return {
    groups: [],
    hosts: [],
    secrets: [],
    knownHosts: [],
    portForwards: [],
    dnsOverrides: [],
    snippets: [],
    workspaces: [],
    preferences: [],
    awsProfiles: [],
    tailnets: [],
  };
}

function decryptRecord<T>(encryptedPayload: string, keyBase64: string): T {
  const envelope = JSON.parse(encryptedPayload) as {
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyBase64, "base64"),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}

function encryptRecord(id: string, value: unknown, keyBase64: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(keyBase64, "base64"),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    id,
    encrypted_payload: JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
    updated_at: "2026-07-16T00:00:00.000Z",
  };
}

async function createHarness(initialContext: AuthSyncContext) {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const stateStorageModule = await import("./state-storage");
  stateStorageModule.resetDesktopStateStorageForTests();
  const { SyncService } = await import("./sync-service");

  let currentContext = { ...initialContext };
  const contextsEqual = (candidate: AuthSyncContext) =>
    candidate.userId === currentContext.userId &&
    candidate.serverUrl === currentContext.serverUrl &&
    candidate.vaultKeyBase64 === currentContext.vaultKeyBase64 &&
    candidate.vaultEpoch === currentContext.vaultEpoch;
  const authService = {
    captureSyncContext: vi.fn(() => ({ ...currentContext })),
    isSyncContextCurrent: vi.fn(contextsEqual),
    getState: vi.fn(() => ({ status: "authenticated" })),
    isVaultReadyForSync: vi.fn(() => true),
    getClientIdentificationHeaders: vi.fn(() => ({
      "X-Dolgate-Client": "desktop",
      "X-Dolgate-Client-Version": "1.8.0-test",
    })),
    getAccessToken: vi.fn(() => currentContext.accessToken),
    refreshSession: vi.fn(),
    handleVaultDekRejected: vi.fn(),
    getVaultStatus: vi.fn(() => "unlocked"),
    noteServerVaultSupport: vi.fn(),
  };

  const emptyRepository = {
    list: vi.fn(() => []),
    // tailnet 저장소는 동기화에 auth key 를 포함한 페이로드를 올린다.
    listPayloads: vi.fn(() => []),
    replaceAll: vi.fn(),
  };
  const settings = {
    getSyncedTerminalPreferences: vi.fn(() => ({
      id: "global-terminal",
      globalTerminalThemeId: "dolssh-dark",
      updatedAt: "2026-07-16T00:00:00.000Z",
    })),
    clearSyncedTerminalPreferences: vi.fn(),
  };
  const secretStore = {
    load: vi.fn<() => Promise<string | null>>(),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const secretMetadata = {
    list: vi.fn(() => [{ secretRef: "secret:one" }]),
    remove: vi.fn(),
  };
  const awsProfiles = {
    listPayloads: vi.fn(() => []),
    replaceAll: vi.fn(),
  };
  const savedWorkspaces = {
    list: vi.fn<() => SavedWorkspaceRecord[]>(() => []),
    replaceAll: vi.fn(),
  };
  const outbox = {
    list: vi.fn(() => []),
    clearMany: vi.fn(),
    clearAll: vi.fn(),
  };

  const service = new SyncService(
    authService as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    emptyRepository as never,
    secretMetadata as never,
    awsProfiles as never,
    settings as never,
    secretStore as never,
    outbox as never,
    emptyRepository as never,
    savedWorkspaces as never,
  );

  return {
    service,
    authService,
    secretStore,
    awsProfiles,
    savedWorkspaces,
    settings,
    outbox,
    setContext: (next: AuthSyncContext) => {
      currentContext = { ...next };
    },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolssh-sync-lease-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("SyncService immutable lease", () => {
  const oldContext: AuthSyncContext = {
    userId: "user-1",
    serverUrl: "https://sync.example.com/",
    accessToken: "access-old",
    vaultKeyBase64: Buffer.alloc(32, 1).toString("base64"),
    vaultEpoch: 1,
  };
  const newContext: AuthSyncContext = {
    ...oldContext,
    accessToken: "access-new",
    vaultKeyBase64: Buffer.alloc(32, 2).toString("base64"),
    vaultEpoch: 3,
  };
  const managedSecret = JSON.stringify({
    secretRef: "secret:one",
    label: "Shared credential",
    password: "secret-value",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });
  const savedWorkspace: SavedWorkspaceRecord = {
    id: "workspace-1",
    version: 1,
    name: "Operations",
    root: {
      id: "workspace-root",
      kind: "split",
      axis: "horizontal",
      ratio: 0.6,
      first: {
        id: "workspace-host",
        kind: "leaf",
        target: { kind: "host", hostId: "host-1", label: "Prod" },
      },
      second: {
        id: "workspace-local",
        kind: "leaf",
        target: { kind: "local", label: "Local shell" },
      },
    },
    favorite: false,
    groupName: null,
    lastOpenedAt: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };

  it("encrypts saved Workspaces into outgoing snapshots", async () => {
    const harness = await createHarness(oldContext);
    harness.savedWorkspaces.list.mockReturnValue([savedWorkspace]);
    harness.secretStore.load.mockResolvedValue(null);
    let requestInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        requestInit = init;
        return new Response(JSON.stringify({ revision: 1 }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    harness.service.markLocalChangesPendingPush();
    await harness.service.pushDirty();

    const payload = JSON.parse(String(requestInit?.body)) as SyncPayloadV2;
    expect(payload.workspaces).toHaveLength(1);
    expect(
      decryptRecord<SavedWorkspaceRecord>(
        payload.workspaces[0].encrypted_payload,
        oldContext.vaultKeyBase64,
      ),
    ).toEqual(savedWorkspace);
  });

  it("decrypts and atomically applies remote saved Workspaces", async () => {
    const harness = await createHarness(oldContext);
    const payload: SyncPayloadV2 = {
      ...emptySyncPayload(),
      workspaces: [
        encryptRecord(
          savedWorkspace.id,
          savedWorkspace,
          oldContext.vaultKeyBase64,
        ),
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(
            JSON.stringify({
              capabilities: {
                sync: { awsProfiles: true },
                vault: { e2ee: true },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"2"' },
        });
      }),
    );

    await harness.service.bootstrap();

    const stateStorage = (
      harness.service as unknown as {
        stateStorage: {
          getState: () => { data: { savedWorkspaces: SavedWorkspaceRecord[] } };
        };
      }
    ).stateStorage;
    expect(stateStorage.getState().data.savedWorkspaces).toEqual([
      savedWorkspace,
    ]);
  });

  // 그룹 경로 rename 은 그 경로로 키를 잡는 모든 것을 다시 써야 한다. 로컬에서 이름을 바꾸면
  // GroupRepository 가 저장된 Workspace 까지 rebase 하지만, 이름 변경이 **동기화로 들어오면** 그
  // 래퍼를 지나지 않아 아무도 rebase 하지 않았다 — groups/hosts 는 서버 값으로 맞춰지는데
  // Workspace 의 groupName 만 옛 경로를 가리켜, 사이드바에 그 Workspace 를 안은 유령 그룹이 남았다.
  it("동기화로 들어온 그룹 이름 변경을 저장된 Workspace 경로에도 적용한다", async () => {
    const harness = await createHarness(oldContext);
    const stateStorage = (
      harness.service as unknown as {
        stateStorage: {
          getState: () => {
            data: { savedWorkspaces: SavedWorkspaceRecord[] };
          };
          updateState: (mutate: (state: Record<string, any>) => void) => unknown;
        };
      }
    ).stateStorage;

    // 로컬은 아직 옛 경로("prod")를 안다.
    stateStorage.updateState((state) => {
      state.data.groups = [
        {
          id: "group-prod",
          name: "prod",
          path: "prod",
          parentPath: null,
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      ];
    });

    const staleWorkspace: SavedWorkspaceRecord = {
      ...savedWorkspace,
      groupName: "prod",
    };
    const payload: SyncPayloadV2 = {
      ...emptySyncPayload(),
      // 다른 기기가 prod → production 으로 바꿨다. 그룹 id 는 그대로여서 매핑을 알 수 있다.
      groups: [
        encryptRecord(
          "group-prod",
          {
            id: "group-prod",
            name: "production",
            path: "production",
            parentPath: null,
            createdAt: "2026-07-16T00:00:00.000Z",
            updatedAt: "2026-07-17T00:00:00.000Z",
          },
          oldContext.vaultKeyBase64,
        ),
      ],
      // 서버의 Workspace 사본은 아직 옛 경로를 가리킨다.
      workspaces: [
        encryptRecord(
          staleWorkspace.id,
          staleWorkspace,
          oldContext.vaultKeyBase64,
        ),
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(
            JSON.stringify({
              capabilities: {
                sync: { awsProfiles: true },
                vault: { e2ee: true },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"2"' },
        });
      }),
    );

    await harness.service.bootstrap();

    const [applied] = stateStorage.getState().data.savedWorkspaces;
    expect(applied?.groupName).toBe("production");
    // push 는 전체 목록을 보내므로, 고친 값이 서버에도 반영되도록 updatedAt 을 올려 둔다.
    expect(applied?.updatedAt).not.toBe(staleWorkspace.updatedAt);
  });

  it("경로가 그대로면 저장된 Workspace 를 건드리지 않는다", async () => {
    const harness = await createHarness(oldContext);
    const stateStorage = (
      harness.service as unknown as {
        stateStorage: {
          getState: () => {
            data: { savedWorkspaces: SavedWorkspaceRecord[] };
          };
        };
      }
    ).stateStorage;

    const grouped: SavedWorkspaceRecord = {
      ...savedWorkspace,
      groupName: "prod",
    };
    const payload: SyncPayloadV2 = {
      ...emptySyncPayload(),
      workspaces: [
        encryptRecord(grouped.id, grouped, oldContext.vaultKeyBase64),
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(
            JSON.stringify({
              capabilities: {
                sync: { awsProfiles: true },
                vault: { e2ee: true },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"2"' },
        });
      }),
    );

    await harness.service.bootstrap();

    expect(stateStorage.getState().data.savedWorkspaces).toEqual([grouped]);
  });

  it("purges account-scoped AWS artifacts after clearing the profile repository", async () => {
    const harness = await createHarness(oldContext);
    const purgeAwsArtifacts = vi.fn(async () => {
      expect(harness.awsProfiles.replaceAll).toHaveBeenCalledWith([]);
    });
    harness.service.setOnPurgedSyncedCache(purgeAwsArtifacts);

    await harness.service.purgeSyncedCache();

    expect(purgeAwsArtifacts).toHaveBeenCalledOnce();
  });

  it("keeps synced tailnet registrations persistent even when the payload is ephemeral", async () => {
    const harness = await createHarness(oldContext);
    const payload: SyncPayloadV2 = {
      ...emptySyncPayload(),
      tailnets: [
        encryptRecord(
          "net-1",
          {
            id: "net-1",
            label: "Work",
            ephemeral: true,
            authKey: "tskey-once",
            createdAt: "2026-07-16T00:00:00.000Z",
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
          oldContext.vaultKeyBase64,
        ),
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(
            JSON.stringify({
              capabilities: {
                sync: { awsProfiles: true },
                vault: { e2ee: true },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"2"',
          },
        });
      }),
    );

    await harness.service.bootstrap();

    const stateStorage = (
      harness.service as unknown as {
        stateStorage: { getState: () => { data: { tailnets: unknown[] } } };
      }
    ).stateStorage;
    expect(stateStorage.getState().data.tailnets).toEqual([
      expect.objectContaining({
        id: "net-1",
        hasAuthKey: true,
        ephemeral: false,
      }),
    ]);
  });

  it("finishes account bookkeeping even when runtime artifact cleanup fails", async () => {
    const harness = await createHarness(oldContext);
    const stateStorage = (
      harness.service as unknown as {
        stateStorage: {
          getSyncDataOwner: () => {
            userId: string | null;
            serverUrl: string | null;
          };
          updateSyncDataOwner: (owner: {
            userId: string | null;
            serverUrl: string | null;
          }) => void;
        };
      }
    ).stateStorage;
    stateStorage.updateSyncDataOwner({
      userId: oldContext.userId,
      serverUrl: oldContext.serverUrl,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const purgeAwsArtifacts = vi.fn(async () => {
      expect(harness.outbox.clearAll).toHaveBeenCalledOnce();
      expect(
        harness.settings.clearSyncedTerminalPreferences,
      ).toHaveBeenCalledOnce();
      expect(stateStorage.getSyncDataOwner()).toEqual({
        userId: null,
        serverUrl: null,
      });
      throw new Error("locked AWS cache file");
    });
    harness.service.setOnPurgedSyncedCache(purgeAwsArtifacts);

    await expect(harness.service.purgeSyncedCache()).resolves.toBeUndefined();

    expect(purgeAwsArtifacts).toHaveBeenCalledOnce();
    expect(harness.service.getState()).toMatchObject({
      status: "idle",
      pendingPush: false,
      errorMessage: null,
      lastDataChangeAt: null,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[sync] failed to purge account-scoped runtime artifacts",
      { message: "locked AWS cache file" },
    );
  });

  it("does not send a snapshot if reset and setup finish while secrets are loading", async () => {
    const harness = await createHarness(oldContext);
    const secretLoad = createDeferred<string | null>();
    harness.secretStore.load.mockReturnValue(secretLoad.promise);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    harness.service.markLocalChangesPendingPush();
    const push = harness.service.pushDirty();
    await vi.waitFor(() => expect(harness.secretStore.load).toHaveBeenCalled());

    harness.setContext(newContext);
    harness.service.resetVaultRecoveryState();
    secretLoad.resolve(managedSecret);
    await push;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.outbox.clearMany).not.toHaveBeenCalled();
    expect(harness.service.getState().status).toBe("paused");
  });

  it("starts the new generation without waiting for stale local IO", async () => {
    const harness = await createHarness(oldContext);
    const staleSecretLoad = createDeferred<string | null>();
    harness.secretStore.load
      .mockReturnValueOnce(staleSecretLoad.promise)
      .mockResolvedValue(managedSecret);
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ revision: 1 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    harness.service.markLocalChangesPendingPush();
    const stalePush = harness.service.pushDirty();
    await vi.waitFor(() =>
      expect(harness.secretStore.load).toHaveBeenCalledOnce(),
    );

    harness.setContext(newContext);
    harness.service.resetVaultRecoveryState();
    harness.service.markLocalChangesPendingPush();
    const currentPush = harness.service.pushDirty();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("X-Dolgate-Vault-Epoch")).toBe("3");
    const payload = JSON.parse(String(requestInit?.body)) as SyncPayloadV2;
    expect(
      decryptRecord<{ password: string }>(
        payload.secrets[0].encrypted_payload,
        newContext.vaultKeyBase64,
      ).password,
    ).toBe("secret-value");

    staleSecretLoad.resolve(managedSecret);
    await Promise.all([stalePush, currentPush]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(harness.outbox.clearMany).toHaveBeenCalledOnce();
    expect(harness.service.getState().status).toBe("ready");
  });

  it("clears a queued push that becomes stale before its callback starts", async () => {
    const harness = await createHarness(oldContext);
    harness.secretStore.load.mockResolvedValue(managedSecret);
    const queueGate = createDeferred<void>();
    (
      harness.service as unknown as {
        operationTail: Promise<void>;
      }
    ).operationTail = queueGate.promise;
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ revision: 1 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    harness.service.markLocalChangesPendingPush();
    const skippedPush = harness.service.pushDirty();
    harness.setContext(newContext);
    queueGate.resolve();
    await skippedPush;

    expect(fetchMock).not.toHaveBeenCalled();

    await harness.service.pushDirty();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(requestInit?.headers).get("X-Dolgate-Vault-Epoch")).toBe(
      "3",
    );
  });

  it("keeps the captured epoch on an in-flight push and discards its late response", async () => {
    const harness = await createHarness(oldContext);
    harness.secretStore.load.mockResolvedValue(managedSecret);
    const responseBody = createDeferred<{ revision: number }>();
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      requestInit = init;
      return {
        ok: true,
        status: 202,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => responseBody.promise,
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    harness.service.markLocalChangesPendingPush();
    const push = harness.service.pushDirty();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const headers = new Headers(requestInit?.headers);
    expect(headers.get("X-Dolgate-Vault-Epoch")).toBe("1");
    const payload = JSON.parse(String(requestInit?.body)) as SyncPayloadV2;
    expect(
      decryptRecord<{ password: string }>(
        payload.secrets[0].encrypted_payload,
        oldContext.vaultKeyBase64,
      ).password,
    ).toBe("secret-value");

    harness.setContext(newContext);
    harness.service.resetVaultRecoveryState();
    responseBody.resolve({ revision: 2 });
    await push;

    expect(harness.outbox.clearMany).not.toHaveBeenCalled();
    expect(harness.service.getState().status).toBe("paused");
  });

  it("does not let stale 409 recovery pause a newer vault generation", async () => {
    const harness = await createHarness(oldContext);
    harness.secretStore.load.mockResolvedValue(managedSecret);
    const staleRecovery = createDeferred<void>();
    harness.authService.handleVaultDekRejected.mockReturnValue(
      staleRecovery.promise,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "vault_reset",
            error: "The vault generation changed.",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: 1 }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    harness.service.markLocalChangesPendingPush();
    const stalePush = harness.service.pushDirty();
    await vi.waitFor(() =>
      expect(harness.authService.handleVaultDekRejected).toHaveBeenCalledOnce(),
    );

    harness.setContext(newContext);
    harness.service.resetVaultRecoveryState();
    harness.service.markLocalChangesPendingPush();
    const currentPush = harness.service.pushDirty();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await currentPush;

    staleRecovery.resolve();
    await stalePush;

    expect(harness.service.getState().status).toBe("ready");
    expect(harness.service.getState().pendingPush).toBe(false);
  });

  it("does not let 409 recovery pause a changed same-generation context", async () => {
    const harness = await createHarness(oldContext);
    harness.secretStore.load.mockResolvedValue(managedSecret);
    const recovery = createDeferred<void>();
    harness.authService.handleVaultDekRejected.mockReturnValue(
      recovery.promise,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "vault_reset",
            error: "The vault generation changed.",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    harness.service.markLocalChangesPendingPush();
    const push = harness.service.pushDirty();
    await vi.waitFor(() =>
      expect(harness.authService.handleVaultDekRejected).toHaveBeenCalledOnce(),
    );

    harness.setContext(newContext);
    recovery.resolve();
    await push;

    expect(harness.service.getState().status).not.toBe("paused");
    expect(harness.service.getState().errorMessage).toBeNull();
  });

  it("uses the new DEK and epoch together on the next generation", async () => {
    const harness = await createHarness(newContext);
    harness.secretStore.load.mockResolvedValue(managedSecret);
    let requestInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        requestInit = init;
        return new Response(JSON.stringify({ revision: 1 }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    harness.service.markLocalChangesPendingPush();
    await harness.service.pushDirty();

    const headers = new Headers(requestInit?.headers);
    expect(headers.get("X-Dolgate-Vault-Epoch")).toBe("3");
    const payload = JSON.parse(String(requestInit?.body)) as SyncPayloadV2;
    expect(
      decryptRecord<{ password: string }>(
        payload.secrets[0].encrypted_payload,
        newContext.vaultKeyBase64,
      ).password,
    ).toBe("secret-value");
    expect(harness.outbox.clearMany).toHaveBeenCalledWith([]);
    expect(harness.service.getState().status).toBe("ready");
  });

  it("aborts and ignores a pull response from an invalidated generation", async () => {
    const harness = await createHarness(oldContext);
    harness.secretStore.load.mockResolvedValue(managedSecret);
    const syncResponse = createDeferred<Response>();
    const applied = vi.fn();
    harness.service.setOnAppliedSnapshot(applied);
    let syncSignal: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(
            JSON.stringify({
              capabilities: {
                sync: { awsProfiles: true },
                vault: { e2ee: true },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        syncSignal = init?.signal ?? null;
        return syncResponse.promise;
      }),
    );

    const bootstrap = harness.service.bootstrap();
    await vi.waitFor(() => expect(syncSignal).not.toBeNull());
    harness.setContext(newContext);
    harness.service.resetVaultRecoveryState();
    expect((syncSignal as AbortSignal | null)?.aborted).toBe(true);
    syncResponse.resolve(
      new Response(JSON.stringify(emptySyncPayload()), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: '"2"',
        },
      }),
    );
    await bootstrap;

    expect(applied).not.toHaveBeenCalled();
    expect(harness.service.getState().status).toBe("paused");
  });

  it("does not let decode recovery pause a changed same-generation context", async () => {
    const harness = await createHarness(oldContext);
    const recovery = createDeferred<void>();
    harness.authService.handleVaultDekRejected.mockReturnValue(
      recovery.promise,
    );
    const corruptedPayload: SyncPayloadV2 = {
      ...emptySyncPayload(),
      groups: [
        {
          id: "corrupted-group",
          encrypted_payload: "not-an-encrypted-payload",
          updated_at: "2026-07-16T00:00:00.000Z",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(
            JSON.stringify({
              capabilities: {
                sync: { awsProfiles: true },
                vault: { e2ee: true },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(corruptedPayload), {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"2"',
          },
        });
      }),
    );

    const bootstrap = harness.service.bootstrap();
    await vi.waitFor(() =>
      expect(harness.authService.handleVaultDekRejected).toHaveBeenCalledOnce(),
    );

    harness.setContext(newContext);
    recovery.resolve();
    await bootstrap;

    expect(harness.service.getState().status).not.toBe("paused");
    expect(harness.service.getState().errorMessage).toBeNull();
  });

  it("serializes bootstrap and push within the same generation", async () => {
    const harness = await createHarness(oldContext);
    harness.secretStore.load.mockResolvedValue(managedSecret);
    const pullResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (url: URL) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/info") {
        return new Response(
          JSON.stringify({
            capabilities: {
              sync: { awsProfiles: true },
              vault: { e2ee: true },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (fetchMock.mock.calls.length === 2) {
        return pullResponse.promise;
      }
      return new Response(JSON.stringify({ revision: 1 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bootstrap = harness.service.bootstrap();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const push = harness.service.pushDirty();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    pullResponse.resolve(new Response(null, { status: 304 }));
    await bootstrap;
    await push;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(harness.service.getState().status).toBe("ready");
  });

  it("does not classify a temporary server-info failure as E2EE unsupported", async () => {
    const harness = await createHarness(oldContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 304 });
      }),
    );

    await harness.service.bootstrap();

    expect(harness.authService.noteServerVaultSupport).not.toHaveBeenCalled();
    expect(harness.service.getState().awsProfilesServerSupport).toBe("unknown");
  });
});
