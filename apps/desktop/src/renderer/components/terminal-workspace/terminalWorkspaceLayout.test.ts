import { describe, expect, it } from 'vitest';
import type { WorkspaceLayoutNode } from '../../store/createAppStore';
import {
  collectWorkspacePlacements,
  directionPreviewRect,
  listWorkspaceSessionIds,
  resolveDropDirection,
} from './terminalWorkspaceLayout';

const splitLayout: WorkspaceLayoutNode = {
  id: 'split-root',
  kind: 'split',
  axis: 'horizontal',
  ratio: 0.25,
  first: {
    id: 'leaf-left',
    kind: 'leaf',
    sessionId: 'session-left',
  },
  second: {
    id: 'split-right',
    kind: 'split',
    axis: 'vertical',
    ratio: 0.5,
    first: {
      id: 'leaf-top-right',
      kind: 'leaf',
      sessionId: 'session-top-right',
    },
    second: {
      id: 'leaf-bottom-right',
      kind: 'leaf',
      sessionId: 'session-bottom-right',
    },
  },
};

describe('terminalWorkspaceLayout helpers', () => {
  it('collects pane placements and split handles from a workspace layout tree', () => {
    const placements: Array<{ sessionId: string; rect: Record<string, number> }> =
      [];
    const handles: Array<{ splitId: string; axis: string; ratio: number }> = [];

    collectWorkspacePlacements(
      splitLayout,
      { x: 0, y: 0, width: 1, height: 1 },
      placements as never[],
      handles as never[],
    );

    expect(placements).toEqual([
      {
        sessionId: 'session-left',
        rect: { x: 0, y: 0, width: 0.25, height: 1 },
      },
      {
        sessionId: 'session-top-right',
        rect: { x: 0.25, y: 0, width: 0.75, height: 0.5 },
      },
      {
        sessionId: 'session-bottom-right',
        rect: { x: 0.25, y: 0.5, width: 0.75, height: 0.5 },
      },
    ]);
    expect(handles).toEqual([
      expect.objectContaining({
        splitId: 'split-root',
        axis: 'horizontal',
        ratio: 0.25,
      }),
      expect.objectContaining({
        splitId: 'split-right',
        axis: 'vertical',
        ratio: 0.5,
      }),
    ]);
  });

  it('lists session ids in leaf order', () => {
    expect(listWorkspaceSessionIds(splitLayout)).toEqual([
      'session-left',
      'session-top-right',
      'session-bottom-right',
    ]);
  });

  it('resolves the nearest drop direction from pointer position', () => {
    const bounds = {
      left: 0,
      top: 0,
      width: 200,
      height: 100,
    } as DOMRect;

    expect(resolveDropDirection(5, 40, bounds)).toBe('left');
    expect(resolveDropDirection(195, 40, bounds)).toBe('right');
    expect(resolveDropDirection(100, 4, bounds)).toBe('top');
    expect(resolveDropDirection(100, 96, bounds)).toBe('bottom');
  });

  it('builds the correct preview rectangle for each direction', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };

    expect(directionPreviewRect(rect, 'left')).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.4,
      height: 0.6,
    });
    expect(directionPreviewRect(rect, 'bottom')).toEqual({
      x: 0.1,
      y: 0.5,
      width: 0.8,
      height: 0.3,
    });
  });
});
