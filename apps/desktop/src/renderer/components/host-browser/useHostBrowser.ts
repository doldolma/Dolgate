import type { CSSProperties } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import { resolveContextMenuPosition } from './contextMenuPosition';
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
import type { ParsedQuickSshCommand } from '@shared';
import type { DesktopPlatform } from '../DesktopWindowControls';
import { t } from '../../i18n';

export const HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX = 235;
export const HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX = 460;
export const HOME_BROWSER_CARD_GAP_PX = 13.6;
export const HOST_DRAG_MIME_TYPE = 'application/x-dolssh-host-id';
export const HOSTS_DRAG_MIME_TYPE = 'application/x-dolssh-host-ids';
export const GROUP_DRAG_MIME_TYPE = 'application/x-dolssh-group-path';

// Serial·RDP 는 여기 없다 — 가져오기가 아니라 새로 만들기라서, New Host 폼 맨 위의
// 종류 셀렉터(SSH/Serial/RDP)로 옮겼다.
export const HOST_BROWSER_IMPORT_MENU_LABELS = [
  'Import Dolgate',
  'Import OpenSSH',
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
    ? t('hostBrowserEmpty.noHostsHint')
    : searchQuery
      ? t('hostBrowserEmpty.searchHint')
      : t('hostBrowserEmpty.addHint');
}

export type HostSortKey = 'name' | 'recent' | 'group' | 'lastConnected';

// 그룹 사이드바 정렬: 이름순 / 최근 사용순 / 호스트 많은 순.
/**
 * `manual` 은 사용자가 끌어서 정한 순서다(GroupRecord.sortRank).
 *
 * 기본값이다. 아무도 순서를 바꾼 적이 없으면 랭크가 전부 비어 있고, 그때 비교 규칙은
 * 이름순으로 떨어지므로 **예전과 같은 화면**이 나온다. 기본을 'name' 으로 두면 끌었을 때
 * 아무 일도 일어나지 않아, 사용자가 정렬 메뉴를 먼저 찾아야 한다.
 */
