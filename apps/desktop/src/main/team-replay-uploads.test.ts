import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTeamReplayKey, openTeamReplayBytes, openTeamReplayJson } from "@shared";
import { decodeReplaySegment, ReplayEventsWriter } from "./session-replay-events";
import { TeamApiError } from "./team-api";
import {
  createFakeTeamReplayServer,
  createTestUploads,
  outputLine,
  recordTeamSession,
  TEST_SESSION,
  TEST_START_META,
  TEST_TEAM_ID,
  testTeamDek,
  type FakeReplay,
} from "./team-replay.test-support";
import {
  type TeamReplayCommandsPiece,
  type TeamReplayEndMeta,
  type TeamReplaySegmentInfo,
  type TeamReplaySnapshotPiece,
  type TeamReplayStartMeta,
} from "./team-replay-uploads";

const TEAM = TEST_TEAM_ID;
const teamDek = testTeamDek;
const createServer = createFakeTeamReplayServer;
const createUploads = createTestUploads;
const START = TEST_START_META;
const SESSION = TEST_SESSION;

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function openServerReplay(replay: FakeReplay, recordingId: string) {
  const key = deriveTeamReplayKey(teamDek, TEAM, recordingId);
  const indexes = [...replay.segments.keys()].sort((left, right) => left - right);
  return {
    start: openTeamReplayJson<TeamReplayStartMeta>(key, recordingId, "start", replay.startMeta),
    end: replay.complete ? openTeamReplayJson<TeamReplayEndMeta>(key, recordingId, "end", replay.complete.endMeta) : null,
    infos: indexes.map((index) => openTeamReplayJson<TeamReplaySegmentInfo>(key, recordingId, `info:${index}`, replay.segments.get(index)!.info)),
    bytes: Buffer.concat(
      indexes.map((index) => openTeamReplayBytes(key, recordingId, `segment:${index}`, replay.segments.get(index)!.data)),
    ),
    commands: [...replay.extras.entries()]
      .filter(([name]) => name.startsWith("commands:"))
      .map(([name, data]) => JSON.parse(Buffer.from(openTeamReplayBytes(key, recordingId, name as `commands:${number}`, data)).toString()) as TeamReplayCommandsPiece),
    snapshots: [...replay.extras.entries()]
      .filter(([name]) => name.startsWith("snapshot:"))
      .map(([name, data]) => JSON.parse(gunzipSync(openTeamReplayBytes(key, recordingId, name as `snapshot:${number}`, data)).toString()) as TeamReplaySnapshotPiece),
  };
}

/** 구간별로 받은 명령을 id 로 합친다 — 보는 쪽이 하는 일. */
function mergeCommands(pieces: TeamReplayCommandsPiece[]): Array<string | null> {
  const byId = new Map<number, string | null>();
  for (const piece of pieces) {
    for (const block of piece.blocks) {
      byId.set(block.id, block.command);
    }
  }
  return [...byId.entries()].sort((left, right) => left[0] - right[0]).map(([, command]) => command);
}

