import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, HostRecord, TerminalTab } from "@shared";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import {
  __resetReconnectOrchestratorForTest,
  initReconnectOrchestrator,
  isReconnecting,
  registerReconnectHandler,
} from "./services/reconnect-orchestrator";

const SSH_HOST: HostRecord = {
  id: "h1",
  kind: "ssh",
  label: "Prod",
  hostname: "prod.example.com",
  port: 22,
  username: "ubuntu",
  authType: "password",
  privateKeyPath: null,
  secretRef: null,
  jumpHostId: null,
  startupCommand: null,
  groupName: null,
  tags: [],
  terminalThemeId: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

function connectedTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "s1",
    stableId: "stable-1",
    sessionId: "s1",
    source: "host",
    hostId: "h1",
    title: "Prod",
    status: "connected",
    hasReceivedOutput: true,
    sessionShare: null,
    lastEventAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedStore(tab: TerminalTab) {
  const store = createAppStore(createMockApi());
  store.setState({
    hosts: [SSH_HOST],
    tabs: [tab],
    tabStrip: [{ kind: "session", sessionId: tab.sessionId }],
  });
  return store;
}

function closedEvent(
  payload: Record<string, unknown>,
  sessionId = "s1",
): CoreEvent {
  return { type: "closed", sessionId, payload } as CoreEvent;
}

const AWS_HOST: HostRecord = {
  id: "aws1",
  kind: "aws-ec2",
  label: "EC2 Prod",
  awsProfileName: "default",
  awsRegion: "ap-northeast-2",
  awsInstanceId: "i-123",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

function seedAwsStore(tab: TerminalTab) {
  const store = createAppStore(createMockApi());
  store.setState({
    hosts: [AWS_HOST],
    tabs: [tab],
    tabStrip: [{ kind: "session", sessionId: tab.sessionId }],
  });
  return store;
}

describe("auto-reconnect trigger (runtimeEventSlice)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReconnectOrchestratorForTest();
    initReconnectOrchestrator(() => ({
      autoReconnectEnabled: true,
      autoReconnectMaxAttempts: 10,
      autoReconnectBaseDelayMs: 1000,
      autoReconnectMaxDelayMs: 30000,
    }));
    // store 인스턴스가 아닌 orchestrator 동작만 검증하므로 no-op 핸들러를 등록한다.
    registerReconnectHandler("session", {
      renderScheduled: () => undefined,
      perform: async () => undefined,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });
  });

  afterEach(() => {
    __resetReconnectOrchestratorForTest();
    vi.useRealTimers();
  });

  it("schedules reconnect on a transport drop of a connected session (keeps tab)", () => {
    const store = seedStore(connectedTab());
    store
      .getState()
      .handleCoreEvent(
        closedEvent({ reason: "transport", message: "connection reset" }),
      );

    expect(isReconnecting("stable-1")).toBe(true);
    const tab = store.getState().tabs.find((item) => item.stableId === "stable-1");
    expect(tab).toBeTruthy();
    expect(tab?.status).toBe("connecting");
    expect(tab?.connectionProgress?.stage).toBe("reconnecting");
  });

  it("does NOT reconnect a cleanly exited shell (reason remote-exit)", () => {
    const store = seedStore(connectedTab());
    store.getState().handleCoreEvent(closedEvent({ reason: "remote-exit" }));

    expect(isReconnecting("stable-1")).toBe(false);
    expect(
      store.getState().tabs.find((item) => item.stableId === "stable-1"),
    ).toBeUndefined();
  });

  it("does NOT reconnect an intentional disconnect (status disconnecting)", () => {
    const store = seedStore(connectedTab({ status: "disconnecting" }));
    store
      .getState()
      .handleCoreEvent(closedEvent({ reason: "transport", message: "reset" }));

    expect(isReconnecting("stable-1")).toBe(false);
  });

  it("does NOT reconnect when auto-reconnect is disabled", () => {
    __resetReconnectOrchestratorForTest();
    initReconnectOrchestrator(() => ({
      autoReconnectEnabled: false,
      autoReconnectMaxAttempts: 10,
      autoReconnectBaseDelayMs: 1000,
      autoReconnectMaxDelayMs: 30000,
    }));
    registerReconnectHandler("session", {
      renderScheduled: () => undefined,
      perform: async () => undefined,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });
    const store = seedStore(connectedTab());
    // 비활성 상태에서도 store는 끊김을 OFF로 읽어야 한다.
    store.setState({
      settings: { ...store.getState().settings, autoReconnectEnabled: false },
    });
    store
      .getState()
      .handleCoreEvent(closedEvent({ reason: "transport", message: "reset" }));

    expect(isReconnecting("stable-1")).toBe(false);
  });

  it("reconnects an aws-ec2 SSM session on a non-zero exit (drop)", () => {
    const store = seedAwsStore(
      connectedTab({ stableId: "stable-aws", sessionId: "a1", hostId: "aws1" }),
    );
    store
      .getState()
      .handleCoreEvent(
        closedEvent(
          { message: "AWS SSM session exited with code 1" },
          "a1",
        ),
      );

    expect(isReconnecting("stable-aws")).toBe(true);
    const tab = store
      .getState()
      .tabs.find((item) => item.stableId === "stable-aws");
    expect(tab?.status).toBe("connecting");
  });

  it("does NOT reconnect an aws-ec2 SSM session on a clean exit (code 0)", () => {
    const store = seedAwsStore(
      connectedTab({ stableId: "stable-aws", sessionId: "a1", hostId: "aws1" }),
    );
    store
      .getState()
      .handleCoreEvent(
        closedEvent(
          { message: "AWS SSM session exited with code 0" },
          "a1",
        ),
      );

    expect(isReconnecting("stable-aws")).toBe(false);
  });

  it("does NOT reconnect a session that never produced output", () => {
    const store = seedStore(connectedTab({ hasReceivedOutput: false }));
    store
      .getState()
      .handleCoreEvent(closedEvent({ reason: "transport", message: "reset" }));

    expect(isReconnecting("stable-1")).toBe(false);
  });
});

