import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Fuse from 'fuse.js';
import {
  collectGroupPaths,
  countHostsInGroupTree,
  filterHostsInGroupTree,
  getAwsEc2HostSshMetadataStatusLabel,
  getGroupDeleteDialogVariant,
  getGroupLabel,
  getParentGroupPath,
  getHostBadgeLabel,
  getHostSearchText,
  getHostSubtitle,
  getHostTagsToggleLabel,
  isGroupWithinPath,
  normalizeGroupPath,
  rebaseGroupPath
} from '@shared';
import type { GroupRecord, GroupRemoveMode, HostRecord } from '@shared';
import { useResponsiveCardGrid } from '../lib/useResponsiveCardGrid';
import { cn } from '../lib/cn';
import { DialogBackdrop } from './DialogBackdrop';
import { HostCard } from './HostCard';
import type { DesktopPlatform } from './DesktopWindowControls';
import {
  Button,
  EmptyState,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  SplitButton,
  SplitButtonMain,
  SplitButtonMenu,
  SplitButtonMenuItem,
  SplitButtonToggle,
} from '../ui';

export {
  buildVisibleGroups,
  collectGroupPaths,
  filterHostsInGroupTree,
  getGroupDeleteDialogVariant,
  getGroupLabel,
  getHostTagsToggleLabel,
  getParentGroupPath,
  isDirectHostChild,
  isGroupWithinPath,
  normalizeGroupPath,
  rebaseGroupPath
} from '@shared';

export const HOST_BROWSER_IMPORT_MENU_LABELS = [
  'Import via AWS SSM',
  'Import OpenSSH',
  'Import from Xshell',
  'Import from Termius',
  'Import from Warpgate'
] as const;

export function getHostBrowserVisibleImportMenuLabels(desktopPlatform: DesktopPlatform): string[] {
  return desktopPlatform === 'win32'
    ? [...HOST_BROWSER_IMPORT_MENU_LABELS]
    : HOST_BROWSER_IMPORT_MENU_LABELS.filter((label) => label !== 'Import from Xshell');
}

export function getHostBrowserEmptyCalloutMessage(hostCount: number, searchQuery: string): string {
  return hostCount === 0 ? 'New Host 또는 Import 메뉴를 눌러 첫 번째 연결 대상을 추가해보세요.' : searchQuery ? '검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.' : 'New Host를 눌러 이 위치에 호스트를 추가하거나, 다른 그룹으로 이동해 장치를 확인해보세요.';
}

const HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX = 280;
const HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX = 460;
const HOME_BROWSER_CARD_GAP_PX = 13.6;

interface GroupDeleteTarget {
  paths: string[];
  groupCount: number;
  title: string;
  hostCount: number;
  childGroupCount: number;
}

interface HostDeleteTarget {
  hostIds: string[];
  title: string;
  hostCount: number;
}

interface HostContextMenuState {
  kind: 'host';
  hostIds: string[];
  x: number;
  y: number;
}

interface GroupContextMenuState {
  kind: 'group';
  groupPaths: string[];
  x: number;
  y: number;
}

type ContextMenuState = HostContextMenuState | GroupContextMenuState;

type GroupModalState =
  | { mode: 'create' }
  | { mode: 'rename'; path: string };

interface GroupTreeRow {
  path: string;
  label: string;
  depth: number;
  parentPath: string | null;
  hasChildren: boolean;
  hostCount: number;
}

function buildGroupTreeRows(
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
    parentPath: normalizeGroupPath(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null),
    hasChildren: [...groupPathSet].some((candidate) => candidate.startsWith(`${path}/`)),
    hostCount: countHostsInGroupTree(hosts, path),
  }));
}

function isAdditiveSelectionEvent(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'> | Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return event.ctrlKey || event.metaKey;
}

