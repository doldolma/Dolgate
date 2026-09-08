import type { SavedWorkspaceNode } from "@shared";
import { cn } from "../lib/cn";

interface WorkspacePreviewProps {
  node: SavedWorkspaceNode;
  missingHostIds?: ReadonlySet<string>;
  showLabels?: boolean;
  className?: string;
}

export function WorkspacePreview({
  node,
  missingHostIds = new Set<string>(),
  showLabels = false,
  className,
}: WorkspacePreviewProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 overflow-hidden rounded-[8px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_74%,transparent_26%)] p-[4px]",
        className,
      )}
      aria-hidden="true"
    >
      <WorkspacePreviewNode
        node={node}
        missingHostIds={missingHostIds}
        showLabels={showLabels}
      />
    </div>
  );
}

function WorkspacePreviewNode({
  node,
  missingHostIds,
  showLabels,
}: {
  node: SavedWorkspaceNode;
  missingHostIds: ReadonlySet<string>;
  showLabels: boolean;
}) {
  if (node.kind === "leaf") {
    const local = node.target.kind === "local";
    const missing =
      node.target.kind === "host" && missingHostIds.has(node.target.hostId);
    return (
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[4px] border px-[3px] text-[0.62rem] font-medium",
          local
            ? "border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface-elevated)_88%,var(--surface-muted)_12%)] text-[var(--text-soft)]"
            : missing
              ? "border-[color-mix(in_srgb,var(--danger-text)_45%,var(--border)_55%)] bg-[var(--danger-bg)] text-[var(--danger-text)]"
              : "border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] bg-[var(--selection-tint)] text-[var(--accent-strong)]",
        )}
        title={node.target.label}
      >
        {showLabels ? (
          <span className="max-w-full truncate px-1">{node.target.label}</span>
        ) : null}
        {showLabels && !local ? (
          <span
            className={cn(
              "absolute left-[4px] top-[4px] h-[5px] w-[5px] rounded-full",
              missing ? "bg-[var(--danger-text)]" : "bg-[var(--success-text)]",
            )}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 gap-[3px]",
        node.axis === "horizontal" ? "flex-row" : "flex-col",
      )}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: node.ratio }}>
        <WorkspacePreviewNode
          node={node.first}
          missingHostIds={missingHostIds}
          showLabels={showLabels}
        />
      </div>
      <div className="flex min-h-0 min-w-0" style={{ flex: 1 - node.ratio }}>
        <WorkspacePreviewNode
          node={node.second}
          missingHostIds={missingHostIds}
          showLabels={showLabels}
        />
      </div>
    </div>
  );
}
