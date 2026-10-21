import { describe, expect, it, vi } from "vitest";
import { normalizeHostEnvVars } from "@shared";
import { clearRuntimeSecretCache, createSecretCoordinator } from "./secret-coordinator";

function createCoordinator(overrides: Record<string, unknown> = {}) {
  const deps = {
    secretStore: {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
    },
    secretMetadata: {
      upsert: vi.fn(),
    },
    hosts: {
      updateSecretRef: vi.fn(),
    },
    activityLogs: {
      append: vi.fn(),
    },
    queueSync: vi.fn(),
    inspectCertificate: vi.fn().mockResolvedValue({ status: "valid" }),
    ...overrides,
  } as any;
  // 팀이 없는 카탈로그 — 비밀값은 개인 저장소에서 읽는다.
  deps.vaults ??= {
    loadSecret: (secretRef: string) => deps.secretStore.load(secretRef),
    scopeOfHost: () => ({ id: "personal" }),
  };

  return {
    deps,
    coordinator: createSecretCoordinator(deps),
  };
}

describe("secret coordinator", () => {
  it("does not persist empty secret payloads", async () => {
    const { deps, coordinator } = createCoordinator();

    await expect(coordinator.persistSecret("Prod", {})).resolves.toBeNull();

    expect(deps.secretStore.save).not.toHaveBeenCalled();
    expect(deps.secretMetadata.upsert).not.toHaveBeenCalled();
  });

  it("saves a team host's secret in that team's vault, not the personal one", async () => {
    const { deps, coordinator } = createCoordinator();
    const team = {
      secrets: { save: vi.fn().mockResolvedValue(undefined) },
      secretMetadata: { upsert: vi.fn() },
    };

    const secretRef = await coordinator.persistSecret("Prod", { password: "pw" }, team as any);

    expect(secretRef).toMatch(/^secret:/);
    expect(team.secrets.save).toHaveBeenCalledWith(secretRef, expect.stringContaining('"password":"pw"'));
    expect(team.secretMetadata.upsert).toHaveBeenCalledWith(expect.objectContaining({ secretRef, hasPassword: true }));
    expect(deps.secretStore.save).not.toHaveBeenCalled();
    expect(deps.secretMetadata.upsert).not.toHaveBeenCalled();
  });

  // 저장하면 내 비밀번호가 팀 호스트의 비밀값이 되어 팀 전체에 공유된다.
  it("keeps what was typed into a prompt for a team host as my own credentials, not the team's secret", async () => {
    const setMyHostCredentials = vi.fn();
    const { deps, coordinator } = createCoordinator({
      vaults: {
        loadSecret: vi.fn(async (secretRef: string) =>
          secretRef === "secret:team" ? JSON.stringify({ secretRef, label: "shared", privateKeyPem: "TEAM-PEM" }) : null,
        ),
        scopeOfHost: vi.fn(() => ({ id: "team-1" })),
        getHost: vi.fn(() => ({ id: "team-host", kind: "ssh", secretRef: "secret:team" })),
        getMyHostCredentials: vi.fn(() => ({ username: "alice" })),
        setMyHostCredentials,
      },
    });

    // 넘어온 값은 팀 키와 내가 넣은 패스프레이즈를 합친 것이다 — 팀 키는 옮기지 않는다.
    await expect(
      coordinator.persistHostSpecificSecret("team-host", "Shared", { privateKeyPem: "TEAM-PEM", passphrase: "mine" }),
    ).resolves.toBeNull();

    expect(setMyHostCredentials).toHaveBeenCalledWith("team-host", { username: "alice", passphrase: "mine" });
    expect(deps.secretStore.save).not.toHaveBeenCalled();
    expect(deps.secretMetadata.upsert).not.toHaveBeenCalled();
    expect(deps.hosts.updateSecretRef).not.toHaveBeenCalled();
    expect(deps.queueSync).toHaveBeenCalledTimes(1);
  });

  it("reads a host's secret from whichever vault holds it", async () => {
    const { deps, coordinator } = createCoordinator({
      vaults: {
        loadSecret: vi.fn(async (secretRef: string) =>
          secretRef === "secret:team" ? JSON.stringify({ secretRef, label: "db", password: "team-pw" }) : null,
        ),
        scopeOfHost: vi.fn(() => ({ id: "personal" })),
      },
    });

    await expect(coordinator.loadSecrets("secret:team")).resolves.toMatchObject({ password: "team-pw" });
    expect(deps.vaults.loadSecret).toHaveBeenCalledWith("secret:team");
    expect(deps.secretStore.load).not.toHaveBeenCalled();
  });

  it("merges runtime secret patches without erasing omitted values", () => {
    const { coordinator } = createCoordinator();

    expect(
      coordinator.mergeSecrets(
        { password: "old", passphrase: "keep", privateKeyPem: "key" },
        { password: "new" },
      ),
    ).toEqual({
      password: "new",
      passphrase: "keep",
      privateKeyPem: "key",
      certificateText: undefined,
    });
  });

  it("rejects missing and invalid certificate auth before connecting", async () => {
    const { coordinator } = createCoordinator({
      inspectCertificate: vi.fn().mockResolvedValue({ status: "expired" }),
    });
    const host = {
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      secretRef: null,
    } as any;

    await expect(
      coordinator.ensureCertificateAuthReady(host, {}),
    ).rejects.toThrow("SSH 인증서를 찾을 수 없습니다.");
    await expect(
      coordinator.ensureCertificateAuthReady(host, {
        certificateText: "cert",
      }),
    ).rejects.toThrow("SSH 인증서가 만료되었습니다.");
  });

  it("round-trips the account and mirrors it into plaintext metadata", async () => {
    // RDP 는 계정이 자격증명에 딸린다. 평문 메타데이터에도 같이 적어야 목록 표시와 접속이
    // 복호화 없이 계정을 알 수 있다 — 쓰는 곳이 persistSecret 하나뿐이라 값이 갈리지 않는다.
    const saved: Record<string, string> = {};
    const { deps, coordinator } = createCoordinator({
      secretStore: {
        save: vi.fn(async (ref: string, json: string) => {
          saved[ref] = json;
        }),
        load: vi.fn(async (ref: string) => saved[ref] ?? null),
      },
    });

    const secretRef = await coordinator.persistSecret("Win admin", {
      kind: "rdp",
      username: "Administrator",
      domain: "CORP",
      password: "pw",
    });
    expect(secretRef).toBeTruthy();

    const loaded = await coordinator.loadSecrets(secretRef);
    expect(loaded.username).toBe("Administrator");
    expect(loaded.domain).toBe("CORP");

    // kind 도 같이 적힌다 — RDP 목록에 SSH 자격증명이 섞이면 고를 수 없는 항목만 늘어난다.
    expect(deps.secretMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rdp",
        username: "Administrator",
        domain: "CORP",
        hasPassword: true,
      }),
    );
    expect(loaded.kind).toBe("rdp");
  });

  it("does not create a credential from an account with no password", async () => {
    // 비밀이 없는 자격증명은 의미가 없다. 만들면 목록에 붙을 수 없는 항목이 쌓인다.
    const { coordinator } = createCoordinator();
    await expect(
      coordinator.persistSecret("Win admin", { username: "Administrator" }),
    ).resolves.toBeNull();
  });

  it("keeps the account when merging runtime secret patches", () => {
    const { coordinator } = createCoordinator();
    expect(
      coordinator.mergeSecrets(
        { username: "Administrator", domain: "CORP", password: "pw" },
        { password: "new" },
      ),
    ).toMatchObject({ username: "Administrator", domain: "CORP", password: "new" });
  });

});

