import { describe, expect, it } from "vitest";
import type {
  DnsOverrideRecord,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  ManagedAwsProfilePayload,
  PortForwardRuleRecord,
  SnippetRecord,
  TailnetRecord,
} from "@shared";
import type { DesktopVaultContents } from "./state-storage";
import type {
  TeamAwsProfileCredentials,
  TeamHostCredentials,
  TeamMemberPrefs,
  TeamTailnetCredentials,
} from "./team-member-prefs";
import { assertNoOutsideReferences, planVaultCopy, type VaultCopyOptions } from "./vault-copy";

// 볼트 사이 복사 계획. 비밀값은 OS 암호화 저장소에 들어가는데 시험에는 그것이 없으므로 평문 폴백을 연다.
process.env.DOLSSH_ALLOW_INSECURE_SECRET_STORAGE_FOR_TESTS = "true";

const at = "2026-10-19T00:00:00.000Z";
const NOW = "2026-10-20T00:00:00.000Z";

function emptyVault(): DesktopVaultContents {
  return {
    data: {
      groups: [],
      hosts: [],
      knownHosts: [],
      portForwards: [],
      dnsOverrides: [],
      secretMetadata: [],
      awsProfiles: [],
      snippets: [],
      savedWorkspaces: [],
      tailnets: [],
      syncOutbox: [],
    },
    secure: { managedSecretsByRef: {}, managedAwsProfilesById: {}, tailnetAuthKeysById: {} },
  } as unknown as DesktopVaultContents;
}

const plain = (value: unknown) => ({
  encrypted: false,
  value: Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64"),
});

function group(path: string, sortRank: number | null = null): GroupRecord {
  const parts = path.split("/");
  return {
    id: `group:${path}`,
    name: parts[parts.length - 1],
    path,
    parentPath: parts.length > 1 ? parts.slice(0, -1).join("/") : null,
    sortRank,
    createdAt: at,
    updatedAt: at,
  };
}

function sshHost(id: string, groupName: string | null, extra: Partial<Extract<HostRecord, { kind: "ssh" }>> = {}): HostRecord {
  return {
    id,
    kind: "ssh",
    label: id,
    groupName,
    tags: [],
    terminalThemeId: null,
    hostname: `${id}.example.com`,
    port: 22,
    username: "ubuntu",
    authType: "password",
    secretRef: null,
    createdAt: at,
    updatedAt: at,
    ...extra,
  } as HostRecord;
}

function addSecret(vault: DesktopVaultContents, secretRef: string, password: string, extra: Record<string, string> = {}): void {
  vault.secure.managedSecretsByRef[secretRef] = plain({ secretRef, label: secretRef, password, ...extra, updatedAt: at });
}

/** 그 팀에 둔 내 자격 증명(멤버 개인 칸)의 가짜. */
function myCredentials(values: {
  hosts?: Record<string, TeamHostCredentials>;
  awsProfiles?: Record<string, TeamAwsProfileCredentials>;
  tailnets?: Record<string, TeamTailnetCredentials>;
}): NonNullable<VaultCopyOptions["sourceMyCredentials"]> {
  return {
    readHostCredentials: (id) => values.hosts?.[id] ?? null,
    readAwsProfileCredentials: (id) => values.awsProfiles?.[id] ?? null,
    readTailnetCredentials: (id) => values.tailnets?.[id] ?? null,
  };
}

