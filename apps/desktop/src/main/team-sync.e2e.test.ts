import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncWatchLoopOptions } from "@shared";

/*
 * 팀 볼트를 실제 서버(services/sync-api)에 붙여 처음부터 끝까지 돌린다.
 *
 * 다른 팀 시험은 가짜 서버에 붙는다. 그 가짜는 실제 서버를 보고 따라 만든 것이라, 필드 이름·헤더·
 * ETag·감시 응답이 어긋나도 그 시험들은 통과한다. 여기서는 서버를 빌드해 임시 SQLite 로 띄우고, 계정
 * 둘(A·B)을 API 로 만든 뒤 앱의 실제 코드(팀 동기화·팀 관리·카탈로그·저장소·실제 상태 파일)를 기기
 * 셋(A 의 기기 둘, B)에 붙인다.
 *
 * Go 가 있어야 하고 빌드까지 1분 안팎 걸려 평소 시험에서는 건너뛴다. 돌리려면:
 *   npm run test:desktop:team-e2e   (DOLGATE_TEAM_E2E=1)
 */

const RUN = process.env.DOLGATE_TEAM_E2E === "1";
const SYNC_API_DIR = fileURLToPath(new URL("../../../../services/sync-api", import.meta.url));
const PASSWORD = "team-e2e-password-1234";
const CLIENT_HEADERS = { "X-Dolgate-Client": "desktop", "X-Dolgate-Client-Version": "1.9.14" };

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getVersion: vi.fn(() => "1.9.14-e2e"),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
  },
}));

interface Account {
  email: string;
  userId: string;
  accessToken: string;
  /** 개인 DEK. 서버는 모른다 — 서버에는 감싼 것(여기서는 아무 바이트)만 올라간다. */
  dekBase64: string;
  epoch: number;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function decrypt<T = Record<string, unknown>>(payload: string, keyBase64: string): T {
  const envelope = JSON.parse(payload) as { iv: string; tag: string; ciphertext: string };
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"),
  ) as T;
}

