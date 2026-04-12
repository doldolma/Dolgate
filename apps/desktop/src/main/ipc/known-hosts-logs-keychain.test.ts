import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../../common/ipc-channels';

const ipcHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

import { registerKnownHostsLogsKeychainIpcHandlers } from './known-hosts-logs-keychain';

function createContext() {
  return {
    knownHosts: {
      list: vi.fn(),
      trust: vi.fn(),
      remove: vi.fn(),
    },
    buildHostKeyProbeResult: vi.fn(),
    emitContainersConnectionProgress: vi.fn(),
    emitSftpConnectionProgress: vi.fn(),
    activityLogs: {
      append: vi.fn(),
      list: vi.fn(),
      clear: vi.fn(),
    },
    sessionReplayService: {
      openReplayWindow: vi.fn(),
      get: vi.fn(),
    },
    resolveWindowFromSender: vi.fn(),
    secretMetadata: {
      list: vi.fn(),
      remove: vi.fn(),
      getBySecretRef: vi.fn(),
      upsert: vi.fn(),
    },
    secretStore: {
      load: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    },
    hosts: {
      clearSecretRef: vi.fn(),
      getById: vi.fn(),
      updateSecretRef: vi.fn(),
    },
    syncOutbox: {
      upsertDeletion: vi.fn(),
    },
    loadSecrets: vi.fn(),
    mergeSecrets: vi.fn((current, patch) => ({
      password: patch.password !== undefined ? patch.password : current.password,
      passphrase:
        patch.passphrase !== undefined ? patch.passphrase : current.passphrase,
      privateKeyPem:
        patch.privateKeyPem !== undefined
          ? patch.privateKeyPem
          : current.privateKeyPem,
      certificateText:
        patch.certificateText !== undefined
          ? patch.certificateText
          : current.certificateText,
    })),
    hasSecretValue: vi.fn((secrets) =>
      Boolean(
        secrets.password ||
          secrets.passphrase ||
          secrets.privateKeyPem ||
          secrets.certificateText,
      ),
    ),
    assertSshHost: vi.fn(),
    persistSecret: vi.fn(),
    describeHostLabel: vi.fn(),
    queueSync: vi.fn(),
  } as any;
}

describe('registerKnownHostsLogsKeychainIpcHandlers', () => {
  beforeEach(() => {
    ipcHandlers.clear();
  });

  it('recomputes key and certificate metadata from the merged secret payload', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-1',
      label: 'Old certificate secret',
      hasPassword: false,
      hasPassphrase: false,
      hasManagedPrivateKey: true,
      hasCertificate: true,
      source: 'local_keychain',
    });
    ctx.loadSecrets.mockResolvedValue({});

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const updateHandler = ipcHandlers.get(ipcChannels.keychain.update);
    expect(updateHandler).toBeTypeOf('function');

    await updateHandler?.(null, {
      secretRef: 'secret-1',
      secrets: {
        password: 'new-password',
      },
    });

    expect(ctx.secretMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        secretRef: 'secret-1',
        hasPassword: true,
        hasManagedPrivateKey: false,
        hasCertificate: false,
      }),
    );
  });
});
