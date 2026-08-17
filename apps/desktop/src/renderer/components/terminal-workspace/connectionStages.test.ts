import { describe, expect, it } from 'vitest';
import type { ConnectionStage, TailnetStatus, TerminalTab } from '@shared';
import { t } from '../../i18n';
import {
  describeConnectionStage,
  resolveConnectionStages,
  stageSubjectFromTab,
} from './connectionStages';

// 단계는 i18n 키로 온다(shared-core 는 UI 언어를 결정하지 않는다). 이 앱이 문구로 바꾼 뒤에
// 단정해야 사용자가 읽는 것과 같은 것을 확인한다.
function detailOf(stage: ConnectionStage | undefined): string | undefined {
  return stage ? describeConnectionStage(stage).detail : undefined;
}

function labelOf(stage: ConnectionStage): string {
  return describeConnectionStage(stage).label;
}

function createTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    sessionId: 's1',
    title: '아산',
    source: 'host',
    status: 'pending',
    hostId: 'h1',
    shellKind: 'ssh',
    hasReceivedOutput: false,
    createdAt: '2026-07-29T00:00:00.000Z',
    lastEventAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  } as TerminalTab;
}

// 코어가 판정한 결과(ready·authorized)를 담는다. 화면은 state·expired·online 으로 다시 조합하지
// 않으므로, 픽스처도 그 계약대로 준다 — 코어에서 ready 인 상태는 반드시 authorized 이기도 하다.
function createStatus(overrides: Partial<TailnetStatus> = {}): TailnetStatus {
  return {
    id: 'n1',
    state: 'running',
    online: true,
    ready: true,
    authorized: true,
    ...overrides,
  } as TailnetStatus;
}

function stateOf(stages: ReturnType<typeof resolveConnectionStages>, id: string) {
  return stages.find((stage) => stage.id === id)?.state;
}

