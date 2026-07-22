import { describe, expect, it } from "vitest";
import type {
  AwsProfileMetadataRecord,
  HostRecord,
  ManagedAwsProfilePayload,
} from "@shared";
import type { DolgateHostBundleV1 } from "./host-transfer-format";
import {
  buildDolgateHostBundle,
  buildHostTransferImportPlan,
} from "./host-transfer-service";
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

function awsHost(
  id: string,
  label: string,
  awsProfileId: string | null,
): HostRecord {
  return {
    id,
    kind: "aws-ec2",
    label,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    awsProfileId,
    awsProfileName: "legacy-profile",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-0123456789abcdef0",
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

function addAwsProfile(
  state: DesktopStateFile,
  payload: ManagedAwsProfilePayload,
): void {
  const metadata: AwsProfileMetadataRecord = {
    id: payload.id,
    name: payload.name,
    kind: payload.kind,
    updatedAt: payload.updatedAt,
  };
  state.data.awsProfiles.push(metadata);
  state.secure.managedAwsProfilesById[payload.id] = {
    encrypted: false,
    value: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  };
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
    expect(plan.skippedCounts).toMatchObject({ hosts: 1 });
  });
});

describe("buildDolgateHostBundle", () => {
  it("exports an AWS profile only when the host references its exact ID", () => {
    const previousInsecureOverride =
      process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
    process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";
    try {
      const record = awsHost("host-aws", "Production EC2", "current-profile-id");
      const state = stateWithHosts([record]);
      addAwsProfile(state, {
        id: "current-profile-id",
        name: "legacy-profile",
        kind: "static",
        region: "ap-northeast-2",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret",
        updatedAt: timestamp,
      });

      const bundle = buildDolgateHostBundle(state, [record.id]);

      expect(bundle.awsProfiles).toHaveLength(1);
      expect(bundle.awsProfiles[0]).toMatchObject({
        id: "current-profile-id",
        name: "legacy-profile",
      });
      expect(bundle.hosts[0]).toMatchObject({
        id: record.id,
        awsProfileId: "current-profile-id",
        awsProfileName: "legacy-profile",
      });
    } finally {
      if (previousInsecureOverride === undefined) {
        delete process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
      } else {
        process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS =
          previousInsecureOverride;
      }
    }
  });

  it("does not resolve a stale AWS profile ID by a matching display name", () => {
    const previousInsecureOverride =
      process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
    process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";
    try {
      const record = awsHost("host-aws", "Production EC2", "stale-profile-id");
      const state = stateWithHosts([record]);
      addAwsProfile(state, {
        id: "current-profile-id",
        name: "legacy-profile",
        kind: "static",
        region: "ap-northeast-2",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret",
        updatedAt: timestamp,
      });

      const bundle = buildDolgateHostBundle(state, [record.id]);

      expect(bundle.awsProfiles).toEqual([]);
      expect(bundle.hosts[0]).toMatchObject({
        id: record.id,
        awsProfileId: null,
        awsProfileName: "",
      });
    } finally {
      if (previousInsecureOverride === undefined) {
        delete process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
      } else {
        process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS =
          previousInsecureOverride;
      }
    }
  });

  it("exports an AWS host without a profile reference when the profile is missing", () => {
    const record = awsHost("host-aws", "Production EC2", "missing-profile");

    const bundle = buildDolgateHostBundle(stateWithHosts([record]), [record.id]);

    expect(bundle.awsProfiles).toEqual([]);
    expect(bundle.hosts).toHaveLength(1);
    expect(bundle.hosts[0]).toMatchObject({
      id: record.id,
      awsProfileId: null,
      awsProfileName: "",
    });

    const importPlan = buildHostTransferImportPlan(bundle, stateWithHosts([]));
    expect(importPlan.hosts[0]).toMatchObject({
      id: record.id,
      awsProfileId: null,
      awsProfileName: "",
    });
  });

  it("exports an AWS host that already has no profile id", () => {
    const record = awsHost("host-aws", "Production EC2", null);

    const bundle = buildDolgateHostBundle(stateWithHosts([record]), [record.id]);

    expect(bundle.awsProfiles).toEqual([]);
    expect(bundle.hosts[0]).toMatchObject({
      id: record.id,
      awsProfileId: null,
      awsProfileName: "",
    });
  });
});
