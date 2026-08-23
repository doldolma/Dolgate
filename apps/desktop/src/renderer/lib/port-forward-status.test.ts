import { describe, expect, it } from 'vitest';
import type { PortForwardRuntimeRecord } from '@shared';
import { portForwardFailureMessage } from './port-forward-status';

function runtime(message?: string): PortForwardRuntimeRecord {
  return {
    ruleId: 'rule-1',
    hostId: 'host-1',
    transport: 'ssh',
    bindAddress: '127.0.0.1',
    bindPort: 5555,
    status: 'error',
    message,
    updatedAt: '',
  };
}

describe('portForwardFailureMessage', () => {
  it('로컬 포트가 이미 쓰이는 경우를 그 주소와 함께 말해 준다', () => {
    // 코어 원문: open local listener: listen tcp 127.0.0.1:5555: bind: address already in use
    expect(
      portForwardFailureMessage(
        runtime(
          'open local listener: listen tcp 127.0.0.1:5555: bind: address already in use',
        ),
      ),
    ).toBe('해당 포트는 이미 사용 중입니다 (127.0.0.1:5555).');
  });

  it('윈도우의 다른 문장도 같은 분류로 받는다', () => {
    expect(
      portForwardFailureMessage(
        runtime(
          'listen tcp 127.0.0.1:5555: bind: Only one usage of each socket address is normally permitted.',
        ),
      ),
    ).toContain('127.0.0.1:5555');
  });

  it('연결 실패는 연결 화면과 같은 문구를 쓴다', () => {
    expect(portForwardFailureMessage(runtime('dial tcp: connection refused'))).not.toContain(
      'dial tcp',
    );
  });

  it('분류되지 않은 오류는 원문을 그대로 돌려준다', () => {
    // 뭉뚱그린 문구로 덮으면 무엇이 잘못됐는지 알 단서가 사라진다.
    expect(portForwardFailureMessage(runtime('something we have never seen'))).toBe(
      'something we have never seen',
    );
  });

  it('메시지가 없으면 null', () => {
    expect(portForwardFailureMessage(runtime())).toBeNull();
    expect(portForwardFailureMessage(runtime('   '))).toBeNull();
    expect(portForwardFailureMessage(null)).toBeNull();
  });
});
