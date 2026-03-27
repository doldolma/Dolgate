import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Fuse from 'fuse.js';
import {
  buildVisibleGroups,
  collectGroupPaths,
  filterHostsInGroupTree,
  getGroupDeleteDialogVariant,
  getHostBadgeLabel,
  getHostSearchText,
  getHostSubtitle,
  getHostTagsToggleLabel,
  isGroupWithinPath,
  normalizeGroupPath
} from '@shared';
import type { GroupRecord, GroupRemoveMode, HostRecord } from '@shared';
import { DialogBackdrop } from './DialogBackdrop';
import type { DesktopPlatform } from './DesktopWindowControls';

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
  normalizeGroupPath
} from '@shared';

export function getHostBrowserCardClassName(isSelected: boolean, isTagsExpanded: boolean): string {
  return ['host-browser-card', isSelected ? 'active' : null, isTagsExpanded ? 'host-browser-card--expanded' : null].filter(Boolean).join(' ');
}

export const HOST_BROWSER_IMPORT_MENU_LABELS = [
  'Import from AWS',
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
  onNavigateGroup: (path: string | null) => void;
  onClearHostSelection: () => void;
  onSelectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onDuplicateHosts: (hostIds: string[]) => Promise<void>;
  onMoveHostToGroup: (hostId: string, groupPath: string | null) => Promise<void>;
  onRemoveHost: (hostId: string) => Promise<void>;
  onConnectHost: (hostId: string) => Promise<void>;
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
  onNavigateGroup,
  onClearHostSelection,
  onSelectHost,
  onEditHost,
  onDuplicateHosts,
  onMoveHostToGroup,
  onRemoveHost,
  onConnectHost
}: HostBrowserProps) {
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
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
  const [expandedHostTags, setExpandedHostTags] = useState<string[]>([]);
  const [isImportMenuOpen, setIsImportMenuOpen] = useState(false);
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
  const visibleGroups = useMemo(() => buildVisibleGroups(groups, hosts, currentGroupPath), [currentGroupPath, groups, hosts]);
  const visibleHostIds = useMemo(() => visibleHosts.map((host) => host.id), [visibleHosts]);
  const visibleGroupPaths = useMemo(() => visibleGroups.map((group) => group.path), [visibleGroups]);
  const showGroupEmptyState = currentGroupPath === null && visibleGroups.length === 0;
  const showGroupSection = visibleGroups.length > 0 || showGroupEmptyState;
  const breadcrumbs = useMemo(() => {
    if (!currentGroupPath) {
      return [];
    }
    const segments = currentGroupPath.split('/');
    return segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join('/')
    }));
  }, [currentGroupPath]);

  const emptyMessage = hosts.length === 0 ? '아직 등록된 호스트가 없습니다.' : searchQuery ? '검색 결과가 없습니다.' : '이 위치에는 아직 호스트가 없습니다.';
  const contextMenuStyle = contextMenu
    ? {
        left: `${Math.max(12, Math.min(contextMenu.x, window.innerWidth - 172))}px`,
        top: `${Math.max(12, Math.min(contextMenu.y, window.innerHeight - 72))}px`
      }
    : null;

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
  }

  function getOrderedSelectedHostIds(hostIds: string[]): string[] {
    const selectedHostIdSet = new Set(hostIds);
    return visibleHostIds.filter((hostId) => selectedHostIdSet.has(hostId));
  }

  function handleBrowserBackgroundClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (
      target.closest('.host-browser-card') ||
      target.closest('.group-card') ||
      target.closest('.context-menu') ||
      target.closest('button') ||
      target.closest('input') ||
      target.closest('.home-modal')
    ) {
      return;
    }
    clearSelections();
  }

  function closeGroupModal() {
    setIsGroupModalOpen(false);
    setNewGroupName('');
    setGroupError(null);
  }

  const selectedHostIdSet = new Set(selectedHostIds);
  const selectedGroupPathSet = new Set(selectedGroupPaths);

  return (
    <div className="host-browser" onClickCapture={handleBrowserBackgroundClick}>
      <div className="home-toolbar">
        <div className="search-panel">
          <input
            id="host-search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search hosts or instances"
            aria-label="Search hosts"
          />
        </div>
        <div className="home-toolbar__actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setIsImportMenuOpen(false);
              onOpenLocalTerminal();
            }}
          >
            TERMINAL
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setIsImportMenuOpen(false);
              setIsGroupModalOpen(true);
              setNewGroupName('');
              setGroupError(null);
            }}
          >
            New Group
          </button>
          <div className="split-button" ref={importMenuRef}>
            <button
              type="button"
              className="primary-button split-button__main"
              onClick={() => {
                setIsImportMenuOpen(false);
                onCreateHost();
              }}
            >
              New Host
            </button>
            <button
              type="button"
              className="primary-button split-button__toggle"
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
              <span className="split-button__chevron" aria-hidden="true">
                <svg viewBox="0 0 12 8" focusable="false">
                  <path d="M1 1.25 6 6.25 11 1.25" />
                </svg>
              </span>
            </button>
            {isImportMenuOpen ? (
              <div className="split-button__menu" role="menu" aria-label="Import host menu">
                {importMenuItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className="split-button__menu-item"
                    role="menuitem"
                    onClick={() => {
                      setIsImportMenuOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {statusMessage ? <div className="terminal-status-banner host-browser__status-banner">{statusMessage}</div> : null}
      {errorMessage ? <div className="terminal-error-banner host-browser__error-banner">{errorMessage}</div> : null}

      {breadcrumbs.length > 0 ? (
        <div className="host-browser__breadcrumbs">
          <button type="button" className="host-browser__breadcrumb" onClick={() => onNavigateGroup(null)}>
            Hosts
          </button>
          {breadcrumbs.map((crumb) => (
            <button
              key={crumb.path}
              type="button"
              className={`host-browser__breadcrumb ${crumb.path === currentGroupPath ? 'active' : ''}`}
              onClick={() => onNavigateGroup(crumb.path)}
            >
              {crumb.label}
            </button>
          ))}
        </div>
      ) : null}

      {showGroupSection ? (
        <div className="browser-section">
        <div className="browser-section__header">
          <div>
            <h2>Groups</h2>
          </div>
        </div>
        <div className="group-grid">
          {showGroupEmptyState ? (
            <div className="empty-callout">
              <strong>{currentGroupPath ? '이 위치에는 아직 그룹이 없습니다.' : '아직 만든 그룹이 없습니다.'}</strong>
              <p>New Group을 눌러 현재 위치 아래에 첫 번째 그룹을 만들어보세요.</p>
            </div>
          ) : (
            visibleGroups.map((group) => (
              <article
                key={group.path}
                className={`group-card group-card--interactive ${selectedGroupPathSet.has(group.path) ? 'active' : ''} ${dragTargetGroupPath === group.path ? 'drop-target' : ''}`}
                onClick={(event) => {
                  handleGroupSelection(group.path, event);
                }}
                onDoubleClick={() => onNavigateGroup(group.path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const nextGroupPaths = selectedGroupPathSet.has(group.path) ? selectedGroupPaths : [group.path];
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
                    y: event.clientY
                  });
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
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
                  event.preventDefault();
                  const hostId = event.dataTransfer.getData('application/x-dolssh-host-id');
                  setDragTargetGroupPath(null);
                  if (!hostId) {
                    return;
                  }
                  await onMoveHostToGroup(hostId, group.path);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === ' ') {
                    event.preventDefault();
                    selectSingleGroup(group.path);
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onNavigateGroup(group.path);
                  }
                }}
              >
                <div className="group-card__icon">{group.name.slice(0, 1).toUpperCase()}</div>
                <div className="group-card__body">
                  <strong>{group.name}</strong>
                  <span>{group.hostCount} hosts</span>
                </div>
              </article>
            ))
          )}
        </div>
        </div>
      ) : null}

      <div className="browser-section">
        <div className="browser-section__header">
          <div>
            <h2>Hosts</h2>
          </div>
        </div>
        <div className="host-grid">
          {visibleHosts.length === 0 ? (
            <div className="empty-callout">
              <strong>{emptyMessage}</strong>
              <p>{getHostBrowserEmptyCalloutMessage(hosts.length, searchQuery)}</p>
            </div>
          ) : (
            visibleHosts.map((host) => {
              const isTagsExpanded = expandedHostTags.includes(host.id);
              const badgeLabel = getHostBadgeLabel(host);
              return (
                <article
                  key={host.id}
                  className={getHostBrowserCardClassName(
                    selectedHostIdSet.has(host.id) ||
                      (selectedHostIds.length === 0 && selectedGroupPaths.length === 0 && selectedHostId === host.id),
                    isTagsExpanded
                  )}
                  draggable
                  onClick={(event) => {
                    handleHostSelection(host.id, event);
                  }}
                  onDragStart={(event) => {
                    selectSingleHost(host.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-dolssh-host-id', host.id);
                    event.dataTransfer.setData('text/plain', host.label);
                  }}
                  onDragEnd={() => {
                    setDragTargetGroupPath(null);
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
                >
                  <div className={`host-browser-card__icon ${badgeLabel.length > 3 ? 'host-browser-card__icon--compact' : ''}`}>
                    {badgeLabel}
                  </div>
                  <div className="host-browser-card__meta">
                    <strong>{host.label}</strong>
                    <span>{getHostSubtitle(host)}</span>
                    <small>{normalizeGroupPath(host.groupName) ?? 'Ungrouped'}</small>
                  </div>
                  <div className="host-browser-card__actions">
                    <button
                      type="button"
                      className="host-browser-card__edit"
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
                        className="host-browser-card__tags-toggle"
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
                  {host.tags && host.tags.length > 0 && isTagsExpanded ? (
                    <div className="host-browser-card__tags-panel">
                      {host.tags.map((tag) => (
                        <span key={tag} className="host-browser-card__tag">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </div>

      {contextMenu ? (
        createPortal(
          <div className="context-menu" style={contextMenuStyle ?? undefined} role="menu">
            {contextMenu.kind === 'host' ? (
              <>
                <button
                  type="button"
                  className="context-menu__item"
                  onClick={async () => {
                    setContextMenu(null);
                    await onDuplicateHosts(getOrderedSelectedHostIds(contextMenu.hostIds));
                  }}
                >
                  {contextMenu.hostIds.length === 1 ? '복사' : `복사 (${contextMenu.hostIds.length}개)`}
                </button>
                <button
                type="button"
                className="context-menu__item context-menu__item--danger"
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
              <button
                type="button"
                className="context-menu__item context-menu__item--danger"
                onClick={() => {
                  setGroupDeleteTarget(buildGroupDeleteTarget(contextMenu.groupPaths));
                  setGroupDeleteError(null);
                  setContextMenu(null);
                }}
              >
                삭제
              </button>
            )}
          </div>,
          document.body
        )
      ) : null}

      {isGroupModalOpen ? (
        <DialogBackdrop className="home-modal-backdrop" onDismiss={closeGroupModal}>
          <div className="home-modal" role="dialog" aria-modal="true" aria-labelledby="new-group-title">
            <div className="section-kicker">Create</div>
            <h3 id="new-group-title">New Group</h3>
            <input
              value={newGroupName}
              onChange={(event) => {
                setNewGroupName(event.target.value);
                setGroupError(null);
              }}
              placeholder="Group name"
              autoFocus
            />
            {groupError ? <p className="home-modal__error">{groupError}</p> : null}
            <div className="home-modal__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={closeGroupModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={async () => {
                  try {
                    await onCreateGroup(newGroupName);
                    closeGroupModal();
                  } catch (error) {
                    setGroupError(error instanceof Error ? error.message : '그룹을 만들지 못했습니다.');
                  }
                }}
              >
                Create group
              </button>
            </div>
          </div>
        </DialogBackdrop>
      ) : null}

      {hostDeleteTarget ? (
        <DialogBackdrop
          className="home-modal-backdrop"
          onDismiss={() => {
            if (isRemovingHost) {
              return;
            }
            setHostDeleteTarget(null);
            setHostDeleteError(null);
          }}
        >
          <div className="home-modal" role="dialog" aria-modal="true" aria-labelledby="delete-host-title">
            <div className="section-kicker">Delete</div>
            <h3 id="delete-host-title">
              {hostDeleteTarget.hostCount === 1
                ? `${hostDeleteTarget.title} 호스트를 삭제할까요?`
                : `선택한 ${hostDeleteTarget.hostCount}개 호스트를 삭제할까요?`}
            </h3>
            <p className="home-modal__copy">연결된 secret 항목은 유지됩니다.</p>
            {hostDeleteError ? <p className="home-modal__error">{hostDeleteError}</p> : null}
            <div className="home-modal__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setHostDeleteTarget(null);
                  setHostDeleteError(null);
                }}
                disabled={isRemovingHost}
              >
                취소
              </button>
              <button
                type="button"
                className="secondary-button danger"
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
              </button>
            </div>
          </div>
        </DialogBackdrop>
      ) : null}

      {groupDeleteTarget ? (
        <div className="home-modal-backdrop" role="presentation">
          <div className="home-modal" role="dialog" aria-modal="true" aria-labelledby="delete-group-title">
            <div className="section-kicker">Delete</div>
            <h3 id="delete-group-title">
              {groupDeleteTarget.groupCount === 1
                ? `${groupDeleteTarget.title} 그룹을 삭제할까요?`
                : `선택한 ${groupDeleteTarget.groupCount}개 그룹을 삭제할까요?`}
            </h3>
            {getGroupDeleteDialogVariant(groupDeleteTarget.childGroupCount, groupDeleteTarget.hostCount) === 'with-descendants' ? (
              <p className="home-modal__copy">
                하위 그룹 {groupDeleteTarget.childGroupCount}개와 호스트 {groupDeleteTarget.hostCount}개가 함께 영향을 받습니다.
              </p>
            ) : (
              <p className="home-modal__copy">이 그룹은 비어 있습니다. 삭제하면 바로 사라집니다.</p>
            )}
            {groupDeleteError ? <p className="home-modal__error">{groupDeleteError}</p> : null}
            <div className="home-modal__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setGroupDeleteTarget(null);
                  setGroupDeleteError(null);
                }}
                disabled={isRemovingGroup}
              >
                취소
              </button>
              {getGroupDeleteDialogVariant(groupDeleteTarget.childGroupCount, groupDeleteTarget.hostCount) === 'with-descendants' ? (
                <button
                  type="button"
                  className="secondary-button"
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
                </button>
              ) : null}
              <button
                type="button"
                className="secondary-button danger"
                disabled={isRemovingGroup}
                onClick={async () => {
                    try {
                      setIsRemovingGroup(true);
                      await onRemoveGroup(
                        groupDeleteTarget.paths[0],
                        getGroupDeleteDialogVariant(groupDeleteTarget.childGroupCount, groupDeleteTarget.hostCount) === 'with-descendants'
                          ? 'delete-subtree'
                          : 'reparent-descendants'
                      );
                      for (const path of groupDeleteTarget.paths.slice(1)) {
                        await onRemoveGroup(
                          path,
                          getGroupDeleteDialogVariant(groupDeleteTarget.childGroupCount, groupDeleteTarget.hostCount) === 'with-descendants'
                            ? 'delete-subtree'
                            : 'reparent-descendants'
                        );
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
                {getGroupDeleteDialogVariant(groupDeleteTarget.childGroupCount, groupDeleteTarget.hostCount) === 'with-descendants'
                  ? '하위 항목까지 삭제'
                  : '삭제'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
