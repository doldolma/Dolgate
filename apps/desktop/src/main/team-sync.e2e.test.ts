import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActivityLogRecord, SessionReplaySegment, SyncWatchLoopOptions } from "@shared";

/*
 * 팀 볼트를 실제 서버(services/sync-api)에 붙여 처음부터 끝까지 돌린다.
 *
 * 다른 팀 시험은 가짜 서버에 붙는다. 그 가짜는 실제 서버를 보고 따라 만든 것이라, 필드 이름·헤더·
 * ETag·감시 응답이 어긋나도 그 시험들은 통과한다. 여기서는 서버를 빌드해 임시 SQLite 로 띄우고, 계정
 * 둘(A·B)을 API 로 만든 뒤 앱의 실제 코드(팀 동기화·팀 관리·카탈로그·저장소·실제 상태 파일)를 기기
 * 셋(A 의 기기 둘, B)에 붙인다. 팀 기록·녹화(올리기·보기)도 기기마다 실제 코드로 붙인다 — 서버는 녹화를 둘만
 * 남기게 띄워 오래된 녹화가 지워지는 것까지 본다. 나가는 멤버는 C 다(B 는 마지막에 내보낸다).
 *
 * Go 가 있어야 하고 빌드까지 1분 안팎 걸려 평소 시험에서는 건너뛴다. 돌리려면:
 *   npm run test:desktop:team-e2e   (DOLGATE_TEAM_E2E=1)
 */

