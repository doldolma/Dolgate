import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, PortForwardRuntimeEvent, SshHostRecord, TerminalTab } from "@shared";
import { createAppStore } from "./createAppStore";
import { createContainerTab, createMockApi } from "./createAppStore.test-support";
import {
  __resetReconnectOrchestratorForTest,
  initReconnectOrchestrator,
  isReconnecting,
  registerReconnectHandler,
  scheduleReconnect,
} from "./services/reconnect-orchestrator";
import { listHostKeyPrompts } from "./utils/host-key-prompts";

// 붙는 중에 팀에서 빠지면(8-6 결함 ②의 데스크톱 쪽) 메인은 그 연결을 까닭과 함께 끊는다. 그 연결이 띄운 물음(호스트 키·OTP·
// 다시 묻는 창)은 답할 대상이 없으니 함께 거둔다 — 남기면 거기서 신뢰를 눌러 빠진 팀 호스트에 붙거나 그 키가 저장됐다.

const NOTICE = "팀에서 빠져 이 연결을 닫았습니다.";

const TEAM_HOST: SshHostRecord = {
  id: "team-host",
  kind: "ssh",
  label: "Team SSH",
  hostname: "team.example.com",
  port: 22,
  username: "ops",
  authType: "password",
  privateKeyPath: null,
  secretRef: null,
  jumpHostId: null,
  startupCommand: null,
  groupName: null,
  tags: [],
  terminalThemeId: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

function connectingTab(sessionId: string): TerminalTab {
  return {
    id: sessionId,
    stableId: `stable-${sessionId}`,
    sessionId,
    source: "host",
    hostId: TEAM_HOST.id,
    title: TEAM_HOST.label,
    status: "connecting",
    hasReceivedOutput: false,
    sessionShare: null,
    lastEventAt: "2026-10-28T00:00:00.000Z",
  };
}

function seed(sessionIds: string[] = ["s1"]) {
  const api = createMockApi();
  const store = createAppStore(api);
  store.setState({
    hosts: [TEAM_HOST],
    tabs: sessionIds.map(connectingTab),
    tabStrip: sessionIds.map((sessionId) => ({ kind: "session" as const, sessionId })),
  });
  return { api, store };
}

/** 코어가 붙는 중에 호스트 키를 묻는다(실시간 물음). 세션이 없으면 SFTP·컨테이너 같은 끝점의 물음이다. */
function hostKeyChallenge(
  target: { sessionId?: string; endpointId?: string },
  challengeId = "live-1",
): CoreEvent {
  return {
    type: "hostKeyTrustChallenge",
    ...target,
    payload: {
      challengeId,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAAC3NzaC1lZDI1NTE5team",
      fingerprintSha256: "SHA256:team",
      mismatch: false,
      hop: { host: TEAM_HOST.hostname, port: TEAM_HOST.port },
    },
  } as CoreEvent;
}

function closedByTeamRemoval(sessionId: string): CoreEvent {
  return {
    type: "closed",
    sessionId,
    payload: { message: NOTICE, closedNotice: NOTICE },
  } as CoreEvent;
}

const noopHandler = {
  renderScheduled: () => undefined,
  perform: async () => undefined,
  renderGaveUp: () => undefined,
  isStillPresent: () => true,
};

beforeEach(() => {
  vi.useFakeTimers();
  __resetReconnectOrchestratorForTest();
  initReconnectOrchestrator(() => ({
    autoReconnectEnabled: true,
    autoReconnectMaxAttempts: 10,
    autoReconnectBaseDelayMs: 1000,
    autoReconnectMaxDelayMs: 30000,
  }));
  for (const kind of ["session", "tmux", "rdp", "vnc", "sftp"] as const) {
    registerReconnectHandler(kind, noopHandler);
  }
});

afterEach(() => {
  __resetReconnectOrchestratorForTest();
  vi.useRealTimers();
});

describe("a terminal the app closed because the team went", () => {
  it("drops its host key question", () => {
    const { store } = seed();
    store.getState().handleCoreEvent(hostKeyChallenge({ sessionId: "s1" }));
    expect(listHostKeyPrompts(store.getState()).map((prompt) => prompt.sessionId)).toEqual(["s1"]);

    store.getState().handleCoreEvent(closedByTeamRemoval("s1"));

    expect(listHostKeyPrompts(store.getState())).toEqual([]);
  });

  it("leaves the questions of another tab", () => {
    const { store } = seed(["s1", "s2"]);
    store.getState().handleCoreEvent(hostKeyChallenge({ sessionId: "s1" }, "live-1"));
    store.getState().handleCoreEvent(hostKeyChallenge({ sessionId: "s2" }, "live-2"));

    store.getState().handleCoreEvent(closedByTeamRemoval("s1"));

    expect(listHostKeyPrompts(store.getState()).map((prompt) => prompt.sessionId)).toEqual(["s2"]);
  });

  it("drops its OTP question", () => {
    const { store } = seed();
    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      sessionId: "s1",
      payload: {
        challengeId: "otp-1",
        attempt: 1,
        name: "",
        instruction: "Two-factor",
        hasStoredPassword: false,
        prompts: [{ label: "Verification code:", echo: false }],
      },
    } as CoreEvent);
    expect(store.getState().pendingInteractiveAuths).toMatchObject([{ source: "ssh", sessionId: "s1" }]);

    store.getState().handleCoreEvent(closedByTeamRemoval("s1"));

    expect(store.getState().pendingInteractiveAuths).toEqual([]);
  });

  it("closes its credential retry", () => {
    const { store } = seed();
    store.setState({
      pendingCredentialRetry: {
        sessionId: "s1",
        hostId: TEAM_HOST.id,
        source: "ssh",
        authType: "password",
        message: "인증에 실패했습니다.",
        initialUsername: TEAM_HOST.username,
      },
      activeCredentialRetryAttempt: {
        sessionId: "s1",
        hostId: TEAM_HOST.id,
        source: "ssh",
        originalUsername: "ops",
        attemptedUsername: "ops",
      },
    });

    store.getState().handleCoreEvent(closedByTeamRemoval("s1"));

    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().activeCredentialRetryAttempt).toBeNull();
  });

  it("leaves the credential retry of another tab", () => {
    const { store } = seed(["s1", "s2"]);
    const retry = {
      sessionId: "s2",
      hostId: TEAM_HOST.id,
      source: "ssh" as const,
      authType: "password" as const,
      message: "인증에 실패했습니다.",
      initialUsername: TEAM_HOST.username,
    };
    const attempt = {
      sessionId: "s2",
      hostId: TEAM_HOST.id,
      source: "ssh" as const,
      originalUsername: "ops",
      attemptedUsername: "ops",
    };
    store.setState({ pendingCredentialRetry: retry, activeCredentialRetryAttempt: attempt });

    store.getState().handleCoreEvent(closedByTeamRemoval("s1"));

    expect(store.getState().pendingCredentialRetry).toEqual(retry);
    expect(store.getState().activeCredentialRetryAttempt).toEqual(attempt);
  });
});

