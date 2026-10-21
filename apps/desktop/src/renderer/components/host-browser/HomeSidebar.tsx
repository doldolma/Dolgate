import { useEffect, useRef, useState } from "react";
import { normalizeGroupPath } from "@shared";
import type { HomeSection } from "../../store/types";
import { PERSONAL_VAULT_ID } from "../../store/utils";
import { cn } from "../../lib/cn";
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
  MoreVertical,
  Plus,
  Scissors,
  Settings,
  Star,
  TriangleAlert,
  UnfoldVertical,
  User,
  type LucideIcon,
} from "../../ui/icons";
import { Tooltip } from "../../ui";
import { MarkSquare } from "../teams/TeamMark";
import { teamMarkOf } from "../teams/team-format";
import { groupTreeKey } from "./browserVaults";
import {
  GROUP_DRAG_MIME_TYPE,
  normalizeGroupSelectionForDelete,
  type GroupSortKey,
  type GroupTreeRow,
  type HostBrowserModel,
  type VaultTree,
} from "./useHostBrowser";
import { useTranslation } from "react-i18next";

interface HomeSidebarProps {
  hb: HostBrowserModel;
  /**
   * 포트 포워딩에서 쓰이고 있는 항목 수. 0 이면 배지를 그리지 않는다.
   *
   * 이 값을 여기서 스토어로 읽지 않는 이유는 host-browser 서브트리가 prop 전용이기 때문이다.
   */
  activePortForwardEntryCount?: number;
  /** 현재 홈 섹션. 아이콘 단독 푸터의 선택 상태를 한 곳에서 표현한다. */
  activeSection?: HomeSection;
  /**
   * All/Favorites에 Host와 함께 합산할 저장된 Workspace 수. 옵셔널로 두면 넘기는 것을 빼먹어도
   * 컴파일이 통과하고 배지 숫자만 조용히 줄어든다 — 필수로 받는다.
   */
  workspaceCount: number;
  favoriteWorkspaceCount: number;
}

const SECTION_ITEMS: Array<{
  section: HomeSection;
  label: string;
  Icon: LucideIcon;
}> = [
  { section: "portForwarding", label: "Port Forwarding", Icon: ArrowLeftRight },
  { section: "snippets", label: "Snippets", Icon: Scissors },
  { section: "logs", label: "Logs", Icon: List },
  { section: "settings", label: "Settings", Icon: Settings },
];

