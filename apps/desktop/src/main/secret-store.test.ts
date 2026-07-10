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
