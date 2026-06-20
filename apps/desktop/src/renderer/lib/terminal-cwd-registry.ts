// 세션의 현재 작업 디렉터리(cwd)를 sessionId 기준으로 보관하는 경량 레지스트리.
//
// cwd는 OSC 7 보고로 컨트롤러의 onCwd에 들어오지만, 터미널 파일 드롭(SFTP 업로드)
// 핸들러는 store 밖 DOM 이벤트 컨텍스트에서 "지금 이 세션의 cwd"를 즉시 읽어야 한다.
// 휘발 맵으로 충분하다(드롭 시점에 동기 조회). 재연결로 sessionId가 바뀌면 새 세션이
// OSC 7을 다시 보고하므로 자연 갱신되고, 세션 종료 시 clearSessionCwd로 정리한다.
//
// store에 두지 않는 이유: 컨트롤러는 store 직접 접근이 없고(refs/props 기반), cd마다
// 전역 리렌더를 유발할 필요도 없다. terminal-write-registry와 같은 결의 모듈 레지스트리다.

const cwdBySessionId = new Map<string, string>();

/** OSC 7로 보고된 cwd를 기록한다. 빈 값이면 항목을 제거한다. */
export function setSessionCwd(sessionId: string, cwd: string | null): void {
  if (!sessionId) {
    return;
  }
  if (cwd && cwd.length > 0) {
    cwdBySessionId.set(sessionId, cwd);
  } else {
    cwdBySessionId.delete(sessionId);
  }
}

/** 해당 세션의 마지막으로 보고된 cwd(절대 경로) 또는 미보고 시 null. */
export function getSessionCwd(sessionId: string): string | null {
  return cwdBySessionId.get(sessionId) ?? null;
}

export function clearSessionCwd(sessionId: string): void {
  cwdBySessionId.delete(sessionId);
}
