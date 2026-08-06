import type { MobileSessionRecord } from '@dolssh/shared-core';
import {
  normalizePersistedSessionsForColdStart,
  resumeDroppedActiveSession,
} from '../src/lib/session-resume';

// 이 함수만 떼어 검증한다. 포그라운드 복귀 시 무엇을 다시 붙이고 무엇을 건드리지 않는지가
// 규칙의 전부이고, 그 규칙이 틀리면 실패한 세션을 앱 전환마다 무한히 재시도한다.

function session(overrides: Partial<MobileSessionRecord>): MobileSessionRecord {
  return {
    id: 'session-1',
    sessionId: 'engine-1',
    hostId: 'host-1',
    title: 'nas',
    status: 'error',
    hasReceivedOutput: true,
    isRestorable: true,
    lastViewportSnapshot: '',
    lastEventAt: new Date().toISOString(),
    ...overrides,
  };
}

function stateWith(
  sessions: MobileSessionRecord[],
  activeSessionTabId: string | null,
  resumeSession = jest.fn(async () => null),
) {
  return {
    state: { sessions, activeSessionTabId, resumeSession },
    resumeSession,
  };
}

describe('resumeDroppedActiveSession', () => {
  it('밖에서 끊긴 활성 탭을 다시 붙인다', () => {
    const { state, resumeSession } = stateWith(
      [session({ status: 'error', disconnectReason: 'dropped' })],
      'session-1',
    );
    resumeDroppedActiveSession(state);
    expect(resumeSession).toHaveBeenCalledWith('session-1');
  });

  it('진짜 오류로 끊긴 세션은 건드리지 않는다', () => {
    // 비밀번호 오류·호스트키 불일치를 자동 재시도하면 포그라운드로 돌아올 때마다 같은 실패를
    // 반복한다. dropped 표시가 없으면 손대지 않는다.
    const { state, resumeSession } = stateWith(
      [session({ status: 'error', errorMessage: 'Permission denied' })],
      'session-1',
    );
    resumeDroppedActiveSession(state);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('연결된 세션은 다시 붙이지 않는다', () => {
    const { state, resumeSession } = stateWith(
      [session({ status: 'connected', disconnectReason: undefined })],
      'session-1',
    );
    resumeDroppedActiveSession(state);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('활성 탭이 아닌 dropped 세션은 건드리지 않는다', () => {
    // 탭이 다섯 개면 핸드셰이크가 다섯 번 일어나고 비밀번호 프롬프트가 겹친다. 나머지는
    // 사용자가 탭할 때 붙는다.
    const { state, resumeSession } = stateWith(
      [
        session({ id: 'session-1', disconnectReason: 'dropped' }),
        session({ id: 'session-2', disconnectReason: 'dropped' }),
        session({ id: 'session-3', disconnectReason: 'dropped' }),
      ],
      'session-2',
    );
    resumeDroppedActiveSession(state);
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).toHaveBeenCalledWith('session-2');
  });

  it('활성 탭이 없으면 아무것도 하지 않는다', () => {
    const { state, resumeSession } = stateWith(
      [session({ disconnectReason: 'dropped' })],
      null,
    );
    resumeDroppedActiveSession(state);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('활성 탭 id 가 없는 세션을 가리켜도 죽지 않는다', () => {
    const { state, resumeSession } = stateWith([], 'session-gone');
    expect(() => resumeDroppedActiveSession(state)).not.toThrow();
    expect(resumeSession).not.toHaveBeenCalled();
  });
});

describe('normalizePersistedSessionsForColdStart', () => {
  const NOW = '2026-08-06T05:00:00.000Z';
  const DROPPED = '연결이 끊겼습니다.';

  it('연결돼 있던 세션은 dropped 로 내려 탭에 남는다', () => {
    // 앱을 다시 켜면 전송은 이미 죽어 있다. 여기서 'closed' 로 내리던 것이 "탭이 전부
    // 사라지는" 증상의 절반이었다.
    const [result] = normalizePersistedSessionsForColdStart(
      [session({ status: 'connected' })],
      NOW,
      DROPPED,
    );
    expect(result.status).toBe('error');
    expect(result.disconnectReason).toBe('dropped');
  });

  it('진짜 오류로 실패했던 세션은 그대로 둔다', () => {
    // 이걸 dropped 로 바꾸면 접속조차 못 했던 호스트가 "Disconnected" 로 보이고, 앱을 켤
    // 때마다 자동 재연결이 같은 실패를 되풀이한다.
    const [result] = normalizePersistedSessionsForColdStart(
      [session({ status: 'error', errorMessage: 'did not respond' })],
      NOW,
      DROPPED,
    );
    expect(result.status).toBe('error');
    expect(result.disconnectReason).toBeUndefined();
    expect(result.errorMessage).toBe('did not respond');
  });

  it('이미 dropped 였던 세션은 dropped 로 남는다', () => {
    const [result] = normalizePersistedSessionsForColdStart(
      [session({ status: 'error', disconnectReason: 'dropped' })],
      NOW,
      DROPPED,
    );
    expect(result.disconnectReason).toBe('dropped');
  });

  it('사용자가 닫은 세션은 건드리지 않는다', () => {
    const [result] = normalizePersistedSessionsForColdStart(
      [session({ status: 'closed' })],
      NOW,
      DROPPED,
    );
    expect(result.status).toBe('closed');
    expect(result.disconnectReason).toBeUndefined();
  });

  it('뷰포트 스냅샷은 버린다', () => {
    // 화면은 재연결이 다시 그린다. 옛 스냅샷을 살리면 끊긴 시점의 화면이 남아 연결된 것처럼
    // 보인다.
    const [result] = normalizePersistedSessionsForColdStart(
      [session({ status: 'connected', lastViewportSnapshot: 'old screen' })],
      NOW,
      DROPPED,
    );
    expect(result.lastViewportSnapshot).toBe('');
  });
});
