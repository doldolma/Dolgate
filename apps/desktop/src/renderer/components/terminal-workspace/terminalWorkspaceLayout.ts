import type React from 'react';
import type {
  WorkspaceDropDirection,
  WorkspaceLayoutNode,
  WorkspaceSplitNode,
} from '../../store/createAppStore';
import type { Rect, SessionPlacement, SplitHandlePlacement } from './types';
// 레이아웃 순회는 lib 에 있다 — 스토어와 세션 패널도 쓰는데, 그쪽이 컴포넌트를 import 하면
// 방향이 거꾸로다. 여기서는 예전처럼 이 이름으로 쓸 수 있게 다시 내보낸다.
export { listWorkspaceSessionIds } from '../../lib/workspace-layout';
import { listWorkspaceSessionIds } from '../../lib/workspace-layout';

/**
 * 지금 포커스된 pane 의 sessionId.
 *
 * 상단 바(패널 토글)와 세션 셸(패널 본체)이 같은 답을 봐야 한다 — 따로 계산하면 토글이 켜는
 * 패널과 실제로 열리는 패널의 대상이 갈린다.
 */
export function resolveFocusedPaneSessionId(
  activeWorkspaceTab: string,
  workspaces: readonly { id: string; activeSessionId: string }[],
  tmuxGroups: readonly { id: string; activeWorkspaceId: string }[] = [],
): string | null {
  if (activeWorkspaceTab.startsWith('session:')) {
    return activeWorkspaceTab.slice('session:'.length);
  }
  if (activeWorkspaceTab.startsWith('workspace:')) {
    const workspaceId = activeWorkspaceTab.slice('workspace:'.length);
    return (
      workspaces.find((workspace) => workspace.id === workspaceId)?.activeSessionId ?? null
    );
  }
  if (activeWorkspaceTab.startsWith('tmuxgrp:')) {
    const group = tmuxGroups.find(
      (item) => item.id === activeWorkspaceTab.slice('tmuxgrp:'.length),
    );
    if (!group) {
      return null;
    }
    return (
      workspaces.find((workspace) => workspace.id === group.activeWorkspaceId)
        ?.activeSessionId ?? null
    );
  }
  return null;
}

export function toPercentRectStyle(rect: Rect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

export function directionPreviewRect(
  rect: Rect,
  direction: WorkspaceDropDirection,
): Rect {
  if (direction === 'left') {
    return { ...rect, width: rect.width * 0.5 };
  }

  if (direction === 'right') {
    return {
      ...rect,
      x: rect.x + rect.width * 0.5,
      width: rect.width * 0.5,
    };
  }

  if (direction === 'top') {
    return { ...rect, height: rect.height * 0.5 };
  }

  return {
    ...rect,
    y: rect.y + rect.height * 0.5,
    height: rect.height * 0.5,
  };
}

export function resolveDropDirection(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): WorkspaceDropDirection {
  const normalizedX =
    rect.width <= 0
      ? 0.5
      : Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const normalizedY =
    rect.height <= 0
      ? 0.5
      : Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  const distances: Array<{
    direction: WorkspaceDropDirection;
    value: number;
  }> = [
    { direction: 'left', value: normalizedX },
    { direction: 'right', value: 1 - normalizedX },
    { direction: 'top', value: normalizedY },
    { direction: 'bottom', value: 1 - normalizedY },
  ];

  distances.sort((left, right) => left.value - right.value);
  return distances[0].direction;
}

export function collectWorkspacePlacements(
  node: WorkspaceLayoutNode,
  rect: Rect,
  placements: SessionPlacement[],
  handles: SplitHandlePlacement[],
): void {
  if (node.kind === 'leaf') {
    placements.push({
      sessionId: node.sessionId,
      rect,
    });
    return;
  }

  handles.push({
    splitId: node.id,
    axis: node.axis,
    rect,
    ratio: node.ratio,
  });

  if (node.axis === 'horizontal') {
    const firstWidth = rect.width * node.ratio;
    collectWorkspacePlacements(
      node.first,
      {
        x: rect.x,
        y: rect.y,
        width: firstWidth,
        height: rect.height,
      },
      placements,
      handles,
    );
    collectWorkspacePlacements(
      node.second,
      {
        x: rect.x + firstWidth,
        y: rect.y,
        width: rect.width - firstWidth,
        height: rect.height,
      },
      placements,
      handles,
    );
    return;
  }

  const firstHeight = rect.height * node.ratio;
  collectWorkspacePlacements(
    node.first,
    {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: firstHeight,
    },
    placements,
    handles,
  );
  collectWorkspacePlacements(
    node.second,
    {
      x: rect.x,
      y: rect.y + firstHeight,
      width: rect.width,
      height: rect.height - firstHeight,
    },
    placements,
    handles,
  );
}

// splitId 로 split 노드를 찾는다(divider 드래그 → tmux resize-pane 매핑에 쓴다).
export function findSplitNodeById(
  node: WorkspaceLayoutNode,
  splitId: string,
): WorkspaceSplitNode | null {
  if (node.kind === 'leaf') {
    return null;
  }
  if (node.id === splitId) {
    return node;
  }
  return (
    findSplitNodeById(node.first, splitId) ??
    findSplitNodeById(node.second, splitId)
  );
}
