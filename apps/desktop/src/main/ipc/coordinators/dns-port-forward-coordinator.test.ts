import { describe, expect, it, vi } from "vitest";
import { createDnsPortForwardCoordinator } from "./dns-port-forward-coordinator";

function scope(overrides: unknown[], rules: unknown[], id?: string) {
  return {
    id,
    dnsOverrides: { list: vi.fn(() => overrides) },
    portForwards: { list: vi.fn(() => rules) },
  };
}

describe("DNS port-forward coordinator", () => {
  it("rewrites linked overrides before stop and restores active overrides if stop fails", async () => {
    const rewrite = vi.fn().mockResolvedValue(undefined);
    const stopError = new Error("stop failed");
    const personal = scope([], []);
    const coordinator = createDnsPortForwardCoordinator({
      vaults: { personal, listScopes: () => [personal] } as any,
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

  it("applies every vault's overrides and keeps a team's static ones switched on", async () => {
    const at = "2025-01-01T00:00:00.000Z";
    const teamRule = {
      id: "team-rule",
      transport: "ssh",
      label: "Team DB",
      hostId: "team-host",
      mode: "local",
      bindAddress: "127.0.0.2",
      bindPort: 5432,
      targetHost: "db.internal",
      targetPort: 5432,
      createdAt: at,
      updatedAt: at,
    };
    const personal = scope([], []);
    const team = scope(
      [
        { id: "team-linked", type: "linked", hostname: "db.internal", portForwardRuleId: "team-rule", createdAt: at, updatedAt: at },
        { id: "team-static", type: "static", hostname: "static.internal", address: "10.0.0.9", createdAt: at, updatedAt: at },
      ],
      [teamRule],
    );
    const rewrite = vi.fn().mockResolvedValue(undefined);
    const pruneStaticOverrideStates = vi.fn();
    const coordinator = createDnsPortForwardCoordinator({
      vaults: { personal, listScopes: () => [personal, team] } as any,
      coreManager: {
        listPortForwardRuntimes: vi.fn(() => [
          { ruleId: "team-rule", hostId: "team-host", transport: "ssh", mode: "local", bindAddress: "127.0.0.2", bindPort: 5432, status: "running", updatedAt: at },
        ]),
      } as any,
      hostsOverrideManager: {
        pruneStaticOverrideStates,
        getActiveStaticOverrideIds: vi.fn(() => new Set(["team-static"])),
        rewrite,
      } as any,
    });

    await coordinator.rewriteActiveDnsOverrides();
    coordinator.listResolvedDnsOverrides();

    expect(rewrite).toHaveBeenCalledWith([
      { hostname: "db.internal", address: "127.0.0.2", ruleId: "team-rule" },
      { hostname: "static.internal", address: "10.0.0.9", ruleId: "team-static" },
    ]);
    // 켜 둔 상태를 정리할 때 팀 것을 지우지 않는다 — 목록 화면을 열 때도.
    expect(pruneStaticOverrideStates).toHaveBeenCalledTimes(2);
    for (const [ids] of pruneStaticOverrideStates.mock.calls) {
      expect(ids).toEqual(["team-static"]);
    }
  });

  // 목록도 모든 볼트다(4-6). 같은 이름을 앞 볼트가 적용 중이면 뒤의 것에 그 볼트를 단다 — 켜 둔 상태는 그대로.
  it("lists every vault and marks a team override whose name the personal vault already applies", () => {
    const at = "2025-01-01T00:00:00.000Z";
    const rule = (id: string, bindAddress: string) => ({
      id,
      transport: "ssh",
      label: id,
      hostId: `${id}-host`,
      mode: "local",
      bindAddress,
      bindPort: 9000,
      targetHost: "localhost",
      targetPort: 80,
      createdAt: at,
      updatedAt: at,
    });
    const personal = scope(
      [{ id: "p-static", type: "static", hostname: "grafana.lab.test", address: "10.0.0.20", createdAt: at, updatedAt: at }],
      [rule("p-rule", "127.0.0.1")],
      "personal",
    );
    const team = scope(
      [
        { id: "t-static", type: "static", hostname: "Grafana.lab.test", address: "10.20.0.50", createdAt: at, updatedAt: at },
        { id: "t-off", type: "static", hostname: "grafana.lab.test", address: "10.20.0.51", createdAt: at, updatedAt: at },
        { id: "t-linked", type: "linked", hostname: "acme.internal", portForwardRuleId: "t-rule", createdAt: at, updatedAt: at },
      ],
      [rule("t-rule", "127.0.0.2")],
      "team-1",
    );
    const listPortForwards = vi.fn(() => [rule("p-rule", "127.0.0.1"), rule("t-rule", "127.0.0.2")]);
    const coordinator = createDnsPortForwardCoordinator({
      vaults: { listScopes: () => [personal, team], listPortForwards } as any,
      coreManager: {
        listPortForwardRuntimes: vi.fn(() => [
          { ruleId: "t-rule", hostId: "t-rule-host", transport: "ssh", mode: "local", bindAddress: "127.0.0.2", bindPort: 9000, status: "running", updatedAt: at },
        ]),
      } as any,
      hostsOverrideManager: {
        pruneStaticOverrideStates: vi.fn(),
        getActiveStaticOverrideIds: vi.fn(() => new Set(["p-static", "t-static"])),
      } as any,
    });

    expect(coordinator.listPortForwardSnapshot().rules.map((entry) => entry.id)).toEqual(["p-rule", "t-rule"]);
    const resolved = Object.fromEntries(
      coordinator.listResolvedDnsOverrides().map((record) => [record.id, [record.status, record.appliedByVaultId ?? null]]),
    );
    expect(resolved).toEqual({
      "p-static": ["active", null],
      // 켜 뒀지만 같은 이름(대소문자 무시)을 개인 것이 적용 중이다.
      "t-static": ["active", "personal"],
      // 꺼 둔 것에는 달지 않는다.
      "t-off": ["inactive", null],
      "t-linked": ["active", null],
    });
  });
});
