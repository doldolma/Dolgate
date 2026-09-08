import type { HostRecord, SavedWorkspaceNode, TerminalTab } from "@shared";
import type { WorkspaceLayoutNode } from "../types";

export interface SavedWorkspaceLeafEntry {
  nodeId: string;
  target: Extract<SavedWorkspaceNode, { kind: "leaf" }>["target"];
}

export function countSavedWorkspacePanes(node: SavedWorkspaceNode): number {
  return node.kind === "leaf"
    ? 1
    : countSavedWorkspacePanes(node.first) +
        countSavedWorkspacePanes(node.second);
}

export function listSavedWorkspaceLeaves(
  node: SavedWorkspaceNode,
): SavedWorkspaceLeafEntry[] {
  if (node.kind === "leaf") {
    return [{ nodeId: node.id, target: node.target }];
  }
  return [
    ...listSavedWorkspaceLeaves(node.first),
    ...listSavedWorkspaceLeaves(node.second),
  ];
}

/**
 * 살아 있는 Workspace split 트리를 영속 target 트리로 바꾼다.
 *
 * tmux 여부는 호출자가 WorkspaceTab.tmux로 먼저 거른다. 여기서는 각 pane이 일반 호스트
 * 세션 또는 로컬 터미널인지 확인하고, 특수/유실 pane이 하나라도 있으면 null을 반환해
 * 일부만 저장되는 일을 막는다.
 */
export function captureSavedWorkspaceNode(
  node: WorkspaceLayoutNode,
  tabs: readonly TerminalTab[],
  hosts: readonly HostRecord[],
): SavedWorkspaceNode | null {
  if (node.kind === "leaf") {
    const tab = tabs.find((entry) => entry.sessionId === node.sessionId);
    if (!tab || tab.tmux) {
      return null;
    }
    if (
      tab.source === "local" &&
      tab.hostId === null &&
      tab.shellKind !== "aws-ecs-exec"
    ) {
      return {
        id: node.id,
        kind: "leaf",
        target: { kind: "local", label: tab.title || "Local Terminal" },
      };
    }
    if (tab.source === "host" && tab.hostId) {
      // 컨테이너 안에서 도는 셸은 호스트 pane 으로 적을 수 없다. 적으면 다시 열 때 컨테이너가
      // 아니라 호스트에 그냥 붙는데, 레이아웃은 복원된 것처럼 보여 알아채기 어렵다. 하나라도
      // 되살릴 수 없는 pane 이 있으면 저장 자체를 막는 이 함수의 규칙 그대로 null 을 돌려준다.
      if (tab.containerId) {
        return null;
      }
      const host = hosts.find((entry) => entry.id === tab.hostId);
      return {
        id: node.id,
        kind: "leaf",
        target: {
          kind: "host",
          hostId: tab.hostId,
          label: host?.label ?? tab.title,
        },
      };
    }
    return null;
  }

  const first = captureSavedWorkspaceNode(node.first, tabs, hosts);
  const second = captureSavedWorkspaceNode(node.second, tabs, hosts);
  if (!first || !second) {
    return null;
  }
  return {
    id: node.id,
    kind: "split",
    axis: node.axis,
    ratio: node.ratio,
    first,
    second,
  };
}

/** 새 pending session ID를 꽂아 런타임 split 트리를 만든다. */
export function hydrateSavedWorkspaceLayout(
  node: SavedWorkspaceNode,
  sessionIdByLeafNodeId: ReadonlyMap<string, string>,
  createNodeId: () => string = () => globalThis.crypto.randomUUID(),
): WorkspaceLayoutNode | null {
  if (node.kind === "leaf") {
    const sessionId = sessionIdByLeafNodeId.get(node.id);
    return sessionId ? { id: createNodeId(), kind: "leaf", sessionId } : null;
  }
  const first = hydrateSavedWorkspaceLayout(
    node.first,
    sessionIdByLeafNodeId,
    createNodeId,
  );
  const second = hydrateSavedWorkspaceLayout(
    node.second,
    sessionIdByLeafNodeId,
    createNodeId,
  );
  if (!first || !second) {
    return null;
  }
  return {
    id: createNodeId(),
    kind: "split",
    axis: node.axis,
    ratio: node.ratio,
    first,
    second,
  };
}