// Plan B: 자동 재연결을 안 거는 경우에도 비정상 드롭이면 탭을 없애지 말고 끊김(error+Retry)
// 상태로 유지한다. 정상 exit/client만 탭을 닫는다.
describe("hold-on-abnormal-drop (runtimeEventSlice, Plan B)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReconnectOrchestratorForTest();
    // 자동 재연결 OFF로 초기화 — 이 상태에서도 탭이 사라지지 않아야 함.
    initReconnectOrchestrator(() => ({
      autoReconnectEnabled: false,
      autoReconnectMaxAttempts: 10,
      autoReconnectBaseDelayMs: 1000,
      autoReconnectMaxDelayMs: 30000,
    }));
    registerReconnectHandler("session", {
      renderScheduled: () => undefined,
      perform: async () => undefined,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });
  });

  afterEach(() => {
    __resetReconnectOrchestratorForTest();
    vi.useRealTimers();
  });

  function seedDisabledStore(tab: TerminalTab) {
    const store = seedStore(tab);
    store.setState({
      settings: { ...store.getState().settings, autoReconnectEnabled: false },
    });
    return store;
  }

  it("holds the tab as error+retryable on a transport drop when auto-reconnect is OFF", () => {
    const store = seedDisabledStore(connectedTab());
    store
      .getState()
      .handleCoreEvent(
        closedEvent({ reason: "transport", message: "connection reset" }),
      );

    expect(isReconnecting("stable-1")).toBe(false);
    const tab = store
      .getState()
      .tabs.find((item) => item.stableId === "stable-1");
    expect(tab).toBeTruthy(); // 탭이 사라지지 않음
    expect(tab?.status).toBe("error");
    expect(tab?.connectionProgress?.retryable).toBe(true); // 수동 재연결(Retry) 노출
    expect(tab?.errorMessage).toBe("connection reset");
  });

  it("holds the tab on a keepalive drop when auto-reconnect is OFF", () => {
    const store = seedDisabledStore(connectedTab());
    store.getState().handleCoreEvent(closedEvent({ reason: "keepalive" }));

    const tab = store
      .getState()
      .tabs.find((item) => item.stableId === "stable-1");
    expect(tab).toBeTruthy();
    expect(tab?.status).toBe("error");
    expect(tab?.connectionProgress?.retryable).toBe(true);
  });

  it("still removes the tab on a clean remote-exit when auto-reconnect is OFF", () => {
    const store = seedDisabledStore(connectedTab());
    store.getState().handleCoreEvent(closedEvent({ reason: "remote-exit" }));

    expect(
      store.getState().tabs.find((item) => item.stableId === "stable-1"),
    ).toBeUndefined();
  });

  it("still removes the tab on a client-requested disconnect when auto-reconnect is OFF", () => {
    const store = seedDisabledStore(connectedTab());
    store.getState().handleCoreEvent(closedEvent({ reason: "client" }));

    expect(
      store.getState().tabs.find((item) => item.stableId === "stable-1"),
    ).toBeUndefined();
  });
});

