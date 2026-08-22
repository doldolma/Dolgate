import {
  describeConnectionStage,
  resolveMobileConnectionStages,
} from '../src/lib/connection-stages';
import type { MobileConnectionViewState } from '../src/store/useMobileAppStore';
import { t } from '../src/i18n';

// 이 파일이 지키는 것은 두 가지다: 이 앱의 연결 상태가 shared-core 의 단계 계산으로 올바르게
// 옮겨지는지, 그리고 돌아온 i18n 키가 이 카탈로그에서 문구로 바뀌는지. 단계 판정 자체의 규칙은
// 데스크톱과 공유하는 shared-core 쪽에서 검증된다.

function createView(
  overrides: Partial<MobileConnectionViewState> = {},
): MobileConnectionViewState {
  return {
    hostId: 'host-1',
    hasTailnet: false,
    targetAddress: '10.0.0.5',
    ...overrides,
  };
}

function stageById(
  stages: ReturnType<typeof resolveMobileConnectionStages>,
  id: string,
) {
  return stages.find(stage => stage.id === id);
}

describe('모바일 연결 단계', () => {
  it('붙는 중이 아니면 아무 단계도 없다', () => {
    expect(
      resolveMobileConnectionStages({ view: undefined, status: 'connected' }),
    ).toEqual([]);
  });

  // tailnet 을 쓰지 않는 호스트에 그 계층을 보여주면 무엇을 기다리는지 오히려 헷갈린다.
  it('tailnet 을 쓰지 않으면 그 계층이 아예 없다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView(),
      status: 'connecting',
    });

    expect(stages.every(stage => stage.group === 'host')).toBe(true);
    expect(stageById(stages, 'host-key')).toBeDefined();
    expect(stageById(stages, 'ssh')).toBeDefined();
  });

  it('tailnet 을 쓰면 그 관문들이 앞에 선다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({
        hasTailnet: true,
        tailnetStatus: { id: 'corp', state: 'running', authorized: true },
      }),
      status: 'connecting',
    });

    expect(stageById(stages, 'tailscale-node')?.state).toBe('done');
    expect(stageById(stages, 'tailscale-registration')?.state).toBe('done');
    // tailnet 이 끝나기 전에는 호스트 관문이 시작조차 안 한 것으로 남아야 한다.
    expect(stageById(stages, 'host-key')?.state).toBe('pending');
  });

  // 사람이 무언가 해야 진행되는 단계는 기다림(…)과 달라야 한다 — 자기 차례임을 알 수 있게.
  it('키를 묻는 중이면 그 단계가 사용자 차례가 된다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({ hostKeyPrompted: true }),
      status: 'connecting',
    });

    const hostKey = stageById(stages, 'host-key');
    expect(hostKey?.state).toBe('blocked');
    expect(describeConnectionStage(hostKey!).detail).toBe(
      t('connectStages.hostKeyPromptDetail'),
    );
  });

  // 코드를 묻고 있다는 것은 키 확인이 이미 지나갔다는 뜻이다. 그것을 "아직" 으로 두면 사용자는
  // 키 문제를 의심하러 간다.
  it('코드를 묻는 중이면 키 확인은 지나간 것으로 남는다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({ interactiveAuthPending: true }),
      status: 'connecting',
    });

    expect(stageById(stages, 'host-key')?.state).toBe('done');
    expect(stageById(stages, 'ssh')?.state).toBe('active');
  });

  // 실패가 어느 계층의 것인지가 이 화면의 존재 이유다. tailnet 때문에 못 붙은 것과 SSH 가
  // 거절한 것이 같은 모양으로 보이면 사용자는 엉뚱한 곳을 고치러 간다.
  it('실패는 그 계층의 단계에 붙는다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({
        hasTailnet: true,
        tailnetStatus: {
          id: 'corp',
          state: 'running',
          authorized: true,
          ready: true,
        },
        failureLayer: 'ssh',
        failureMessage: '비밀번호가 거부되었습니다.',
      }),
      status: 'error',
    });

    const ssh = stageById(stages, 'ssh');
    expect(ssh?.state).toBe('failed');
    expect(describeConnectionStage(ssh!).detail).toBe(
      '비밀번호가 거부되었습니다.',
    );
    // 그 앞 관문은 통과한 것으로 남는다.
    expect(stageById(stages, 'tailscale-node')?.state).toBe('done');
    expect(stageById(stages, 'host-key')?.state).toBe('done');
  });

  it('분류되지 않은 실패는 진행 중이던 단계에 붙는다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({ failureMessage: '아무도 분류하지 못한 오류' }),
      status: 'error',
    });

    const failed = stages.filter(stage => stage.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(describeConnectionStage(failed[0]).detail).toBe(
      '아무도 분류하지 못한 오류',
    );
  });

  // 백엔드가 준 원문은 번역하지 않는다 — 분류에 없는 문장을 키로 바꾸려 하면 그것이 사라진다.
  it('백엔드 원문과 번역된 안내를 한 줄에 함께 싣는다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({
        hasTailnet: true,
        tailnetStatus: {
          id: 'corp',
          state: 'running',
          loginError: 'invalid key',
        },
      }),
      status: 'connecting',
    });

    const detail = describeConnectionStage(
      stageById(stages, 'tailscale-registration')!,
    ).detail;
    expect(detail).toContain(t('connectStages.tailscaleLoginRejectedDetail'));
    expect(detail).toContain('invalid key');
  });

  // 점프 체인에서 어느 홉을 붙는 중인지. 이것이 없으면 여러 홉이 통째로 "SSH 연결" 한 줄이고,
  // 베스천에서 막힌 것과 그 뒤 대상에서 막힌 것이 같은 모양으로 보인다.
  it('여러 홉이면 지금 붙는 홉을 SSH 관문에 붙인다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({
        interactiveAuthPending: false,
        hop: {
          hopLabel: 'jump@gw.example.com:2222',
          hopIndex: 1,
          hopCount: 2,
          stage: 'connecting',
        },
      }),
      status: 'connecting',
    });

    const detail = describeConnectionStage(stageById(stages, 'ssh')!).detail;
    expect(detail).toContain('1/2');
    expect(detail).toContain('jump@gw.example.com:2222');
  });

  // 홉이 하나면 그 줄은 군더더기다 — 대상 주소는 이미 탭과 세션 정보에 있다.
  it('홉이 하나면 붙이지 않는다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({
        hop: {
          hopLabel: 'deploy@10.0.0.5:22',
          hopIndex: 1,
          hopCount: 1,
          stage: 'connecting',
        },
      }),
      status: 'connecting',
    });

    expect(
      describeConnectionStage(stageById(stages, 'ssh')!).detail,
    ).toBeUndefined();
  });

  // 실패했으면 그 자리에는 실패 이유가 있어야 한다. 홉 표시로 덮으면 왜 안 됐는지가 사라진다.
  it('실패한 뒤에는 홉 대신 실패 이유를 남긴다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView({
        failureLayer: 'ssh',
        failureMessage: '비밀번호가 거부되었습니다.',
        hop: {
          hopLabel: 'jump@gw.example.com:2222',
          hopIndex: 2,
          hopCount: 2,
          stage: 'connecting',
        },
      }),
      status: 'error',
    });

    expect(describeConnectionStage(stageById(stages, 'ssh')!).detail).toBe(
      '비밀번호가 거부되었습니다.',
    );
  });

  it('VNC-over-SSH는 gateway와 target tunnel을 VNC 협상 앞에 둔다', () => {
    const opening = resolveMobileConnectionStages({
      view: createView({
        hostKind: 'vnc',
        tunnelLabel: 'VNC bastion',
        stage: 'ssh-tunnel-gateway',
      }),
      status: 'connecting',
    });

    expect(stageById(opening, 'host-key')?.state).toBe('done');
    expect(stageById(opening, 'ssh-tunnel-gateway')?.state).toBe('active');
    expect(stageById(opening, 'ssh-tunnel')?.state).toBe('pending');
    expect(stageById(opening, 'vnc')?.state).toBe('pending');

    const opened = resolveMobileConnectionStages({
      view: createView({
        hostKind: 'vnc',
        tunnelLabel: 'VNC bastion',
        stage: 'ssh-tunnel-open',
      }),
      status: 'connecting',
    });
    expect(stageById(opened, 'ssh-tunnel-gateway')?.state).toBe('done');
    expect(stageById(opened, 'ssh-tunnel')?.state).toBe('done');
    expect(stageById(opened, 'vnc')?.state).toBe('active');
  });

  it('RDP-over-SSM은 SSM forward가 열린 뒤에 RDP 협상을 시작한다', () => {
    const opening = resolveMobileConnectionStages({
      view: createView({
        hostKind: 'rdp',
        ssmTunnel: true,
        stage: 'ssm-tunnel',
      }),
      status: 'connecting',
    });
    expect(stageById(opening, 'ssm-tunnel')?.state).toBe('active');
    expect(stageById(opening, 'rdp')?.state).toBe('pending');

    const opened = resolveMobileConnectionStages({
      view: createView({
        hostKind: 'rdp',
        ssmTunnel: true,
        stage: 'connecting',
      }),
      status: 'connecting',
    });
    expect(stageById(opened, 'ssm-tunnel')?.state).toBe('done');
    expect(stageById(opened, 'rdp')?.state).toBe('active');
  });

  it('라벨은 이 앱의 카탈로그에서 나온다', () => {
    const stages = resolveMobileConnectionStages({
      view: createView(),
      status: 'connecting',
    });

    const labels = stages.map(stage => describeConnectionStage(stage).label);
    expect(labels).toContain(t('connectStages.hostKey'));
    expect(labels).toContain(t('connectStages.ssh'));
    // 키가 그대로 보이면 카탈로그에 그 문구가 없다는 뜻이다.
    expect(labels.some(label => label.startsWith('connectStages.'))).toBe(
      false,
    );
  });
});
