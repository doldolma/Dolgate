import path from "node:path";
import { vi } from "vitest";
import { bytesToBase64, createTeamDek } from "@shared";
import { createInProcessScanHost } from "./replay-scan-host";
import { ReplayEventsWriter, type ReplaySegmentRecord } from "./session-replay-events";
import { TeamApiError, type RawTeamReplay, type RawTeamReplayDetail, type TeamReplayFrame } from "./team-api";
import { TeamReplayUploads } from "./team-replay-uploads";

/*
 * 시험용 가짜 팀 녹화 서버 — 올리기(TeamReplayUploads)와 보기(TeamReplayViewer)가 같은 것을 쓴다. 받은 것을 잠긴
 * 그대로 들고, 묶어 읽기는 실제 서버처럼 from 부터 limit 개까지 준다. requests 에 읽기 요청을 차례로 남긴다.
 */

export interface FakeReplay {
  authorEmail: string;
  startMeta: string;
  segments: Map<number, { info: string; data: Uint8Array }>;
  extras: Map<string, Uint8Array>;
  complete: { endMeta: string; lastSegment: number; cut: boolean } | null;
  state: RawTeamReplay["state"];
}

export function createFakeTeamReplayServer() {
  const replays = new Map<string, FakeReplay>();
  const requests: string[] = [];
  let reject: ((call: string) => Error | null) | null = null;
  const replayOf = (recordingId: string) => {
    const replay = replays.get(recordingId);
    if (!replay) {
      throw new TeamApiError(404, "team_replay_not_found", "missing");
    }
    if (replay.state === "deleted") {
      throw new TeamApiError(410, "team_replay_deleted", "deleted");
    }
    return replay;
  };
  const summary = (recordingId: string, replay: FakeReplay): RawTeamReplay => {
    const indexes = [...replay.segments.keys()];
    return {
      recordingId,
      authorUserId: "u1",
      authorEmail: replay.authorEmail,
      state: replay.state,
      segmentCount: indexes.length,
      lastSegment: indexes.length > 0 ? Math.max(...indexes) : -1,
      totalBytes: 0,
      createdAt: "2026-10-21T01:00:00.000Z",
      lastActivityAt: "2026-10-21T01:05:00.000Z",
    };
  };
  const frames = (entries: Array<[number, Uint8Array]>, from: number, limit = 256): TeamReplayFrame[] =>
    entries
      .filter(([index]) => index >= from)
      .sort((left, right) => left[0] - right[0])
      .slice(0, limit)
      .map(([index, data]) => ({ index, data }));
  const api = {
    startTeamReplay: vi.fn(async (_lease: unknown, _teamId: string, recordingId: string, startMeta: string) => {
      const failure = reject?.("start");
      if (failure) throw failure;
      const replay = replays.get(recordingId) ?? {
        authorEmail: "a@example.com",
        startMeta,
        segments: new Map(),
        extras: new Map(),
        complete: null,
        state: "live" as const,
      };
      replays.set(recordingId, replay);
      return summary(recordingId, replayOf(recordingId));
    }),
    putTeamReplaySegment: vi.fn(
      async (_lease: unknown, _teamId: string, recordingId: string, index: number, info: string, data: Uint8Array) => {
        const failure = reject?.(`segment:${index}`);
        if (failure) throw failure;
        replayOf(recordingId).segments.set(index, { info, data });
      },
    ),
    putTeamReplayExtra: vi.fn(
      async (_lease: unknown, _teamId: string, recordingId: string, kind: string, index: number, data: Uint8Array) => {
        const failure = reject?.(`${kind}:${index}`);
        if (failure) throw failure;
        replayOf(recordingId).extras.set(`${kind}:${index}`, data);
      },
    ),
    completeTeamReplay: vi.fn(
      async (
        _lease: unknown,
        _teamId: string,
        recordingId: string,
        input: { endMeta: string; lastSegment: number; cut: boolean },
      ) => {
        const failure = reject?.("complete");
        if (failure) throw failure;
        const replay = replayOf(recordingId);
        replay.complete = input;
        replay.state = replay.state === "truncated" ? "truncated" : input.cut ? "cut" : "ended";
      },
    ),
    getTeamReplay: vi.fn(async (_lease: unknown, _teamId: string, recordingId: string): Promise<RawTeamReplayDetail> => {
      requests.push("detail");
      const replay = replayOf(recordingId);
      return {
        ...summary(recordingId, replay),
        startMeta: replay.startMeta,
        endMeta: replay.complete?.endMeta,
        segments: [...replay.segments.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([index, segment]) => ({ index, info: segment.info, size: segment.data.length })),
        extras: [...replay.extras.entries()].map(([name, data]) => {
          const [kind, index] = name.split(":");
          return { kind: kind as "commands" | "snapshot", index: Number(index), size: data.length };
        }),
      };
    }),
    readTeamReplaySegments: vi.fn(
      async (_lease: unknown, _teamId: string, recordingId: string, from: number, limit?: number) => {
        requests.push(`segments:${from}+${limit ?? 256}`);
        const replay = replayOf(recordingId);
        return frames(
          [...replay.segments.entries()].map(([index, segment]) => [index, segment.data]),
          from,
          limit,
        );
      },
    ),
    readTeamReplayExtras: vi.fn(
      async (_lease: unknown, _teamId: string, recordingId: string, kind: string, from: number, limit?: number) => {
        requests.push(`${kind}:${from}+${limit ?? 256}`);
        const replay = replayOf(recordingId);
        return frames(
          [...replay.extras.entries()]
            .filter(([name]) => name.startsWith(`${kind}:`))
            .map(([name, data]) => [Number(name.split(":")[1]), data]),
          from,
          limit,
        );
      },
    ),
  };
  return {
    replays,
    requests,
    api,
    setReject: (fn: typeof reject) => {
      reject = fn;
    },
  };
}

