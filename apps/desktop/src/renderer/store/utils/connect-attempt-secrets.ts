import type { ConnectAttemptSecrets } from '../types';

/**
 * 세션 접속에 쓴, 아직 저장되지 않은 요청 창 값.
 *
 * 세션은 접속 요청이 돌아온 뒤에 실패가 오류 이벤트로 온다. 그때 다시 물으면서 앞서 넣은 값을 함께 보내야
 * 한다 — 안 그러면 점프 호스트를 묻고 나서 대상에 넣었던 값을 또 묻는다. 그래서 그 사이만 세션 id 로 들고
 * 있다가, 붙거나(저장은 메인이 한다) 실패해 다음 요청 창으로 넘기면 버린다. 스토어 밖에 두는 것은 비밀값이
 * 화면 상태·저장되는 상태에 섞이지 않게 하려는 것이다.
 */
const attemptSecretsBySessionId = new Map<string, ConnectAttemptSecrets>();

export function rememberConnectAttemptSecrets(sessionId: string, attempt: ConnectAttemptSecrets): void {
  if (!attempt.secrets && !hasEntries(attempt.jumpSecrets)) {
    return;
  }
  attemptSecretsBySessionId.set(sessionId, attempt);
}

/** 꺼내면서 버린다. */
export function takeConnectAttemptSecrets(sessionId: string): ConnectAttemptSecrets | undefined {
  const attempt = attemptSecretsBySessionId.get(sessionId);
  attemptSecretsBySessionId.delete(sessionId);
  return attempt;
}

export function forgetConnectAttemptSecrets(sessionId: string): void {
  attemptSecretsBySessionId.delete(sessionId);
}

function hasEntries(record: Record<string, unknown> | undefined): boolean {
  return Boolean(record) && Object.keys(record as Record<string, unknown>).length > 0;
}
