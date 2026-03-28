import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir = "";
let encryptionAvailable = true;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === "userData" ? tempDir : os.tmpdir(),
    ),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => encryptionAvailable),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) =>
      Buffer.from(value).toString("utf8"),
    ),
  },
}));

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
