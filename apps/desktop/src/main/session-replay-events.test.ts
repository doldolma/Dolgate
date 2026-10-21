import os from "node:os";
import path from "node:path";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionReplayEntry, SessionReplaySegment } from "@shared";
import {
  decodeReplaySegment,
  indexPlainReplayEvents,
  loadReplaySegments,
  parseReplayIndex,
  readReplaySegment,
  REPLAY_SEGMENT_BYTES,
  ReplayEventsWriter,
  type ReplayEventFiles,
  type ReplaySegmentRecord,
} from "./session-replay-events";

function outputLine(atMs: number, text: string): string {
  return JSON.stringify({
    type: "output",
    atMs,
    dataBase64: Buffer.from(text).toString("base64"),
  });
}

function segmentTexts(segment: SessionReplaySegment): string[] {
  const texts: string[] = [];
  for (let index = 0; index < segment.atMs.length; index += 1) {
    if (segment.cols[index]! > 0) {
      texts.push(`resize:${segment.cols[index]}x${segment.rows[index]}`);
      continue;
    }
    const start = index === 0 ? 0 : segment.dataEnd[index - 1]!;
    texts.push(Buffer.from(segment.data.subarray(start, segment.dataEnd[index]!)).toString());
  }
  return texts;
}

async function readAllTexts(files: ReplayEventFiles): Promise<string[]> {
  const texts: string[] = [];
  for (const record of await loadReplaySegments(files)) {
    texts.push(...segmentTexts(await readReplaySegment(files.events, record)));
  }
  return texts;
}

