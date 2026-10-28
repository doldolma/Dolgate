/**
 * 붙는 중에 팀에서 빠지면 그 연결은 뒤늦게 붙지 않는다(8-6 에서 찾은 결함 ②).
 *
 * 실제 앱에서 본 것: 호스트 키 창이 떠 있는 동안 팀에서 빠지자 탭은 '오류'로 바뀌었는데 창은 남았고, 그 창에서
 * 신뢰하자 셸이 열렸다 — 팀이 모르는 접속이다. 아직 런타임이 없는 연결에는 팀을 잊을 때의 닫기가 닿지 않았다.
 *
 * 팀 받기(team-sync)는 팀을 잊기 직전 onTeamForgotten 을 부르고 그 팀을 지운다. 여기서는 진짜 팀 받기를 그대로 쓰되
 * 스토어가 넘긴 deps 만 잡아 두었다가 같은 순서(닫게 하고 → 지운다)로 빠짐을 일으킨다. 엔진은 jest.setup.js 의 가짜
 * 네이티브 모듈이고, 진짜 코어처럼 '거두기'(cancelConnect)가 오면 붙는 중인 connect 가 실패하게 심는다.
 */
import { DeviceEventEmitter, NativeModules } from "react-native";
import { act } from "react-test-renderer";
import type {
  AuthState,
  AwsEc2HostRecord,
  LoadedManagedSecretPayload,
  ManagedAwsProfilePayload,
  SshHostRecord,
} from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from "../src/lib/mobile";
import {
  resetReportedTerminalGridForTests,
  setReportedTerminalGrid,
} from "../src/lib/terminal-size";
import { AwsSftpHostKeyChallengeError } from "../src/lib/aws-sftp";
import type { TeamSyncDeps } from "../src/store/team-sync";
import {
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from "../src/store/useMobileAppStore";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));
// 진짜 팀 받기를 쓰되, 스토어가 만들 때 넘긴 deps 를 잡아 둔다(빠짐을 일으키는 입구).
jest.mock("../src/store/team-sync", () => {
  const actual = jest.requireActual("../src/store/team-sync");
  const captured: { deps: unknown } = { deps: null };
  return {
    ...actual,
    createTeamSync: (deps: unknown) => {
      captured.deps = deps;
      return actual.createTeamSync(deps);
    },
    mockCaptured: captured,
  };
});
// AWS 를 부르는 곳은 대역으로 둔다. 값은 시험마다 정한다.
jest.mock("../src/lib/aws-session", () => ({
  ...jest.requireActual("../src/lib/aws-session"),
  resolveAwsSessionForHost: jest.fn(),
}));
jest.mock("../src/lib/aws-ssm-direct", () => ({
  assertSsmManagedInstance: jest.fn(),
  startSsmShellSession: jest.fn(),
  startSsmPortForwardSession: jest.fn(),
  pushEc2InstanceConnectKey: jest.fn(),
}));
jest.mock("../src/lib/aws-sftp", () => ({
  ...jest.requireActual("../src/lib/aws-sftp"),
  connectAwsSftp: jest.fn(),
}));

const engineNative = NativeModules.GoSshEngineModule as Record<
  string,
  jest.Mock
>;
const awsSession = jest.requireMock("../src/lib/aws-session") as {
  resolveAwsSessionForHost: jest.Mock;
};
const ssmDirect = jest.requireMock("../src/lib/aws-ssm-direct") as Record<
  | "assertSsmManagedInstance"
  | "startSsmShellSession"
  | "startSsmPortForwardSession"
  | "pushEc2InstanceConnectKey",
  jest.Mock
>;
const awsSftp = jest.requireMock("../src/lib/aws-sftp") as {
  connectAwsSftp: jest.Mock;
};

const NOTICE = "팀에서 빠져 이 연결을 닫았습니다.";
const AT = "2026-10-28T00:00:00.000Z";
const TEST_GRID = { cols: 80, rows: 24 };

function teamSyncDeps(): TeamSyncDeps {
  const { mockCaptured } = jest.requireMock("../src/store/team-sync") as {
    mockCaptured: { deps: TeamSyncDeps | null };
  };
  if (!mockCaptured.deps) {
    throw new Error("the store did not create team sync");
  }
  return mockCaptured.deps;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// 붙는 흐름은 기다림이 길다(키·포워드·셸…). 넉넉히 돈다.
async function flushAsyncWork(rounds = 60): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function createAuthenticatedState(): AuthState {
  return {
    status: "authenticated",
    session: {
      user: { id: "user-1", email: "member@example.com" },
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresInSeconds: 900,
      },
      vaultBootstrap: { keyBase64: "a2V5" },
      offlineLease: {
        token: "offline-token",
        issuedAt: AT,
        expiresAt: "2026-10-29T00:00:00.000Z",
        verificationPublicKeyPem: "public-key",
      },
      syncServerTime: AT,
    },
    offline: null,
    errorMessage: null,
  };
}

