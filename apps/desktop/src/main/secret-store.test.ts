import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir = "";
let encryptionAvailable = true;
let storageBackend = "gnome_libsecret";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === "userData" ? tempDir : os.tmpdir(),
    ),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => encryptionAvailable),
    getSelectedStorageBackend: vi.fn(() => storageBackend),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) =>
      Buffer.from(value).toString("utf8"),
    ),
  },
}));

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

async function loadModules() {
  vi.resetModules();
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  const stateStorageModule = await import("./state-storage");
  stateStorageModule.resetDesktopStateStorageForTests();
  const secretStoreModule = await import("./secret-store");
  return {
    stateStorageModule,
    secretStoreModule,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolssh-secret-store-"));
  encryptionAvailable = true;
  storageBackend = "gnome_libsecret";
});

afterEach(() => {
  delete process.env.DOLSSH_USER_DATA_DIR;
  delete process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("SecretStore", () => {
  it("rejects saving secrets when secure storage is unavailable", async () => {
    encryptionAvailable = false;
    const { secretStoreModule } = await loadModules();
    const secretStore = new secretStoreModule.SecretStore();

    await expect(
      secretStore.save("secret:test", "top-secret"),
    ).rejects.toBeInstanceOf(secretStoreModule.SecureStorageUnavailableError);
  });

  it("ignores legacy unencrypted secrets when insecure test override is disabled", async () => {
    encryptionAvailable = false;
    const { stateStorageModule, secretStoreModule } = await loadModules();
    stateStorageModule
      .getDesktopStateStorage()
      .writeSecureValue("secret:test", {
        encrypted: false,
        value: Buffer.from("legacy-secret", "utf8").toString("base64"),
      });

    const secretStore = new secretStoreModule.SecretStore();
    await expect(secretStore.load("secret:test")).resolves.toBeNull();
  });

  it("allows insecure secret storage only with the explicit test override", async () => {
    encryptionAvailable = false;
    process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";
    const { secretStoreModule } = await loadModules();
    const secretStore = new secretStoreModule.SecretStore();

    await secretStore.save("secret:test", "top-secret");
    await expect(secretStore.load("secret:test")).resolves.toBe("top-secret");
  });

  it("keeps app secrets (auth:*, ai:*) when a sync snapshot replaces managed secrets wholesale", async () => {
    const { stateStorageModule, secretStoreModule } = await loadModules();
    const secretStore = new secretStoreModule.SecretStore();

    await secretStore.save("auth:vault-dek", "dek-value");
    await secretStore.save("ai:apiKey:anthropic", "sk-ant");

    // sync-service 가 스냅샷 적용 시 수행하는 것과 동일한 통째 교체
    stateStorageModule.getDesktopStateStorage().updateState((state) => {
      state.secure.managedSecretsByRef = {
        "secret:remote": {
          encrypted: true,
          value: Buffer.from("remote-secret", "utf8").toString("base64"),
        },
      };
    });

    await expect(secretStore.load("auth:vault-dek")).resolves.toBe("dek-value");
    await expect(secretStore.load("ai:apiKey:anthropic")).resolves.toBe("sk-ant");
    await expect(secretStore.load("secret:remote")).resolves.toBe("remote-secret");
  });

  it("migrates app secrets stored in managedSecretsByRef by older builds", async () => {
    const first = await loadModules();
    first.stateStorageModule.getDesktopStateStorage().updateState((state) => {
      // 과거 빌드가 앱 시크릿을 sync 교체 대상 맵에 저장하던 레이아웃을 재현
      state.secure.managedSecretsByRef["auth:vault-dek"] = {
        encrypted: true,
        value: Buffer.from("legacy-dek", "utf8").toString("base64"),
      };
    });

    const second = await loadModules();
    const secretStore = new second.secretStoreModule.SecretStore();
    await expect(secretStore.load("auth:vault-dek")).resolves.toBe("legacy-dek");

    // 이전 후에는 sync 통째 교체가 일어나도 지워지지 않는다
    second.stateStorageModule.getDesktopStateStorage().updateState((state) => {
      state.secure.managedSecretsByRef = {};
    });
    await expect(secretStore.load("auth:vault-dek")).resolves.toBe("legacy-dek");
  });
});

describe("isSecureStorageUsable", () => {
  it("is false when encryption is unavailable", async () => {
    encryptionAvailable = false;
    const { secretStoreModule } = await loadModules();
    expect(secretStoreModule.isSecureStorageUsable()).toBe(false);
  });

  it("treats the Linux basic_text fallback (locked keyring) as unusable", async () => {
    // 우분투 자동 로그인 등으로 키링이 잠기면 isEncryptionAvailable 은 true 인 채
    // basic_text 로 폴백한다 — 이 조합을 사용 불가로 판정해야 한다.
    storageBackend = "basic_text";
    const { secretStoreModule } = await loadModules();
    expect(withPlatform("linux", () => secretStoreModule.isSecureStorageUsable())).toBe(false);
    // mac/win 은 백엔드 개념이 없어 영향 없음.
    expect(withPlatform("darwin", () => secretStoreModule.isSecureStorageUsable())).toBe(true);
    expect(withPlatform("win32", () => secretStoreModule.isSecureStorageUsable())).toBe(true);
  });

  it("is true on Linux with a real keyring backend", async () => {
    storageBackend = "gnome_libsecret";
    const { secretStoreModule } = await loadModules();
    expect(withPlatform("linux", () => secretStoreModule.isSecureStorageUsable())).toBe(true);
  });

  it("honors the explicit insecure test override (e2e)", async () => {
    encryptionAvailable = false;
    process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";
    const { secretStoreModule } = await loadModules();
    expect(secretStoreModule.isSecureStorageUsable()).toBe(true);
  });
});
