import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  orderSyncPushEntries,
  planSyncPushBatches,
  pushSyncRecordsInBatches,
  resetSyncPushBatchBytes,
  SYNC_PUSH_BATCH_BYTES,
  syncPushBatchBytes,
  utf8ByteLength,
  type SyncPushSendOutcome,
  type SyncRecord,
} from "@dolssh/shared-core";

/** 본문에서 대략 size 바이트를 차지하는 레코드. */
function record(id: string, size = 100, deleted = false): SyncRecord {
  const base: SyncRecord = deleted
    ? { id, encrypted_payload: "", updated_at: "2026-11-13T00:00:00.000Z", deleted_at: "2026-11-13T00:00:00.000Z" }
    : { id, encrypted_payload: "", updated_at: "2026-11-13T00:00:00.000Z" };
  const overhead = JSON.stringify(base).length + 1;
  return deleted ? base : { ...base, encrypted_payload: "x".repeat(Math.max(0, size - overhead)) };
}

function ids(payload: Record<string, SyncRecord[]>): string[] {
  return Object.entries(payload).flatMap(([kind, records]) => records.map((item) => `${kind}:${item.id}`));
}

/** 본문이 limit 바이트를 넘으면 413 을 주는 앞단. 받은 본문을 적어 둔다. */
function proxy(limit: number) {
  const bodies: Array<{ bytes: number; ids: string[] }> = [];
  const send = vi.fn(async (payload: Record<string, SyncRecord[]>): Promise<SyncPushSendOutcome> => {
    const bytes = utf8ByteLength(JSON.stringify(payload));
    if (bytes > limit) {
      return "too-large";
    }
    bodies.push({ bytes, ids: ids(payload) });
    return "sent";
  });
  return { send, bodies };
}

beforeEach(() => {
  resetSyncPushBatchBytes();
});

describe("utf8ByteLength", () => {
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("한")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("a한😀")).toBe(new TextEncoder().encode("a한😀").length);
  });
});

describe("orderSyncPushEntries", () => {
  it("puts referenced kinds first, unknown kinds last, and deletions after upserts in reverse", () => {
    const order = orderSyncPushEntries({
      workspaces: [record("w1")],
      hostPrefs: [record("p1")],
      hosts: [record("h1"), record("h-gone", 0, true), record("h2")],
      secrets: [record("s1"), record("s-gone", 0, true)],
      hostCredentials: [record("c1")],
      portForwards: [record("f1")],
      groups: [record("g1")],
    }).map((entry) => `${entry.kind}:${entry.record.id}`);

    expect(order).toEqual([
      "secrets:s1",
      "groups:g1",
      "hosts:h1",
      "hosts:h2",
      "portForwards:f1",
      "workspaces:w1",
      // 모르는 종류는 들어온 순서대로 끝에.
      "hostPrefs:p1",
      "hostCredentials:c1",
      // 지움은 거꾸로 — 가리키는 호스트가 먼저, 가리킴을 받는 비밀값이 나중.
      "hosts:h-gone",
      "secrets:s-gone",
    ]);
  });
});

describe("planSyncPushBatches", () => {
  it("packs records up to the batch size and keeps an oversized record on its own", () => {
    const batches = planSyncPushBatches(
      { hosts: [record("a", 400), record("b", 400), record("c", 400), record("big", 5000), record("d", 400)] },
      1000,
    );
    expect(batches.map((batch) => batch.map((entry) => entry.record.id))).toEqual([["a", "b"], ["c"], ["big"], ["d"]]);
    for (const batch of batches.filter((batch) => batch.length > 1)) {
      expect(utf8ByteLength(JSON.stringify({ hosts: batch.map((entry) => entry.record) }))).toBeLessThanOrEqual(1000);
    }
  });

  it("starts at a quarter of nginx's default 1MB body limit", () => {
    expect(SYNC_PUSH_BATCH_BYTES).toBe(256 * 1024);
    // 1.1MB 볼트(호스트·비밀값 801개쯤)는 다섯 묶음이다.
    const vault = {
      hosts: Array.from({ length: 801 }, (_, n) => record(`h${n}`, 700)),
      secrets: Array.from({ length: 801 }, (_, n) => record(`s${n}`, 700)),
    };
    const batches = planSyncPushBatches(vault);
    expect(batches).toHaveLength(5);
    for (const batch of batches) {
      expect(utf8ByteLength(JSON.stringify(batch.map((entry) => entry.record)))).toBeLessThanOrEqual(SYNC_PUSH_BATCH_BYTES);
    }
  });
});

