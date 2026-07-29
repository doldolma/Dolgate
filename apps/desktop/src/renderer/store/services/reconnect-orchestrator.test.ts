import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getReconnectStateForTest,
  __resetReconnectOrchestratorForTest,
  cancelReconnect,
  computeBackoffDelay,
  initReconnectHold,
  initReconnectOrchestrator,
  isReconnecting,
  onConnectivityChange,
  registerReconnectHandler,
  resumeReconnectsAfterHold,
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

// Tailscale 이 브라우저 로그인을 기다리는 동안은 재연결이 될 수 없다. 그 사이에 시도 횟수를
// 소비하면 사용자가 로그인하기 전에 상한을 다 써서 포기해 버리고, 로그인을 마쳐도 아무 일도
// 일어나지 않는다.
describe("사람을 기다리는 동안의 재연결", () => {
  it("시도 횟수를 소비하지 않고 다시 확인한다", async () => {
    const handler = makeHandler();
    registerReconnectHandler("session", handler);
    let held = true;
    initReconnectHold(() => held);

    scheduleReconnect({ kind: "session", key: "s1" });
    await vi.advanceTimersByTimeAsync(1500);

    // 막혀 있는 동안은 실행하지 않는다.
    expect(handler.perform).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(handler.perform).not.toHaveBeenCalled();
    // 상한(3)을 넘도록 기다려도 포기하지 않는다.
    expect(handler.renderGaveUp).not.toHaveBeenCalled();
    expect(__getReconnectStateForTest("s1")?.attempt).toBe(0);

    // 사람이 로그인을 마치면 그때 진행한다.
    held = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler.perform).toHaveBeenCalledTimes(1);
  });

  // 로그인을 마쳤는데 백오프를 기다리게 두면 화면이 한동안 멈춘 것처럼 보인다.
  it("열리는 순간 백오프를 기다리지 않고 재발화한다", async () => {
    const handler = makeHandler();
    registerReconnectHandler("session", handler);
    let held = true;
    initReconnectHold(() => held);

    scheduleReconnect({ kind: "session", key: "s1" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(handler.perform).not.toHaveBeenCalled();

    held = false;
    resumeReconnectsAfterHold();
    await vi.advanceTimersByTimeAsync(300);

    expect(handler.perform).toHaveBeenCalledTimes(1);
  });

  // 막지 않는 대상은 평소처럼 시도 횟수를 쓴다. 안 그러면 영원히 재시도하는 대상이 생긴다.
  it("막히지 않은 대상은 평소처럼 시도한다", async () => {
    const handler = makeHandler();
    registerReconnectHandler("session", handler);
    initReconnectHold(() => false);

    scheduleReconnect({ kind: "session", key: "s1" });
    // 백오프에 0.8~1.2 지터가 있어 정각(1000ms)으로는 불안정하다. 상한을 넘겨 기다린다.
    await vi.advanceTimersByTimeAsync(1500);

    expect(handler.perform).toHaveBeenCalledTimes(1);
    expect(__getReconnectStateForTest("s1")?.attempt).toBe(1);
  });
});
