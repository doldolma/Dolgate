import {
  isStaticDnsOverrideRecord,
} from "@shared";
import type { DnsOverrideResolvedRecord, PortForwardRuntimeRecord } from "@shared";
import type { CoreManager } from "../../core-manager";
import type {
  DnsOverrideRepository,
  PortForwardRepository,
} from "../../database";
import {
  collectActiveDnsOverrideEntries,
  HostsOverrideManager,
  resolveDnsOverrideRecords,
} from "../../hosts-override-manager";

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
  dnsOverrides: DnsOverrideRepository;
  portForwards: PortForwardRepository;
  coreManager: CoreManager;
  hostsOverrideManager: HostsOverrideManager;
}): DnsPortForwardCoordinator {
  const { dnsOverrides, portForwards, coreManager, hostsOverrideManager } = deps;

  const listPortForwardSnapshot = () => ({
    rules: portForwards.list(),
    runtimes: coreManager.listPortForwardRuntimes(),
  });

  const listResolvedDnsOverrides = (): DnsOverrideResolvedRecord[] => {
    const overrides = dnsOverrides.list();
    const portForwardSnapshot = listPortForwardSnapshot();
    hostsOverrideManager.pruneStaticOverrideStates(
      overrides.filter(isStaticDnsOverrideRecord).map((record) => record.id),
    );
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
    const overrides = dnsOverrides.list();
    hostsOverrideManager.pruneStaticOverrideStates(
      overrides.filter(isStaticDnsOverrideRecord).map((record) => record.id),
    );
    const runtimes = runtimeOverride ?? coreManager.listPortForwardRuntimes();
    await hostsOverrideManager.rewrite(
      collectActiveDnsOverrideEntries(
        overrides,
        portForwards.list(),
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
