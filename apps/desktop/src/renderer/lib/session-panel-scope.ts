import type { WorkspaceTab } from '../store/createAppStore';
import { listWorkspaceSessionIds } from './workspace-layout';

/**
 * 세션 패널이 "같은 것" 으로 볼 단위.
 *
 * tmux 창 하나는 **호스트 하나**다. 그런데 pane 마다 sessionId 가 따로라, 패널이 포커스된
 * pane 을 그대로 따라가면 pane 을 옮길 때마다 다른 세션 취급이 된다 — 보던 섹션이 바뀌고,
 * 도커 화면 상태가 리셋되고, 폴링이 처음부터 다시 돈다. 우리 분할(비-tmux)은 pane 마다 다른
 * 호스트일 수 있으니 지금처럼 따로 본다.
 *
 * 키가 둘인 이유: 화면 상태는 pane 이 죽어도 남아야 하고(창 정체성), 원격에 무언가 물으려면
 * 살아 있는 세션이 있어야 한다(첫 pane). 하나로 합치면 첫 pane 을 닫는 순간 상태가 날아간다.
 */
function findWorkspace(
  workspaces: readonly WorkspaceTab[] | undefined,
  sessionId: string,
): WorkspaceTab | undefined {
  if (!sessionId || !workspaces) {
    return undefined;
  }
  return workspaces.find((workspace) =>
    listWorkspaceSessionIds(workspace.layout).includes(sessionId),
  );
}

/**
 * 화면 상태를 담는 키. tmux 창이면 그 창의 정체성이고, 아니면 세션 그대로다.
 *
 * pane 이 생기고 죽어도 바뀌지 않는다 — 첫 pane 의 sessionId 를 키로 쓰면 그 pane 을 닫는
 * 순간 보던 섹션과 도커 화면 상태가 통째로 초기화된다.
 */
export function resolveSessionPanelStateKey(
  workspaces: readonly WorkspaceTab[] | undefined,
  sessionId: string,
): string {
  return stateKeyForWorkspace(findWorkspace(workspaces, sessionId)) ?? sessionId;
}

/** 이 워크스페이스가 tmux 창이면 그 상태 키. 아니면 null(세션 키를 쓴다). */
export function stateKeyForWorkspace(
  workspace: WorkspaceTab | undefined,
): string | null {
  if (!workspace?.tmux) {
    return null;
  }
  // 접두사를 pane 세션 id(`tmux:<control>:<pane>`)와 다르게 둔다 — 형태가 겹치면 창 키와
  // 세션 키가 같은 맵에서 섞인다.
  return `tmuxwin:${workspace.tmux.controlSessionId}:${workspace.tmux.windowId}`;
}

/**
 * 원격에 물을 때 쓸 세션. tmux 창이면 **그 창의 첫 pane** 이다.
 *
 * 어느 pane 이든 같은 호스트이므로 값은 같고, 고정해 두면 포커스를 옮겨도 폴링이 이어진다
 * (지표가 이미 같은 규칙을 쓴다 — 따라가면 차분 기준을 매번 버려 NET·DISK 가 깜빡였다).
 */
export function resolveSessionPanelQuerySessionId(
  workspaces: readonly WorkspaceTab[] | undefined,
  sessionId: string,
): string {
  const workspace = findWorkspace(workspaces, sessionId);
  if (!workspace?.tmux) {
    return sessionId;
  }
  return listWorkspaceSessionIds(workspace.layout)[0] ?? sessionId;
}
