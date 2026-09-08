import { normalizeGroupPath } from "@shared";
import type { HostRecord, SavedWorkspaceRecord } from "@shared";
import { cn } from "../../lib/cn";
import { HostRowBoundary } from "./HostRowBoundary";
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  MoreVertical,
  Star,
} from "../../ui/icons";
import {
  formatLastUsed,
  getHostAddress,
  getHostShortType,
} from "./hostDisplay";
import {
  HOME_ASSETS_DRAG_MIME_TYPE,
  HOST_DRAG_MIME_TYPE,
  HOSTS_DRAG_MIME_TYPE,
  type HostBrowserModel,
} from "./useHostBrowser";
import { useTranslation } from "react-i18next";
import { HostBadge } from "./HostBadge";
import { summarizeSavedWorkspace } from "./WorkspaceListCard";
import {
  parseHomeAssetKey,
  partitionHomeAssetKeys,
} from "./homeAssets";

interface HostListTableProps {
  hb: HostBrowserModel;
  hosts: readonly HostRecord[];
  onOpenWorkspace: (workspaceId: string) => Promise<unknown> | void;
  onToggleWorkspaceFavorite: (workspaceId: string, favorite: boolean) => void;
}

// 8열: 이름(배지+이름) · 타입 · IP/Host · 그룹 · 태그 · 최근 접속 · 즐겨찾기 · 메뉴.
// minmax(0,*fr)로 좁아져도 넘치지 않고 truncate 되게 한다(가로 스크롤 불필요).
const GRID_TEMPLATE =
  "minmax(0,1.7fr) 56px minmax(0,1.1fr) minmax(0,1.3fr) minmax(0,1fr) 80px 36px 36px";

const MAX_VISIBLE_TAGS = 2;

export function HostListTable({
  hb,
  hosts,
  onOpenWorkspace,
  onToggleWorkspaceFavorite,
}: HostListTableProps) {
  const { t: translate } = useTranslation();
  const {
    visibleHosts,
    favoriteHostIdSet,
    sortKey,
    sortDirection,
  } = hb;

  function openHostMenu(
    host: (typeof visibleHosts)[number],
    x: number,
    y: number,
  ) {
    const key = `host:${host.id}` as const;
    const isAlreadySelected = hb.selectedAssetKeySet.has(key);
    const targetAssetKeys = isAlreadySelected ? hb.selectedAssetKeys : [key];
    if (!isAlreadySelected) {
      hb.selectSingleAsset({ kind: "host", id: host.id }, "menu");
    }
    hb.setContextMenu({ kind: "asset", assetKeys: targetAssetKeys, x, y });
  }

  function openWorkspaceMenu(
    workspace: SavedWorkspaceRecord,
    x: number,
    y: number,
  ) {
    const key = `workspace:${workspace.id}` as const;
    const isAlreadySelected = hb.selectedAssetKeySet.has(key);
    const targetAssetKeys = isAlreadySelected ? hb.selectedAssetKeys : [key];
    if (!isAlreadySelected) {
      hb.selectSingleAsset({ kind: "workspace", id: workspace.id }, "menu");
    }
    hb.setContextMenu({ kind: "asset", assetKeys: targetAssetKeys, x, y });
  }

  function SortHeader({
    label,
    column,
    className,
  }: {
    label: string;
    column: "name" | "lastConnected";
    className?: string;
  }) {
    const active = sortKey === column;
    const Arrow = active && sortDirection === "asc" ? ChevronUp : ChevronDown;
    return (
      <button
        type="button"
        onClick={() => hb.toggleSort(column)}
        className={cn(
          "flex items-center gap-[0.2rem] text-left transition-colors duration-140 hover:text-[var(--text)]",
          active ? "text-[var(--accent-strong)]" : "text-[var(--text-soft)]",
          className,
        )}
      >
        {label}
        <Arrow
          className={cn(
            "h-[0.8rem] w-[0.8rem]",
            active ? "opacity-100" : "opacity-40",
          )}
          aria-hidden="true"
        />
      </button>
    );
  }

  return (
    <div className="text-[0.82rem]">
      {/* Header */}
      <div
        role="row"
        className="sticky top-0 z-[1] grid items-center gap-[0.7rem] border-b border-[var(--border)] bg-[var(--surface-strong)] px-[0.6rem] pb-[0.5rem] pt-[0.5rem] text-[0.74rem] font-semibold text-[var(--text-soft)]"
        style={{ gridTemplateColumns: GRID_TEMPLATE }}
      >
        <SortHeader label={translate("hostList.name")} column="name" />
        <span>{translate("hostList.type")}</span>
        <span>IP / Host</span>
        <span>{translate("hostList.group")}</span>
        <span>{translate("hostList.tags")}</span>
        <SortHeader
          label={translate("hostList.lastConnected")}
          column="lastConnected"
        />
        <span
          className="grid place-items-center"
          aria-label={translate("hostList.favorite")}
        >
          <Star className="h-[0.9rem] w-[0.9rem]" />
        </span>
        <span />
      </div>

      {/* Rows */}
      <div className="flex flex-col divide-y divide-[var(--border)]">
        {hb.visibleAssets.map((asset) =>
          asset.kind === "workspace" ? (
            <WorkspaceListTableRow
              key={asset.key}
              workspace={asset.record}
              hosts={hosts}
              hb={hb}
              selected={hb.selectedAssetKeySet.has(asset.key)}
              menuTarget={
                hb.contextMenu?.kind === "asset" &&
                hb.contextMenu.assetKeys.includes(asset.key)
              }
              // 세션을 열면 스토어가 호스트 편집기를 닫는다 — 먼저 묻는다(더블클릭·Enter 공용).
              onOpen={() =>
                hb.withLeaveHostEditor(() => void onOpenWorkspace(asset.id))
              }
              onToggleFavorite={() =>
                onToggleWorkspaceFavorite(
                  asset.id,
                  !asset.record.favorite,
                )
              }
              onOpenMenu={(x, y) =>
                openWorkspaceMenu(asset.record, x, y)
              }
            />
          ) : (
            <HostRowBoundary
              key={asset.key}
              host={asset.record}
              render={() => (
                <HostListTableRow
                  host={asset.record}
                  hb={hb}
                  isSelected={hb.selectedAssetKeySet.has(asset.key)}
                  isFavorite={favoriteHostIdSet.has(asset.id)}
                  isMenuTarget={
                    hb.contextMenu?.kind === "asset" &&
                    hb.contextMenu.assetKeys.includes(asset.key)
                  }
                  onOpenMenu={openHostMenu}
                />
              )}
            />
          ),
        )}
      </div>
    </div>
  );
}