describe("session replay events", () => {
  let tempDir: string;
  let files: ReplayEventFiles;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "dolsh-replay-events-"));
    files = {
      events: path.join(tempDir, "rec.events.jsonl.gz"),
      legacyEvents: path.join(tempDir, "rec.events.jsonl"),
      index: path.join(tempDir, "rec.index.jsonl"),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 팀 호스트 녹화는 구간을 짧게 끊어 끝나는 대로 팀에 보낸다. 넘긴 바이트는 파일 속 그 구간과 같아야 한다 —
  // 서버의 구간을 이어 붙이면 로컬 녹화 파일이 된다.
  it("cuts a segment once it is old enough and hands each finished segment over with its exact bytes", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const handed: Array<{ index: number; record: ReplaySegmentRecord; data: Buffer }> = [];
    const writer = new ReplayEventsWriter(files.events, files.index, {
      segmentMaxAgeMs: 5000,
      onSegment: (record, index, data) => handed.push({ index, record, data }),
    });
    writer.append(outputLine(0, "first"), 0, 5);
    now += 1000;
    writer.flush();
    writer.append(outputLine(1000, "second"), 1000, 6);
    now += 4000;
    // 첫 항목부터 5초 — 새 출력이 없어도 끊는다.
    writer.flush();
    writer.flush();
    writer.append(outputLine(5000, "third"), 5000, 5);
    await writer.end();

    expect(handed.map((segment) => segment.index)).toEqual([0, 1]);
    const file = readFileSync(files.events);
    for (const { record, data } of handed) {
      expect(data.equals(file.subarray(record.offset, record.offset + record.length))).toBe(true);
    }
    expect(Buffer.concat(handed.map((segment) => segment.data)).equals(file)).toBe(true);
    expect(segmentTexts(decodeReplaySegment(gunzipSync(handed[0]!.data).toString(), 0))).toEqual(["first", "second"]);
    expect(handed[1]!.record).toMatchObject({ startAtMs: 5000, entryCount: 1 });
  });

  // 구간마다 gzip 멤버를 새로 시작하고 색인에 위치를 적는다. 파일은 통째로도 풀리고, 구간만 따로도 풀린다.
  it("splits a recording into gzip members and indexes each one", async () => {
    const writer = new ReplayEventsWriter(files.events, files.index, { segmentBytes: 200 });
    const lines: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const line = outputLine(index * 10, `line ${index}\n`);
      lines.push(line);
      writer.append(line, index * 10, `line ${index}\n`.length);
    }
    await writer.end();

    const records = parseReplayIndex(
      readFileSync(files.index, "utf8"),
      statSync(files.events).size,
    );
    expect(records.length).toBeGreaterThan(5);
    expect(records).toEqual(writer.segments);
    expect(records[0]!.offset).toBe(0);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]!.offset).toBe(records[index - 1]!.offset + records[index - 1]!.length);
      expect(records[index]!.startAtMs).toBeGreaterThanOrEqual(records[index - 1]!.endAtMs);
    }
    const last = records[records.length - 1]!;
    expect(last.offset + last.length).toBe(statSync(files.events).size);
    expect(records.reduce((sum, record) => sum + record.entryCount, 0)).toBe(60);

    // 통째로 풀어도 같은 줄이 나온다(멤버를 이어 붙인 gzip).
    expect(gunzipSync(readFileSync(files.events)).toString()).toBe(`${lines.join("\n")}\n`);

    const second = await readReplaySegment(files.events, records[1]!);
    const firstCount = records[0]!.entryCount;
    expect(segmentTexts(second)[0]).toBe(`line ${firstCount}\n`);
    expect(second.atMs[0]).toBe(records[1]!.startAtMs);
    expect(await readAllTexts(files)).toEqual(
      Array.from({ length: 60 }, (_, index) => `line ${index}\n`),
    );
  });

  it("keeps members in order even when they finish compressing out of order", async () => {
    // 끊자마자 다음 멤버가 시작되므로 짧은 구간을 잔뜩 만들면 앞 멤버가 마무리되기 전에 뒤 멤버가 결과를 낸다.
    const writer = new ReplayEventsWriter(files.events, files.index, { segmentBytes: 1 });
    const expected: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const text = `${index}:${"x".repeat(index % 50)}\n`;
      expected.push(text);
      writer.append(outputLine(index, text), index, text.length);
    }
    await writer.end();

    expect(writer.segments).toHaveLength(300);
    expect(await readAllTexts(files)).toEqual(expected);
  });

  // 비정상 종료: 마지막 멤버는 마무리도 색인도 없다. 마지막으로 비운 지점까지는 읽혀야 한다.
  it("reads the unindexed end of a recording that was cut off", async () => {
    const writer = new ReplayEventsWriter(files.events, files.index, { segmentBytes: 300 });
    for (let index = 0; index < 20; index += 1) {
      writer.append(outputLine(index * 10, `row ${index}\n`), index * 10, 7);
    }
    writer.flush();
    // 비운 것이 파일에 닿을 때까지 기다렸다가 그 순간의 파일을 떠 둔다(끝내지 않은 채).
    await vi.waitFor(
      () => {
        const text = gunzipSync(readFileSync(files.events), {
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        }).toString();
        expect(text.split("\n").filter(Boolean)).toHaveLength(20);
      },
      { timeout: 3000, interval: 20 },
    );
    const crashed: ReplayEventFiles = {
      events: path.join(tempDir, "crashed.events.jsonl.gz"),
      legacyEvents: path.join(tempDir, "crashed.events.jsonl"),
      index: path.join(tempDir, "crashed.index.jsonl"),
    };
    copyFileSync(files.events, crashed.events);
    copyFileSync(files.index, crashed.index);
    await writer.end();

    const records = await loadReplaySegments(crashed);
    const indexedCount = parseReplayIndex(
      readFileSync(crashed.index, "utf8"),
      statSync(crashed.events).size,
    ).length;
    expect(records.length).toBe(indexedCount + 1);
    expect(await readAllTexts(crashed)).toEqual(
      Array.from({ length: 20 }, (_, index) => `row ${index}\n`),
    );
  });

  it("ignores index lines that point past the end of the file", () => {
    const lines = [
      JSON.stringify({ offset: 0, length: 10, startAtMs: 0, endAtMs: 5, entryCount: 2, outputBytes: 4 }),
      JSON.stringify({ offset: 10, length: 50, startAtMs: 5, endAtMs: 9, entryCount: 1, outputBytes: 1 }),
    ];
    expect(parseReplayIndex(lines.join("\n"), 30)).toHaveLength(1);
    expect(parseReplayIndex(`${lines[0]}\n{broken\n${lines[1]}`, 100)).toHaveLength(1);
  });

  // 색인 없이 gzip 하나로 쓰던 녹화. 처음 열 때 구간을 나눠 다시 쓰고 색인을 만든다.
  it("rewrites an older single-stream recording into indexed segments", async () => {
    const lines: string[] = [];
    let size = 0;
    for (let index = 0; size < REPLAY_SEGMENT_BYTES * 2.5; index += 1) {
      const line = outputLine(index, `${index} ${"y".repeat(2000)}\n`);
      lines.push(line);
      size += line.length + 1;
    }
    writeFileSync(files.events, gzipSync(`${lines.join("\n")}\n`));

    const records = await loadReplaySegments(files);

    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(existsSync(files.index)).toBe(true);
    expect(existsSync(`${files.events}.tmp`)).toBe(false);
    expect(existsSync(`${files.index}.tmp`)).toBe(false);
    expect(records.reduce((sum, record) => sum + record.entryCount, 0)).toBe(lines.length);
    const texts = await readAllTexts(files);
    expect(texts).toHaveLength(lines.length);
    expect(texts[lines.length - 1]).toBe(`${lines.length - 1} ${"y".repeat(2000)}\n`);
    // 두 번째로 열 때는 색인을 그대로 쓴다.
    expect(await loadReplaySegments(files)).toEqual(records);
  });

  it("rewrites a plain-text legacy recording and removes the old file", async () => {
    writeFileSync(
      files.legacyEvents,
      `${outputLine(5, "legacy")}\n${JSON.stringify({ type: "resize", atMs: 7, cols: 90, rows: 20 })}\n`,
    );

    expect(await readAllTexts(files)).toEqual(["legacy", "resize:90x20"]);
    expect(existsSync(files.legacyEvents)).toBe(false);
    expect(existsSync(files.events)).toBe(true);
  });

  // 폴더에 쓸 수 없으면(권한·디스크 공간) 옛 녹화를 바꿔 쓰지 못한다. 그래도 원래 파일을 그대로 읽어 연다 —
  // 바꿔 써야만 열게 되면서 원문 오류(EACCES·ENOSPC)로 열리지 않았다(실측).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reads a legacy recording in place when the folder cannot be written",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const lines = [
        outputLine(5, "가나다"),
        JSON.stringify({ type: "resize", atMs: 7, cols: 90, rows: 20 }),
        "not json",
        outputLine(3, "back"),
        outputLine(9, "last"),
      ];
      writeFileSync(files.legacyEvents, `${lines.join("\n")}\n`);
      chmodSync(tempDir, 0o555);
      try {
        const records = await loadReplaySegments(files);
        expect(records.every((record) => record.plain === true)).toBe(true);
        const texts: string[] = [];
        const times: number[] = [];
        for (const record of records) {
          const segment = await readReplaySegment(files.legacyEvents, record);
          texts.push(...segmentTexts(segment));
          times.push(...Array.from(segment.atMs));
        }
        expect(texts).toEqual(["가나다", "resize:90x20", "back", "last"]);
        // 시각은 바꿔 쓸 때와 같이 앞보다 작아지지 않는다.
        expect(times).toEqual([5, 7, 7, 9]);
      } finally {
        chmodSync(tempDir, 0o755);
      }
      expect(existsSync(files.legacyEvents)).toBe(true);
      expect(existsSync(`${files.events}.tmp`)).toBe(false);
      expect(existsSync(files.events)).toBe(false);
    },
  );

  // 구간은 새 녹화와 같은 기준(JSON 줄의 양)으로 나뉘고, 각 구간은 그 파일의 줄 경계에서 읽힌다.
  it("indexes a plain legacy recording into line-aligned segments", async () => {
    const lines = Array.from({ length: 50 }, (_, index) => outputLine(index * 10, `line-${index}\n`));
    writeFileSync(files.legacyEvents, lines.join("\n"));
    const records = await indexPlainReplayEvents(files.legacyEvents, 400);
    expect(records.length).toBeGreaterThan(1);
    expect(records.reduce((sum, record) => sum + record.entryCount, 0)).toBe(50);
    const texts: string[] = [];
    for (const record of records) {
      texts.push(...segmentTexts(await readReplaySegment(files.legacyEvents, record)));
    }
    expect(texts).toEqual(lines.map((_, index) => `line-${index}\n`));
  });

  // 푸는 중에 압축 오류가 나면 거기까지 풀린 것도 쓰지 않는다 — 깨진 데이터는 오류 전에 가짜 줄로 풀려 나온다.
  it("refuses to rewrite a damaged recording and leaves it as it was", async () => {
    const lines = Array.from({ length: 2000 }, (_, index) =>
      outputLine(index, `${index}:${index.toString(36).repeat(6)}\n`),
    );
    const compressed = gzipSync(`${lines.join("\n")}\n`);
    // 가운데 블록 하나를 망가뜨린다: deflate 블록 종류 3(없는 종류)이 되게 한다.
    const middle = Math.floor(compressed.length / 2);
    compressed.fill(0x07, middle, middle + 64);
    writeFileSync(files.events, compressed);

    await expect(loadReplaySegments(files)).rejects.toMatchObject({
      code: expect.stringMatching(/^Z_/),
    });
    expect(readFileSync(files.events).equals(compressed)).toBe(true);
    expect(existsSync(files.index)).toBe(false);
    expect(existsSync(`${files.events}.tmp`)).toBe(false);
    expect(existsSync(`${files.index}.tmp`)).toBe(false);
  });

  // 녹화 하나의 구간 하나가 깨져도 그 구간만 못 읽는다(멤버마다 따로 검사된다).
  it("fails only the damaged segment of an indexed recording", async () => {
    const writer = new ReplayEventsWriter(files.events, files.index, { segmentBytes: 200 });
    for (let index = 0; index < 30; index += 1) {
      writer.append(outputLine(index, `seg ${index}\n`), index, 6);
    }
    await writer.end();
    const records = await loadReplaySegments(files);
    const damaged = readFileSync(files.events);
    const target = records[1]!;
    for (let index = target.offset + 12; index < target.offset + target.length - 8; index += 1) {
      damaged[index] = 0xff;
    }
    writeFileSync(files.events, damaged);

    await expect(readReplaySegment(files.events, target)).rejects.toThrow();
    expect(segmentTexts(await readReplaySegment(files.events, records[2]!))[0]).toMatch(/^seg /);
  });

  it("leaves the recording alone when it cannot be read at all", async () => {
    // 파일을 열 수 없는 경우(여기서는 같은 이름의 폴더). 압축이 깨진 것과 달리 바꿔 쓰지 않는다.
    mkdirSync(files.events);

    await expect(loadReplaySegments(files)).rejects.toThrow();
    expect(existsSync(files.events)).toBe(true);
    expect(existsSync(`${files.events}.tmp`)).toBe(false);
    expect(existsSync(`${files.index}.tmp`)).toBe(false);
  });

  // 녹화 중 시스템 시계가 뒤로 가면 시각이 줄어든다. 재생은 항목이 시각 순서라고 믿으므로 앞 항목에 맞춘다.
  it("never lets entry times go backwards", async () => {
    const segment = decodeReplaySegment(
      [outputLine(100, "a"), outputLine(50, "b"), outputLine(120, "c")].join("\n"),
      90,
    );
    expect(Array.from(segment.atMs)).toEqual([100, 100, 120]);

    writeFileSync(
      files.events,
      gzipSync([outputLine(100, "a"), outputLine(50, "b"), outputLine(120, "c")].join("\n")),
    );
    const records = await loadReplaySegments(files);
    expect(records[0]).toMatchObject({ startAtMs: 100, endAtMs: 120, entryCount: 3 });
    const converted = await readReplaySegment(files.events, records[0]!);
    expect(Array.from(converted.atMs)).toEqual([100, 100, 120]);
  });

  it("drops lines it does not understand", () => {
    const segment = decodeReplaySegment(
      [
        "not json",
        JSON.stringify({ type: "output", atMs: 1 }),
        JSON.stringify({ type: "resize", atMs: 2, cols: 0, rows: 10 }),
        JSON.stringify({ type: "resize", atMs: 3, cols: 80, rows: 24 }),
        outputLine(4, "ok"),
        "",
      ].join("\n"),
      0,
    );
    expect(segmentTexts(segment)).toEqual(["resize:80x24", "ok"]);
  });

  it("sizes the output buffer exactly instead of sharing a pooled one", () => {
    const segment = decodeReplaySegment(outputLine(0, "tiny"), 0);
    expect(segment.data.byteLength).toBe(4);
    expect(segment.data.buffer.byteLength).toBe(4);
  });

  it("reports a write failure once and stops", async () => {
    const onError = vi.fn();
    const writer = new ReplayEventsWriter(files.events, files.index, { onError });
    writer.append(outputLine(0, "a"), 0, 1);
    // 압축기 뒤의 파일 스트림이 실패한 것과 같게 한다.
    (writer as unknown as { file: { destroy: (error: Error) => void } }).file.destroy(
      new Error("disk full"),
    );
    await writer.end();
    writer.append(outputLine(1, "b"), 1, 1);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(writer.failed).toBe(true);
  });
});
