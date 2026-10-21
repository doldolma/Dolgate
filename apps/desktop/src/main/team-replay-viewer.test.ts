import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveTeamReplayKey,
  openTeamReplayJson,
  sealTeamReplayBytes,
  sealTeamReplayJson,
  type SessionReplaySegment,
} from "@shared";
import { scanReplayCommands } from "../common/replay/replay-command-scan";
import { t } from "./i18n";
import { TeamApiError } from "./team-api";
import { concatReplaySegments } from "./replay-segment-groups";
import { loadReplaySegments, readReplaySegment } from "./session-replay-events";
import { TeamReplayCache } from "./team-replay-cache";
import {
  createFakeTeamReplayServer,
  createTestUploads,
  recordTeamSession,
  TEST_SESSION,
  TEST_START_META,
  TEST_TEAM_ID,
  testTeamAccess,
  testTeamDek,
  type FakeTeamReplayServer,
} from "./team-replay.test-support";
import type { TeamReplaySegmentInfo, TeamReplayStartMeta } from "./team-replay-uploads";
import { TeamReplayViewer } from "./team-replay-viewer";

const TEAM = TEST_TEAM_ID;
/** 녹화 ID 는 UUID 다(보기는 다른 꼴을 받지 않는다). */
const rec = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

/** 녹화한 사람 쪽: 세션을 녹화하며 팀에 올린다. ended 가 false 면 아직 진행 중이다. */
async function uploadSession(
  server: FakeTeamReplayServer,
  recordingId: string,
  lines: Array<[number, string]>,
  options: { ended?: boolean } = {},
) {
  const replayDir = tempDir("team-view-local-");
  const ended = options.ended ?? true;
  const { uploads, settle } = createTestUploads({ server, stateDir: tempDir("team-view-up-"), active: () => !ended });
  uploads.onRecordingStarted({ recordingId, teamId: TEAM, replayDirectoryPath: replayDir, startMeta: TEST_START_META });
  const { handed, segments } = await recordTeamSession(replayDir, recordingId, lines);
  for (const segment of handed) {
    uploads.onSegment(recordingId, segment.index, segment.record, segment.data);
  }
  if (ended) {
    const last = lines[lines.length - 1]?.[0] ?? 0;
    uploads.onRecordingEnded(recordingId, { disconnectedAt: "2026-10-21T01:10:00.000Z", durationMs: last, lastSegment: segments.length - 1 });
  }
  await settle();
  uploads.deactivate();
  return { replayDir, segments };
}

/** 보는 사람 쪽. 같은 stateDir 이면 같은 캐시를 쓴다. */
function createViewer(server: FakeTeamReplayServer, stateDir = tempDir("team-view-state-"), open = true) {
  const viewer = new TeamReplayViewer({
    api: server.api as never,
    openTeamAccess: () => (open ? testTeamAccess() : null),
    cache: new TeamReplayCache(),
  });
  viewer.activate(stateDir);
  return { viewer, stateDir };
}

/** 이 기기의 녹화 파일을 처음부터 끝까지 읽는다. */
async function readLocal(replayDir: string, recordingId: string): Promise<SessionReplaySegment> {
  const events = path.join(replayDir, `${recordingId}.events.jsonl.gz`);
  const records = await loadReplaySegments({
    events,
    legacyEvents: path.join(replayDir, `${recordingId}.events.jsonl`),
    index: path.join(replayDir, `${recordingId}.index.jsonl`),
  });
  const parts: SessionReplaySegment[] = [];
  for (const record of records) {
    parts.push(await readReplaySegment(events, record));
  }
  return concatReplaySegments(parts);
}

async function readAll(viewer: TeamReplayViewer, recordingId: string, count: number): Promise<SessionReplaySegment> {
  const parts: SessionReplaySegment[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(await viewer.readSegment(TEAM, recordingId, index));
  }
  return concatReplaySegments(parts);
}

function sameEntries(left: SessionReplaySegment, right: SessionReplaySegment) {
  return {
    atMs: [...left.atMs].join(",") === [...right.atMs].join(","),
    dataEnd: [...left.dataEnd].join(",") === [...right.dataEnd].join(","),
    data: Buffer.from(left.data).equals(Buffer.from(right.data)),
  };
}

const replayKeyOf = (recordingId: string) => deriveTeamReplayKey(testTeamDek, TEAM, recordingId);

/**
 * 스냅샷 간격(8MB)을 넘기는 큰 세션 — 구간 하나가 출력 100KB 라 묶음(512KB 안팎)은 여섯 구간이고, 스냅샷(82번 구간)은
 * 묶음 한가운데에 걸린다(묶음을 스냅샷에서 새로 시작하는지 보려면 그래야 한다).
 */
