import type { SessionReplaySegment, SessionReplaySegmentInfo } from "@shared";

/*
 * 작은 구간 묶기.
 *
 * 팀 호스트 세션의 녹화는 구간을 짧게(5초 또는 압축 전 512KB) 끊어 끝나는 대로 팀에 보낸다. 재생 창이 그 구간을
 * 그대로 받으면 "앞 3구간"(replay-player)이 몇 초 분량에 그치고 구간마다 요청이 하나씩 간다. 그래서 재생 창에는
 * 이어지는 작은 구간을 출력 512KB 안팎까지 이어 붙인 묶음을 한 구간처럼 준다. 개인 호스트 녹화는 구간이 이미 크고,
 * 묶지 않는다(부르는 쪽이 고른다).
 */

/** 묶음이 이만큼의 출력을 넘으면 다음 구간부터 새 묶음이다. */
export const REPLAY_GROUP_OUTPUT_BYTES = 512 * 1024;
/** 묶음 하나의 구간 수 상한 — 팀 녹화를 한 번에 묶어 받는 상한(서버 256개)과 같다. */
export const REPLAY_GROUP_MAX_SEGMENTS = 256;

/** 묶음 하나 — first 부터 last 까지의 구간(둘 다 포함). */
export interface ReplaySegmentGroup {
  first: number;
  last: number;
}

/**
 * 구간을 묶는다. startsGroup 이 참인 구간에서는 묶음을 새로 시작한다 — 스냅샷은 "그 구간의 첫 항목부터 잇는다"
 * 이므로 묶음의 첫 구간이어야 한다.
 */
export function groupReplaySegments(
  infos: readonly SessionReplaySegmentInfo[],
  startsGroup?: (index: number) => boolean,
): ReplaySegmentGroup[] {
  const groups: ReplaySegmentGroup[] = [];
  let current: ReplaySegmentGroup | null = null;
  let outputBytes = 0;
  for (let index = 0; index < infos.length; index += 1) {
    if (
      !current ||
      outputBytes >= REPLAY_GROUP_OUTPUT_BYTES ||
      index - current.first >= REPLAY_GROUP_MAX_SEGMENTS ||
      startsGroup?.(index)
    ) {
      current = { first: index, last: index };
      groups.push(current);
      outputBytes = 0;
    } else {
      current.last = index;
    }
    outputBytes += infos[index].outputBytes;
  }
  return groups;
}

/** 묶음의 구간 정보 — 재생 창에는 이것이 구간 하나다. */
export function groupedSegmentInfo(
  infos: readonly SessionReplaySegmentInfo[],
  group: ReplaySegmentGroup,
): SessionReplaySegmentInfo {
  let entryCount = 0;
  let outputBytes = 0;
  for (let index = group.first; index <= group.last; index += 1) {
    entryCount += infos[index].entryCount;
    outputBytes += infos[index].outputBytes;
  }
  return {
    startAtMs: infos[group.first].startAtMs,
    endAtMs: infos[group.last].endAtMs,
    entryCount,
    outputBytes,
  };
}

/** 구간 여럿의 항목을 차례로 이어 한 구간으로 만든다. */
export function concatReplaySegments(parts: readonly SessionReplaySegment[]): SessionReplaySegment {
  if (parts.length === 1) {
    return parts[0];
  }
  let count = 0;
  let dataLength = 0;
  for (const part of parts) {
    count += part.atMs.length;
    dataLength += part.data.length;
  }
  const merged: SessionReplaySegment = {
    atMs: new Float64Array(count),
    dataEnd: new Uint32Array(count),
    cols: new Uint16Array(count),
    rows: new Uint16Array(count),
    data: new Uint8Array(dataLength),
  };
  let entry = 0;
  let offset = 0;
  for (const part of parts) {
    merged.atMs.set(part.atMs, entry);
    merged.cols.set(part.cols, entry);
    merged.rows.set(part.rows, entry);
    for (let index = 0; index < part.dataEnd.length; index += 1) {
      merged.dataEnd[entry + index] = part.dataEnd[index] + offset;
    }
    merged.data.set(part.data, offset);
    entry += part.atMs.length;
    offset += part.data.length;
  }
  return merged;
}
