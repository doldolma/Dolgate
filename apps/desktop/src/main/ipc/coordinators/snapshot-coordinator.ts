import type {
  DesktopBootstrapSnapshot,
  DesktopSyncedWorkspaceSnapshot,
} from "@shared";
import type {
  ActivityLogRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  SecretMetadataRepository,
  SettingsRepository,
} from "../../database";
import type { LocalFileService } from "../../file-service";
import type { CoreManager } from "../../core-manager";
import type { DnsPortForwardCoordinator } from "./dns-port-forward-coordinator";

export interface SnapshotCoordinator {
  getInitialBootstrapSnapshot: (
    ownerWebContentsId?: number,
  ) => Promise<DesktopBootstrapSnapshot>;
  getSyncedWorkspaceSnapshot: () => Promise<DesktopSyncedWorkspaceSnapshot>;
}

export function createSnapshotCoordinator(deps: {
  hosts: HostRepository;
  groups: GroupRepository;
  settings: SettingsRepository;
  knownHosts: KnownHostRepository;
  activityLogs: ActivityLogRepository;
  secretMetadata: SecretMetadataRepository;
  coreManager: CoreManager;
  localFiles: LocalFileService;
  dnsPortForwardCoordinator: DnsPortForwardCoordinator;
}): SnapshotCoordinator {
  const {
    hosts,
    groups,
    settings,
    knownHosts,
    activityLogs,
    secretMetadata,
    coreManager,
    localFiles,
    dnsPortForwardCoordinator,
  } = deps;

  const getInitialBootstrapSnapshot =
    async (ownerWebContentsId?: number): Promise<DesktopBootstrapSnapshot> => {
      const [
        nextHosts,
        nextGroups,
        tabs,
        nextSettings,
        localHomePath,
        portForwardSnapshot,
        resolvedDnsOverrides,
        nextKnownHosts,
        nextActivityLogs,
        nextKeychainEntries,
      ] = await Promise.all([
        hosts.list(),
        groups.list(),
        coreManager.listTabs(ownerWebContentsId),
        settings.get(),
        localFiles.getHomeDirectory(),
        Promise.resolve(dnsPortForwardCoordinator.listPortForwardSnapshot()),
        Promise.resolve(dnsPortForwardCoordinator.listResolvedDnsOverrides()),
        knownHosts.list(),
        activityLogs.list(),
        secretMetadata.list(),
      ]);
      const localHomeListing = await localFiles.list(localHomePath);
      return {
        hosts: nextHosts,
        groups: nextGroups,
        tabs,
        settings: nextSettings,
        localHomePath,
        localHomeListing,
        portForwardSnapshot,
        dnsOverrides: resolvedDnsOverrides,
        knownHosts: nextKnownHosts,
        activityLogs: nextActivityLogs,
        keychainEntries: nextKeychainEntries,
      };
    };

  const getSyncedWorkspaceSnapshot =
    async (): Promise<DesktopSyncedWorkspaceSnapshot> => ({
      hosts: hosts.list(),
      groups: groups.list(),
      settings: settings.get(),
      portForwardSnapshot: dnsPortForwardCoordinator.listPortForwardSnapshot(),
      dnsOverrides: dnsPortForwardCoordinator.listResolvedDnsOverrides(),
      knownHosts: knownHosts.list(),
      keychainEntries: secretMetadata.list(),
    });

  return {
    getInitialBootstrapSnapshot,
    getSyncedWorkspaceSnapshot,
  };
}
