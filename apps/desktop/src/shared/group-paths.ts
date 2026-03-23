import type { GroupRecord, HostRecord } from './models';

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

  return [...paths].sort((a, b) => a.localeCompare(b));
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