const RUN = process.env.DOLGATE_TEAM_E2E === "1";
const SYNC_API_DIR = fileURLToPath(new URL("../../../../services/sync-api", import.meta.url));
const PASSWORD = "team-e2e-password-1234";
const CLIENT_HEADERS = { "X-Dolgate-Client": "desktop", "X-Dolgate-Client-Version": "1.9.14" };
/** 서버가 팀에 남기는 녹화 수. 셋째 녹화가 시작하면 가장 오래된 것이 지워진다. */
const REPLAY_MAX_COUNT = 2;
/** 셸 통합 표시가 있는 짧은 세션 — 명령 둘(ls -la, uptime). */
const SESSION_LINES: Array<[number, string]> = [
  [0, "ops@prod:~$ \x1b]133;B\x07"],
  [100, "ls -la\r\n\x1b]133;C\x07"],
  [150, "file-a\r\nfile-b\r\n"],
  [400, "\x1b]133;D;0\x07"],
  [410, "ops@prod:~$ \x1b]133;B\x07"],
  [500, "uptime\r\n\x1b]133;C\x07"],
  [600, " 10:00 up 3 days\r\n\x1b]133;D;0\x07"],
];

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
    // 팀을 잃으면 그 팀의 기록 대기열·녹화 올리기·녹화 캐시를 지운다(main.ts 의 연결 그대로).
    let forgetTeamHistory: (teamId: string) => void = () => undefined;
    const service = new TeamSyncService({
      auth,
      secretStore,
      onTeamForgotten: (forgotten) => forgetTeamHistory(forgotten),
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

    // 팀 기록·녹화 — 타이머 대신 시험이 보내기를 직접 건다(flush·pump).
    const { TeamApi } = await import("./team-api");
    const { TeamHistoryService, resolveLogTeamId } = await import("./team-history-service");
    const { TeamReplayUploads } = await import("./team-replay-uploads");
    const { TeamReplayViewer } = await import("./team-replay-viewer");
    const { TeamReplayCache } = await import("./team-replay-cache");
    const { createInProcessScanHost } = await import("./replay-scan-host");
    const teamApi = new TeamApi(auth);
    const openTeamAccess = (forTeam: string) => service.openTeamAccess(forTeam);
    const manualTimer = () => ({ cancel: () => undefined });
    const history = new TeamHistoryService({ api: teamApi, openTeamAccess, setTimer: manualTimer });
    history.setTeamResolver((metadata) => resolveLogTeamId(catalog, metadata));
    history.activate(dataDir);
    /** 이 기기에서 지금 녹화 중인 것(세션 서비스의 isRecordingActive). */
    const recording = new Set<string>();
    const uploads = new TeamReplayUploads({
      api: teamApi,
      getHistoryLimits: (access) => history.getHistoryLimits(access.lease),
      openTeamAccess,
      scanHost: createInProcessScanHost(),
      isRecordingActive: (recordingId) => recording.has(recordingId),
      onTruncated: () => undefined,
      setTimer: manualTimer,
    });
    uploads.activate(history.stateDirectoryPath!);
    const viewer = new TeamReplayViewer({ api: teamApi, openTeamAccess, cache: new TeamReplayCache() });
    viewer.activate(history.stateDirectoryPath!);
    forgetTeamHistory = (forgotten) => {
      history.forgetTeam(forgotten);
      uploads.forgetTeam(forgotten);
      viewer.forgetTeam(forgotten);
    };
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
      history,
      uploads,
      viewer,
      recording,
      replayCacheDir: path.join(history.stateDirectoryPath!, "replay-cache"),
    };
  }

  type Device = Awaited<ReturnType<typeof createDevice>>;

  /** 팀 호스트 접속 줄(core-manager 가 남기는 수명 기록). */
  function sessionRecord(sessionId: string, status: "connected" | "closed", recordingId: string, connectedAt: string): ActivityLogRecord {
    return {
      id: `session:${sessionId}`,
      level: "info",
      category: "session",
      kind: "session-lifecycle",
      message: "SSH 세션",
      messageKey: "core.sessionLog",
      messageParams: { kind: "SSH" },
      metadata: {
        sessionId,
        hostId: "team-host",
        hostLabel: "from-b",
        title: "from-b",
        connectionKind: "ssh",
        connectedAt,
        disconnectedAt: status === "closed" ? new Date().toISOString() : null,
        status,
        recordingId,
        hasReplay: true,
      },
      createdAt: connectedAt,
      updatedAt: new Date().toISOString(),
    } as ActivityLogRecord;
  }

  /**
   * 팀 호스트 세션 하나 — 세션 서비스가 하는 일 그대로: 접속 줄을 남기고, 실제 녹화 쓰기가 구간을 끊어 넘기는 대로
   * 올리기에 주고, 세션 동안 한 번 보낸 뒤 끝을 알린다. 로컬 녹화 파일 자리를 돌려준다.
   */
  async function recordTeamSession(device: Device, recordingId: string, onLive?: () => Promise<void>) {
    // 세션마다 다른 ID — 접속 줄의 기록 ID 가 여기서 나오고, 서버는 같은 기록 ID 를 다시 보낸 것으로 본다.
    const sessionId = `session-${recordingId}`;
    const connectedAt = new Date().toISOString();
    const replayDir = mkdtempSync(path.join(workDir, `${device.name}-replays-`));
    device.history.mirror(sessionRecord(sessionId, "connected", recordingId, connectedAt));
    device.recording.add(recordingId);
    device.uploads.onRecordingStarted({
      recordingId,
      teamId,
      replayDirectoryPath: replayDir,
      startMeta: {
        sessionId,
        hostId: "team-host",
        hostLabel: "from-b",
        title: "from-b",
        connectionDetails: "ops@prod.internal:22",
        connectionKind: "ssh",
        connectedAt,
        initialCols: 80,
        initialRows: 24,
      },
    });
    const { ReplayEventsWriter } = await import("./session-replay-events");
    const writer = new ReplayEventsWriter(
      path.join(replayDir, `${recordingId}.events.jsonl.gz`),
      path.join(replayDir, `${recordingId}.index.jsonl`),
      { segmentBytes: 160, onSegment: (record, index, data) => device.uploads.onSegment(recordingId, index, record, data) },
    );
    for (const [atMs, text] of SESSION_LINES) {
      writer.append(JSON.stringify({ type: "output", atMs, dataBase64: Buffer.from(text).toString("base64") }), atMs, text.length);
    }
    await writer.end();
    // 세션 동안 — 끝난 구간은 벌써 팀에 간다.
    await device.history.flush();
    await device.uploads.pump();
    await onLive?.();
    device.uploads.onRecordingEnded(recordingId, {
      disconnectedAt: new Date().toISOString(),
      durationMs: SESSION_LINES[SESSION_LINES.length - 1]![0],
      lastSegment: writer.segments.length - 1,
    });
    device.recording.delete(recordingId);
    device.history.mirror(sessionRecord(sessionId, "closed", recordingId, connectedAt));
    await device.history.flush();
    await device.uploads.pump();
    return { replayDir, segments: writer.segments.length };
  }

  /** 이 기기의 녹화 파일을 처음부터 끝까지 읽는다. */
  async function readLocalRecording(replayDir: string, recordingId: string): Promise<SessionReplaySegment> {
    const { loadReplaySegments, readReplaySegment } = await import("./session-replay-events");
    const { concatReplaySegments } = await import("./replay-segment-groups");
    const events = path.join(replayDir, `${recordingId}.events.jsonl.gz`);
    const records = await loadReplaySegments({
      events,
      legacyEvents: path.join(replayDir, `${recordingId}.events.jsonl`),
      index: path.join(replayDir, `${recordingId}.index.jsonl`),
    });
    return concatReplaySegments(await Promise.all(records.map((record) => readReplaySegment(events, record))));
  }

  /** 팀 녹화를 보는 쪽처럼 연다: 녹화 정보와 구간 전부. */
  async function playTeamRecording(device: Device, recordingId: string) {
    const { concatReplaySegments } = await import("./replay-segment-groups");
    const view = await device.viewer.load(teamId, recordingId);
    const parts: SessionReplaySegment[] = [];
    for (let index = 0; index < view.segments.length; index += 1) {
      parts.push(await device.viewer.readSegment(teamId, recordingId, index));
    }
    return { view, played: concatReplaySegments(parts) };
  }

  function sameEntries(left: SessionReplaySegment, right: SessionReplaySegment): boolean {
    return (
      [...left.atMs].join(",") === [...right.atMs].join(",") &&
      [...left.dataEnd].join(",") === [...right.dataEnd].join(",") &&
      Buffer.from(left.data).equals(Buffer.from(right.data))
    );
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
        TEAM_REPLAY_MAX_COUNT: String(REPLAY_MAX_COUNT),
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
    // B 도 A 가 만든 링크를 목록에서 다시 복사한다 — 서버의 잠근 비밀값을 B 의 팀 키로 연다.
    const invites = await deviceB.teams.listInvites(teamId);
    expect(invites.find((invite) => link.includes(`/invite/${invite.code}#`))?.link).toBe(link);

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

  // AWS 정적 키와 tailnet auth key 는 사람의 인증 정보라 함께 공유여도 팀에 가지 않는다 — 팀에는 설정만. 키는 동기화하지
  // 않으니 공유한 기기(A1)에만 남아 거기서 바로 쓰고, A 의 다른 기기와 B 에는 없다.
  it("A shares an EC2 host and a tailnet host: the team gets the settings, the keys stay on the device that shared them", async () => {
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

    // 키는 A 의 개인 칸(/me)에도 올라가지 않는다.
    const mine = await api(accountA.accessToken, "GET", `/teams/${teamId}/me`);
    expect(mine.body.awsProfileCredentials ?? []).toEqual([]);
    expect(mine.body.tailnetCredentials ?? []).toEqual([]);

    // 공유한 A1 에서는 키가 채워져 바로 쓴다. A 의 다른 기기(A2)와 B 에는 없다 — 거기서는 넣어야 한다(Tailscale 은
    // 비워 두면 브라우저 로그인).
    const keysOn = (device: typeof deviceA1) => ({
      aws: device.catalog.getScope(teamId)!.awsProfiles.getPayloadById(profileId),
      authKey: device.catalog.listTailnetPayloads().find((tailnet) => tailnet.id === tailnetId)?.authKey,
    });
    expect(keysOn(deviceA1)).toEqual({
      aws: expect.objectContaining({ accessKeyId: "AKIAAONLY", secretAccessKey: "a-only-secret" }),
      authKey: "tskey-a-only",
    });
    for (const device of [deviceA2, deviceB]) {
      expect(keysOn(device)).toEqual({
        aws: expect.objectContaining({ accessKeyId: "", secretAccessKey: "" }),
        authKey: undefined,
      });
    }
  }, 60_000);

  // 팀 호스트 세션은 접속 기록과 녹화가 팀에 남는다 — 서버는 잠긴 것만 보고, B 는 받아 열어 본다.
  const recordingIds = [
    "5e1f0c3a-1b2c-4d5e-8f60-000000000001",
    "5e1f0c3a-1b2c-4d5e-8f60-000000000002",
    "5e1f0c3a-1b2c-4d5e-8f60-000000000003",
    "5e1f0c3a-1b2c-4d5e-8f60-000000000004",
  ];

  it("A's team host session reaches B as activity and a recording B plays exactly like A's file", async () => {
    let sawLive = false;
    const { replayDir, segments } = await recordTeamSession(deviceA1, recordingIds[0]!, async () => {
      // 아직 세션 중 — B 는 이미 접속 줄을 보고 녹화를 열 수 있다.
      const [status] = await deviceB.history.getReplayStatuses(teamId, [recordingIds[0]!]);
      expect(status).toMatchObject({ state: "live", authorEmail: accountA.email });
      expect(status!.segmentCount).toBeGreaterThan(0);
      const [start] = await deviceB.history.listActivity(teamId, { limit: 1 });
      expect(start).toMatchObject({ authorEmail: accountA.email, activity: { phase: "start" } });
      expect(start!.activity!.record.metadata).toMatchObject({ status: "connected", recordingId: recordingIds[0] });
      sawLive = true;
    });
    expect(sawLive).toBe(true);
    expect(segments).toBeGreaterThan(1);

    // 끝난 뒤 — 끝 줄과 끝난 녹화.
    const [end] = await deviceB.history.listActivity(teamId, { limit: 1 });
    expect(end).toMatchObject({ authorEmail: accountA.email, activity: { phase: "end" } });
    expect(end!.activity!.record.metadata).toMatchObject({ status: "closed", recordingId: recordingIds[0] });
    const { view, played } = await playTeamRecording(deviceB, recordingIds[0]!);
    expect(view.team).toMatchObject({ teamId, authorEmail: accountA.email, state: "ended" });
    expect(view.team!.commands!.blocks.map((block) => block.command)).toEqual(["ls -la", "uptime"]);
    expect(view).toMatchObject({ hostLabel: "from-b", connectionDetails: "ops@prod.internal:22", initialCols: 80 });
    expect(sameEntries(played, await readLocalRecording(replayDir, recordingIds[0]!))).toBe(true);
    expect(existsSync(path.join(deviceB.replayCacheDir, teamId, recordingIds[0]!))).toBe(true);

    // 서버에는 잠긴 것만 있다 — 호스트 이름도 명령도 평문으로 없다.
    const rawEvents = await api(accountB.accessToken, "GET", `/teams/${teamId}/events`);
    expect(rawEvents.status).toBe(200);
    expect(JSON.stringify(rawEvents.body)).not.toMatch(/from-b|prod\.internal/);
    const rawReplay = await api(accountB.accessToken, "GET", `/teams/${teamId}/replays/${recordingIds[0]}`);
    expect(JSON.stringify(rawReplay.body)).not.toMatch(/from-b|ls -la|uptime/);
  }, 60_000);

  it("keeps only the newest recordings: the oldest is gone for B, and B's copy of it goes too", async () => {
    await recordTeamSession(deviceA1, recordingIds[1]!);
    await recordTeamSession(deviceA1, recordingIds[2]!);

    const statuses = await deviceB.history.getReplayStatuses(teamId, recordingIds.slice(0, 3));
    expect(Object.fromEntries(statuses.map((status) => [status.recordingId, status.state]))).toEqual({
      [recordingIds[0]!]: "deleted",
      [recordingIds[1]!]: "ended",
      [recordingIds[2]!]: "ended",
    });
    await expect(deviceB.viewer.load(teamId, recordingIds[0]!)).rejects.toMatchObject({ code: "team_replay_deleted" });
    // 지워진 녹화의 캐시도 지운다.
    expect(existsSync(path.join(deviceB.replayCacheDir, teamId, recordingIds[0]!))).toBe(false);
    await expect(playTeamRecording(deviceB, recordingIds[2]!)).resolves.toMatchObject({ view: { team: { state: "ended" } } });
  }, 60_000);

  it("a member who leaves stays in the team's history: A sees C's session, recording and leaving", async () => {
    const accountC = await createAccount("c@team-e2e.test");
    const deviceC = await createDevice("c", accountC);
    const invite = await deviceA1.teams.createInvite(teamId);
    await expect(deviceC.teams.join(invite.link)).resolves.toMatchObject({ id: teamId, role: "member" });
    await deviceC.tick();
    expect(deviceC.catalog.scopeOfHost("team-host").id).toBe(teamId);

    const { replayDir } = await recordTeamSession(deviceC, recordingIds[3]!);
    await playTeamRecording(deviceC, recordingIds[2]!);
    expect(existsSync(path.join(deviceC.replayCacheDir, teamId))).toBe(true);
    await deviceC.teams.leave(teamId);
    // C 의 기기에서 팀이 지워지며 팀 녹화 캐시도 지워진다.
    expect(existsSync(path.join(deviceC.replayCacheDir, teamId))).toBe(false);
    expect(deviceC.uploads.isPending(recordingIds[3]!)).toBe(false);

    const recent = await deviceA1.history.listActivity(teamId, { limit: 10 });
    expect(recent[0]).toMatchObject({ source: "server", memberChange: { type: "member_left", email: accountC.email } });
    expect(recent.some((item) => item.memberChange?.type === "member_joined" && item.memberChange.email === accountC.email)).toBe(true);
    const sessionOfC = recent.filter((item) => item.authorEmail === accountC.email && item.activity?.record.kind === "session-lifecycle");
    expect(sessionOfC.map((item) => item.activity!.phase)).toEqual(["end", "start"]);

    const { view, played } = await playTeamRecording(deviceA1, recordingIds[3]!);
    expect(view.team).toMatchObject({ authorEmail: accountC.email, state: "ended" });
    expect(sameEntries(played, await readLocalRecording(replayDir, recordingIds[3]!))).toBe(true);
    expect((await deviceA1.teams.listMembers(teamId)).map((member) => member.email).sort()).toEqual([accountA.email, accountB.email]);
  }, 60_000);

  it("removing B wipes B's copy and the old link stops working", async () => {
    await deviceA1.teams.removeMember(teamId, accountB.userId);
    await deviceB.tick();

    expect(deviceB.storage.listTeamIds()).toEqual([]);
    expect(deviceB.catalog.getHost("team-host")).toBeNull();
    await expect(deviceB.catalog.loadSecret(secretRef)).resolves.toBeNull();
    expect(deviceB.activeLoops()).toBe(0);
    await expect(deviceB.teams.getInviteInfo(link)).rejects.toMatchObject({ code: "team_invite_invalid" });
    // 취소된 링크는 다시 복사할 수도 없다.
    const invites = await deviceA1.teams.listInvites(teamId);
    expect(invites.length).toBeGreaterThan(0);
    expect(invites.map((invite) => invite.link)).toEqual(invites.map(() => null));
    // A 쪽은 그대로다.
    expect(deviceA1.catalog.getHost("team-host")).toMatchObject({ label: "from-b" });
    expect((await deviceA1.teams.listMembers(teamId)).map((member) => member.email)).toEqual([accountA.email]);
  }, 60_000);

  // 2026-10-23 사고: 옛 메인이 인증 정보 지움 기록의 id 자리에 배열을 썼다(새 화면이 배열을 보냈다). 서버는 push 를
  // 통째로 400 으로 거절했고 앱은 같은 것을 다시 보냈다 — 그 뒤의 변경이 하나도 올라가지 않은 채 로그아웃이 지웠다.
  // 잘못된 기록은 빼고 올리고, 대기열에서도 치워야 한다. 팀 볼트도 같다.
  it("keeps uploading past a malformed deletion an old build left in the queue", async () => {
    const account = await createAccount("p@team-e2e.test");
    const device = await createDevice("p", account);
    const { SyncService } = await import("./sync-service");
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
      isVaultReadyForSync: () => true,
      captureSyncContext: () => ({ ...context }),
      isSyncContextCurrent: (candidate: typeof context) =>
        candidate.userId === context.userId && candidate.vaultKeyBase64 === context.vaultKeyBase64,
      getClientIdentificationHeaders: () => ({ ...CLIENT_HEADERS }),
      getAccessToken: () => context.accessToken,
      refreshSession: async () => ({ status: "authenticated" }),
      handleVaultDekRejected: async () => undefined,
      noteServerVaultSupport: () => undefined,
    };
    const { database } = device;
    const sync = new SyncService(
      auth as never,
      new database.HostRepository(),
      new database.GroupRepository(),
      new database.PortForwardRepository(),
      new database.DnsOverrideRepository(),
      new database.SnippetRepository(),
      new database.KnownHostRepository(),
      new database.SecretMetadataRepository(),
      new database.AwsProfileRepository(),
      new database.SettingsRepository(),
      device.secretStore,
      new database.SyncOutboxRepository(),
      new database.TailnetRepository(),
      new database.SavedWorkspaceRepository(),
    );
    const draft = (label: string) => ({
      kind: "ssh" as const,
      label,
      hostname: `${label}.internal`,
      port: 22,
      username: "ubuntu",
      authType: "password" as const,
    });
    const liveIds = (body: Record<string, unknown>, kind: string) =>
      ((body[kind] ?? []) as Array<{ id: string; deleted_at?: string | null }>)
        .filter((record) => !record.deleted_at)
        .map((record) => record.id)
        .sort();
    // 옛 메인이 쓴 모양 그대로 — 지움 기록의 id 자리에 배열.
    const poisoned = { kind: "secrets", recordId: ["secret:a", "secret:b"] as unknown as string, deletedAt: new Date().toISOString() };

    device.catalog.createHost("personal", "p-first", draft("first"), null);
    await expect(sync.pushDirty()).resolves.toMatchObject({ status: "ready" });
    device.storage.updateState((state) => {
      state.data.syncOutbox.push(poisoned as never);
    });
    device.catalog.createHost("personal", "p-second", draft("second"), null);
    await expect(sync.pushDirty()).resolves.toMatchObject({ status: "ready", errorMessage: null });
    expect(liveIds((await api(account.accessToken, "GET", "/sync")).body, "hosts")).toEqual(["p-first", "p-second"]);
    expect(device.storage.getState().data.syncOutbox).toEqual([]);

    const team = await device.teams.create("P team");
    device.storage.updateState((state) => {
      state.teams[team.id]!.data.syncOutbox.push(poisoned as never);
    });
    device.catalog.createHost(team.id, "p-team-host", draft("team"), null);
    await device.service.pushDirty();
    expect(liveIds((await api(account.accessToken, "GET", `/teams/${team.id}/sync`)).body, "hosts")).toEqual(["p-team-host"]);
    expect(device.storage.getTeamState(team.id)!.data.syncOutbox).toEqual([]);
  }, 60_000);
});
