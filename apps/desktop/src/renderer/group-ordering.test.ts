import { describe, expect, it } from 'vitest';
import type { GroupRecord, HostRecord } from '@shared';
import {
  collectGroupPaths,
  compareGroupSiblings,
  GROUP_RANK_STEP,
  nextGroupRank,
  planGroupReorder,
  seedGroupRanks,
} from '@shared';

function group(path: string, sortRank?: number | null): GroupRecord {
  return {
    id: `g:${path}`,
    name: path.split('/').at(-1)!,
    path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null,
    sortRank: sortRank ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('compareGroupSiblings', () => {
  // 랭크 없는 것을 뒤로 모는 것이 이 규칙의 핵심이다. 이름순으로 사이에 끼우면 다른 기기에서
  // 넘어온 그룹이 목록 중간에 조용히 나타나 찾지 못한다.
  it('puts ranked groups first and leaves unranked ones at the end by name', () => {
    const sorted = [group('zulu', 10), group('alpha'), group('bravo')].sort(
      compareGroupSiblings,
    );

    expect(sorted.map((record) => record.path)).toEqual(['zulu', 'alpha', 'bravo']);
  });

  it('breaks ties by id so two devices agree', () => {
    const left = { ...group('a', 5), id: 'id-a' };
    const right = { ...group('b', 5), id: 'id-b' };

    expect(compareGroupSiblings(left, right)).toBeLessThan(0);
    expect(compareGroupSiblings(right, left)).toBeGreaterThan(0);
  });
});

// 기본 정렬 방식을 '직접' 으로 바꾸는 근거다 — 랭크가 하나도 없으면 예전(이름순)과 같은
// 화면이어야 아무것도 옮기지 않은 사용자에게 변화가 없다.
describe('collectGroupPaths', () => {
  it('matches plain name order while nothing has been reordered', () => {
    const groups = [group('work'), group('work/aws'), group('personal')];
    const hosts: HostRecord[] = [];

    expect(collectGroupPaths(groups, hosts)).toEqual([
      'personal',
      'work',
      'work/aws',
    ]);
  });

  it('keeps children directly under their parent when ranks reorder the roots', () => {
    const groups = [
      group('work', 2 * GROUP_RANK_STEP),
      group('work/aws'),
      group('personal', GROUP_RANK_STEP),
    ];

    // personal 이 앞으로 왔어도 work/aws 는 work 바로 뒤에 붙는다.
    expect(collectGroupPaths(groups, [])).toEqual([
      'personal',
      'work',
      'work/aws',
    ]);
  });

  it('orders groups that exist only through hosts by name after ranked ones', () => {
    const hosts = [
      { groupName: 'implicit' } as HostRecord,
      { groupName: 'another' } as HostRecord,
    ];

    expect(collectGroupPaths([group('ranked', GROUP_RANK_STEP)], hosts)).toEqual([
      'ranked',
      'another',
      'implicit',
    ]);
  });
});

describe('planGroupReorder', () => {
  const siblings = [
    group('a', GROUP_RANK_STEP),
    group('b', 2 * GROUP_RANK_STEP),
    group('c', 3 * GROUP_RANK_STEP),
  ];

  // 흔한 경우는 레코드 하나만 바뀌어야 한다 — 형제 전부를 다시 매기면 그만큼 동기화로 나간다.
  it('moves one record when there is room between neighbours', () => {
    const plan = planGroupReorder(siblings, 'g:c', 1);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.id).toBe('g:c');
    expect(plan[0]?.sortRank).toBeGreaterThan(GROUP_RANK_STEP);
    expect(plan[0]?.sortRank).toBeLessThan(2 * GROUP_RANK_STEP);
  });

  it('moves to the head by stepping below the first rank', () => {
    const plan = planGroupReorder(siblings, 'g:c', 0);

    expect(plan).toEqual([{ id: 'g:c', sortRank: 0 }]);
  });

  // 간격이 닫히면 그 부모 아래를 다시 매긴다. 부분만 매기면 랭크 있는 것과 없는 것이 섞인다.
  it('renumbers the whole sibling set when the gap is closed', () => {
    const tight = [group('a', 10), group('b', 11), group('c', 12)];
    const plan = planGroupReorder(tight, 'g:c', 1);

    expect(plan).toHaveLength(3);
    expect(plan.map((entry) => entry.id)).toEqual(['g:a', 'g:c', 'g:b']);
  });

  it('renumbers when a neighbour has no rank yet', () => {
    const mixed = [group('a', GROUP_RANK_STEP), group('b'), group('c')];
    const plan = planGroupReorder(mixed, 'g:c', 1);

    expect(plan).toHaveLength(3);
  });
});

describe('seedGroupRanks / nextGroupRank', () => {
  it('seeds the visible order without changing it', () => {
    const seeded = seedGroupRanks([group('a'), group('b'), group('c')]);

    expect(seeded.map((entry) => entry.sortRank)).toEqual([
      GROUP_RANK_STEP,
      2 * GROUP_RANK_STEP,
      3 * GROUP_RANK_STEP,
    ]);
  });

  // 새로 만든 그룹은 맨 뒤다 — 목록 중간에 생기면 방금 만든 것을 못 찾는다.
  it('appends new groups after the last ranked sibling', () => {
    expect(nextGroupRank([group('a', 5), group('b', 9)])).toBe(9 + GROUP_RANK_STEP);
    expect(nextGroupRank([])).toBe(GROUP_RANK_STEP);
  });
});
