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