describe("pushSyncRecordsInBatches", () => {
  it("sends every batch in order and reports each one before sending the next", async () => {
    const events: string[] = [];
    const { send, bodies } = proxy(1_000_000);
    const result = await pushSyncRecordsInBatches(
      { hosts: Array.from({ length: 6 }, (_, n) => record(`h${n}`, 300)) },
      {
        serverKey: "https://a",
        send: async (payload) => {
          events.push(`send ${ids(payload).length}`);
          return send(payload);
        },
        onSent: async (entries) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          events.push(`sent ${entries.map((entry) => entry.record.id).join(",")}`);
        },
      },
    );

    expect(result).toEqual({ batches: 1, tooLarge: [] });
    expect(bodies).toHaveLength(1);
    expect(events).toEqual(["send 6", "sent h0,h1,h2,h3,h4,h5"]);
  });

  it("waits for each batch's report before sending the next one", async () => {
    const events: string[] = [];
    // 150KB 레코드는 둘이면 256KB 를 넘어 하나씩 간다 — 묶음 셋.
    await pushSyncRecordsInBatches(
      { hosts: Array.from({ length: 3 }, (_, n) => record(`h${n}`, 150 * 1024)) },
      {
        serverKey: "https://a",
        send: async (payload) => {
          events.push(`send ${ids(payload).join(",")}`);
          return "sent";
        },
        onSent: async (entries) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`sent ${entries.map((entry) => entry.record.id).join(",")}`);
        },
      },
    );
    expect(events).toEqual(["send hosts:h0", "sent h0", "send hosts:h1", "sent h1", "send hosts:h2", "sent h2"]);
  });

  it("halves the batch on 413, keeps going, and remembers the smaller size for that server only", async () => {
    // 앞단 한도 100KB — 처음 256KB 묶음은 413, 128KB 도 413, 64KB 면 들어간다.
    const records = Array.from({ length: 1000 }, (_, n) => record(`h${n}`, 500));
    const { send, bodies } = proxy(100 * 1024);
    const onSent = vi.fn();
    const result = await pushSyncRecordsInBatches({ hosts: records }, { serverKey: "https://a", send, onSent });

    expect(result.tooLarge).toEqual([]);
    expect(bodies.flatMap((body) => body.ids)).toEqual(records.map((item) => `hosts:${item.id}`));
    expect(Math.max(...bodies.map((body) => body.bytes))).toBeLessThanOrEqual(100 * 1024);
    expect(onSent).toHaveBeenCalledTimes(result.batches);
    // 256KB → 413, 128KB → 413, 64KB 부터 들어간다.
    const outcomes = await Promise.all(send.mock.results.map((call) => call.value));
    expect(outcomes.filter((value) => value === "too-large")).toHaveLength(2);
    expect(syncPushBatchBytes("https://a")).toBeLessThanOrEqual(100 * 1024);
    expect(syncPushBatchBytes("https://b")).toBe(SYNC_PUSH_BATCH_BYTES);

    // 같은 서버의 다음 올리기는 줄인 크기로 시작해 413 을 다시 겪지 않는다.
    const again = proxy(100 * 1024);
    await pushSyncRecordsInBatches({ hosts: records }, { serverKey: "https://a", send: again.send });
    const againOutcomes = await Promise.all(again.send.mock.results.map((call) => call.value));
    expect(againOutcomes.every((value) => value === "sent")).toBe(true);
  });

  it("skips a record bigger than the proxy limit and sends the rest without shrinking batches", async () => {
    // nginx 기본 1MB 앞단에 1.5MB 스니펫 하나 — 256KB 묶음에는 처음부터 혼자 들어간다.
    const { send, bodies } = proxy(1024 * 1024);
    const result = await pushSyncRecordsInBatches(
      {
        snippets: [record("small-1", 200), record("huge", 1_500_000), record("small-2", 200)],
        hosts: [record("h1", 200)],
      },
      { serverKey: "https://a", send },
    );

    expect(result.tooLarge.map((entry) => `${entry.kind}:${entry.record.id}`)).toEqual(["snippets:huge"]);
    expect(result.tooLarge[0].bytes).toBeGreaterThan(1_500_000 - 100);
    expect(bodies.flatMap((body) => body.ids)).toEqual(["snippets:small-1", "snippets:small-2", "hosts:h1"]);
    expect(send).toHaveBeenCalledTimes(3);
    // 혼자서 413 인 것은 묶음 크기를 줄이지 않는다.
    expect(syncPushBatchBytes("https://a")).toBe(SYNC_PUSH_BATCH_BYTES);
  });

  it("with a small proxy limit, halves until only the oversized record is left out", async () => {
    const { send, bodies } = proxy(10_000);
    const result = await pushSyncRecordsInBatches(
      {
        snippets: [record("small-1", 200), record("huge", 50_000), record("small-2", 200)],
        hosts: [record("h1", 200)],
      },
      { serverKey: "https://a", send },
    );

    expect(result.tooLarge.map((entry) => `${entry.kind}:${entry.record.id}`)).toEqual(["snippets:huge"]);
    expect(bodies.flatMap((body) => body.ids)).toEqual(["snippets:small-1", "snippets:small-2", "hosts:h1"]);
    expect(syncPushBatchBytes("https://a")).toBeLessThan(SYNC_PUSH_BATCH_BYTES);
  });

  it("stops on any other failure, after reporting only the batches that went in", async () => {
    const onSent = vi.fn();
    let calls = 0;
    const failure = new Error("서버 오류 (502)");
    const error = await pushSyncRecordsInBatches(
      { hosts: Array.from({ length: 30 }, (_, n) => record(`h${n}`, 20_000)) },
      {
        serverKey: "https://a",
        send: async () => {
          calls += 1;
          if (calls === 2) {
            throw failure;
          }
          return "sent";
        },
        onSent,
      },
    ).catch((caught) => caught);

    expect(error).toBe(failure);
    expect(calls).toBe(2);
    expect(onSent).toHaveBeenCalledTimes(1);
    const first = onSent.mock.calls[0][0] as Array<{ record: SyncRecord }>;
    expect(first[0].record.id).toBe("h0");
  });

  it("keeps every kind the payload had in each batch, empty ones included (same wire shape as before)", async () => {
    const bodies: Array<Record<string, SyncRecord[]>> = [];
    await pushSyncRecordsInBatches(
      { groups: [], hosts: [record("h1", 200_000), record("h2", 200_000)], secrets: [], tailnets: [] },
      {
        serverKey: "https://a",
        send: async (payload) => {
          bodies.push(payload);
          return "sent";
        },
      },
    );
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(["groups", "hosts", "secrets", "tailnets"]);
      expect(body.hosts).toHaveLength(1);
      expect(body.secrets).toEqual([]);
    }
  });

  it("sends nothing for an empty payload", async () => {
    const send = vi.fn();
    expect(await pushSyncRecordsInBatches({ hosts: [], secrets: [] }, { serverKey: "https://a", send })).toEqual({
      batches: 0,
      tooLarge: [],
    });
    expect(send).not.toHaveBeenCalled();
  });
});