export function HomeSidebar({
  hb,
  activePortForwardEntryCount = 0,
  activeSection = "hosts",
  workspaceCount,
  favoriteWorkspaceCount,
}: HomeSidebarProps) {
  const { t: translate } = useTranslation();
  const {
    hosts,
    groupTreeRows,
    visibleGroupTreeRows,
    currentGroupPath,
    favoriteHostIds,
    favoritesFilterActive,
    toggleFavoritesFilter,
    tagCounts,
    activeTagFilter,
    toggleTagFilter,
    isRootDragTarget,
    draggedGroupPath,
    onSelectSection,
    groupSortKey,
    setGroupSortKey,
    hideEmptyGroups,
    setHideEmptyGroups,
    expandAllGroups,
    collapseAllGroups,
  } = hb;
  // 팀이 없으면 비어 있다 — 볼트 줄 없이 지금처럼 그린다.
  const vaultTrees = hb.vaultTrees ?? [];

  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
  const groupMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isGroupMenuOpen) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (
        groupMenuRef.current &&
        !groupMenuRef.current.contains(event.target as Node)
      ) {
        setIsGroupMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isGroupMenuOpen]);
  const groupMenuItemClass =
    "flex w-full items-center gap-[0.6rem] rounded-[8px] px-[0.7rem] py-[0.5rem] text-left text-[0.85rem] text-[var(--text)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)]";
  const groupSortOptions: Array<{ key: GroupSortKey; label: string }> = [
    { key: "manual", label: translate("sidebar.sortManual") },
    { key: "name", label: translate("sidebar.sortName") },
    { key: "recent", label: translate("sidebar.sortRecent") },
    { key: "count", label: translate("sidebar.sortCount") },
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
              aria-label={translate("sidebar.groupOptions")}
              title={translate("sidebar.groupOptions")}
              aria-haspopup="menu"
              aria-expanded={isGroupMenuOpen}
              className={cn(
                "inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[8px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)] transition-colors duration-140 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] hover:text-[var(--accent-strong)]",
                isGroupMenuOpen &&
                  "border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] text-[var(--accent-strong)]",
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
                    <ArrowDownUp
                      className="h-4 w-4 shrink-0 text-[var(--text-soft)]"
                      aria-hidden
                    />
                    <span className="flex-1">{option.label}</span>
                    {groupSortKey === option.key ? (
                      <Check
                        className="h-4 w-4 shrink-0 text-[var(--accent-strong)]"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                ))}

                <div
                  role="separator"
                  className="my-[0.3rem] h-px bg-[var(--border)]"
                />

                <button
                  type="button"
                  role="menuitem"
                  className={groupMenuItemClass}
                  onClick={() => {
                    expandAllGroups();
                    setIsGroupMenuOpen(false);
                  }}
                >
                  <UnfoldVertical
                    className="h-4 w-4 shrink-0 text-[var(--text-soft)]"
                    aria-hidden
                  />
                  <span className="flex-1">
                    {translate("sidebar.expandAll")}
                  </span>
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
                  <FoldVertical
                    className="h-4 w-4 shrink-0 text-[var(--text-soft)]"
                    aria-hidden
                  />
                  <span className="flex-1">
                    {translate("sidebar.collapseAll")}
                  </span>
                </button>

                <div
                  role="separator"
                  className="my-[0.3rem] h-px bg-[var(--border)]"
                />

                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={hideEmptyGroups}
                  className={groupMenuItemClass}
                  onClick={() => setHideEmptyGroups((value) => !value)}
                >
                  <EyeOff
                    className="h-4 w-4 shrink-0 text-[var(--text-soft)]"
                    aria-hidden
                  />
                  <span className="flex-1">
                    {translate("sidebar.hideEmpty")}
                  </span>
                  {hideEmptyGroups ? (
                    <Check
                      className="h-4 w-4 shrink-0 text-[var(--accent-strong)]"
                      aria-hidden
                    />
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
            "flex w-full min-w-0 items-center gap-[0.55rem] rounded-[10px] border border-transparent bg-transparent px-[0.55rem] py-[0.4rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]",
            activeSection === "hosts" &&
              currentGroupPath === null &&
              (hb.currentVaultId ?? null) === null &&
              !favoritesFilterActive &&
              "border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]",
            isRootDragTarget &&
              "border-[var(--selection-border)] bg-[var(--selection-tint-strong)]",
          )}
          onClick={() => {
            onSelectSection?.("hosts");
            hb.handleNavigateRoot();
          }}
          onDragOver={(event) => {
            // 볼트가 있으면 All 은 여러 볼트가 섞인 곳이라 놓을 자리가 아니다 — 볼트 줄에 놓는다.
            if (hb.hasVaults) {
              return;
            }
            const activeDraggedAssetKeys = hb.getActiveDraggedAssetKeys(
              event.dataTransfer,
            );
            const activeDraggedGroupPath =
              draggedGroupPath ??
              normalizeGroupPath(
                event.dataTransfer.getData(GROUP_DRAG_MIME_TYPE),
              );
            if (
              activeDraggedAssetKeys.length === 0 &&
              (!activeDraggedGroupPath ||
                !hb.canReparentGroup(activeDraggedGroupPath, null))
            ) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            hb.setIsRootDragTarget(true);
          }}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              nextTarget instanceof Node &&
              event.currentTarget.contains(nextTarget)
            ) {
              return;
            }
            hb.setIsRootDragTarget(false);
          }}
          onDrop={async (event) => {
            if (hb.hasVaults) {
              return;
            }
            const activeDraggedAssetKeys = hb.getActiveDraggedAssetKeys(
              event.dataTransfer,
            );
            const activeDraggedGroupPath =
              draggedGroupPath ??
              normalizeGroupPath(
                event.dataTransfer.getData(GROUP_DRAG_MIME_TYPE),
              );
            hb.setIsRootDragTarget(false);
            if (activeDraggedAssetKeys.length > 0) {
              event.preventDefault();
              try {
                await hb.moveAssetsToGroup(activeDraggedAssetKeys, null);
              } finally {
                hb.clearDragState();
              }
              return;
            }
            if (
              !activeDraggedGroupPath ||
              !hb.canReparentGroup(activeDraggedGroupPath, null)
            ) {
              return;
            }
            event.preventDefault();
            const nextGroupPath = hb.buildNextGroupPath(
              activeDraggedGroupPath,
              null,
            );
            if (!nextGroupPath) {
              return;
            }
            try {
              await hb.onMoveGroup(activeDraggedGroupPath, null);
              hb.applyGroupPathUiMutation(
                activeDraggedGroupPath,
                nextGroupPath,
              );
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
          <span className="min-w-0 flex-1 truncate font-semibold">All</span>
          <span className="shrink-0 text-[0.7rem] font-semibold text-[var(--text-muted)]">
            {hosts.length + workspaceCount}
          </span>
        </button>

        {/* 즐겨찾기 (UI only for now) */}
        <button
          type="button"
          aria-label={translate("sidebar.favorites")}
          className={cn(
            "flex w-full min-w-0 items-center gap-[0.55rem] rounded-[10px] border border-transparent bg-transparent px-[0.55rem] py-[0.4rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]",
            activeSection === "hosts" &&
              favoritesFilterActive &&
              "border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]",
          )}
          onClick={() => {
            onSelectSection?.("hosts");
            toggleFavoritesFilter();
          }}
        >
          <span
            aria-hidden="true"
            className="inline-grid h-[1.55rem] w-[1.55rem] shrink-0 place-items-center rounded-[8px] bg-[color-mix(in_srgb,#e8a33d_18%,transparent_82%)] text-[#d8901f]"
          >
            <Star className="h-[0.95rem] w-[0.95rem]" fill="currentColor" />
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold">
            {translate("sidebar.favorites")}
          </span>
          <span className="shrink-0 text-[0.7rem] font-semibold text-[var(--text-muted)]">
            {favoriteHostIds.length + favoriteWorkspaceCount}
          </span>
        </button>

        <div
          className="my-[0.4rem] h-px bg-[var(--border)]"
          aria-hidden="true"
        />

        {/* Group rows — the only scrollable region */}
        <div className="flex min-h-0 flex-1 flex-col gap-[0.25rem] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {vaultTrees.length > 0 ? (
            // 팀이 있으면 맨 윗단이 볼트다(개인 + 팀). 그룹은 그 아래 한 단 들어간다.
            vaultTrees.map((tree) => (
              <VaultSection
                key={tree.vaultId}
                hb={hb}
                tree={tree}
                activeSection={activeSection}
              />
            ))
          ) : groupTreeRows.length === 0 ? (
            <div className="px-[0.55rem] py-[0.7rem] text-[0.82rem] leading-[1.45] text-[var(--text-soft)]">
              {translate("sidebar.noGroups")}
            </div>
          ) : (
            visibleGroupTreeRows.map((group) => (
              <GroupTreeItem
                key={group.path}
                hb={hb}
                group={group}
                vaultId={PERSONAL_VAULT_ID}
                indent={0}
                activeSection={activeSection}
              />
            ))
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
                    "inline-flex items-center gap-[0.25rem] rounded-full border px-[0.55rem] py-[0.25rem] text-[0.7rem] font-medium transition-colors duration-140",
                    active
                      ? "border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]"
                      : "border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)] hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] hover:text-[var(--text)]",
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
        {SECTION_ITEMS.map((item) => {
          // 배지는 항목의 성질로 둔다 — 이 푸터는 스스로 임시라고 적혀 있어서, 나중에 재배치할 때
          // 포워딩 전용 분기가 아니라 항목과 함께 따라가야 한다.
          const badge =
            item.section === "portForwarding" ? activePortForwardEntryCount : 0;
          // 아이콘만 있는 버튼이라 숫자만 읽히면 뜻이 없다. 개수가 있을 때는 이름에 붙여 준다.
          const name =
            badge > 0 ? `${item.label} (${badge} active)` : item.label;
          return (
            <Tooltip key={item.section} label={name} className="flex-1">
              <button
                type="button"
                aria-label={name}
                className={cn(
                  "relative inline-grid h-[2.4rem] w-full place-items-center rounded-[10px] border bg-transparent text-[var(--text-soft)] transition-colors duration-140 hover:border-[var(--border)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--accent-strong)]",
                  activeSection === item.section
                    ? "border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]"
                    : "border-transparent",
                )}
                onClick={() => onSelectSection?.(item.section)}
              >
                <item.Icon
                  className="h-[1.25rem] w-[1.25rem]"
                  aria-hidden="true"
                />
                {/* 점이 아니라 개수다 — 1개는 의도한 것일 수 있고 여러 개면 정리 대상이라, 몇
                    개인지가 행동을 바꾼다. 시각 언어는 타이틀바의 업데이트 표시를 따르고 링만
                    사이드바 배경으로 바꾼다. 두 자리를 넘기면 아이콘을 가리므로 자른다. */}
                {badge > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-[0.3rem] top-[0.25rem] min-w-[1rem] rounded-full bg-[var(--accent-strong)] px-[0.2rem] text-center text-[0.62rem] font-semibold leading-[1rem] text-[var(--on-accent,#fff)] ring-2 ring-[var(--surface)]"
                  >
                    {badge > 9 ? "9+" : badge}
                  </span>
                ) : null}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * 그룹 줄 하나. 팀이 없을 때의 트리와 볼트 안의 트리가 같이 쓴다 — 볼트를 넘나드는 상태(접기·고르기·끌어 놓을
 * 자리)는 볼트까지 보고, 그룹 쓰기는 그 볼트로 간다.
 */
function GroupTreeItem({
  hb,
  group,
  vaultId,
  indent,
  activeSection,
}: {
  hb: HostBrowserModel;
  group: GroupTreeRow;
  vaultId: string;
  /** 볼트 줄 아래면 한 단 들어간다. */
  indent: number;
  activeSection: HomeSection;
}) {
  const { onSelectSection } = hb;
  // 개인은 경로 그대로라 팀이 없을 때의 키와 같다.
  const rowKey = groupTreeKey(vaultId, group.path);
  const collapsed = hb.collapsedTreeGroupPathSet.has(rowKey);
  const isActive =
    activeSection === "hosts" && hb.isCurrentGroup(vaultId, group.path);
  const isSelected = hb.isGroupSelected(vaultId, group.path);
  const FolderGlyph = group.hasChildren && !collapsed ? FolderOpen : Folder;
  return (
    <div className="flex min-w-0 items-stretch">
      {/* depth guide rails */}
      {Array.from({ length: group.depth + indent }).map((_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="relative w-[0.85rem] shrink-0"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)]" />
        </span>
      ))}
      {/* disclosure */}
      {group.hasChildren ? (
        <button
          type="button"
          className="flex w-[1.15rem] shrink-0 items-center justify-center self-stretch text-[var(--text-muted)] transition-colors duration-140 hover:text-[var(--text)]"
          aria-label={collapsed ? "Expand subgroup" : "Collapse subgroup"}
          onClick={() => hb.handleToggleGroupBranch(group.path, vaultId)}
        >
          <ChevronRight
            className={cn(
              "h-[0.85rem] w-[0.85rem] transition-transform duration-140",
              !collapsed && "rotate-90",
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
          "flex w-full min-w-0 items-center gap-[0.4rem] rounded-[10px] border border-transparent bg-transparent px-[0.55rem] py-[0.4rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]",
          isActive &&
            "border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]",
          !hb.currentGroupPath && isSelected && "text-[var(--text)]",
          isSelected &&
            !isActive &&
            "bg-[color-mix(in_srgb,var(--surface-elevated)_66%,transparent_34%)]",
          hb.dragTargetGroupPath === rowKey &&
            "border-[var(--selection-border)] bg-[var(--selection-tint-strong)]",
          // 놓일 자리 표시. 행 위/아래에 2px 액센트 선을 의사요소로 얹는다 — 실제
          // 항목을 끼워 넣으면 목록 높이가 흔들려 커서 아래 행이 밀린다.
          hb.groupDropEdge?.path === rowKey &&
            'relative before:absolute before:left-0 before:right-0 before:h-[2px] before:rounded-full before:bg-[var(--accent-strong)] before:content-[""]',
          hb.groupDropEdge?.path === rowKey &&
            (hb.groupDropEdge.edge === "before"
              ? "before:-top-[1px]"
              : "before:-bottom-[1px]"),
        )}
        data-group-tree-state={isSelected ? "selected" : "idle"}
        draggable
        onClick={(event) => {
          onSelectSection?.("hosts");
          hb.handleGroupSelection(group.path, event, vaultId);
        }}
        onDragStart={(event) => {
          hb.selectSingleGroup(group.path, vaultId);
          hb.startGroupDrag(group.path, vaultId, event.dataTransfer);
          event.dataTransfer.effectAllowed = hb.dragEffectAllowed;
          event.dataTransfer.setData("text/plain", group.label);
        }}
        onDragEnd={() => hb.clearDragState()}
        onDoubleClick={() => {
          if (group.hasChildren) {
            hb.handleToggleGroupBranch(group.path, vaultId);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          const nextGroupPaths = isSelected
            ? hb.selectedGroupPaths
            : [group.path];
          if (!isSelected) {
            hb.selectSingleGroup(group.path, vaultId);
          }
          hb.setContextMenu({
            kind: "group",
            groupPaths: normalizeGroupSelectionForDelete(nextGroupPaths),
            vaultId,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onDragOver={(event) => {
          // 같은 볼트는 옮기기, 다른 볼트는 복사(이 그룹 안으로), 그 밖은 놓이지 않는다.
          const intent = hb.resolveDropIntent(
            event.dataTransfer,
            vaultId,
            group.path,
          );
          if (!intent) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = intent;
          hb.setIsRootDragTarget(false);
          hb.setDropIntent(intent);
          if (intent === "copy") {
            // 복사는 "안으로" 만 — 형제 사이 자리 표시는 같은 볼트 옮기기에만 있다.
            hb.setGroupDropEdge(null);
            hb.setDragTargetGroupPath(rowKey);
            return;
          }
          const draggedGroup = hb.getActiveDraggedGroup(event.dataTransfer);

          // 행의 위/아래 25% 는 "이 자리로", 가운데 50% 는 "이 그룹 안으로".
          // 노션과 같은 규칙이고, 얇은 밴드를 잘못 노리는 사고를 줄인다.
          // 순서를 바꿀 수 없는 정렬에서는 판정하지 않는다 — 놓아도 제자리로 튄다.
          const edge = (() => {
            if (!hb.canReorderGroups || !draggedGroup) {
              return null;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientY - bounds.top) / bounds.height;
            if (ratio < 0.25) return "before" as const;
            if (ratio > 0.75) return "after" as const;
            return null;
          })();

          if (edge) {
            hb.setDragTargetGroupPath(null);
            hb.setGroupDropEdge({ path: rowKey, edge });
            return;
          }
          hb.setGroupDropEdge(null);
          hb.setDragTargetGroupPath(rowKey);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (
            nextTarget instanceof Node &&
            event.currentTarget.contains(nextTarget)
          ) {
            return;
          }
          hb.setDragTargetGroupPath((current) =>
            current === rowKey ? null : current,
          );
          hb.setGroupDropEdge((current) =>
            current?.path === rowKey ? null : current,
          );
        }}
        onDrop={async (event) => {
          const activeDraggedAssetKeys = hb.getActiveDraggedAssetKeys(
            event.dataTransfer,
          );
          const draggedGroup = hb.getActiveDraggedGroup(event.dataTransfer);
          const dropEdge = hb.groupDropEdge;
          hb.setDragTargetGroupPath(null);
          hb.setIsRootDragTarget(false);
          hb.setGroupDropEdge(null);
          if (
            hb.resolveDropIntent(event.dataTransfer, vaultId, group.path) ===
            "copy"
          ) {
            event.preventDefault();
            hb.requestVaultCopyFromDrop(event.dataTransfer, vaultId, group.path);
            hb.clearDragState();
            return;
          }
          if (activeDraggedAssetKeys.length > 0) {
            event.preventDefault();
            try {
              await hb.moveAssetsToGroup(
                activeDraggedAssetKeys,
                group.path,
                vaultId,
              );
            } finally {
              hb.clearDragState();
            }
            return;
          }
          if (
            !draggedGroup ||
            draggedGroup.vaultId !== vaultId ||
            !hb.canReparentGroup(draggedGroup.path, group.path)
          ) {
            return;
          }
          // 표시선이 떠 있었으면 "안으로" 가 아니라 "이 자리로" 다.
          if (dropEdge?.path === rowKey) {
            const target = hb.resolveGroupDropTarget(
              group.path,
              dropEdge.edge,
              draggedGroup.path,
              vaultId,
            );
            if (target) {
              event.preventDefault();
              try {
                await hb.reorderGroupIn(
                  draggedGroup.path,
                  target.parentPath,
                  target.index,
                  vaultId,
                );
              } catch {
                // HomeShell surfaces the error through the shared notice area.
              } finally {
                hb.clearDragState();
              }
            }
            return;
          }

          event.preventDefault();
          const nextGroupPath = hb.buildNextGroupPath(
            draggedGroup.path,
            group.path,
          );
          if (!nextGroupPath) {
            return;
          }
          try {
            await hb.moveGroupIn(draggedGroup.path, group.path, vaultId);
            hb.applyGroupPathUiMutation(
              draggedGroup.path,
              nextGroupPath,
              vaultId,
            );
            hb.setCollapsedTreeGroupPaths((current) =>
              current.filter((key) => key !== rowKey),
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
              "h-[1.05rem] w-[1.05rem] shrink-0",
              isActive
                ? "text-[var(--accent-strong)]"
                : "text-[color-mix(in_srgb,var(--accent-strong)_64%,var(--text-muted)_36%)]",
            )}
          />
        ) : (
          <span className="w-[1.05rem] shrink-0" aria-hidden="true" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            group.hasChildren ? "font-semibold" : "font-medium",
          )}
        >
          {group.label}
        </span>
        {hb.dropIntent === "copy" && hb.dragTargetGroupPath === rowKey ? (
          <CopyDropChip />
        ) : (
          <span className="shrink-0 text-[0.7rem] font-semibold text-[var(--text-muted)]">
            {group.assetCount}
          </span>
        )}
      </button>
    </div>
  );
}

/** 다른 볼트에 복사로 놓일 줄 — 옮기기와 같은 강조에 "+ Copy"(맥은 커서에도 + 가 붙는다). */
function CopyDropChip() {
  const { t: translate } = useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center gap-[0.2rem] rounded-[6px] border border-[color-mix(in_srgb,var(--accent-strong)_32%,var(--border))] bg-[var(--surface-elevated)] px-[0.45rem] py-[0.1rem] text-[0.72rem] font-semibold text-[var(--accent-strong)]">
      <Plus className="h-[0.75rem] w-[0.75rem]" aria-hidden="true" />
      {translate("hostBrowser.dropCopy")}
    </span>
  );
}

/**
 * 볼트 줄(V1 — 그룹 줄과 같은 결: 접기 화살표·아이콘·굵은 이름·개수)과 그 아래 그 볼트의 그룹 트리.
 *
 * 줄을 누르면 그 볼트 맨 위, 오른쪽 클릭이나 ⋯ 은 볼트 메뉴. 그 볼트 것은 줄 위에 놓아 맨 위로 옮긴다.
 * 동기화가 막힌 팀만 개수 자리에 경고 표시 + 툴팁 — 평소엔 아무것도 안 보인다.
 */
function VaultSection({
  hb,
  tree,
  activeSection,
}: {
  hb: HostBrowserModel;
  tree: VaultTree;
  activeSection: HomeSection;
}) {
  const { t: translate } = useTranslation();
  const vault = tree.vault;
  if (!vault) {
    return null;
  }
  const collapsed = tree.collapsed;
  const isActive =
    activeSection === "hosts" &&
    hb.currentVaultId === vault.id &&
    hb.currentGroupPath === null &&
    !hb.favoritesFilterActive;
  const blockedLabel =
    vault.blocked === "needs-rejoin"
      ? translate("teams.needsRejoin")
      : vault.blocked === "outdated"
        ? translate("teamsPanel.sync.outdated")
        : null;
  const menuLabel = translate("sidebar.vaultMenu", { name: vault.name });
  const openMenu = (x: number, y: number) =>
    hb.setContextMenu({ kind: "vault", vaultId: vault.id, x, y });

  return (
    <>
      <div className="group/vault relative flex min-w-0 items-stretch">
        <button
          type="button"
          className="flex w-[1.15rem] shrink-0 items-center justify-center self-stretch text-[var(--text-muted)] transition-colors duration-140 hover:text-[var(--text)]"
          aria-label={translate(
            collapsed ? "sidebar.expandVault" : "sidebar.collapseVault",
            { name: vault.name },
          )}
          aria-expanded={!collapsed}
          onClick={() => hb.toggleVaultCollapsed(vault.id)}
        >
          <ChevronRight
            className={cn(
              "h-[0.85rem] w-[0.85rem] transition-transform duration-140",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <button
          type="button"
          data-vault-id={vault.id}
          className={cn(
            "flex w-full min-w-0 items-center gap-[0.5rem] rounded-[10px] border border-transparent bg-transparent px-[0.55rem] py-[0.4rem] text-left text-[var(--text-soft)] transition-[background-color,border-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-elevated)_72%,transparent_28%)] hover:text-[var(--text)]",
            isActive &&
              "border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]",
            hb.vaultDragTargetId === vault.id &&
              "border-[var(--selection-border)] bg-[var(--selection-tint-strong)]",
          )}
          aria-current={isActive ? "location" : undefined}
          onClick={() => {
            hb.onSelectSection?.("hosts");
            hb.handleNavigateVault(vault.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(event.clientX, event.clientY);
          }}
          onDragOver={(event) => {
            // 같은 볼트는 맨 위로 옮기기, 다른 볼트는 맨 위로 복사.
            const intent = hb.resolveDropIntent(
              event.dataTransfer,
              vault.id,
              null,
            );
            if (!intent) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = intent;
            hb.setDropIntent(intent);
            hb.setVaultDragTargetId(vault.id);
          }}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              nextTarget instanceof Node &&
              event.currentTarget.contains(nextTarget)
            ) {
              return;
            }
            hb.setVaultDragTargetId((current) =>
              current === vault.id ? null : current,
            );
          }}
          onDrop={async (event) => {
            const activeDraggedAssetKeys = hb.getActiveDraggedAssetKeys(
              event.dataTransfer,
            );
            const draggedGroup = hb.getActiveDraggedGroup(event.dataTransfer);
            hb.setVaultDragTargetId(null);
            if (
              hb.resolveDropIntent(event.dataTransfer, vault.id, null) ===
              "copy"
            ) {
              event.preventDefault();
              hb.requestVaultCopyFromDrop(event.dataTransfer, vault.id, null);
              hb.clearDragState();
              return;
            }
            if (activeDraggedAssetKeys.length > 0) {
              if (!hb.canDropAssetsInVault(activeDraggedAssetKeys, vault.id)) {
                return;
              }
              event.preventDefault();
              try {
                await hb.moveAssetsToGroup(
                  activeDraggedAssetKeys,
                  null,
                  vault.id,
                );
              } finally {
                hb.clearDragState();
              }
              return;
            }
            if (
              !draggedGroup ||
              draggedGroup.vaultId !== vault.id ||
              !hb.canReparentGroup(draggedGroup.path, null)
            ) {
              return;
            }
            event.preventDefault();
            const nextGroupPath = hb.buildNextGroupPath(draggedGroup.path, null);
            if (!nextGroupPath) {
              return;
            }
            try {
              await hb.moveGroupIn(draggedGroup.path, null, vault.id);
              hb.applyGroupPathUiMutation(
                draggedGroup.path,
                nextGroupPath,
                vault.id,
              );
            } catch {
              // HomeShell surfaces the error through the shared notice area.
            } finally {
              hb.clearDragState();
            }
          }}
        >
          {vault.kind === "personal" ? (
            <span
              aria-hidden="true"
              className="inline-grid h-[1.4rem] w-[1.4rem] shrink-0 place-items-center rounded-[7px] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] text-[var(--accent-strong)]"
            >
              <User className="h-[0.85rem] w-[0.85rem]" />
            </span>
          ) : (
            <MarkSquare size="sm" tone={vault.blocked ? "muted" : "accent"}>
              {teamMarkOf(vault.name)}
            </MarkSquare>
          )}
          <span className="min-w-0 flex-1 truncate font-semibold text-[var(--text)]">
            {vault.name}
          </span>
          {/* 개수 자리는 폭을 정해 둔다 — 줄에 올리면 같은 자리에 ⋯ 이 뜬다. 막힌 팀은 그 자리에 경고(툴팁). */}
          {blockedLabel ? (
            <Tooltip label={blockedLabel} multiline className="shrink-0">
              <span
                role="img"
                aria-label={blockedLabel}
                className="inline-flex h-[1.4rem] w-[1.4rem] items-center justify-end text-[var(--warning-text)]"
              >
                <TriangleAlert className="h-[0.9rem] w-[0.9rem]" aria-hidden="true" />
              </span>
            </Tooltip>
          ) : hb.dropIntent === "copy" && hb.vaultDragTargetId === vault.id ? (
            <CopyDropChip />
          ) : (
            <span className="w-[1.4rem] shrink-0 text-right text-[0.7rem] font-semibold text-[var(--text-muted)] transition-opacity duration-140 group-focus-within/vault:opacity-0 group-hover/vault:opacity-0">
              {tree.assetCount}
            </span>
          )}
        </button>
        {/* 볼트 메뉴 단추. 줄 단추 안에 단추를 둘 수 없어 개수 자리 위에 겹쳐 둔다. 막힌 팀은 경고가 그 자리라 오른쪽 클릭으로 연다. */}
        {blockedLabel ? null : (
          <button
            type="button"
            aria-label={menuLabel}
            title={menuLabel}
            aria-haspopup="menu"
            className="absolute right-[0.55rem] top-1/2 inline-grid h-[1.4rem] w-[1.4rem] -translate-y-1/2 place-items-center rounded-[7px] text-[var(--text-soft)] opacity-0 transition-[opacity,background-color,color] duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)] focus-visible:opacity-100 group-focus-within/vault:opacity-100 group-hover/vault:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect();
              openMenu(bounds.left, bounds.bottom + 4);
            }}
          >
            <MoreVertical className="h-[0.9rem] w-[0.9rem]" aria-hidden="true" />
          </button>
        )}
      </div>
      {collapsed
        ? null
        : tree.visibleRows.map((group) => (
            <GroupTreeItem
              key={groupTreeKey(vault.id, group.path)}
              hb={hb}
              group={group}
              vaultId={vault.id}
              indent={1}
              activeSection={activeSection}
            />
          ))}
    </>
  );
}
