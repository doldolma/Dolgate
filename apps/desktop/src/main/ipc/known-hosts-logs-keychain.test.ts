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
    inspectCertificate: vi.fn(),
    hosts: {
      clearSecretRef: vi.fn(),
      getById: vi.fn(),
      updateSecretRef: vi.fn(),
    },
    syncOutbox: {
      upsertDeletion: vi.fn(),
    },
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

  it('includes certificate validity info when loading a certificate secret', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-1',
      label: 'Prod certificate',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    ctx.secretStore.load.mockResolvedValue(
      JSON.stringify({
        secretRef: 'secret-1',
        label: 'Prod certificate',
        privateKeyPem: 'PRIVATE KEY',
        certificateText: 'CERTIFICATE',
        updatedAt: '2026-04-12T00:00:00.000Z',
      }),
    );
    ctx.inspectCertificate.mockResolvedValue({
      status: 'expired',
      validBefore: '2026-04-11T00:00:00.000Z',
      principals: ['ubuntu'],
    });

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const loadHandler = ipcHandlers.get(ipcChannels.keychain.load);
    expect(loadHandler).toBeTypeOf('function');

    await expect(loadHandler?.(null, 'secret-1')).resolves.toMatchObject({
      secretRef: 'secret-1',
      certificateInfo: {
        status: 'expired',
        validBefore: '2026-04-11T00:00:00.000Z',
        principals: ['ubuntu'],
      },
    });
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
    });
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

  it('treats update payload as a full replacement instead of merging old fields', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-1',
      label: 'Mixed secret',
      hasPassword: true,
      hasPassphrase: true,
      hasManagedPrivateKey: true,
      hasCertificate: true,
    });

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const updateHandler = ipcHandlers.get(ipcChannels.keychain.update);
    expect(updateHandler).toBeTypeOf('function');

    await updateHandler?.(null, {
      secretRef: 'secret-1',
      secrets: {
        privateKeyPem: 'PRIVATE KEY',
      },
    });

    expect(ctx.secretStore.save).toHaveBeenCalledWith(
      'secret-1',
      expect.stringContaining('"privateKeyPem":"PRIVATE KEY"'),
    );
    expect(ctx.secretStore.save).not.toHaveBeenCalledWith(
      'secret-1',
      expect.stringContaining('"password"'),
    );
    expect(ctx.secretMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        hasPassword: false,
        hasPassphrase: false,
        hasManagedPrivateKey: true,
        hasCertificate: false,
      }),
    );
  });

  it('creates host-specific clones from the replacement payload only', async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: 'host-1',
      kind: 'ssh',
      label: 'Prod',
      secretRef: 'secret-1',
    });
    ctx.describeHostLabel.mockReturnValue('Prod');
    ctx.persistSecret.mockResolvedValue('secret-2');

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const cloneHandler = ipcHandlers.get(ipcChannels.keychain.cloneForHost);
    expect(cloneHandler).toBeTypeOf('function');

    await cloneHandler?.(null, {
      hostId: 'host-1',
      sourceSecretRef: 'secret-1',
      secrets: {
        certificateText: 'ssh-ed25519-cert-v01@openssh.com AAA',
        privateKeyPem: 'PRIVATE KEY',
      },
    });

    expect(ctx.persistSecret).toHaveBeenCalledWith('Prod', {
      password: undefined,
      passphrase: undefined,
      privateKeyPem: 'PRIVATE KEY',
      certificateText: 'ssh-ed25519-cert-v01@openssh.com AAA',
    });
    expect(ctx.hosts.updateSecretRef).toHaveBeenCalledWith('host-1', 'secret-2');
  });
});
