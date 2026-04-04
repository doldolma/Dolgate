import type { AppState } from "../types";
import type { SliceDeps } from "./context";
import {
  sortDnsOverrides,
  sortGroups,
  sortHosts,
  sortKeychainEntries,
  sortKnownHosts,
  sortLogs,
  sortPortForwards,
} from "../utils";

type StoreSetter = SliceDeps["set"];

export function createBootstrapSyncServices({ api }: SliceDeps) {
  const syncOperationalData = async (set: StoreSetter) => {
    const [snapshot, dnsOverrides, knownHosts, activityLogs, keychainEntries] =
      await Promise.all([
        api.portForwards.list(),
        api.dnsOverrides.list(),
        api.knownHosts.list(),
        api.logs.list(),
        api.keychain.list(),
      ]);

    set({
      portForwards: sortPortForwards(snapshot.rules),
      dnsOverrides: sortDnsOverrides(dnsOverrides),
      portForwardRuntimes: snapshot.runtimes,
      knownHosts: sortKnownHosts(knownHosts),
      activityLogs: sortLogs(activityLogs),
      keychainEntries: sortKeychainEntries(keychainEntries),
    } satisfies Partial<AppState>);
  };

  const syncSyncedWorkspaceData = async (set: StoreSetter) => {
    const snapshot = await api.bootstrap.getSyncedWorkspaceSnapshot();

    set({
      hosts: sortHosts(snapshot.hosts),
      groups: sortGroups(snapshot.groups),
      portForwards: sortPortForwards(snapshot.portForwardSnapshot.rules),
      dnsOverrides: sortDnsOverrides(snapshot.dnsOverrides),
      portForwardRuntimes: snapshot.portForwardSnapshot.runtimes,
      knownHosts: sortKnownHosts(snapshot.knownHosts),
      keychainEntries: sortKeychainEntries(snapshot.keychainEntries),
      settings: snapshot.settings,
    } satisfies Partial<AppState>);
  };

  const refreshHostAndKeychainState = async (set: StoreSetter) => {
    const [hosts, keychainEntries] = await Promise.all([
      api.hosts.list(),
      api.keychain.list(),
    ]);
    set({
      hosts: sortHosts(hosts),
      keychainEntries: sortKeychainEntries(keychainEntries),
    } satisfies Partial<AppState>);
  };

  return {
    syncOperationalData,
    syncSyncedWorkspaceData,
    refreshHostAndKeychainState,
  };
}
