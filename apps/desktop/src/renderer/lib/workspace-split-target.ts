import { isSplittablePaneKind } from '@shared';
import type { AppState, DynamicTabStripItem, WorkspaceTab } from '../store/types';
import { listWorkspaceSessionIds } from './workspace-layout';

export interface WorkspaceSplitTarget {
  sessionId: string;
  workspaceId: string | null;
}

type SplitContext = Pick<AppState, 'tabs' | 'tabStrip' | 'workspaces'>;

/** 자기 탭을 끌거나 대상 없이 분할할 때만 쓰는 기존 이웃 선택 순서. */
export function resolveAdjacentTarget(
  tabStrip: DynamicTabStripItem[],
  workspaces: WorkspaceTab[],
  sessionId: string,
): DynamicTabStripItem | null {
  const index = tabStrip.findIndex(
    (item) => item.kind === 'session' && item.sessionId === sessionId,
  );
  if (index < 0) {
    return null;
  }
  for (const candidateIndex of [index + 1, index - 1]) {
    const candidate = tabStrip[candidateIndex];
    if (!candidate || candidate.kind === 'tmux') {
      continue;
    }
    if (candidate.kind === 'workspace') {
      const workspace = workspaces.find((item) => item.id === candidate.workspaceId);
      if (!workspace || workspace.tmux || listWorkspaceSessionIds(workspace.layout).length >= 4) {
        continue;
      }
    }
    return candidate;
  }
  return null;
}

/**
 * 미리보기와 실제 분할이 같은 대상·제한을 사용한다. 명시한 다른 세션이 없거나
 * 분할 불가여도 이웃으로 대체하지 않는다. 자기 자신/대상 없는 호출만 이웃을 찾는다.
 */
export function resolveWorkspaceSplitTarget(
  state: SplitContext,
  sessionId: string,
  targetSessionId?: string,
): WorkspaceSplitTarget | null {
  const isSplittable = (id: string) => {
    const tab = state.tabs.find((item) => item.sessionId === id);
    return Boolean(tab && !tab.tmux && !id.startsWith('tmux:') && isSplittablePaneKind(tab.paneKind));
  };
  const isStandalone = (id: string) => state.tabStrip.some(
    (item) => item.kind === 'session' && item.sessionId === id,
  );
  if (!isSplittable(sessionId) || !isStandalone(sessionId)) {
    return null;
  }

  let resolvedSessionId = targetSessionId;
  let workspace: WorkspaceTab | undefined;
  if (targetSessionId === undefined || targetSessionId === sessionId) {
    const adjacent = resolveAdjacentTarget(state.tabStrip, state.workspaces, sessionId);
    if (!adjacent || adjacent.kind === 'tmux') {
      return null;
    }
    if (adjacent.kind === 'session') {
      resolvedSessionId = adjacent.sessionId;
    } else {
      workspace = state.workspaces.find((item) => item.id === adjacent.workspaceId);
      if (!workspace) {
        return null;
      }
      const ids = listWorkspaceSessionIds(workspace.layout);
      resolvedSessionId = ids.includes(workspace.activeSessionId)
        ? workspace.activeSessionId
        : ids[0];
    }
  } else if (!isStandalone(targetSessionId)) {
    workspace = state.workspaces.find((item) =>
      listWorkspaceSessionIds(item.layout).includes(targetSessionId),
    );
    if (!workspace) {
      return null;
    }
  }

  if (!resolvedSessionId || resolvedSessionId === sessionId || !isSplittable(resolvedSessionId)) {
    return null;
  }
  if (workspace) {
    const ids = listWorkspaceSessionIds(workspace.layout);
    if (
      workspace.tmux || ids.length >= 4 || ids.includes(sessionId) ||
      !ids.every(isSplittable) ||
      !state.tabStrip.some((item) => item.kind === 'workspace' && item.workspaceId === workspace.id)
    ) {
      return null;
    }
    return { sessionId: resolvedSessionId, workspaceId: workspace.id };
  }
  return isStandalone(resolvedSessionId)
    ? { sessionId: resolvedSessionId, workspaceId: null }
    : null;
}
