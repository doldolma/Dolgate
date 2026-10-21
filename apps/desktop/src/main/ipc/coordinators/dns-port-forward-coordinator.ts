import type { DnsOverrideResolvedRecord, PortForwardRuntimeRecord } from "@shared";
import type { CoreManager } from "../../core-manager";
import type { PortForwardRepository } from "../../database";
import {
  collectActiveDnsOverrideEntriesAcrossVaults,
  type DnsOverrideVault,
  HostsOverrideManager,
  listStaticDnsOverrideIds,
  resolveDnsOverrideRecordsAcrossVaults,
} from "../../hosts-override-manager";
import type { VaultCatalog } from "../../vault-catalog";

export interface DnsPortForwardCoordinator {
  listPortForwardSnapshot: () => {
    rules: ReturnType<PortForwardRepository["list"]>;
    runtimes: ReturnType<CoreManager["listPortForwardRuntimes"]>;
  };
  listResolvedDnsOverrides: () => DnsOverrideResolvedRecord[];
  rewriteActiveDnsOverrides: (
    runtimeOverride?: PortForwardRuntimeRecord[],
  ) => Promise<void>;
  stopPortForwardWithDnsOverrideCleanup: (ruleId: string) => Promise<void>;
}

export function createDnsPortForwardCoordinator(deps: {
  vaults: Pick<VaultCatalog, "listScopes" | "listPortForwards">;
  coreManager: CoreManager;
  hostsOverrideManager: HostsOverrideManager;
}): DnsPortForwardCoordinator {
  const { vaults, coreManager, hostsOverrideManager } = deps;
  // 목록·적용·켜 둔 상태 정리 모두 모든 볼트를 본다(개인이 먼저). 화면은 볼트 표로 묶는다.
  const listDnsOverrideVaults = (): Array<DnsOverrideVault & { id: string }> =>
    vaults.listScopes().map((scope) => ({
      id: scope.id,
      overrides: scope.dnsOverrides.list(),
      rules: scope.portForwards.list(),
    }));

  const listPortForwardSnapshot = () => ({
    rules: vaults.listPortForwards(),
    runtimes: coreManager.listPortForwardRuntimes(),
  });

  const listResolvedDnsOverrides = (): DnsOverrideResolvedRecord[] => {
    const dnsVaults = listDnsOverrideVaults();
    hostsOverrideManager.pruneStaticOverrideStates(listStaticDnsOverrideIds(dnsVaults));
    return resolveDnsOverrideRecordsAcrossVaults(
      dnsVaults,
      coreManager.listPortForwardRuntimes(),
      hostsOverrideManager.getActiveStaticOverrideIds(),
    );
  };

  const rewriteActiveDnsOverrides = async (
    runtimeOverride?: PortForwardRuntimeRecord[],
  ): Promise<void> => {
    const dnsVaults = listDnsOverrideVaults();
    hostsOverrideManager.pruneStaticOverrideStates(listStaticDnsOverrideIds(dnsVaults));
    const runtimes = runtimeOverride ?? coreManager.listPortForwardRuntimes();
    await hostsOverrideManager.rewrite(
      collectActiveDnsOverrideEntriesAcrossVaults(
        dnsVaults,
        runtimes,
        hostsOverrideManager.getActiveStaticOverrideIds(),
      ),
    );
  };

  const stopPortForwardWithDnsOverrideCleanup = async (
    ruleId: string,
  ): Promise<void> => {
    const remainingRuntimes = coreManager
      .listPortForwardRuntimes()
      .filter((runtime) => runtime.ruleId !== ruleId);

    await rewriteActiveDnsOverrides(remainingRuntimes);
    try {
      await coreManager.stopPortForward(ruleId);
    } catch (error) {
      await rewriteActiveDnsOverrides().catch(() => undefined);
      throw error;
    }
  };

  return {
    listPortForwardSnapshot,
    listResolvedDnsOverrides,
    rewriteActiveDnsOverrides,
    stopPortForwardWithDnsOverrideCleanup,
  };
}
