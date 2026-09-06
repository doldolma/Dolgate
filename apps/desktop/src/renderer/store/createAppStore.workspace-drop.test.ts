import { describe, expect, it } from 'vitest';
import type { TerminalTab } from '@shared';
import { resolveWorkspaceSplitTarget } from '../lib/workspace-split-target';
import { listWorkspaceSessionIds } from '../lib/workspace-layout';
import { createAppStore } from './createAppStore';
import { createMockApi } from './createAppStore.test-support';
import type { DynamicTabStripItem, WorkspaceTab, WorkspaceTabId } from './types';
import { createWorkspaceLeaf, createWorkspaceSplit } from './utils/workspaces';

function workspace(id: string, first: string, second: string): WorkspaceTab {
  return {
    id, title: id, layout: createWorkspaceSplit(first, second, 'right'),
    activeSessionId: first, broadcastEnabled: true,
  };
}

function seed(input: {
  ids?: string[];
  workspaces?: WorkspaceTab[];
  tabStrip?: DynamicTabStripItem[];
  active?: WorkspaceTabId;
} = {}) {
  const api = createMockApi();
  const store = createAppStore(api);
  const tabs: TerminalTab[] = (input.ids ?? ['A', 'B', 'C']).map((sessionId) => ({
    id: sessionId, stableId: sessionId, sessionId, title: sessionId,
    source: 'local', hostId: null, status: 'connected',
    sessionShare: null, hasReceivedOutput: true, lastEventAt: '2026-09-06T00:00:00Z',
  }));
  store.setState({
    tabs,
    workspaces: input.workspaces ?? [],
    tabStrip: input.tabStrip ?? tabs.map((tab) => ({ kind: 'session', sessionId: tab.sessionId })),
    activeWorkspaceTab: input.active ?? 'session:C',
  });
  return { store, api };
}

