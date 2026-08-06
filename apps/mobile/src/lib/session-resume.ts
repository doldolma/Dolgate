// 포그라운드로 돌아왔을 때 무엇을 다시 붙일지 정하는 규칙.
//
// 스토어에서 떼어 둔 이유는 검증이다 — 규칙이 틀리면 실패한 세션을 앱 전환마다 무한히 재시도하는데,
// 그것을 확인하려고 네이티브 모듈을 모킹할 이유가 없다.

import type { MobileSessionRecord } from '@dolssh/shared-core';

/** 탭에 남아 있어야 하는 세션. 탭 목록은 이 판정을 따른다. */
export function isLiveSession(session: MobileSessionRecord): boolean {
  return session.status !== 'closed';
}

/**
 * 앱을 다시 켰을 때 저장된 세션들을 정리한다.
 *
 * 재시작되면 살아 있던 세션의 전송은 이미 죽어 있다. 사용자가 끝낸 것이 아니므로 'closed' 가
 * 아니라 dropped 로 내린다 — 그래야 탭이 남고 자동 재연결 대상이 된다. 여기서 'closed' 로
 * 내리던 것이 "홈 갔다 오면 탭이 전부 사라지는" 증상의 절반이었다.
 *
 * 단 **이미 진짜 오류였던 세션은 그대로 둔다.** 'error' 도 live 라서 함께 dropped 로 바꾸면
 * 접속조차 못 했던 호스트가 "Disconnected" 로 표시되고 앱을 켤 때마다 다시 시도된다.
 */
export function normalizePersistedSessionsForColdStart(
  sessions: MobileSessionRecord[],
  now: string,
  // 끊겼다는 안내 문구. 비워 두면 화면에 배너가 없어 "Preparing the terminal" 만 남고, 사용자는
  // 왜 비어 있는지도 어떻게 되살리는지도 알 수 없다(실측에서 확인).
  droppedMessage: string,
): MobileSessionRecord[] {
  return sessions.map(session => {
    const wasGenuineError =
      session.status === 'error' && session.disconnectReason !== 'dropped';
    const normalized: MobileSessionRecord =
      !isLiveSession(session) || wasGenuineError
        ? session
        : {
            ...session,
            status: 'error',
            disconnectReason: 'dropped',
            errorMessage: droppedMessage,
            connectionStatusMessage: null,
            lastEventAt: now,
            lastDisconnectedAt: session.lastDisconnectedAt ?? now,
          };
    // 뷰포트 스냅샷은 되살리지 않는다 — 화면은 재연결이 다시 그린다.
    return { ...normalized, lastViewportSnapshot: '' };
  });
}

export interface ResumeDroppedInput {
  sessions: MobileSessionRecord[];
  activeSessionTabId: string | null;
  resumeSession: (sessionId: string) => Promise<string | null>;
}

/**
 * 밖에서 끊긴 활성 탭을 다시 붙인다.
 *
 * **활성 탭 하나만** 붙인다. 탭이 다섯 개면 핸드셰이크가 다섯 번 일어나고 비밀번호를 묻는
 * 호스트끼리 프롬프트가 겹치며, 셀룰러에서는 앱을 전환할 때마다 그만큼 트래픽이 된다. 나머지 탭은
 * 사용자가 탭할 때 붙는다.
 *
 * **`dropped` 인 것만** 붙인다. 비밀번호 오류·호스트키 불일치처럼 진짜 실패한 세션까지 붙이면
 * 포그라운드로 돌아올 때마다 같은 실패를 반복한다. 사용자가 끝낸 세션('closed')은 애초에 탭에 없다.
 */
export function resumeDroppedActiveSession(input: ResumeDroppedInput): void {
  const { activeSessionTabId } = input;
  if (!activeSessionTabId) {
    return;
  }
  const session = input.sessions.find(item => item.id === activeSessionTabId);
  if (session?.disconnectReason !== 'dropped') {
    return;
  }
  // resumeSession 이 connecting/pending 중복을 이미 가려낸다.
  void input.resumeSession(activeSessionTabId).catch(() => undefined);
}