function resetStore(): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: createAuthenticatedState(),
    settings: createDefaultMobileSettings(),
    syncStatus: {
      ...createDefaultSyncStatus(),
      awsProfilesServerSupport: "supported",
      awsSsmServerSupport: "supported",
      awsSftpServerSupport: "supported",
    },
    groups: [],
    hosts: [],
    awsProfiles: [],
    tailnets: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    remoteDesktopSessions: [],
    activeSessionTabId: null,
    activeConnectionTab: null,
    connectionViews: {},
    secretsByRef: {},
    teamVaults: [],
    teamSecrets: {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
    pendingCredentialRetry: null,
    pendingInteractiveAuthPrompt: null,
    syncOutbox: [],
    syncOutboxFailure: null,
  });
}

function teamSshHost(overrides: Partial<SshHostRecord> = {}): SshHostRecord {
  return {
    id: "team-host-1",
    kind: "ssh",
    label: "Team SSH",
    hostname: "team.example.com",
    port: 22,
    username: "ops",
    authType: "password",
    secretRef: "team-secret-1",
    privateKeyPath: null,
    certificatePath: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const TEAM_PASSWORD: Record<string, LoadedManagedSecretPayload> = {
  "team-secret-1": {
    secretRef: "team-secret-1",
    label: "Team SSH credentials",
    password: "team-pw",
    updatedAt: AT,
  },
};

const TEAM_KEY: Record<string, LoadedManagedSecretPayload> = {
  "team-secret-1": {
    secretRef: "team-secret-1",
    label: "Team SSH key",
    privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----\nteam\n-----END OPENSSH PRIVATE KEY-----",
    updatedAt: AT,
  },
};

function teamAwsHost(
  overrides: Partial<AwsEc2HostRecord> = {},
): AwsEc2HostRecord {
  return {
    id: "team-aws-1",
    kind: "aws-ec2",
    label: "Team EC2",
    awsProfileId: "team-aws-static",
    awsProfileName: "acme-static",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-team",
    awsSshUsername: "ec2-user",
    awsAvailabilityZone: "ap-northeast-2a",
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const TEAM_AWS_PROFILE: ManagedAwsProfilePayload = {
  id: "team-aws-static",
  name: "acme-static",
  kind: "static",
  region: "ap-northeast-2",
  accessKeyId: "",
  secretAccessKey: "",
  updatedAt: AT,
};

/** 이 기기에 둔 내 AWS 키 — 팀 정적 키 프로필에 쓴다(없으면 붙기 전에 멈춘다). */
const MY_AWS_KEYS = {
  "team-aws-static": { accessKeyId: "AKIAMINE", secretAccessKey: "mine" },
};

/** 팀 team-1 을 받아 둔 상태(B 가 멤버). */
function joinTeam(options: {
  hosts: Array<SshHostRecord | AwsEc2HostRecord>;
  secretsByRef?: Record<string, LoadedManagedSecretPayload>;
  awsProfiles?: ManagedAwsProfilePayload[];
}): void {
  useMobileAppStore.setState({
    teamVaults: [
      {
        id: "team-1",
        name: "Acme",
        role: "member",
        wrappedTeamDek: "wrapped",
        state: "ready",
        errorMessage: null,
        hosts: options.hosts,
        groups: [],
        knownHosts: [],
        awsProfiles: options.awsProfiles ?? [],
        tailnets: [],
        snippets: [],
        hostPrefs: [],
      },
    ],
    teamSecrets: {
      "team-1": {
        secretsByRef: options.secretsByRef ?? {},
        hostCredentials: {},
        awsKeys: MY_AWS_KEYS,
      },
    },
  });
}

/** team-1 에서 빠진다 — 팀 받기의 forgetTeam 과 같은 순서다(그 팀 호스트의 연결을 닫게 하고 → 팀을 지운다). */
async function removeFromTeam(): Promise<void> {
  await act(async () => {
    const state = useMobileAppStore.getState();
    const vault = state.teamVaults.find(item => item.id === "team-1");
    if (!vault) {
      throw new Error("team-1 is not on this device");
    }
    teamSyncDeps().onTeamForgotten?.(
      "team-1",
      new Set(vault.hosts.map(host => host.id)),
    );
    const { "team-1": _gone, ...teamSecrets } = state.teamSecrets;
    useMobileAppStore.setState({
      teamVaults: state.teamVaults.filter(item => item.id !== "team-1"),
      teamSecrets,
    });
    await flushAsyncWork();
  });
}

async function connect(hostId: string): Promise<string> {
  let sessionId: string | null = null;
  await act(async () => {
    sessionId = await useMobileAppStore.getState().connectToHost(hostId);
    await flushAsyncWork();
  });
  if (!sessionId) {
    throw new Error("no session was created");
  }
  return sessionId;
}

async function openSftp(hostId: string): Promise<string> {
  let sftpId: string | null = null;
  await act(async () => {
    sftpId = await useMobileAppStore.getState().openSftpForHost(hostId);
    await flushAsyncWork();
  });
  if (!sftpId) {
    throw new Error("no SFTP session was created");
  }
  return sftpId;
}

function terminalOf(sessionId: string) {
  return useMobileAppStore
    .getState()
    .sessions.find(item => item.id === sessionId);
}

function sftpOf(sftpId: string) {
  return useMobileAppStore
    .getState()
    .sftpSessions.find(item => item.id === sftpId);
}

/**
 * 빠지는 동안 그 탭이 거친 상태들. 멈춘 흐름이 '닫힘(취소)'을 잠깐이라도 쓰면, 닫는 쪽 안내가 곧 덮어도 그 사이 탭이
 * 앞에서 내려간다 — 끝 상태만 봐서는 안 보인다.
 */
function watchStatuses(read: () => string | undefined): {
  seen: string[];
  stop: () => void;
} {
  const seen: string[] = [];
  const stop = useMobileAppStore.subscribe(() => {
    const status = read();
    if (status && seen[seen.length - 1] !== status) {
      seen.push(status);
    }
  });
  return { seen, stop };
}

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await flushAsyncWork();
  });
}

function emitConnectionEvent(
  connectionId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  DeviceEventEmitter.emit("GoSshEngine:connection", {
    eventJson: JSON.stringify({ type, sessionId: connectionId, payload }),
  });
}

function emitHostKeyChallenge(connectionId: string): void {
  emitConnectionEvent(connectionId, "hostKeyTrustChallenge", {
    challengeId: "hostkey-1",
    algorithm: "ssh-ed25519",
    fingerprintSha256: "SHA256:team",
    publicKeyBase64: "AAAAC3NzaC1lZDI1NTE5team",
    mismatch: false,
  });
}

/**
 * 붙는 중에 서 있는 connect. 진짜 코어처럼 거두기(cancelConnect)가 오면 실패로 끝난다 — `cancellable: false` 면 거두기가
 * 닿지 못한 경우(이미 서버가 답한 뒤)다. `finish()` 로 늦게라도 붙게 할 수 있다. 붙기 전에 일을 더 시킬 수 있다(물음 등).
 */
function standingConnect(options: {
  cancellable: boolean;
  onStart?: (connectionId: string) => void;
}): { finish: () => void; started: () => string | null } {
  const pending = deferred<void>();
  let startedId: string | null = null;
  engineNative.connect.mockImplementationOnce(async (connectionId: string) => {
    startedId = connectionId;
    options.onStart?.(connectionId);
    await pending.promise;
    return JSON.stringify({ id: connectionId });
  });
  if (options.cancellable) {
    engineNative.cancelConnect.mockImplementationOnce(async () => {
      pending.reject(new Error("connect: cancelled"));
    });
  }
  return { finish: () => pending.resolve(), started: () => startedId };
}

/** 붙는 중 호스트 키를 묻고 답(또는 거두기)을 기다리는 connect — 진짜 코어처럼 거부면 실패한다. */
function connectAskingHostKey(): void {
  engineNative.connect.mockImplementationOnce(async (connectionId: string) => {
    const decided = new Promise<boolean>((resolve, reject) => {
      engineNative.respondHostKeyTrust.mockImplementationOnce(
        async (_challengeId: string, trust: boolean) => {
          resolve(trust);
        },
      );
      engineNative.cancelConnect.mockImplementationOnce(async () => {
        reject(new Error("connect: cancelled"));
      });
    });
    emitHostKeyChallenge(connectionId);
    if (!(await decided)) {
      throw new Error("connect: trusted host key is required");
    }
    return JSON.stringify({ id: connectionId });
  });
}

/** 붙는 중 서버가 OTP 를 묻고 답(또는 거두기)을 기다리는 connect — 취소면 실패한다. */
function connectAskingOtp(): void {
  engineNative.connect.mockImplementationOnce(async (connectionId: string) => {
    const answered = new Promise<void>((_resolve, reject) => {
      engineNative.respondKeyboardInteractive.mockImplementationOnce(
        async () => {
          reject(new Error("connect: authentication cancelled"));
        },
      );
      engineNative.cancelConnect.mockImplementationOnce(async () => {
        reject(new Error("connect: cancelled"));
      });
    });
    emitConnectionEvent(connectionId, "keyboardInteractiveChallenge", {
      challengeId: "otp-1",
      attempt: 1,
      name: "",
      instruction: "Two-factor",
      hasStoredPassword: false,
      prompts: [
        {
          label: "Verification code:",
          echo: false,
          allowStoredPassword: false,
          masked: false,
        },
      ],
    });
    await answered;
    return JSON.stringify({ id: connectionId });
  });
}

function personalSecret(secretRef: string): LoadedManagedSecretPayload {
  return { secretRef, label: secretRef, password: "pw", updatedAt: AT };
}

const RESOLVED_AWS = {
  envSpec: { env: {}, unsetEnv: [] },
  credentials: {
    accessKeyId: "AKIAMINE",
    secretAccessKey: "mine",
    sessionToken: "token",
  },
  profileName: "acme-static",
  region: "ap-northeast-2",
  connectionDetails: "acme-static · ap-northeast-2 · i-team",
};

/** AWS SFTP(서버 경유) 연결의 대역. */
function fakeAwsSftpConnection(listing?: Promise<unknown>) {
  return {
    listDirectory: jest.fn(
      () => listing ?? Promise.resolve({ path: "/home/ec2-user", entries: [] }),
    ),
    close: jest.fn(async () => undefined),
  };
}

describe("connections to a team host while leaving the team", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn<
    Promise<Response>,
    [RequestInfo | URL, RequestInit?]
  >();

  beforeAll(() => {
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    resetMobileStoreRuntimeForTests();
    resetReportedTerminalGridForTests();
    setReportedTerminalGrid(TEST_GRID);
    jest.clearAllMocks();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async input => {
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    // 앞 시험이 심은 한 번짜리 구현이 남지 않게 기본으로 되돌린다.
    for (const name of [
      "connect",
      "cancelConnect",
      "respondHostKeyTrust",
      "respondKeyboardInteractive",
      "inspectPrivateKey",
      "startShell",
      "startSftp",
      "sftpList",
      "startSsmPortForward",
      "startAwsSsmShell",
    ]) {
      engineNative[name].mockReset();
    }
    engineNative.connect.mockImplementation(async (connectionId: string) =>
      JSON.stringify({ id: connectionId }),
    );
    engineNative.cancelConnect.mockResolvedValue(undefined);
    engineNative.respondHostKeyTrust.mockResolvedValue(undefined);
    engineNative.respondKeyboardInteractive.mockResolvedValue(undefined);
    engineNative.inspectPrivateKey.mockResolvedValue(
      JSON.stringify({ algorithm: "ssh-ed25519" }),
    );
    engineNative.startShell.mockResolvedValue({
      shellId: "test-shell",
      info: "{}",
    });
    engineNative.startSftp.mockResolvedValue("test-sftp");
    engineNative.sftpList.mockResolvedValue(
      JSON.stringify({ path: "/root", entries: [] }),
    );
    engineNative.startSsmPortForward.mockResolvedValue({
      forwardId: "test-forward",
      bindPort: 54321,
    });
    engineNative.startAwsSsmShell.mockResolvedValue({
      shellId: "test-ssm-shell",
      info: "{}",
    });
    awsSession.resolveAwsSessionForHost.mockReset();
    awsSession.resolveAwsSessionForHost.mockResolvedValue(RESOLVED_AWS);
    ssmDirect.assertSsmManagedInstance.mockReset();
    ssmDirect.assertSsmManagedInstance.mockResolvedValue(undefined);
    ssmDirect.pushEc2InstanceConnectKey.mockReset();
    ssmDirect.pushEc2InstanceConnectKey.mockResolvedValue(undefined);
    ssmDirect.startSsmPortForwardSession.mockReset();
    ssmDirect.startSsmPortForwardSession.mockResolvedValue({
      streamUrl: "wss://ssm.example.test/forward",
      tokenValue: "forward-token",
      sessionId: "ssm-forward",
    });
    ssmDirect.startSsmShellSession.mockReset();
    ssmDirect.startSsmShellSession.mockResolvedValue({
      streamUrl: "wss://ssm.example.test/shell",
      tokenValue: "shell-token",
      sessionId: "ssm-shell",
    });
    awsSftp.connectAwsSftp.mockReset();
    await act(async () => {
      resetStore();
    });
  });

  afterEach(async () => {
    resetMobileStoreRuntimeForTests();
    await act(async () => {
      resetStore();
    });
  });

  // ── 터미널(SSH) ──────────────────────────────────────────────────────────────

  // 실제 앱에서 재현한 그 길(가): 창이 남아 있어 신뢰하자 붙었다.
  it("closes the host key prompt and never connects when the team is removed while it is open", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    connectAskingHostKey();

    const sessionId = await connect(host.id);
    expect(useMobileAppStore.getState().pendingServerKeyPrompt).not.toBeNull();

    await removeFromTeam();

    expect(useMobileAppStore.getState().pendingServerKeyPrompt).toBeNull();
    expect(engineNative.cancelConnect).toHaveBeenCalledWith(sessionId);
    expect(engineNative.respondHostKeyTrust).toHaveBeenCalledWith(
      "hostkey-1",
      false,
    );
    expect(engineNative.startShell).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // (나) 서버가 늦게 답하는 동안 빠지면 엔진의 붙는 중인 연결을 그 자리에서 거둔다 — 서버에 로그인이 남지 않는다.
  it("cuts a slow connect when the team is removed and keeps the removal notice", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    const server = standingConnect({ cancellable: true });

    const sessionId = await connect(host.id);
    expect(server.started()).toBe(sessionId);

    await removeFromTeam();

    expect(engineNative.cancelConnect).toHaveBeenCalledWith(sessionId);
    expect(engineNative.startShell).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // 거두기가 닿기 전에 서버가 답해 엔진 연결이 섰어도 셸을 열지 않고 닫는다.
  it("closes a connect that completes after the team was removed", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    const server = standingConnect({ cancellable: false });

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() => server.finish());

    expect(engineNative.startShell).not.toHaveBeenCalled();
    expect(engineNative.disconnect).toHaveBeenCalledWith(sessionId);
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // 이미 선 연결은 런타임 닫기가 맡는다(8-5). 끝난 흐름의 멈춤은 떼어져 있어, 거두기를 다시 부르지 않는다.
  it("closes an established connection without cancelling it as a pending one", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });

    const sessionId = await connect(host.id);
    expect(terminalOf(sessionId)?.status).toBe("connected");

    await removeFromTeam();

    expect(engineNative.cancelConnect).not.toHaveBeenCalled();
    expect(engineNative.closeShell).toHaveBeenCalledWith("test-shell");
    expect(engineNative.disconnect).toHaveBeenCalledWith(sessionId);
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // 비밀번호를 묻는 창이 떠 있을 때 — 창을 거두고, '취소'로 덮지 않는다.
  it("cancels the credential prompt without overwriting the removal notice", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: {} });

    const sessionId = await connect(host.id);
    expect(useMobileAppStore.getState().pendingCredentialPrompt?.hostId).toBe(
      host.id,
    );

    const watch = watchStatuses(() => terminalOf(sessionId)?.status);
    await removeFromTeam();
    watch.stop();

    expect(useMobileAppStore.getState().pendingCredentialPrompt).toBeNull();
    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(watch.seen).not.toContain("closed");
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // 키 검사(네이티브)가 끝나기 전에 빠지면 '연결 중'으로 덮지 않고 붙지도 않는다.
  it("does not connect after a slow key check when the team was removed", async () => {
    const host = teamSshHost({ authType: "privateKey" });
    joinTeam({ hosts: [host], secretsByRef: TEAM_KEY });
    const keyCheck = deferred<string>();
    engineNative.inspectPrivateKey.mockReturnValueOnce(keyCheck.promise);

    const sessionId = await connect(host.id);
    expect(engineNative.inspectPrivateKey).toHaveBeenCalled();

    await removeFromTeam();
    await settle(() =>
      keyCheck.resolve(JSON.stringify({ algorithm: "ssh-ed25519" })),
    );

    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // 터미널 크기를 기다리는 사이 빠지면 다이얼하지 않는다(거두기는 아직 시작 안 한 연결에 닿지 않는다).
  it("does not dial when the terminal grid arrives after the team was removed", async () => {
    resetReportedTerminalGridForTests();
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });

    const sessionId = await connect(host.id);
    expect(terminalOf(sessionId)?.status).toBe("connecting");

    await removeFromTeam();
    await settle(() => setReportedTerminalGrid(TEST_GRID));

    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // 서버의 대화형 인증 물음(OTP 등)이 떠 있을 때 — 취소로 답하고 창을 거둔다.
  it("cancels a keyboard-interactive question when the team is removed", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    connectAskingOtp();

    const sessionId = await connect(host.id);
    expect(
      useMobileAppStore.getState().pendingInteractiveAuthPrompt,
    ).not.toBeNull();

    await removeFromTeam();

    expect(useMobileAppStore.getState().pendingInteractiveAuthPrompt).toBeNull();
    expect(engineNative.respondKeyboardInteractive).toHaveBeenCalledWith(
      JSON.stringify({ challengeId: "otp-1", responses: [], cancelled: true }),
    );
    expect(engineNative.startShell).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // 빠진 팀의 것만 거둔다 — 같은 때 붙는 중인 개인 호스트의 창·흐름은 그대로다.
  it("leaves the prompts and connects of other hosts alone", async () => {
    const team = teamSshHost();
    const keyHost = teamSshHost({ id: "p-key", hostname: "key.example.com", secretRef: "p-key" });
    const askHost = teamSshHost({ id: "p-ask", hostname: "ask.example.com", secretRef: "p-ask" });
    const otpHost = teamSshHost({ id: "p-otp", hostname: "otp.example.com", secretRef: "p-otp" });
    const slowHost = teamSshHost({ id: "p-slow", hostname: "slow.example.com", secretRef: "p-slow" });
    useMobileAppStore.setState({
      hosts: [keyHost, askHost, otpHost, slowHost],
      // p-ask 는 비밀번호가 없어 묻는다.
      secretsByRef: {
        "p-key": personalSecret("p-key"),
        "p-otp": personalSecret("p-otp"),
        "p-slow": personalSecret("p-slow"),
      },
    });
    joinTeam({ hosts: [team], secretsByRef: TEAM_PASSWORD });
    connectAskingHostKey();
    connectAskingOtp();
    const slow = standingConnect({ cancellable: true });

    await connect(keyHost.id);
    await connect(askHost.id);
    await connect(otpHost.id);
    const slowId = await connect(slowHost.id);

    await removeFromTeam();

    const state = useMobileAppStore.getState();
    expect(state.pendingServerKeyPrompt?.hostId).toBe(keyHost.id);
    expect(state.pendingCredentialPrompt?.hostId).toBe(askHost.id);
    expect(state.pendingInteractiveAuthPrompt?.hostId).toBe(otpHost.id);
    expect(engineNative.cancelConnect).not.toHaveBeenCalled();

    await settle(() => slow.finish());
    expect(terminalOf(slowId)?.status).toBe("connected");
  });

  // 인증이 깨진 뒤 다시 묻는 창도 그 팀 호스트 것이면 닫는다.
  it("closes the credential retry dialog of a removed team host", async () => {
    const host = teamSshHost();
    const other = teamSshHost({ id: "other-host", label: "Personal" });
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    useMobileAppStore.setState({
      pendingCredentialRetry: {
        hostId: host.id,
        hostLabel: host.label,
        target: { kind: "terminal", recordId: "session-x" },
        authType: "password",
        initialUsername: host.username,
      },
    });

    await removeFromTeam();
    expect(useMobileAppStore.getState().pendingCredentialRetry).toBeNull();

    // 다른 호스트의 창은 그대로 둔다.
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    useMobileAppStore.setState({
      hosts: [other],
      pendingCredentialRetry: {
        hostId: other.id,
        hostLabel: other.label,
        target: { kind: "terminal", recordId: "session-y" },
        authType: "password",
        initialUsername: other.username,
      },
    });
    await removeFromTeam();
    expect(useMobileAppStore.getState().pendingCredentialRetry?.hostId).toBe(
      other.id,
    );
  });

  // 마지막 안전장치 — 창이 떠 있는 사이 호스트가 볼트에서 사라졌으면(지움·빠짐) 신뢰해도 거부한다.
  it("rejects a key the user trusts after the host left every vault", async () => {
    const host = teamSshHost({ id: "personal-host", secretRef: "personal-secret" });
    useMobileAppStore.setState({
      hosts: [host],
      secretsByRef: {
        "personal-secret": {
          secretRef: "personal-secret",
          label: "Personal",
          password: "pw",
          updatedAt: AT,
        },
      },
    });
    connectAskingHostKey();

    await connect(host.id);
    expect(useMobileAppStore.getState().pendingServerKeyPrompt).not.toBeNull();

    await act(async () => {
      useMobileAppStore.setState({ hosts: [] });
      await useMobileAppStore.getState().acceptServerKeyPrompt();
      await flushAsyncWork();
    });

    expect(engineNative.respondHostKeyTrust).toHaveBeenCalledWith(
      "hostkey-1",
      false,
    );
    expect(useMobileAppStore.getState().knownHosts).toEqual([]);
    expect(engineNative.startShell).not.toHaveBeenCalled();
  });

  // 거두기가 닿지 못한 채 서버가 뒤늦게 키를 내밀면, 이미 없는 호스트라 묻지도 않고 거부한다.
  it("rejects without asking when a key arrives after the host left every vault", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    const server = standingConnect({ cancellable: false });

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() => emitHostKeyChallenge(sessionId));

    expect(useMobileAppStore.getState().pendingServerKeyPrompt).toBeNull();
    expect(engineNative.respondHostKeyTrust).toHaveBeenCalledWith(
      "hostkey-1",
      false,
    );
    await settle(() => server.finish());
    expect(engineNative.startShell).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // ── SFTP ─────────────────────────────────────────────────────────────────────

  it("closes the SFTP host key prompt when the team is removed and keeps the notice", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    connectAskingHostKey();

    const sftpId = await openSftp(host.id);
    expect(useMobileAppStore.getState().pendingServerKeyPrompt).not.toBeNull();

    await removeFromTeam();

    expect(useMobileAppStore.getState().pendingServerKeyPrompt).toBeNull();
    expect(engineNative.cancelConnect).toHaveBeenCalledWith(sftpId);
    expect(engineNative.respondHostKeyTrust).toHaveBeenCalledWith(
      "hostkey-1",
      false,
    );
    expect(engineNative.startSftp).not.toHaveBeenCalled();
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("closes an SFTP connect that completes after the team was removed", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });
    const server = standingConnect({ cancellable: false });

    const sftpId = await openSftp(host.id);
    await removeFromTeam();
    await settle(() => server.finish());

    expect(engineNative.sftpList).not.toHaveBeenCalled();
    expect(engineNative.closeSftp).toHaveBeenCalled();
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("closes an established SFTP session without cancelling it as a pending one", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: TEAM_PASSWORD });

    const sftpId = await openSftp(host.id);
    expect(sftpOf(sftpId)?.status).toBe("connected");

    await removeFromTeam();

    expect(engineNative.cancelConnect).not.toHaveBeenCalled();
    expect(engineNative.closeSftp).toHaveBeenCalled();
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("cancels the SFTP credential prompt without overwriting the notice", async () => {
    const host = teamSshHost();
    joinTeam({ hosts: [host], secretsByRef: {} });

    const sftpId = await openSftp(host.id);
    expect(useMobileAppStore.getState().pendingCredentialPrompt).not.toBeNull();

    const watch = watchStatuses(() => sftpOf(sftpId)?.status);
    await removeFromTeam();
    watch.stop();

    expect(useMobileAppStore.getState().pendingCredentialPrompt).toBeNull();
    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(watch.seen).not.toContain("closed");
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("does not open SFTP after a slow key check when the team was removed", async () => {
    const host = teamSshHost({ authType: "privateKey" });
    joinTeam({ hosts: [host], secretsByRef: TEAM_KEY });
    const keyCheck = deferred<string>();
    engineNative.inspectPrivateKey.mockReturnValueOnce(keyCheck.promise);

    const sftpId = await openSftp(host.id);
    await removeFromTeam();
    await settle(() =>
      keyCheck.resolve(JSON.stringify({ algorithm: "ssh-ed25519" })),
    );

    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // ── AWS EC2 터미널 — 기기에서 직접(SSH over SSM, 안 되면 SSM 셸) ─────────────────────

  it("stops an SSH-over-SSM connect when the team is removed, without falling back or remembering a failure", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    standingConnect({ cancellable: true });

    const sessionId = await connect(host.id);
    expect(engineNative.connect).toHaveBeenCalledTimes(1);

    await removeFromTeam();

    expect(engineNative.cancelConnect).toHaveBeenCalledWith(sessionId);
    expect(engineNative.stopSsmPortForward).toHaveBeenCalled();
    expect(ssmDirect.startSsmShellSession).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });

    // 다시 들어와 붙으면 SSH 를 다시 시도한다 — 멈춘 것을 'SSH 가 안 되는 인스턴스'로 기억하지 않았다.
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    await connect(host.id);
    expect(engineNative.connect).toHaveBeenCalledTimes(2);
  });

  it("closes an established SSH-over-SSM session without cancelling it as a pending one", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });

    const sessionId = await connect(host.id);
    expect(terminalOf(sessionId)?.status).toBe("connected");

    await removeFromTeam();

    expect(engineNative.cancelConnect).not.toHaveBeenCalled();
    expect(engineNative.disconnect).toHaveBeenCalledWith(sessionId);
    expect(engineNative.stopSsmPortForward).toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("does not dial the instance when the team was removed while the forward was opening", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const forwardToken = deferred<unknown>();
    ssmDirect.startSsmPortForwardSession.mockReturnValueOnce(
      forwardToken.promise,
    );

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() =>
      forwardToken.resolve({
        streamUrl: "wss://ssm.example.test/forward",
        tokenValue: "forward-token",
        sessionId: "ssm-forward",
      }),
    );

    expect(engineNative.connect).not.toHaveBeenCalled();
    expect(engineNative.stopSsmPortForward).toHaveBeenCalled();
    expect(ssmDirect.startSsmShellSession).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("closes an SSH-over-SSM shell that opens after the team was removed", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const server = standingConnect({ cancellable: false });

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() => server.finish());

    expect(engineNative.startShell).toHaveBeenCalledTimes(1);
    expect(engineNative.closeShell).toHaveBeenCalledWith("test-shell");
    expect(engineNative.disconnect).toHaveBeenCalledWith(sessionId);
    expect(engineNative.stopSsmPortForward).toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("closes an SSM shell that opens after the team was removed", async () => {
    const host = teamAwsHost({ awsPlatform: "Windows" });
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const shellToken = deferred<unknown>();
    ssmDirect.startSsmShellSession.mockReturnValueOnce(shellToken.promise);

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() =>
      shellToken.resolve({
        streamUrl: "wss://ssm.example.test/shell",
        tokenValue: "shell-token",
        sessionId: "ssm-shell",
      }),
    );

    expect(engineNative.startAwsSsmShell).toHaveBeenCalledTimes(1);
    expect(engineNative.closeShell).toHaveBeenCalledWith("test-ssm-shell");
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("does not start the SSM shell when the team was removed during the instance check", async () => {
    const host = teamAwsHost({ awsPlatform: "Windows" });
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const managed = deferred<void>();
    ssmDirect.assertSsmManagedInstance.mockReturnValueOnce(managed.promise);

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() => managed.resolve());

    expect(ssmDirect.startSsmShellSession).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("keeps the notice when the instance check fails after the team was removed", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const managed = deferred<void>();
    ssmDirect.assertSsmManagedInstance.mockReturnValueOnce(managed.promise);

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() => managed.reject(new Error("not managed by SSM")));

    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("does not reach AWS when the team was removed while the AWS session was resolving", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const resolving = deferred<unknown>();
    awsSession.resolveAwsSessionForHost.mockReturnValueOnce(resolving.promise);

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() => resolving.resolve(RESOLVED_AWS));

    expect(ssmDirect.assertSsmManagedInstance).not.toHaveBeenCalled();
    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("keeps the notice when resolving the AWS session fails after the team was removed", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const resolving = deferred<unknown>();
    awsSession.resolveAwsSessionForHost.mockReturnValueOnce(resolving.promise);

    const sessionId = await connect(host.id);
    await removeFromTeam();
    await settle(() => resolving.reject(new Error("sts: expired")));

    expect(terminalOf(sessionId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  // ── AWS EC2 터미널 — 서버 프록시(SSH, 안 되면 서버의 SSM 셸 릴레이) ─────────────────────

  describe("through the server proxy", () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      send() {}
      close() {}
    }
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

    beforeEach(() => {
      FakeWebSocket.instances = [];
      (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    });

    afterEach(() => {
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    });

    it("does not fall back to the server relay when the team is removed during the SSH attempt", async () => {
      const host = teamAwsHost({ awsSsmServerProxyEnabled: true });
      joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
      standingConnect({ cancellable: true });

      const sessionId = await connect(host.id);
      expect(engineNative.connect).toHaveBeenCalledTimes(1);

      await removeFromTeam();

      expect(engineNative.cancelConnect).toHaveBeenCalledWith(sessionId);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(terminalOf(sessionId)).toMatchObject({
        status: "error",
        errorMessage: NOTICE,
      });

      // 다시 들어와 붙으면 SSH 를 다시 시도한다(멈춘 것을 실패로 기억하지 않았다).
      joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
      await connect(host.id);
      expect(engineNative.connect).toHaveBeenCalledTimes(2);
    });

    it("closes a proxied SSH shell that opens after the team was removed", async () => {
      const host = teamAwsHost({ awsSsmServerProxyEnabled: true });
      joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
      const server = standingConnect({ cancellable: false });

      const sessionId = await connect(host.id);
      await removeFromTeam();
      await settle(() => server.finish());

      expect(engineNative.closeShell).toHaveBeenCalledWith("test-shell");
      expect(engineNative.disconnect).toHaveBeenCalledWith(sessionId);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(terminalOf(sessionId)).toMatchObject({
        status: "error",
        errorMessage: NOTICE,
      });
    });

    it("keeps the notice when the server says it cannot proxy after the team was removed", async () => {
      useMobileAppStore.setState({
        syncStatus: {
          ...createDefaultSyncStatus(),
          awsProfilesServerSupport: "supported",
          awsSsmServerSupport: "unknown",
        },
      });
      const host = teamAwsHost({ awsSsmServerProxyEnabled: true });
      joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
      const info = deferred<Response>();
      fetchMock.mockImplementationOnce(() => info.promise);

      const sessionId = await connect(host.id);
      await removeFromTeam();
      await settle(() =>
        info.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            serverVersion: "test",
            capabilities: {
              sync: { awsProfiles: true },
              sessions: { awsSsm: false, awsSftp: false },
            },
          }),
        } as unknown as Response),
      );

      expect(terminalOf(sessionId)).toMatchObject({
        status: "error",
        errorMessage: NOTICE,
      });
    });
  });

  // ── AWS EC2 SFTP(서버 경유) ─────────────────────────────────────────────────────

  it("does not open AWS SFTP when the team was removed while the AWS session was resolving", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const resolving = deferred<unknown>();
    awsSession.resolveAwsSessionForHost.mockReturnValueOnce(resolving.promise);

    const sftpId = await openSftp(host.id);
    await removeFromTeam();
    await settle(() => resolving.resolve(RESOLVED_AWS));

    expect(awsSftp.connectAwsSftp).not.toHaveBeenCalled();
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("closes an AWS SFTP connection that opens after the team was removed", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const opening = deferred<unknown>();
    awsSftp.connectAwsSftp.mockReturnValueOnce(opening.promise);
    const connection = fakeAwsSftpConnection();

    const sftpId = await openSftp(host.id);
    await removeFromTeam();
    await settle(() => opening.resolve(connection));

    expect(connection.close).toHaveBeenCalled();
    expect(connection.listDirectory).not.toHaveBeenCalled();
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("does not mark AWS SFTP connected when the listing arrives after the team was removed", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const listing = deferred<unknown>();
    const connection = fakeAwsSftpConnection(listing.promise);
    awsSftp.connectAwsSftp.mockResolvedValueOnce(connection);

    const sftpId = await openSftp(host.id);
    expect(connection.listDirectory).toHaveBeenCalled();
    await removeFromTeam();
    // 런타임은 닫는 쪽이 닫았다.
    expect(connection.close).toHaveBeenCalled();
    await settle(() => listing.resolve({ path: "/home/ec2-user", entries: [] }));

    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("keeps the notice when the AWS SFTP host key prompt is closed by leaving the team", async () => {
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    awsSftp.connectAwsSftp.mockRejectedValueOnce(
      new AwsSftpHostKeyChallengeError(
        "host_key_required",
        {
          host: "aws-ssm:acme-static:ap-northeast-2:i-team",
          port: 22,
          algorithm: "ssh-ed25519",
          fingerprintSha256: "SHA256:aws",
          keyBase64: "AAAAC3NzaC1lZDI1NTE5aws",
        },
        "host key required",
      ),
    );

    const sftpId = await openSftp(host.id);
    expect(useMobileAppStore.getState().pendingServerKeyPrompt).not.toBeNull();

    const watch = watchStatuses(() => sftpOf(sftpId)?.status);
    await removeFromTeam();
    watch.stop();

    expect(useMobileAppStore.getState().pendingServerKeyPrompt).toBeNull();
    expect(awsSftp.connectAwsSftp).toHaveBeenCalledTimes(1);
    expect(watch.seen).not.toContain("closed");
    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });

  it("keeps the notice when the server says it cannot do AWS SFTP after the team was removed", async () => {
    useMobileAppStore.setState({
      syncStatus: {
        ...createDefaultSyncStatus(),
        awsProfilesServerSupport: "supported",
        awsSsmServerSupport: "supported",
        awsSftpServerSupport: "unknown",
      },
    });
    const host = teamAwsHost();
    joinTeam({ hosts: [host], awsProfiles: [TEAM_AWS_PROFILE] });
    const info = deferred<Response>();
    fetchMock.mockImplementationOnce(() => info.promise);

    const sftpId = await openSftp(host.id);
    await removeFromTeam();
    await settle(() =>
      info.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          serverVersion: "test",
          capabilities: {
            sync: { awsProfiles: true },
            sessions: { awsSsm: true, awsSftp: false },
          },
        }),
      } as unknown as Response),
    );

    expect(sftpOf(sftpId)).toMatchObject({
      status: "error",
      errorMessage: NOTICE,
    });
  });
});