/** 팀 볼트: 비밀값이 있는 호스트 둘(같은 것을 함께 씀), 비밀값을 빼고 공유된 호스트, RDP, 그것들이 쓰는 것. */
function teamSource(): DesktopVaultContents {
  const vault = emptyVault();
  vault.data.hosts.push(
    sshHost("db", "Shared", { secretRef: "secret:team", tailnetId: "tn-team" }),
    sshHost("cache", "Shared", { secretRef: "secret:team" }),
    sshHost("bare", "Shared", { authType: "password" }),
    {
      id: "win",
      kind: "rdp",
      label: "win",
      groupName: "Shared",
      tags: [],
      terminalThemeId: null,
      hostname: "10.0.0.9",
      port: 3389,
      secretRef: "secret:win",
      createdAt: at,
      updatedAt: at,
    } as unknown as HostRecord,
    {
      id: "ec2",
      kind: "aws-ec2",
      label: "ec2",
      groupName: "Shared",
      tags: [],
      terminalThemeId: null,
      awsProfileId: "tp-static",
      awsProfileName: "team",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-0123456789abcdef1",
      createdAt: at,
      updatedAt: at,
    } as HostRecord,
  );
  addSecret(vault, "secret:team", "team-pw");
  addSecret(vault, "secret:win", "team-rdp", { kind: "rdp", username: "Administrator" });
  vault.data.hosts.push(sshHost("keyed", "Shared", { authType: "privateKey", secretRef: "secret:team-key" }));
  vault.secure.managedSecretsByRef["secret:team-key"] = plain({
    secretRef: "secret:team-key",
    label: "team key",
    privateKeyPem: "TEAM-PEM",
    publicKey: "ssh-ed25519 TEAMPUB",
    publicKeyFingerprintSha256: "SHA256:team",
    keyAlgorithm: "ssh-ed25519",
    updatedAt: at,
  });
  // 키를 빼고 공유된 정적 프로필 — 팀에는 키가 없다.
  addProfile(vault, { id: "tp-static", kind: "static", name: "team", region: null, accessKeyId: "", secretAccessKey: "", updatedAt: at });
  vault.data.tailnets.push({ id: "tn-team", label: "team", hasAuthKey: true, createdAt: at, updatedAt: at } as TailnetRecord);
  vault.secure.tailnetAuthKeysById["tn-team"] = plain("tskey-team");
  return vault;
}

const teamHostIds = ["db", "cache", "bare", "win", "ec2", "keyed"];

function addProfile(vault: DesktopVaultContents, payload: ManagedAwsProfilePayload): void {
  vault.data.awsProfiles.push({ id: payload.id, name: payload.name, kind: payload.kind, updatedAt: at });
  vault.secure.managedAwsProfilesById[payload.id] = plain(payload);
}

function knownHost(id: string, host: string, extra: Partial<KnownHostRecord> = {}): KnownHostRecord {
  return {
    id,
    host,
    port: 22,
    algorithm: "ssh-ed25519",
    publicKeyBase64: `key-of-${host}`,
    fingerprintSha256: `SHA256:${host}`,
    createdAt: at,
    lastSeenAt: at,
    updatedAt: at,
    ...extra,
  } as KnownHostRecord;
}

function localForward(id: string, hostId: string): PortForwardRuleRecord {
  return {
    id,
    transport: "ssh",
    label: id,
    hostId,
    mode: "local",
    bindAddress: "127.0.0.1",
    bindPort: 5432,
    targetHost: "db.internal",
    targetPort: 5432,
    createdAt: at,
    updatedAt: at,
  } as PortForwardRuleRecord;
}

function linkedDns(id: string, hostname: string, portForwardRuleId: string): DnsOverrideRecord {
  return { id, type: "linked", hostname, portForwardRuleId, createdAt: at, updatedAt: at };
}