// tmux control 세션은 그룹 형성 시 탭이 사라져 일반 세션 재연결(shouldAutoReconnectSession)을
// 못 탄다. closed 이벤트를 controlSessionId 로 그룹에 매핑해 그룹 단위로 재연결을 거는지 검증.
describe("tmux auto-reconnect trigger (runtimeEventSlice)", () => {
  const CTL = "tmux-ctl-1";

  beforeEach(() => {
    vi.useFakeTimers();
    __resetReconnectOrchestratorForTest();
    initReconnectOrchestrator(() => ({
      autoReconnectEnabled: true,
      autoReconnectMaxAttempts: 10,
      autoReconnectBaseDelayMs: 1000,
      autoReconnectMaxDelayMs: 30000,
    }));
    registerReconnectHandler("tmux", {
      renderScheduled: () => undefined,
      perform: async () => undefined,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });
  });

  afterEach(() => {
    __resetReconnectOrchestratorForTest();
    vi.useRealTimers();
  });

  function seedTmuxStore() {
    const store = createAppStore(createMockApi());
    store.setState({ hosts: [SSH_HOST] });
    store
      .getState()
      .handleTmuxLayoutChange(CTL, "@0", "bd5e,80x24,0,0,0", { index: 0 });
    // 그룹 hostId 는 control 탭에서 캡처되는데 테스트엔 control 탭이 없으므로 명시 세팅.
    store.setState((state) => ({
      tmuxGroups: state.tmuxGroups.map((g) => ({ ...g, hostId: "h1" })),
    }));
    return store;
  }

  it("schedules a tmux reconnect (key = group.id) on a transport drop of the control session", () => {
    const store = seedTmuxStore();
    const groupId = store.getState().tmuxGroups[0]!.id;

    store.getState().handleCoreEvent(closedEvent({ reason: "transport" }, CTL));

    expect(isReconnecting(groupId)).toBe(true);
  });

  it("schedules a tmux reconnect on a keepalive-failure drop (app-level probe)", () => {
    const store = seedTmuxStore();
    const groupId = store.getState().tmuxGroups[0]!.id;

    store.getState().handleCoreEvent(closedEvent({ reason: "keepalive" }, CTL));

    expect(isReconnecting(groupId)).toBe(true);
  });

  it("does NOT reconnect (and cleans up the group) on a clean control-session close", () => {
    const store = seedTmuxStore();
    const groupId = store.getState().tmuxGroups[0]!.id;

    store.getState().handleCoreEvent(closedEvent({ reason: "remote-exit" }, CTL));

    expect(isReconnecting(groupId)).toBe(false);
    expect(store.getState().tmuxGroups).toHaveLength(0);
  });

  it("does NOT reconnect on a client-requested detach (reason=client)", () => {
    const store = seedTmuxStore();
    const groupId = store.getState().tmuxGroups[0]!.id;

    store.getState().handleCoreEvent(closedEvent({ reason: "client" }, CTL));

    expect(isReconnecting(groupId)).toBe(false);
    expect(store.getState().tmuxGroups).toHaveLength(0);
  });

  it("marks the group dropped (error, no reconnect) on a transport drop when auto-reconnect is OFF", () => {
    const store = seedTmuxStore();
    store.setState((state) => ({
      settings: { ...state.settings, autoReconnectEnabled: false },
    }));
    const groupId = store.getState().tmuxGroups[0]!.id;

    store.getState().handleCoreEvent(closedEvent({ reason: "transport" }, CTL));

    expect(isReconnecting(groupId)).toBe(false);
    expect(store.getState().tmuxGroups[0]?.reconnect ?? null).toBeNull();
    const pane = store.getState().tabs.find((t) => t.tmux?.windowId === "@0");
    expect(pane?.status).toBe("error");
    expect(pane?.connectionProgress?.retryable).toBe(true);
  });
});

// keepalive round-trip 이벤트가 탭 인디게이터용 RTT 로 기록되는지(SSH 세션 탭).
describe("keepalive latency → tab RTT", () => {
  it("records RTT on the session tab from a latency event", () => {
    const store = seedStore(connectedTab());

    store.getState().handleCoreEvent({
      type: "latency",
      sessionId: "s1",
      payload: { roundTripMs: 9 },
    } as CoreEvent);

    expect(
      store.getState().tabs.find((item) => item.stableId === "stable-1")
        ?.lastRttMs,
    ).toBe(9);
  });
});

// 셸 통합(OSC133) 기반 명령 상태가 탭에 기록되는지(탭 점 하이브리드용).
describe("shell-integration command state → tab", () => {
  it("records running then ok/failed on the session tab", () => {
    const store = seedStore(connectedTab());
    const rttTab = () =>
      store.getState().tabs.find((item) => item.stableId === "stable-1");

    store.getState().applyTabCommandState("s1", "running");
    expect(rttTab()?.commandState).toBe("running");

    store.getState().applyTabCommandState("s1", "failed");
    expect(rttTab()?.commandState).toBe("failed");

    store.getState().applyTabCommandState("s1", null);
    expect(rttTab()?.commandState ?? null).toBeNull();
  });
});
