import { useEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import {
  collectGroupPaths,
  countHostsInGroupTree,
  filterHostsInGroupTree,
  getGroupDeleteDialogVariant,
  getGroupLabel,
  getHostSearchText,
  isGroupWithinPath,
  normalizeGroupPath,
  rebaseGroupPath,
} from '@shared';
import type {
  ActivityLogRecord,
  GroupRecord,
  GroupRemoveMode,
  HomeHostViewMode,
  HostRecord,
  SecretMetadataRecord,
  SnippetRecord,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
} from '@shared';
import type { HomeSection, SettingsSection } from '../../store/types';
import { getUnusedSavedCredentialsAfterHostDeletion } from '../../lib/host-secret-cleanup';
import { getKeyboardLayoutSearchQueries } from '../../lib/keyboard-layout-search';
import { useResponsiveCardGrid } from '../../lib/useResponsiveCardGrid';
import type { ParsedQuickSshCommand } from '../../lib/quick-connect';
import type { DesktopPlatform } from '../DesktopWindowControls';

export const HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX = 235;
export const HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX = 460;
export const HOME_BROWSER_CARD_GAP_PX = 13.6;
export const HOST_DRAG_MIME_TYPE = 'application/x-dolssh-host-id';
export const HOSTS_DRAG_MIME_TYPE = 'application/x-dolssh-host-ids';
export const GROUP_DRAG_MIME_TYPE = 'application/x-dolssh-group-path';

export const HOST_BROWSER_IMPORT_MENU_LABELS = [
  'Import Dolgate',
  'Import OpenSSH',
  'Import Serial',
  'Import from Termius',
  'Import from Xshell',
  'Import from Warpgate',
  'Import via AWS SSM',
] as const;

export function getHostBrowserVisibleImportMenuLabels(
  desktopPlatform: DesktopPlatform,
): string[] {
  return desktopPlatform === 'win32'
    ? [...HOST_BROWSER_IMPORT_MENU_LABELS]
    : HOST_BROWSER_IMPORT_MENU_LABELS.filter((label) => label !== 'Import from Xshell');
}

export function getHostBrowserEmptyCalloutMessage(
  hostCount: number,
  searchQuery: string,
): string {
  return hostCount === 0
    ? 'New Host로 첫 번째 SSH host를 추가해보세요. 시리얼 연결은 Import Serial에서 시작할 수 있습니다.'
    : searchQuery
      ? '검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.'
      : 'New Host로 SSH host를 추가하거나, 시리얼 연결이 필요하면 Import Serial을 사용해보세요.';
}

export type HostSortKey = 'name' | 'recent' | 'group' | 'lastConnected';

// 그룹 사이드바 정렬: 이름순 / 최근 사용순 / 호스트 많은 순.
export type GroupSortKey = 'name' | 'recent' | 'count';
export type HostViewMode = HomeHostViewMode;

export interface GroupDeleteTarget {
  paths: string[];
  groupCount: number;
  title: string;
  hostCount: number;
  childGroupCount: number;
}

export interface HostDeleteTarget {
  hostIds: string[];
  title: string;
  hostCount: number;
}

export interface HostContextMenuState {
  kind: 'host';
  hostIds: string[];
  x: number;
  y: number;
}

export interface GroupContextMenuState {
  kind: 'group';
  groupPaths: string[];
  x: number;
  y: number;
}

export type ContextMenuState = HostContextMenuState | GroupContextMenuState;

export type GroupModalState =
  | { mode: 'create'; parentPath?: string | null }
  | { mode: 'rename'; path: string };

export interface GroupTreeRow {
  path: string;
  label: string;
  depth: number;
  parentPath: string | null;
  hasChildren: boolean;
  hostCount: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export function buildGroupTreeRows(
  groupPaths: string[],
  groups: GroupRecord[],
  hosts: HostRecord[],
): GroupTreeRow[] {
  const explicitGroupMap = new Map(groups.map((group) => [group.path, group]));
  const groupPathSet = new Set(groupPaths);
  return groupPaths.map((path) => ({
    path,
    label: explicitGroupMap.get(path)?.name ?? getGroupLabel(path),
    depth: Math.max(0, path.split('/').length - 1),
    parentPath: normalizeGroupPath(
      path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null,
    ),
    hasChildren: [...groupPathSet].some((candidate) => candidate.startsWith(`${path}/`)),
    hostCount: countHostsInGroupTree(hosts, path),
  }));
}

// 그룹 트리를 계층 구조를 유지하며 정렬한다(부모 → 자식 DFS 순서). 같은 부모의 형제들만
// 정렬 키로 재배열하므로 들여쓰기/펼침 동작이 깨지지 않는다.
export function sortGroupTreeRows(
  rows: GroupTreeRow[],
  sortKey: GroupSortKey,
  recentByPath: Map<string, number>,
): GroupTreeRow[] {
  const byParent = new Map<string | null, GroupTreeRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentPath);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.parentPath, [row]);
    }
  }
  const compare = (a: GroupTreeRow, b: GroupTreeRow): number => {
    if (sortKey === 'count') {
      return b.hostCount - a.hostCount || a.label.localeCompare(b.label);
    }
    if (sortKey === 'recent') {
      return (recentByPath.get(b.path) ?? 0) - (recentByPath.get(a.path) ?? 0) || a.label.localeCompare(b.label);
    }
    return a.label.localeCompare(b.label);
  };
  const ordered: GroupTreeRow[] = [];
  const walk = (parentPath: string | null) => {
    const children = (byParent.get(parentPath) ?? []).slice().sort(compare);
    for (const child of children) {
      ordered.push(child);
      walk(child.path);
    }
  };
  walk(null);
  return ordered;
}

