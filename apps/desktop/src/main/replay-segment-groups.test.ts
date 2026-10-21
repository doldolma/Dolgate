import { describe, expect, it } from "vitest";
import type { SessionReplaySegment, SessionReplaySegmentInfo } from "@shared";
import {
  concatReplaySegments,
  groupedSegmentInfo,
  groupReplaySegments,
  REPLAY_GROUP_MAX_SEGMENTS,
} from "./replay-segment-groups";

function info(startAtMs: number, outputBytes: number): SessionReplaySegmentInfo {
  return { startAtMs, endAtMs: startAtMs + 5, entryCount: 2, outputBytes };
}

describe("groupReplaySegments", () => {
  it("joins small segments up to about 512KB of output", () => {
    const infos = Array.from({ length: 10 }, (_value, index) => info(index * 10, 200 * 1024));
    expect(groupReplaySegments(infos)).toEqual([
      { first: 0, last: 2 },
      { first: 3, last: 5 },
      { first: 6, last: 8 },
      { first: 9, last: 9 },
    ]);
    expect(groupedSegmentInfo(infos, { first: 3, last: 5 })).toEqual({
      startAtMs: 30,
      endAtMs: 55,
      entryCount: 6,
      outputBytes: 600 * 1024,
    });
  });

  it("leaves big segments alone", () => {
    const infos = Array.from({ length: 3 }, (_value, index) => info(index * 10, 1024 * 1024));
    expect(groupReplaySegments(infos)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 1 },
      { first: 2, last: 2 },
    ]);
  });

  it("starts a group where a snapshot is and caps the segments in one group", () => {
    const infos = Array.from({ length: 6 }, (_value, index) => info(index * 10, 10));
    expect(groupReplaySegments(infos, (index) => index === 4)).toEqual([
      { first: 0, last: 3 },
      { first: 4, last: 5 },
    ]);
    const many = Array.from({ length: REPLAY_GROUP_MAX_SEGMENTS + 1 }, (_value, index) => info(index, 1));
    expect(groupReplaySegments(many)).toEqual([
      { first: 0, last: REPLAY_GROUP_MAX_SEGMENTS - 1 },
      { first: REPLAY_GROUP_MAX_SEGMENTS, last: REPLAY_GROUP_MAX_SEGMENTS },
    ]);
  });
});

describe("concatReplaySegments", () => {
  function segment(atMs: number[], texts: string[], resizeAt?: number): SessionReplaySegment {
    const data = Buffer.from(texts.join(""));
    let end = 0;
    return {
      atMs: Float64Array.from(atMs),
      dataEnd: Uint32Array.from(texts.map((text) => (end += Buffer.byteLength(text)))),
      cols: Uint16Array.from(atMs.map((_value, index) => (index === resizeAt ? 100 : 0))),
      rows: Uint16Array.from(atMs.map((_value, index) => (index === resizeAt ? 30 : 0))),
      data: Uint8Array.from(data),
    };
  }

  it("joins entries in order and moves each output's end along", () => {
    const merged = concatReplaySegments([segment([0, 5], ["ab", "c"]), segment([7, 9], ["", "de"], 0)]);
    expect([...merged.atMs]).toEqual([0, 5, 7, 9]);
    expect([...merged.dataEnd]).toEqual([2, 3, 3, 5]);
    expect([...merged.cols]).toEqual([0, 0, 100, 0]);
    expect(Buffer.from(merged.data).toString()).toBe("abcde");
  });
});
