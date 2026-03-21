import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../../main/sync-service';

function createSyncService() {
  const hosts = {
    replaceAll: vi.fn()
  };
  const groups = {
    replaceAll: vi.fn()
  };
  const portForwards = {
    replaceAll: vi.fn()
  };
  const knownHosts = {
    replaceAll: vi.fn()
  };
  const secretMetadata = {
    list: vi.fn().mockReturnValue([
      {
        secretRef: 'secret:local',
        label: 'Local Secret',
        hasPassword: true,
        hasPassphrase: false,
        hasManagedPrivateKey: false,
        source: 'local_keychain',
        linkedHostCount: 1,
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      {
        secretRef: 'secret:server',
        label: 'Server Secret',
        hasPassword: false,
        hasPassphrase: true,
        hasManagedPrivateKey: true,
        source: 'server_managed',
        linkedHostCount: 2,
        updatedAt: '2026-03-22T00:00:00.000Z'
      }
    ]),
    remove: vi.fn()
  };
  const secretStore = {
    remove: vi.fn().mockResolvedValue(undefined)
  };
  const outbox = {
    clearAll: vi.fn()
  };
  const activityLogs = {
    append: vi.fn()
  };

  const service = new SyncService(
    {} as never,
    hosts as never,
    groups as never,
    portForwards as never,
    knownHosts as never,
    secretMetadata as never,
    secretStore as never,
    outbox as never,
    activityLogs as never
  );

  return {
    service,
    hosts,
    groups,
    portForwards,
    knownHosts,
    secretMetadata,
    secretStore,
    outbox
  };
}

describe('SyncService', () => {
  it('purges all synced cache and every local secret on logout', async () => {
    const { service, hosts, groups, portForwards, knownHosts, secretMetadata, secretStore, outbox } = createSyncService();

    await service.purgeSyncedCache();

    expect(secretStore.remove).toHaveBeenCalledTimes(2);
    expect(secretStore.remove).toHaveBeenCalledWith('secret:local');
    expect(secretStore.remove).toHaveBeenCalledWith('secret:server');
    expect(secretMetadata.remove).toHaveBeenCalledTimes(2);
    expect(secretMetadata.remove).toHaveBeenCalledWith('secret:local');
    expect(secretMetadata.remove).toHaveBeenCalledWith('secret:server');
    expect(hosts.replaceAll).toHaveBeenCalledWith([]);
    expect(groups.replaceAll).toHaveBeenCalledWith([]);
    expect(knownHosts.replaceAll).toHaveBeenCalledWith([]);
    expect(portForwards.replaceAll).toHaveBeenCalledWith([]);
    expect(outbox.clearAll).toHaveBeenCalledWith();
    expect(service.getState()).toEqual({
      status: 'idle',
      lastSuccessfulSyncAt: null,
      pendingPush: false,
      errorMessage: null
    });
  });
});
