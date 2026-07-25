import { describe, expect, it } from 'vitest';
import type { ReplayCommandBlock } from '../lib/replay-command-scan';
import {
  buildScrubberMarkerClusters,
  findBlockAt,
} from './SessionReplayScrubberMarkers';

function block(
  id: number,
  atMs: number,
  state: ReplayCommandBlock['state'] = 'ok',
): ReplayCommandBlock {
  return {
    id,
    atMs,
    endAtMs: atMs + 10,
    durationMs: 10,
    command: `cmd-${id}`,
    exitCode: state === 'failed' ? 1 : 0,
    cwd: null,
    state,
  };
}

describe('buildScrubberMarkerClusters', () => {
  it('충분히 떨어진 명령은 각각 눈금이 된다', () => {
    const clusters = buildScrubberMarkerClusters(
      [block(1, 0), block(2, 5000), block(3, 10_000)],
      10_000,
      500,
    );
    expect(clusters.map((cluster) => cluster.count)).toEqual([1, 1, 1]);
    expect(clusters.map((cluster) => Math.round(cluster.ratio * 100))).toEqual([
      0, 50, 100,
    ]);
  });

  it('픽셀 간격보다 촘촘하면 하나로 묶는다', () => {
    // 500px 트랙에서 10초 → 1초당 50px. 20ms 간격은 1px 라 전부 한 덩어리.
    const clusters = buildScrubberMarkerClusters(
      [block(1, 0), block(2, 20), block(3, 40), block(4, 60)],
      10_000,
      500,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(4);
  });

  it('묶인 덩어리에 실패가 있으면 실패로 표시한다', () => {
    const clusters = buildScrubberMarkerClusters(
      [block(1, 0), block(2, 20, 'failed'), block(3, 40)],
      10_000,
      500,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].state).toBe('failed');
  });

  it('트랙 폭이 넓어지면 묶였던 눈금이 갈라진다', () => {
    const blocks = [block(1, 0), block(2, 100), block(3, 200)];
    expect(buildScrubberMarkerClusters(blocks, 10_000, 300)).toHaveLength(1);
    expect(buildScrubberMarkerClusters(blocks, 10_000, 4000)).toHaveLength(3);
  });

  it('길이나 폭을 모르면 눈금을 만들지 않는다', () => {
    expect(buildScrubberMarkerClusters([block(1, 0)], 0, 500)).toEqual([]);
    expect(buildScrubberMarkerClusters([block(1, 0)], 10_000, 0)).toEqual([]);
  });
});

describe('findBlockAt', () => {
  const blocks = [block(1, 0), block(2, 1000, 'failed'), block(3, 5000)];

  it('그 시각 이전에 시작한 마지막 명령을 돌려준다', () => {
    expect(findBlockAt(blocks, 500)?.id).toBe(1);
    expect(findBlockAt(blocks, 1000)?.id).toBe(2);
    expect(findBlockAt(blocks, 4999)?.id).toBe(2);
    expect(findBlockAt(blocks, 99_999)?.id).toBe(3);
  });

  it('첫 명령보다 앞이면 없음', () => {
    expect(findBlockAt(blocks, -1)).toBeNull();
    expect(findBlockAt([], 100)).toBeNull();
  });
});
