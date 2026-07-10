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

// OS 보안 저장소가 "실제로" 쓸 만한지 — isEncryptionAvailable 만으로는 부족하다.
// Linux 에서 키링이 잠겨 있으면(대표: 우분투 자동 로그인 → GNOME Keyring 미해제)
// Chromium 이 조용히 basic_text(사실상 평문) 백엔드로 폴백하는데, 이때도
// isEncryptionAvailable 은 true 라서 기존 키링-암호화 시크릿의 복호화가 전부 실패해
// 호스트/로그인이 빈 상태로 뜬다. 그래서 Linux 는 선택된 백엔드까지 확인한다.
// (mac/win 은 isEncryptionAvailable 판정으로 충분)
export function isSecureStorageUsable(): boolean {
  if (allowInsecureSecretStorageForTests()) {
    return true;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return false;
  }
  if (process.platform === "linux") {
    try {
      if (safeStorage.getSelectedStorageBackend() === "basic_text") {
        return false;
      }
    } catch {
      // 백엔드 조회가 불가능한 환경이면 isEncryptionAvailable 판정만 쓴다.
    }
  }
  return true;
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

export function encodeSecretForStorage(secret: string): StoredEncryptedValue {
  return encodeSecret(secret);
}

export function decodeSecretFromStorage(record: StoredEncryptedValue): string | null {
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
    return decodeSecretFromStorage(record);
  }

  async remove(account: string): Promise<void> {
    this.storage.deleteSecureValue(account);
    if (account === REFRESH_TOKEN_ACCOUNT) {
      return;
    }
  }
}
