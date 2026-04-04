import type React from 'react';
import type {
  WorkspaceDropDirection,
  WorkspaceLayoutNode,
} from '../../store/createAppStore';
import type { Rect, SessionPlacement, SplitHandlePlacement } from './types';

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

export function listWorkspaceSessionIds(node: WorkspaceLayoutNode): string[] {
  if (node.kind === 'leaf') {
    return [node.sessionId];
  }

  return [
    ...listWorkspaceSessionIds(node.first),
    ...listWorkspaceSessionIds(node.second),
  ];
}
