import { useEffect, useRef, useState } from 'react';
import { normalizeGroupPath } from '@shared';
import type { HomeSection } from '../../store/types';
import { cn } from '../../lib/cn';
import {
  ArrowDownUp,
  ArrowLeftRight,
  Check,
  ChevronRight,
  EyeOff,
  FoldVertical,
  Folder,
  FolderOpen,
  LayoutGrid,
  List,
  ListFilter,
  Plus,
  Scissors,
  Settings,
  Star,
  UnfoldVertical,
  type LucideIcon,
} from '../../ui/icons';
import { Tooltip } from '../../ui';
import {
  GROUP_DRAG_MIME_TYPE,
  normalizeGroupSelectionForDelete,
  type GroupSortKey,
  type HostBrowserModel,
} from './useHostBrowser';
import { useTranslation } from 'react-i18next';

interface HomeSidebarProps {
  hb: HostBrowserModel;
}

const SECTION_ITEMS: Array<{ section: HomeSection; label: string; Icon: LucideIcon }> = [
  { section: 'portForwarding', label: 'Port Forwarding', Icon: ArrowLeftRight },
  { section: 'snippets', label: 'Snippets', Icon: Scissors },
  { section: 'logs', label: 'Logs', Icon: List },
  { section: 'settings', label: 'Settings', Icon: Settings },
];

