import { isGroupWithinPath, normalizeGroupPath } from '@shared';

/**
 * 최근 로그를 좁힐 그룹 경로.
 *
 * 명시적으로 고른 그룹 카드가 있으면 그것이 범위다. 그룹은 Cmd/Ctrl·Shift 클릭으로 여러 개를
 * 고를 수 있고, 그때는 고른 그룹 **전체의 합집합**이다. 고른 것이 없으면 지금 들어가 있는
 * 그룹(탐색 중인 경로)을 쓴다 — 둘 다 "지금 보고 있는 그룹"이라, 어느 쪽으로 좁혀도 오른쪽
 * 목록이 따라오는 편이 화면이 한 가지 이야기를 한다.
 */
export function resolveRecentLogScopeGroupPaths(input: {
  selectedGroupPaths?: readonly string[] | null;
  currentGroupPath?: string | null;
}): string[] {
  const selected = (input.selectedGroupPaths ?? [])
    .map((path) => normalizeGroupPath(path))
    .filter((path): path is string => Boolean(path));
  if (selected.length > 0) {
    return selected;
  }
  const current = normalizeGroupPath(input.currentGroupPath ?? null);
  return current ? [current] : [];
}

/**
 * 범위에 속한 호스트 id 집합. **null 은 "범위 없음"(전체)** 이고, 빈 Set 은 "범위는 있는데 그
 * 안에 호스트가 없다" 다 — 이 둘을 섞으면 그룹을 골랐는데 전체 로그가 나온다.
 *
 * 하위 그룹의 호스트도 포함한다(트리에서 부모를 고르면 그 아래가 다 보이는 것과 같게).
 * 그룹이 없는 호스트는 isGroupWithinPath 가 false 를 주므로 자연히 빠진다.
 */
export function collectScopedHostIds(
  hosts: readonly { id: string; groupName?: string | null }[],
  scopeGroupPaths: readonly string[],
): Set<string> | null {
  if (scopeGroupPaths.length === 0) {
    return null;
  }
  const ids = new Set<string>();
  for (const host of hosts) {
    const hostGroupPath = normalizeGroupPath(host.groupName ?? null);
    if (scopeGroupPaths.some((path) => isGroupWithinPath(hostGroupPath, path))) {
      ids.add(host.id);
    }
  }
  return ids;
}