export type GroupSortKey = 'manual' | 'name' | 'recent' | 'count';
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
  // 직접 순서는 들어온 배열이 이미 갖고 있다 — collectGroupPaths 가 랭크로 정렬하고
  // buildGroupTreeRows 가 그 순서를 유지한다. 여기서 다시 손대면 그 순서를 덮는다.
  if (sortKey === 'manual') {
    return rows;
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

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

export function getHostNavigationStep(
  key: string,
  columns: number,
): number | null {
  switch (key) {
    case 'ArrowLeft':
      return -1;
    case 'ArrowRight':
      return 1;
    case 'ArrowUp':
      return -columns;
    case 'ArrowDown':
      return columns;
    default:
      return null;
  }
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
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
  /**
   * 홈의 호스트 화면이 지금 보이는 화면인지. 홈 셸은 세션 탭이 활성일 때도 마운트된 채
   * 숨겨지기만 하므로, 창 전역 키 처리는 이 값을 봐야 터미널을 쓰는 중에 끼어들지 않는다.
   */
  active?: boolean;
  searchQuery: string;
  hostViewMode?: HostViewMode;
  selectedHostId: string | null;
  /**
   * 단일 선택을 상위가 막을 수 있게 한다. false 를 주면 내부 선택도 움직이지 않는다.
   *
   * 편집 중에는 상위가 "저장하지 않은 변경" 을 물어본 뒤에 선택을 옮긴다. 내부 상태만 먼저
   * 움직이면 목록 하이라이트와 우측 패널이 서로 다른 호스트를 가리킨다(실제로 그랬다).
   */
  canSelectHost?: (
    hostId: string,
    options?: { reason?: 'click' | 'menu' },
  ) => boolean;
  /**
   * 그룹 이동(그룹 카드·트리 클릭, All Hosts 복귀)을 상위가 가로챈다.
   *
   * **거부가 아니라 "이어서 실행" 이다.** 거부만 하면 확인을 받은 뒤 이동을 다시 실행할 주체가
   * 없어서 편집기만 닫히고 이동이 사라진다(실제로 그랬다). 상위는 물어볼 필요가 없으면 즉시,
   * 물어봤으면 사용자가 답한 뒤에 `proceed()` 를 부른다.
   */
  onLeaveGroupScope?: (proceed: () => void) => void;
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
  onOpenAwsImport: () => void;
  onOpenOpenSshImport: () => void;
  onOpenXshellImport: () => void;
  onOpenTermiusImport: () => void;
  onOpenWarpgateImport: () => void;
  onCreateGroup: (name: string, parentPath?: string | null) => Promise<void>;
  onRemoveGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  onMoveGroup: (path: string, targetParentPath: string | null) => Promise<void>;
  /** 직접 정렬에서 자리를 옮긴다(부모가 바뀌면 이동까지 함께). */
  onReorderGroup: (
    path: string,
    targetParentPath: string | null,
    targetIndex: number,
  ) => Promise<void>;
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
    canSelectHost,
    onLeaveGroupScope,
    onClearHostSelection,
    onSelectHost,
    onNavigateGroup,
    onMoveGroup,
    onReorderGroup,
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
  // 상위가 보관한 선택이 바뀌면 목록 하이라이트를 그것으로 맞춘다. 편집 중 전환처럼 상위가
  // 직접 선택을 옮기는 경로가 있어서, 내부 상태만 두면 둘이 어긋난 채로 남는다.
  useEffect(() => {
    setSelectedHostIds(selectedHostId ? [selectedHostId] : []);
  }, [selectedHostId]);
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
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenuStyle, setContextMenuStyle] = useState<CSSProperties | null>(
    null,
  );
  const [dragTargetGroupPath, setDragTargetGroupPath] = useState<string | null>(null);
  const [draggedHostIds, setDraggedHostIds] = useState<string[]>([]);
  const [draggedGroupPath, setDraggedGroupPath] = useState<string | null>(null);
  const [isRootDragTarget, setIsRootDragTarget] = useState(false);
  /**
   * 형제 사이에 놓을 자리 표시. `직접` 정렬일 때만 쓴다 — 다른 정렬에서는 놓아도 그 기준대로
   * 다시 배치되므로 있지도 않은 자리를 그리게 된다.
   */
  const [groupDropEdge, setGroupDropEdge] = useState<{
    path: string;
    edge: 'before' | 'after';
  } | null>(null);
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
  const [groupSortKey, setGroupSortKey] = useState<GroupSortKey>('manual');
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
      // 'audit' 은 이름 변경·자격 증명 저장 같은 편집 기록이고 그것도 metadata.hostId 를
      // 갖는다. 종류를 가리지 않으면 호스트를 고치기만 해도 "최근 접속"이 오늘로 바뀐다.
      if (log.category !== 'session') {
        continue;
      }
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

  /** 끌어서 순서를 바꿀 수 있는 상태인가. 다른 정렬에서는 놓자마자 제자리로 튄다. */
  const canReorderGroups = groupSortKey === 'manual';

  /**
   * "이 행 위/아래" 를 부모와 index 로 옮긴다.
   *
   * index 는 **끌고 있는 그룹을 뺀 뒤**의 형제 목록 기준이다 — 스토어의 planGroupReorder 가
   * 먼저 빼고 끼워 넣으므로, 그대로 세면 아래로 옮길 때 한 칸 어긋난다.
   */
  const resolveGroupDropTarget = useCallback(
    (rowPath: string, edge: 'before' | 'after', draggedPath: string) => {
      const row = sortedGroupTreeRows.find((candidate) => candidate.path === rowPath);
      if (!row) {
        return null;
      }
      const siblings = sortedGroupTreeRows.filter(
        (candidate) =>
          candidate.parentPath === row.parentPath && candidate.path !== draggedPath,
      );
      const anchor = siblings.findIndex((candidate) => candidate.path === rowPath);
      if (anchor < 0) {
        return null;
      }
      return {
        parentPath: row.parentPath,
        index: edge === 'before' ? anchor : anchor + 1,
      };
    },
    [sortedGroupTreeRows],
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
      ? t('hostBrowserEmpty.noHosts')
      : searchQuery
        ? t('hostBrowserEmpty.noResults')
        : t('hostBrowserEmpty.noHostsHere');
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
  /**
   * 메뉴가 뜨면 **실제로 렌더된 크기를 재서** 화면 안으로 접어 넣는다.
   *
   * 항목 수가 대상(호스트/그룹)과 선택 개수에 따라 달라지므로 상수 추정은 맞을 수가 없다 — 예전에는
   * 높이를 72px 로 어림해서, 목록 아래쪽 호스트를 우클릭하면 메뉴가 화면 밖으로 잘렸다.
   *
   * useLayoutEffect 라 paint 전에 보정 위치가 적용돼 깜빡임이 없다(SFTP 판의 메뉴와 같은 방식).
   */
  useLayoutEffect(() => {
    if (!contextMenu) {
      setContextMenuStyle(null);
      return;
    }
    const element = contextMenuRef.current;
    const placement = resolveContextMenuPosition({
      x: contextMenu.x,
      y: contextMenu.y,
      width: element?.offsetWidth || 196,
      // scrollHeight 를 함께 본다: 앞서 열린 메뉴가 화면보다 커서 maxHeight 로 접혔다면 이번 첫
      // 프레임에도 그 값이 남아 있어 offsetHeight 가 접힌 높이로 나온다. 그 값으로 자리를 잡으면
      // 실제보다 짧다고 보고 아래로 펼쳐서 다시 잘린다.
      height: Math.max(element?.scrollHeight ?? 0, element?.offsetHeight ?? 0) || 220,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setContextMenuStyle({
      left: placement.left,
      top: placement.top,
      maxHeight: placement.maxHeight,
      // 화면보다 큰 메뉴만 스크롤된다. 잘라 버리면 마지막 항목을 누를 방법이 없다.
      overflowY: 'auto',
    });
  }, [contextMenu]);

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

  const keyboardActive = params.active !== false;

  useEffect(() => {
    if (!keyboardActive) {
      return;
    }
    const handleSelectAllHosts = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        (!event.metaKey && !event.ctrlKey) ||
        event.key.toLocaleLowerCase() !== 'a' ||
        isEditableKeyboardTarget(event.target) ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        return;
      }

      event.preventDefault();
      setSelectedHostIds(visibleHostIds);
      setSelectedGroupPaths([]);
      setHostSelectionAnchor(visibleHostIds[0] ?? null);
      setGroupSelectionAnchor(null);
      setContextMenu(null);
    };

    window.addEventListener('keydown', handleSelectAllHosts);
    return () => window.removeEventListener('keydown', handleSelectAllHosts);
  }, [keyboardActive, visibleHostIds]);

  // 선택된 호스트를 화살표로 옮긴다. 카드가 DOM 포커스를 갖고 있지 않아도 동작해야 한다 —
  // 사용자가 보고 있는 것은 "선택된 호스트"이고, 클릭 외에 커맨드 팔레트·정렬 변경으로도
  // 선택이 생긴다. 가드는 위 전체 선택(Cmd+A) 핸들러와 같은 규칙이다: 검색 입력에서는
  // 팔레트가 화살표를 쓰므로 넘기고, 모달이 떠 있으면 관여하지 않는다.
  useEffect(() => {
    if (!keyboardActive) {
      return;
    }
    const handleArrowNavigation = (event: KeyboardEvent) => {
      const step = getHostNavigationStep(
        event.key,
        // 목록(테이블)은 한 줄에 하나뿐이라 좌우로 옮길 자리가 없다.
        viewMode === 'list' ? 1 : Math.max(1, hostGridLayout.columns),
      );
      if (
        step === null ||
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        isEditableKeyboardTarget(event.target) ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        return;
      }
      // 여러 개를 고른 상태에서 화살표를 누르면 무엇을 기준으로 옮길지 정할 수 없다 —
      // 선택을 하나로 줄여 버리는 대신 아무것도 하지 않는다.
      if (selectedGroupPaths.length > 0 || selectedHostIds.length > 1) {
        return;
      }
      const currentHostId = selectedHostIds[0] ?? selectedHostId;
      if (!currentHostId) {
        return;
      }
      const currentIndex = visibleHostIds.indexOf(currentHostId);
      if (currentIndex < 0) {
        return;
      }
      // 끝에서는 멈춘다 — 순환시키면 목록 반대편으로 튀어 어디로 갔는지 놓친다.
      const nextIndex = Math.min(
        Math.max(currentIndex + step, 0),
        visibleHostIds.length - 1,
      );
      event.preventDefault();
      if (nextIndex === currentIndex) {
        return;
      }
      const nextHostId = visibleHostIds[nextIndex];
      selectSingleHost(nextHostId);
      // 다음 칠 때까지 기다린 뒤 화면 안으로 끌어오고 포커스를 옮긴다. 스크롤이 없으면
      // 목록을 벗어난 순간 선택이 어디로 갔는지 보이지 않고, 포커스를 옮기지 않으면
      // Enter(연결)가 여전히 이전 카드로 간다.
      requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>(
          `[data-host-id="${cssEscape(nextHostId)}"]`,
        );
        // jsdom 에는 scrollIntoView 가 없다 — 테스트에서 rAF 안에서 터지면 실행 뒤에
        // 잡히지 않는 예외가 된다.
        element?.scrollIntoView?.({ block: 'nearest' });
        element?.focus?.({ preventScroll: true });
      });
    };

    window.addEventListener('keydown', handleArrowNavigation);
    return () => window.removeEventListener('keydown', handleArrowNavigation);
    // selectSingleHost 는 매 렌더 새로 만들어지므로 목록에 넣어도 재등록 빈도는 같다.
    // 핸들러가 읽는 값만 적어 무엇에 의존하는지 드러낸다.
  }, [
    hostGridLayout.columns,
    keyboardActive,
    selectedGroupPaths,
    selectedHostId,
    selectedHostIds,
    viewMode,
    visibleHostIds,
  ]);

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

  function getHostIdsInGroupTrees(groupPaths: string[]): string[] {
    const normalizedPaths = normalizeGroupSelectionForDelete(groupPaths);
    return hosts
      .filter((host) =>
        normalizedPaths.some((path) =>
          isGroupWithinPath(normalizeGroupPath(host.groupName), path),
        ),
      )
      .map((host) => host.id);
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
          : t('hostBrowserEmpty.selectedHosts', { count: targetHosts.length }),
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

  /**
   * 호스트 하나를 단독 선택한다.
   *
   * `reason` 은 상위가 판단을 달리할 근거다 — 우클릭(menu)으로 선택이 옮겨가는 것과 좌클릭으로
   * 옮겨가는 것은 편집 중일 때 뜻이 다르다(메뉴를 열려던 동작이 확인 창을 띄우면 안 된다).
   */
  function selectSingleHost(hostId: string, reason: 'click' | 'menu' = 'click') {
    if (canSelectHost && !canSelectHost(hostId, { reason })) {
      return;
    }
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
    // 이미 단독 선택된 그룹을 다시 누르면 선택을 해제하고 루트로 복귀한다(호스트 재클릭 해제와 동일한 UX).
    if (selectedGroupPaths.length === 1 && selectedGroupPaths[0] === groupPath) {
      handleNavigateRoot();
      return;
    }
    // 상위가 편집 중이면 확인을 받은 뒤에 이 계속(continuation)을 부른다. 내부 상태 변경도 그
    // 안에 있어서, 확인 중에 하이라이트만 먼저 움직이는 일이 없다.
    leaveGroupScope(() => {
      selectSingleGroup(groupPath);
      // 그룹을 고르면 즐겨찾기 스코프는 해제(즐겨찾기/그룹/All Hosts는 상호배타 스코프).
      setFavoritesFilterActive(false);
      onNavigateGroup(groupPath);
    });
  }

  /** 편집 중이면 상위가 물어본 뒤에 이어서 실행한다. 편집 중이 아니면 그 자리에서 실행한다. */
  function leaveGroupScope(proceed: () => void) {
    if (onLeaveGroupScope) {
      onLeaveGroupScope(proceed);
      return;
    }
    proceed();
  }

  function handleNavigateRoot() {
    setContextMenu(null);
    leaveGroupScope(() => {
      setSelectedGroupPaths([]);
      setSelectedHostIds([]);
      setGroupSelectionAnchor(null);
      setHostSelectionAnchor(null);
      setFavoritesFilterActive(false);
      onClearHostSelection();
      onNavigateGroup(null);
    });
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
    getHostIdsInGroupTrees,
    clearSelections,
    // drag state + helpers
    draggedGroupPath,
    setDraggedGroupPath,
    draggedHostIds,
    setDraggedHostIds,
    dragTargetGroupPath,
    setDragTargetGroupPath,
    groupDropEdge,
    setGroupDropEdge,
    onReorderGroup,
    canReorderGroups,
    resolveGroupDropTarget,
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
    // 크기를 재려면 실제 노드가 필요하다(항목 수가 대상마다 다르다).
    contextMenuRef,
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
