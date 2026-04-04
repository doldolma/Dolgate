import type {
  DynamicTabStripItem,
  WorkspaceDropDirection,
  WorkspaceLayoutNode,
  WorkspaceTab,
  WorkspaceTabId,
} from "../types";

export function asSessionTabId(sessionId: string): `session:${string}` {
  return `session:${sessionId}`;
}

export function asWorkspaceTabId(workspaceId: string): `workspace:${string}` {
  return `workspace:${workspaceId}`;
}

export function listWorkspaceSessionIds(node: WorkspaceLayoutNode): string[] {
  if (node.kind === "leaf") {
    return [node.sessionId];
  }
  return [
    ...listWorkspaceSessionIds(node.first),
    ...listWorkspaceSessionIds(node.second),
  ];
}

export function countWorkspaceSessions(node: WorkspaceLayoutNode): number {
  return listWorkspaceSessionIds(node).length;
}

export function updateWorkspaceSplitRatio(
  node: WorkspaceLayoutNode,
  splitId: string,
  ratio: number,
): WorkspaceLayoutNode {
  if (node.kind === "leaf") {
    return node;
  }

  const clampedRatio = Math.min(0.8, Math.max(0.2, ratio));
  if (node.id === splitId) {
    return {
      ...node,
      ratio: clampedRatio,
    };
  }

  return {
    ...node,
    first: updateWorkspaceSplitRatio(node.first, splitId, clampedRatio),
    second: updateWorkspaceSplitRatio(node.second, splitId, clampedRatio),
  };
}

export function resolveNextVisibleTab(
  tabStrip: DynamicTabStripItem[],
  removedIndex: number,
): WorkspaceTabId {
  const nextItem = tabStrip[removedIndex] ?? tabStrip[removedIndex - 1];
  if (!nextItem) {
    return "home";
  }
  if (nextItem.kind === "session") {
    return asSessionTabId(nextItem.sessionId);
  }
  if (nextItem.kind === "workspace") {
    return asWorkspaceTabId(nextItem.workspaceId);
  }
  return "home";
}

export function resolveAdjacentTarget(
  tabStrip: DynamicTabStripItem[],
  workspaces: WorkspaceTab[],
  sessionId: string,
): DynamicTabStripItem | null {
  const currentIndex = tabStrip.findIndex(
    (item) => item.kind === "session" && item.sessionId === sessionId,
  );
  if (currentIndex < 0) {
    return null;
  }

  const candidateIndexes = [currentIndex + 1, currentIndex - 1];
  for (const index of candidateIndexes) {
    const candidate = tabStrip[index];
    if (!candidate) {
      continue;
    }
    if (candidate.kind === "workspace") {
      const workspace = workspaces.find(
        (item) => item.id === candidate.workspaceId,
      );
      if (!workspace) {
        continue;
      }
      if (countWorkspaceSessions(workspace.layout) >= 4) {
        continue;
      }
    }
    return candidate;
  }

  return null;
}

export function directionAxis(
  direction: WorkspaceDropDirection,
): "horizontal" | "vertical" {
  return direction === "left" || direction === "right"
    ? "horizontal"
    : "vertical";
}