describe("TeamReplayUploads", () => {
  it("sends each finished segment, the commands it saw and the end — the server copy is the local file", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    let recording = true;
    const { uploads, settle } = createUploads({ server, stateDir: tempDir("team-replay-state-"), active: () => recording });
    uploads.onRecordingStarted({ recordingId: "rec-1", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    const { handed, segments } = await recordTeamSession(replayDir, "rec-1", SESSION);
    for (const segment of handed) {
      uploads.onSegment("rec-1", segment.index, segment.record, segment.data);
    }
    await settle();
    expect(server.replays.get("rec-1")?.segments.size).toBe(segments.length);
    expect(server.replays.get("rec-1")?.complete).toBeNull();
    expect(uploads.isPending("rec-1")).toBe(true);

    recording = false;
    uploads.onRecordingEnded("rec-1", { disconnectedAt: "2026-10-21T01:10:00.000Z", durationMs: 600, lastSegment: segments.length - 1 });
    await settle();

    const replay = server.replays.get("rec-1")!;
    const opened = openServerReplay(replay, "rec-1");
    expect(opened.start).toMatchObject({ v: 1, format: "jsonl-gzip-v1", hostLabel: "web-1", initialCols: 80 });
    expect(opened.bytes.equals(readFileSync(path.join(replayDir, "rec-1.events.jsonl.gz")))).toBe(true);
    expect(opened.infos.map((info) => info.startAtMs)).toEqual(segments.map((segment) => segment.startAtMs));
    expect(opened.end).toMatchObject({ lastSegment: segments.length - 1, cut: false, durationMs: 600 });
    expect(replay.complete?.cut).toBe(false);
    expect(mergeCommands(opened.commands)).toEqual(["ls -la", "uptime"]);
    expect(uploads.isPending("rec-1")).toBe(false);
  });

  it("reads the segments it had not sent from the file after a restart", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    const stateDir = tempDir("team-replay-state-");
    const first = createUploads({ server, stateDir, active: () => true });
    first.uploads.onRecordingStarted({ recordingId: "rec-2", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    const { handed, segments } = await recordTeamSession(replayDir, "rec-2", SESSION);
    // 두 구간을 보내고 네트워크가 끊겼다.
    server.setReject((call) => (call === "segment:2" ? new TypeError("fetch failed") : null));
    for (const segment of handed) {
      first.uploads.onSegment("rec-2", segment.index, segment.record, segment.data);
    }
    first.uploads.onRecordingEnded("rec-2", { disconnectedAt: "2026-10-21T01:10:00.000Z", durationMs: 600, lastSegment: segments.length - 1 });
    await first.settle();
    expect(server.replays.get("rec-2")?.segments.size).toBe(2);
    expect(first.waiting()).toEqual([2000]);
    first.uploads.deactivate();

    // 앱을 다시 켰다 — 남은 구간은 파일에서 읽어 보낸다.
    server.setReject(null);
    server.api.putTeamReplaySegment.mockClear();
    const second = createUploads({ server, stateDir });
    await second.settle();
    const replay = server.replays.get("rec-2")!;
    expect(server.api.putTeamReplaySegment.mock.calls.map((call) => call[3])).toEqual(
      Array.from({ length: segments.length - 2 }, (_value, index) => index + 2),
    );
    const opened = openServerReplay(replay, "rec-2");
    expect(opened.bytes.equals(readFileSync(path.join(replayDir, "rec-2.events.jsonl.gz")))).toBe(true);
    expect(replay.complete?.lastSegment).toBe(segments.length - 1);
    expect(mergeCommands(opened.commands)).toEqual(["ls -la", "uptime"]);
    expect(second.uploads.isPending("rec-2")).toBe(false);
  });

  it("does not send a segment's commands twice after a restart", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    const stateDir = tempDir("team-replay-state-");
    const first = createUploads({ server, stateDir, active: () => true });
    first.uploads.onRecordingStarted({ recordingId: "rec-2b", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    const { handed, segments } = await recordTeamSession(replayDir, "rec-2b", SESSION);
    // 구간은 다 갔고, 셋째 구간부터의 덧붙임을 보내다 끊겼다.
    server.setReject((call) => (/^(commands|snapshot):(\d+)$/.exec(call) && Number(call.split(":")[1]) >= 2 ? new TypeError("fetch failed") : null));
    for (const segment of handed) {
      first.uploads.onSegment("rec-2b", segment.index, segment.record, segment.data);
    }
    first.uploads.onRecordingEnded("rec-2b", { disconnectedAt: "x", durationMs: 600, lastSegment: segments.length - 1 });
    await first.settle();
    const sentBefore = server.api.putTeamReplayExtra.mock.calls.map((call) => `${call[3]}:${call[4]}`);
    expect(sentBefore.length).toBeGreaterThan(0);
    first.uploads.deactivate();

    server.setReject(null);
    server.api.putTeamReplayExtra.mockClear();
    server.api.putTeamReplaySegment.mockClear();
    const second = createUploads({ server, stateDir });
    await second.settle();
    const sentAfter = server.api.putTeamReplayExtra.mock.calls.map((call) => `${call[3]}:${call[4]}`);
    expect(sentAfter.length).toBeGreaterThan(0);
    expect(sentAfter.every((name) => Number(name.split(":")[1]) >= 2)).toBe(true);
    expect(server.api.putTeamReplaySegment).not.toHaveBeenCalled();
    expect(mergeCommands(openServerReplay(server.replays.get("rec-2b")!, "rec-2b").commands)).toEqual(["ls -la", "uptime"]);
  });

  it("finishes a recording whose app died, up to what the file holds, as cut", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    const stateDir = tempDir("team-replay-state-");
    const crashed = createUploads({ server, stateDir, open: () => false, active: () => true });
    crashed.uploads.onRecordingStarted({ recordingId: "rec-3", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    // 끝을 알리기 전에 앱이 죽었다 — 마지막 멤버는 색인에 오르지 못했다.
    const indexed = await recordTeamSession(replayDir, "rec-3", SESSION.slice(0, 4));
    const events = path.join(replayDir, "rec-3.events.jsonl.gz");
    const tailWriter = new ReplayEventsWriter(path.join(replayDir, "tail.events.jsonl.gz"), path.join(replayDir, "tail.index.jsonl"));
    for (const [atMs, text] of SESSION.slice(4)) {
      tailWriter.append(outputLine(atMs, text), atMs, text.length);
    }
    await tailWriter.end();
    writeFileSync(events, Buffer.concat([readFileSync(events), readFileSync(path.join(replayDir, "tail.events.jsonl.gz"))]));
    await crashed.settle();
    expect(server.api.startTeamReplay).not.toHaveBeenCalled();
    crashed.uploads.deactivate();

    const restarted = createUploads({ server, stateDir });
    await restarted.settle();
    const replay = server.replays.get("rec-3")!;
    expect(replay.complete).toMatchObject({ cut: true, lastSegment: indexed.segments.length });
    const opened = openServerReplay(replay, "rec-3");
    expect(opened.end).toMatchObject({ cut: true, lastSegment: indexed.segments.length, durationMs: 600 });
    const decoded = decodeReplaySegment(gunzipSync(opened.bytes).toString(), 0);
    expect([...decoded.atMs]).toEqual(SESSION.map(([atMs]) => atMs));
    expect(mergeCommands(opened.commands)).toEqual(["ls -la", "uptime"]);
    expect(restarted.uploads.isPending("rec-3")).toBe(false);
  });

  it("waits while the team is not open and goes once it opens", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    let open = false;
    const { uploads, settle, waiting } = createUploads({ server, stateDir: tempDir("team-replay-state-"), open: () => open });
    uploads.onRecordingStarted({ recordingId: "rec-4", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    const { handed, segments } = await recordTeamSession(replayDir, "rec-4", SESSION.slice(0, 2));
    for (const segment of handed) {
      uploads.onSegment("rec-4", segment.index, segment.record, segment.data);
    }
    uploads.onRecordingEnded("rec-4", { disconnectedAt: "x", durationMs: 100, lastSegment: segments.length - 1 });
    await settle();
    expect(server.api.startTeamReplay).not.toHaveBeenCalled();
    expect(uploads.isPending("rec-4")).toBe(true);
    // 기다리는 동안 다시 해 보지 않는다 — 팀이 열리면 kick 이 깨운다.
    expect(waiting()).toEqual([]);
    open = true;
    uploads.kick();
    await settle();
    expect(server.replays.get("rec-4")?.complete).not.toBeNull();
    expect(uploads.isPending("rec-4")).toBe(false);
  });

  it("keeps only the beginning in the team when the recording goes over the per-recording limit", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    const onTruncated = vi.fn();
    const { uploads, settle } = createUploads({ server, stateDir: tempDir("team-replay-state-"), onTruncated });
    uploads.onRecordingStarted({ recordingId: "rec-5", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    const { handed, segments } = await recordTeamSession(replayDir, "rec-5", SESSION);
    server.setReject((call) => (call === "segment:1" ? new TeamApiError(413, "team_replay_too_large", "too large") : null));
    for (const segment of handed) {
      uploads.onSegment("rec-5", segment.index, segment.record, segment.data);
    }
    uploads.onRecordingEnded("rec-5", { disconnectedAt: "x", durationMs: 600, lastSegment: segments.length - 1 });
    await settle();
    const replay = server.replays.get("rec-5")!;
    expect(onTruncated).toHaveBeenCalledTimes(1);
    expect(onTruncated).toHaveBeenCalledWith(expect.objectContaining({ recordingId: "rec-5", teamId: TEAM }));
    expect([...replay.segments.keys()]).toEqual([0]);
    expect(replay.complete).toMatchObject({ lastSegment: 0 });
    expect(openServerReplay(replay, "rec-5").end).toMatchObject({ lastSegment: 0 });
    expect(uploads.isPending("rec-5")).toBe(false);
  });

  it("waits a minute when the team's recording space is full of live recordings", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    const { uploads, settle, waiting } = createUploads({ server, stateDir: tempDir("team-replay-state-"), active: () => true });
    uploads.onRecordingStarted({ recordingId: "rec-6", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    const { handed } = await recordTeamSession(replayDir, "rec-6", SESSION.slice(0, 2));
    server.setReject((call) => (call.startsWith("segment:") ? new TeamApiError(409, "team_replay_quota_busy", "busy") : null));
    uploads.onSegment("rec-6", 0, handed[0]!.record, handed[0]!.data);
    await settle();
    expect(waiting()).toEqual([60_000]);
    expect(uploads.isPending("rec-6")).toBe(true);
  });

  it("drops a forgotten team's recordings and those the server already removed", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    const stateDir = tempDir("team-replay-state-");
    const closed = createUploads({ server, stateDir, open: () => false });
    closed.uploads.onRecordingStarted({ recordingId: "rec-7", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    closed.uploads.forgetTeam(TEAM);
    expect(closed.uploads.isPending("rec-7")).toBe(false);
    closed.uploads.deactivate();
    // 다시 켜도 돌아오지 않는다.
    expect(createUploads({ server, stateDir }).uploads.isPending("rec-7")).toBe(false);

    const open = createUploads({ server, stateDir: tempDir("team-replay-state-"), active: () => true });
    open.uploads.onRecordingStarted({ recordingId: "rec-8", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    server.setReject((call) => (call === "start" ? new TeamApiError(410, "team_replay_deleted", "gone") : null));
    await open.settle();
    expect(open.uploads.isPending("rec-8")).toBe(false);
    expect(open.waiting()).toEqual([]);
  });

  // 보내는 동안 다른 세션이 시작하면, 그 녹화는 이번 차례가 시작할 때 고른 목록에 없다. 그 사이 불린 pump 가 한
  // 번 더 돌아야 같은 차례 안에 보낸다(안 그러면 다음 구간이 끝날 때까지 기다린다).
  it("takes up a recording that started while it was sending, in the same run", async () => {
    const server = createServer();
    const firstDir = tempDir("team-replay-local-");
    const secondDir = tempDir("team-replay-local-");
    const { uploads } = createUploads({ server, stateDir: tempDir("team-replay-state-"), active: () => true });
    uploads.onRecordingStarted({ recordingId: "rec-13", teamId: TEAM, replayDirectoryPath: firstDir, startMeta: START });
    const first = await recordTeamSession(firstDir, "rec-13", SESSION.slice(0, 2));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = server.api.putTeamReplaySegment.getMockImplementation()!;
    server.api.putTeamReplaySegment.mockImplementationOnce(async (...args: Parameters<typeof put>) => {
      await held;
      return put(...args);
    });
    uploads.onSegment("rec-13", 0, first.handed[0]!.record, first.handed[0]!.data);
    const run = uploads.pump();
    await vi.waitFor(() => expect(server.api.putTeamReplaySegment).toHaveBeenCalledTimes(1));

    uploads.onRecordingStarted({ recordingId: "rec-14", teamId: TEAM, replayDirectoryPath: secondDir, startMeta: START });
    const second = await recordTeamSession(secondDir, "rec-14", SESSION.slice(0, 2));
    uploads.onSegment("rec-14", 0, second.handed[0]!.record, second.handed[0]!.data);
    // 타이머가 하는 일 — 도는 중이면 같은 약속을 돌려주고 끝난 뒤 한 번 더 돈다.
    expect(uploads.pump()).toBe(run);
    release();
    await run;
    expect(server.replays.get("rec-14")?.segments.size).toBeGreaterThan(0);
  });

  it("sends snapshots so a viewer can jump without the whole recording", async () => {
    const server = createServer();
    const replayDir = tempDir("team-replay-local-");
    const { uploads, settle } = createUploads({ server, stateDir: tempDir("team-replay-state-") });
    uploads.onRecordingStarted({ recordingId: "rec-9", teamId: TEAM, replayDirectoryPath: replayDir, startMeta: START });
    // 스냅샷 간격(8MB)을 넘길 만큼 출력한다.
    const block = "x".repeat(64 * 1024) + "\r\n";
    const lines: Array<[number, string]> = Array.from({ length: 140 }, (_value, index) => [index * 10, block]);
    const { handed, segments } = await recordTeamSession(replayDir, "rec-9", lines);
    for (const segment of handed) {
      uploads.onSegment("rec-9", segment.index, segment.record, segment.data);
    }
    uploads.onRecordingEnded("rec-9", { disconnectedAt: "x", durationMs: 1390, lastSegment: segments.length - 1 });
    await settle();
    const opened = openServerReplay(server.replays.get("rec-9")!, "rec-9");
    expect(opened.snapshots).toHaveLength(1);
    const { snapshot } = opened.snapshots[0]!;
    // 스냅샷은 앞 구간까지 다 그린 화면이다(재생 창이 뜨는 스냅샷과 같다) — 재생기는 그 구간의 첫 항목부터 잇는다.
    expect(snapshot.atMs).toBe(segments[snapshot.segment - 1]!.endAtMs);
    expect(snapshot.data).toContain("xxxx");
  });
});