/** 개인 볼트: Prod 아래 호스트 넷(웹은 Prod/Web), 바깥 Bastions 의 점프 호스트, 그것들이 쓰는 것 전부. */
function personalSource(): DesktopVaultContents {
  const vault = emptyVault();
  vault.data.groups.push(group("Prod", 1), group("Prod/Web", 3), group("Prod/Empty"), group("Bastions"));
  vault.data.hosts.push(
    sshHost("bastion", "Bastions", { secretRef: "secret:shared" }),
    sshHost("web", "Prod/Web", {
      secretRef: "secret:shared",
      jumpHostId: "bastion",
      jumpHostIds: ["bastion"],
      tailnetId: "tn-1",
      startupCommand: { type: "snippet", snippetId: "sn-1" },
      favorite: true,
      agentForwarding: true,
      terminalThemeId: "night-owl",
      privateKeyPath: "/Users/me/.ssh/id_ed25519",
    }),
    sshHost("api", "Prod", { secretRef: "secret:shared" }),
    {
      id: "aws",
      kind: "aws-ec2",
      label: "aws",
      groupName: "Prod",
      tags: [],
      terminalThemeId: null,
      awsProfileId: "p-role",
      awsProfileName: "ops",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-0123456789abcdef0",
      createdAt: at,
      updatedAt: at,
    } as HostRecord,
    {
      id: "vnc",
      kind: "vnc",
      label: "vnc",
      groupName: "Prod",
      tags: [],
      terminalThemeId: null,
      hostname: "10.0.0.6",
      port: 5900,
      secretRef: null,
      sshTunnelHostId: "bastion",
      createdAt: at,
      updatedAt: at,
    } as unknown as HostRecord,
    sshHost("elsewhere", "Bastions"),
  );
  addSecret(vault, "secret:shared", "hunter2");
  addProfile(vault, { id: "p-static", kind: "static", name: "prod", region: null, accessKeyId: "AKIA1", secretAccessKey: "s1", updatedAt: at });
  addProfile(vault, { id: "p-role", kind: "role", name: "ops", region: null, sourceProfileId: "p-static", roleArn: "arn:aws:iam::1:role/Ops", updatedAt: at });
  vault.data.snippets.push({ id: "sn-1", name: "uptime", command: "uptime", createdAt: at, updatedAt: at } as unknown as SnippetRecord);
  vault.data.tailnets.push({ id: "tn-1", label: "corp", hasAuthKey: true, loginName: "me@example.com", createdAt: at, updatedAt: at } as TailnetRecord);
  vault.secure.tailnetAuthKeysById["tn-1"] = plain("tskey-1");
  vault.data.knownHosts.push(
    knownHost("kh-web", "web.example.com", { tailnetId: "tn-1" }),
    knownHost("kh-bastion", "bastion.example.com"),
    knownHost("kh-other", "elsewhere.example.com"),
  );
  vault.data.portForwards.push(localForward("pf-web", "web"), localForward("pf-api", "api"), localForward("pf-elsewhere", "elsewhere"));
  vault.data.dnsOverrides.push(linkedDns("dns-db", "db.internal", "pf-web"), linkedDns("dns-dup", "dup.internal", "pf-api"));
  return vault;
}

