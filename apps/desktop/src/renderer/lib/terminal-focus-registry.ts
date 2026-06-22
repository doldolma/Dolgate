// 세션 터미널의 포커스 함수를 sessionId 기준으로 보관하는 경량 레지스트리.
//
// tmux 명령 프롬프트(Ctrl-b : / $ / ,)는 store 밖 DOM input 이라, 닫은 뒤 활성 pane 의
// xterm 으로 포커스를 되돌려야 한다. 컨트롤러는 store 직접 접근이 없어(refs/props 기반)
// terminal-cwd-registry 와 같은 결의 모듈 레지스트리로 둔다.

const focusBySessionId = new Map<string, () => void>();

/** 컨트롤러가 자신의 터미널 포커스 함수를 등록한다. */
export function registerTerminalFocus(
  sessionId: string,
  focus: () => void,
): void {
  if (!sessionId) {
    return;
  }
  focusBySessionId.set(sessionId, focus);
}

/** 등록 해제. focus 가 주어지면 동일 함수일 때만 지운다(세션 교체 레이스 방지). */
export function unregisterTerminalFocus(
  sessionId: string,
  focus?: () => void,
): void {
  if (focus && focusBySessionId.get(sessionId) !== focus) {
    return;
  }
  focusBySessionId.delete(sessionId);
}

/** 해당 세션 터미널에 포커스를 준다(미등록이면 무시). */
export function focusTerminalSession(sessionId: string): void {
  focusBySessionId.get(sessionId)?.();
}
