import type { GroupRecord, HostRecord } from './models';
import { compareGroupSiblings } from './group-ordering';

export interface GroupCardView {
  path: string;
  name: string;
  hostCount: number;
}

export function normalizeGroupPath(groupPath?: string | null): string | null {
  const normalized = (groupPath ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  return normalized.length > 0 ? normalized : null;
}

export function getParentGroupPath(groupPath?: string | null): string | null {
  const normalized = normalizeGroupPath(groupPath);
  if (!normalized || !normalized.includes('/')) {
    return null;
  }
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

export function getGroupLabel(groupPath: string): string {
  const parts = groupPath.split('/');
  return parts[parts.length - 1];
}

export function isGroupWithinPath(groupPath: string | null, currentGroupPath: string | null): boolean {
  if (!currentGroupPath) {
    return true;
  }
  if (!groupPath) {
    return false;
  }
  return groupPath === currentGroupPath || groupPath.startsWith(`${currentGroupPath}/`);
}

export function isDirectGroupChild(groupPath: string, currentGroupPath: string | null): boolean {
  return getParentGroupPath(groupPath) === currentGroupPath;
}

export function isDirectHostChild(groupPath: string | null, currentGroupPath: string | null): boolean {
  return normalizeGroupPath(groupPath) === currentGroupPath;
}

export function filterHostsInGroupTree<T extends Pick<HostRecord, 'groupName'>>(hosts: T[], currentGroupPath: string | null): T[] {
  return hosts.filter((host) => isGroupWithinPath(normalizeGroupPath(host.groupName), currentGroupPath));
}

export function collectGroupPaths(groups: GroupRecord[], hosts: HostRecord[]): string[] {
  const paths = new Set<string>();

  const appendPathWithAncestors = (targetPath?: string | null) => {
    const normalized = normalizeGroupPath(targetPath);
    if (!normalized) {
      return;
    }
    const segments = normalized.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index + 1).join('/'));
    }
  };

  for (const group of groups) {
    appendPathWithAncestors(group.path);
  }

  for (const host of hosts) {
    appendPathWithAncestors(host.groupName);
  }

  return orderGroupPaths([...paths], groups);
}

/**
 * 경로 목록을 **트리 순서**로 편다 — 부모 바로 뒤에 그 자식들이 오고, 형제끼리는
 * `compareGroupSiblings`(직접 순서 → 없으면 이름) 로 정렬한다.
 *
 * 예전에는 경로 문자열을 통째로 정렬했다. 직접 순서는 레코드에 있으므로 문자열만 봐서는
 * 반영할 수 없다. 순서가 하나도 없으면 결과는 예전과 같다 — 형제끼리는 부모 접두사가 같아
 * 전체 경로 비교와 마지막 마디 비교가 같은 답을 내기 때문이다.
 */
function orderGroupPaths(allPaths: string[], groups: GroupRecord[]): string[] {
  const recordByPath = new Map(groups.map((group) => [group.path, group]));
  const childrenByParent = new Map<string, string[]>();
  for (const path of allPaths) {
    const parent = getParentGroupPath(path) ?? '';
    const bucket = childrenByParent.get(parent);
    if (bucket) {
      bucket.push(path);
    } else {
      childrenByParent.set(parent, [path]);
    }
  }

  const ordered: string[] = [];
  const emit = (parent: string) => {
    const children = childrenByParent.get(parent);
    if (!children) {
      return;
    }
    const sorted = [...children].sort((left, right) =>
      compareGroupSiblings(
        recordByPath.get(left) ?? { path: left },
        recordByPath.get(right) ?? { path: right }
      )
    );
    for (const path of sorted) {
      ordered.push(path);
      emit(path);
    }
  };
  emit('');
  return ordered;
}

export function countHostsInGroupTree(hosts: HostRecord[], groupPath: string): number {
  return hosts.filter((host) => {
    const hostGroupPath = normalizeGroupPath(host.groupName);
    return Boolean(hostGroupPath && isGroupWithinPath(hostGroupPath, groupPath));
  }).length;
}

export function buildVisibleGroups(groups: GroupRecord[], hosts: HostRecord[], currentGroupPath: string | null): GroupCardView[] {
  const explicitGroupMap = new Map(groups.map((group) => [group.path, group]));
  return collectGroupPaths(groups, hosts)
    .filter((groupPath) => isDirectGroupChild(groupPath, currentGroupPath))
    .map((groupPath) => ({
      path: groupPath,
      name: explicitGroupMap.get(groupPath)?.name ?? getGroupLabel(groupPath),
      hostCount: countHostsInGroupTree(hosts, groupPath)
    }));
}

export function stripRemovedGroupSegment(groupPath: string | null, removedGroupPath: string): string | null {
  const normalizedGroupPath = normalizeGroupPath(groupPath);
  const normalizedRemovedPath = normalizeGroupPath(removedGroupPath);
  if (!normalizedGroupPath || !normalizedRemovedPath || !isGroupWithinPath(normalizedGroupPath, normalizedRemovedPath)) {
    return normalizedGroupPath;
  }

  const parentPath = getParentGroupPath(normalizedRemovedPath);
  if (normalizedGroupPath === normalizedRemovedPath) {
    return parentPath;
  }

  const suffix = normalizedGroupPath.slice(normalizedRemovedPath.length + 1);
  return normalizeGroupPath(parentPath ? `${parentPath}/${suffix}` : suffix);
}

export function rebaseGroupPath(
  sourcePath: string | null,
  fromPath: string,
  toPath: string | null
): string | null {
  const normalizedSourcePath = normalizeGroupPath(sourcePath);
  const normalizedFromPath = normalizeGroupPath(fromPath);
  const normalizedToPath = normalizeGroupPath(toPath);
  if (!normalizedSourcePath || !normalizedFromPath || !isGroupWithinPath(normalizedSourcePath, normalizedFromPath)) {
    return normalizedSourcePath;
  }

  if (normalizedSourcePath === normalizedFromPath) {
    return normalizedToPath;
  }

  const suffix = normalizedSourcePath.slice(normalizedFromPath.length + 1);
  return normalizeGroupPath(normalizedToPath ? `${normalizedToPath}/${suffix}` : suffix);
}

export function buildGroupOptions(
  groups: GroupRecord[],
  hosts: HostRecord[],
  extras: Array<string | null | undefined> = []
): Array<{ value: string | null; label: string }> {
  const paths = new Set(collectGroupPaths(groups, hosts));
  for (const extra of extras) {
    const normalized = normalizeGroupPath(extra);
    if (normalized) {
      paths.add(normalized);
    }
  }

  return [
    { value: null, label: 'Ungrouped' },
    ...[...paths].sort((a, b) => a.localeCompare(b)).map((path) => ({
      value: path,
      label: path
    }))
  ];
}

export function getHostTagsToggleLabel(isExpanded: boolean, tagCount: number): string {
  return isExpanded ? 'Hide tags' : `Tags (${tagCount})`;
}

export function getGroupDeleteDialogVariant(childGroupCount: number, hostCount: number): 'simple' | 'with-descendants' {
  return childGroupCount > 0 || hostCount > 0 ? 'with-descendants' : 'simple';
}
