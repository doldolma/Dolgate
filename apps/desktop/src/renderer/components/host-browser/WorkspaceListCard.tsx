import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import {
  normalizeGroupPath,
  type HostRecord,
  type SavedWorkspaceRecord,
} from "@shared";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import {
  countSavedWorkspacePanes,
  listSavedWorkspaceLeaves,
} from "../../store/utils";
import { Columns2, MoreVertical, Star } from "../../ui/icons";
import { formatLastUsed } from "./hostDisplay";

export interface WorkspaceCardSummary {
  paneCount: number;
  hostCount: number;
  localCount: number;
  missingCount: number;
  labels: string[];
  lastUsedAt: number;
}

export function summarizeSavedWorkspace(
  workspace: SavedWorkspaceRecord,
  hosts: readonly HostRecord[],
): WorkspaceCardSummary {
  const hostById = new Map(hosts.map((host) => [host.id, host] as const));
  const leaves = listSavedWorkspaceLeaves(workspace.root);
  let hostCount = 0;
  let localCount = 0;
  let missingCount = 0;
  const labels = leaves.map((leaf) => {
    if (leaf.target.kind === "local") {
      localCount += 1;
      return leaf.target.label;
    }
    hostCount += 1;
    const host = hostById.get(leaf.target.hostId);
    if (!host) {
      missingCount += 1;
    }
    return host?.label ?? leaf.target.label;
  });
  const timestamp = workspace.lastOpenedAt ?? "";
  return {
    paneCount: countSavedWorkspacePanes(workspace.root),
    hostCount,
    localCount,
    missingCount,
    labels,
    lastUsedAt: Date.parse(timestamp) || 0,
  };
}

interface WorkspaceListCardProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  workspace: SavedWorkspaceRecord;
  hosts: readonly HostRecord[];
  selected?: boolean;
  menuTarget?: boolean;
  onToggleFavorite?: () => void;
  onOpenMenu?: (coords: { x: number; y: number }) => void;
  style?: CSSProperties;
}

export function WorkspaceListCard({
  workspace,
  hosts,
  selected = false,
  menuTarget = false,
  onToggleFavorite,
  onOpenMenu,
  className,
  ...props
}: WorkspaceListCardProps) {
  const { t } = useTranslation();
  const summary = summarizeSavedWorkspace(workspace, hosts);
  const groupPath = normalizeGroupPath(workspace.groupName);
  const groupLabel = groupPath
    ? groupPath.split("/").join(" / ")
    : t("savedWorkspace.ungrouped");

  // data-home-asset-key 를 카드가 직접 붙이는 이유는 HostListCard 의 같은 자리 주석에 있다.
  return (
    <article
      data-workspace-card="true"
      data-workspace-id={workspace.id}
      data-home-asset-key={`workspace:${workspace.id}`}
      data-workspace-card-state={selected ? "selected" : "idle"}
      data-workspace-menu-target={menuTarget ? "true" : undefined}
      className={cn(
        "flex h-full min-h-[7.75rem] cursor-pointer flex-col gap-[0.4rem] overflow-hidden rounded-[10px] border bg-[var(--surface-elevated)] px-[0.9rem] py-[0.7rem] text-left transition-[background-color,border-color,box-shadow] duration-150",
        selected
          ? "border-[var(--selection-border)] bg-[var(--selection-tint)]"
          : "border-[var(--border)] hover:border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--accent-strong)_8%)]",
        menuTarget &&
          "ring-2 ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-[0.55rem]">
        <span className="inline-grid h-[2rem] w-[2rem] shrink-0 place-items-center rounded-[9px] border border-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent)] text-[var(--accent-strong)]">
          <Columns2 className="h-[1rem] w-[1rem]" aria-hidden="true" />
        </span>
        <strong className="min-w-0 flex-1 truncate text-[0.9rem] text-[var(--text)]">
          {workspace.name}
        </strong>
        {onToggleFavorite ? (
          <button
            type="button"
            aria-label={
              workspace.favorite
                ? t("savedWorkspace.unfavorite")
                : t("savedWorkspace.favorite")
            }
            aria-pressed={workspace.favorite}
            className={cn(
              "inline-grid h-[1.7rem] w-[1.7rem] shrink-0 place-items-center rounded-[8px] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]",
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
              className="h-[1rem] w-[1rem]"
              fill={workspace.favorite ? "currentColor" : "none"}
            />
          </button>
        ) : null}
        {onOpenMenu ? (
          <button
            type="button"
            aria-label={t("savedWorkspace.moreActions", {
              name: workspace.name,
            })}
            className="inline-grid h-[1.7rem] w-[1.7rem] shrink-0 place-items-center rounded-[8px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenMenu({ x: rect.right, y: rect.bottom });
            }}
          >
            <MoreVertical className="h-[1.05rem] w-[1.05rem]" />
          </button>
        ) : null}
      </div>

      <span className="truncate text-[0.76rem] font-medium text-[var(--text-soft)]">
        {t("savedWorkspace.cardMeta", { count: summary.paneCount })}
      </span>
      <span className="truncate text-[0.76rem] text-[var(--text)]">
        {summary.labels.join(" · ")}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-[0.25rem]">
        {summary.hostCount > 0 ? (
          <WorkspaceCountChip>
            {t("savedWorkspace.hostCount", { count: summary.hostCount })}
          </WorkspaceCountChip>
        ) : null}
        {summary.localCount > 0 ? (
          <WorkspaceCountChip>
            {t("savedWorkspace.localCount", { count: summary.localCount })}
          </WorkspaceCountChip>
        ) : null}
        {summary.missingCount > 0 ? (
          <WorkspaceCountChip danger>
            {t("savedWorkspace.missingCount", {
              count: summary.missingCount,
            })}
          </WorkspaceCountChip>
        ) : null}
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-[var(--border)] pt-[0.4rem] text-[0.7rem] text-[var(--text-muted)]">
        <span className="min-w-0 flex-1 truncate">
          {groupLabel}
        </span>
        <span className="shrink-0 tabular-nums">
          {t("savedWorkspace.lastOpened", {
            date: formatLastUsed(summary.lastUsedAt),
          })}
        </span>
      </div>
    </article>
  );
}

function WorkspaceCountChip({
  children,
  danger = false,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--accent-strong)_16%,var(--border)_84%)] bg-[color-mix(in_srgb,var(--accent-strong)_9%,transparent_91%)] px-[0.4rem] py-[0.2rem] text-[0.68rem] font-medium text-[var(--accent-strong)]",
        danger &&
          "border-[color-mix(in_srgb,var(--danger-text)_32%,var(--border)_68%)] bg-[color-mix(in_srgb,var(--danger-text)_9%,transparent_91%)] text-[var(--danger-text)]",
      )}
    >
      {children}
    </span>
  );
}