describe('workspace tab drop targets', () => {
  it.each([
    { source: 'A', visible: 'C', untouched: 'B' },
    { source: 'C', visible: 'A', untouched: 'B' },
    { source: 'B', visible: 'A', untouched: 'C' },
  ])('combines $source with visible $visible regardless of tab order', ({ source, visible, untouched }) => {
    const { store, api } = seed({ active: `session:${visible}` });
    const beforeTabs = store.getState().tabs;
    const preview = resolveWorkspaceSplitTarget(store.getState(), source, visible);
    expect(preview).toEqual({ sessionId: visible, workspaceId: null });
    expect(store.getState().splitSessionIntoWorkspace(source, 'right', preview!.sessionId)).toBe(true);
    const result = store.getState().workspaces[0];
    expect(listWorkspaceSessionIds(result.layout)).toEqual([visible, source]);
    expect(store.getState().activeWorkspaceTab).toBe(`workspace:${result.id}`);
    expect(result.activeSessionId).toBe(source);
    expect(store.getState().tabStrip).toContainEqual({ kind: 'session', sessionId: untouched });
    expect(store.getState().tabs).toBe(beforeTabs);
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(api.ssh.disconnect).not.toHaveBeenCalled();
  });

  it.each(['A', 'C'])('keeps the adjacent-tab rule when dragging the visible tab %s itself', (source) => {
    const { store } = seed({ active: `session:${source}` });
    expect(resolveWorkspaceSplitTarget(store.getState(), source, source)).toEqual({ sessionId: 'B', workspaceId: null });
    expect(store.getState().splitSessionIntoWorkspace(source, 'right', source)).toBe(true);
    expect(listWorkspaceSessionIds(store.getState().workspaces[0].layout)).toEqual(['B', source]);
  });

  it('preserves adjacent selection for calls without a target', () => {
    const { store } = seed();
    expect(store.getState().splitSessionIntoWorkspace('A', 'right')).toBe(true);
    expect(listWorkspaceSessionIds(store.getState().workspaces[0].layout)).toEqual(['B', 'A']);
  });

  it('does nothing when a self-drop has no neighbor', () => {
    const { store } = seed({ ids: ['A'], active: 'session:A' });
    const before = store.getState();
    expect(resolveWorkspaceSplitTarget(before, 'A', 'A')).toBeNull();
    expect(before.splitSessionIntoWorkspace('A', 'right', 'A')).toBe(false);
    expect(store.getState()).toBe(before);
  });

  it.each([
    { direction: 'left', axis: 'horizontal', order: ['A', 'D'] },
    { direction: 'right', axis: 'horizontal', order: ['D', 'A'] },
    { direction: 'top', axis: 'vertical', order: ['A', 'D'] },
    { direction: 'bottom', axis: 'vertical', order: ['D', 'A'] },
  ] as const)('splits the hovered pane in a nonadjacent workspace to the $direction', ({ direction, axis, order }) => {
    const w1 = workspace('W1', 'X', 'Y');
    const w2 = { ...workspace('W2', 'C', 'D'), activeSessionId: 'C', zoomedSessionId: 'D' };
    const { store } = seed({
      ids: ['A', 'X', 'Y', 'C', 'D'], workspaces: [w1, w2], active: 'workspace:W2',
      tabStrip: [{ kind: 'session', sessionId: 'A' }, { kind: 'workspace', workspaceId: 'W1' }, { kind: 'workspace', workspaceId: 'W2' }],
    });
    expect(resolveWorkspaceSplitTarget(store.getState(), 'A', 'D')).toEqual({ sessionId: 'D', workspaceId: 'W2' });
    expect(store.getState().splitSessionIntoWorkspace('A', direction, 'D')).toBe(true);
    expect(store.getState().workspaces[0]).toBe(w1);
    const result = store.getState().workspaces[1];
    expect(result).toMatchObject({ activeSessionId: 'A', zoomedSessionId: null, broadcastEnabled: true });
    expect(result.layout).toMatchObject({
      kind: 'split', first: { kind: 'leaf', sessionId: 'C' },
      second: { kind: 'split', axis, ratio: 0.5, first: { sessionId: order[0] }, second: { sessionId: order[1] } },
    });
    expect(store.getState().activeWorkspaceTab).toBe('workspace:W2');
  });

  it('uses the adjacent workspace active pane for a self-drop', () => {
    const target = { ...workspace('W1', 'B', 'C'), activeSessionId: 'C' };
    const { store } = seed({ workspaces: [target], active: 'session:A', tabStrip: [
      { kind: 'session', sessionId: 'A' }, { kind: 'workspace', workspaceId: 'W1' },
    ] });
    expect(resolveWorkspaceSplitTarget(store.getState(), 'A', 'A')).toEqual({ sessionId: 'C', workspaceId: 'W1' });
    expect(store.getState().splitSessionIntoWorkspace('A', 'right', 'C')).toBe(true);
    expect(listWorkspaceSessionIds(store.getState().workspaces[0].layout)).toEqual(['B', 'C', 'A']);
  });

  it.each(['source', 'target'] as const)('rejects a removed %s even if another neighbor is available', (removed) => {
    const { store } = seed();
    const preview = resolveWorkspaceSplitTarget(store.getState(), 'A', 'C');
    const id = removed === 'source' ? 'A' : 'C';
    store.setState({ tabs: store.getState().tabs.filter((tab) => tab.sessionId !== id) });
    const before = store.getState();
    expect(before.splitSessionIntoWorkspace('A', 'right', preview!.sessionId)).toBe(false);
    expect(store.getState()).toBe(before);
  });

  it.each(['rdp', 'vnc'] as const)('rejects %s as source or explicit target without falling back', (paneKind) => {
    for (const id of ['A', 'C']) {
      const { store } = seed();
      store.setState({ tabs: store.getState().tabs.map((tab) => tab.sessionId === id ? { ...tab, paneKind } : tab) });
      const before = store.getState();
      expect(resolveWorkspaceSplitTarget(before, 'A', 'C')).toBeNull();
      expect(before.splitSessionIntoWorkspace('A', 'right', 'C')).toBe(false);
      expect(store.getState()).toBe(before);
    }
  });

  it.each(['full', 'tmux'] as const)('rejects an explicit %s workspace instead of choosing a neighbor', (kind) => {
    const target = workspace('W1', 'C', 'D');
    if (kind === 'full') {
      target.layout = { id: 'full', kind: 'split', axis: 'horizontal', ratio: 0.5,
        first: target.layout, second: createWorkspaceSplit('E', 'F', 'right') };
    } else {
      target.tmux = { controlSessionId: 'control', windowId: '@1', index: 0, name: 'tmux' };
    }
    const { store } = seed({ ids: ['A', 'B', 'C', 'D', 'E', 'F'], workspaces: [target], tabStrip: [
      { kind: 'session', sessionId: 'A' }, { kind: 'session', sessionId: 'B' }, { kind: 'workspace', workspaceId: 'W1' },
    ] });
    const before = store.getState();
    expect(resolveWorkspaceSplitTarget(before, 'A', 'C')).toBeNull();
    expect(before.splitSessionIntoWorkspace('A', 'right', 'C')).toBe(false);
    expect(store.getState()).toBe(before);
  });

  it('rechecks the pane limit after previewing a valid target', () => {
    const target = workspace('W1', 'C', 'D');
    const { store } = seed({ ids: ['A', 'B', 'C', 'D', 'E', 'F'], workspaces: [target], tabStrip: [
      { kind: 'session', sessionId: 'A' }, { kind: 'session', sessionId: 'B' }, { kind: 'workspace', workspaceId: 'W1' },
    ] });
    const preview = resolveWorkspaceSplitTarget(store.getState(), 'A', 'D');
    expect(preview).not.toBeNull();
    store.setState({ workspaces: [{ ...target, layout: {
      id: 'full', kind: 'split', axis: 'horizontal', ratio: 0.5, first: target.layout,
      second: { id: 'new', kind: 'split', axis: 'vertical', ratio: 0.5, first: createWorkspaceLeaf('E'), second: createWorkspaceLeaf('F') },
    } }] });
    const before = store.getState();
    expect(before.splitSessionIntoWorkspace('A', 'right', preview!.sessionId)).toBe(false);
    expect(store.getState()).toBe(before);
  });
});