const BIG_SESSION: Array<[number, string]> = Array.from({ length: 90 }, (_value, index) => [
  index * 10,
  `${"x".repeat(100 * 1024 - 8)}${String(index).padStart(6, "0")}\r\n`,
]);

describe("TeamReplayViewer", () => {
  it("plays a team recording exactly like the recorder's local file and downloads only what is watched", async () => {
    const server = createFakeTeamReplayServer();
    const { replayDir, segments } = await uploadSession(server, rec(1), TEST_SESSION);
    const { viewer } = createViewer(server);

    const view = await viewer.load(TEAM, rec(1));
    // 열 때 받는 것은 녹화 하나와 명령 목록뿐이다 — 구간은 받지 않는다.
    expect(server.requests).toEqual(["detail", expect.stringMatching(/^commands:0\+/)]);
    expect(view).toMatchObject({
      recordingId: rec(1),
      hostLabel: "web-1",
      connectedAt: "2026-10-21T01:00:00.000Z",
      disconnectedAt: "2026-10-21T01:10:00.000Z",
      initialCols: 80,
      team: { teamId: TEAM, authorEmail: "a@example.com", state: "ended" },
    });
    // 작은 구간은 묶어 준다.
    expect(segments.length).toBeGreaterThan(1);
    expect(view.segments).toHaveLength(1);
    expect(view.segments[0]).toMatchObject({ startAtMs: 0, endAtMs: 600, entryCount: TEST_SESSION.length });

    const played = await readAll(viewer, rec(1), view.segments.length);
    expect(sameEntries(played, await readLocal(replayDir, rec(1)))).toEqual({ atMs: true, dataEnd: true, data: true });
    expect(server.requests.filter((request) => request.startsWith("segments:"))).toEqual([`segments:0+${segments.length}`]);
  });

  it("shows the command list the recorder's app made — the same as scanning the whole recording", async () => {
    const server = createFakeTeamReplayServer();
    const { replayDir } = await uploadSession(server, rec(2), TEST_SESSION);
    const { viewer } = createViewer(server);

    const view = await viewer.load(TEAM, rec(2));
    const local = await readLocal(replayDir, rec(2));
    const scanned = await scanReplayCommands({
      initialCols: 80,
      initialRows: 24,
      segments: [{ startAtMs: 0, endAtMs: 600, entryCount: local.atMs.length, outputBytes: local.data.length }],
      readSegment: async () => local,
    });
    expect(view.team?.commands).toEqual({ blocks: scanned.blocks, shellIntegrationDetected: true });
    expect(view.team?.commands?.blocks.map((block) => block.command)).toEqual(["ls -la", "uptime"]);
  });

  it("does not download again once cached, and fetches again a cached piece that no longer opens", async () => {
    const server = createFakeTeamReplayServer();
    const { replayDir } = await uploadSession(server, rec(3), TEST_SESSION);
    const stateDir = tempDir("team-view-state-");
    const first = createViewer(server, stateDir);
    const view = await first.viewer.load(TEAM, rec(3));
    await readAll(first.viewer, rec(3), view.segments.length);

    // 앱을 다시 켜 같은 녹화를 연다 — 메타만 다시 받는다.
    server.requests.length = 0;
    const second = createViewer(server, stateDir);
    await second.viewer.load(TEAM, rec(3));
    const replayed = await readAll(second.viewer, rec(3), view.segments.length);
    expect(server.requests).toEqual(["detail"]);
    expect(sameEntries(replayed, await readLocal(replayDir, rec(3))).data).toBe(true);

    // 디스크에서 캐시 조각이 바뀌었다 — 그 조각만 다시 받는다.
    writeFileSync(path.join(stateDir, "replay-cache", TEAM, rec(3), "segment-0"), Buffer.from("garbage-garbage-garbage-garbage"));
    server.requests.length = 0;
    const third = createViewer(server, stateDir);
    await third.viewer.load(TEAM, rec(3));
    const repaired = await readAll(third.viewer, rec(3), view.segments.length);
    expect(server.requests).toEqual(["detail", "segments:0+1"]);
    expect(sameEntries(repaired, await readLocal(replayDir, rec(3))).data).toBe(true);
  });

  it("jumps far with one snapshot and the segments after it, without the ones before", async () => {
    const server = createFakeTeamReplayServer();
    const { replayDir } = await uploadSession(server, rec(4), BIG_SESSION);
    const { viewer } = createViewer(server);

    const view = await viewer.load(TEAM, rec(4));
    const snapshots = view.team?.snapshots ?? [];
    expect(snapshots).toHaveLength(1);
    const [ref] = snapshots;
    // 묶음은 출력 512KB 안팎이고, 스냅샷이 걸린 구간에서 새 묶음이 시작한다 — 그 앞 묶음만 짧다.
    const beforeSnapshot = ref.segment - 1;
    expect(
      view.segments.every(
        (segment, index) => index === view.segments.length - 1 || index === beforeSnapshot || segment.outputBytes >= 512 * 1024,
      ),
    ).toBe(true);
    expect(view.segments[beforeSnapshot].outputBytes).toBeLessThan(512 * 1024);
    expect(view.segments[ref.segment].startAtMs).toBeGreaterThan(ref.atMs);
    expect(view.segments[ref.segment - 1].endAtMs).toBe(ref.atMs);

    server.requests.length = 0;
    const snapshot = await viewer.readSnapshot(TEAM, rec(4), ref.segment);
    expect(snapshot).toMatchObject({ segment: ref.segment, atMs: ref.atMs, cols: 80, rows: 24 });
    expect(snapshot?.data).toContain("xxxx");
    const segment = await viewer.readSegment(TEAM, rec(4), ref.segment);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatch(/^snapshot:\d+\+1$/);
    const firstServerSegment = Number(server.requests[0].split(":")[1].split("+")[0]);
    expect(server.requests[1]).toMatch(new RegExp(`^segments:${firstServerSegment}\\+`));
    expect(segment.atMs[0]).toBe(view.segments[ref.segment].startAtMs);

    // 묶음을 다 이으면 로컬 녹화와 같다.
    const played = await readAll(viewer, rec(4), view.segments.length);
    expect(sameEntries(played, await readLocal(replayDir, rec(4)))).toEqual({ atMs: true, dataEnd: true, data: true });
  });

  it("plays only the segments that follow on from the start", async () => {
    const server = createFakeTeamReplayServer();
    const { segments } = await uploadSession(server, rec(12), TEST_SESSION);
    expect(segments.length).toBeGreaterThan(2);
    // 가운데 구간이 빠졌다(서버가 아직 못 받았거나 잃었다) — 그 앞까지만 재생한다.
    server.replays.get(rec(12))!.segments.delete(1);
    const { viewer } = createViewer(server);

    const view = await viewer.load(TEAM, rec(12));
    expect(view.segments).toHaveLength(1);
    expect(view.segments[0]).toMatchObject({ startAtMs: 0, endAtMs: segments[0]!.endAtMs, entryCount: segments[0]!.entryCount });
    const played = await viewer.readSegment(TEAM, rec(12), 0);
    expect(played.atMs.length).toBe(segments[0]!.entryCount);
  });

  it("opens a recording still in progress up to what has arrived", async () => {
    const server = createFakeTeamReplayServer();
    const { replayDir } = await uploadSession(server, rec(5), TEST_SESSION, { ended: false });
    const { viewer } = createViewer(server);

    const view = await viewer.load(TEAM, rec(5));
    expect(view.team?.state).toBe("live");
    expect(view.durationMs).toBe(600);
    expect(view.disconnectedAt).toBe("2026-10-21T01:05:00.000Z");
    const played = await readAll(viewer, rec(5), view.segments.length);
    expect(sameEntries(played, await readLocal(replayDir, rec(5))).data).toBe(true);
  });

  it("plays a recording cut short by the per-recording limit only as long as what is in the team", async () => {
    const server = createFakeTeamReplayServer();
    server.setReject((call) => (call === "segment:2" ? new TeamApiError(413, "team_replay_too_large", "too large") : null));
    await uploadSession(server, rec(11), TEST_SESSION);
    const replay = server.replays.get(rec(11))!;
    // 서버가 한 개 최대를 넘은 녹화를 "앞부분만"으로 둔다.
    replay.state = "truncated";
    const { viewer } = createViewer(server);

    const view = await viewer.load(TEAM, rec(11));
    const key = replayKeyOf(rec(11));
    const lastInfo = openTeamReplayJson<TeamReplaySegmentInfo>(key, rec(11), "info:1", replay.segments.get(1)!.info);
    expect(view.team?.state).toBe("truncated");
    expect(view.durationMs).toBe(lastInfo.endAtMs);
    expect(view.durationMs).toBeLessThan(600);
  });

  it("asks for an update for a newer recording format and leaves out newer command lists and snapshots", async () => {
    const server = createFakeTeamReplayServer();
    await uploadSession(server, rec(6), TEST_SESSION);
    await uploadSession(server, rec(7), BIG_SESSION);
    const replay6 = server.replays.get(rec(6))!;
    const key6 = replayKeyOf(rec(6));
    const start = openTeamReplayJson<TeamReplayStartMeta>(key6, rec(6), "start", replay6.startMeta);

    // 명령 목록 한 조각이 새 형식이다 — 목록은 비우고 업데이트를 안내한다(재생은 된다).
    const commandsName = [...replay6.extras.keys()].find((name) => name.startsWith("commands:"))!;
    const commandsIndex = Number(commandsName.split(":")[1]);
    replay6.extras.set(
      commandsName,
      sealTeamReplayBytes(key6, rec(6), `commands:${commandsIndex}`, Buffer.from(JSON.stringify({ v: 2, blocks: [] }))),
    );
    const { viewer } = createViewer(server);
    const view = await viewer.load(TEAM, rec(6));
    expect(view.team?.commands).toBeNull();
    await expect(viewer.readSegment(TEAM, rec(6), 0)).resolves.toBeTruthy();

    // 스냅샷이 새 형식이면 쓰지 않는다 — 재생 창은 처음부터 그린다.
    const replay7 = server.replays.get(rec(7))!;
    const snapshotName = [...replay7.extras.keys()].find((name) => name.startsWith("snapshot:"))!;
    const snapshotIndex = Number(snapshotName.split(":")[1]);
    replay7.extras.set(
      snapshotName,
      sealTeamReplayBytes(replayKeyOf(rec(7)), rec(7), `snapshot:${snapshotIndex}`, gzipSync(JSON.stringify({ v: 2 }))),
    );
    const view7 = await viewer.load(TEAM, rec(7));
    await expect(viewer.readSnapshot(TEAM, rec(7), view7.team!.snapshots[0].segment)).resolves.toBeNull();

    // 녹화 자체가 새 형식이면 열지 않고 업데이트를 안내한다.
    replay6.startMeta = sealTeamReplayJson(key6, rec(6), "start", { ...start, v: 2 });
    await expect(createViewer(server).viewer.load(TEAM, rec(6))).rejects.toThrow(t("teamReplay.unsupported"));
  });

  it("reports damage when the server hands back altered bytes", async () => {
    const server = createFakeTeamReplayServer();
    await uploadSession(server, rec(8), TEST_SESSION);
    const segment = server.replays.get(rec(8))!.segments.get(0)!;
    segment.data = Uint8Array.from(segment.data, (byte, index) => (index === 20 ? byte ^ 0xff : byte));
    const { viewer } = createViewer(server);
    await viewer.load(TEAM, rec(8));
    await expect(viewer.readSegment(TEAM, rec(8), 0)).rejects.toThrow(t("replaySvc.damaged"));
  });

  it("forgets a team's cache, drops a removed recording's cache and waits for the team to open", async () => {
    const server = createFakeTeamReplayServer();
    await uploadSession(server, rec(9), TEST_SESSION);
    await uploadSession(server, rec(10), TEST_SESSION);
    const { viewer, stateDir } = createViewer(server);
    for (const recordingId of [rec(9), rec(10)]) {
      await viewer.load(TEAM, recordingId);
      await viewer.readSegment(TEAM, recordingId, 0);
    }
    const teamCache = path.join(stateDir, "replay-cache", TEAM);
    expect(existsSync(path.join(teamCache, rec(9), "segment-0"))).toBe(true);

    // 한도로 지워진 녹화 — 그 녹화의 캐시를 지운다.
    server.replays.get(rec(9))!.state = "deleted";
    await expect(viewer.load(TEAM, rec(9))).rejects.toThrow();
    expect(existsSync(path.join(teamCache, rec(9)))).toBe(false);
    expect(existsSync(path.join(teamCache, rec(10)))).toBe(true);

    viewer.forgetTeam(TEAM);
    expect(existsSync(teamCache)).toBe(false);

    await expect(createViewer(server, stateDir, false).viewer.load(TEAM, rec(10))).rejects.toThrow(t("teamReplay.teamNotOpen"));
    // 녹화 ID 가 아닌 값은 서버에 묻지 않고 "없음"이다.
    server.requests.length = 0;
    await expect(viewer.load(TEAM, "")).rejects.toThrow(t("teams.api.replayNotFound"));
    await expect(viewer.load(TEAM, "../replays")).rejects.toThrow(t("teams.api.replayNotFound"));
    expect(server.requests).toEqual([]);
  });
});
