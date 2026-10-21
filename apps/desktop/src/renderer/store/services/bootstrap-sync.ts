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
  // 볼트 표와 팀 사용 가능 여부. 못 읽어도 다른 목록 읽기를 막지 않는다 — 그때는 지금 값을 그대로 둔다.
  const loadVaultIndex = () => api.teams.getVaultIndex().catch(() => null);
  const loadTeamAvailability = () => api.teams.getAvailability().catch(() => null);

  const syncOperationalData = async (set: StoreSetter) => {
    const [snapshot, dnsOverrides, knownHosts, activityLogs, keychainEntries, snippets, savedWorkspaces, vaultIndex] =
      await Promise.all([
        api.portForwards.list(),
        api.dnsOverrides.list(),
        api.knownHosts.list(),
        api.logs.list(),
        api.keychain.list(),
        api.snippets.list(),
        api.savedWorkspaces.list(),
        loadVaultIndex(),
      ]);

    set({
      portForwards: sortPortForwards(snapshot.rules),
      dnsOverrides: sortDnsOverrides(dnsOverrides),
      portForwardRuntimes: snapshot.runtimes,
      knownHosts: sortKnownHosts(knownHosts),
      activityLogs: sortLogs(activityLogs),
      keychainEntries: sortKeychainEntries(keychainEntries),
      snippets,
      savedWorkspaces,
      ...(vaultIndex ? { vaultIndex } : {}),
    } satisfies Partial<AppState>);
  };

  const syncSyncedWorkspaceData = async (set: StoreSetter) => {
    const [snapshot, snippets, savedWorkspaces, vaultIndex, teamAvailability] = await Promise.all([
      api.bootstrap.getSyncedWorkspaceSnapshot(),
      api.snippets.list(),
      api.savedWorkspaces.list(),
      loadVaultIndex(),
      loadTeamAvailability(),
    ]);

    set({
      hosts: sortHosts(snapshot.hosts),
      groups: sortGroups(snapshot.groups),
      portForwards: sortPortForwards(snapshot.portForwardSnapshot.rules),
      dnsOverrides: sortDnsOverrides(snapshot.dnsOverrides),
      portForwardRuntimes: snapshot.portForwardSnapshot.runtimes,
      knownHosts: sortKnownHosts(snapshot.knownHosts),
      keychainEntries: sortKeychainEntries(snapshot.keychainEntries),
      settings: snapshot.settings,
      snippets,
      savedWorkspaces,
      ...(vaultIndex ? { vaultIndex } : {}),
      ...(teamAvailability ? { teamAvailability } : {}),
    } satisfies Partial<AppState>);
  };

  const refreshHostAndKeychainState = async (set: StoreSetter) => {
    const [hosts, keychainEntries, vaultIndex] = await Promise.all([
      api.hosts.list(),
      api.keychain.list(),
      loadVaultIndex(),
    ]);
    set({
      hosts: sortHosts(hosts),
      keychainEntries: sortKeychainEntries(keychainEntries),
      ...(vaultIndex ? { vaultIndex } : {}),
    } satisfies Partial<AppState>);
  };

  return {
    loadVaultIndex,
    loadTeamAvailability,
    syncOperationalData,
    syncSyncedWorkspaceData,
    refreshHostAndKeychainState,
  };
}
