import { safeStorage } from "electron";
import {
  getDesktopStateStorage,
  type StoredEncryptedValue,
} from "./state-storage";

const REFRESH_TOKEN_ACCOUNT = "auth:refresh-token";
const insecureSecretStorageOverrideEnv =
  "DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS";

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super(
      "이 환경에서는 안전한 저장소를 사용할 수 없어 secret을 저장할 수 없습니다.",
    );
    this.name = "SecureStorageUnavailableError";
  }
}

function allowInsecureSecretStorageForTests(): boolean {
  return process.env[insecureSecretStorageOverrideEnv] === "true";
}

function encodeSecret(secret: string): StoredEncryptedValue {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypted: true,
      value: safeStorage.encryptString(secret).toString("base64"),
    };
  }

  if (!allowInsecureSecretStorageForTests()) {
    throw new SecureStorageUnavailableError();
  }

  return {
    encrypted: false,
    value: Buffer.from(secret, "utf8").toString("base64"),
  };
}

function decodeSecret(record: StoredEncryptedValue): string | null {
  try {
    if (record.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        return null;
      }
      return safeStorage.decryptString(Buffer.from(record.value, "base64"));
    }
    if (!allowInsecureSecretStorageForTests()) {
      return null;
    }
    return Buffer.from(record.value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export class SecretStore {
  private readonly storage = getDesktopStateStorage();

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async save(account: string, secret: string): Promise<string> {
    this.storage.writeSecureValue(account, encodeSecret(secret));
    return account;
  }

  async load(account: string): Promise<string | null> {
    const record = this.storage.readSecureValue(account);
    if (!record) {
      return null;
    }
    return decodeSecret(record);
  }

  async remove(account: string): Promise<void> {
    this.storage.deleteSecureValue(account);
    if (account === REFRESH_TOKEN_ACCOUNT) {
      return;
    }
  }
}