export type FakeTeamReplayServer = ReturnType<typeof createFakeTeamReplayServer>;

export const TEST_TEAM_ID = "6f0b6a6e-6b0c-4f43-9a55-2c9b9a2f1e01";
/** 시험 팀의 키. 올리는 쪽과 보는 쪽이 같은 것을 쓴다. */
export const testTeamDek = createTeamDek();
const HISTORY = { replayMaxCount: 10, replayMaxBytes: 1 << 30, replayMaxBytesPerRecording: 1 << 28, segmentMaxBytes: 1 << 20 };
const LEASE = {
  serverUrl: "https://sync.example.com",
  accessToken: "t",
  vaultEpoch: 1,
  signal: new AbortController().signal,
  isActive: () => true,
};

/** 시험 팀을 연 접근(팀 키). */
export function testTeamAccess() {
  return { lease: LEASE, teamKeyBase64: bytesToBase64(testTeamDek) };
}

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  live: boolean;
}

/** 타이머를 손으로 울리는 녹화 올리기. */
export function createTestUploads(options: {
  server: FakeTeamReplayServer;
  stateDir: string;
  open?: () => boolean;
  active?: (recordingId: string) => boolean;
  onTruncated?: () => void;
}) {
  const timers: FakeTimer[] = [];
  const uploads = new TeamReplayUploads({
    api: options.server.api as never,
    getHistoryLimits: async () => HISTORY,
    openTeamAccess: () => ((options.open ?? (() => true))() ? testTeamAccess() : null),
    scanHost: createInProcessScanHost(),
    isRecordingActive: options.active ?? (() => false),
    onTruncated: options.onTruncated ?? (() => undefined),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, live: true };
      timers.push(timer);
      return {
        cancel: () => {
          timer.live = false;
        },
      };
    },
  });
  uploads.activate(options.stateDir);
  return {
    uploads,
    /** 아직 울리지 않은 타이머의 지연. */
    waiting: () => timers.filter((timer) => timer.live).map((timer) => timer.delayMs),
    /** 곧 울릴 타이머를 울리고 올리기가 다 돌 때까지 기다린다 — 실제 앱에서 타이머가 하는 일. */
    settle: async () => {
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.delayMs === 0);
        if (due.length === 0) {
          return;
        }
        for (const timer of due) {
          timer.live = false;
          timer.callback();
        }
        await uploads.pump();
      }
    },
  };
}

export function outputLine(atMs: number, text: string): string {
  return JSON.stringify({ type: "output", atMs, dataBase64: Buffer.from(text).toString("base64") });
}

/** 실제 녹화 쓰기로 팀 녹화 파일을 만들고, 구간이 끝날 때마다 넘겨받은 것을 돌려준다. */
export async function recordTeamSession(
  replayDir: string,
  recordingId: string,
  lines: Array<[number, string]>,
  segmentBytes = 120,
) {
  const handed: Array<{ index: number; record: ReplaySegmentRecord; data: Buffer }> = [];
  const writer = new ReplayEventsWriter(
    path.join(replayDir, `${recordingId}.events.jsonl.gz`),
    path.join(replayDir, `${recordingId}.index.jsonl`),
    { segmentBytes, onSegment: (record, index, data) => handed.push({ index, record, data }) },
  );
  for (const [atMs, text] of lines) {
    writer.append(outputLine(atMs, text), atMs, text.length);
  }
  await writer.end();
  return { handed, segments: writer.segments };
}

export const TEST_START_META = {
  sessionId: "s1",
  hostId: "team-host",
  hostLabel: "web-1",
  title: "web-1",
  connectionDetails: "app@web-1:22",
  connectionKind: "ssh",
  connectedAt: "2026-10-21T01:00:00.000Z",
  initialCols: 80,
  initialRows: 24,
};

/** 명령 둘(ls -la, uptime)이 있는 짧은 세션. */
export const TEST_SESSION: Array<[number, string]> = [
  [0, "user@host:~$ \x1b]133;B\x07"],
  [100, "ls -la\r\n\x1b]133;C\x07"],
  [150, "file-a\r\nfile-b\r\n"],
  [400, "\x1b]133;D;0\x07"],
  [410, "user@host:~$ \x1b]133;B\x07"],
  [500, "uptime\r\n\x1b]133;C\x07"],
  [600, " 10:00 up 3 days\r\n\x1b]133;D;0\x07"],
];
