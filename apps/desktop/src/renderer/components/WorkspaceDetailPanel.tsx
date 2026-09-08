import { useMemo } from "react";
import type {
  ActivityLogRecord,
  HostRecord,
  SavedWorkspaceRecord,
} from "@shared";
import { useTranslation } from "react-i18next";
import { getFormatLocale } from "../i18n";
import { listSavedWorkspaceLeaves } from "../store/utils";
import { Button, SectionLabel } from "../ui";
import {
  Clock,
  Copy,
  Pencil,
  Play,
  SquareTerminal,
  Star,
  Trash2,
} from "../ui/icons";
import { cn } from "../lib/cn";
import { WorkspacePreview } from "./WorkspacePreview";

interface WorkspaceDetailPanelProps {
  workspace: SavedWorkspaceRecord | null;
  hosts: readonly HostRecord[];
  activityLogs: readonly ActivityLogRecord[];
  onOpen: (workspaceId: string) => void | Promise<unknown>;
  onRename: (workspace: SavedWorkspaceRecord) => void;
  onDuplicate: (workspaceId: string) => void | Promise<unknown>;
  onToggleFavorite: (
    workspaceId: string,
    favorite: boolean,
  ) => void | Promise<unknown>;
  onDelete: (workspace: SavedWorkspaceRecord) => void;
}