// SFTP·컨테이너의 물음은 탭이 없다(전역 대화상자) — 끝점 id 로 묶어, 그 연결이 끝나면 거둔다.
describe("an SFTP or containers connection that ends while it asks", () => {
  function connectingSftpPane(store: ReturnType<typeof createAppStore>, endpointId: string) {
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          connectingEndpointId: endpointId,
          connectingHostId: TEAM_HOST.id,
        },
      },
    }));
  }

  it("drops the SFTP question when the app cut that connect, and sends the pane back with the reason", () => {
    const { store } = seed([]);
    connectingSftpPane(store, "sftp-team");
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "sftp-team" }));
    scheduleReconnect({ kind: "sftp", key: "right", meta: { hostId: TEAM_HOST.id } });

    // 붙는 요청의 오류가 끊김보다 먼저 왔다 — 메인은 그 오류에도 까닭을 싣는다.
    store.getState().handleCoreEvent({
      type: "sftpError",
      endpointId: "sftp-team",
      payload: { message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    expect(listHostKeyPrompts(store.getState())).toEqual([]);
    expect(store.getState().sftp.rightPane.errorMessage).toBe(NOTICE);
    expect(isReconnecting("right")).toBe(false);
  });

  // 판이 그 연결을 아직 기다리는 경우와, 판이 다른 곳으로 옮겨 간 뒤(그 끝점을 아무 판도 안 가리킴) 끝나는 경우.
  it.each([
    ["fails", "sftpError", true],
    ["is closed", "sftpDisconnected", true],
    ["fails after its pane moved on", "sftpError", false],
    ["is closed after its pane moved on", "sftpDisconnected", false],
  ] as const)("drops the SFTP question when that connection %s for another reason", (_label, type, withPane) => {
    const { store } = seed([]);
    if (withPane) {
      connectingSftpPane(store, "sftp-team");
    }
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "sftp-team" }));

    store.getState().handleCoreEvent({
      type,
      endpointId: "sftp-team",
      payload: type === "sftpError" ? { message: "dial tcp: i/o timeout" } : {},
    } as CoreEvent);

    expect(listHostKeyPrompts(store.getState())).toEqual([]);
  });

  it("keeps the question of another SFTP connection", () => {
    const { store } = seed([]);
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "sftp-a" }, "live-a"));
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "sftp-b" }, "live-b"));

    store.getState().handleCoreEvent({
      type: "sftpDisconnected",
      endpointId: "sftp-a",
      payload: { message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    expect(listHostKeyPrompts(store.getState()).map((prompt) => prompt.endpointId)).toEqual(["sftp-b"]);
  });

  it("drops the containers question when the app cut that connect, and says why", () => {
    const { store } = seed([]);
    store.setState({ containerTabs: [createContainerTab(TEAM_HOST.id)] });
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: `containers:${TEAM_HOST.id}` }));
    expect(listHostKeyPrompts(store.getState())).toHaveLength(1);

    store.getState().handleCoreEvent({
      type: "containersError",
      endpointId: `containers:${TEAM_HOST.id}`,
      payload: { message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    expect(listHostKeyPrompts(store.getState())).toEqual([]);
    expect(store.getState().containerTabs[0]).toMatchObject({ errorMessage: NOTICE, isLoading: false });
  });
});

