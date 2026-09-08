import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedWorkspaceRecord } from "@shared";
import { cn } from "../../lib/cn";
import { listSavedWorkspaceLeaves } from "../../store/utils";
import { CommandPalette, type CommandPaletteItem } from "../CommandPalette";
import {
  ChevronDown,
  Columns2,
  LayoutGrid,
  List,
  Search,
} from "../../ui/icons";
import { HostListCard } from "./HostListCard";
import { HostListTable } from "./HostListTable";
import { HostRowBoundary } from "./HostRowBoundary";
import { WorkspaceListCard } from "./WorkspaceListCard";
import { buildHostBrowserCommandPaletteItems } from "./commandPaletteItems";
import {
  parseHomeAssetKey,
  partitionHomeAssetKeys,
} from "./homeAssets";
import {
  Button,
  EmptyState,
  SplitButton,
  SplitButtonMain,
  SplitButtonMenu,
  SplitButtonMenuItem,
  SplitButtonToggle,
} from "../../ui";
import {
  HOME_ASSETS_DRAG_MIME_TYPE,
  HOST_BROWSER_IMPORT_MENU_LABELS,
  HOST_DRAG_MIME_TYPE,
  HOSTS_DRAG_MIME_TYPE,
  type HostBrowserModel,
} from "./useHostBrowser";
import { useTranslation } from "react-i18next";

interface HostListPanelProps {
  hb: HostBrowserModel;
  workspaces: readonly SavedWorkspaceRecord[];
  onOpenWorkspace: (workspaceId: string) => void | Promise<unknown>;
  onToggleWorkspaceFavorite: (
    workspaceId: string,
    favorite: boolean,
  ) => void | Promise<unknown>;
}

const SORT_OPTIONS: Array<{
  value: HostBrowserModel["sortKey"];
  labelKey: string;
}> = [
  { value: "name", labelKey: "hostListPanel.sortName" },
  { value: "lastConnected", labelKey: "hostListPanel.sortLastConnected" },
  { value: "recent", labelKey: "hostListPanel.sortRecent" },
];

