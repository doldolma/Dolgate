import type {
  SessionReplayEntry,
  SessionReplaySegment,
  SessionReplaySegmentInfo,
} from '@shared';
import { vi } from 'vitest';

function decodeBase64(dataBase64: string): Uint8Array {
  return Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0));
}

/** 항목들을 메인이 재생 창에 넘기는 구간 꼴로 담는다. */
export function packReplaySegment(entries: SessionReplayEntry[]): SessionReplaySegment {
  const atMs: number[] = [];
  const dataEnd: number[] = [];
  const cols: number[] = [];
  const rows: number[] = [];
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const entry of entries) {
    if (entry.type === 'output') {
      const bytes = decodeBase64(entry.dataBase64);
      chunks.push(bytes);
      size += bytes.length;
      cols.push(0);
      rows.push(0);
    } else {
      cols.push(entry.cols);
      rows.push(entry.rows);
    }
    atMs.push(entry.atMs);
    dataEnd.push(size);
  }
  const data = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    data.set(chunk, position);
    position += chunk.length;
  }
  return {
    atMs: Float64Array.from(atMs),
    dataEnd: Uint32Array.from(dataEnd),
    cols: Uint16Array.from(cols),
    rows: Uint16Array.from(rows),
    data,
  };
}

/**
 * 녹화 항목을 entriesPerSegment 개씩 구간으로 나눈다. 구간 목록과, 구간을 돌려주는 readSegment(호출을
 * 셀 수 있는 mock)를 준다.
 */
export function segmentReplayEntries(
  entries: SessionReplayEntry[],
  entriesPerSegment = Number.POSITIVE_INFINITY,
): {
  segments: SessionReplaySegmentInfo[];
  readSegment: ReturnType<typeof vi.fn<(segmentIndex: number) => Promise<SessionReplaySegment>>>;
} {
  const groups: SessionReplayEntry[][] = [];
  for (let index = 0; index < entries.length; index += entriesPerSegment) {
    groups.push(entries.slice(index, index + entriesPerSegment));
  }
  const packed = groups.map(packReplaySegment);
  return {
    segments: groups.map((group, index) => ({
      startAtMs: group[0]!.atMs,
      endAtMs: group[group.length - 1]!.atMs,
      entryCount: group.length,
      outputBytes: packed[index]!.data.length,
    })),
    readSegment: vi.fn(async (segmentIndex: number) => {
      const segment = packed[segmentIndex];
      if (!segment) {
        throw new Error(`no segment ${segmentIndex}`);
      }
      return segment;
    }),
  };
}
