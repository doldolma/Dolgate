import { describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  startSyncWatchLoop,
  syncWatchBackoffMs,
  type SyncWatchOutcome,
} from "@dolssh/shared-core";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function startHarness() {
  let clock = 0;
  const watches: Array<{ signal: AbortSignal; result: Deferred<SyncWatchOutcome> }> = [];
  const sleeps: Array<{ ms: number; result: Deferred<void> }> = [];
  const onChange = vi.fn(async () => true);
  const loop = startSyncWatchLoop({
    watch: (signal) => {
      const result = deferred<SyncWatchOutcome>();
      watches.push({ signal, result });
      return result.promise;
    },
    onChange: () => onChange(),
    sleep: (ms, signal) => {
      const result = deferred<void>();
      sleeps.push({ ms, result });
      signal.addEventListener("abort", () => result.reject(new Error("aborted")));
      return result.promise;
    },
    random: () => 0.5,
    now: () => clock,
  });
  return {
    loop,
    watches,
    sleeps,
    onChange,
    lastWatch: () => watches[watches.length - 1],
    lastSleep: () => sleeps[sleeps.length - 1],
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("startSyncWatchLoop", () => {
  it("pulls when the server says something changed, then waits again", async () => {
    const harness = startHarness();
    await flush();
    expect(harness.watches).toHaveLength(1);

    harness.lastWatch().result.resolve("changed");
    await flush();

    expect(harness.onChange).toHaveBeenCalledTimes(1);
    expect(harness.watches).toHaveLength(2);
    expect(harness.sleeps).toHaveLength(0);
    harness.loop.stop();
  });

  it("waits again right away after a full wait with nothing changed", async () => {
    const harness = startHarness();
    await flush();

    harness.advance(25_000);
    harness.lastWatch().result.resolve("unchanged");
    await flush();

    expect(harness.onChange).not.toHaveBeenCalled();
    expect(harness.watches).toHaveLength(2);
    expect(harness.sleeps).toHaveLength(0);
    harness.loop.stop();
  });

  // 서버가 내려가는 중이거나 중간 장비가 대기를 바로 끊으면 '변경 없음' 이 즉시 돌아온다.
  // 그대로 다시 붙으면 요청이 끝없이 돈다.
  it("backs off when 'unchanged' comes back too fast", async () => {
    const harness = startHarness();
    await flush();

    harness.advance(10);
    harness.lastWatch().result.resolve("unchanged");
    await flush();

    expect(harness.watches).toHaveLength(1);
    expect(harness.lastSleep().ms).toBe(2_000);
    harness.lastSleep().result.resolve();
    await flush();
    expect(harness.watches).toHaveLength(2);
    harness.loop.stop();
  });

  it("backs off 2·5·15·30s on repeated failures and resets after a healthy wait", async () => {
    const harness = startHarness();
    await flush();

    for (const expected of [2_000, 5_000, 15_000, 30_000, 30_000]) {
      harness.lastWatch().result.reject(new Error("offline"));
      await flush();
      expect(harness.lastSleep().ms).toBe(expected);
      harness.lastSleep().result.resolve();
      await flush();
    }

    harness.advance(25_000);
    harness.lastWatch().result.resolve("unchanged");
    await flush();
    harness.lastWatch().result.reject(new Error("offline"));
    await flush();
    expect(harness.lastSleep().ms).toBe(2_000);
    harness.loop.stop();
  });

  // 당기기가 리비전을 못 올리면 다음 watch 가 즉시 또 'changed' 를 돌려준다.
  it("backs off when the pull fails instead of pulling again at once", async () => {
    const harness = startHarness();
    harness.onChange.mockResolvedValueOnce(false);
    await flush();

    harness.lastWatch().result.resolve("changed");
    await flush();

    expect(harness.onChange).toHaveBeenCalledTimes(1);
    expect(harness.watches).toHaveLength(1);
    expect(harness.lastSleep().ms).toBe(2_000);
    harness.loop.stop();
  });

  it("treats a throwing pull as a failure", async () => {
    const harness = startHarness();
    harness.onChange.mockRejectedValueOnce(new Error("boom"));
    await flush();

    harness.lastWatch().result.resolve("changed");
    await flush();

    expect(harness.sleeps).toHaveLength(1);
    harness.loop.stop();
  });

  // 앞단이 ETag 를 지우거나 바꾸면 서버가 매번 즉시 '바뀜' 이라 답하고, 당기기는 성공한다.
  it("pulls every quick 'changed' but backs off once more than three come in a row", async () => {
    const harness = startHarness();
    await flush();

    for (let round = 1; round <= 3; round += 1) {
      harness.lastWatch().result.resolve("changed");
      await flush();
    }
    expect(harness.onChange).toHaveBeenCalledTimes(3);
    expect(harness.watches).toHaveLength(4);
    expect(harness.sleeps).toHaveLength(0);

    for (const expected of [2_000, 5_000, 15_000, 30_000, 30_000]) {
      harness.lastWatch().result.resolve("changed");
      await flush();
      expect(harness.lastSleep().ms).toBe(expected);
      harness.lastSleep().result.resolve();
      await flush();
    }
    expect(harness.onChange).toHaveBeenCalledTimes(8);
    harness.loop.stop();
  });

  it.each(["changed", "unchanged"] as const)(
    "counts quick 'changed' answers from zero again after a wait the server held (%s)",
    async (held) => {
      const harness = startHarness();
      await flush();
      for (let round = 1; round <= 3; round += 1) {
        harness.lastWatch().result.resolve("changed");
        await flush();
      }

      // 1초를 채운 대기는 서버가 기다려 준 것이다.
      harness.advance(1_000);
      harness.lastWatch().result.resolve(held);
      await flush();
      for (let round = 1; round <= 3; round += 1) {
        harness.lastWatch().result.resolve("changed");
        await flush();
      }
      expect(harness.sleeps).toHaveLength(0);

      harness.lastWatch().result.resolve("changed");
      await flush();
      expect(harness.lastSleep().ms).toBe(2_000);
      harness.loop.stop();
    },
  );

  it("times only the wait, not the pull, when telling a quick 'changed'", async () => {
    const harness = startHarness();
    harness.onChange.mockImplementation(async () => {
      harness.advance(2_000);
      return true;
    });
    await flush();

    for (let round = 1; round <= 3; round += 1) {
      harness.lastWatch().result.resolve("changed");
      await flush();
    }
    expect(harness.sleeps).toHaveLength(0);
    harness.lastWatch().result.resolve("changed");
    await flush();
    expect(harness.lastSleep().ms).toBe(2_000);
    harness.loop.stop();
  });

  // 끊겼다 돌아오면 첫 대기가 그동안 쌓인 변경으로 즉시 '바뀜' 이다. 그것은 정상이다.
  it("still clears earlier failures on a quick 'changed' within the three", async () => {
    const harness = startHarness();
    await flush();
    harness.lastWatch().result.reject(new Error("offline"));
    await flush();
    expect(harness.lastSleep().ms).toBe(2_000);
    harness.lastSleep().result.resolve();
    await flush();

    harness.lastWatch().result.resolve("changed");
    await flush();
    harness.lastWatch().result.reject(new Error("offline"));
    await flush();
    expect(harness.lastSleep().ms).toBe(2_000);
    harness.loop.stop();
  });

  it("stop aborts the wait in flight and ignores its result", async () => {
    const harness = startHarness();
    await flush();
    const inFlight = harness.lastWatch();

    harness.loop.stop();
    expect(inFlight.signal.aborted).toBe(true);
    inFlight.result.resolve("changed");
    await flush();

    expect(harness.onChange).not.toHaveBeenCalled();
    expect(harness.watches).toHaveLength(1);
  });

  it("stop during a backoff ends the loop", async () => {
    const harness = startHarness();
    await flush();
    harness.lastWatch().result.reject(new Error("offline"));
    await flush();
    expect(harness.sleeps).toHaveLength(1);

    harness.loop.stop();
    await flush();
    expect(harness.watches).toHaveLength(1);
  });

  it("retryNow cuts a backoff short but leaves a live wait alone", async () => {
    const harness = startHarness();
    await flush();

    harness.loop.retryNow();
    expect(harness.lastWatch().signal.aborted).toBe(false);

    harness.lastWatch().result.reject(new Error("offline"));
    await flush();
    expect(harness.sleeps).toHaveLength(1);

    harness.loop.retryNow();
    await flush();
    expect(harness.watches).toHaveLength(2);
    harness.loop.stop();
  });
});

describe("syncWatchBackoffMs", () => {
  it("spreads each step by ±20%", () => {
    expect(syncWatchBackoffMs(1, () => 0)).toBe(1_600);
    expect(syncWatchBackoffMs(1, () => 1)).toBe(2_400);
    expect(syncWatchBackoffMs(2, () => 0.5)).toBe(5_000);
    expect(syncWatchBackoffMs(99, () => 0.5)).toBe(30_000);
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay and rejects when aborted", async () => {
    await expect(abortableSleep(1, new AbortController().signal)).resolves.toBeUndefined();

    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toThrow("aborted");

    const already = new AbortController();
    already.abort();
    await expect(abortableSleep(1, already.signal)).rejects.toThrow("aborted");
  });
});
