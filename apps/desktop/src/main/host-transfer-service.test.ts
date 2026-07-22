import { describe, expect, it } from "vitest";
import type { HostRecord } from "@shared";
import type { DolgateHostBundleV1 } from "./host-transfer-format";
import { buildHostTransferImportPlan } from "./host-transfer-service";
import type { DesktopStateFile } from "./state-storage";

const timestamp = "2026-07-22T00:00:00.000Z";

function host(id: string, label: string): HostRecord {
  return {
    id,
    kind: "ssh",
    label,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    hostname: "example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function stateWithHosts(hosts: HostRecord[]): DesktopStateFile {
  return {
    data: {
      groups: [],
      hosts,
      knownHosts: [],
      portForwards: [],
      dnsOverrides: [],
      secretMetadata: [],
      awsProfiles: [],
      snippets: [],
      syncOutbox: [],
    },
    secure: {
      refreshToken: null,
      appSecretsByAccount: {},
      managedSecretsByRef: {},
      managedAwsProfilesById: {},
    },
  } as unknown as DesktopStateFile;
}

function bundleWithHosts(hosts: HostRecord[]): DolgateHostBundleV1 {
  return {
    schemaVersion: 1,
    scope: "hosts",
    exportedAt: timestamp,
    rootHostIds: hosts.map((record) => record.id),
    groups: [],
    hosts,
    secrets: [],
    knownHosts: [],
    portForwards: [],
    dnsOverrides: [],
    awsProfiles: [],
    snippets: [],
  };
}

describe("buildHostTransferImportPlan", () => {
  it("skips the same UUID but does not match hosts by display name", () => {
    const existing = host("host-existing", "Production");
    const sameId = host("host-existing", "Renamed in export");
    const sameNameDifferentId = host("host-imported", "Production");

    const plan = buildHostTransferImportPlan(
      bundleWithHosts([sameId, sameNameDifferentId]),
      stateWithHosts([existing]),
    );

    expect(plan.hosts.map((record) => record.id)).toEqual(["host-imported"]);
    expect(plan.skippedCount).toBe(1);
  });
});