export function HomeSidebar({ hb }: HomeSidebarProps) {
  const { t: translate } = useTranslation();
  const {
    hosts,
    groupTreeRows,
    visibleGroupTreeRows,
    collapsedTreeGroupPathSet,
    currentGroupPath,
    selectedGroupPathSet,
    selectedGroupPaths,
    favoriteHostIds,
    favoritesFilterActive,
    toggleFavoritesFilter,
    tagCounts,
    activeTagFilter,
    toggleTagFilter,
    isRootDragTarget,
    dragTargetGroupPath,
    draggedGroupPath,
    onSelectSection,
    groupSortKey,
    setGroupSortKey,
    hideEmptyGroups,
    setHideEmptyGroups,
    expandAllGroups,
    collapseAllGroups,
  } = hb;

  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
  const groupMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isGroupMenuOpen) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (groupMenuRef.current && !groupMenuRef.current.contains(event.target as Node)) {
        setIsGroupMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isGroupMenuOpen]);
  const groupMenuItemClass =
    'flex w-full items-center gap-[0.6rem] rounded-[8px] px-[0.7rem] py-[0.5rem] text-left text-[0.85rem] text-[var(--text)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)]';
  const groupSortOptions: Array<{ key: GroupSortKey; label: string }> = [
    { key: 'name', label: translate('sidebar.sortName') },
    { key: 'recent', label: translate('sidebar.sortRecent') },
    { key: 'count', label: translate('sidebar.sortCount') },
  ];

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-elevated)_94%,var(--app-bg)_6%)] max-[1040px]:hidden">
      {/* GROUPS header */}
      <div className="flex shrink-0 items-center justify-between px-[0.9rem] pb-[0.55rem] pt-[1.1rem]">
        <span className="text-[0.7rem] font-bold uppercase tracking-[0.14em] text-[var(--text-soft)]">
          Groups
        </span>
        <div className="flex items-center gap-[0.35rem]">
          <button
            type="button"
            aria-label="New Group"
            title="New Group"
            className="inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[8px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[0.9rem] leading-none text-[var(--text-soft)] transition-colors duration-140 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] hover:text-[var(--accent-strong)]"
            onClick={hb.openCreateGroupModal}
          >
            <Plus className="h-[1rem] w-[1rem]" />
          </button>
          <div className="relative" ref={groupMenuRef}>
            <button
              type="button"
              aria-label={translate('sidebar.groupOptions')}
              title={translate('sidebar.groupOptions')}
              aria-haspopup="menu"
              aria-expanded={isGroupMenuOpen}
              className={cn(
                'inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[8px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)] transition-colors duration-140 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] hover:text-[var(--accent-strong)]',
                isGroupMenuOpen &&
                  'border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] text-[var(--accent-strong)]',
              )}
              onClick={() => setIsGroupMenuOpen((open) => !open)}
            >
              <ListFilter className="h-[1rem] w-[1rem]" />
            </button>
            {isGroupMenuOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+0.4rem)] z-30 min-w-[208px] rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] p-[0.4rem] shadow-[var(--shadow-floating)]"
              >
                {groupSortOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={groupSortKey === option.key}
                    className={groupMenuItemClass}
                    onClick={() => {
                      setGroupSortKey(option.key);
                      setIsGroupMenuOpen(false);
                    }}
                  >
                    <ArrowDownUp className="h-4 w-4 shrink-0 text-[var(--text-soft)]" aria-hidden />
                    <span className="flex-1">{option.label}</span>
                    {groupSortKey === option.key ? (
                      <Check className="h-4 w-4 shrink-0 text-[var(--accent-strong)]" aria-hidden />
                    ) : null}
                  </button>
                ))}

                <div role="separator" className="my-[0.3rem] h-px bg-[var(--border)]" />

                <button
                  type="button"
                  role="menuitem"
                  className={groupMenuItemClass}
                  onClick={() => {
                    expandAllGroups();
                    setIsGroupMenuOpen(false);
                  }}
                >
                  <UnfoldVertical className="h-4 w-4 shrink-0 text-[var(--text-soft)]" aria-hidden />
                  <span className="flex-1">{translate('sidebar.expandAll')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={groupMenuItemClass}
                  onClick={() => {
                    collapseAllGroups();
                    setIsGroupMenuOpen(false);
                  }}
                >
                  <FoldVertical className="h-4 w-4 shrink-0 text-[var(--text-soft)]" aria-hidden />
                  <span className="flex-1">{translate('sidebar.collapseAll')}</span>
                </button>

                <div role="separator" className="my-[0.3rem] h-px bg-[var(--border)]" />

                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={hideEmptyGroups}
                  className={groupMenuItemClass}
                  onClick={() => setHideEmptyGroups((value) => !value)}
                >
                  <EyeOff className="h-4 w-4 shrink-0 text-[var(--text-soft)]" aria-hidden />
                  <span className="flex-1">{translate('sidebar.hideEmpty')}</span>
                  {hideEmptyGroups ? (
                    <Check className="h-4 w-4 shrink-0 text-[var(--accent-strong)]" aria-hidden />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Group tree — All Hosts/즐겨찾기는 상단 고정, 아래 그룹 목록만 스크롤 */}
      <nav
        className="flex min-h-0 flex-1 flex-col gap-[0.25rem] px-[0.55rem] pb-[0.55rem]"
        aria-label="Group tree"
      >
        {/* All Hosts (root) */}
        <button
          type="button"
          className={cn(
            'flex w-full min-w-0 items-center gap-[0.55rem] rounded-[10px] border border-transparent bg-transparent px-[0.55rem] py-[0.4rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]',
            currentGroupPath === null &&
              !favoritesFilterActive &&
              'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]',
            isRootDragTarget && 'border-[var(--selection-border)] bg-[var(--selection-tint-strong)]',
          )}
          onClick={hb.handleNavigateRoot}
          onDragOver={(event) => {
            const activeDraggedGroupPath =
              draggedGroupPath ??
              normalizeGroupPath(event.dataTransfer.getData(GROUP_DRAG_MIME_TYPE));
            if (!activeDraggedGroupPath || !hb.canReparentGroup(activeDraggedGroupPath, null)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            hb.setIsRootDragTarget(true);
          }}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
              return;
            }
            hb.setIsRootDragTarget(false);
          }}
          onDrop={async (event) => {
            const activeDraggedGroupPath =
              draggedGroupPath ??
              normalizeGroupPath(event.dataTransfer.getData(GROUP_DRAG_MIME_TYPE));
            hb.setIsRootDragTarget(false);
            if (!activeDraggedGroupPath || !hb.canReparentGroup(activeDraggedGroupPath, null)) {
              return;
            }
            event.preventDefault();
            const nextGroupPath = hb.buildNextGroupPath(activeDraggedGroupPath, null);
            if (!nextGroupPath) {
              return;
            }
            try {
              await hb.onMoveGroup(activeDraggedGroupPath, null);
              hb.applyGroupPathUiMutation(activeDraggedGroupPath, nextGroupPath);
            } catch {
              // HomeShell surfaces the error through the shared notice area.
            } finally {
              hb.clearDragState();
            }
          }}
        >
          <span
            aria-hidden="true"
            className="inline-grid h-[1.55rem] w-[1.55rem] shrink-0 place-items-center rounded-[8px] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] text-[var(--accent-strong)]"
          >
            <LayoutGrid className="h-[0.95rem] w-[0.95rem]" />
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold">All Hosts</span>
          <span className="shrink-0 text-[0.7rem] font-semibold text-[var(--text-muted)]">
            {hosts.length}
          </span>
        </button>

        {/* 즐겨찾기 (UI only for now) */}
        <button
          type="button"
          aria-label={translate('sidebar.favorites')}
          className={cn(
            'flex w-full min-w-0 items-center gap-[0.55rem] rounded-[10px] border border-transparent bg-transparent px-[0.55rem] py-[0.4rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]',
            favoritesFilterActive &&
              'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]',
          )}
          onClick={toggleFavoritesFilter}
        >
          <span
            aria-hidden="true"
            className="inline-grid h-[1.55rem] w-[1.55rem] shrink-0 place-items-center rounded-[8px] bg-[color-mix(in_srgb,#e8a33d_18%,transparent_82%)] text-[#d8901f]"
          >
            <Star className="h-[0.95rem] w-[0.95rem]" fill="currentColor" />
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold">{translate('sidebar.favorites')}</span>
          <span className="shrink-0 text-[0.7rem] font-semibold text-[var(--text-muted)]">
            {favoriteHostIds.length}
          </span>
        </button>

        <div className="my-[0.4rem] h-px bg-[var(--border)]" aria-hidden="true" />

        {/* Group rows — the only scrollable region */}
        <div className="flex min-h-0 flex-1 flex-col gap-[0.25rem] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groupTreeRows.length === 0 ? (
          <div className="px-[0.55rem] py-[0.7rem] text-[0.82rem] leading-[1.45] text-[var(--text-soft)]">
            {translate('sidebar.noGroups')}
          </div>
        ) : (
          visibleGroupTreeRows.map((group) => {
            const collapsed = collapsedTreeGroupPathSet.has(group.path);
            const isActive = currentGroupPath === group.path;
            const FolderGlyph = group.hasChildren && !collapsed ? FolderOpen : Folder;
            return (
              <div key={group.path} className="flex min-w-0 items-stretch">
                {/* depth guide rails */}
                {Array.from({ length: group.depth }).map((_, index) => (
                  <span key={index} aria-hidden="true" className="relative w-[0.85rem] shrink-0">
                    <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)]" />
                  </span>
                ))}
                {/* disclosure */}
                {group.hasChildren ? (
                  <button
                    type="button"
                    className="flex w-[1.15rem] shrink-0 items-center justify-center self-stretch text-[var(--text-muted)] transition-colors duration-140 hover:text-[var(--text)]"
                    aria-label={collapsed ? 'Expand subgroup' : 'Collapse subgroup'}
                    onClick={() => hb.handleToggleGroupBranch(group.path)}
                  >
                    <ChevronRight
                      className={cn(
                        'h-[0.85rem] w-[0.85rem] transition-transform duration-140',
                        !collapsed && 'rotate-90',
                      )}
                    />
                  </button>
                ) : (
                  <span className="w-[1.15rem] shrink-0" aria-hidden="true" />
                )}
                {/* group row */}
                <button
                  type="button"
                  className={cn(
                    'flex w-full min-w-0 items-center gap-[0.4rem] rounded-[10px] border border-transparent bg-transparent px-[0.55rem] py-[0.4rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]',
                    isActive &&
                      'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]',
                    !currentGroupPath && selectedGroupPathSet.has(group.path) && 'text-[var(--text)]',
                    selectedGroupPathSet.has(group.path) &&
                      !isActive &&
                      'bg-[color-mix(in_srgb,var(--surface-elevated)_66%,transparent_34%)]',
                    dragTargetGroupPath === group.path &&
                      'border-[var(--selection-border)] bg-[var(--selection-tint-strong)]',
                  )}
                  data-group-tree-state={selectedGroupPathSet.has(group.path) ? 'selected' : 'idle'}
                  draggable
                  onClick={(event) => hb.handleGroupSelection(group.path, event)}
                  onDragStart={(event) => {
                    hb.selectSingleGroup(group.path);
                    hb.setDraggedHostIds([]);
                    hb.setDraggedGroupPath(group.path);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(GROUP_DRAG_MIME_TYPE, group.path);
                    event.dataTransfer.setData('text/plain', group.label);
                  }}
                  onDragEnd={() => hb.clearDragState()}
                  onDoubleClick={() => {
                    if (group.hasChildren) {
                      hb.handleToggleGroupBranch(group.path);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const nextGroupPaths = selectedGroupPathSet.has(group.path)
                      ? selectedGroupPaths
                      : [group.path];
                    if (!selectedGroupPathSet.has(group.path)) {
                      hb.setSelectedGroupPaths([group.path]);
                      hb.setSelectedHostIds([]);
                      hb.setGroupSelectionAnchor(group.path);
                      hb.setHostSelectionAnchor(null);
                      hb.onClearHostSelection();
                    }
                    hb.setContextMenu({
                      kind: 'group',
                      groupPaths: normalizeGroupSelectionForDelete(nextGroupPaths),
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onDragOver={(event) => {
                    const activeDraggedHostIds = hb.getActiveDraggedHostIds(event.dataTransfer);
                    const activeDraggedGroupPath =
                      draggedGroupPath ??
                      normalizeGroupPath(event.dataTransfer.getData(GROUP_DRAG_MIME_TYPE));
                    if (
                      activeDraggedHostIds.length === 0 &&
                      (!activeDraggedGroupPath ||
                        !hb.canReparentGroup(activeDraggedGroupPath, group.path))
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    hb.setIsRootDragTarget(false);
                    hb.setDragTargetGroupPath(group.path);
                  }}
                  onDragLeave={(event) => {
                    const nextTarget = event.relatedTarget;
                    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                      return;
                    }
                    hb.setDragTargetGroupPath((current) =>
                      current === group.path ? null : current,
                    );
                  }}
                  onDrop={async (event) => {
                    const activeDraggedHostIds = hb.getActiveDraggedHostIds(event.dataTransfer);
                    const activeDraggedGroupPath =
                      draggedGroupPath ??
                      normalizeGroupPath(event.dataTransfer.getData(GROUP_DRAG_MIME_TYPE));
                    hb.setDragTargetGroupPath(null);
                    hb.setIsRootDragTarget(false);
                    if (activeDraggedHostIds.length > 0) {
                      event.preventDefault();
                      try {
                        for (const hostId of activeDraggedHostIds) {
                          await hb.onMoveHostToGroup(hostId, group.path);
                        }
                      } finally {
                        hb.clearDragState();
                      }
                      return;
                    }
                    if (
                      !activeDraggedGroupPath ||
                      !hb.canReparentGroup(activeDraggedGroupPath, group.path)
                    ) {
                      return;
                    }
                    event.preventDefault();
                    const nextGroupPath = hb.buildNextGroupPath(activeDraggedGroupPath, group.path);
                    if (!nextGroupPath) {
                      return;
                    }
                    try {
                      await hb.onMoveGroup(activeDraggedGroupPath, group.path);
                      hb.applyGroupPathUiMutation(activeDraggedGroupPath, nextGroupPath);
                      hb.setCollapsedTreeGroupPaths((current) =>
                        current.filter((path) => path !== group.path),
                      );
                    } catch {
                      // HomeShell surfaces the error through the shared notice area.
                    } finally {
                      hb.clearDragState();
                    }
                  }}
                >
                  {group.hasChildren || group.depth === 0 ? (
                    <FolderGlyph
                      className={cn(
                        'h-[1.05rem] w-[1.05rem] shrink-0',
                        isActive
                          ? 'text-[var(--accent-strong)]'
                          : 'text-[color-mix(in_srgb,var(--accent-strong)_64%,var(--text-muted)_36%)]',
                      )}
                    />
                  ) : (
                    <span className="w-[1.05rem] shrink-0" aria-hidden="true" />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      group.hasChildren ? 'font-semibold' : 'font-medium',
                    )}
                  >
                    {group.label}
                  </span>
                  <span className="shrink-0 text-[0.7rem] font-semibold text-[var(--text-muted)]">
                    {group.hostCount}
                  </span>
                </button>
              </div>
            );
          })
        )}
        </div>
      </nav>

      {/* TAGS — separated, always visible (its own bounded scroll) */}
      {tagCounts.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-[0.55rem] border-t border-[var(--border)] px-[0.9rem] pb-[0.7rem] pt-[0.7rem]">
          <span className="text-[0.7rem] font-bold uppercase tracking-[0.14em] text-[var(--text-soft)]">
            Tags
          </span>
          <div className="flex max-h-[7.5rem] flex-wrap gap-[0.4rem] overflow-y-auto">
            {tagCounts.map(({ tag, count }) => {
              const active = activeTagFilter.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={active}
                  className={cn(
                    'inline-flex items-center gap-[0.25rem] rounded-full border px-[0.55rem] py-[0.25rem] text-[0.7rem] font-medium transition-colors duration-140',
                    active
                      ? 'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]'
                      : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)] hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] hover:text-[var(--text)]',
                  )}
                  onClick={() => toggleTagFilter(tag)}
                >
                  <span className="truncate">{tag}</span>
                  <span className="text-[var(--text-muted)]">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Footer: section entry points (temporary home — to be refined later) */}
      <div className="flex shrink-0 items-center gap-[0.4rem] border-t border-[var(--border)] px-[0.7rem] py-[0.8rem]">
        {SECTION_ITEMS.map((item) => (
          <Tooltip key={item.section} label={item.label} className="flex-1">
            <button
              type="button"
              aria-label={item.label}
              className="inline-grid h-[2.4rem] w-full place-items-center rounded-[10px] border border-transparent bg-transparent text-[var(--text-soft)] transition-colors duration-140 hover:border-[var(--border)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--accent-strong)]"
              onClick={() => onSelectSection?.(item.section)}
            >
              <item.Icon className="h-[1.25rem] w-[1.25rem]" aria-hidden="true" />
            </button>
          </Tooltip>
        ))}
      </div>
    </aside>
  );
}
