import { describe, expect, it, vi } from "vitest";
import { createSnapshotCoordinator } from "./snapshot-coordinator";

describe("snapshot coordinator", () => {
  it("builds bootstrap and synced workspace snapshots from repositories", async () => {
    const coordinator = createSnapshotCoordinator({
      hosts: { list: vi.fn(() => [{ id: "host-1" }]) } as any,
      groups: { list: vi.fn(() => [{ id: "group-1" }]) } as any,
      settings: { get: vi.fn(() => ({ theme: "system" })) } as any,
      knownHosts: { list: vi.fn(() => [{ id: "known-1" }]) } as any,
      activityLogs: { list: vi.fn(() => [{ id: "log-1" }]) } as any,
      secretMetadata: { list: vi.fn(() => [{ secretRef: "secret-1" }]) } as any,
      coreManager: { listTabs: vi.fn(() => [{ id: "tab-1" }]) } as any,
      localFiles: {
        getHomeDirectory: vi.fn().mockResolvedValue("/Users/test"),
        list: vi.fn().mockResolvedValue({ path: "/Users/test", entries: [] }),
      } as any,
      dnsPortForwardCoordinator: {
        listPortForwardSnapshot: vi.fn(() => ({ rules: [], runtimes: [] })),
        listResolvedDnsOverrides: vi.fn(() => []),
      } as any,
    });

    await expect(coordinator.getInitialBootstrapSnapshot()).resolves.toMatchObject({
      hosts: [{ id: "host-1" }],
      groups: [{ id: "group-1" }],
      tabs: [{ id: "tab-1" }],
      localHomePath: "/Users/test",
    });
    await expect(coordinator.getSyncedWorkspaceSnapshot()).resolves.toMatchObject({
      hosts: [{ id: "host-1" }],
      groups: [{ id: "group-1" }],
      portForwardSnapshot: { rules: [], runtimes: [] },
      dnsOverrides: [],
    });
  });
});