describe('resolveConnectionStages', () => {
  // Tailscale 을 안 쓰는 호스트에 없는 관문을 보여주면, 무엇을 기다리는지 오히려 헷갈린다.
  it('Tailscale 을 쓰지 않으면 그 계층이 아예 없다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connecting' })),
      hasTailscale: false,
      failureLayer: null,
    });

    expect(stages.every((stage) => stage.group === 'host')).toBe(true);
    expect(stages.map((stage) => stage.id)).toEqual(['host-key', 'ssh']);
  });

  // Windows EC2 는 SSM 셸(PowerShell)로 붙는다 — SSH 도, 대조할 호스트 키도 없다. 그런데
  // "호스트 키 확인 → SSH 연결" 을 세우면 없는 관문을 통과한 것처럼 읽힌다.
  it('Windows EC2 는 호스트 키 관문 없이 SSM 단계만 보여준다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connecting' })),
      hasTailscale: false,
      hostKind: 'aws-ec2',
      awsPlatform: 'Windows',
      failureLayer: null,
    });

    expect(stages.map((stage) => stage.id)).toEqual(['ssm']);
  });

  // 리눅스 EC2 는 SSH-over-SSM 을 먼저 타므로 기존 관문이 그대로 맞다.
  it('리눅스 EC2 는 호스트 키·SSH 관문을 그대로 쓴다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connecting' })),
      hasTailscale: false,
      hostKind: 'aws-ec2',
      awsPlatform: 'Linux/UNIX',
      failureLayer: null,
    });

    expect(stages.map((stage) => stage.id)).toEqual(['host-key', 'ssh']);
  });

  // 빠르게 지나간 단계도 남아야 한다. 이게 없으면 사용자는 아무것도 못 본 것과 같다.
  it('지나간 단계는 완료로 남는다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      tailnetStatus: createStatus({ peers: [{ direct: true }] }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'tailscale-node')).toBe('done');
    expect(stateOf(stages, 'tailscale-registration')).toBe('done');
    expect(stateOf(stages, 'tailscale-auth')).toBe('done');
    expect(stateOf(stages, 'tailscale-network')).toBe('done');
    expect(stateOf(stages, 'host-key')).toBe('done');
    expect(stateOf(stages, 'ssh')).toBe('done');
  });

  // 사람이 할 일이 있는 단계와 그냥 기다리는 단계는 달라야 한다 — 링크가 오기 전에 "로그인하세요"
  // 라고 하면 누를 것을 찾다가 없다는 것만 확인하게 된다.
  it('로그인 단계는 링크가 왔을 때만 사용자 차례가 된다', () => {
    const waiting = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({ state: 'needsAuth', ready: false }),
      failureLayer: null,
    });
    const ready = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({ state: 'needsAuth', ready: false, authUrl: 'https://login' }),
      failureLayer: null,
    });

    expect(stateOf(waiting, 'tailscale-auth')).toBe('active');
    expect(stateOf(ready, 'tailscale-auth')).toBe('blocked');
  });

  // 잘못된 auth key 는 상태가 링크 대기와 똑같다(needsAuth + 링크 없음). 그것을 "링크를 받는 중"
  // 으로 그리면 사용자는 기다리면 될 줄 알고 3 분을 앉아 있는다 — 실제로 그렇게 보였다. 링크는
  // 오지 않고, 고칠 것은 설정이다.
  it('로그인이 거부되면 링크를 기다린다고 말하지 않는다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({
        state: 'needsAuth',
        ready: false,
        loginError: 'invalid key: unable to validate API key',
      }),
      failureLayer: null,
    });

    const registration = stages.find((stage) => stage.id === 'tailscale-registration');
    const auth = stages.find((stage) => stage.id === 'tailscale-auth');

    // 실패는 등록 단계에 붙고, 백엔드가 준 이유가 그대로 보여야 한다.
    expect(registration?.state).toBe('failed');
    expect(detailOf(registration)).toContain('invalid key');
    // 인증 단계는 진행 중이 아니다 — 기다려서 풀리는 것이 아니기 때문이다.
    expect(auth?.state).toBe('pending');
    expect(detailOf(auth)).toBeUndefined();
  });

  // 링크가 오지 않으면 코어가 노드를 다시 세워 등록을 처음부터 밟는다. 재시작 전후의 상태는
  // 완전히 같아서(needsAuth·링크 없음), 이 표시가 없으면 화면은 아무 일도 없는 것처럼 보이고
  // 사용자는 멈춘 줄 안다 — 실제로 그렇게 보였다.
  it('링크를 기다리는 동안 코어가 노드를 다시 세운 것을 보여준다', () => {
    const before = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({ state: 'needsAuth', ready: false }),
      failureLayer: null,
    });
    const after = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({ state: 'needsAuth', ready: false, restarts: 2 }),
      failureLayer: null,
    });

    const authDetail = (stages: ReturnType<typeof resolveConnectionStages>) =>
      detailOf(stages.find((stage) => stage.id === 'tailscale-auth')) ?? '';

    expect(authDetail(before)).toBe(t('connectStages.tailscaleLinkDetail'));
    expect(authDetail(after)).toContain(
      t('connectStages.tailscaleRestartDetail', { count: 2 }),
    );
    // 무엇을 기다리는지는 그대로 남아야 한다 — 덮어쓰면 재시작만 보이고 대기 이유가 사라진다.
    expect(authDetail(after)).toContain(t('connectStages.tailscaleLinkDetail'));
  });

  // 만료는 그 단계의 실패다. 로그인 단계에만 표시하면 "왜 또 로그인해야 하는지" 를 알 수 없다.
  it('만료는 등록 확인 단계의 실패로 붙는다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({
        state: 'needsAuth',
        ready: false,
        expired: true,
        authUrl: 'https://login',
      }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'tailscale-registration')).toBe('failed');
    expect(detailOf(stages.find((stage) => stage.id === 'tailscale-registration'))).toBeTruthy();
  });

  it('삭제된 identity는 동기화 장애가 아니라 자동 재등록으로 표시한다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({
        state: 'running',
        ready: false,
        online: false,
        authorized: false,
        identityInvalid: true,
      }),
      failureLayer: null,
    });

    const registration = stages.find((stage) => stage.id === 'tailscale-registration');
    expect(registration?.state).toBe('active');
    expect(detailOf(registration)).toBe(
      t('connectStages.tailscaleIdentityInvalidDetail'),
    );
  });

  // 이 화면의 존재 이유: Tailscale 때문인지 SSH 가 거절한 것인지 구분.
  it('실패는 그 계층의 단계에만 붙는다', () => {
    const sshFailure = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'error', errorMessage: 'connection refused' })),
      hasTailscale: true,
      tailnetStatus: createStatus({ peers: [{ direct: true }] }),
      failureLayer: 'ssh',
      failureMessage: '대상이 연결을 거부했습니다.',
    });
    const tailscaleFailure = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'error', errorMessage: 'tailnet unreachable' })),
      hasTailscale: true,
      tailnetStatus: createStatus({ state: 'stopped', ready: false, online: false }),
      failureLayer: 'tailscale',
      failureMessage: 'tailnet 을 통해 닿지 못했습니다.',
    });

    expect(stateOf(sshFailure, 'ssh')).toBe('failed');
    expect(stateOf(sshFailure, 'tailscale-node')).toBe('done');
    // SSH 까지 갔다는 것은 키 확인을 통과했다는 뜻이다. 미완으로 두면 키를 의심하러 간다.
    expect(stateOf(sshFailure, 'host-key')).toBe('done');

    expect(stateOf(tailscaleFailure, 'tailscale-node')).toBe('failed');
    expect(stateOf(tailscaleFailure, 'ssh')).not.toBe('failed');
    expect(stateOf(tailscaleFailure, 'host-key')).not.toBe('failed');
  });

  // 노드가 안 붙었으면 호스트 키 확인은 시작조차 못 한다. 진행 중으로 보이면 엉뚱한 곳을 본다.
  it('Tailscale 이 준비되기 전 호스트 단계는 시작 전이다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({ state: 'needsAuth', ready: false, authUrl: 'https://login' }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'host-key')).toBe('pending');
    expect(stateOf(stages, 'ssh')).toBe('pending');
  });

  // 상태가 정상으로 보이는데 통신이 안 되는 경우의 유일한 단서다.
  it('백엔드 경고와 오류를 그대로 싣는다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({
        health: ['relay unreachable', 'accept-routes off'],
        error: 'control plane refused',
      }),
      failureLayer: null,
    });

    expect(stages.filter((stage) => stage.state === 'warn')).toHaveLength(2);
    expect(detailOf(stages.find((stage) => stage.id === 'tailscale-error'))).toBe(
      'control plane refused',
    );
  });

  // NoState 는 "백엔드가 아직 아무것도 만들지 못했다" 는 뜻이다. 인터넷이 없으면 여기서 멈추는데,
  // 그것을 시작 완료로 표시하면 화면이 "노드 시작 ✓" 라고 거짓말한다.
  it("백엔드가 상태를 만들기 전에는 시작 완료로 쓰지 않는다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      // mapBackendState 가 NoState 를 starting 으로 뭉개므로 화면은 그 구간을 구분할 수 없다.
      tailnetStatus: createStatus({
        state: 'starting',
        backendState: 'NoState',
        ready: false,
        online: false,
      }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'tailscale-node')).not.toBe('done');
  });

  // 이 줄이 지금까지 화면에 없어서 "연결됨인데 통신이 안 되는" 상태를 아무도 설명할 수 없었다.
  // 등록이 만료되면 컨트롤 플레인이 세션을 끊는데, 노드는 연결됨으로 남고 기기 목록까지 낡은
  // 값으로 유지된다.
  it("컨트롤 플레인 동기화가 끊긴 것을 드러낸다", () => {
    const stale = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      tailnetStatus: createStatus({
        state: 'running',
        ready: false,
        online: false,
        peers: [{ direct: true }],
      }),
      failureLayer: null,
    });
    const sync = stale.find((stage) => stage.id === 'tailscale-network');

    expect(sync?.state).toBe('active');
    // 끊긴 것을 말해야 한다. 낡은 기기 목록을 근거로 "91대 보임" 을 쓰면 사용자는 왜 안 되는지
    // 알 수 없다.
    expect(detailOf(sync)).toBe(t('connectStages.tailscaleStaleDetail'));

    // 끊긴 것은 이 줄 하나다. 등록·로그인은 이미 끝났고(authorized), 그것을 미완료로 되돌리면
    // 화면이 거꾸로 진행하는 것처럼 보인다 — 아래 단계에는 체크가 떠 있는데 위가 "아직" 이었다.
    expect(stateOf(stale, 'tailscale-registration')).toBe('done');
    expect(stateOf(stale, 'tailscale-auth')).toBe('done');
  });

  // 동기화가 끊긴 채로 코어가 진행하기로 했으면(degraded) 그것은 경고이고 대기가 아니다.
  //
  // "진행 중"(…)으로 두면 이미 넘어간 뒤에도 무언가를 기다리는 것처럼 보이고, 다음 관문이 시작된
  // 것을 화면이 부정한다 — 코어가 넘긴 연결을 화면이 되돌려 세워 두는 셈이다.
  it("동기화 없이 진행하기로 한 것은 경고로 남긴다", () => {
    const degraded = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connecting' })),
      hasTailscale: true,
      tailnetStatus: createStatus({
        state: 'running',
        ready: false,
        online: false,
        degraded: true,
        peers: [{ direct: true }],
      }),
      failureLayer: null,
    });
    const sync = degraded.find((stage) => stage.id === 'tailscale-network');

    expect(sync?.state).toBe('warn');
    expect(detailOf(sync)).toBe(t('connectStages.tailscaleDegradedDetail'));
    // 코어가 넘겼으므로 호스트 계층은 실제로 진행 중이다.
    expect(stateOf(degraded, 'host-key')).toBe('active');
  });

  // 동기화가 살아 있을 때만 기기 수를 말한다. 끊긴 상태의 기기 목록은 낡은 값이라, 그것을 근거로
  // 보여주면 "91대가 보이는데 왜 안 되지" 가 된다.
  it("동기화 중일 때만 기기 수를 말한다", () => {
    const live = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      tailnetStatus: createStatus({ peers: [{ direct: true }, { direct: false }] }),
      failureLayer: null,
    });
    const sync = live.find((stage) => stage.id === 'tailscale-network');

    expect(sync?.state).toBe('done');
    expect(detailOf(sync)).toContain('2');
  });
  // 분류되지 않은 실패가 어느 단계에도 안 붙으면, 실패한 단계가 "아직 시작 안 함" 으로 남아 화면에서
  // 사라진다. 문구를 하나씩 분류하는 것으로는 막을 수 없다 — 새 에러가 나올 때마다 같은 일이 생긴다.
  it("분류되지 않은 실패는 진행 중이던 단계에 붙인다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(
        createTab({
          status: 'error',
          errorMessage: 'something nobody classified',
          connectionProgress: {
            stage: 'connecting',
            message: '',
            blockingKind: 'none',
            retryable: true,
          },
        }),
      ),
      hasTailscale: true,
      tailnetStatus: createStatus({ peers: [{ direct: true }] }),
      failureLayer: null,
      failureMessage: 'something nobody classified',
    });

    // 호스트 키까지 갔으므로 SSH 연결이 진행 중이던 단계다.
    expect(stateOf(stages, 'ssh')).toBe('failed');
    expect(detailOf(stages.find((stage) => stage.id === 'ssh'))).toBe(
      'something nobody classified',
    );
  });

  // Tailscale 이 붙어 있어도 대상에 못 가는 경우가 있다. 그것을 안 보여주면 "설정은 연결됨인데 왜
  // 안 되지" 가 된다.
  it("대상까지의 경로를 보여준다", () => {
    const direct = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      targetAddress: 'agt-1',
      tailnetStatus: createStatus({
        peers: [{ direct: true, hostName: 'agt-1', dnsName: 'agt-1.example.ts.net' }],
      }),
      failureLayer: null,
    });
    const relayed = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      targetAddress: '100.64.0.1',
      tailnetStatus: createStatus({
        peers: [{ direct: false, relay: 'tok', ips: ['100.64.0.1'] }],
      }),
      failureLayer: null,
    });

    expect(stateOf(direct, 'tailscale-target')).toBe('done');
    expect(detailOf(direct.find((stage) => stage.id === 'tailscale-target'))).toBe(
      t('connectStages.tailscaleTargetDirect'),
    );
    expect(detailOf(relayed.find((stage) => stage.id === 'tailscale-target'))).toContain('tok');
  });

  // 넷맵은 받았는데 대상이 그 안에 없으면, 기다려도 안 된다. 그 사실을 말해야 한다.
  it("넷맵에 없는 대상은 실패로 말한다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      targetAddress: 'ghost',
      tailnetStatus: createStatus({ peers: [{ direct: true, hostName: 'agt-1' }] }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'tailscale-target')).toBe('failed');
  });

  // 서브넷 라우터가 광고한 대역은 기기 목록에 없지만 이 네트워크로 닿는다. 그것을 "기기를 찾을 수
  // 없습니다" 로 말하면 멀쩡한 경로를 실패로 그린다 — 실기기에서 사내 192.168.x 주소가 그랬다.
  it("서브넷 라우터가 담당하는 대역은 경로가 있는 것으로 본다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      targetAddress: '192.168.200.37',
      tailnetStatus: createStatus({
        peers: [
          { direct: true, hostName: 'router-1', routes: ['192.168.200.0/24'] },
          { direct: true, hostName: 'agt-1' },
        ],
      }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'tailscale-target')).toBe('done');
    expect(detailOf(stages.find((stage) => stage.id === 'tailscale-target'))).toContain('router-1');
  });

  // 기기도 아니고 담당 대역도 없는 IP 는 tailnet 밖 경로(점프 뒤의 망·지금 붙어 있는 랜)로 갈 수
  // 있다. 실패로 단정하면 사용자가 엉뚱한 곳을 의심한다.
  it("담당 대역이 없는 IP 는 실패로 단정하지 않는다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      targetAddress: '10.9.9.9',
      tailnetStatus: createStatus({
        peers: [{ direct: true, hostName: 'router-1', routes: ['192.168.200.0/24'] }],
      }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'tailscale-target')).toBe('warn');
  });

  // 이름(MagicDNS)으로 지정한 대상이 넷맵에 없으면 그건 여전히 실패다 — 기다려도 되지 않는다.
  it("이름으로 지정한 대상이 없으면 여전히 실패다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      targetAddress: 'ghost',
      tailnetStatus: createStatus({
        peers: [{ direct: true, hostName: 'router-1', routes: ['192.168.200.0/24'] }],
      }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'tailscale-target')).toBe('failed');
  });

  // 이미 분류된 실패가 있으면 그것을 덮지 않는다. 덮으면 Tailscale 실패가 SSH 실패로 옮겨져서,
  // 사용자가 엉뚱한 계층을 의심한다.
  it("이미 분류된 실패를 다른 단계로 옮기지 않는다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'error', errorMessage: 'tailnet expired' })),
      hasTailscale: true,
      tailnetStatus: createStatus({ state: 'needsAuth', ready: false, expired: true }),
      failureLayer: 'tailscale',
      failureMessage: '등록이 만료됐습니다.',
    });

    expect(stateOf(stages, 'tailscale-registration')).toBe('failed');
    // 실패는 하나여야 한다. 이미 붙은 것을 두고 또 붙이면 어느 것이 원인인지 알 수 없다.
    expect(stages.filter((stage) => stage.state === 'failed')).toHaveLength(1);
  });

  // Tailscale 을 쓰지 않는 호스트에는 그 줄이 없어야 한다.
  it("대상 주소가 없으면 경로 줄을 만들지 않는다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      tailnetStatus: createStatus({ peers: [{ direct: true }] }),
      failureLayer: null,
    });

    expect(stages.some((stage) => stage.id === 'tailscale-target')).toBe(false);
  });
  // 경로가 없을 때 원인은 여러 개라 단정할 수 없다. 대신 주고받은 양을 그대로 보여주면 사용자가
  // "보내는데 답이 없다" 를 스스로 읽는다 — 오늘 이 판단에 30 분이 걸렸다.
  it("경로가 없으면 그 사실과 주고받은 양만 말한다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab()),
      hasTailscale: true,
      targetAddress: 'agt-1',
      tailnetStatus: createStatus({
        peers: [{ direct: false, hostName: 'agt-1', txBytes: 149304, rxBytes: 0 }],
      }),
      failureLayer: null,
    });
    const target = stages.find((stage) => stage.id === 'tailscale-target');

    expect(target?.state).toBe('failed');
    expect(detailOf(target)).toContain('146 KB');
    expect(detailOf(target)).toContain('0 B');
    // 원인을 단정하지 않는다.
    expect(detailOf(target)).not.toContain('삭제');
    expect(detailOf(target)).not.toContain('만료');
  });

  // 경로가 있으면 그것도 관찰값과 함께.
  it("경로가 있으면 직결·릴레이와 주고받은 양을 함께 보여준다", () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connected' })),
      hasTailscale: true,
      targetAddress: 'agt-1',
      tailnetStatus: createStatus({
        peers: [{ direct: true, hostName: 'agt-1', txBytes: 149304, rxBytes: 32984 }],
      }),
      failureLayer: null,
    });
    const target = stages.find((stage) => stage.id === 'tailscale-target');

    expect(target?.state).toBe('done');
    expect(detailOf(target)).toContain(t('connectStages.tailscaleTargetDirect'));
    expect(detailOf(target)).toContain('32 KB');
  });
  // 무엇에 붙든 "호스트 키 확인 → SSH 연결" 이 뜨던 버그. 로컬 셸에는 둘 다 없고, RDP·시리얼·
  // ECS Exec 은 SSH 를 쓰지 않는다 — 없는 관문이 통과되는 것처럼 보이면 어디서 막혔는지 못 읽는다.
  it('로컬 셸에는 호스트 계층 단계를 세우지 않는다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ source: 'local', hostId: null, status: 'connecting' })),
      hasTailscale: false,
      failureLayer: null,
    });

    expect(stages).toEqual([]);
  });

  it('RDP 는 호스트 키 대신 RDP 연결 한 단계만 세운다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ paneKind: 'rdp', status: 'connecting' })),
      hasTailscale: false,
      hostKind: 'rdp',
      failureLayer: null,
    });

    expect(stages.map((stage) => stage.id)).toEqual(['rdp']);
    expect(labelOf(stages[0])).toBe(t('connectStages.rdp'));
    // 앞에 관문이 없으므로 바로 진행 중이어야 한다 — 'pending' 이면 멈춘 것처럼 보인다.
    expect(stages[0].state).toBe('active');
  });

  it('시리얼과 ECS Exec 도 SSH 라고 하지 않는다', () => {
    const serial = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connecting', shellKind: 'serial' })),
      hasTailscale: false,
      hostKind: 'serial',
      failureLayer: null,
    });
    const ecs = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connecting' })),
      hasTailscale: false,
      hostKind: 'aws-ecs',
      failureLayer: null,
    });

    expect(serial.map((stage) => stage.id)).toEqual(['serial']);
    expect(ecs.map((stage) => stage.id)).toEqual(['ecs-exec']);
  });

  // SSH 를 타는 종류(SSH·EC2·Warpgate)는 그대로 호스트 키를 먼저 확인한다.
  it('SSH 계열은 호스트 키 확인을 유지한다', () => {
    for (const hostKind of ['ssh', 'aws-ec2', 'warpgate-ssh'] as const) {
      const stages = resolveConnectionStages({
        subject: stageSubjectFromTab(createTab({ status: 'connecting' })),
        hasTailscale: false,
        hostKind,
        failureLayer: null,
      });

      expect(stages.map((stage) => stage.id)).toEqual(['host-key', 'ssh']);
    }
  });

  // 호스트 종류가 아직 없을 때(목록 로딩) 로컬로 보면 단계가 통째로 사라진다.
  it('호스트 탭인데 종류를 모르면 SSH 로 본다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ status: 'connecting' })),
      hasTailscale: false,
      failureLayer: null,
    });

    expect(stages.map((stage) => stage.id)).toEqual(['host-key', 'ssh']);
  });

  // tailnet 을 경유하는 RDP 는 그 계층을 지나기 전에는 붙는 중이 아니다.
  it('tailnet 이 아직 준비되지 않으면 RDP 단계는 기다린다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ paneKind: 'rdp', status: 'connecting' })),
      hasTailscale: true,
      hostKind: 'rdp',
      tailnetStatus: createStatus({ ready: false, authorized: false, state: 'starting' }),
      failureLayer: null,
    });

    expect(stateOf(stages, 'rdp')).toBe('pending');
  });
  // 터널 관문 두 개. 이 둘의 실패가 사용자에게 완전히 다르다 — 경유 서버에 못 붙었으면 그쪽
  // 자격증명 문제이고, 통로는 열렸는데 그 뒤가 막혔으면 원격에 VNC 가 안 떠 있다는 뜻이다.
  it('SSH 터널을 거치면 관문 두 개가 순서대로 진행한다', () => {
    const gateway = resolveConnectionStages({
      subject: stageSubjectFromTab(
        createTab({
          paneKind: 'vnc',
          status: 'pending',
          connectionProgress: {
            stage: 'ssh-tunnel-gateway',
            message: '경유 중',
            blockingKind: 'none',
            retryable: true,
          },
        }),
      ),
      hasTailscale: false,
      hostKind: 'vnc',
      tunnelLabel: 'Gate',
      failureLayer: null,
    });
    expect(stateOf(gateway, 'ssh-tunnel-gateway')).toBe('active');
    expect(stateOf(gateway, 'ssh-tunnel')).toBe('pending');
    // 통로가 아직 없으면 그 뒤의 VNC 협상은 시작조차 못 한다.
    expect(stateOf(gateway, 'vnc')).toBe('pending');

    const opened = resolveConnectionStages({
      subject: stageSubjectFromTab(
        createTab({
          paneKind: 'vnc',
          status: 'pending',
          connectionProgress: {
            stage: 'ssh-tunnel-open',
            message: '통로 열림',
            blockingKind: 'none',
            retryable: true,
          },
        }),
      ),
      hasTailscale: false,
      hostKind: 'vnc',
      tunnelLabel: 'Gate',
      failureLayer: null,
    });
    expect(stateOf(opened, 'ssh-tunnel-gateway')).toBe('done');
    expect(stateOf(opened, 'ssh-tunnel')).toBe('done');
    expect(stateOf(opened, 'vnc')).toBe('active');
  });

  // 터널을 안 쓰는 연결에 없는 관문을 세우면 무엇을 기다리는지 오히려 헷갈린다.
  it('터널을 안 쓰면 그 관문이 아예 없다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ paneKind: 'vnc' })),
      hasTailscale: false,
      hostKind: 'vnc',
      failureLayer: null,
    });

    expect(stages.map((stage) => stage.id)).toEqual(['vnc']);
  });

  // tailnet 을 지나야 통로를 열 수 있다. 그 전에 "진행 중" 으로 그리면 순서가 거꾸로 보인다.
  it('tailnet 이 아직이면 터널 관문은 기다린다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(createTab({ paneKind: 'vnc' })),
      hasTailscale: true,
      hostKind: 'vnc',
      tailnetStatus: createStatus({ state: 'needsAuth', ready: false, authorized: false }),
      tunnelLabel: 'Gate',
      failureLayer: null,
    });

    expect(stateOf(stages, 'ssh-tunnel-gateway')).toBe('pending');
    expect(stateOf(stages, 'ssh-tunnel')).toBe('pending');
  });

  // 분류되지 않은 실패는 진행 중이던 관문에 붙는다(마지막 정리). 통로를 여는 중에 실패하면 그
  // 사실이 어디서 났는지 이 줄이 말한다.
  it('경유 중 실패는 그 관문에 붙는다', () => {
    const stages = resolveConnectionStages({
      subject: stageSubjectFromTab(
        createTab({
          paneKind: 'vnc',
          status: 'error',
          connectionProgress: {
            stage: 'ssh-tunnel-gateway',
            message: '경유 중',
            blockingKind: 'none',
            retryable: true,
          },
        }),
      ),
      hasTailscale: false,
      hostKind: 'vnc',
      tunnelLabel: 'Gate',
      failureLayer: null,
      failureMessage: 'ssh: handshake failed',
    });

    expect(stateOf(stages, 'ssh-tunnel-gateway')).toBe('failed');
    expect(detailOf(stages.find((stage) => stage.id === 'ssh-tunnel-gateway'))).toBe(
      'ssh: handshake failed',
    );
  });
});
