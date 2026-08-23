import type { GroupRecord } from './models';

// 그룹 수동 정렬(직접 순서)의 계산 규칙.
//
// 데스크톱과 모바일이 같은 순서를 보여야 하므로 비교와 재배치를 한곳에 둔다.
//
// **성긴 정수**를 쓴다. 문자열 랭크(LexoRank 계열)는 형제가 수천 개일 때 값을 하는데, 여기서는
// 부모 하나 아래 그룹이 많아야 수십 개다. 정수에 넓은 간격을 두면 대부분의 이동이 레코드
// 하나만 바꾸고, 간격이 닫혔을 때만 그 부모의 형제를 다시 매긴다.

/** 새 랭크를 매길 때 형제 사이에 두는 간격. 이 크기면 같은 자리에 열 번쯤 끼워 넣어도 안 닫힌다. */
export const GROUP_RANK_STEP = 1024;

/**
 * 형제 정렬 규칙.
 *
 * 랭크가 있는 것이 먼저, 그들끼리는 랭크 오름차순. **랭크가 없는 것은 맨 뒤**로 몰고 그들끼리
 * 이름순이다 — 새로 동기화돼 들어온 그룹이 목록 중간에 조용히 끼면 찾지 못한다.
 * 랭크가 같으면(두 기기가 같은 자리에 동시에 넣은 경우) id 로 갈라 순서를 안정시킨다.
 */
export function compareGroupSiblings(
  left: { sortRank?: number | null; path: string; id?: string },
  right: { sortRank?: number | null; path: string; id?: string }
): number {
  const leftRank = typeof left.sortRank === 'number' ? left.sortRank : null;
  const rightRank = typeof right.sortRank === 'number' ? right.sortRank : null;

  if (leftRank !== null && rightRank !== null) {
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return (left.id ?? '').localeCompare(right.id ?? '');
  }
  if (leftRank !== null) return -1;
  if (rightRank !== null) return 1;

  return left.path.localeCompare(right.path);
}

/** 목록 끝에 붙일 랭크. 그룹을 새로 만들 때 쓴다. */
export function nextGroupRank(siblings: Array<{ sortRank?: number | null }>): number {
  let max: number | null = null;
  for (const sibling of siblings) {
    if (typeof sibling.sortRank === 'number' && (max === null || sibling.sortRank > max)) {
      max = sibling.sortRank;
    }
  }
  return max === null ? GROUP_RANK_STEP : max + GROUP_RANK_STEP;
}

export interface GroupRankAssignment {
  id: string;
  sortRank: number;
}

/**
 * `movedId` 를 형제 목록의 `targetIndex` 자리로 옮겼을 때 필요한 랭크 변경을 계산한다.
 *
 * `siblings` 는 **화면에 보이는 순서**여야 한다(compareGroupSiblings 로 이미 정렬된 것).
 * `targetIndex` 는 옮긴 뒤 그 항목이 있어야 할 자리다.
 *
 * 보통은 앞뒤 이웃의 중간값 하나만 돌려준다. 그 사이에 넣을 정수가 없거나(간격이 닫혔다)
 * 랭크가 없는 형제가 섞여 있으면 **그 부모의 형제 전체를 다시 매긴다** — 부분만 매기면
 * 랭크 있는 것과 없는 것이 뒤섞여 목록이 흐트러진다.
 */
export function planGroupReorder(
  siblings: Array<{ id: string; sortRank?: number | null; path: string }>,
  movedId: string,
  targetIndex: number
): GroupRankAssignment[] {
  const from = siblings.findIndex((sibling) => sibling.id === movedId);
  if (from < 0) {
    return [];
  }

  const reordered = [...siblings];
  const [moved] = reordered.splice(from, 1);
  if (!moved) {
    return [];
  }
  const clamped = Math.max(0, Math.min(targetIndex, reordered.length));
  reordered.splice(clamped, 0, moved);

  const before = clamped > 0 ? reordered[clamped - 1] : null;
  const after = clamped + 1 < reordered.length ? reordered[clamped + 1] : null;
  const beforeRank = typeof before?.sortRank === 'number' ? before.sortRank : null;
  const afterRank = typeof after?.sortRank === 'number' ? after.sortRank : null;

  // 이웃 둘 다 랭크를 갖고 사이에 정수가 남아 있으면 하나만 바꾸면 된다.
  if (before === null && afterRank !== null) {
    const next = afterRank - GROUP_RANK_STEP;
    return [{ id: moved.id, sortRank: next }];
  }
  if (after === null && beforeRank !== null) {
    return [{ id: moved.id, sortRank: beforeRank + GROUP_RANK_STEP }];
  }
  if (beforeRank !== null && afterRank !== null && afterRank - beforeRank > 1) {
    return [{ id: moved.id, sortRank: Math.floor((beforeRank + afterRank) / 2) }];
  }
  if (before === null && after === null) {
    return [{ id: moved.id, sortRank: GROUP_RANK_STEP }];
  }

  // 간격이 닫혔거나 이웃에 랭크가 없다 — 이 부모 아래를 처음부터 다시 매긴다.
  return reordered.map((sibling, index) => ({
    id: sibling.id,
    sortRank: (index + 1) * GROUP_RANK_STEP
  }));
}

/** 랭크가 없는 형제가 섞여 있는지. 처음 수동 정렬을 시작할 때 전체를 매겨야 하는지 판단한다. */
export function hasUnrankedSibling(siblings: Array<{ sortRank?: number | null }>): boolean {
  return siblings.some((sibling) => typeof sibling.sortRank !== 'number');
}

/** 지금 보이는 순서 그대로 랭크를 심는다. 정렬 결과가 바뀌지 않는다. */
export function seedGroupRanks(
  siblings: Array<{ id: string; sortRank?: number | null }>
): GroupRankAssignment[] {
  return siblings.map((sibling, index) => ({
    id: sibling.id,
    sortRank: (index + 1) * GROUP_RANK_STEP
  }));
}

/** 레코드 배열을 형제 규칙으로 정렬한다(같은 부모끼리라는 전제). */
export function sortGroupSiblings<T extends { sortRank?: number | null; path: string; id?: string }>(
  siblings: T[]
): T[] {
  return [...siblings].sort(compareGroupSiblings);
}

export type { GroupRecord };
