import { describe, expect, it } from "vitest";
import type {
  AwsProfileMetadataRecord,
  HostRecord,
  ManagedAwsProfilePayload,
  TailnetPayload,
} from "@shared";
import type { DolgateHostBundleV1 } from "./host-transfer-format";
import {
  buildDolgateHostBundle,
  buildHostTransferImportPlan,
} from "./host-transfer-service";
import type { DesktopStateFile } from "./state-storage";

// auth key 는 OS 암호화 저장소에 들어간다. 테스트에는 그것이 없으므로 평문 폴백을 연다.
process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";

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
      tailnets: [],
      syncOutbox: [],
    },
    secure: {
      refreshToken: null,
      appSecretsByAccount: {},
      managedSecretsByRef: {},
      managedAwsProfilesById: {},
      tailnetAuthKeysById: {},
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
    tailnets: [],
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

// tailnet 은 호스트의 tailnetId 만 옮기면 받는 쪽에 그 id 가 없어 연결이
// "is not configured" 로 죽는다. 연결 자체는 되는 것처럼 보이는 다른 항목들과 달리, 이건
// 가져오기가 성공했다고 말한 뒤에 실패하는 종류라 눈에 잘 안 띈다.
describe("tailnet transfer", () => {
  const tailnet: TailnetPayload = {
    id: "tn-1",
    label: "Gridwiz",
    controlUrl: "https://headscale.example.com",
    tailnetName: "gridwiz.example.com",
    ephemeral: false,
    hasAuthKey: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  function stateWithTailnet(hosts: HostRecord[], authKey?: string): DesktopStateFile {
    const state = stateWithHosts(hosts);
    const { authKey: _drop, ...record } = tailnet;
    state.data.tailnets.push({ ...record, hasAuthKey: Boolean(authKey) });
    if (authKey) {
      state.secure.tailnetAuthKeysById[tailnet.id] = {
        encrypted: false,
        value: Buffer.from(authKey, "utf8").toString("base64"),
      };
    }
    return state;
  }

  function tailnetHost(): HostRecord {
    return { ...host("h-tn", "lime-dev"), tailnetId: tailnet.id } as HostRecord;
  }

  it("exports the tailnet a host goes through, with its auth key", () => {
    const record = tailnetHost();
    const bundle = buildDolgateHostBundle(stateWithTailnet([record], "tskey-abc"), [
      record.id,
    ]);
    expect(bundle.tailnets).toHaveLength(1);
    expect(bundle.tailnets[0]).toMatchObject({
      id: "tn-1",
      label: "Gridwiz",
      controlUrl: "https://headscale.example.com",
      authKey: "tskey-abc",
      hasAuthKey: true,
    });
  });

  // 브라우저 로그인으로 등록한 tailnet 은 키가 없다. 없는 것을 있다고 적으면 받는 쪽이
  // "키가 있다는데 없는" 상태가 된다.
  it("marks a tailnet without an auth key as having none", () => {
    const record = tailnetHost();
    const bundle = buildDolgateHostBundle(stateWithTailnet([record]), [record.id]);
    expect(bundle.tailnets[0].authKey).toBeUndefined();
    expect(bundle.tailnets[0].hasAuthKey).toBe(false);
  });

  // 쓰지 않는 tailnet 까지 실어 보내면 파일을 건넨 상대에게 필요 없는 자격증명이 넘어간다.
  it("only exports tailnets the exported hosts actually use", () => {
    const plain = host("h-plain", "plain");
    const bundle = buildDolgateHostBundle(stateWithTailnet([plain], "tskey-abc"), [
      plain.id,
    ]);
    expect(bundle.tailnets).toHaveLength(0);
  });

  it("imports the tailnet so the host can connect", () => {
    const record = tailnetHost();
    const bundle = buildDolgateHostBundle(stateWithTailnet([record], "tskey-abc"), [
      record.id,
    ]);
    const plan = buildHostTransferImportPlan(bundle, stateWithHosts([]));
    expect(plan.tailnets).toHaveLength(1);
    expect(plan.tailnets[0].authKey).toBe("tskey-abc");
    expect(plan.warnings).toHaveLength(0);
  });

  // 이미 등록돼 있으면 로컬 쪽이 더 최신일 수 있다(재인증한 키 등). 덮어쓰면 되던 연결이 끊긴다.
  it("keeps an existing tailnet instead of overwriting it", () => {
    const record = tailnetHost();
    const bundle = buildDolgateHostBundle(stateWithTailnet([record], "tskey-abc"), [
      record.id,
    ]);
    const plan = buildHostTransferImportPlan(bundle, stateWithTailnet([], "tskey-local"));
    expect(plan.tailnets).toHaveLength(0);
    expect(plan.skippedCounts.tailnets).toBe(1);
    expect(plan.warnings).toHaveLength(0);
  });

  // 이 필드가 생기기 전 파일에는 tailnet 이 없다. 막으면 그런 파일을 통째로 못 가져온다.
  it("imports an older bundle that carries no tailnets, with a warning", () => {
    const record = tailnetHost();
    const bundle = buildDolgateHostBundle(stateWithTailnet([record], "tskey-abc"), [
      record.id,
    ]);
    const legacy = { ...bundle, tailnets: [] };
    const plan = buildHostTransferImportPlan(legacy, stateWithHosts([]));
    expect(plan.hosts).toHaveLength(1);
    // tailnetId 를 비우지 않는다 — 비우면 그 호스트는 tailnet 밖으로 조용히 붙는다.
    expect((plan.hosts[0] as { tailnetId?: string | null }).tailnetId).toBe("tn-1");
    expect(plan.warnings).toHaveLength(1);
  });
});
