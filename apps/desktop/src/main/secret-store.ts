import { safeStorage } from 'electron';
import { getDesktopStateStorage, type StoredEncryptedValue } from './state-storage';

const REFRESH_TOKEN_ACCOUNT = 'auth:refresh-token';

function encodeSecret(secret: string): StoredEncryptedValue {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypted: true,
      value: safeStorage.encryptString(secret).toString('base64')
    };
  }

  return {
    encrypted: false,
    value: Buffer.from(secret, 'utf8').toString('base64')
  };
}

function decodeSecret(record: StoredEncryptedValue): string | null {
  try {
    if (record.encrypted) {
      return safeStorage.decryptString(Buffer.from(record.value, 'base64'));
    }
    return Buffer.from(record.value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export class SecretStore {
  private readonly storage = getDesktopStateStorage();

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

