import type { WorkspaceLayoutNode } from '../store/createAppStore';

/**
 * 이 레이아웃에 있는 세션 id 를 **화면 순서대로** 준다(왼쪽·위가 먼저).
 *
 * 순서가 의미를 갖는 자리가 있다 — tmux 창에서 "첫 pane" 은 지표를 담는 키이자 보조 질의를
 * 보내는 대상이다(어느 pane 이든 같은 호스트라 고정해도 값이 같고, 포커스를 따라가면 차분
 * 기준이 매번 버려진다).
 */
export function listWorkspaceSessionIds(node: WorkspaceLayoutNode): string[] {
  if (node.kind === 'leaf') {
    return [node.sessionId];
  }

  return [
    ...listWorkspaceSessionIds(node.first),
    ...listWorkspaceSessionIds(node.second),
  ];
}