export function HostListPanel({
  hb,
  workspaces,
  onOpenWorkspace,
  onToggleWorkspaceFavorite,
}: HostListPanelProps) {
  const { t: translate } = useTranslation();
  const {
    desktopPlatform,
    hosts,
    searchQuery,
    searchPlaceholder,
    onSearchChange,
    visibleHosts,
    emptyMessage,
    selectedHostId,
    selectedHostIds,
    selectedGroupPaths,
    selectedHostIdSet,
    favoriteHostIdSet,
    viewMode,
    sortKey,
    isImportMenuOpen,
    importMenuRef,
  } = hb;
  const visibleAssetCount = visibleHosts.length + workspaces.length;
  const totalAssetCount = hosts.length + (hb.savedWorkspaces?.length ?? 0);
  const combinedEmptyTitle =
    totalAssetCount === 0
      ? translate("savedWorkspace.emptyAssetsTitle")
      : searchQuery.trim()
        ? translate("hostBrowserEmpty.noResults")
        : emptyMessage === translate("hostBrowserEmpty.noHosts")
          ? translate("hostBrowserEmpty.noHostsHere")
          : emptyMessage;
  const combinedEmptyDescription =
    totalAssetCount === 0
      ? translate("savedWorkspace.emptyAssetsDescription")
      : translate("savedWorkspace.noMatchingAssets");

  const shortcutLabel = desktopPlatform === "darwin" ? "⌘K" : "Ctrl K";
  const paletteRootRef = useRef<HTMLDivElement | null>(null);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [activePaletteIndex, setActivePaletteIndex] = useState(0);

  const importMenuItems = useMemo(
    () => [
      {
        label: HOST_BROWSER_IMPORT_MENU_LABELS[0],
        onSelect: hb.onOpenDolgateImport,
      },
      {
        label: HOST_BROWSER_IMPORT_MENU_LABELS[1],
        onSelect: hb.onOpenOpenSshImport,
      },
      {
        label: HOST_BROWSER_IMPORT_MENU_LABELS[2],
        onSelect: hb.onOpenTermiusImport,
      },
      ...(desktopPlatform === "win32"
        ? [
            {
              label: HOST_BROWSER_IMPORT_MENU_LABELS[3],
              onSelect: hb.onOpenXshellImport,
            },
          ]
        : []),
      {
        label: HOST_BROWSER_IMPORT_MENU_LABELS[4],
        onSelect: hb.onOpenWarpgateImport,
      },
      {
        label: HOST_BROWSER_IMPORT_MENU_LABELS[5],
        onSelect: hb.onOpenAwsImport,
      },
    ],
    [
      desktopPlatform,
      hb.onOpenDolgateImport,
      hb.onOpenAwsImport,
      hb.onOpenOpenSshImport,
      hb.onOpenTermiusImport,
      hb.onOpenWarpgateImport,
      hb.onOpenXshellImport,
    ],
  );

  // 팔레트 후보는 hb.paletteWorkspaces 에서 온다 — 화면 목록(workspaces = visibleWorkspaces)이
  // 아니다. 목록은 그룹 스코프·태그·즐겨찾기 필터와 사용자가 고른 정렬을 따르는데, 팔레트의
  // 호스트 항목은 전체에서 나오므로 여기만 목록을 쓰면 같은 드롭다운의 범위가 종류마다 달라진다.
  const workspacePaletteItems = useMemo<CommandPaletteItem[]>(
    () =>
      hb.paletteWorkspaces
        .slice(0, searchQuery.trim() ? 6 : 3)
        .map((workspace) => {
          const leaves = listSavedWorkspaceLeaves(workspace.root);
          return {
            id: `workspace:open:${workspace.id}`,
            group: "workspace",
            title: workspace.name,
            subtitle: translate("savedWorkspace.quickSubtitle", {
              count: leaves.length,
              targets: leaves.map((leaf) => leaf.target.label).join(" · "),
            }),
            keywords: [
              workspace.name,
              ...leaves.map((leaf) => leaf.target.label),
            ],
            Icon: Columns2,
            run: () => {
              hb.withLeaveHostEditor(() => void onOpenWorkspace(workspace.id));
            },
          };
        }),
    [
      hb.paletteWorkspaces,
      hb.withLeaveHostEditor,
      onOpenWorkspace,
      searchQuery,
      translate,
    ],
  );
  const paletteItems = [
    ...workspacePaletteItems,
    ...buildHostBrowserCommandPaletteItems(hb),
  ];

  const clampedActivePaletteIndex =
    paletteItems.length === 0
      ? 0
      : Math.min(activePaletteIndex, paletteItems.length - 1);

  useEffect(() => {
    if (!isPaletteOpen) {
      return;
    }
    setActivePaletteIndex(0);
  }, [isPaletteOpen, searchQuery]);

  useEffect(() => {
    if (!isPaletteOpen) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      if (paletteRootRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsPaletteOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isPaletteOpen]);

  function runPaletteItem(item: CommandPaletteItem) {
    if (item.disabledReason) {
      return;
    }
    setIsPaletteOpen(false);
    void Promise.resolve(item.run());
  }

  function handleBackgroundClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (
      // 종류별 속성을 나열하지 않는다 — 새 종류가 늘 때 여기 한 줄이 빠지면 그 카드를 누를 때마다
      // 선택이 풀린다. 홈 목록의 항목은 모두 data-home-asset-key 를 갖는다.
      target.closest("[data-home-asset-key]") ||
      target.closest('[role="menu"]') ||
      target.closest("button") ||
      target.closest("input") ||
      target.closest("select") ||
      target.closest('[data-host-browser-modal="true"]')
    ) {
      return;
    }
    hb.clearSelections();
  }

  function openHostMenu(
    host: (typeof visibleHosts)[number],
    x: number,
    y: number,
  ) {
    const key = `host:${host.id}` as const;
    const isAlreadySelected = hb.selectedAssetKeySet.has(key);
    const targetAssetKeys = isAlreadySelected
      ? hb.selectedAssetKeys
      : [key];
    if (!isAlreadySelected) {
      hb.selectSingleAsset({ kind: "host", id: host.id }, "menu");
    }
    hb.setContextMenu({
      kind: "asset",
      assetKeys: targetAssetKeys,
      x,
      y,
    });
  }

  function renderHostCard(host: (typeof visibleHosts)[number]) {
    // 카드 하나가 못 그려져도 나머지 목록은 남아야 한다. 내용을 함수로 넘기는 이유는
    // HostRowBoundary 주석에 있다(부모 렌더에서 계산하면 바운더리를 지나친다).
    return (
      <HostRowBoundary
        key={host.id}
        host={host}
        render={() => renderHostCardBody(host)}
      />
    );
  }

  function renderHostCardBody(host: (typeof visibleHosts)[number]) {
    return (
      <HostListCard
        host={host}
        selected={hb.selectedAssetKeySet.has(`host:${host.id}`)}
        focused={hb.focusedAssetKey === `host:${host.id}`}
        menuTarget={
          hb.contextMenu?.kind === "asset" &&
          hb.contextMenu.assetKeys.includes(`host:${host.id}`)
        }
        favorite={favoriteHostIdSet.has(host.id)}
        favoriteLabel={translate("hostListPanel.favoriteFor", {
          label: host.label,
        })}
        lastUsedAt={hb.lastConnectedByHostId.get(host.id)}
        onToggleFavorite={() => hb.toggleFavorite(host.id)}
        onOpenMenu={({ x, y }) => openHostMenu(host, x, y)}
        style={hb.clampedHostCardStyle}
        draggable
        role="button"
        tabIndex={0}
        onClick={(event) => {
          hb.handleAssetSelection({ kind: "host", id: host.id }, event);
        }}
        onDragStart={(event) => {
          const nextDraggedAssetKeys = hb.getNextDraggedAssetKeys({
            kind: "host",
            id: host.id,
          });
          if (!hb.selectedAssetKeySet.has(`host:${host.id}`)) {
            hb.selectSingleAsset({ kind: "host", id: host.id });
          }
          const refs = nextDraggedAssetKeys.map(parseHomeAssetKey);
          const nextDraggedHostIds = partitionHomeAssetKeys(
            nextDraggedAssetKeys,
          ).hostIds;
          hb.setDraggedGroupPath(null);
          hb.setDraggedAssetKeys(nextDraggedAssetKeys);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            HOME_ASSETS_DRAG_MIME_TYPE,
            JSON.stringify(refs),
          );
          event.dataTransfer.setData(
            HOST_DRAG_MIME_TYPE,
            nextDraggedHostIds[0] ?? host.id,
          );
          event.dataTransfer.setData(
            HOSTS_DRAG_MIME_TYPE,
            JSON.stringify(nextDraggedHostIds),
          );
          event.dataTransfer.setData(
            "text/plain",
            nextDraggedAssetKeys.length === 1
              ? host.label
              : `${nextDraggedAssetKeys.length} items`,
          );
        }}
        onDragEnd={() => hb.clearDragState()}
        onDoubleClick={() => {
          hb.withLeaveHostEditor(() => void hb.onConnectHost(host.id));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openHostMenu(host, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            hb.withLeaveHostEditor(() => void hb.onConnectHost(host.id));
          }
        }}
      />
    );
  }

  function openWorkspaceMenu(
    workspace: SavedWorkspaceRecord,
    x: number,
    y: number,
  ) {
    const key = `workspace:${workspace.id}` as const;
    const isAlreadySelected = hb.selectedAssetKeySet.has(key);
    const targetAssetKeys = isAlreadySelected
      ? hb.selectedAssetKeys
      : [key];
    if (!isAlreadySelected) {
      hb.selectSingleAsset({ kind: "workspace", id: workspace.id }, "menu");
    }
    hb.setContextMenu({
      kind: "asset",
      assetKeys: targetAssetKeys,
      x,
      y,
    });
  }

  function renderWorkspaceCard(workspace: SavedWorkspaceRecord) {
    return (
      <WorkspaceListCard
        key={workspace.id}
        workspace={workspace}
        hosts={hosts}
        selected={hb.selectedAssetKeySet.has(`workspace:${workspace.id}`)}
        menuTarget={
          hb.contextMenu?.kind === "asset" &&
          hb.contextMenu.assetKeys.includes(`workspace:${workspace.id}`)
        }
        onToggleFavorite={() =>
          onToggleWorkspaceFavorite(workspace.id, !workspace.favorite)
        }
        onOpenMenu={({ x, y }) => openWorkspaceMenu(workspace, x, y)}
        style={hb.clampedHostCardStyle}
        draggable
        role="button"
        tabIndex={0}
        aria-pressed={hb.selectedAssetKeySet.has(
          `workspace:${workspace.id}`,
        )}
        onClick={(event) => {
          hb.handleAssetSelection(
            { kind: "workspace", id: workspace.id },
            event,
          );
        }}
        onDragStart={(event) => {
          const nextDraggedAssetKeys = hb.getNextDraggedAssetKeys({
            kind: "workspace",
            id: workspace.id,
          });
          if (!hb.selectedAssetKeySet.has(`workspace:${workspace.id}`)) {
            hb.selectSingleAsset({ kind: "workspace", id: workspace.id });
          }
          hb.setDraggedGroupPath(null);
          hb.setDraggedAssetKeys(nextDraggedAssetKeys);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            HOME_ASSETS_DRAG_MIME_TYPE,
            JSON.stringify(nextDraggedAssetKeys.map(parseHomeAssetKey)),
          );
          event.dataTransfer.setData(
            "text/plain",
            nextDraggedAssetKeys.length === 1
              ? workspace.name
              : `${nextDraggedAssetKeys.length} items`,
          );
        }}
        onDragEnd={() => hb.clearDragState()}
        onDoubleClick={() => {
          hb.withLeaveHostEditor(() => void onOpenWorkspace(workspace.id));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openWorkspaceMenu(workspace, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            hb.withLeaveHostEditor(() => void onOpenWorkspace(workspace.id));
          }
        }}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onClickCapture={handleBackgroundClick}
    >
      {/* Toolbar row: search + actions */}
      <div className="flex items-center gap-3 px-[1.1rem] pb-[0.7rem] pt-[1.1rem] max-[760px]:flex-col max-[760px]:items-stretch">
        <div className="relative min-w-0 flex-1" ref={paletteRootRef}>
          <Search
            className="pointer-events-none absolute left-[0.75rem] top-1/2 h-[1rem] w-[1rem] -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <input
            id="host-search"
            value={searchQuery}
            onFocus={() => setIsPaletteOpen(true)}
            onChange={(event) => {
              onSearchChange(event.target.value);
              setIsPaletteOpen(true);
            }}
            onKeyDown={(event) => {
              if (!isPaletteOpen) {
                if (event.key === "ArrowDown") {
                  setIsPaletteOpen(true);
                  event.preventDefault();
                }
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActivePaletteIndex((current) =>
                  paletteItems.length === 0
                    ? 0
                    : Math.min(current + 1, paletteItems.length - 1),
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActivePaletteIndex((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                const item = paletteItems[clampedActivePaletteIndex];
                if (item) {
                  event.preventDefault();
                  runPaletteItem(item);
                }
              } else if (event.key === "Escape") {
                event.preventDefault();
                setIsPaletteOpen(false);
              }
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-expanded={isPaletteOpen}
            aria-controls="command-palette-results"
            aria-haspopup="listbox"
            className="pl-[2.4rem] pr-[3.4rem]"
          />
          <kbd className="pointer-events-none absolute right-[0.6rem] top-1/2 inline-flex -translate-y-1/2 items-center rounded-[6px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.4rem] py-[0.1rem] text-[0.7rem] font-medium text-[var(--text-muted)]">
            {shortcutLabel}
          </kbd>
          {isPaletteOpen ? (
            <CommandPalette
              items={paletteItems}
              activeIndex={clampedActivePaletteIndex}
              onActiveIndexChange={setActivePaletteIndex}
              onRunItem={runPaletteItem}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="primary"
            onClick={() => {
              hb.setIsImportMenuOpen(false);
              hb.onCreateHost();
            }}
          >
            New Host
          </Button>
          <SplitButton ref={importMenuRef}>
            <SplitButtonMain
              variant="secondary"
              onClick={() => {
                hb.setIsImportMenuOpen(false);
                hb.onOpenOpenSshImport();
              }}
            >
              Import
            </SplitButtonMain>
            <SplitButtonToggle
              variant="secondary"
              aria-label="Open import menu"
              aria-expanded={isImportMenuOpen}
              aria-haspopup="menu"
              onClick={() => hb.setIsImportMenuOpen((current) => !current)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  hb.setIsImportMenuOpen((current) => !current);
                }
              }}
            >
              <ChevronDown
                className={cn(
                  "h-[0.95rem] w-[0.95rem] transition-transform duration-140",
                  isImportMenuOpen && "rotate-180",
                )}
                aria-hidden="true"
              />
            </SplitButtonToggle>
            {isImportMenuOpen ? (
              <SplitButtonMenu role="menu" aria-label="Import host menu">
                {importMenuItems.map((item) => (
                  <SplitButtonMenuItem
                    key={item.label}
                    role="menuitem"
                    onClick={() => {
                      hb.setIsImportMenuOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </SplitButtonMenuItem>
                ))}
              </SplitButtonMenu>
            ) : null}
          </SplitButton>
          <Button
            variant="secondary"
            onClick={() => {
              hb.setIsImportMenuOpen(false);
              hb.onOpenLocalTerminal();
            }}
          >
            Local Terminal
          </Button>
        </div>
      </div>

      {/* Meta row: count + sort + view toggle */}
      <div className="flex items-center justify-between gap-3 px-[1.1rem] pb-[0.7rem]">
        <span className="text-[0.9rem] font-semibold text-[var(--text)]">
          {translate("savedWorkspace.assetCount", { count: visibleAssetCount })}
        </span>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-[0.25rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] p-[0.25rem]">
            <button
              type="button"
              aria-label={translate("hostListPanel.gridView")}
              aria-pressed={viewMode === "grid"}
              className={cn(
                "inline-grid h-[1.6rem] w-[1.85rem] place-items-center rounded-[8px] text-[0.82rem] transition-colors duration-140",
                viewMode === "grid"
                  ? "bg-[var(--selection-tint)] text-[var(--accent-strong)]"
                  : "text-[var(--text-soft)] hover:text-[var(--text)]",
              )}
              onClick={() => {
                void hb.setViewMode("grid");
              }}
            >
              <LayoutGrid className="h-[1rem] w-[1rem]" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={translate("hostListPanel.listView")}
              aria-pressed={viewMode === "list"}
              className={cn(
                "inline-grid h-[1.6rem] w-[1.85rem] place-items-center rounded-[8px] text-[0.82rem] transition-colors duration-140",
                viewMode === "list"
                  ? "bg-[var(--selection-tint)] text-[var(--accent-strong)]"
                  : "text-[var(--text-soft)] hover:text-[var(--text)]",
              )}
              onClick={() => {
                void hb.setViewMode("list");
              }}
            >
              <List className="h-[1rem] w-[1rem]" aria-hidden="true" />
            </button>
          </div>
          {/* 목록(테이블) 뷰는 헤더 클릭으로 정렬하므로 드롭다운은 격자 뷰에서만 노출. */}
          {viewMode === "list" ? null : (
            <>
              <label className="sr-only" htmlFor="host-sort">
                {translate("hostListPanel.sort")}
              </label>
              <div className="relative shrink-0">
                <select
                  id="host-sort"
                  value={sortKey}
                  onChange={(event) =>
                    hb.setSort(
                      event.target.value as HostBrowserModel["sortKey"],
                    )
                  }
                  className="h-[2rem] w-[8rem] appearance-none rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] py-0 pl-[0.7rem] pr-[1.7rem] text-[0.82rem] font-medium leading-none text-[var(--text-soft)] outline-none transition-colors duration-140 hover:text-[var(--text)] focus-visible:border-[var(--selection-border)]"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {translate(option.labelKey)}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-[0.5rem] top-1/2 h-[0.85rem] w-[0.85rem] -translate-y-1/2 text-[var(--text-soft)]"
                  aria-hidden="true"
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Cards */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-[1.1rem] pb-[1.1rem]",
          // 목록(테이블)은 흰 배경, 격자(카드)는 기존 투명 배경 위에 둔다.
          viewMode === "list" && "bg-[var(--surface-strong)]",
          // 위 여백은 **무엇을 그리는지**에 달렸다.
          //
          // 표는 머리글 행이 위 영역과 맞닿아야 해서 여백을 주지 않는다. 빈 상태는 그 표가 아니라
          // 안내 박스인데, 같은 컨테이너를 쓰는 탓에 그 pt-0 을 물려받아 툴바에 붙어 있었다.
          // 다른 화면들은 빈 상태를 PanelSection(gap 0.9rem) 안에 두므로 그 값에 맞춘다.
          visibleAssetCount === 0
            ? "pt-[0.9rem]"
            : viewMode === "list"
              ? "pt-0"
              : "pt-[0.4rem]",
        )}
        data-testid="host-browser-content"
      >
        {visibleAssetCount === 0 ? (
          <EmptyState
            title={combinedEmptyTitle}
            description={combinedEmptyDescription}
          />
        ) : viewMode === "list" ? (
          <HostListTable
            hb={hb}
            hosts={hosts}
            onOpenWorkspace={onOpenWorkspace}
            onToggleWorkspaceFavorite={onToggleWorkspaceFavorite}
          />
        ) : (
          <div
            data-host-grid="true"
            className="grid content-start gap-[0.9rem]"
            ref={hb.hostGridRef}
            style={hb.hostGridStyle}
          >
            {hb.visibleAssets.map((asset) =>
              asset.kind === "workspace"
                ? renderWorkspaceCard(asset.record)
                : renderHostCard(asset.record),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
