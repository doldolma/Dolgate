import keytar from 'keytar';

const SERVICE_NAME = 'KeyTerm';

export class SecretStore {
  async save(account: string, secret: string): Promise<string> {
    await keytar.setPassword(SERVICE_NAME, account, secret);
    return account;
  }

  async load(account: string): Promise<string | null> {
    return keytar.getPassword(SERVICE_NAME, account);
  }

  async remove(account: string): Promise<void> {
    await keytar.deletePassword(SERVICE_NAME, account);
  }
}