// 팀 호스트는 내 자격 증명 → 팀 것 → 요청 창 순서다. 개인 호스트는 카탈로그가 내 것을 늘 null 로 준다.
describe("login to connect with", () => {
  const teamHost = {
    id: "team-host",
    kind: "ssh",
    label: "Shared",
    hostname: "shared.example.com",
    port: 22,
    username: "deploy",
    authType: "privateKey",
    secretRef: "secret:team",
  } as any;

  function createTeamCoordinator(mine: Record<string, string> | null) {
    clearRuntimeSecretCache();
    const loadSecret = vi.fn(async (secretRef: string) =>
      secretRef === "secret:team"
        ? JSON.stringify({ secretRef, label: "shared", username: "deploy", privateKeyPem: "TEAM-PEM" })
        : null,
    );
    const setMyHostCredentials = vi.fn();
    const setHostLoginUsername = vi.fn();
    const { coordinator, deps } = createCoordinator({
      vaults: {
        loadSecret,
        scopeOfHost: vi.fn(() => ({ id: "team-1" })),
        getHost: vi.fn(() => teamHost),
        getMyHostCredentials: vi.fn(() => mine),
        setMyHostCredentials,
        setHostLoginUsername,
      },
    });
    return { coordinator, loadSecret, setMyHostCredentials, setHostLoginUsername, deps };
  }

  it("connects with my own credentials first, without reading the team's secret", async () => {
    const { coordinator, loadSecret } = createTeamCoordinator({
      username: "alice",
      authType: "password",
      password: "mine",
    });

    await expect(coordinator.resolveSshAuth(teamHost)).resolves.toMatchObject({
      username: "alice",
      authType: "password",
      secrets: { password: "mine" },
      shouldPersistHostSecret: false,
    });
    expect(loadSecret).not.toHaveBeenCalled();
  });

  it("uses my account name with the team's key when that is all I set", async () => {
    const { coordinator } = createTeamCoordinator({ username: "alice" });

    const auth = await coordinator.resolveSshAuth(teamHost);

    expect(auth).toMatchObject({ username: "alice", authType: "privateKey", secrets: { privateKeyPem: "TEAM-PEM" } });
  });

  it("uses the host's own login when I have none", async () => {
    const { coordinator } = createTeamCoordinator(null);

    await expect(coordinator.resolveSshAuth(teamHost)).resolves.toMatchObject({
      username: "deploy",
      authType: "privateKey",
      secrets: { privateKeyPem: "TEAM-PEM" },
    });
    await expect(coordinator.resolveSshAuth({ ...teamHost, username: "  " })).rejects.toThrow("사용자명이 필요합니다.");
  });

  // 비밀번호·키를 빼고 공유된 호스트: 공유한 사람은 내 것으로 붙고, 내 것이 없는 멤버는 빈 로그인으로 가서
  // 지금의 요청 창이 뜬다(넣은 값은 내 칸에 저장된다 — 위 시험).
  it("connects a host shared without its password with mine, or with nothing so the prompt asks", async () => {
    const shared = { ...teamHost, secretRef: null };
    const sharer = createTeamCoordinator({ password: "sharer-pw" });
    await expect(sharer.coordinator.resolveSshAuth(shared)).resolves.toMatchObject({
      username: "deploy",
      secrets: { password: "sharer-pw" },
    });

    const member = createTeamCoordinator(null);
    const auth = await member.coordinator.resolveSshAuth(shared);
    expect(auth).toMatchObject({ username: "deploy", authType: "privateKey" });
    expect([auth.secrets.password, auth.secrets.privateKeyPem, auth.secrets.passphrase]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(member.loadSecret).not.toHaveBeenCalled();
  });

  it("lets what was typed into the prompt win over mine, and marks it to be kept", async () => {
    const { coordinator } = createTeamCoordinator({ username: "alice", authType: "password", password: "old" });

    await expect(coordinator.resolveSshAuth(teamHost, { password: "new" })).resolves.toMatchObject({
      username: "alice",
      secrets: { password: "new" },
      shouldPersistHostSecret: true,
    });
  });

  // 요청 창에서 바꾼 사용자 이름은 이번 시도의 것이다 — 내 것·호스트 것보다 먼저 쓰고, 붙으면 저장하도록 알린다.
  it("connects with the username typed into the prompt, even with nothing else typed", async () => {
    const { coordinator } = createTeamCoordinator({ username: "alice", authType: "password", password: "mine" });

    await expect(coordinator.resolveSshAuth(teamHost, { username: " bob ", password: "bob-pw" })).resolves.toMatchObject({
      username: "bob",
      typedUsername: "bob",
      secrets: { password: "bob-pw" },
      shouldPersistHostSecret: true,
    });
    // 사용자 이름만 바꿔도 저장할 것이 있다.
    const nameOnly = createTeamCoordinator(null);
    await expect(nameOnly.coordinator.resolveSshAuth(teamHost, { username: "bob" })).resolves.toMatchObject({
      username: "bob",
      typedUsername: "bob",
      shouldPersistHostSecret: true,
    });
    // 넣지 않았으면 없다.
    await expect(nameOnly.coordinator.resolveSshAuth(teamHost)).resolves.toMatchObject({
      username: "deploy",
      typedUsername: null,
      shouldPersistHostSecret: false,
    });
  });

  // 붙은 뒤 저장: 사용자 이름은 카탈로그가 제자리에 둔다(팀 호스트면 내 칸 — 팀 레코드에 쓰면 팀 모두의 이름이
  // 바뀐다). 내 칸으로 옮기는 비밀값에 사용자 이름이 섞이지 않는다.
  it("saves the typed username through the catalog, apart from the secrets that go to my own slot", async () => {
    const team = createTeamCoordinator({ username: "alice" });
    await team.coordinator.persistHostSpecificSecret("team-host", "Shared", { username: "secret-account", password: "bob-pw" }, "bob");
    expect(team.setHostLoginUsername).toHaveBeenCalledWith("team-host", "bob");
    expect(team.setMyHostCredentials).toHaveBeenCalledWith("team-host", { username: "alice", password: "bob-pw" });
    expect(team.deps.hosts.updateSecretRef).not.toHaveBeenCalled();

    // 사용자 이름만 바꾼 경우에도 저장한다.
    const nameOnly = createTeamCoordinator(null);
    await expect(nameOnly.coordinator.persistHostSpecificSecret("team-host", "Shared", {}, "bob")).resolves.toBeNull();
    expect(nameOnly.setHostLoginUsername).toHaveBeenCalledWith("team-host", "bob");
    expect(nameOnly.setMyHostCredentials).not.toHaveBeenCalled();
    expect(nameOnly.deps.queueSync).toHaveBeenCalled();
  });

  // 키 설치는 이 실행 중 요청 창에 넣었던 값을 다시 쓰지 않는다(전과 같다).
  it("leaves out the prompt values remembered for reconnecting when asked to", async () => {
    const { coordinator } = createTeamCoordinator(null);
    await coordinator.persistHostSpecificSecret("team-host", "Shared", { passphrase: "typed" });

    await expect(coordinator.resolveSshAuth(teamHost)).resolves.toMatchObject({ secrets: { passphrase: "typed" } });
    const withoutCache = await coordinator.resolveSshAuth(teamHost, undefined, { includeRuntimeCache: false });
    expect(withoutCache.secrets.passphrase).toBeUndefined();
    clearRuntimeSecretCache();
  });

  // 붙기 전에 기억하면, 다른 까닭(점프 홉)으로 실패한 뒤 다음 접속이 그 값으로 붙고도 저장하지 않아 앱을 다시
  // 켜면 또 물었다.
  it("remembers prompt values for reconnecting only once the connection succeeded", async () => {
    const { coordinator } = createTeamCoordinator(null);
    await coordinator.resolveSshAuth(teamHost, { password: "typed" });

    await expect(coordinator.resolveSshAuth(teamHost)).resolves.not.toMatchObject({ secrets: { password: "typed" } });

    await coordinator.persistHostSpecificSecret("team-host", "Shared", { password: "typed" });
    await expect(coordinator.resolveSshAuth(teamHost)).resolves.toMatchObject({ secrets: { password: "typed" } });
    clearRuntimeSecretCache();
  });

  it("gives RDP and VNC my credentials first, else the team's with my account name", async () => {
    const withMine = createTeamCoordinator({ username: "alice", domain: "CORP", password: "mine" });
    await expect(withMine.coordinator.loadHostSecrets(teamHost)).resolves.toEqual({
      username: "alice",
      domain: "CORP",
      password: "mine",
    });
    expect(withMine.loadSecret).not.toHaveBeenCalled();

    const nameOnly = createTeamCoordinator({ username: "alice" });
    await expect(nameOnly.coordinator.loadHostSecrets(teamHost)).resolves.toMatchObject({
      username: "alice",
      privateKeyPem: "TEAM-PEM",
    });

    const none = createTeamCoordinator(null);
    await expect(none.coordinator.loadHostSecrets(teamHost)).resolves.toMatchObject({
      username: "deploy",
      privateKeyPem: "TEAM-PEM",
    });
  });
});

describe("normalizeHostEnvVars", () => {
  it("keeps valid vars, drops invalid keys, strips newlines, caps count", () => {
    expect(
      normalizeHostEnvVars([
        { key: "FOO", value: "bar" },
        { key: " SPACED ", value: "x" },
        { key: "1BAD", value: "y" },
        { key: "OK2", value: "a\r\nb" },
      ]),
    ).toEqual([
      { key: "FOO", value: "bar" },
      { key: "SPACED", value: "x" },
      { key: "OK2", value: "ab" },
    ]);
    expect(normalizeHostEnvVars(undefined)).toEqual([]);
    expect(
      normalizeHostEnvVars(
        Array.from({ length: 150 }, (_, index) => ({
          key: `K${index}`,
          value: "v",
        })),
      ),
    ).toHaveLength(100);
  });
});