describe("planVaultCopy", () => {
  it("copies a whole group and everything it uses under new ids, linked only among the copies", () => {
    const source = personalSource();
    const before = structuredClone(source);
    const target = emptyVault();
    target.data.groups.push(group("Team"));
    addProfile(target, { id: "t-prod", kind: "static", name: "prod", region: null, accessKeyId: "AKIAT", secretAccessKey: "t", updatedAt: at });
    target.data.knownHosts.push(knownHost("t-kh", "bastion.example.com"));
    target.data.dnsOverrides.push(linkedDns("t-dns", "dup.internal", "t-rule"));
    let sequence = 0;

    const plan = planVaultCopy(source, target, { kind: "group", groupPath: "Prod" }, {
      targetGroupPath: "Team",
      targetIsTeam: true,
      now: NOW,
      newId: () => `new-${++sequence}`,
    });

    // 원본은 그대로이고, 복사본은 모두 새 id 다.
    expect(source).toEqual(before);
    const copyOf = (id: string) => plan.hosts.find((host) => host.id === plan.hostIdMap[id]) as HostRecord & Record<string, unknown>;
    expect(Object.keys(plan.hostIdMap).sort()).toEqual(["api", "aws", "bastion", "vnc", "web"]);
    for (const record of [...plan.hosts, ...plan.groups, ...plan.portForwards, ...plan.dnsOverrides, ...plan.snippets, ...plan.tailnets, ...plan.awsProfiles, ...plan.knownHosts]) {
      expect(record.id).toMatch(/^new-/);
    }

    // 자리: 고른 그룹은 놓은 자리 아래로, 딸려 온 점프 호스트는 놓은 자리에. 빈 하위 그룹도 온다.
    expect(copyOf("web").groupName).toBe("Team/Prod/Web");
    expect(copyOf("api").groupName).toBe("Team/Prod");
    expect(copyOf("bastion").groupName).toBe("Team");
    expect(plan.groups.map((record) => [record.path, record.parentPath, record.sortRank])).toEqual([
      ["Team/Prod", "Team", 1],
      ["Team/Prod/Empty", "Team/Prod", null],
      ["Team/Prod/Web", "Team/Prod", 3],
    ]);

    // 비밀값: 세 호스트가 함께 쓰던 것은 복사본도 하나를 함께 쓴다.
    expect(plan.secrets).toHaveLength(1);
    const [secret] = plan.secrets;
    expect(secret).toMatchObject({ password: "hunter2" });
    expect(secret.secretRef).toMatch(/^secret:new-/);
    expect([copyOf("web").secretRef, copyOf("api").secretRef, copyOf("bastion").secretRef]).toEqual([
      secret.secretRef,
      secret.secretRef,
      secret.secretRef,
    ]);
    expect(plan.secretMetadata.map((record) => record.secretRef)).toEqual([secret.secretRef]);

    // 다시 잇기: 점프·tailnet·시작 명령 스니펫·VNC 터널·AWS 프로필.
    const [tailnet] = plan.tailnets;
    expect(copyOf("web")).toMatchObject({
      jumpHostId: plan.hostIdMap.bastion,
      jumpHostIds: [plan.hostIdMap.bastion],
      tailnetId: tailnet.id,
      startupCommand: { type: "snippet", snippetId: plan.snippets[0].id },
      privateKeyPath: null,
    });
    expect(copyOf("vnc").sshTunnelHostId).toBe(plan.hostIdMap.bastion);
    const staticCopy = plan.awsProfiles.find((profile) => profile.kind === "static");
    const roleCopy = plan.awsProfiles.find((profile) => profile.kind === "role");
    expect(staticCopy?.name).toBe("prod-2");
    expect(roleCopy).toMatchObject({ name: "ops", sourceProfileId: staticCopy?.id });
    expect(copyOf("aws")).toMatchObject({ awsProfileId: roleCopy?.id, awsProfileName: "ops" });

    // 사람마다 다른 값은 팀 레코드에서 빠지고 복사한 사람 몫으로 따로 온다.
    expect(copyOf("web")).toMatchObject({ favorite: null, agentForwarding: null, terminalThemeId: null });
    expect(plan.memberValues).toEqual([
      { hostId: plan.hostIdMap.web, favorite: true, agentForwarding: true, terminalThemeId: "night-owl" },
    ]);
    // 비밀번호·키를 함께 공유해도 복사한 사람의 내 칸으로 가는 것: 키 파일 경로(그 기기의 파일), AWS 정적 키와
    // tailnet auth key(사람의 인증 정보 — 팀에는 설정만 간다).
    expect(plan.memberCredentials).toEqual({
      hostCredentials: [{ id: plan.hostIdMap.web, credentials: { privateKeyPath: "/Users/me/.ssh/id_ed25519" } }],
      awsProfileCredentials: [{ id: staticCopy?.id, credentials: { accessKeyId: "AKIA1", secretAccessKey: "s1" } }],
      tailnetCredentials: [{ id: tailnet.id, credentials: { authKey: "tskey-1" } }],
    });
    expect(staticCopy).toMatchObject({ accessKeyId: "", secretAccessKey: "" });

    // tailnet 은 설정만 간다 — auth key(사람의 인증 정보)와 그 기기의 로그인 계정은 두고 온다.
    expect(tailnet).toMatchObject({ label: "corp" });
    expect(tailnet).not.toHaveProperty("authKey");
    expect(tailnet).not.toHaveProperty("loginName");

    // known hosts: 복사하는 호스트의 주소만, 대상에 이미 있는 키는 빼고.
    expect(plan.knownHosts.map((record) => [record.host, record.tailnetId])).toEqual([["web.example.com", tailnet.id]]);

    // 포트 포워딩은 복사하는 호스트의 것만, DNS 는 대상에 없는 이름만.
    expect(plan.portForwards.map((rule) => rule.hostId).sort()).toEqual([plan.hostIdMap.api, plan.hostIdMap.web].sort());
    const webRule = plan.portForwards.find((rule) => rule.hostId === plan.hostIdMap.web);
    expect(plan.dnsOverrides).toEqual([
      expect.objectContaining({ hostname: "db.internal", portForwardRuleId: webRule?.id }),
    ]);

    expect(plan.counts).toEqual({
      groups: 3,
      hosts: 5,
      dependencyHosts: 1,
      // 비밀번호와 키: 호스트 비밀값 하나만 팀에 간다(AWS 정적 키·auth key 는 내 칸으로).
      secrets: 1,
      knownHosts: 1,
      portForwards: 2,
      dnsOverrides: 1,
      snippets: 1,
      awsProfiles: 2,
      tailnets: 1,
      workspaces: 0,
    });
  });

  it("shares without passwords and keys: the team gets none, and the sharer keeps them as their own", () => {
    let sequence = 0;
    const plan = planVaultCopy(personalSource(), emptyVault(), { kind: "group", groupPath: "Prod" }, {
      targetGroupPath: null,
      targetIsTeam: true,
      shareSecrets: false,
      now: NOW,
      newId: () => `new-${++sequence}`,
    });

    // 팀 쪽: 호스트에는 비밀값이 없고, 정적 프로필에는 키가 없고, tailnet 에는 auth key 가 없다.
    for (const host of plan.hosts) {
      expect("secretRef" in host ? host.secretRef : null, host.label).toBeNull();
    }
    expect(plan.secrets).toEqual([]);
    expect(plan.secretMetadata).toEqual([]);
    const staticCopy = plan.awsProfiles.find((profile) => profile.kind === "static");
    expect(staticCopy).toMatchObject({ accessKeyId: "", secretAccessKey: "" });
    expect(plan.tailnets[0]).not.toHaveProperty("authKey");
    expect(JSON.stringify([plan.hosts, plan.secrets, plan.awsProfiles, plan.tailnets])).not.toMatch(/hunter2|AKIA1|tskey-1/);
    expect(plan.counts.secrets).toBe(0);

    // 복사한 사람의 내 칸: 원래 비밀번호(세 호스트가 함께 쓰던 것)·키 파일 경로·AWS 키·auth key.
    const mine = new Map(plan.memberCredentials.hostCredentials.map((entry) => [entry.id, entry.credentials]));
    expect(Object.fromEntries(["web", "api", "bastion", "vnc"].map((id) => [id, mine.get(plan.hostIdMap[id]) ?? null]))).toEqual({
      web: { password: "hunter2", privateKeyPath: "/Users/me/.ssh/id_ed25519" },
      api: { password: "hunter2" },
      bastion: { password: "hunter2" },
      vnc: null,
    });
    expect(plan.memberCredentials.awsProfileCredentials).toEqual([
      { id: staticCopy?.id, credentials: { accessKeyId: "AKIA1", secretAccessKey: "s1" } },
    ]);
    expect(plan.memberCredentials.tailnetCredentials).toEqual([{ id: plan.tailnets[0].id, credentials: { authKey: "tskey-1" } }]);
  });

  it("copies a team host to my personal vault with my own values on it", () => {
    const source = emptyVault();
    source.data.hosts.push(sshHost("team-host", "Shared"));
    const myValues: TeamMemberPrefs = {
      hosts: new Map([["team-host", { id: "team-host", favorite: true, agentForwarding: true, updatedAt: at }]]),
      workspaces: new Map(),
      terminalThemeByHostId: { "team-host": "night-owl" },
    };

    const plan = planVaultCopy(source, emptyVault(), { kind: "hosts", hostIds: ["team-host"] }, {
      targetGroupPath: null,
      targetIsTeam: false,
      sourceMemberPrefs: myValues,
      now: NOW,
    });

    expect(plan.hosts).toEqual([
      expect.objectContaining({ groupName: null, favorite: true, agentForwarding: true, terminalThemeId: "night-owl" }),
    ]);
    expect(plan.hosts[0].id).not.toBe("team-host");
    expect(plan.memberValues).toEqual([]);
    expect(plan.groups).toEqual([]);
  });

  it("brings my own credentials along when copying team hosts to my personal vault — mine first", () => {
    const source = teamSource();
    const plan = planVaultCopy(source, emptyVault(), { kind: "hosts", hostIds: teamHostIds }, {
      targetGroupPath: null,
      targetIsTeam: false,
      sourceMyCredentials: myCredentials({
        hosts: {
          db: { username: "alice", password: "alice-pw" },
          bare: { authType: "privateKey", privateKeyPem: "ALICE-PEM" },
          win: { username: "alice", domain: "CORP" },
          keyed: { privateKeyPem: "ALICE-PEM" },
        },
        awsProfiles: { "tp-static": { accessKeyId: "AKIAALICE", secretAccessKey: "alice-secret" } },
        tailnets: { "tn-team": { authKey: "tskey-alice" } },
      }),
      now: NOW,
    });

    const copyOf = (id: string) => plan.hosts.find((host) => host.id === plan.hostIdMap[id]) as HostRecord & Record<string, unknown>;
    const secretOf = (id: string) => plan.secrets.find((secret) => secret.secretRef === copyOf(id).secretRef);
    // 내 비밀번호가 팀 것 위에 얹혀 복사본의 비밀값이 되고, 내 사용자 이름이 복사본의 것이 된다.
    expect(copyOf("db")).toMatchObject({ username: "alice" });
    expect(secretOf("db")).toMatchObject({ password: "alice-pw" });
    // 내 것이 없는 호스트는 팀 비밀값을 그대로 가져간다 — 함께 쓰던 것은 하나로.
    expect(secretOf("cache")).toMatchObject({ password: "team-pw" });
    expect(copyOf("cache").secretRef).not.toBe(copyOf("db").secretRef);
    // 팀에 비밀값이 없던 호스트도 내 것으로 그대로 붙는다.
    expect(copyOf("bare")).toMatchObject({ authType: "privateKey" });
    expect(secretOf("bare")).toMatchObject({ privateKeyPem: "ALICE-PEM" });
    // RDP 는 계정이 비밀값에 딸린다 — 내 계정 이름·도메인에 팀 비밀번호.
    expect(secretOf("win")).toMatchObject({ kind: "rdp", username: "alice", domain: "CORP", password: "team-rdp" });
    // 내 키가 팀 키를 갈아 끼우면 팀 키의 공개키·지문은 따라오지 않는다(키 설치가 그 공개키를 쓴다).
    expect(secretOf("keyed")).toMatchObject({ privateKeyPem: "ALICE-PEM", label: "team key" });
    expect(secretOf("keyed")).not.toHaveProperty("publicKey");
    expect(secretOf("keyed")).not.toHaveProperty("publicKeyFingerprintSha256");
    expect(secretOf("keyed")).not.toHaveProperty("keyAlgorithm");
    expect(plan.secrets).toHaveLength(5);
    // AWS 키와 auth key 도 내 것이 먼저다.
    expect(plan.awsProfiles).toEqual([expect.objectContaining({ accessKeyId: "AKIAALICE", secretAccessKey: "alice-secret" })]);
    expect(plan.tailnets).toEqual([expect.objectContaining({ authKey: "tskey-alice" })]);
    expect(plan.memberCredentials).toEqual({ hostCredentials: [], awsProfileCredentials: [], tailnetCredentials: [] });
    expect(plan.counts.secrets).toBe(7);
  });

  it("never turns my own credentials into a team secret when copying into another team", () => {
    const mine = myCredentials({
      hosts: { db: { username: "alice", password: "alice-pw" } },
      awsProfiles: { "tp-static": { accessKeyId: "AKIAALICE", secretAccessKey: "alice-secret" } },
      tailnets: { "tn-team": { authKey: "tskey-alice" } },
    });
    const copy = (shareSecrets: boolean) =>
      planVaultCopy(teamSource(), emptyVault(), { kind: "hosts", hostIds: teamHostIds }, {
        targetGroupPath: null,
        targetIsTeam: true,
        shareSecrets,
        sourceMyCredentials: mine,
        now: NOW,
      });

    // 함께 공유: 팀에는 원래 팀의 비밀번호·SSH 키만 들어가고, 내 것은 새 팀의 내 칸으로 간다. tailnet auth key 는
    // 함께 공유여도 팀에 가지 않는다.
    const shared = copy(true);
    expect(shared.secrets.map((secret) => secret.password ?? secret.privateKeyPem).sort()).toEqual([
      "TEAM-PEM",
      "team-pw",
      "team-rdp",
    ]);
    expect(shared.tailnets[0]).not.toHaveProperty("authKey");
    expect(JSON.stringify([shared.hosts, shared.secrets, shared.awsProfiles, shared.tailnets])).not.toMatch(/alice/i);
    expect(shared.memberCredentials).toEqual({
      hostCredentials: [{ id: shared.hostIdMap.db, credentials: { username: "alice", password: "alice-pw" } }],
      awsProfileCredentials: [
        { id: shared.awsProfiles[0].id, credentials: { accessKeyId: "AKIAALICE", secretAccessKey: "alice-secret" } },
      ],
      tailnetCredentials: [{ id: shared.tailnets[0].id, credentials: { authKey: "tskey-alice" } }],
    });

    // 빼고 공유: 팀에는 아무것도 없고, 내 칸에는 내 것이 먼저, 없으면 원래 팀 것.
    const withheld = copy(false);
    expect(withheld.secrets).toEqual([]);
    expect(withheld.tailnets[0]).not.toHaveProperty("authKey");
    const credentialsOf = (id: string) =>
      withheld.memberCredentials.hostCredentials.find((entry) => entry.id === withheld.hostIdMap[id])?.credentials;
    expect(credentialsOf("db")).toEqual({ username: "alice", password: "alice-pw" });
    expect(credentialsOf("cache")).toEqual({ password: "team-pw" });
    expect(credentialsOf("win")).toEqual({ username: "Administrator", password: "team-rdp" });
    expect(credentialsOf("keyed")).toEqual({ privateKeyPem: "TEAM-PEM" });
    expect(credentialsOf("bare")).toBeUndefined();
    expect(withheld.memberCredentials.tailnetCredentials).toEqual([
      { id: withheld.tailnets[0].id, credentials: { authKey: "tskey-alice" } },
    ]);
  });

  it("brings an RDP host's SSM profile along and relinks it", () => {
    const source = emptyVault();
    addProfile(source, { id: "p-ssm", kind: "static", name: "ssm", region: null, accessKeyId: "AKIA2", secretAccessKey: "s2", updatedAt: at });
    source.data.hosts.push({
      id: "rdp",
      kind: "rdp",
      label: "rdp",
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: "10.0.0.5",
      port: 3389,
      username: "",
      secretRef: null,
      awsSsm: { profileId: "p-ssm", profileName: "ssm", region: "ap-northeast-2", instanceId: "i-1" },
      createdAt: at,
      updatedAt: at,
    } as unknown as HostRecord);

    const plan = planVaultCopy(source, emptyVault(), { kind: "hosts", hostIds: ["rdp"] }, { targetGroupPath: null, targetIsTeam: true, now: NOW });

    expect(plan.awsProfiles.map((profile) => profile.name)).toEqual(["ssm"]);
    expect(plan.hosts[0]).toMatchObject({ awsSsm: { profileId: plan.awsProfiles[0].id, profileName: "ssm" } });
  });

  it("refuses a plan whose copies would still point outside the copied set", () => {
    const valid = planVaultCopy(personalSource(), emptyVault(), { kind: "group", groupPath: "Prod" }, {
      targetGroupPath: null,
      targetIsTeam: true,
      now: NOW,
    });
    expect(() => assertNoOutsideReferences(valid)).not.toThrow();

    const pointsBack = (mutate: (plan: typeof valid) => void) => {
      const plan = structuredClone(valid);
      mutate(plan);
      return () => assertNoOutsideReferences(plan);
    };
    const webCopy = (plan: typeof valid) => plan.hosts.find((host) => host.id === plan.hostIdMap.web) as HostRecord & Record<string, unknown>;
    expect(pointsBack((plan) => { webCopy(plan).jumpHostIds = ["bastion"]; })).toThrow(/jumpHostIds/);
    expect(pointsBack((plan) => { webCopy(plan).secretRef = "secret:shared"; })).toThrow(/secretRef/);
    expect(pointsBack((plan) => { webCopy(plan).tailnetId = "tn-1"; })).toThrow(/tailnetId/);
    expect(pointsBack((plan) => { webCopy(plan).startupCommand = { type: "snippet", snippetId: "sn-1" }; })).toThrow(/startupCommand/);
    expect(pointsBack((plan) => { (plan.hosts.find((host) => host.kind === "aws-ec2") as unknown as Record<string, unknown>).awsProfileId = "p-role"; })).toThrow(/awsProfileId/);
    expect(pointsBack((plan) => { (plan.hosts.find((host) => host.kind === "vnc") as unknown as Record<string, unknown>).sshTunnelHostId = "bastion"; })).toThrow(/sshTunnelHostId/);
    expect(pointsBack((plan) => { plan.portForwards[0].hostId = "web"; })).toThrow(/hostId/);
    expect(pointsBack((plan) => { (plan.dnsOverrides[0] as unknown as Record<string, unknown>).portForwardRuleId = "pf-web"; })).toThrow(/portForwardRuleId/);
    expect(pointsBack((plan) => { (plan.awsProfiles.find((profile) => profile.kind === "role") as unknown as Record<string, unknown>).sourceProfileId = "p-static"; })).toThrow(/sourceProfileId/);
    expect(pointsBack((plan) => { plan.knownHosts[0].tailnetId = "tn-1"; })).toThrow(/tailnetId/);
  });

  it("drops a reference whose target is gone instead of pointing back at the source", () => {
    const source = emptyVault();
    source.data.hosts.push(sshHost("lonely", null, { tailnetId: "tn-deleted" }));

    const plan = planVaultCopy(source, emptyVault(), { kind: "hosts", hostIds: ["lonely"] }, { targetGroupPath: "Ops", targetIsTeam: true, now: NOW });

    expect(plan.hosts[0]).toMatchObject({ tailnetId: null, groupName: "Ops" });
    expect(plan.groups.map((record) => record.path)).toEqual(["Ops"]);
  });

  // 4-6: 워크스페이스를 다른 볼트에 놓으면 그 창의 호스트(와 호스트가 쓰는 것)까지 복사하고 창을 복사본으로 잇는다.
  it("copies workspaces with their panes' hosts and relinks the panes to the copies", () => {
    const source = emptyVault();
    source.data.hosts.push(
      sshHost("bastion", "Ops"),
      sshHost("web", "Prod", { jumpHostIds: ["bastion"], jumpHostId: "bastion" }),
      sshHost("db", "Prod"),
      sshHost("unused", "Prod"),
    );
    const leaf = (hostId: string) => ({ id: `leaf-${hostId}`, kind: "leaf" as const, target: { kind: "host" as const, hostId, label: hostId } });
    const local = (id: string) => ({ id, kind: "leaf" as const, target: { kind: "local" as const, label: "Local" } });
    // 저장된 워크스페이스는 창이 둘 이상이다.
    const shellsRoot = { id: "split-shells", kind: "split" as const, axis: "horizontal" as const, ratio: 0.5, first: local("l-1"), second: local("l-2") };
    source.data.savedWorkspaces.push(
      {
        version: 1,
        id: "ws-1",
        name: "Web + DB",
        root: {
          id: "split-1",
          kind: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: leaf("web"),
          second: { id: "split-2", kind: "split", axis: "vertical", ratio: 0.5, first: leaf("db"), second: leaf("deleted") },
        },
        favorite: true,
        groupName: "Prod",
        lastOpenedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      { version: 1, id: "ws-local", name: "Shells", root: shellsRoot, favorite: false, groupName: null, lastOpenedAt: null, createdAt: at, updatedAt: at },
      {
        version: 1,
        id: "ws-other",
        name: "Other",
        root: { id: "split-other", kind: "split", axis: "vertical", ratio: 0.5, first: leaf("unused"), second: local("l-3") },
        favorite: false,
        groupName: null,
        lastOpenedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    );
    let sequence = 0;

    const plan = planVaultCopy(source, emptyVault(), { kind: "workspaces", workspaceIds: ["ws-1", "ws-local"] }, {
      targetGroupPath: "Shared",
      targetIsTeam: true,
      now: NOW,
      newId: () => `new-${++sequence}`,
    });

    // 창의 호스트와 그 점프 호스트만 — 고르지 않은 워크스페이스의 호스트는 오지 않는다.
    expect(plan.hosts.map((host) => host.label).sort()).toEqual(["bastion", "db", "web"]);
    expect(plan.counts).toMatchObject({ workspaces: 2, hosts: 3, dependencyHosts: 1 });
    const [copy, shells] = plan.savedWorkspaces;
    expect(plan.workspaceIdMap).toEqual({ "ws-1": copy.id, "ws-local": shells.id });
    expect(copy).toMatchObject({ name: "Web + DB", groupName: "Shared", favorite: false, lastOpenedAt: null, createdAt: NOW });
    expect(copy.id).not.toBe("ws-1");
    const panes = JSON.stringify(copy.root);
    expect(panes).toContain(`"hostId":"${plan.hostIdMap.web}"`);
    expect(panes).toContain(`"hostId":"${plan.hostIdMap.db}"`);
    // 원본 볼트를 가리키는 id 는 남지 않는다 — 지워진 호스트를 가리키던 창은 어디에도 없는 id 로.
    for (const sourceId of ["web", "db", "deleted"]) {
      expect(panes).not.toContain(`"hostId":"${sourceId}"`);
    }
    expect(shells.root).toEqual(shellsRoot);
    // 놓은 자리(Shared)가 대상에 없으면 만든다. 호스트도 그 자리로 간다.
    expect(plan.groups.map((record) => record.path)).toEqual(["Shared"]);
    expect(new Set(plan.hosts.map((host) => host.groupName))).toEqual(new Set(["Shared"]));
  });

  it("refuses a workspace copy that names no workspace in the source", () => {
    expect(() =>
      planVaultCopy(emptyVault(), emptyVault(), { kind: "workspaces", workspaceIds: ["nope"] }, { targetGroupPath: null, targetIsTeam: true }),
    ).toThrow(/workspace/);
  });
});
