import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, HostRecord, TerminalTab } from "@shared";
import { createAppStore } from "./createAppStore";
import { createContainerTab, createMockApi } from "./createAppStore.test-support";
import {
  __resetReconnectOrchestratorForTest,
  initReconnectOrchestrator,
  isReconnecting,
  registerReconnectHandler,
  scheduleReconnect,
} from "./services/reconnect-orchestrator";

// 팀에서 빠지면 메인이 그 팀 호스트의 연결을 까닭과 함께 닫는다(core-manager.closeHostConnections, RDP·VNC 의
// closeHostSessions). 화면은 그 자리를 끊김으로 남겨 까닭을 보이고, 되살리지 않는다 — 그 호스트는 곧 사라진다.

const NOTICE = "팀에서 빠져 이 연결을 닫았습니다.";

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

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
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

function seed(seedTab: TerminalTab, hosts: HostRecord[] = [SSH_HOST]) {
  const store = createAppStore(createMockApi());
  store.setState({
    hosts,
    tabs: [seedTab],
    tabStrip: [{ kind: "session", sessionId: seedTab.sessionId }],
  });
  return store;
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

describe("a terminal the app closed with a reason", () => {
  it("stays as a dropped tab that says why, with no retry and no reconnect", () => {
    const store = seed(tab());

    // 끊긴 모양(transport)이어도 까닭이 실려 있으면 되살리지 않는다.
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "s1",
      payload: { reason: "transport", message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    expect(isReconnecting("stable-1")).toBe(false);
    const closed = store.getState().tabs.find((item) => item.sessionId === "s1");
    expect(closed).toMatchObject({ status: "error", errorMessage: NOTICE });
    expect(closed?.connectionProgress).toMatchObject({ message: NOTICE, retryable: false });
  });

  it("stops a reconnect that was already under way", () => {
    const store = seed(tab({ status: "connecting" }));
    scheduleReconnect({ kind: "session", key: "stable-1" });
    expect(isReconnecting("stable-1")).toBe(true);

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "s1",
      payload: { message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    expect(isReconnecting("stable-1")).toBe(false);
    expect(store.getState().tabs[0]).toMatchObject({ status: "error", errorMessage: NOTICE });
  });

  it("marks every pane of a tmux group dropped without a retry", () => {
    const store = createAppStore(createMockApi());
    store.setState({ hosts: [SSH_HOST] });
    store.getState().handleTmuxLayoutChange("tmux-ctl-1", "@0", "bd5e,80x24,0,0,0", { index: 0 });
    store.setState((state) => ({ tmuxGroups: state.tmuxGroups.map((group) => ({ ...group, hostId: "h1" })) }));
    const groupId = store.getState().tmuxGroups[0]!.id;

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "tmux-ctl-1",
      payload: { reason: "transport", message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    expect(isReconnecting(groupId)).toBe(false);
    const pane = store.getState().tabs.find((item) => item.tmux?.windowId === "@0");
    expect(pane?.status).toBe("error");
    expect(pane?.connectionProgress).toMatchObject({ message: NOTICE, retryable: false });
  });

  it("still closes an ordinary tab on a clean exit (no reason)", () => {
    const store = seed(tab());

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "s1",
      payload: { reason: "remote-exit", message: "exit" },
    } as CoreEvent);

    expect(store.getState().tabs).toHaveLength(0);
  });
});

describe("a remote screen the app closed with a reason", () => {
  const RDP_HOST = { id: "rdp1", kind: "rdp", label: "Win", hostname: "10.0.2.181", port: 3389 } as HostRecord;
  const VNC_HOST = { id: "vnc1", kind: "vnc", label: "Lab", hostname: "10.0.2.90", port: 5900 } as HostRecord;

  it("keeps an RDP tab dropped with the reason, even after the core's own close", () => {
    const store = seed(
      tab({ sessionId: "rdp-s1", stableId: "rdp-stable-1", hostId: "rdp1", paneKind: "rdp" } as Partial<TerminalTab>),
      [RDP_HOST],
    );

    store.getState().handleRdpEvent({ type: "closed", sessionId: "rdp-s1", graceful: true, reason: NOTICE, notice: NOTICE });
    store.getState().handleRdpEvent({ type: "closed", sessionId: "rdp-s1" });

    expect(isReconnecting("rdp-stable-1")).toBe(false);
    const closed = store.getState().tabs.find((item) => item.sessionId === "rdp-s1");
    expect(closed).toMatchObject({ status: "error", errorMessage: NOTICE });
    expect(closed?.connectionProgress?.retryable).toBe(false);
  });

  it("keeps a VNC tab dropped with the reason instead of reconnecting", () => {
    const store = seed(
      tab({ sessionId: "vnc-s1", stableId: "vnc-stable-1", hostId: "vnc1", paneKind: "vnc" } as Partial<TerminalTab>),
      [VNC_HOST],
    );

    store.getState().handleVncEvent({ type: "closed", sessionId: "vnc-s1", notice: NOTICE });

    expect(isReconnecting("vnc-stable-1")).toBe(false);
    const closed = store.getState().tabs.find((item) => item.sessionId === "vnc-s1");
    expect(closed).toMatchObject({ status: "error", errorMessage: NOTICE });
    expect(closed?.connectionProgress?.retryable).toBe(false);
  });
});

describe("SFTP and containers the app closed with a reason", () => {
  it("sends the SFTP pane back to the host picker and says why", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          endpoint: {
            id: "endpoint-1",
            kind: "remote",
            hostId: "h1",
            title: "Prod",
            path: "/remote",
            connectedAt: "2025-01-01T00:00:00.000Z",
          },
          currentPath: "/remote",
          history: ["/remote"],
          historyIndex: 0,
        },
      },
    }));
    scheduleReconnect({ kind: "sftp", key: "right", meta: { hostId: "h1" } });
    expect(isReconnecting("right")).toBe(true);

    store.getState().handleCoreEvent({
      type: "sftpDisconnected",
      endpointId: "endpoint-1",
      payload: { message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    const pane = store.getState().sftp.rightPane;
    expect(pane.endpoint).toBeNull();
    expect(pane.currentPath).toBe("");
    expect(pane.errorMessage).toBe(NOTICE);
    expect(isReconnecting("right")).toBe(false);
  });

  it("shows the reason on the containers tab", () => {
    const store = createAppStore(createMockApi());
    store.setState({ hosts: [SSH_HOST], containerTabs: [createContainerTab("h1")] });

    store.getState().handleCoreEvent({
      type: "containersDisconnected",
      endpointId: "containers:h1",
      payload: { message: NOTICE, closedNotice: NOTICE },
    } as CoreEvent);

    expect(store.getState().containerTabs[0]).toMatchObject({ errorMessage: NOTICE, isLoading: false });
  });
});
