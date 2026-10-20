import type { DnsOverrideResolvedRecord, PortForwardRuntimeRecord } from "@shared";
import type { CoreManager } from "../../core-manager";
import type { PortForwardRepository } from "../../database";
import {
  collectActiveDnsOverrideEntriesAcrossVaults,
  type DnsOverrideVault,
  HostsOverrideManager,
  listStaticDnsOverrideIds,
  resolveDnsOverrideRecords,
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
  vaults: Pick<VaultCatalog, "personal" | "listScopes">;
  coreManager: CoreManager;
  hostsOverrideManager: HostsOverrideManager;
}): DnsPortForwardCoordinator {
  const { vaults, coreManager, hostsOverrideManager } = deps;
  // 목록 화면은 아직 개인 것만 보인다(볼트별 목록은 작업 4). 적용과 켜 둔 상태 정리는 모든 볼트를 본다.
  const { dnsOverrides, portForwards } = vaults.personal;
  const listDnsOverrideVaults = (): DnsOverrideVault[] =>
    vaults.listScopes().map((scope) => ({
      overrides: scope.dnsOverrides.list(),
      rules: scope.portForwards.list(),
    }));

  const listPortForwardSnapshot = () => ({
    rules: portForwards.list(),
    runtimes: coreManager.listPortForwardRuntimes(),
  });

  const listResolvedDnsOverrides = (): DnsOverrideResolvedRecord[] => {
    const overrides = dnsOverrides.list();
    const portForwardSnapshot = listPortForwardSnapshot();
    hostsOverrideManager.pruneStaticOverrideStates(listStaticDnsOverrideIds(listDnsOverrideVaults()));
    return resolveDnsOverrideRecords(
      overrides,
      portForwardSnapshot.rules,
      portForwardSnapshot.runtimes,
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