// 포워딩(VNC 의 경유 터널 포함)의 물음도 탭이 없다 — 끝점 id 가 곧 규칙 id 다. 팀에서 빠지면 메인이 그 포워딩을 멈추는데,
// 화면은 OTP 카드만 내리고 호스트 키 물음은 남겼다(실제 앱 10: 팀 게이트웨이를 거치는 VNC).
describe("a forward that ends while it asks", () => {
  function forwardEvent(ruleId: string, status: "starting" | "running" | "stopped" | "error") {
    return {
      runtime: {
        ruleId,
        hostId: TEAM_HOST.id,
        transport: "ssh",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 0,
        status,
        message: status === "stopped" ? NOTICE : undefined,
        updatedAt: "2026-10-28T00:00:00.000Z",
      },
    } as PortForwardRuntimeEvent;
  }

  it.each(["stopped", "error"] as const)(
    "drops the question of a VNC tunnel when that forward is %s, and keeps another forward's",
    (status) => {
      const { store } = seed([]);
      store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "vnc:pending:s1" }, "live-vnc"));
      store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "rule-other" }, "live-other"));

      store.getState().handlePortForwardEvent(forwardEvent("vnc:pending:s1", status));

      expect(listHostKeyPrompts(store.getState()).map((prompt) => prompt.endpointId)).toEqual(["rule-other"]);
    },
  );

  it("keeps the question while that forward is still starting or running", () => {
    const { store } = seed([]);
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "rule-1" }));

    store.getState().handlePortForwardEvent(forwardEvent("rule-1", "starting"));
    store.getState().handlePortForwardEvent(forwardEvent("rule-1", "running"));

    expect(listHostKeyPrompts(store.getState()).map((prompt) => prompt.endpointId)).toEqual(["rule-1"]);
  });
});

// 마지막 안전장치 — 물음의 호스트가 목록에서 사라졌으면(팀을 잊음) 신뢰로 풀지 않는다. 키를 두지 않고 '아니오'로 답한다.
describe("accepting a host key question", () => {
  it("does not trust a question whose host left the list, and answers no", async () => {
    const { api, store } = seed([]);
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "sftp-team" }));
    store.setState({ hosts: [] });

    await store.getState().acceptPendingHostKeyPrompt("trust");

    expect(vi.mocked(api.knownHosts.trust)).not.toHaveBeenCalled();
    expect(vi.mocked(api.ssh.respondHostKeyTrust).mock.calls.map(([input]) => input)).toEqual([
      { challengeId: "live-1", trust: false },
    ]);
    expect(listHostKeyPrompts(store.getState())).toEqual([]);
  });

  it("trusts a question whose host is still listed", async () => {
    const { api, store } = seed([]);
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "sftp-team" }));

    await store.getState().acceptPendingHostKeyPrompt("trust");

    expect(vi.mocked(api.knownHosts.trust)).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: TEAM_HOST.id }),
    );
    expect(vi.mocked(api.ssh.respondHostKeyTrust)).toHaveBeenCalledWith({ challengeId: "live-1", trust: true });
  });

  it("trusts a question for a hop that is not a saved host (no host id)", async () => {
    const { api, store } = seed([]);
    store.setState({ hosts: [] });
    store.getState().handleCoreEvent(hostKeyChallenge({ endpointId: "sftp-team" }));
    expect(listHostKeyPrompts(store.getState())[0]?.probe.hostId).toBe("");

    await store.getState().acceptPendingHostKeyPrompt("trust");

    expect(vi.mocked(api.knownHosts.trust)).toHaveBeenCalled();
    expect(vi.mocked(api.ssh.respondHostKeyTrust)).toHaveBeenCalledWith({ challengeId: "live-1", trust: true });
  });
});
