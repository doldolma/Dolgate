import { describe, expect, it, vi } from "vitest";
import { createDnsPortForwardCoordinator } from "./dns-port-forward-coordinator";

describe("DNS port-forward coordinator", () => {
  it("rewrites linked overrides before stop and restores active overrides if stop fails", async () => {
    const rewrite = vi.fn().mockResolvedValue(undefined);
    const stopError = new Error("stop failed");
    const coordinator = createDnsPortForwardCoordinator({
      dnsOverrides: {
        list: vi.fn(() => []),
      } as any,
      portForwards: {
        list: vi.fn(() => []),
      } as any,
      coreManager: {
        listPortForwardRuntimes: vi.fn(() => [
          { ruleId: "rule-1" },
          { ruleId: "rule-2" },
        ]),
        stopPortForward: vi.fn().mockRejectedValue(stopError),
      } as any,
      hostsOverrideManager: {
        pruneStaticOverrideStates: vi.fn(),
        getActiveStaticOverrideIds: vi.fn(() => new Set<string>()),
        rewrite,
      } as any,
    });

    await expect(
      coordinator.stopPortForwardWithDnsOverrideCleanup("rule-1"),
    ).rejects.toThrow(stopError);

    expect(rewrite).toHaveBeenCalledTimes(2);
  });
});