export function isAdditiveSelectionEvent(
  event:
    | Pick<MouseEvent, 'ctrlKey' | 'metaKey'>
    | Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>,
): boolean {
  return event.ctrlKey || event.metaKey;
}

export function getSelectionRange<T extends string>(items: T[], anchor: T | null, target: T): T[] {
  const targetIndex = items.indexOf(target);
  if (targetIndex < 0) {
    return [target];
  }
  const anchorIndex = anchor ? items.indexOf(anchor) : -1;
  if (anchorIndex < 0) {
    return [target];
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return items.slice(start, end + 1);
}

export function normalizeGroupSelectionForDelete(groupPaths: string[]): string[] {
  return [...groupPaths]
    .filter(
      (path) =>
        !groupPaths.some(
          (candidate) => candidate !== path && isGroupWithinPath(path, candidate),
        ),
    )
    .sort(
      (left, right) =>
        left.split('/').length - right.split('/').length || left.localeCompare(right),
    );
}

export function buildNextGroupPath(
  groupPath: string,
  targetParentPath: string | null,
): string | null {
  const normalizedGroupPath = normalizeGroupPath(groupPath);
  if (!normalizedGroupPath) {
    return null;
  }
  const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
  return normalizeGroupPath(
    normalizedTargetParentPath
      ? `${normalizedTargetParentPath}/${getGroupLabel(normalizedGroupPath)}`
      : getGroupLabel(normalizedGroupPath),
  );
}

export function canReparentGroup(
  groupPath: string,
  targetParentPath: string | null,
): boolean {
  const normalizedGroupPath = normalizeGroupPath(groupPath);
  const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
  if (!normalizedGroupPath) {
    return false;
  }
  if (
    normalizedTargetParentPath &&
    isGroupWithinPath(normalizedTargetParentPath, normalizedGroupPath)
  ) {
    return false;
  }
  const nextGroupPath = buildNextGroupPath(normalizedGroupPath, normalizedTargetParentPath);
  return Boolean(nextGroupPath && nextGroupPath !== normalizedGroupPath);
}

export function parseHostDragIds(payload: string): string[] {
  if (!payload) {
    return [];
  }
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

// 정렬 키별 기본 방향: 이름/그룹은 오름차순(가나다), 시간 계열은 내림차순(최신 먼저).
export function defaultHostSortDirection(key: HostSortKey): 'asc' | 'desc' {
  return key === 'name' || key === 'group' ? 'asc' : 'desc';
}

function sortHosts(
  hosts: HostRecord[],
  sortKey: HostSortKey,
  sortDirection: 'asc' | 'desc',
  lastConnectedByHostId: Map<string, number>,
): HostRecord[] {
  // 각 비교자는 오름차순 기준이고 방향(dir)으로 부호를 뒤집는다. 동률은 항상 이름 오름차순.
  const dir = sortDirection === 'desc' ? -1 : 1;
  const byName = (a: HostRecord, b: HostRecord) => a.label.localeCompare(b.label);
  if (sortKey === 'group') {
    return [...hosts].sort(
      (a, b) =>
        dir *
          (normalizeGroupPath(a.groupName) ?? '').localeCompare(
            normalizeGroupPath(b.groupName) ?? '',
          ) || byName(a, b),
    );
  }
  if (sortKey === 'lastConnected') {
    return [...hosts].sort((a, b) => {
      const ta = lastConnectedByHostId.get(a.id) ?? 0;
      const tb = lastConnectedByHostId.get(b.id) ?? 0;
      return dir * (ta - tb) || byName(a, b);
    });
  }
  if (sortKey === 'recent') {
    return [...hosts].sort(
      (a, b) => dir * (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '') || byName(a, b),
    );
  }
  return [...hosts].sort((a, b) => dir * byName(a, b));
}

export interface UseHostBrowserParams {
  desktopPlatform: DesktopPlatform;
  hosts: HostRecord[];
  groups: GroupRecord[];
  keychainEntries: SecretMetadataRecord[];
  currentGroupPath: string | null;
  searchQuery: string;
  hostViewMode?: HostViewMode;
  selectedHostId: string | null;
  activityLogs?: ActivityLogRecord[];
  snippets?: SnippetRecord[];
  onSetHostFavorite: (hostId: string, favorite: boolean) => void | Promise<void>;
  errorMessage?: string | null;
  statusMessage?: string | null;
  onSearchChange: (query: string) => void;
  onHostViewModeChange?: (mode: HostViewMode) => void | Promise<void>;
  onOpenLocalTerminal: () => void;
  onCreateHost: () => void;
  onOpenDolgateImport: () => void;
  onOpenSerialImport: () => void;
  onOpenAwsImport: () => void;
  onOpenOpenSshImport: () => void;
  onOpenXshellImport: () => void;
  onOpenTermiusImport: () => void;
  onOpenWarpgateImport: () => void;
  onCreateGroup: (name: string, parentPath?: string | null) => Promise<void>;
  onRemoveGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  onMoveGroup: (path: string, targetParentPath: string | null) => Promise<void>;
  onRenameGroup: (path: string, name: string) => Promise<void>;
  onNavigateGroup: (path: string | null) => void;
  onClearHostSelection: () => void;
  onSelectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onDuplicateHosts: (hostIds: string[]) => Promise<void>;
  onExportHosts: (hostIds: string[]) => void;
  onMoveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  onRemoveHost: (hostId: string) => Promise<void>;
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onConnectHost: (hostId: string) => Promise<void>;
  onOpenHostInNewWindow?: (hostId: string) => Promise<void>;
  onConnectHostTmux?: (hostId: string) => Promise<void>;
  onOpenHostContainers: (hostId: string) => Promise<void>;
  onOpenSftp?: (hostId: string) => void | Promise<void>;
  onSelectSection?: (section: HomeSection) => void;
  onActivateSftp?: () => void | Promise<void>;
  onActivateContainers?: () => void | Promise<void>;
  onOpenSettingsSection?: (section: SettingsSection) => void | Promise<void>;
  onQuickConnectSsh?: (input: ParsedQuickSshCommand) => Promise<void>;
  detailTab?: 'overview' | 'connection';
  onDetailTabChange?: (tab: 'overview' | 'connection') => void;
  onOpenReplay?: (recordingId: string) => void | Promise<void>;
  onGenerateAndInstallSshKey?: (hostId: string, input: SshKeyGenerateInput) => Promise<void>;
  onInstallSshPublicKey?: (input: SshKeyInstallInput) => Promise<SshKeyInstallResult>;
}

/**
 * 홈 호스트 브라우저의 모든 상호작용 상태(선택/드래그/컨텍스트메뉴/모달)와 파생값,
 * 핸들러를 한 곳에 모은 훅. 사이드바·호스트 목록·상세 패널 세 region이 이 모델을
 * 공유한다. 드래그 hover 등 고빈도·렌더결합·비영속 상태라 Zustand로 올리지 않는다.
 */
export function useHostBrowser(params: UseHostBrowserParams) {
  const {
    hosts,
    groups,
    keychainEntries,
    currentGroupPath,
    searchQuery,
    selectedHostId,
    onClearHostSelection,
    onSelectHost,
    onNavigateGroup,
    onMoveGroup,
    onMoveHostToGroup,
  } = params;

  const [groupModalState, setGroupModalState] = useState<GroupModalState | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupError, setGroupError] = useState<string | null>(null);
  // 섹션 이동(로그/포트포워딩 등)으로 HostBrowser가 언마운트됐다 돌아와도 선택을 잃지 않도록,
  // 영속되는 selectedHostId(상위 보관)로 초기화해 리스트 선택 상태를 복원한다.
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>(
    selectedHostId ? [selectedHostId] : [],
  );
  const [selectedGroupPaths, setSelectedGroupPaths] = useState<string[]>([]);
  const [hostSelectionAnchor, setHostSelectionAnchor] = useState<string | null>(null);
  const [groupSelectionAnchor, setGroupSelectionAnchor] = useState<string | null>(null);
  const [groupDeleteTarget, setGroupDeleteTarget] = useState<GroupDeleteTarget | null>(null);
  const [groupDeleteError, setGroupDeleteError] = useState<string | null>(null);
  const [isRemovingGroup, setIsRemovingGroup] = useState(false);
  const [hostDeleteTarget, setHostDeleteTarget] = useState<HostDeleteTarget | null>(null);
  const [hostDeleteError, setHostDeleteError] = useState<string | null>(null);
  const [isRemovingHost, setIsRemovingHost] = useState(false);
  const [removeUnusedSecretsOnHostDelete, setRemoveUnusedSecretsOnHostDelete] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragTargetGroupPath, setDragTargetGroupPath] = useState<string | null>(null);
  const [draggedHostIds, setDraggedHostIds] = useState<string[]>([]);
  const [draggedGroupPath, setDraggedGroupPath] = useState<string | null>(null);
  const [isRootDragTarget, setIsRootDragTarget] = useState(false);
  const [expandedHostTags, setExpandedHostTags] = useState<string[]>([]);
  const [isImportMenuOpen, setIsImportMenuOpen] = useState(false);
  const [collapsedTreeGroupPaths, setCollapsedTreeGroupPaths] = useState<string[]>([]);
  // 신규: 태그 필터 / 정렬 / 뷰 모드.
  const [activeTagFilter, setActiveTagFilter] = useState<string[]>([]);
  const [favoritesFilterActive, setFavoritesFilterActive] = useState(false);
  const [sortKey, setSortKey] = useState<HostSortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  function setSort(key: HostSortKey, direction?: 'asc' | 'desc') {
    setSortKey(key);
    setSortDirection(direction ?? defaultHostSortDirection(key));
  }
  // 테이블 헤더 클릭: 같은 키면 방향 토글, 다른 키면 그 키의 기본 방향으로.
  function toggleSort(key: HostSortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
    }
  }
  const [groupSortKey, setGroupSortKey] = useState<GroupSortKey>('name');
  const [hideEmptyGroups, setHideEmptyGroups] = useState(false);
  const viewMode = params.hostViewMode ?? 'grid';
  const setViewMode: (mode: HostViewMode) => void | Promise<void> =
    params.onHostViewModeChange ?? (() => undefined);
  const importMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  // 현재 그룹 안에서는 그 하위 트리만 검색하고, 루트에서는 전체 호스트를 그대로 보여준다.
  const scopedHosts = useMemo(
    () => filterHostsInGroupTree(hosts, currentGroupPath),
    [currentGroupPath, hosts],
  );

  const searchableHosts = useMemo(
    () =>
      scopedHosts.map((host) => ({
        ...host,
        searchText: getHostSearchText(host).join(' '),
      })),
    [scopedHosts],
  );

  const fuse = useMemo(
    () =>
      new Fuse(searchableHosts, {
        keys: ['label', 'groupName', 'searchText'],
        threshold: 0.32,
      }),
    [searchableHosts],
  );
  const searchQueries = useMemo(
    () => getKeyboardLayoutSearchQueries(searchQuery),
    [searchQuery],
  );

  const searchedHosts = useMemo<HostRecord[]>(() => {
    if (searchQueries.length > 0) {
      const seenHostIds = new Set<string>();
      return searchQueries.flatMap((query) =>
        fuse.search(query).flatMap((result) => {
          if (seenHostIds.has(result.item.id)) {
            return [];
          }
          seenHostIds.add(result.item.id);
          const { searchText: _searchText, ...host } = result.item;
          return [host];
        }),
      );
    }
    return searchableHosts.map(({ searchText: _searchText, ...host }) => host);
  }, [fuse, searchableHosts, searchQueries]);

  // 태그 집계(현재 그룹 스코프 기준).
  const tagCounts = useMemo<TagCount[]>(() => {
    const counts = new Map<string, number>();
    for (const host of scopedHosts) {
      for (const tag of host.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [scopedHosts]);

  // 즐겨찾기는 호스트 레코드의 favorite 필드에서 파생(영속·동기화됨).
  const favoriteHostIds = useMemo(
    () => hosts.filter((host) => host.favorite === true).map((host) => host.id),
    [hosts],
  );
  const favoriteHostIdSet = useMemo(() => new Set(favoriteHostIds), [favoriteHostIds]);

  // 활동 로그에서 호스트별 마지막 연결/활동 시각(ms). "최근 연결순" 정렬에 사용.
  const lastConnectedByHostId = useMemo(() => {
    const map = new Map<string, number>();
    for (const log of params.activityLogs ?? []) {
      const metadata = log.metadata as { hostId?: string } | null;
      const hostId = metadata?.hostId;
      if (!hostId) {
        continue;
      }
      const ts = Date.parse(log.createdAt);
      if (Number.isNaN(ts)) {
        continue;
      }
      const prev = map.get(hostId);
      if (prev === undefined || ts > prev) {
        map.set(hostId, ts);
      }
    }
    return map;
  }, [params.activityLogs]);

  // 검색 → 즐겨찾기 → 태그 필터 → 정렬 순으로 최종 표시 목록을 만든다.
  const visibleHosts = useMemo(() => {
    let next = searchedHosts;
    if (favoritesFilterActive) {
      next = next.filter((host) => favoriteHostIdSet.has(host.id));
    }
    if (activeTagFilter.length > 0) {
      next = next.filter((host) =>
        activeTagFilter.every((tag) => (host.tags ?? []).includes(tag)),
      );
    }
    return sortHosts(next, sortKey, sortDirection, lastConnectedByHostId);
  }, [
    searchedHosts,
    favoritesFilterActive,
    favoriteHostIdSet,
    activeTagFilter,
    sortKey,
    sortDirection,
    lastConnectedByHostId,
  ]);

  const allGroupPaths = useMemo(() => collectGroupPaths(groups, hosts), [groups, hosts]);
  const groupTreeRows = useMemo(
    () => buildGroupTreeRows(allGroupPaths, groups, hosts),
    [allGroupPaths, groups, hosts],
  );
  // 그룹별 최근 사용 시각(ms): 그룹 서브트리 내 호스트 활동의 최댓값(조상 경로에도 전파).
  const groupRecentByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const host of hosts) {
      const ms = lastConnectedByHostId.get(host.id) ?? 0;
      if (ms <= 0) {
        continue;
      }
      let path = normalizeGroupPath(host.groupName ?? null);
      while (path) {
        map.set(path, Math.max(map.get(path) ?? 0, ms));
        path = normalizeGroupPath(
          path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null,
        );
      }
    }
    return map;
  }, [hosts, lastConnectedByHostId]);
  const sortedGroupTreeRows = useMemo(
    () => sortGroupTreeRows(groupTreeRows, groupSortKey, groupRecentByPath),
    [groupTreeRows, groupSortKey, groupRecentByPath],
  );
  const expandAllGroups = () => setCollapsedTreeGroupPaths([]);
  const collapseAllGroups = () =>
    setCollapsedTreeGroupPaths(
      groupTreeRows.filter((row) => row.hasChildren).map((row) => row.path),
    );
  const collapsedTreeGroupPathSet = useMemo(
    () => new Set(collapsedTreeGroupPaths),
    [collapsedTreeGroupPaths],
  );
  const visibleGroupTreeRows = useMemo(
    () =>
      sortedGroupTreeRows.filter((group) => {
        if (hideEmptyGroups && group.hostCount === 0) {
          return false;
        }
        let ancestorPath = group.parentPath;
        while (ancestorPath) {
          if (collapsedTreeGroupPathSet.has(ancestorPath)) {
            return false;
          }
          ancestorPath = normalizeGroupPath(
            ancestorPath.includes('/')
              ? ancestorPath.slice(0, ancestorPath.lastIndexOf('/'))
              : null,
          );
        }
        return true;
      }),
    [collapsedTreeGroupPathSet, sortedGroupTreeRows, hideEmptyGroups],
  );
  const visibleHostIds = useMemo(() => visibleHosts.map((host) => host.id), [visibleHosts]);
  const visibleGroupPaths = useMemo(
    () => visibleGroupTreeRows.map((group) => group.path),
    [visibleGroupTreeRows],
  );

  const {
    ref: hostGridRef,
    style: hostGridStyle,
    layout: hostGridLayout,
  } = useResponsiveCardGrid({
    itemCount: visibleHosts.length,
    minWidth: HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX,
    maxWidth: HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX,
    gap: HOME_BROWSER_CARD_GAP_PX,
  });
  const clampedHostCardStyle =
    hostGridLayout.justifyContent === 'start' && hostGridLayout.cardWidth
      ? { width: '100%', maxWidth: `${hostGridLayout.cardWidth}px` }
      : undefined;

  const currentGroupPathLabel = currentGroupPath
    ? currentGroupPath.split('/').join(' / ')
    : 'All Groups';
  const searchPlaceholder = currentGroupPath
    ? `Search hosts inside ${currentGroupPathLabel}`
    : 'Search hosts or instances';
  const emptyMessage =
    hosts.length === 0
      ? '아직 등록된 호스트가 없습니다.'
      : searchQuery
        ? '검색 결과가 없습니다.'
        : '이 위치에는 아직 호스트가 없습니다.';
  const groupDeleteDialogVariant = groupDeleteTarget
    ? getGroupDeleteDialogVariant(groupDeleteTarget.childGroupCount, groupDeleteTarget.hostCount)
    : null;
  const hostDeleteUnusedLocalSecretRefs = useMemo(
    () =>
      hostDeleteTarget
        ? getUnusedSavedCredentialsAfterHostDeletion(
            hosts,
            keychainEntries,
            hostDeleteTarget.hostIds,
          )
        : [],
    [hostDeleteTarget, hosts, keychainEntries],
  );
  const contextMenuStyle = contextMenu
    ? {
        left: `${Math.max(12, Math.min(contextMenu.x, window.innerWidth - 172))}px`,
        top: `${Math.max(12, Math.min(contextMenu.y, window.innerHeight - 72))}px`,
      }
    : null;

  useEffect(() => {
    setCollapsedTreeGroupPaths((current) =>
      current.filter((path) => allGroupPaths.includes(path)),
    );
  }, [allGroupPaths]);

  useEffect(() => {
    setSelectedHostIds((current) =>
      current.filter((hostId) => visibleHostIds.includes(hostId)),
    );
  }, [visibleHostIds]);

  useEffect(() => {
    setSelectedGroupPaths((current) =>
      current.filter((groupPath) => visibleGroupPaths.includes(groupPath)),
    );
  }, [visibleGroupPaths]);

  useEffect(() => {
    if (hostSelectionAnchor && !visibleHostIds.includes(hostSelectionAnchor)) {
      setHostSelectionAnchor(null);
    }
  }, [hostSelectionAnchor, visibleHostIds]);

  useEffect(() => {
    if (groupSelectionAnchor && !visibleGroupPaths.includes(groupSelectionAnchor)) {
      setGroupSelectionAnchor(null);
    }
  }, [groupSelectionAnchor, visibleGroupPaths]);

  useEffect(() => {
    setExpandedHostTags((current) =>
      current.filter((hostId) =>
        hosts.some((host) => host.id === hostId && (host.tags?.length ?? 0) > 0),
      ),
    );
  }, [hosts]);

  useEffect(() => {
    // 태그가 사라지면 필터에서 제거.
    const known = new Set(tagCounts.map((entry) => entry.tag));
    setActiveTagFilter((current) => current.filter((tag) => known.has(tag)));
  }, [tagCounts]);

  useEffect(() => {
    setRemoveUnusedSecretsOnHostDelete(hostDeleteUnusedLocalSecretRefs.length > 0);
  }, [hostDeleteTarget, hostDeleteUnusedLocalSecretRefs.length]);

  useEffect(() => {
    if (!isImportMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!importMenuRef.current?.contains(event.target as Node)) {
        setIsImportMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsImportMenuOpen(false);
      }
    };
    const handleResize = () => setIsImportMenuOpen(false);
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [isImportMenuOpen]);

  function clearSelections() {
    setSelectedHostIds([]);
    setSelectedGroupPaths([]);
    setHostSelectionAnchor(null);
    setGroupSelectionAnchor(null);
    setContextMenu(null);
    onClearHostSelection();
  }

  function buildGroupDeleteTarget(groupPaths: string[]): GroupDeleteTarget {
    const normalizedPaths = normalizeGroupSelectionForDelete(groupPaths);
    const normalizedPathSet = new Set(normalizedPaths);
    const hostCount = hosts.filter((host) =>
      normalizedPaths.some((path) =>
        isGroupWithinPath(normalizeGroupPath(host.groupName), path),
      ),
    ).length;
    const childGroupCount = allGroupPaths.filter(
      (candidatePath) =>
        !normalizedPathSet.has(candidatePath) &&
        normalizedPaths.some((path) => candidatePath.startsWith(`${path}/`)),
    ).length;

    return {
      paths: normalizedPaths,
      groupCount: normalizedPaths.length,
      title:
        normalizedPaths.length === 1
          ? groups.find((group) => group.path === normalizedPaths[0])?.name ??
            normalizedPaths[0]
          : `${normalizedPaths.length} groups`,
      hostCount,
      childGroupCount,
    };
  }

  function buildHostDeleteTarget(hostIds: string[]): HostDeleteTarget {
    const orderedHostIds = getOrderedSelectedHostIds(hostIds);
    const targetHosts = orderedHostIds
      .map((hostId) => hosts.find((host) => host.id === hostId))
      .filter((host): host is HostRecord => Boolean(host));

    return {
      hostIds: targetHosts.map((host) => host.id),
      hostCount: targetHosts.length,
      title:
        targetHosts.length === 1
          ? targetHosts[0].label
          : `선택한 ${targetHosts.length}개 호스트`,
    };
  }

  function selectHostRange(hostId: string) {
    setSelectedHostIds(getSelectionRange(visibleHostIds, hostSelectionAnchor, hostId));
    setHostSelectionAnchor(hostId);
  }

  function toggleHostSelection(hostId: string) {
    setSelectedHostIds((current) => {
      const next = current.includes(hostId)
        ? current.filter((entry) => entry !== hostId)
        : [...current, hostId];
      if (next.length === 0) {
        onClearHostSelection();
      }
      return next;
    });
    setHostSelectionAnchor(hostId);
  }

  function selectSingleHost(hostId: string) {
    setSelectedHostIds([hostId]);
    setSelectedGroupPaths([]);
    setHostSelectionAnchor(hostId);
    setGroupSelectionAnchor(null);
    onSelectHost(hostId);
  }

  function handleHostSelection(
    hostId: string,
    event: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>,
  ) {
    setContextMenu(null);
    if (event.shiftKey) {
      selectHostRange(hostId);
      return;
    }
    if (isAdditiveSelectionEvent(event)) {
      toggleHostSelection(hostId);
      return;
    }
    // 이미 단독 선택된 호스트를 다시 누르면 선택을 해제한다(상세 패널을 닫고 빈 상태로).
    if (selectedHostIds.length === 1 && selectedHostIds[0] === hostId) {
      clearSelections();
      return;
    }
    selectSingleHost(hostId);
  }

  function selectGroupRange(groupPath: string) {
    setSelectedGroupPaths(getSelectionRange(visibleGroupPaths, groupSelectionAnchor, groupPath));
    setGroupSelectionAnchor(groupPath);
  }

  function toggleGroupSelection(groupPath: string) {
    setSelectedGroupPaths((current) =>
      current.includes(groupPath)
        ? current.filter((entry) => entry !== groupPath)
        : [...current, groupPath],
    );
    setGroupSelectionAnchor(groupPath);
  }

  function selectSingleGroup(groupPath: string) {
    setSelectedGroupPaths([groupPath]);
    setSelectedHostIds([]);
    setGroupSelectionAnchor(groupPath);
    setHostSelectionAnchor(null);
    onClearHostSelection();
  }

  function handleGroupSelection(
    groupPath: string,
    event: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>,
  ) {
    setContextMenu(null);
    if (event.shiftKey) {
      selectGroupRange(groupPath);
      return;
    }
    if (isAdditiveSelectionEvent(event)) {
      toggleGroupSelection(groupPath);
      return;
    }
    selectSingleGroup(groupPath);
    // 그룹을 고르면 즐겨찾기 스코프는 해제(즐겨찾기/그룹/All Hosts는 상호배타 스코프).
    setFavoritesFilterActive(false);
    onNavigateGroup(groupPath);
  }

  function handleNavigateRoot() {
    setContextMenu(null);
    setSelectedGroupPaths([]);
    setSelectedHostIds([]);
    setGroupSelectionAnchor(null);
    setHostSelectionAnchor(null);
    setFavoritesFilterActive(false);
    onClearHostSelection();
    onNavigateGroup(null);
  }

  function handleToggleGroupBranch(groupPath: string) {
    setCollapsedTreeGroupPaths((current) =>
      current.includes(groupPath)
        ? current.filter((path) => path !== groupPath)
        : [...current, groupPath],
    );
  }

  function getOrderedSelectedHostIds(hostIds: string[]): string[] {
    const selectedHostIdSet = new Set(hostIds);
    return visibleHostIds.filter((hostId) => selectedHostIdSet.has(hostId));
  }

  async function runForOrderedHosts(
    hostIds: string[],
    action: (hostId: string) => Promise<void>,
  ) {
    const orderedHostIds = getOrderedSelectedHostIds(hostIds);
    setContextMenu(null);
    for (const hostId of orderedHostIds) {
      await action(hostId);
    }
  }

  function applyGroupPathUiMutation(previousGroupPath: string, nextGroupPath: string) {
    setSelectedGroupPaths((current) => {
      const nextSelected = current
        .map((groupPath) => rebaseGroupPath(groupPath, previousGroupPath, nextGroupPath))
        .filter((groupPath): groupPath is string => Boolean(groupPath));
      return [...new Set(nextSelected)];
    });
    setGroupSelectionAnchor((current) =>
      rebaseGroupPath(current, previousGroupPath, nextGroupPath),
    );
    setCollapsedTreeGroupPaths((current) => {
      const nextCollapsed = current
        .map((groupPath) => rebaseGroupPath(groupPath, previousGroupPath, nextGroupPath))
        .filter((groupPath): groupPath is string => Boolean(groupPath));
      return [...new Set(nextCollapsed)];
    });
  }

  function openCreateGroupModal() {
    setGroupModalState({ mode: 'create' });
    setNewGroupName('');
    setGroupError(null);
  }

  function openCreateSubgroupModal(parentPath: string) {
    setGroupModalState({ mode: 'create', parentPath });
    setNewGroupName('');
    setGroupError(null);
  }

  function openRenameGroupModal(groupPath: string) {
    setGroupModalState({ mode: 'rename', path: groupPath });
    setNewGroupName(getGroupLabel(groupPath));
    setGroupError(null);
  }

  function closeGroupModal() {
    setGroupModalState(null);
    setNewGroupName('');
    setGroupError(null);
  }

  function clearDragState() {
    setDragTargetGroupPath(null);
    setDraggedHostIds([]);
    setDraggedGroupPath(null);
    setIsRootDragTarget(false);
  }

  const selectedHostIdSet = new Set(selectedHostIds);
  const selectedGroupPathSet = new Set(selectedGroupPaths);

  function getActiveDraggedHostIds(dataTransfer: DataTransfer): string[] {
    const stateHostIds = getOrderedSelectedHostIds(draggedHostIds);
    if (stateHostIds.length > 0) {
      return stateHostIds;
    }
    const payloadHostIds = getOrderedSelectedHostIds(
      parseHostDragIds(dataTransfer.getData(HOSTS_DRAG_MIME_TYPE)),
    );
    if (payloadHostIds.length > 0) {
      return payloadHostIds;
    }
    const singleHostId = dataTransfer.getData(HOST_DRAG_MIME_TYPE);
    return singleHostId ? getOrderedSelectedHostIds([singleHostId]) : [];
  }

  function getNextDraggedHostIds(host: HostRecord): string[] {
    if (!selectedHostIdSet.has(host.id)) {
      return [host.id];
    }
    const orderedSelectedHostIds = getOrderedSelectedHostIds(selectedHostIds);
    return orderedSelectedHostIds.length > 0 ? orderedSelectedHostIds : [host.id];
  }

  function toggleTagFilter(tag: string) {
    setActiveTagFilter((current) =>
      current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag],
    );
  }

  function toggleFavorite(hostId: string) {
    const host = hosts.find((entry) => entry.id === hostId);
    void params.onSetHostFavorite(hostId, !(host?.favorite === true));
  }

  function toggleFavoritesFilter() {
    const next = !favoritesFilterActive;
    setFavoritesFilterActive(next);
    if (next) {
      // 즐겨찾기는 그룹과 무관하게 전체에서 보여준다 → 그룹 스코프/선택을 해제.
      setSelectedGroupPaths([]);
      onClearHostSelection();
      onNavigateGroup(null);
    }
  }

  return {
    // passthrough params (callbacks + data used directly by the regions)
    ...params,
    // search / scope
    scopedHosts,
    searchPlaceholder,
    visibleHosts,
    visibleHostIds,
    emptyMessage,
    // tags / sort / view / favorites (UI only)
    tagCounts,
    activeTagFilter,
    toggleTagFilter,
    setActiveTagFilter,
    favoriteHostIds,
    favoriteHostIdSet,
    toggleFavorite,
    favoritesFilterActive,
    toggleFavoritesFilter,
    setFavoritesFilterActive,
    sortKey,
    setSortKey,
    sortDirection,
    setSort,
    toggleSort,
    lastConnectedByHostId,
    viewMode,
    setViewMode,
    // group tree
    allGroupPaths,
    groupTreeRows,
    visibleGroupTreeRows,
    visibleGroupPaths,
    collapsedTreeGroupPathSet,
    groupSortKey,
    setGroupSortKey,
    hideEmptyGroups,
    setHideEmptyGroups,
    expandAllGroups,
    collapseAllGroups,
    // selection state
    selectedHostIds,
    setSelectedHostIds,
    selectedGroupPaths,
    setSelectedGroupPaths,
    selectedHostIdSet,
    selectedGroupPathSet,
    setHostSelectionAnchor,
    setGroupSelectionAnchor,
    expandedHostTags,
    setExpandedHostTags,
    // selection handlers
    handleHostSelection,
    selectSingleHost,
    toggleHostSelection,
    selectHostRange,
    handleGroupSelection,
    selectSingleGroup,
    handleNavigateRoot,
    handleToggleGroupBranch,
    getOrderedSelectedHostIds,
    runForOrderedHosts,
    clearSelections,
    // drag state + helpers
    draggedGroupPath,
    setDraggedGroupPath,
    draggedHostIds,
    setDraggedHostIds,
    dragTargetGroupPath,
    setDragTargetGroupPath,
    isRootDragTarget,
    setIsRootDragTarget,
    getActiveDraggedHostIds,
    getNextDraggedHostIds,
    clearDragState,
    canReparentGroup,
    buildNextGroupPath,
    applyGroupPathUiMutation,
    setCollapsedTreeGroupPaths,
    // context menu
    contextMenu,
    setContextMenu,
    contextMenuStyle,
    // import menu
    isImportMenuOpen,
    setIsImportMenuOpen,
    importMenuRef,
    // grid
    hostGridRef,
    hostGridStyle,
    hostGridLayout,
    clampedHostCardStyle,
    // group modal
    groupModalState,
    openCreateGroupModal,
    openCreateSubgroupModal,
    openRenameGroupModal,
    closeGroupModal,
    newGroupName,
    setNewGroupName,
    groupError,
    setGroupError,
    // group delete
    groupDeleteTarget,
    setGroupDeleteTarget,
    buildGroupDeleteTarget,
    groupDeleteDialogVariant,
    groupDeleteError,
    setGroupDeleteError,
    isRemovingGroup,
    setIsRemovingGroup,
    // host delete
    hostDeleteTarget,
    setHostDeleteTarget,
    buildHostDeleteTarget,
    hostDeleteUnusedLocalSecretRefs,
    removeUnusedSecretsOnHostDelete,
    setRemoveUnusedSecretsOnHostDelete,
    hostDeleteError,
    setHostDeleteError,
    isRemovingHost,
    setIsRemovingHost,
    // exposed for clarity
    selectedHostId,
    currentGroupPath,
    hosts,
    groups,
  };
}

export type HostBrowserModel = ReturnType<typeof useHostBrowser>;
