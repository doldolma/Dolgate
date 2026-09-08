import { useEffect, useMemo, useRef, useState } from "react";
import type { HostRecord, SavedWorkspaceRecord } from "@shared";
import { useTranslation } from "react-i18next";
import {
  countSavedWorkspacePanes,
  listSavedWorkspaceLeaves,
} from "../store/utils";
import { Button, EmptyState, SectionLabel } from "../ui";
import { Copy, MoreVertical, Pencil, Play, Trash2 } from "../ui/icons";
import { cn } from "../lib/cn";
import { formatLastUsed } from "./host-browser/hostDisplay";
import { WorkspacePreview } from "./WorkspacePreview";

interface WorkspaceListPanelProps {
  workspaces: readonly SavedWorkspaceRecord[];
  hosts: readonly HostRecord[];
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
  onOpen: (workspaceId: string) => void | Promise<unknown>;
  onRename: (workspace: SavedWorkspaceRecord) => void;
  onDuplicate: (workspaceId: string) => void | Promise<unknown>;
  onDelete: (workspace: SavedWorkspaceRecord) => void;
}

export function WorkspaceListPanel({
  workspaces,
  hosts,
  selectedWorkspaceId,
  onSelect,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: WorkspaceListPanelProps) {
  const { t } = useTranslation();
  const hostIdSet = useMemo(
    () => new Set(hosts.map((host) => host.id)),
    [hosts],
  );
  const [menuWorkspaceId, setMenuWorkspaceId] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuWorkspaceId) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!menuRootRef.current?.contains(event.target as Node)) {
        setMenuWorkspaceId(null);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuWorkspaceId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-end justify-between gap-4 border-b border-[var(--border)] px-[1.1rem] py-[0.9rem]">
        <div>
          <SectionLabel>{t("savedWorkspace.section")}</SectionLabel>
          <h2 className="mt-1 text-[1.05rem] font-bold text-[var(--text)]">
            {t("savedWorkspace.count", { count: workspaces.length })}
          </h2>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-[1.1rem]">
        {workspaces.length === 0 ? (
          <EmptyState
            title={t("savedWorkspace.empty.title")}
            description={t("savedWorkspace.empty.description")}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-[0.8rem]">
            {workspaces.map((workspace) => {
              const leaves = listSavedWorkspaceLeaves(workspace.root);
              const missingHostIds = new Set(
                leaves.flatMap((leaf) =>
                  leaf.target.kind === "host" &&
                  !hostIdSet.has(leaf.target.hostId)
                    ? [leaf.target.hostId]
                    : [],
                ),
              );
              const selected = selectedWorkspaceId === workspace.id;
              const menuOpen = menuWorkspaceId === workspace.id;
              const chips = leaves.slice(0, 3);
              return (
                <article
                  key={workspace.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  className={cn(
                    "group relative rounded-[14px] border bg-[var(--surface)] p-[0.8rem] text-left shadow-[var(--shadow-card)] transition-[border-color,background-color,transform] duration-150",
                    selected
                      ? "border-[var(--selection-border)] bg-[var(--selection-tint)]"
                      : "border-[var(--border)] hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--accent-strong)_32%,var(--border)_68%)] hover:bg-[var(--surface-elevated)]",
                  )}
                  onClick={() => onSelect(workspace.id)}
                  onDoubleClick={() => void onOpen(workspace.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(workspace.id);
                    }
                  }}
                >
                  <div className="flex gap-[0.75rem]">
                    <WorkspacePreview
                      node={workspace.root}
                      missingHostIds={missingHostIds}
                      className="h-[68px] w-[98px] shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-[0.9rem] font-semibold text-[var(--text)]">
                          {workspace.name}
                        </h3>
                        {workspace.favorite ? (
                          <span
                            className="text-[0.72rem] text-[var(--accent-strong)]"
                            aria-label={t("savedWorkspace.favorite")}
                          >
                            ★
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[0.72rem] text-[var(--text-muted)]">
                        {t("savedWorkspace.panes", {
                          count: countSavedWorkspacePanes(workspace.root),
                        })}
                        {workspace.lastOpenedAt
                          ? ` · ${formatLastUsed(new Date(workspace.lastOpenedAt).getTime())}`
                          : ""}
                      </p>
                      <div className="mt-[0.55rem] flex flex-wrap gap-[0.3rem]">
                        {chips.map((leaf) => {
                          const missing =
                            leaf.target.kind === "host" &&
                            missingHostIds.has(leaf.target.hostId);
                          return (
                            <span
                              key={leaf.nodeId}
                              className={cn(
                                "max-w-[6rem] truncate rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.45rem] py-[0.12rem] text-[0.64rem] text-[var(--text-soft)]",
                                leaf.target.kind === "local" && "italic",
                                missing &&
                                  "border-[color-mix(in_srgb,var(--danger-text)_32%,var(--border)_68%)] text-[var(--danger-text)] line-through",
                              )}
                            >
                              {leaf.target.label}
                            </span>
                          );
                        })}
                        {leaves.length > chips.length ? (
                          <span className="rounded-full border border-[var(--border)] px-[0.4rem] py-[0.12rem] text-[0.64rem] text-[var(--text-muted)]">
                            +{leaves.length - chips.length}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-[0.75rem] flex items-center justify-between border-t border-[var(--border)] pt-[0.65rem]">
                    <Button
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onOpen(workspace.id);
                      }}
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("savedWorkspace.open")}
                    </Button>
                    <div
                      className="relative"
                      ref={menuOpen ? menuRootRef : undefined}
                    >
                      <button
                        type="button"
                        aria-label={t("savedWorkspace.moreActions", {
                          name: workspace.name,
                        })}
                        className="grid h-8 w-8 place-items-center rounded-[8px] text-[var(--text-soft)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuWorkspaceId((current) =>
                            current === workspace.id ? null : workspace.id,
                          );
                        }}
                      >
                        <MoreVertical className="h-4 w-4" aria-hidden="true" />
                      </button>
                      {menuOpen ? (
                        <div className="absolute right-0 top-[calc(100%+4px)] z-30 w-40 rounded-[10px] border border-[var(--border)] bg-[var(--dialog-surface)] p-1 shadow-[var(--shadow-floating)]">
                          <WorkspaceMenuButton
                            icon={Pencil}
                            label={t("common.rename")}
                            onClick={() => {
                              setMenuWorkspaceId(null);
                              onRename(workspace);
                            }}
                          />
                          <WorkspaceMenuButton
                            icon={Copy}
                            label={t("common.duplicate")}
                            onClick={() => {
                              setMenuWorkspaceId(null);
                              void onDuplicate(workspace.id);
                            }}
                          />
                          <WorkspaceMenuButton
                            icon={Trash2}
                            label={t("common.delete")}
                            danger
                            onClick={() => {
                              setMenuWorkspaceId(null);
                              onDelete(workspace);
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function WorkspaceMenuButton({
  icon: Icon,
  label,
  danger = false,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[0.76rem] hover:bg-[var(--surface-muted)]",
        danger ? "text-[var(--danger-text)]" : "text-[var(--text)]",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}