function getSelectionRange<T extends string>(items: T[], anchor: T | null, target: T): T[] {
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

function normalizeGroupSelectionForDelete(groupPaths: string[]): string[] {
  return [...groupPaths]
    .filter((path) => !groupPaths.some((candidate) => candidate !== path && isGroupWithinPath(path, candidate)))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
}

function buildNextGroupPath(groupPath: string, targetParentPath: string | null): string | null {
  const normalizedGroupPath = normalizeGroupPath(groupPath);
  if (!normalizedGroupPath) {
    return null;
  }
  const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
  return normalizeGroupPath(
    normalizedTargetParentPath ? `${normalizedTargetParentPath}/${getGroupLabel(normalizedGroupPath)}` : getGroupLabel(normalizedGroupPath)
  );
}

function canReparentGroup(groupPath: string, targetParentPath: string | null): boolean {
  const normalizedGroupPath = normalizeGroupPath(groupPath);
  const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
  if (!normalizedGroupPath) {
    return false;
  }
  if (normalizedTargetParentPath && isGroupWithinPath(normalizedTargetParentPath, normalizedGroupPath)) {
    return false;
  }
  const nextGroupPath = buildNextGroupPath(normalizedGroupPath, normalizedTargetParentPath);
  return Boolean(nextGroupPath && nextGroupPath !== normalizedGroupPath);
}

interface HostBrowserProps {
  desktopPlatform: DesktopPlatform;
  hosts: HostRecord[];
  groups: GroupRecord[];
  currentGroupPath: string | null;
  searchQuery: string;
  selectedHostId: string | null;
  errorMessage?: string | null;
  statusMessage?: string | null;
  onSearchChange: (query: string) => void;
  onOpenLocalTerminal: () => void;
  onCreateHost: () => void;
  onOpenAwsImport: () => void;
  onOpenOpenSshImport: () => void;
  onOpenXshellImport: () => void;
  onOpenTermiusImport: () => void;
  onOpenWarpgateImport: () => void;
  onCreateGroup: (name: string) => Promise<void>;
  onRemoveGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  onMoveGroup: (path: string, targetParentPath: string | null) => Promise<void>;
  onRenameGroup: (path: string, name: string) => Promise<void>;
  onNavigateGroup: (path: string | null) => void;
  onClearHostSelection: () => void;
  onSelectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onDuplicateHosts: (hostIds: string[]) => Promise<void>;
  onMoveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  onRemoveHost: (hostId: string) => Promise<void>;
  onConnectHost: (hostId: string) => Promise<void>;
  onOpenHostContainers: (hostId: string) => Promise<void>;
}

export function HostBrowser({
  desktopPlatform,
  hosts,
  groups,
  currentGroupPath,
  searchQuery,
  selectedHostId,
  errorMessage = null,
  statusMessage = null,
  onSearchChange,
  onOpenLocalTerminal,
  onCreateHost,
  onOpenAwsImport,
  onOpenOpenSshImport,
  onOpenXshellImport,
  onOpenTermiusImport,
  onOpenWarpgateImport,
  onCreateGroup,
  onRemoveGroup,
  onMoveGroup,
  onRenameGroup,
  onNavigateGroup,
  onClearHostSelection,
  onSelectHost,
  onEditHost,
  onDuplicateHosts,
  onMoveHostToGroup,
  onRemoveHost,
  onConnectHost,
  onOpenHostContainers
}: HostBrowserProps) {
  const [groupModalState, setGroupModalState] = useState<GroupModalState | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupError, setGroupError] = useState<string | null>(null);
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>([]);
  const [selectedGroupPaths, setSelectedGroupPaths] = useState<string[]>([]);
  const [hostSelectionAnchor, setHostSelectionAnchor] = useState<string | null>(null);
  const [groupSelectionAnchor, setGroupSelectionAnchor] = useState<string | null>(null);
  const [groupDeleteTarget, setGroupDeleteTarget] = useState<GroupDeleteTarget | null>(null);
  const [groupDeleteError, setGroupDeleteError] = useState<string | null>(null);
  const [isRemovingGroup, setIsRemovingGroup] = useState(false);
  const [hostDeleteTarget, setHostDeleteTarget] = useState<HostDeleteTarget | null>(null);
  const [hostDeleteError, setHostDeleteError] = useState<string | null>(null);
  const [isRemovingHost, setIsRemovingHost] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragTargetGroupPath, setDragTargetGroupPath] = useState<string | null>(null);
  const [draggedHostId, setDraggedHostId] = useState<string | null>(null);
  const [draggedGroupPath, setDraggedGroupPath] = useState<string | null>(null);
  const [isRootDragTarget, setIsRootDragTarget] = useState(false);
  const [expandedHostTags, setExpandedHostTags] = useState<string[]>([]);
  const [isImportMenuOpen, setIsImportMenuOpen] = useState(false);
  const [collapsedTreeGroupPaths, setCollapsedTreeGroupPaths] = useState<string[]>([]);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  const importMenuItems = useMemo(
    () =>
      [
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[0], onSelect: onOpenAwsImport },
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[1], onSelect: onOpenOpenSshImport },
        ...(desktopPlatform === 'win32' ? [{ label: HOST_BROWSER_IMPORT_MENU_LABELS[2], onSelect: onOpenXshellImport }] : []),
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[3], onSelect: onOpenTermiusImport },
        { label: HOST_BROWSER_IMPORT_MENU_LABELS[4], onSelect: onOpenWarpgateImport }
      ],
    [desktopPlatform, onOpenAwsImport, onOpenOpenSshImport, onOpenTermiusImport, onOpenWarpgateImport, onOpenXshellImport]
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const close = () => {
      setContextMenu(null);
    };

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
  const scopedHosts = useMemo(() => filterHostsInGroupTree(hosts, currentGroupPath), [currentGroupPath, hosts]);

  const searchableHosts = useMemo(
    () =>
      scopedHosts.map((host) => ({
        ...host,
        searchText: getHostSearchText(host).join(' ')
      })),
    [scopedHosts]
  );

  const fuse = useMemo(
    () =>
      new Fuse(searchableHosts, {
        keys: ['label', 'groupName', 'searchText'],
        threshold: 0.32
      }),
    [searchableHosts]
  );

  const visibleHosts = useMemo(() => {
    if (searchQuery) {
      return fuse.search(searchQuery).map((result) => {
        const { searchText: _searchText, ...host } = result.item;
        return host;
      });
    }
    return searchableHosts;
  }, [currentGroupPath, fuse, searchableHosts, searchQuery]);

  const allGroupPaths = useMemo(() => collectGroupPaths(groups, hosts), [groups, hosts]);
  const groupTreeRows = useMemo(() => buildGroupTreeRows(allGroupPaths, groups, hosts), [allGroupPaths, groups, hosts]);
  const collapsedTreeGroupPathSet = useMemo(() => new Set(collapsedTreeGroupPaths), [collapsedTreeGroupPaths]);
  const visibleGroupTreeRows = useMemo(
    () =>
      groupTreeRows.filter((group) => {
        let ancestorPath = group.parentPath;
        while (ancestorPath) {
          if (collapsedTreeGroupPathSet.has(ancestorPath)) {
            return false;
          }
          ancestorPath = normalizeGroupPath(ancestorPath.includes('/') ? ancestorPath.slice(0, ancestorPath.lastIndexOf('/')) : null);
        }
        return true;
      }),
    [collapsedTreeGroupPathSet, groupTreeRows]
  );
  const visibleHostIds = useMemo(() => visibleHosts.map((host) => host.id), [visibleHosts]);
  const visibleGroupPaths = useMemo(() => visibleGroupTreeRows.map((group) => group.path), [visibleGroupTreeRows]);
  const { ref: hostGridRef, style: hostGridStyle, layout: hostGridLayout } = useResponsiveCardGrid({
    itemCount: visibleHosts.length,
    minWidth: HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX,
    maxWidth: HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX,
    gap: HOME_BROWSER_CARD_GAP_PX
  });
  const clampedHostCardStyle =
    hostGridLayout.justifyContent === 'start' && hostGridLayout.cardWidth
      ? { width: '100%', maxWidth: `${hostGridLayout.cardWidth}px` }
      : undefined;
  const currentGroupPathLabel = currentGroupPath ? currentGroupPath.split('/').join(' / ') : 'All Groups';
  const searchPlaceholder = currentGroupPath ? `Search hosts inside ${currentGroupPathLabel}` : 'Search hosts or instances';
  const emptyMessage = hosts.length === 0 ? '아직 등록된 호스트가 없습니다.' : searchQuery ? '검색 결과가 없습니다.' : '이 위치에는 아직 호스트가 없습니다.';
  const groupDeleteDialogVariant = groupDeleteTarget
    ? getGroupDeleteDialogVariant(groupDeleteTarget.childGroupCount, groupDeleteTarget.hostCount)
    : null;
  const contextMenuStyle = contextMenu
    ? {
        left: `${Math.max(12, Math.min(contextMenu.x, window.innerWidth - 172))}px`,
        top: `${Math.max(12, Math.min(contextMenu.y, window.innerHeight - 72))}px`
      }
    : null;

  useEffect(() => {
    setCollapsedTreeGroupPaths((current) => current.filter((path) => allGroupPaths.includes(path)));
  }, [allGroupPaths]);

  useEffect(() => {
    setSelectedHostIds((current) => current.filter((hostId) => visibleHostIds.includes(hostId)));
  }, [visibleHostIds]);

  useEffect(() => {
    setSelectedGroupPaths((current) => current.filter((groupPath) => visibleGroupPaths.includes(groupPath)));
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
    setExpandedHostTags((current) => current.filter((hostId) => hosts.some((host) => host.id === hostId && (host.tags?.length ?? 0) > 0)));
  }, [hosts]);

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

    const handleResize = () => {
      setIsImportMenuOpen(false);
    };

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
      normalizedPaths.some((path) => isGroupWithinPath(normalizeGroupPath(host.groupName), path))
    ).length;
    const childGroupCount = allGroupPaths.filter(
      (candidatePath) =>
        !normalizedPathSet.has(candidatePath) &&
        normalizedPaths.some((path) => candidatePath.startsWith(`${path}/`))
    ).length;

    return {
      paths: normalizedPaths,
      groupCount: normalizedPaths.length,
      title:
        normalizedPaths.length === 1
          ? groups.find((group) => group.path === normalizedPaths[0])?.name ?? normalizedPaths[0]
          : `${normalizedPaths.length} groups`,
      hostCount,
      childGroupCount
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
          : `선택한 ${targetHosts.length}개 호스트`
    };
  }

  function selectHostRange(hostId: string) {
    setSelectedHostIds(getSelectionRange(visibleHostIds, hostSelectionAnchor, hostId));
    setHostSelectionAnchor(hostId);
  }

  function toggleHostSelection(hostId: string) {
    setSelectedHostIds((current) => {
      const next = current.includes(hostId) ? current.filter((entry) => entry !== hostId) : [...current, hostId];
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

  function handleHostSelection(hostId: string, event: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>) {
    setContextMenu(null);
    if (event.shiftKey) {
      selectHostRange(hostId);
      return;
    }
    if (isAdditiveSelectionEvent(event)) {
      toggleHostSelection(hostId);
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
      current.includes(groupPath) ? current.filter((entry) => entry !== groupPath) : [...current, groupPath]
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

  function handleGroupSelection(groupPath: string, event: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>) {
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
    onNavigateGroup(groupPath);
  }

  function handleNavigateRoot() {
    setContextMenu(null);
    setSelectedGroupPaths([]);
    setSelectedHostIds([]);
    setGroupSelectionAnchor(null);
    setHostSelectionAnchor(null);
    onClearHostSelection();
    onNavigateGroup(null);
  }

  function handleToggleGroupBranch(groupPath: string) {
    setCollapsedTreeGroupPaths((current) =>
      current.includes(groupPath) ? current.filter((path) => path !== groupPath) : [...current, groupPath]
    );
  }

  function getOrderedSelectedHostIds(hostIds: string[]): string[] {
    const selectedHostIdSet = new Set(hostIds);
    return visibleHostIds.filter((hostId) => selectedHostIdSet.has(hostId));
  }

  function handleBrowserBackgroundClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (
      target.closest('[data-host-card="true"]') ||
      target.closest('[data-group-card="true"]') ||
      target.closest('[role="menu"]') ||
      target.closest('button') ||
      target.closest('input') ||
      target.closest('[data-host-browser-modal="true"]')
    ) {
      return;
    }
    clearSelections();
  }

  function applyGroupPathUiMutation(previousGroupPath: string, nextGroupPath: string) {
    setSelectedGroupPaths((current) => {
      const nextSelected = current
        .map((groupPath) => rebaseGroupPath(groupPath, previousGroupPath, nextGroupPath))
        .filter((groupPath): groupPath is string => Boolean(groupPath));
      return [...new Set(nextSelected)];
    });
    setGroupSelectionAnchor((current) => rebaseGroupPath(current, previousGroupPath, nextGroupPath));
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
    setDraggedHostId(null);
    setDraggedGroupPath(null);
    setIsRootDragTarget(false);
  }

  const selectedHostIdSet = new Set(selectedHostIds);
  const selectedGroupPathSet = new Set(selectedGroupPaths);

  return (
    <div
      className="relative flex min-h-full flex-1 flex-col gap-5 [--home-browser-card-min-width:280px] [--home-browser-tree-width:clamp(10.5rem,14vw,12.5rem)]"
      onClickCapture={handleBrowserBackgroundClick}
    >
      <div className="flex items-end gap-4 pb-[0.8rem] pt-[0.2rem] max-[760px]:flex-col max-[760px]:items-stretch">
        <div className="flex-1">
          <input
            id="host-search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search hosts"
          />
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            variant="secondary"
            onClick={() => {
              setIsImportMenuOpen(false);
              onOpenLocalTerminal();
            }}
          >
            TERMINAL
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setIsImportMenuOpen(false);
              openCreateGroupModal();
            }}
          >
            New Group
          </Button>
          <SplitButton ref={importMenuRef}>
            <SplitButtonMain
              onClick={() => {
                setIsImportMenuOpen(false);
                onCreateHost();
              }}
            >
              New Host
            </SplitButtonMain>
            <SplitButtonToggle
              aria-label="Open import menu"
              aria-expanded={isImportMenuOpen}
              aria-haspopup="menu"
              onClick={() => {
                setIsImportMenuOpen((current) => !current);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setIsImportMenuOpen((current) => !current);
                }
              }}
            >
              <span
                className={cn(
                  'inline-grid h-[0.72rem] w-[0.98rem] place-items-center transition-transform duration-140',
                  isImportMenuOpen && 'rotate-180',
                )}
                aria-hidden="true"
              >
                <svg viewBox="0 0 12 8" focusable="false" className="block h-full w-full">
                  <path d="M1 1.25 6 6.25 11 1.25" />
                </svg>
              </span>
            </SplitButtonToggle>
            {isImportMenuOpen ? (
              <SplitButtonMenu role="menu" aria-label="Import host menu">
                {importMenuItems.map((item) => (
                  <SplitButtonMenuItem
                    key={item.label}
                    role="menuitem"
                    onClick={() => {
                      setIsImportMenuOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </SplitButtonMenuItem>
                ))}
              </SplitButtonMenu>
            ) : null}
          </SplitButton>
        </div>
      </div>

      {statusMessage ? (
        <NoticeCard tone="info" className="mb-4">
          {statusMessage}
        </NoticeCard>
      ) : null}
      {errorMessage ? (
        <NoticeCard tone="danger" className="mb-4" role="alert">
          {errorMessage}
        </NoticeCard>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,var(--home-browser-tree-width))_minmax(0,1fr)] items-stretch gap-[1.3rem] min-[0px]:min-w-0 max-[1040px]:grid-cols-1">
        <aside className="flex min-h-0 flex-col gap-[0.85rem] pt-[0.15rem]" aria-label="Group tree">
          <div className="flex items-center justify-between text-[0.75rem] font-bold uppercase tracking-[0.08em] text-[var(--text-soft)]">
            <span>Group Tree</span>
          </div>
          <button
            type="button"
            className={cn(
              'flex w-full min-w-0 items-center justify-between gap-3 rounded-[18px] border border-transparent bg-transparent px-[0.4rem] py-[0.45rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color,box-shadow] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]',
              currentGroupPath === null &&
                'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]',
              isRootDragTarget &&
                'border-[var(--selection-border)] bg-[var(--selection-tint-strong)]',
            )}
            onClick={handleNavigateRoot}
            onDragOver={(event) => {
              const activeDraggedGroupPath =
                draggedGroupPath ?? normalizeGroupPath(event.dataTransfer.getData('application/x-dolssh-group-path'));
              if (!activeDraggedGroupPath || !canReparentGroup(activeDraggedGroupPath, null)) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setIsRootDragTarget(true);
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                return;
              }
              setIsRootDragTarget(false);
            }}
            onDrop={async (event) => {
              const activeDraggedGroupPath =
                draggedGroupPath ?? normalizeGroupPath(event.dataTransfer.getData('application/x-dolssh-group-path'));
              setIsRootDragTarget(false);
              if (!activeDraggedGroupPath || !canReparentGroup(activeDraggedGroupPath, null)) {
                return;
              }
              event.preventDefault();
              const nextGroupPath = buildNextGroupPath(activeDraggedGroupPath, null);
              if (!nextGroupPath) {
                return;
              }
              try {
                await onMoveGroup(activeDraggedGroupPath, null);
                applyGroupPathUiMutation(activeDraggedGroupPath, nextGroupPath);
              } catch {
                // HomeShell surfaces the error through the shared notice area.
              } finally {
                clearDragState();
              }
            }}
          >
            <span>All Groups</span>
            <span className="shrink-0 text-[0.74rem] font-semibold text-[var(--text-muted)]">{hosts.length}</span>
          </button>
          {groupTreeRows.length === 0 ? (
            <div className="px-[0.2rem] py-[0.75rem] text-[0.8rem] leading-[1.45] text-[var(--text-soft)]">
              아직 만든 그룹이 없습니다.
            </div>
          ) : (
            <div className="flex flex-col gap-[0.15rem]">
              {visibleGroupTreeRows.map((group) => (
                <div
                  key={group.path}
                  className="flex min-w-0 items-center gap-[0.1rem]"
                  style={{ paddingLeft: `calc(${group.depth} * 1rem)` }}
                >
                  {group.hasChildren ? (
                    <button
                      type="button"
                      className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-[0.8rem] leading-none text-[var(--text-muted)] hover:text-[var(--text)]"
                      aria-label={collapsedTreeGroupPathSet.has(group.path) ? 'Expand subgroup' : 'Collapse subgroup'}
                      onClick={() => {
                        handleToggleGroupBranch(group.path);
                      }}
                    >
                      <span aria-hidden="true">{collapsedTreeGroupPathSet.has(group.path) ? '▸' : '▾'}</span>
                    </button>
                  ) : (
                    <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    className={cn(
                      'flex w-full min-w-0 items-center justify-between gap-3 rounded-[18px] border border-transparent bg-transparent px-[0.4rem] py-[0.45rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color,box-shadow] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]',
                      currentGroupPath === group.path &&
                        'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]',
                      !currentGroupPath && selectedGroupPathSet.has(group.path) && 'text-[var(--text)]',
                      selectedGroupPathSet.has(group.path) &&
                        currentGroupPath !== group.path &&
                        'bg-[color-mix(in_srgb,var(--surface-elevated)_66%,transparent_34%)]',
                      dragTargetGroupPath === group.path &&
                        'border-[var(--selection-border)] bg-[var(--selection-tint-strong)]',
                    )}
                    data-group-tree-state={selectedGroupPathSet.has(group.path) ? 'selected' : 'idle'}
                    draggable
                    onClick={(event) => handleGroupSelection(group.path, event)}
                    onDragStart={(event) => {
                      selectSingleGroup(group.path);
                      setDraggedHostId(null);
                      setDraggedGroupPath(group.path);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-dolssh-group-path', group.path);
                      event.dataTransfer.setData('text/plain', group.label);
                    }}
                    onDragEnd={() => {
                      clearDragState();
                    }}
                    onDoubleClick={() => {
                      if (group.hasChildren) {
                        handleToggleGroupBranch(group.path);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const nextGroupPaths = selectedGroupPathSet.has(group.path)
                        ? selectedGroupPaths
                        : [group.path];
                      if (!selectedGroupPathSet.has(group.path)) {
                        setSelectedGroupPaths([group.path]);
                        setSelectedHostIds([]);
                        setGroupSelectionAnchor(group.path);
                        setHostSelectionAnchor(null);
                        onClearHostSelection();
                      }
                      setContextMenu({
                        kind: 'group',
                        groupPaths: normalizeGroupSelectionForDelete(nextGroupPaths),
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    onDragOver={(event) => {
                      const activeDraggedHostId =
                        draggedHostId ?? event.dataTransfer.getData('application/x-dolssh-host-id');
                      const activeDraggedGroupPath =
                        draggedGroupPath ?? normalizeGroupPath(event.dataTransfer.getData('application/x-dolssh-group-path'));
                      if (!activeDraggedHostId && (!activeDraggedGroupPath || !canReparentGroup(activeDraggedGroupPath, group.path))) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setIsRootDragTarget(false);
                      setDragTargetGroupPath(group.path);
                    }}
                    onDragLeave={(event) => {
                      const nextTarget = event.relatedTarget;
                      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                        return;
                      }
                      setDragTargetGroupPath((current) => (current === group.path ? null : current));
                    }}
                    onDrop={async (event) => {
                      const activeDraggedHostId =
                        draggedHostId ?? event.dataTransfer.getData('application/x-dolssh-host-id');
                      const activeDraggedGroupPath =
                        draggedGroupPath ?? normalizeGroupPath(event.dataTransfer.getData('application/x-dolssh-group-path'));
                      setDragTargetGroupPath(null);
                      setIsRootDragTarget(false);
                      if (activeDraggedHostId) {
                        event.preventDefault();
                        await onMoveHostToGroup(activeDraggedHostId, group.path);
                        clearDragState();
                        return;
                      }
                      if (!activeDraggedGroupPath || !canReparentGroup(activeDraggedGroupPath, group.path)) {
                        return;
                      }
                      event.preventDefault();
                      const nextGroupPath = buildNextGroupPath(activeDraggedGroupPath, group.path);
                      if (!nextGroupPath) {
                        return;
                      }
                      try {
                        await onMoveGroup(activeDraggedGroupPath, group.path);
                        applyGroupPathUiMutation(activeDraggedGroupPath, nextGroupPath);
                        setCollapsedTreeGroupPaths((current) => current.filter((path) => path !== group.path));
                      } catch {
                        // HomeShell surfaces the error through the shared notice area.
                      } finally {
                        clearDragState();
                      }
                    }}
                  >
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">{group.label}</span>
                    <span className="shrink-0 text-[0.74rem] font-semibold text-[var(--text-muted)]">{group.hostCount}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <div className="flex min-w-0 flex-col gap-[0.85rem]" data-testid="host-browser-content">
          <div className="flex flex-col gap-4">
            <div
              data-host-grid="true"
              className="grid content-start gap-[0.85rem]"
              ref={hostGridRef}
              style={hostGridStyle}
            >
              {visibleHosts.length === 0 ? (
                <EmptyState
                  title={emptyMessage}
                  description={getHostBrowserEmptyCalloutMessage(hosts.length, searchQuery)}
                />
              ) : (
                visibleHosts.map((host) => {
                  const isTagsExpanded = expandedHostTags.includes(host.id);
                  const badgeLabel = getHostBadgeLabel(host);
                  const awsMetadataStatusLabel = host.kind === 'aws-ec2' ? getAwsEc2HostSshMetadataStatusLabel(host.awsSshMetadataStatus) : null;
                  const hint = host.kind === 'aws-ec2' && awsMetadataStatusLabel
                    ? `${awsMetadataStatusLabel}${host.awsSshMetadataStatus === 'error' && host.awsSshMetadataError ? ` · ${host.awsSshMetadataError}` : ''}`
                    : null;
                  return (
                    <HostCard
                      key={host.id}
                      selected={
                        selectedHostIdSet.has(host.id) ||
                        (selectedHostIds.length === 0 && selectedGroupPaths.length === 0 && selectedHostId === host.id)
                      }
                      expanded={isTagsExpanded}
                      badgeLabel={badgeLabel}
                      title={host.label}
                      subtitle={getHostSubtitle(host)}
                      groupLabel={normalizeGroupPath(host.groupName) ?? 'Ungrouped'}
                      hint={hint}
                      style={clampedHostCardStyle}
                      draggable
                      onClick={(event) => {
                        handleHostSelection(host.id, event);
                      }}
                      onDragStart={(event) => {
                        selectSingleHost(host.id);
                        setDraggedGroupPath(null);
                        setDraggedHostId(host.id);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-dolssh-host-id', host.id);
                        event.dataTransfer.setData('text/plain', host.label);
                      }}
                      onDragEnd={() => {
                        clearDragState();
                      }}
                      onDoubleClick={async () => {
                        await onConnectHost(host.id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        const nextHostIds = selectedHostIdSet.has(host.id) ? getOrderedSelectedHostIds(selectedHostIds) : [host.id];
                        if (!selectedHostIdSet.has(host.id)) {
                          setSelectedHostIds([host.id]);
                          setSelectedGroupPaths([]);
                          setHostSelectionAnchor(host.id);
                          setGroupSelectionAnchor(null);
                          onSelectHost(host.id);
                        }
                        setContextMenu({
                          kind: 'host',
                          hostIds: nextHostIds,
                          x: event.clientX,
                          y: event.clientY
                        });
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void (async () => {
                            await onConnectHost(host.id);
                          })();
                        }
                      }}
                      actions={
                        <div className="flex flex-col items-end gap-[0.3rem]">
                          <button
                            type="button"
                            className="inline-grid h-[1.9rem] w-[1.9rem] shrink-0 place-items-center rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[0.8rem] text-[var(--text-soft)] hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] hover:text-[var(--text)]"
                            aria-label={`${host.label} 수정`}
                            onClick={(event) => {
                              event.stopPropagation();
                              selectSingleHost(host.id);
                              onEditHost(host.id);
                            }}
                          >
                            ✎
                          </button>
                          {host.tags && host.tags.length > 0 ? (
                            <button
                              type="button"
                              className="rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.42rem] py-[0.24rem] text-[0.66rem] leading-[1.1] text-[var(--text-soft)] hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] hover:text-[var(--text)]"
                              aria-expanded={isTagsExpanded}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpandedHostTags((current) =>
                                  current.includes(host.id) ? current.filter((entry) => entry !== host.id) : [...current, host.id]
                                );
                              }}
                            >
                              {getHostTagsToggleLabel(isTagsExpanded, host.tags.length)}
                            </button>
                          ) : null}
                        </div>
                      }
                      footer={
                        host.tags && host.tags.length > 0 && isTagsExpanded ? (
                          <>
                            {host.tags.map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.46rem] py-[0.18rem] text-[0.7rem] leading-[1.2] text-[var(--text-soft)]"
                              >
                                #{tag}
                              </span>
                            ))}
                          </>
                        ) : null
                      }
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {contextMenu ? (
        createPortal(
          <div
            className="fixed z-[24] min-w-[148px] rounded-[16px] border border-[var(--border)] bg-[var(--surface-strong)] p-[0.45rem] shadow-[var(--shadow-floating)]"
            style={contextMenuStyle ?? undefined}
            role="menu"
          >
            {contextMenu.kind === 'host' ? (
              <>
                <button
                  type="button"
                  className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                  disabled={contextMenu.hostIds.length !== 1}
                  onClick={async () => {
                    const orderedHostIds = getOrderedSelectedHostIds(contextMenu.hostIds);
                    const targetHostId = orderedHostIds[0];
                    setContextMenu(null);
                    if (!targetHostId) {
                      return;
                    }
                    await onOpenHostContainers(targetHostId);
                  }}
                >
                  컨테이너
                </button>
                <button
                  type="button"
                  className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                  onClick={async () => {
                    setContextMenu(null);
                    await onDuplicateHosts(getOrderedSelectedHostIds(contextMenu.hostIds));
                  }}
                >
                  {contextMenu.hostIds.length === 1 ? '복사' : `복사 (${contextMenu.hostIds.length}개)`}
                </button>
                <button
                type="button"
                className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                onClick={async () => {
                  const orderedHostIds = getOrderedSelectedHostIds(contextMenu.hostIds);
                  setContextMenu(null);
                  if (orderedHostIds.length === 0) {
                    return;
                  }
                  setHostDeleteTarget(buildHostDeleteTarget(orderedHostIds));
                  setHostDeleteError(null);
                }}
              >
                삭제
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                  disabled={contextMenu.groupPaths.length !== 1}
                  onClick={() => {
                    const targetGroupPath = contextMenu.groupPaths[0];
                    setContextMenu(null);
                    if (!targetGroupPath) {
                      return;
                    }
                    openRenameGroupModal(targetGroupPath);
                  }}
                >
                  이름 변경
                </button>
                <button
                  type="button"
                  className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg)]"
                  onClick={() => {
                    setGroupDeleteTarget(buildGroupDeleteTarget(contextMenu.groupPaths));
                    setGroupDeleteError(null);
                    setContextMenu(null);
                  }}
                >
                  삭제
                </button>
              </>
            )}
          </div>,
          document.body
        )
      ) : null}

      {groupModalState ? (
        <DialogBackdrop data-testid="host-browser-modal-backdrop" onDismiss={closeGroupModal}>
          <ModalShell
            data-host-browser-modal="true"
            role="dialog"
            aria-modal="true"
            aria-labelledby={groupModalState.mode === 'create' ? 'new-group-title' : 'rename-group-title'}
          >
            <ModalHeader className="block">
              <SectionLabel>{groupModalState.mode === 'create' ? 'Create' : 'Rename'}</SectionLabel>
              <h3 id={groupModalState.mode === 'create' ? 'new-group-title' : 'rename-group-title'}>
                {groupModalState.mode === 'create' ? 'New Group' : 'Rename Group'}
              </h3>
            </ModalHeader>
            <ModalBody className="grid gap-4">
            <Input
              value={newGroupName}
              onChange={(event) => {
                setNewGroupName(event.target.value);
                setGroupError(null);
              }}
              placeholder="Group name"
              autoFocus
            />
            {groupError ? <p className="text-sm text-[var(--danger-text)]">{groupError}</p> : null}
            </ModalBody>
            <ModalFooter>
              <Button variant="secondary" onClick={closeGroupModal}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    if (groupModalState.mode === 'create') {
                      await onCreateGroup(newGroupName);
                    } else {
                      const nextGroupPath = normalizeGroupPath(
                        getParentGroupPath(groupModalState.path)
                          ? `${getParentGroupPath(groupModalState.path)}/${newGroupName.trim()}`
                          : newGroupName.trim()
                      );
                      await onRenameGroup(groupModalState.path, newGroupName);
                      if (nextGroupPath) {
                        applyGroupPathUiMutation(groupModalState.path, nextGroupPath);
                      }
                    }
                    closeGroupModal();
                  } catch (error) {
                    setGroupError(
                      error instanceof Error
                        ? error.message
                        : groupModalState.mode === 'create'
                          ? '그룹을 만들지 못했습니다.'
                          : '그룹 이름을 변경하지 못했습니다.'
                    );
                  }
                }}
              >
                {groupModalState.mode === 'create' ? 'Create group' : 'Rename group'}
              </Button>
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      {hostDeleteTarget ? (
        <DialogBackdrop
          data-testid="host-browser-modal-backdrop"
          onDismiss={() => {
            if (isRemovingHost) {
              return;
            }
            setHostDeleteTarget(null);
            setHostDeleteError(null);
          }}
        >
          <ModalShell data-host-browser-modal="true" role="dialog" aria-modal="true" aria-labelledby="delete-host-title">
            <ModalHeader className="block">
            <SectionLabel>Delete</SectionLabel>
            <h3 id="delete-host-title">
              {hostDeleteTarget.hostCount === 1
                ? `${hostDeleteTarget.title} 호스트를 삭제할까요?`
                : `선택한 ${hostDeleteTarget.hostCount}개 호스트를 삭제할까요?`}
            </h3>
            </ModalHeader>
            <ModalBody className="grid gap-4">
            <p className="text-sm leading-6 text-[var(--text-soft)]">연결된 secret 항목은 유지됩니다.</p>
            {hostDeleteError ? <p className="text-sm text-[var(--danger-text)]">{hostDeleteError}</p> : null}
            </ModalBody>
            <ModalFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  setHostDeleteTarget(null);
                  setHostDeleteError(null);
                }}
                disabled={isRemovingHost}
              >
                취소
              </Button>
              <Button
                variant="danger"
                disabled={isRemovingHost}
                onClick={async () => {
                  try {
                    setIsRemovingHost(true);
                    for (const hostId of hostDeleteTarget.hostIds) {
                      await onRemoveHost(hostId);
                    }
                    clearSelections();
                    setHostDeleteTarget(null);
                    setHostDeleteError(null);
                  } catch (error) {
                    setHostDeleteError(error instanceof Error ? error.message : '호스트를 삭제하지 못했습니다.');
                  } finally {
                    setIsRemovingHost(false);
                  }
                }}
              >
                삭제
              </Button>
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      {groupDeleteTarget ? (
        <DialogBackdrop data-testid="host-browser-modal-backdrop">
          <ModalShell data-host-browser-modal="true" role="dialog" aria-modal="true" aria-labelledby="delete-group-title">
            <ModalHeader className="block">
            <SectionLabel>Delete</SectionLabel>
            <h3 id="delete-group-title">
              {groupDeleteTarget.groupCount === 1
                ? `${groupDeleteTarget.title} 그룹을 삭제할까요?`
                : `선택한 ${groupDeleteTarget.groupCount}개 그룹을 삭제할까요?`}
            </h3>
            </ModalHeader>
            <ModalBody className="grid gap-4">
            {groupDeleteDialogVariant === 'with-descendants' ? (
              <p className="text-sm leading-6 text-[var(--text-soft)]">
                하위 그룹 {groupDeleteTarget.childGroupCount}개와 호스트 {groupDeleteTarget.hostCount}개가 함께 영향을 받습니다.
              </p>
            ) : (
              <p className="text-sm leading-6 text-[var(--text-soft)]">이 그룹은 비어 있습니다. 삭제하면 바로 사라집니다.</p>
            )}
            {groupDeleteError ? <p className="text-sm text-[var(--danger-text)]">{groupDeleteError}</p> : null}
            </ModalBody>
            <ModalFooter className={groupDeleteDialogVariant === 'with-descendants' ? 'flex-nowrap gap-[0.85rem]' : undefined}>
              <Button
                variant="secondary"
                className={groupDeleteDialogVariant === 'with-descendants' ? 'shrink-0 whitespace-nowrap' : undefined}
                onClick={() => {
                  setGroupDeleteTarget(null);
                  setGroupDeleteError(null);
                }}
                disabled={isRemovingGroup}
              >
                취소
              </Button>
              {groupDeleteDialogVariant === 'with-descendants' ? (
                <>
                  <Button
                    variant="secondary"
                    className="min-w-0 flex-1 whitespace-nowrap"
                    disabled={isRemovingGroup}
                    onClick={async () => {
                      try {
                        setIsRemovingGroup(true);
                        for (const path of groupDeleteTarget.paths) {
                          await onRemoveGroup(path, 'reparent-descendants');
                        }
                        setSelectedGroupPaths((current) => current.filter((path) => !groupDeleteTarget.paths.includes(path)));
                        setGroupDeleteTarget(null);
                        setGroupDeleteError(null);
                      } catch (error) {
                        setGroupDeleteError(error instanceof Error ? error.message : '그룹을 삭제하지 못했습니다.');
                      } finally {
                        setIsRemovingGroup(false);
                      }
                    }}
                  >
                    하위 항목 유지
                  </Button>
                  <Button
                    variant="danger"
                    className="min-w-0 flex-1 whitespace-nowrap"
                    disabled={isRemovingGroup}
                    onClick={async () => {
                      try {
                        setIsRemovingGroup(true);
                        await onRemoveGroup(
                          groupDeleteTarget.paths[0],
                          'delete-subtree'
                        );
                        for (const path of groupDeleteTarget.paths.slice(1)) {
                          await onRemoveGroup(path, 'delete-subtree');
                        }
                        setSelectedGroupPaths((current) => current.filter((path) => !groupDeleteTarget.paths.includes(path)));
                        setGroupDeleteTarget(null);
                        setGroupDeleteError(null);
                      } catch (error) {
                        setGroupDeleteError(error instanceof Error ? error.message : '그룹을 삭제하지 못했습니다.');
                      } finally {
                        setIsRemovingGroup(false);
                      }
                    }}
                  >
                    하위 항목까지 삭제
                  </Button>
                </>
              ) : (
                <Button
                  variant="danger"
                  disabled={isRemovingGroup}
                  onClick={async () => {
                    try {
                      setIsRemovingGroup(true);
                      await onRemoveGroup(groupDeleteTarget.paths[0], 'reparent-descendants');
                      for (const path of groupDeleteTarget.paths.slice(1)) {
                        await onRemoveGroup(path, 'reparent-descendants');
                      }
                      setSelectedGroupPaths((current) => current.filter((path) => !groupDeleteTarget.paths.includes(path)));
                      setGroupDeleteTarget(null);
                      setGroupDeleteError(null);
                    } catch (error) {
                      setGroupDeleteError(error instanceof Error ? error.message : '그룹을 삭제하지 못했습니다.');
                    } finally {
                      setIsRemovingGroup(false);
                    }
                  }}
                >
                  삭제
                </Button>
              )}
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}
    </div>
  );
}