describe.skipIf(!RUN)("team vault against the real sync server", () => {
  let workDir = "";
  let server: ChildProcess | null = null;
  let serverLog = "";
  let baseUrl = "";
  let accountA: Account;
  let accountB: Account;
  let deviceA1: Awaited<ReturnType<typeof createDevice>>;
  let deviceA2: Awaited<ReturnType<typeof createDevice>>;
  let deviceB: Awaited<ReturnType<typeof createDevice>>;
  let teamId = "";
  let link = "";
  let secretRef = "";

  async function api(
    token: string | null,
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; etag: string | null; body: Record<string, unknown> }> {
    const response = await fetch(new URL(pathname, baseUrl), {
      method,
      headers: {
        // 실제 앱처럼 이름과 버전을 밝힌다. 안 밝히면 서버가 옛 클라이언트로 보고 v1(서버 보관 키) 볼트를 만든다.
        ...CLIENT_HEADERS,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      etag: response.headers.get("etag"),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  /** 계정을 만들고 v2 볼트(E2EE)를 연다. DEK 는 시험이 만들고, 서버에는 감싼 것 대신 아무 바이트를 올린다. */
  async function createAccount(email: string): Promise<Account> {
    const signup = await api(null, "POST", "/auth/signup", { email, password: PASSWORD });
    expect(signup.status, JSON.stringify(signup.body)).toBe(201);
    const session = signup.body as {
      user: { id: string };
      tokens: { accessToken: string };
      vaultBootstrap?: { epoch?: number };
    };
    const vault = await api(session.tokens.accessToken, "POST", "/auth/vault", {
      wrappedDekBase64: randomBytes(60).toString("base64"),
      dekVerifierBase64: randomBytes(32).toString("base64"),
      kdf: {
        algorithm: "argon2id",
        saltBase64: randomBytes(16).toString("base64"),
        memoryKib: 64 * 1024,
        timeCost: 3,
        parallelism: 1,
      },
      expectedEpoch: session.vaultBootstrap?.epoch ?? 0,
    });
    expect(vault.status, JSON.stringify(vault.body)).toBe(200);
    return {
      email,
      userId: session.user.id,
      accessToken: session.tokens.accessToken,
      dekBase64: randomBytes(32).toString("base64"),
      epoch: Number(vault.body.epoch),
    };
  }

  /** 기기 하나 — 자기 상태 파일과 모듈(저장소 싱글턴 포함)을 따로 가진다. */
  async function createDevice(name: string, account: Account) {
    const dataDir = mkdtempSync(path.join(workDir, `${name}-`));
    process.env.DOLSSH_USER_DATA_DIR = dataDir;
    vi.resetModules();
    const stateStorage = await import("./state-storage");
    stateStorage.resetDesktopStateStorageForTests();
    // 데이터 폴더는 만들어질 때 정해진다 — 다른 기기를 만들어도 이 기기는 제 폴더에 쓴다.
    const storage = stateStorage.getDesktopStateStorage();
    storage.getState();
    const database = await import("./database");
    const vaultRoot = await import("./vault-root");
    const vaultCatalog = await import("./vault-catalog");
    const teamVaultScope = await import("./team-vault-scope");
    const { TeamSyncService } = await import("./team-sync-service");
    const { TeamService } = await import("./team-service");
    const { SecretStore } = await import("./secret-store");
    const { VaultCopyService } = await import("./vault-copy-service");

    const context = {
      userId: account.userId,
      serverUrl: baseUrl,
      accessToken: account.accessToken,
      vaultKeyBase64: account.dekBase64,
      vaultEpoch: account.epoch as number | null,
    };
    const auth = {
      getState: () => ({ status: "authenticated" }),
      getVaultStatus: () => "unlocked",
      captureSyncContext: () => ({ ...context }),
      isSyncContextCurrent: (candidate: typeof context) =>
        candidate.userId === context.userId &&
        candidate.serverUrl === context.serverUrl &&
        candidate.vaultKeyBase64 === context.vaultKeyBase64 &&
        candidate.vaultEpoch === context.vaultEpoch,
      refreshSession: async () => ({ status: "authenticated" }),
      getAccessToken: () => context.accessToken,
      getClientIdentificationHeaders: () => ({ ...CLIENT_HEADERS }),
    };
    const loops: Array<{ options: SyncWatchLoopOptions; stopped: boolean }> = [];
    const secretStore = new SecretStore();
    const service = new TeamSyncService({
      auth,
      secretStore,
      // 감시 루프는 시험이 한 바퀴씩 돌린다 — 바뀐 것이 없을 때 돌리면 서버가 25초 안팎 붙들고 있다.
      startWatchLoop: (options) => {
        const entry = { options, stopped: false };
        loops.push(entry);
        return {
          stop: () => {
            entry.stopped = true;
          },
          retryNow: () => undefined,
        };
      },
    });
    const teams = new TeamService({ auth, teamSync: service });
    const catalog = vaultCatalog.createVaultCatalog(
      vaultCatalog.pickVaultRepositories(
        {
          hosts: new database.HostRepository(),
          groups: new database.GroupRepository(),
          tailnets: new database.TailnetRepository(),
          portForwards: new database.PortForwardRepository(),
          dnsOverrides: new database.DnsOverrideRepository(),
          snippets: new database.SnippetRepository(),
          savedWorkspaces: new database.SavedWorkspaceRepository(),
          knownHosts: new database.KnownHostRepository(),
          secretMetadata: new database.SecretMetadataRepository(),
          awsProfiles: new database.AwsProfileRepository(),
          syncOutbox: new database.SyncOutboxRepository(),
        },
        secretStore,
      ),
      teamVaultScope.createStoredTeamVaults(),
    );
    // 복사하는 IPC 가 하는 일 그대로 — 쓰고 나서 동기화는 시험이 직접 건다.
    const copies = new VaultCopyService({ vaults: catalog, onCopied: () => undefined });
    /** 살아 있는 감시 루프를 한 바퀴씩. 바뀐 것이 있을 때만 부른다. */
    const tick = async () => {
      for (const entry of loops.filter((candidate) => !candidate.stopped)) {
        const outcome = await entry.options.watch(new AbortController().signal);
        if (outcome === "changed" && !entry.stopped) {
          await entry.options.onChange();
        }
      }
    };
    return {
      name,
      account,
      storage,
      service,
      teams,
      catalog,
      copies,
      secretStore,
      database,
      vaultRoot,
      tick,
      activeLoops: () => loops.filter((entry) => !entry.stopped).length,
    };
  }

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-e2e-"));
    const binary = path.join(workDir, "sync-api");
    execFileSync("go", ["build", "-o", binary, "./cmd/api"], { cwd: SYNC_API_DIR, stdio: "pipe", timeout: 240_000 });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(binary, [], {
      cwd: workDir,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: `file:${path.join(workDir, "sync.db")}`,
        AUTH_SIGNING_PRIVATE_KEY_PATH: path.join(workDir, "signing.pem"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => (serverLog += String(chunk)));
    server.stderr?.on("data", (chunk) => (serverLog += String(chunk)));
    const deadline = Date.now() + 30_000;
    for (;;) {
      const healthy = await fetch(new URL("/healthz", baseUrl)).then((response) => response.ok).catch(() => false);
      if (healthy) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`sync-api did not start:\n${serverLog}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    accountA = await createAccount("a@team-e2e.test");
    accountB = await createAccount("b@team-e2e.test");
    deviceA1 = await createDevice("a1", accountA);
    deviceB = await createDevice("b", accountB);
  }, 300_000);

  afterAll(() => {
    server?.kill("SIGTERM");
    delete process.env.DOLSSH_USER_DATA_DIR;
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("A creates a team and shares a host whose password stays in the team, sealed with the team key", async () => {
    const created = await deviceA1.teams.create("Acme");
    teamId = created.id;
    expect(created).toMatchObject({ name: "Acme", role: "owner", syncState: "ready" });

    // 호스트를 만드는 IPC 가 하는 일 그대로: 비밀값은 그 팀 볼트에, 호스트는 그 팀에.
    const scope = deviceA1.catalog.getScope(teamId)!;
    secretRef = "secret:team-e2e-password";
    await scope.secrets.save(
      secretRef,
      JSON.stringify({ secretRef, label: "prod", password: "hunter2", updatedAt: new Date().toISOString() }),
    );
    scope.secretMetadata.upsert({ secretRef, label: "prod", hasPassword: true, hasPassphrase: false });
    deviceA1.catalog.createHost(
      teamId,
      "team-host",
      {
        kind: "ssh",
        label: "prod",
        hostname: "prod.internal",
        port: 22,
        username: "ubuntu",
        authType: "password",
        agentForwarding: true,
        terminalThemeId: "night-owl",
      },
      secretRef,
    );
    await deviceA1.service.pushDirty();

    // 서버에는 팀 키로 잠긴 것만 있고, 사람마다 다른 값은 들어 있지 않다.
    const { unwrapTeamDek } = await import("@shared");
    const wrapped = deviceA1.storage.getTeamState(teamId)!.info.wrappedTeamDek!;
    const teamKey = Buffer.from(unwrapTeamDek(wrapped, Buffer.from(accountA.dekBase64, "base64"), teamId)).toString("base64");
    const snapshot = await api(accountA.accessToken, "GET", `/teams/${teamId}/sync`);
    expect(snapshot.status).toBe(200);
    const hosts = snapshot.body.hosts as Array<{ id: string; encrypted_payload: string }>;
    expect(hosts.map((record) => record.id)).toEqual(["team-host"]);
    expect(decrypt(hosts[0].encrypted_payload, teamKey)).toMatchObject({
      label: "prod",
      favorite: null,
      terminalThemeId: null,
      agentForwarding: null,
    });
    const secrets = snapshot.body.secrets as Array<{ id: string; encrypted_payload: string }>;
    expect(secrets.map((record) => record.id)).toEqual([secretRef]);
    expect(decrypt(secrets[0].encrypted_payload, teamKey)).toMatchObject({ password: "hunter2" });
    expect(() => decrypt(hosts[0].encrypted_payload, accountA.dekBase64)).toThrow();
  }, 60_000);

  it("B joins with the invite link and receives the host and its password", async () => {
    ({ link } = await deviceA1.teams.createInvite(teamId));
    expect(link.startsWith(`${baseUrl}/invite/`)).toBe(true);

    await expect(deviceB.teams.getInviteInfo(link)).resolves.toMatchObject({
      teamId,
      teamName: "Acme",
      inviterEmail: accountA.email,
      memberCount: 1,
      alreadyJoined: false,
    });
    await expect(deviceB.teams.join(link)).resolves.toMatchObject({ id: teamId, role: "member", syncState: "ready" });
    await deviceB.tick();

    expect(deviceB.catalog.getHost("team-host")).toMatchObject({ label: "prod", agentForwarding: null, terminalThemeId: null });
    await expect(deviceB.catalog.loadSecret(secretRef)).resolves.toContain("hunter2");
    const members = await deviceA1.teams.listMembers(teamId);
    expect(members.map((member) => [member.email, member.role, member.hasKey]).sort()).toEqual([
      [accountA.email, "owner", true],
      [accountB.email, "member", true],
    ]);
  }, 60_000);

  it("A's rename reaches B by waking B's waiting watch", async () => {
    const started = Date.now();
    // B 는 바뀐 것이 없으니 서버가 붙들고 있다. A 가 올리면 그 자리에서 깨어나야 한다.
    const waking = deviceB.tick();
    await new Promise((resolve) => setTimeout(resolve, 500));
    deviceA1.catalog.updateHost("team-host", {
      kind: "ssh",
      label: "prod-renamed",
      hostname: "prod.internal",
      port: 22,
      username: "ubuntu",
      authType: "password",
      agentForwarding: true,
      terminalThemeId: "night-owl",
    }, secretRef);
    await deviceA1.service.pushDirty();
    await waking;

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(deviceB.catalog.getHost("team-host")).toMatchObject({ label: "prod-renamed" });
  }, 60_000);

  it("keeps each member's favorite with that member, synced only across their own devices", async () => {
    deviceB.catalog.setHostFavorite("team-host", true);
    await deviceB.service.pushDirty();

    // A 의 두 번째 기기 — 같은 계정·같은 개인 DEK 로 새로 들어온다.
    deviceA2 = await createDevice("a2", accountA);
    await deviceA2.service.refreshTeams();
    await deviceA2.tick();
    expect(deviceA2.catalog.getHost("team-host")).toMatchObject({ label: "prod-renamed", favorite: null });
    expect(deviceA1.catalog.getHost("team-host")).toMatchObject({ favorite: null });
    // A 가 A1 에서 정한 agent forwarding 은 A2 로 온다(내 개인 칸). B 에게는 안 간다.
    expect(deviceA2.catalog.getHost("team-host")).toMatchObject({ agentForwarding: true });
    expect(deviceB.catalog.getHost("team-host")).toMatchObject({ agentForwarding: null });

    deviceA1.catalog.setHostFavorite("team-host", true);
    await deviceA1.service.pushDirty();
    await deviceA2.tick();
    expect(deviceA2.catalog.getHost("team-host")).toMatchObject({ favorite: true });

    deviceB.catalog.setHostFavorite("team-host", false);
    await deviceB.service.pushDirty();
    expect(deviceB.catalog.getHost("team-host")).toMatchObject({ favorite: null });
    expect(deviceA1.catalog.getHost("team-host")).toMatchObject({ favorite: true });
  }, 60_000);

  it("settles two members' edits of the same host on the later one, even when the older one is pushed last", async () => {
    const draft = (label: string) => ({
      kind: "ssh" as const,
      label,
      hostname: "prod.internal",
      port: 22,
      username: "ubuntu",
      authType: "password" as const,
    });
    deviceA1.catalog.updateHost("team-host", draft("from-a"), secretRef);
    await new Promise((resolve) => setTimeout(resolve, 20));
    deviceB.catalog.updateHost("team-host", draft("from-b"), secretRef);
    await deviceB.service.pushDirty();
    // A 의 편집이 먼저였다 — 나중에 올려도 지고, A 는 B 의 것을 받는다.
    await deviceA1.service.pushDirty();
    await deviceA2.tick();

    for (const device of [deviceA1, deviceA2, deviceB]) {
      expect(device.catalog.getHost("team-host"), device.name).toMatchObject({ label: "from-b" });
    }
  }, 60_000);

  it("pushes nothing when nothing changed", async () => {
    const before = await api(accountA.accessToken, "GET", `/teams/${teamId}/sync`);
    await deviceA1.service.pushDirty();
    await deviceB.service.pushDirty();
    const after = await api(accountA.accessToken, "GET", `/teams/${teamId}/sync`);
    expect(after.etag).toBe(before.etag);
  }, 60_000);

  it("A copies a personal host and its jump host into the team, and B connects with the copied password", async () => {
    // A1 의 개인 볼트: 점프 호스트를 거치는 호스트, 둘이 함께 쓰는 비밀번호.
    await deviceA1.secretStore.save(
      "secret:a-personal",
      JSON.stringify({ secretRef: "secret:a-personal", label: "mine", password: "a-personal-pw", updatedAt: new Date().toISOString() }),
    );
    const personalHosts = new deviceA1.database.HostRepository();
    const draft = (label: string) => ({
      kind: "ssh" as const,
      label,
      hostname: `${label}.internal`,
      port: 22,
      username: "ops",
      authType: "password" as const,
    });
    personalHosts.create("copy-bastion", draft("bastion"), "secret:a-personal");
    personalHosts.create("copy-web", { ...draft("web"), jumpHostIds: ["copy-bastion"] }, "secret:a-personal");

    const result = deviceA1.copies.copy({
      sourceVaultId: "personal",
      targetVaultId: teamId,
      selection: { kind: "hosts", hostIds: ["copy-web"] },
      targetGroupPath: "Shared",
    });
    await deviceA1.service.pushDirty();
    await deviceB.tick();

    // B 는 팀 볼트에서 복사본을 받고, 점프 호스트도 복사본끼리 이어져 있으며, 비밀번호를 연다.
    const webOnB = deviceB.catalog.getHost(result.hostIds["copy-web"]) as Record<string, unknown> | null;
    expect(webOnB).toMatchObject({
      label: "web",
      groupName: "Shared",
      jumpHostIds: [result.hostIds["copy-bastion"]],
    });
    expect(deviceB.catalog.scopeOfHost(result.hostIds["copy-web"]).id).toBe(teamId);
    expect(deviceB.catalog.getHostInSameVault(result.hostIds["copy-web"], result.hostIds["copy-bastion"])).not.toBeNull();
    await expect(deviceB.catalog.loadSecret(String(webOnB?.secretRef))).resolves.toContain("a-personal-pw");
    // A 의 개인 원본은 그대로이고, B 의 개인 볼트에는 아무것도 오지 않는다.
    expect(deviceA1.storage.getState().data.hosts.map((host) => host.id).sort()).toEqual(["copy-bastion", "copy-web"]);
    expect(deviceB.storage.getState().data.hosts).toEqual([]);
  }, 60_000);

  it("A's own login to a team host follows A to A2, locked with A's key, and never reaches B", async () => {
    deviceA1.catalog.setMyHostCredentials("team-host", { username: "alice", authType: "password", password: "a-own-pw" });
    await deviceA1.service.pushDirty();
    await deviceA2.tick();
    expect(deviceA2.catalog.getMyHostCredentials("team-host")).toMatchObject({ username: "alice", password: "a-own-pw" });

    // 서버에는 A 의 개인 칸에만, A 의 개인 DEK 로 잠겨 있다 — 팀 키로는 안 열린다.
    const { unwrapTeamDek } = await import("@shared");
    const wrapped = deviceA1.storage.getTeamState(teamId)!.info.wrappedTeamDek!;
    const teamKey = Buffer.from(unwrapTeamDek(wrapped, Buffer.from(accountA.dekBase64, "base64"), teamId)).toString("base64");
    const mine = await api(accountA.accessToken, "GET", `/teams/${teamId}/me`);
    const records = mine.body.hostCredentials as Array<{ id: string; encrypted_payload: string }>;
    expect(records.map((record) => record.id)).toEqual(["team-host"]);
    expect(decrypt(records[0].encrypted_payload, accountA.dekBase64)).toMatchObject({
      credentials: { username: "alice", password: "a-own-pw" },
    });
    expect(() => decrypt(records[0].encrypted_payload, teamKey)).toThrow();
    // B 의 개인 칸에도, 팀 레코드에도 없다.
    const theirs = await api(accountB.accessToken, "GET", `/teams/${teamId}/me`);
    expect(theirs.body.hostCredentials ?? []).toEqual([]);
    const team = await api(accountB.accessToken, "GET", `/teams/${teamId}/sync`);
    expect(team.body.hostCredentials ?? []).toEqual([]);
    expect(JSON.stringify(team.body)).not.toContain("a-own-pw");
    expect(deviceB.catalog.getMyHostCredentials("team-host")).toBeNull();

    // 지우면 A2 에서도 지워진다.
    deviceA1.catalog.setMyHostCredentials("team-host", null);
    await deviceA1.service.pushDirty();
    await deviceA2.tick();
    expect(deviceA2.catalog.getMyHostCredentials("team-host")).toBeNull();
  }, 60_000);

  it("A shares a host without its password: B gets the host only, while A and A2 connect with A's own", async () => {
    await deviceA1.secretStore.save(
      "secret:a-quiet",
      JSON.stringify({ secretRef: "secret:a-quiet", label: "quiet", password: "a-quiet-pw", updatedAt: new Date().toISOString() }),
    );
    new deviceA1.database.HostRepository().create(
      "quiet",
      { kind: "ssh", label: "quiet", hostname: "quiet.internal", port: 22, username: "ops", authType: "password" },
      "secret:a-quiet",
    );

    const result = deviceA1.copies.copy({
      sourceVaultId: "personal",
      targetVaultId: teamId,
      selection: { kind: "hosts", hostIds: ["quiet"] },
      shareSecrets: false,
    });
    await deviceA1.service.pushDirty();
    await deviceB.tick();
    await deviceA2.tick();

    const copyId = result.hostIds.quiet;
    // B 는 호스트만 받는다 — 비밀값도 A 의 자격 증명도 없어서, 처음 접속할 때 자기 것을 넣는다.
    expect(deviceB.catalog.getHost(copyId)).toMatchObject({ label: "quiet", username: "ops", secretRef: null });
    expect(deviceB.catalog.getMyHostCredentials(copyId)).toBeNull();
    // A 의 두 기기는 A 의 자격 증명으로 그대로 붙는다.
    expect(deviceA1.catalog.getMyHostCredentials(copyId)).toEqual({ password: "a-quiet-pw" });
    expect(deviceA2.catalog.getMyHostCredentials(copyId)).toEqual({ password: "a-quiet-pw" });
    // 서버의 팀 레코드에는 어디에도 없다.
    const { unwrapTeamDek } = await import("@shared");
    const wrapped = deviceA1.storage.getTeamState(teamId)!.info.wrappedTeamDek!;
    const teamKey = Buffer.from(unwrapTeamDek(wrapped, Buffer.from(accountA.dekBase64, "base64"), teamId)).toString("base64");
    const snapshot = await api(accountB.accessToken, "GET", `/teams/${teamId}/sync`);
    const opened = Object.values(snapshot.body)
      .filter((records): records is Array<{ encrypted_payload: string }> => Array.isArray(records))
      .flat()
      .filter((record) => typeof record?.encrypted_payload === "string")
      .map((record) => JSON.stringify(decrypt(record.encrypted_payload, teamKey)));
    expect(opened.some((text) => text.includes(copyId))).toBe(true);
    expect(opened.join("\n")).not.toContain("a-quiet-pw");
  }, 60_000);

  // AWS 정적 키와 tailnet auth key 는 사람의 인증 정보라 함께 공유여도 팀에 가지 않는다 — 팀에는 설정만.
  it("A shares an EC2 host and a tailnet host: the team gets the settings, the keys stay A's own", async () => {
    const at = new Date().toISOString();
    new deviceA1.database.AwsProfileRepository().upsert({
      id: "a-static",
      kind: "static",
      name: "a-prod",
      region: "ap-northeast-2",
      accessKeyId: "AKIAAONLY",
      secretAccessKey: "a-only-secret",
      updatedAt: at,
    });
    new deviceA1.database.TailnetRepository().save({ id: "a-tailnet", label: "corp", createdAt: at, updatedAt: at }, "tskey-a-only");
    const personalHosts = new deviceA1.database.HostRepository();
    personalHosts.create("a-ec2", {
      kind: "aws-ec2",
      label: "a-ec2",
      awsProfileId: "a-static",
      awsProfileName: "a-prod",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-0e2e000000000001",
    });
    personalHosts.create("a-tn", {
      kind: "ssh",
      label: "a-tn",
      hostname: "tn.internal",
      port: 22,
      username: "ops",
      authType: "password",
      tailnetId: "a-tailnet",
    });

    // 함께 공유(기본)로 복사한다.
    const result = deviceA1.copies.copy({
      sourceVaultId: "personal",
      targetVaultId: teamId,
      selection: { kind: "hosts", hostIds: ["a-ec2", "a-tn"] },
    });
    await deviceA1.service.pushDirty();
    await deviceB.tick();
    await deviceA2.tick();

    const ec2OnB = deviceB.catalog.getHost(result.hostIds["a-ec2"]) as Record<string, unknown> | null;
    const tnOnB = deviceB.catalog.getHost(result.hostIds["a-tn"]) as Record<string, unknown> | null;
    const profileId = String(ec2OnB?.awsProfileId);
    const tailnetId = String(tnOnB?.tailnetId);
    expect(ec2OnB).toMatchObject({ awsProfileName: "a-prod" });

    // 서버의 팀 레코드에는 설정만 있다.
    const { unwrapTeamDek } = await import("@shared");
    const wrapped = deviceA1.storage.getTeamState(teamId)!.info.wrappedTeamDek!;
    const teamKey = Buffer.from(unwrapTeamDek(wrapped, Buffer.from(accountA.dekBase64, "base64"), teamId)).toString("base64");
    const snapshot = await api(accountB.accessToken, "GET", `/teams/${teamId}/sync`);
    const opened = Object.values(snapshot.body)
      .filter((records): records is Array<{ encrypted_payload: string }> => Array.isArray(records))
      .flat()
      .filter((record) => typeof record?.encrypted_payload === "string")
      .map((record) => JSON.stringify(decrypt(record.encrypted_payload, teamKey)));
    expect(opened.some((text) => text.includes(profileId) && text.includes("a-prod"))).toBe(true);
    expect(opened.some((text) => text.includes(tailnetId) && text.includes("corp"))).toBe(true);
    expect(opened.join("\n")).not.toMatch(/AKIAAONLY|a-only-secret|tskey-a-only/);

    // 키는 A 의 개인 칸에만, A 의 개인 DEK 로 잠겨 있다.
    const mine = await api(accountA.accessToken, "GET", `/teams/${teamId}/me`);
    const sealed = (kind: string) =>
      (mine.body[kind] as Array<{ id: string; encrypted_payload: string }>).find((record) => record.id === (kind === "tailnetCredentials" ? tailnetId : profileId))!;
    expect(decrypt(sealed("awsProfileCredentials").encrypted_payload, accountA.dekBase64)).toMatchObject({
      credentials: { accessKeyId: "AKIAAONLY", secretAccessKey: "a-only-secret" },
    });
    expect(decrypt(sealed("tailnetCredentials").encrypted_payload, accountA.dekBase64)).toMatchObject({
      credentials: { authKey: "tskey-a-only" },
    });
    expect(() => decrypt(sealed("tailnetCredentials").encrypted_payload, teamKey)).toThrow();

    // A2 는 받아 코어에 자기 키로 넘기고, B 는 키가 없다(Tailscale 은 브라우저 로그인, 정적 키는 자기 것을 넣는다).
    expect(deviceA2.catalog.getScope(teamId)!.memberPrefs!.readAwsProfileCredentials(profileId)).toEqual({
      accessKeyId: "AKIAAONLY",
      secretAccessKey: "a-only-secret",
    });
    expect(deviceA2.catalog.listTailnetPayloads().find((tailnet) => tailnet.id === tailnetId)?.authKey).toBe("tskey-a-only");
    expect(deviceB.catalog.getScope(teamId)!.memberPrefs!.readAwsProfileCredentials(profileId)).toBeNull();
    expect(deviceB.catalog.listTailnetPayloads().find((tailnet) => tailnet.id === tailnetId)?.authKey).toBeUndefined();
  }, 60_000);

  it("removing B wipes B's copy and the old link stops working", async () => {
    await deviceA1.teams.removeMember(teamId, accountB.userId);
    await deviceB.tick();

    expect(deviceB.storage.listTeamIds()).toEqual([]);
    expect(deviceB.catalog.getHost("team-host")).toBeNull();
    await expect(deviceB.catalog.loadSecret(secretRef)).resolves.toBeNull();
    expect(deviceB.activeLoops()).toBe(0);
    await expect(deviceB.teams.getInviteInfo(link)).rejects.toMatchObject({ code: "team_invite_invalid" });
    // A 쪽은 그대로다.
    expect(deviceA1.catalog.getHost("team-host")).toMatchObject({ label: "from-b" });
    expect((await deviceA1.teams.listMembers(teamId)).map((member) => member.email)).toEqual([accountA.email]);
  }, 60_000);
});