function WorkspaceListTableRow({
  workspace,
  hosts,
  hb,
  selected,
  menuTarget,
  onOpen,
  onToggleFavorite,
  onOpenMenu,
}: {
  workspace: SavedWorkspaceRecord;
  hosts: readonly HostRecord[];
  hb: HostBrowserModel;
  selected: boolean;
  menuTarget: boolean;
  onOpen: () => Promise<unknown> | void;
  onToggleFavorite: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const { t: translate } = useTranslation();
  const summary = summarizeSavedWorkspace(workspace, hosts);
  const groupPath = normalizeGroupPath(workspace.groupName);
  const groupLabel = groupPath
    ? groupPath.split("/").join(" / ")
    : translate("savedWorkspace.ungrouped");
  const countLabels = [
    summary.hostCount > 0
      ? translate("savedWorkspace.hostCount", { count: summary.hostCount })
      : null,
    summary.localCount > 0
      ? translate("savedWorkspace.localCount", { count: summary.localCount })
      : null,
    summary.missingCount > 0
      ? translate("savedWorkspace.missingCount", {
          count: summary.missingCount,
        })
      : null,
  ].filter(Boolean);

  return (
    <div
      data-workspace-card="true"
      data-workspace-id={workspace.id}
      data-home-asset-key={`workspace:${workspace.id}`}
      data-workspace-card-state={selected ? "selected" : "idle"}
      data-workspace-menu-target={menuTarget ? "true" : undefined}
      role="button"
      tabIndex={0}
      draggable
      aria-pressed={selected}
      className={cn(
        "grid cursor-pointer items-center gap-[0.7rem] px-[0.6rem] py-[0.6rem] transition-[background-color] duration-140",
        selected
          ? "bg-[var(--selection-tint)]"
          : "hover:bg-[color-mix(in_srgb,var(--surface-elevated)_70%,transparent_30%)]",
        menuTarget &&
          "ring-2 ring-inset ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]",
      )}
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
      onClick={(event) =>
        hb.handleAssetSelection(
          { kind: "workspace", id: workspace.id },
          event,
        )
      }
      onDoubleClick={() => void onOpen()}
      onDragStart={(event) => {
        const assetKeys = hb.getNextDraggedAssetKeys({
          kind: "workspace",
          id: workspace.id,
        });
        if (!hb.selectedAssetKeySet.has(`workspace:${workspace.id}`)) {
          hb.selectSingleAsset({ kind: "workspace", id: workspace.id });
        }
        hb.setDraggedGroupPath(null);
        hb.setDraggedAssetKeys(assetKeys);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          HOME_ASSETS_DRAG_MIME_TYPE,
          JSON.stringify(assetKeys.map(parseHomeAssetKey)),
        );
        event.dataTransfer.setData(
          "text/plain",
          assetKeys.length === 1
            ? workspace.name
            : `${assetKeys.length} items`,
        );
      }}
      onDragEnd={() => hb.clearDragState()}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void onOpen();
        }
      }}
    >
      <span className="flex min-w-0 items-center gap-[0.55rem]">
        <span className="inline-grid h-[1.7rem] w-[1.7rem] shrink-0 place-items-center rounded-[7px] border border-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent)] text-[var(--accent-strong)]">
          <Columns2 className="h-[0.9rem] w-[0.9rem]" aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate font-medium text-[var(--text)]">
          {workspace.name}
        </span>
      </span>
      <span className="min-w-0 truncate text-[var(--text-soft)]">
        {translate("savedWorkspace.cardType")}
      </span>
      <span className="min-w-0 truncate text-[var(--text-soft)]">
        {summary.labels.join(" · ")}
      </span>
      <span className="min-w-0 truncate text-[var(--text-soft)]">
        {groupLabel}
      </span>
      <span className="min-w-0 truncate text-[0.72rem] text-[var(--text-soft)]">
        {countLabels.join(" · ")}
      </span>
      <span className="min-w-0 truncate text-[var(--text-soft)] tabular-nums">
        {formatLastUsed(summary.lastUsedAt)}
      </span>
      <button
        type="button"
        aria-label={
          workspace.favorite
            ? translate("savedWorkspace.unfavorite")
            : translate("savedWorkspace.favorite")
        }
        aria-pressed={workspace.favorite}
        className={cn(
          "inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[7px] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]",
          workspace.favorite
            ? "text-[#e0a23a]"
            : "text-[var(--text-muted)] hover:text-[var(--text-soft)]",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Star
          className="h-[0.95rem] w-[0.95rem]"
          fill={workspace.favorite ? "currentColor" : "none"}
        />
      </button>
      <button
        type="button"
        aria-label={translate("savedWorkspace.moreActions", {
          name: workspace.name,
        })}
        className="inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[7px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(rect.right, rect.bottom);
        }}
      >
        <MoreVertical className="h-[1.05rem] w-[1.05rem]" />
      </button>
    </div>
  );
}

