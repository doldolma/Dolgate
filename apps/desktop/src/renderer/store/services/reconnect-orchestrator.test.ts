import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getReconnectStateForTest,
  __resetReconnectOrchestratorForTest,
  cancelReconnect,
  computeBackoffDelay,
  initReconnectOrchestrator,
  isReconnecting,
  onConnectivityChange,
  registerReconnectHandler,
  scheduleReconnect,
  type ReconnectAttemptInfo,
} from "./reconnect-orchestrator";

interface HandlerMock {
  renderScheduled: ReturnType<typeof vi.fn>;
  perform: ReturnType<typeof vi.fn>;
  renderGaveUp: ReturnType<typeof vi.fn>;
  isStillPresent: ReturnType<typeof vi.fn>;
}

function makeHandler(): HandlerMock {
  return {
    renderScheduled: vi.fn(),
    perform: vi.fn().mockResolvedValue(undefined),
    renderGaveUp: vi.fn(),
    isStillPresent: vi.fn().mockReturnValue(true),
  };
}

const CONFIG = {
  autoReconnectEnabled: true,
  autoReconnectMaxAttempts: 3,
  autoReconnectBaseDelayMs: 1000,
  autoReconnectMaxDelayMs: 30000,
};

let config = { ...CONFIG };

beforeEach(() => {
  vi.useFakeTimers();
  __resetReconnectOrchestratorForTest();
  config = { ...CONFIG };
  initReconnectOrchestrator(() => config);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeBackoffDelay", () => {
  it("grows exponentially, capped at max, within jitter bounds", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = computeBackoffDelay(attempt, 1000, 30000);
      const capped = Math.min(30000, 1000 * 2 ** attempt);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(capped * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.ceil(capped * 1.2));
    }
  });
});

describe("scheduleReconnect", () => {
  it("schedules then performs after backoff", async () => {
    const handler = makeHandler();
    registerReconnectHandler("session", handler);

    expect(scheduleReconnect({ kind: "session", key: "k1" })).toBe(true);
    expect(handler.renderScheduled).toHaveBeenCalledTimes(1);
    const info = handler.renderScheduled.mock.calls[0][1] as ReconnectAttemptInfo;
    expect(info.attempt).toBe(1);
    expect(handler.perform).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1300);
    expect(handler.perform).toHaveBeenCalledTimes(1);
    expect(handler.perform).toHaveBeenCalledWith("k1", expect.anything());
  });

  it("does nothing when auto-reconnect is disabled", () => {
    config.autoReconnectEnabled = false;
    const handler = makeHandler();
    registerReconnectHandler("session", handler);
    expect(scheduleReconnect({ kind: "session", key: "k1" })).toBe(false);
    expect(handler.renderScheduled).not.toHaveBeenCalled();
  });

  it("gives up after max attempts", async () => {
    const handler = makeHandler();
    registerReconnectHandler("session", handler);

    // 3회 시도(perform) 후 4번째 schedule에서 포기.
    // 진행 시간은 백오프보다 크고 워치독(30s)보다 작게 둔다.
    for (let i = 0; i < config.autoReconnectMaxAttempts; i++) {
      scheduleReconnect({ kind: "session", key: "k1" });
      await vi.advanceTimersByTimeAsync(6000);
    }
    expect(handler.perform).toHaveBeenCalledTimes(3);
    expect(handler.renderGaveUp).not.toHaveBeenCalled();

    scheduleReconnect({ kind: "session", key: "k1" });
    expect(handler.renderGaveUp).toHaveBeenCalledTimes(1);
    expect(isReconnecting("k1")).toBe(false);
  });

  it("cancel stops a pending attempt", async () => {
    const handler = makeHandler();
    registerReconnectHandler("session", handler);
    scheduleReconnect({ kind: "session", key: "k1" });
    expect(isReconnecting("k1")).toBe(true);
    cancelReconnect("k1", "test");
    expect(isReconnecting("k1")).toBe(false);
    await vi.advanceTimersByTimeAsync(40000);
    expect(handler.perform).not.toHaveBeenCalled();
  });
});

describe("connectivity gating", () => {
  it("waits while offline, then fires immediately on reconnect", async () => {
    const handler = makeHandler();
    registerReconnectHandler("session", handler);

    onConnectivityChange(false);
    scheduleReconnect({ kind: "session", key: "k1" });
    const info = handler.renderScheduled.mock.calls[0][1] as ReconnectAttemptInfo;
    expect(info.waitingForNetwork).toBe(true);
    expect(__getReconnectStateForTest("k1")?.waitingForNetwork).toBe(true);

    await vi.advanceTimersByTimeAsync(40000);
    expect(handler.perform).not.toHaveBeenCalled();

    onConnectivityChange(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(handler.perform).toHaveBeenCalledTimes(1);
  });
});
