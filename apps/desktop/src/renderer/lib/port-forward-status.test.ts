import { describe, expect, it } from 'vitest';
import type { DnsOverrideResolvedRecord, PortForwardRuntimeRecord } from '@shared';
import {
  activePortForwardsForHost,
  countActivePortForwardEntries,
  countActivePortForwards,
  portForwardFailureMessage,
} from './port-forward-status';

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

function active(
  overrides: Partial<PortForwardRuntimeRecord> = {},
): PortForwardRuntimeRecord {
  return {
    ruleId: 'rule-1',
    hostId: 'host-1',
    transport: 'ssh',
    bindAddress: '127.0.0.1',
    bindPort: 15432,
    status: 'running',
    updatedAt: '',
    ...overrides,
  };
}

function dns(status: 'active' | 'inactive', id = 'dns-1'): DnsOverrideResolvedRecord {
  return {
    id,
    type: 'static',
    hostname: 'db.local',
    address: '127.0.0.1',
    status,
    createdAt: '',
    updatedAt: '',
  };
}

describe('countActivePortForwards', () => {
  it('running 과 starting 을 세고 나머지는 세지 않는다', () => {
    // starting 을 세는 이유: 아직 안 열렸어도 사용자가 켠 것이고, OTP 를 묻는 호스트에서는
    // 그 상태가 몇십 초 이어진다.
    expect(
      countActivePortForwards([
        active({ status: 'running' }),
        active({ ruleId: 'rule-2', status: 'starting' }),
        active({ ruleId: 'rule-3', status: 'stopped' }),
        active({ ruleId: 'rule-4', status: 'error' }),
      ]),
    ).toBe(2);
  });

  it('전송 방식 네 가지를 모두 센다', () => {
    // 배지는 "그 화면에 켜 둔 것" 을 말한다. 한 탭만 세면 다른 탭에 켜 둔 것을 못 찾는다.
    expect(
      countActivePortForwards([
        active({ ruleId: 'r1', transport: 'ssh' }),
        active({ ruleId: 'r2', transport: 'aws-ssm' }),
        active({ ruleId: 'r3', transport: 'ecs-task' }),
        active({ ruleId: 'r4', transport: 'container' }),
      ]),
    ).toBe(4);
  });
});

describe('countActivePortForwardEntries', () => {
  it('DNS override 까지 다섯 탭을 합산한다', () => {
    expect(
      countActivePortForwardEntries(
        [active(), active({ ruleId: 'rule-2', transport: 'container' })],
        [dns('active'), dns('inactive', 'dns-2')],
      ),
    ).toBe(3);
  });

  /**
   * RDP-over-SSM·VNC-over-SSH 는 붙는 동안 전송 터널을 하나씩 연다. 그것은 사용자가 만든 규칙이
   * 아니라 포트 포워딩 화면에 나오지 않는다 — 세면 배지에 1이 뜨는데 눌러 들어가면 아무것도 없다.
   */
  it('우리가 여는 전송 터널은 세지 않는다', () => {
    expect(
      countActivePortForwardEntries(
        [
          active({ ruleId: 'rdp:session-1' }),
          active({ ruleId: 'vnc:session-2' }),
          active({ ruleId: 'aws-ec2-ssh:session-3' }),
        ],
        [],
      ),
    ).toBe(0);
  });

  it('사용자가 만든 규칙은 그대로 센다 — 접두사가 붙은 사용자용 터널도 포함', () => {
    expect(
      countActivePortForwardEntries(
        [
          active(),
          active({ ruleId: 'container-service-tunnel:abc' }),
          active({ ruleId: 'rdp:session-1' }),
        ],
        [],
      ),
    ).toBe(2);
  });
  it('켜진 것이 없으면 0 이다 — 배지를 그리지 않는 조건이다', () => {
    expect(countActivePortForwardEntries([active({ status: 'stopped' })], [dns('inactive')])).toBe(0);
  });
});

describe('activePortForwardsForHost', () => {
  it('다른 호스트의 포워딩은 섞지 않는다', () => {
    const rows = activePortForwardsForHost(
      [active(), active({ ruleId: 'rule-2', hostId: 'host-2', bindPort: 8080 })],
      'host-1',
    );
    expect(rows.map((row) => row.bindPort)).toEqual([15432]);
  });

  it('호스트가 없으면 빈 목록이다 — 로컬 터미널 탭에는 행이 생기지 않는다', () => {
    expect(activePortForwardsForHost([active()], null)).toEqual([]);
  });
});