function HostListTableRow({
  host,
  hb,
  isSelected,
  isFavorite,
  isMenuTarget,
  onOpenMenu,
}: {
  host: HostRecord;
  hb: HostBrowserModel;
  isSelected: boolean;
  isFavorite: boolean;
  /** 지금 열린 메뉴가 이 행을 대상으로 하는가(선택과 다른 표시 — 카드 쪽 주석 참고). */
  isMenuTarget: boolean;
  onOpenMenu: (host: HostRecord, x: number, y: number) => void;
}) {
  const { t: translate } = useTranslation();
  const group = normalizeGroupPath(host.groupName);
  const address = getHostAddress(host);
  const lastUsedAt = hb.lastConnectedByHostId.get(host.id);
  const tags = host.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflowTagCount = tags.length - visibleTags.length;

  return (
    <div
      data-host-card="true"
      data-host-id={host.id}
      data-home-asset-key={`host:${host.id}`}
      data-host-card-state={isSelected ? "selected" : "idle"}
      data-host-menu-target={isMenuTarget ? "true" : undefined}
      role="button"
      tabIndex={0}
      draggable
      className={cn(
        "grid cursor-pointer items-center gap-[0.7rem] px-[0.6rem] py-[0.6rem] transition-[background-color] duration-140",
        isSelected
          ? "bg-[var(--selection-tint)]"
          : "hover:bg-[color-mix(in_srgb,var(--surface-elevated)_70%,transparent_30%)]",
        isMenuTarget &&
          "ring-2 ring-inset ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]",
      )}
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
      onClick={(event) => {
        hb.handleAssetSelection({ kind: "host", id: host.id }, event);
      }}
      onDoubleClick={() => {
        hb.withLeaveHostEditor(() => void hb.onConnectHost(host.id));
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(host, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          hb.withLeaveHostEditor(() => void hb.onConnectHost(host.id));
        }
      }}
      onDragStart={(event) => {
        const assetKeys = hb.getNextDraggedAssetKeys({
          kind: "host",
          id: host.id,
        });
        if (!hb.selectedAssetKeySet.has(`host:${host.id}`)) {
          hb.selectSingleAsset({ kind: "host", id: host.id });
        }
        const hostIds = partitionHomeAssetKeys(assetKeys).hostIds;
        hb.setDraggedGroupPath(null);
        hb.setDraggedAssetKeys(assetKeys);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          HOME_ASSETS_DRAG_MIME_TYPE,
          JSON.stringify(assetKeys.map(parseHomeAssetKey)),
        );
        event.dataTransfer.setData(
          HOST_DRAG_MIME_TYPE,
          hostIds[0] ?? host.id,
        );
        event.dataTransfer.setData(
          HOSTS_DRAG_MIME_TYPE,
          JSON.stringify(hostIds),
        );
        event.dataTransfer.setData(
          "text/plain",
          assetKeys.length === 1 ? host.label : `${assetKeys.length} items`,
        );
      }}
      onDragEnd={() => hb.clearDragState()}
    >
      {/* 이름 + 배지 */}
      <span className="flex min-w-0 items-center gap-[0.55rem]">
        {/* 표는 행이 얕아 뱃지도 한 단계 작게 그린다. */}
        <HostBadge
          host={host}
          className="h-[1.7rem] w-[1.7rem] rounded-[7px]"
        />
        <span className="min-w-0 truncate font-medium text-[var(--text)]">
          {host.label}
        </span>
      </span>

      {/* 타입 */}
      <span className="min-w-0 truncate text-[var(--text-soft)]">
        {getHostShortType(host)}
      </span>

      {/* IP / Host */}
      <span className="min-w-0 truncate text-[var(--text-soft)]">
        {address ?? "—"}
      </span>

      {/* 그룹 */}
      <span className="min-w-0 truncate text-[var(--text-soft)]">
        {group ? group.split("/").join(" / ") : "Ungrouped"}
      </span>

      {/* 태그 */}
      <span className="flex min-w-0 items-center gap-[0.25rem]">
        {visibleTags.map((tag) => (
          <span
            key={tag}
            className="inline-flex min-w-0 items-center truncate rounded-full border border-[color-mix(in_srgb,var(--accent-strong)_16%,var(--border)_84%)] bg-[color-mix(in_srgb,var(--accent-strong)_9%,transparent_91%)] px-[0.4rem] py-[0.15rem] text-[0.68rem] font-medium text-[var(--accent-strong)]"
          >
            {tag}
          </span>
        ))}
        {overflowTagCount > 0 ? (
          <span className="shrink-0 text-[0.68rem] font-medium text-[var(--text-muted)]">
            +{overflowTagCount}
          </span>
        ) : null}
      </span>

      {/* 최근 접속 */}
      <span className="min-w-0 truncate text-[var(--text-soft)] tabular-nums">
        {lastUsedAt ? formatLastUsed(lastUsedAt) : "—"}
      </span>

      {/* 즐겨찾기 */}
      <button
        type="button"
        aria-label={translate("hostList.favoriteFor", { label: host.label })}
        aria-pressed={isFavorite}
        className={cn(
          "inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[7px] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]",
          isFavorite
            ? "text-[#e0a23a]"
            : "text-[var(--text-muted)] hover:text-[var(--text-soft)]",
        )}
        onClick={(event) => {
          event.stopPropagation();
          hb.toggleFavorite(host.id);
        }}
      >
        <Star
          className="h-[0.95rem] w-[0.95rem]"
          fill={isFavorite ? "currentColor" : "none"}
        />
      </button>

      {/* 메뉴 */}
      <button
        type="button"
        aria-label={translate("hostList.menuFor", { label: host.label })}
        className="inline-grid h-[1.6rem] w-[1.6rem] place-items-center rounded-[7px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(host, rect.right, rect.bottom);
        }}
      >
        <MoreVertical className="h-[1.05rem] w-[1.05rem]" />
      </button>
    </div>
  );
}