export function WorkspaceDetailPanel({
  workspace,
  hosts,
  activityLogs,
  onOpen,
  onRename,
  onDuplicate,
  onToggleFavorite,
  onDelete,
}: WorkspaceDetailPanelProps) {
  const { t } = useTranslation();
  const formatLocale = getFormatLocale();
  const hostById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host] as const)),
    [hosts],
  );

  if (!workspace) {
    return (
      <aside className="grid min-h-0 place-items-center border-l border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_56%,var(--surface)_44%)] p-8 text-center">
        <p className="max-w-[16rem] text-sm leading-6 text-[var(--text-muted)]">
          {t("savedWorkspace.detail.placeholder")}
        </p>
      </aside>
    );
  }

  const leaves = listSavedWorkspaceLeaves(workspace.root);
  const missingHostIds = new Set(
    leaves.flatMap((leaf) =>
      leaf.target.kind === "host" && !hostById.has(leaf.target.hostId)
        ? [leaf.target.hostId]
        : [],
    ),
  );
  const workspaceHostLabels = new Map<string, string>();
  for (const leaf of leaves) {
    if (leaf.target.kind !== "host") {
      continue;
    }
    workspaceHostLabels.set(
      leaf.target.hostId,
      hostById.get(leaf.target.hostId)?.label ?? leaf.target.label,
    );
  }
  const workspaceLogs = activityLogs
    .flatMap((record) => {
      const metadata = record.metadata as {
        hostId?: string;
        hostLabel?: string;
        label?: string;
        title?: string;
      } | null;
      const hostId =
        typeof metadata?.hostId === "string" ? metadata.hostId : null;
      if (!hostId || !workspaceHostLabels.has(hostId)) {
        return [];
      }
      return [
        {
          record,
          hostLabel:
            hostById.get(hostId)?.label ??
            metadata?.hostLabel ??
            metadata?.label ??
            metadata?.title ??
            workspaceHostLabels.get(hostId) ??
            hostId,
        },
      ];
    })
    .slice(0, 5);

  return (
    <aside className="h-full min-h-0 overflow-y-auto overscroll-contain bg-[color-mix(in_srgb,var(--surface-muted)_56%,var(--surface)_44%)] p-[1rem]">
      <div className="flex min-h-full flex-col gap-[1rem]">
        <section className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-[0.9rem] shadow-[var(--shadow-card)]">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <SectionLabel>{t("savedWorkspace.detail.title")}</SectionLabel>
              <h2 className="mt-1 truncate text-[1.08rem] font-bold text-[var(--text)]">
                {workspace.name}
              </h2>
              <p className="mt-1 text-[0.72rem] text-[var(--text-muted)]">
                {t("savedWorkspace.created", {
                  date: new Date(workspace.createdAt).toLocaleDateString(
                    formatLocale,
                  ),
                })}
              </p>
            </div>
            <button
              type="button"
              aria-label={
                workspace.favorite
                  ? t("savedWorkspace.unfavorite")
                  : t("savedWorkspace.favorite")
              }
              aria-pressed={workspace.favorite}
              className={cn(
                "grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-[var(--border)] bg-[var(--surface-elevated)] transition-colors hover:bg-[var(--surface-muted)]",
                workspace.favorite
                  ? "text-[#e0a23a]"
                  : "text-[var(--text-muted)]",
              )}
              onClick={() =>
                void onToggleFavorite(workspace.id, !workspace.favorite)
              }
            >
              <Star
                className={cn("h-4 w-4", workspace.favorite && "fill-current")}
                aria-hidden="true"
              />
            </button>
          </div>

          <WorkspacePreview
            node={workspace.root}
            missingHostIds={missingHostIds}
            showLabels
            className="mt-[0.9rem] h-[178px]"
          />

          <div className="mt-[0.8rem] grid grid-cols-2 gap-2">
            <Button onClick={() => void onOpen(workspace.id)}>
              <Play className="h-4 w-4" aria-hidden="true" />
              {t("savedWorkspace.open")}
            </Button>
            <Button variant="secondary" onClick={() => onRename(workspace)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t("common.rename")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void onDuplicate(workspace.id)}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              {t("common.duplicate")}
            </Button>
            <Button variant="danger" onClick={() => onDelete(workspace)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t("common.delete")}
            </Button>
          </div>
        </section>

        <section className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-[0.9rem] shadow-[var(--shadow-card)]">
          <SectionLabel>{t("savedWorkspace.panesHeading")}</SectionLabel>
          <div className="mt-[0.65rem] space-y-1.5">
            {leaves.map((leaf) => {
              const local = leaf.target.kind === "local";
              const missing =
                leaf.target.kind === "host" &&
                !hostById.has(leaf.target.hostId);
              const liveLabel =
                leaf.target.kind === "host"
                  ? (hostById.get(leaf.target.hostId)?.label ??
                    leaf.target.label)
                  : leaf.target.label;
              return (
                <div
                  key={leaf.nodeId}
                  className="flex items-center gap-2 rounded-[9px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[0.65rem] py-[0.55rem]"
                >
                  <SquareTerminal
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      missing
                        ? "text-[var(--danger-text)]"
                        : "text-[var(--accent-strong)]",
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[0.76rem] font-medium text-[var(--text)]",
                      missing && "line-through",
                    )}
                  >
                    {liveLabel}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[0.64rem]",
                      missing
                        ? "text-[var(--danger-text)]"
                        : "text-[var(--text-muted)]",
                    )}
                  >
                    {local
                      ? t("savedWorkspace.local")
                      : missing
                        ? t("savedWorkspace.missing")
                        : t("savedWorkspace.ready")}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-[0.9rem] shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2">
            <Clock
              className="h-3.5 w-3.5 text-[var(--text-muted)]"
              aria-hidden="true"
            />
            <SectionLabel>{t("savedWorkspace.recentActivity")}</SectionLabel>
          </div>
          {workspaceLogs.length > 0 ? (
            <div className="mt-[0.65rem] space-y-2">
              {workspaceLogs.map(({ record, hostLabel }) => (
                <div
                  key={record.id}
                  className="border-l-2 border-[var(--border-strong)] pl-2.5"
                >
                  <strong className="block truncate text-[0.72rem] font-semibold text-[var(--text)]">
                    {hostLabel}
                  </strong>
                  <p className="mt-0.5 text-[0.72rem] leading-snug text-[var(--text-soft)]">
                    {record.message}
                  </p>
                  <p className="mt-0.5 text-[0.62rem] text-[var(--text-muted)]">
                    {new Date(record.createdAt).toLocaleString(formatLocale)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-[0.65rem] text-[0.72rem] text-[var(--text-muted)]">
              {t("savedWorkspace.noRecentActivity")}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
