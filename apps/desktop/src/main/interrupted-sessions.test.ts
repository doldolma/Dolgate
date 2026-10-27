import { describe, expect, it, vi } from "vitest";
import type { ActivityLogRecord } from "@shared";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dolgate-test-user-data", isPackaged: false },
}));

import { closeInterruptedSessions } from "./interrupted-sessions";

const REASON = "앱이 꺼져 끊겼습니다.";
const STARTED = Date.parse("2026-10-26T09:00:00.000Z");
const BEFORE = "2026-10-26T08:00:00.000Z";
const AFTER = "2026-10-26T09:00:05.000Z";

function row(id: string, kind: ActivityLogRecord["kind"], createdAt: string, metadata: Record<string, unknown>): ActivityLogRecord {
  return {
    id,
    level: "info",
    category: "session",
    kind,
    message: id,
    metadata,
    createdAt,
    updatedAt: createdAt,
  } as ActivityLogRecord;
}

function session(id: string, createdAt: string, extra: Record<string, unknown> = {}): ActivityLogRecord {
  return row(id, "session-lifecycle", createdAt, {
    sessionId: id,
    hostId: "host-1",
    hostLabel: "prod-web",
    title: "prod-web",
    connectionDetails: "10.0.0.5 · 22 · ops",
    connectionKind: "ssh",
    connectedAt: createdAt,
    disconnectedAt: null,
    durationMs: null,
    status: "connected",
    disconnectReason: null,
    recordingId: null,
    hasReplay: false,
    ...extra,
  });
}

function sweep(records: ActivityLogRecord[], recovered: Record<string, { disconnectedAt: string; durationMs: number }> = {}) {
  const upsertMany = vi.fn();
  const recover = vi.fn((recording: { recordingId: string }) => recovered[recording.recordingId] ?? null);
  const result = closeInterruptedSessions({
    logs: { list: () => records, upsertMany },
    recordings: { recoverInterruptedRecording: recover },
    startedBeforeMs: STARTED,
  });
  const written = new Map<string, ActivityLogRecord>(
    (upsertMany.mock.calls[0]?.[0] ?? []).map((record: ActivityLogRecord) => [record.id, record]),
  );
  return { result, upsertMany, recover, written };
}

describe("closeInterruptedSessions", () => {
  it("closes the rows an earlier run left open, in one write", () => {
    const { result, upsertMany, written } = sweep([
      session("s-open", BEFORE),
      row("pf-open", "port-forward-lifecycle", BEFORE, { ruleId: "r1", hostId: "host-1", startedAt: BEFORE, status: "running" }),
      row("sftp-connecting", "sftp-lifecycle", BEFORE, { endpointId: "e1", hostId: "host-1", startedAt: BEFORE, status: "connecting" }),
      row("ct-open", "container-lifecycle", BEFORE, { lifecycleId: "c1", hostId: "host-1", startedAt: BEFORE, status: "connected" }),
    ]);

    expect(result).toEqual({ closed: 4, recoveredRecordings: 0 });
    expect(upsertMany).toHaveBeenCalledTimes(1);
    // 끝 시각을 모르면 비워 둔다 — 지어내지 않는다.
    expect(written.get("s-open")?.metadata).toMatchObject({
      status: "closed",
      disconnectedAt: null,
      durationMs: null,
      disconnectReason: REASON,
      hasReplay: false,
    });
    expect(written.get("pf-open")?.metadata).toMatchObject({ status: "closed", stoppedAt: null, durationMs: null, endReason: REASON });
    expect(written.get("sftp-connecting")?.metadata).toMatchObject({ status: "closed", endedAt: null, durationMs: null, endReason: REASON });
    expect(written.get("ct-open")?.metadata).toMatchObject({ status: "closed", endedAt: null, durationMs: null, endReason: REASON });
    // 줄의 자리(시작 시각)는 그대로다.
    expect(written.get("s-open")?.createdAt).toBe(BEFORE);
  });

  it("ends a recorded session where its recording ends, and turns its Replay back on", () => {
    const { result, recover, written } = sweep(
      [session("s-recorded", BEFORE, { recordingId: "rec-1", hasReplay: false })],
      { "rec-1": { disconnectedAt: "2026-10-26T08:30:00.000Z", durationMs: 1_800_000 } },
    );

    expect(result).toEqual({ closed: 1, recoveredRecordings: 1 });
    expect(recover).toHaveBeenCalledWith({
      recordingId: "rec-1",
      sessionId: "s-recorded",
      hostId: "host-1",
      hostLabel: "prod-web",
      title: "prod-web",
      connectionDetails: "10.0.0.5 · 22 · ops",
      connectionKind: "ssh",
      connectedAt: BEFORE,
    });
    expect(written.get("s-recorded")).toMatchObject({
      updatedAt: "2026-10-26T08:30:00.000Z",
      metadata: {
        status: "closed",
        disconnectedAt: "2026-10-26T08:30:00.000Z",
        durationMs: 1_800_000,
        disconnectReason: REASON,
        hasReplay: true,
      },
    });
  });

  it("leaves rows of this run, ended rows and other logs alone", () => {
    const { result, upsertMany, recover } = sweep([
      // 로그인하며 옮겨 온, 이 실행에서 지금 열려 있는 세션.
      session("s-this-run", AFTER, { recordingId: "rec-live" }),
      session("s-ended", BEFORE, { status: "closed", disconnectedAt: BEFORE }),
      row("pf-ended", "port-forward-lifecycle", BEFORE, { ruleId: "r1", hostId: "host-1", startedAt: BEFORE, status: "error" }),
      row("generic", "generic", BEFORE, { status: "connected" }),
    ]);

    expect(result).toEqual({ closed: 0, recoveredRecordings: 0 });
    expect(upsertMany).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });
});
