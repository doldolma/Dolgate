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
  parseDolgateBundle,
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

function rdpHost(id: string, label: string): HostRecord {
  return {
    id,
    kind: "rdp",
    label,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    hostname: "10.0.0.5",
    port: 3389,
    // 계정은 자격증명에 있다 — 레코드에는 빈 값으로 존재한다(normalizeHostRecord 참고).
    username: "",
    secretRef: "secret:rdp-cred",
    tailnetId: "tailnet-1",
    drives: [{ path: "/Users/me/Documents", readOnly: true }],
    createdAt: timestamp,
    updatedAt: timestamp,
  } as unknown as HostRecord;
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

// RDP 는 계정이 호스트가 아니라 자격증명에 있다(DOMAIN\user+비밀번호 한 묶음). 자격증명과
// 경유 tailnet 이 같이 안 옮겨지면 "가져오면 바로 된다"가 성립하지 않는다.
describe("rdp transfer", () => {
  const rdpTailnet: TailnetPayload = {
    id: "tailnet-1",
    label: "Home",
    ephemeral: false,
    hasAuthKey: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  function stateWithRdpHost(): DesktopStateFile {
    const record = rdpHost("host-rdp", "Work PC");
    const state = stateWithHosts([record]);
    const { hasAuthKey: _drop, ...tailnetRecord } = rdpTailnet;
    state.data.tailnets.push({ ...tailnetRecord, hasAuthKey: false });
    state.secure.managedSecretsByRef["secret:rdp-cred"] = {
      encrypted: false,
      value: Buffer.from(
        JSON.stringify({
          secretRef: "secret:rdp-cred",
          label: "Work PC",
          updatedAt: timestamp,
          kind: "rdp",
          username: "admin",
          domain: "WORKGROUP",
          password: "hunter2",
        }),
        "utf8",
      ).toString("base64"),
    };
    return state;
  }

  it("round-trips an RDP host with its credential and tailnet", () => {
    const previousInsecureOverride =
      process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
    process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";
    try {
      const bundle = buildDolgateHostBundle(stateWithRdpHost(), ["host-rdp"]);

      expect(bundle.hosts).toHaveLength(1);
      expect(bundle.hosts[0].kind).toBe("rdp");
      expect(bundle.secrets.map((record) => record.secretRef)).toEqual([
        "secret:rdp-cred",
      ]);
      expect(bundle.tailnets.map((record) => record.id)).toEqual(["tailnet-1"]);

      // 파일을 거쳐 돌아와도(직렬화→파싱) RDP 호스트와 자격증명 필드가 살아남아야 한다.
      const parsed = parseDolgateBundle(JSON.parse(JSON.stringify(bundle))).bundle;
      expect(parsed.hosts[0].kind).toBe("rdp");
      const secret = parsed.secrets[0] as unknown as {
        username?: string;
        domain?: string;
        password?: string;
      };
      expect(secret.username).toBe("admin");
      expect(secret.domain).toBe("WORKGROUP");
      expect(secret.password).toBe("hunter2");

      const plan = buildHostTransferImportPlan(parsed, stateWithHosts([]));
      expect(plan.hosts.map((record) => record.id)).toEqual(["host-rdp"]);
      // 메타데이터 투영이 kind/계정을 빠뜨리면 가져온 자격증명이 RDP 폼 목록에 안 나온다
      // (kind 없는 메타데이터는 SSH 로 간주된다).
      expect(plan.secretMetadata).toHaveLength(1);
      expect(plan.secretMetadata[0]).toMatchObject({
        secretRef: "secret:rdp-cred",
        kind: "rdp",
        username: "admin",
        domain: "WORKGROUP",
        hasPassword: true,
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

  it("rejects a bundle whose RDP host lost its credential", () => {
    const orphan = rdpHost("host-rdp", "Work PC");
    expect(() => parseDolgateBundle(JSON.parse(JSON.stringify(bundleWithHosts([orphan]))))).toThrow();
  });
});

// 새 버전이 내보낸 파일에는 이 버전이 모르는 종류의 호스트가 들어 있을 수 있다.
// 파일 전체를 거부하는 대신 그 호스트(와 딸린 것들)만 건너뛰고 나머지를 살린다.
describe("parseDolgateBundle unknown host kinds", () => {
  function unknownKindHost(id: string): HostRecord {
    return {
      id,
      // 실제로 구현될 종류를 예시로 쓰면 그것이 구현되는 날 이 테스트의 뜻이 뒤집힌다
      // (vnc 가 그랬다). 앞으로도 쓰이지 않을 이름을 고정한다.
      kind: "will-not-exist",
      label: "From a newer version",
      secretRef: "secret:future-cred",
      tailnetId: "tailnet-future",
      createdAt: timestamp,
      updatedAt: timestamp,
    } as unknown as HostRecord;
  }

  it("skips unknown-kind hosts and their forwards, DNS, secrets, tailnets", () => {
    const bundle = {
      ...bundleWithHosts([host("host-ssh", "Kept"), unknownKindHost("host-future")]),
      secrets: [{ secretRef: "secret:future-cred", label: "VNC cred", updatedAt: timestamp }],
      tailnets: [
        { id: "tailnet-future", label: "VNC net", createdAt: timestamp, updatedAt: timestamp },
      ],
      portForwards: [
        {
          id: "pf-future",
          label: "future forward",
          hostId: "host-future",
          transport: "ssh",
          bindAddress: "127.0.0.1",
          bindPort: 5901,
          targetHost: "localhost",
          targetPort: 5901,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      dnsOverrides: [
        {
          id: "dns-linked",
          type: "linked",
          hostname: "future.internal",
          portForwardRuleId: "pf-future",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "dns-static",
          type: "static",
          hostname: "db.internal",
          address: "10.0.0.9",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };

    const parsed = parseDolgateBundle(bundle);

    expect(parsed.bundle.hosts.map((record) => record.id)).toEqual(["host-ssh"]);
    expect(parsed.bundle.rootHostIds).toEqual(["host-ssh"]);
    expect(parsed.bundle.portForwards).toEqual([]);
    expect(parsed.bundle.dnsOverrides.map((record) => record.id)).toEqual(["dns-static"]);
    expect(parsed.bundle.secrets).toEqual([]);
    expect(parsed.bundle.tailnets).toEqual([]);
    expect(parsed.warnings).toHaveLength(2);

    // 살아남은 번들은 그대로 가져올 수 있어야 한다.
    const plan = buildHostTransferImportPlan(parsed.bundle, stateWithHosts([]));
    expect(plan.hosts.map((record) => record.id)).toEqual(["host-ssh"]);
  });

  it("also drops hosts whose jump chain passes through a skipped host", () => {
    const jumped = { ...host("host-jumped", "Via future"), jumpHostIds: ["host-future"] };
    const chained = { ...host("host-chain", "Via jumped"), jumpHostIds: ["host-jumped"] };
    const bundle = bundleWithHosts([
      host("host-plain", "Kept"),
      unknownKindHost("host-future"),
      jumped,
      chained,
    ]);

    const parsed = parseDolgateBundle(bundle);

    expect(parsed.bundle.hosts.map((record) => record.id)).toEqual(["host-plain"]);
    expect(parsed.bundle.rootHostIds).toEqual(["host-plain"]);
    expect(parsed.warnings).toHaveLength(2);
  });

  it("keeps a secret an unknown-kind host shares with a surviving host", () => {
    const previousInsecureOverride =
      process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
    process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";
    try {
      const sharing = {
        ...unknownKindHost("host-future"),
        secretRef: "secret:rdp-cred",
      } as unknown as HostRecord;
      const bundle = {
        ...bundleWithHosts([rdpHost("host-rdp", "Work PC"), sharing]),
        secrets: [{ secretRef: "secret:rdp-cred", label: "Shared cred", updatedAt: timestamp }],
      };

      const parsed = parseDolgateBundle(bundle);

      expect(parsed.bundle.hosts.map((record) => record.id)).toEqual(["host-rdp"]);
      expect(parsed.bundle.secrets.map((record) => record.secretRef)).toEqual([
        "secret:rdp-cred",
      ]);
    } finally {
      if (previousInsecureOverride === undefined) {
        delete process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS;
      } else {
        process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS =
          previousInsecureOverride;
      }
    }
  });

  it("still rejects malformed host entries (missing kind is a broken file, not a new one)", () => {
    const broken = { ...host("host-bad", "Broken") } as Record<string, unknown>;
    delete broken.kind;
    expect(() =>
      parseDolgateBundle(bundleWithHosts([broken as unknown as HostRecord])),
    ).toThrow();
  });
});
