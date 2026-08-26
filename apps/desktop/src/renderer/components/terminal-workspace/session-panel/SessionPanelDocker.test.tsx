// 배관 검증. 명령 문자열과 파싱은 lib/docker.test.ts 가 덮으므로, 여기서는 "화면에서 누르면
// 어디로 무엇이 나가는가" 만 본다 — 읽기는 보조 채널, 셸·로그는 새 탭, 상태 변경은 지금
// 터미널, 파괴적인 것은 넣기만.

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanelDocker } from './SessionPanelDocker';
import { queryPrefixOf, requestDockerRefresh, useDockerRuntime } from './useSessionDocker';
import { clearSessionScopedState } from './useSessionScopedState';
import type { SessionPanelSender } from './useSessionPanelTarget';

const connectHost = vi.fn();
const openTunnel = vi.fn(() => Promise.resolve());
const closeTunnel = vi.fn(() => Promise.resolve());
const openExternalUrl = vi.fn();
const query = vi.fn();

const storeState: Record<string, unknown> = {};

vi.mock('../../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

vi.mock('../../../services/desktop/terminal', () => ({
  queryTerminalCompletion: (
    sessionId: string,
    command: string,
    options?: { background?: boolean },
  ) => query(sessionId, command, options),
}));

/** 패널이 넘긴 "대상 알아내기" 함수를 꺼낸다. 스토어가 "여는 중" 을 찍은 뒤에 부르는 값이다. */
function resolveNetworksOf(spy: ReturnType<typeof vi.fn>) {
  const input = spy.mock.calls[0]?.[0] as {
    resolveNetworks: () => Promise<readonly { name: string; ipAddress: string }[]>;
  };
  return input.resolveNetworks;
}

function row(cells: string[]): string {
  return [...cells, ...Array.from({ length: 9 - cells.length }, () => '')].join('\t');
}

const CONTAINERS = [
  row(['a1b2c3d4e5f6', 'lime-gateway', 'running', 'Up 22 hours (healthy)', 'app:1', '0.0.0.0:5050->5050/tcp', 'lime', 'gateway', '/srv/lime']),
  row(['a2b3c4d5e6f7', 'lime-bid', 'running', 'Up 22 hours', 'app:1', '', 'lime', 'bid', '/srv/lime']),
  row(['b1c2d3e4f506', 'loose', 'exited', 'Exited (137) 3 days ago', 'redis:7']),
].join('\n');

/**
 * 지표 왕복이 돌려주는 것: 지표 · 검사(구분자로 갈라 온다). 목록과 **다른 왕복**이다 —
 * `stats --no-stream` 이 느려서 목록이 그 뒤에 서지 않게 갈라 놓았다.
 */
const METRICS = [
  ['a1b2c3d4e5f6\t12.40%\t412MiB / 15.6GiB\t2.58%\t1.2GB / 340MB\t0B / 4.1MB\t18',
   'a2b3c4d5e6f7\t0.30%\t96MiB / 15.6GiB\t0.60%\t2MB / 1MB\t0B / 0B\t7'].join('\n'),
  '@@dolgate@@',
  [
    // 마지막 칸은 컨테이너가 여는 포트다 — `ps` 는 공개된 것만 주므로 여기서 함께 받는다.
    `a1b2c3d4e5f6${'0'.repeat(52)}\t0\thealthy\tfalse\t5050/tcp 9090/tcp \tbridge=172.17.0.5;`,
    `a2b3c4d5e6f7${'0'.repeat(52)}\t14\t\tfalse\t\t`,
  ].join('\n'),
].join('\n');

function sender(overrides: Partial<SessionPanelSender> = {}): SessionPanelSender {
  return {
    context: { atPrompt: true, bracketedPaste: false },
    insert: vi.fn(() => true),
    run: vi.fn(() => true),
    copy: vi.fn(),
    jumpToLine: vi.fn(),
    ...overrides,
  } as SessionPanelSender;
}

function renderSection(options: {
  sender?: SessionPanelSender;
  hostId?: string | null;
} = {}) {
  const senderStub = options.sender ?? sender();
  const view = render(
    <SessionPanelDocker
      sessionId="session-1"
      hostId={options.hostId === undefined ? 'host-1' : options.hostId}
      sender={senderStub}
      runtime={{ availability: 'available', prefix: 'docker', elevate: false, compose: 'docker compose' }}
    />,
  );
  return { ...view, sender: senderStub };
}

/** 명령별 응답. 부르지 않은 명령이 오면 빈 문자열이다. */
function respond(byFragment: Record<string, string>): void {
  query.mockImplementation((_sessionId: string, command: string) => {
    for (const [fragment, stdout] of Object.entries(byFragment)) {
      if (command.includes(fragment)) {
        return Promise.resolve(stdout);
      }
    }
    return Promise.resolve('');
  });
}

beforeEach(() => {
  // 보던 탭·검색어는 세션 단위로 앱 수명 동안 남는다(모듈 저장소) — 테스트 사이에도 남으므로
  // 여기서 놓는다. 안 그러면 앞 테스트가 옮겨 둔 탭에서 뒤 테스트가 시작한다.
  clearSessionScopedState('session-1');
  connectHost.mockReset();
  openTunnel.mockClear();
  closeTunnel.mockClear();
  openExternalUrl.mockClear();
  query.mockReset();
  Object.assign(storeState, {
    connectHost,
    sessionPanelOpen: true,
    sessionContainerTunnels: {},
    openSessionContainerTunnel: openTunnel,
    closeSessionContainerTunnel: closeTunnel,
    openExternalUrl,
  });
  respond({ 'ps -a --format': CONTAINERS, 'stats --no-stream': METRICS });
});

describe('컨테이너', () => {
  it('스택 라벨로 묶어 그리고 서비스 이름을 보여 준다', async () => {
    renderSection();
    expect(await screen.findByText('lime')).toBeTruthy();
    expect(screen.getByText('gateway')).toBeTruthy();
    // 라벨이 없는 것은 머리 없이 줄로만 온다(머리 한 줄을 벌지 못하므로).
    expect(screen.queryByText('스택 없음')).toBeNull();
    expect(screen.getByText('loose')).toBeTruthy();
    // 돌고 있는 것 / 전체.
    expect(screen.getByText('2/2')).toBeTruthy();
  });

  it('패널이 닫혀 있으면 아무것도 받아오지 않는다', () => {
    Object.assign(storeState, { sessionPanelOpen: false });
    renderSection();
    expect(query).not.toHaveBeenCalled();
  });

  // 이 왕복은 `stats --no-stream` 때문에 초 단위로 채널을 문다. 대화형 레인에 태우면 그동안
  // 사용자가 치는 자동완성이 통째로 뒤에 줄 선다 — 그래서 백그라운드로 표시해 보낸다.
  it('조회는 백그라운드 레인으로 나간다', async () => {
    renderSection();
    await screen.findByText('lime');
    expect(query).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('ps -a --format'),
      { background: true, elevate: false },
    );
    for (const call of query.mock.calls) {
      expect(call[2]).toMatchObject({ background: true });
    }
  });

  it('셸은 새 탭을 열지 않고 지금 터미널에서 실행한다', async () => {
    const { sender: senderStub } = renderSection();
    fireEvent.click(await screen.findByText('gateway'));
    fireEvent.click(screen.getByRole('button', { name: '셸 접속' }));
    expect(senderStub.run).toHaveBeenCalledWith(
      expect.stringContaining("docker exec -it 'lime-gateway'"),
    );
    expect(connectHost).not.toHaveBeenCalled();
  });

  it('로그도 지금 터미널에서 따라간다', async () => {
    const { sender: senderStub } = renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '로그 gateway' }));
    expect(senderStub.run).toHaveBeenCalledWith("docker logs -f --tail 200 'lime-gateway'");
    expect(connectHost).not.toHaveBeenCalled();
  });

  it('정지된 컨테이너는 셸이 꺼진다', async () => {
    renderSection();
    fireEvent.click(await screen.findByText('loose'));
    expect((screen.getByRole('button', { name: '셸 접속' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByText('gateway'));
    expect((screen.getByRole('button', { name: '셸 접속' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('재시작은 지금 터미널에서 실행하고, 삭제는 넣기만 한다', async () => {
    const { sender: senderStub } = renderSection();
    await screen.findByText('gateway');
    fireEvent.click(screen.getByText('gateway'));
    fireEvent.click(screen.getByRole('button', { name: '재시작' }));
    expect(senderStub.run).toHaveBeenCalledWith("docker restart 'lime-gateway'");

    fireEvent.click(screen.getByRole('button', { name: '삭제 gateway' }));
    expect(senderStub.insert).toHaveBeenCalledWith("docker rm 'lime-gateway'");
    // 파괴적인 것은 엔터를 사람이 친다 — 우리가 실행하지 않는다.
    expect(senderStub.run).toHaveBeenCalledTimes(1);
  });

  it('프롬프트가 아니면 상태를 바꾸는 항목이 꺼진다(셸·로그는 그대로)', async () => {
    renderSection({ sender: sender({ context: { atPrompt: false, bracketedPaste: false } }) });
    await screen.findByText('gateway');
    fireEvent.click(screen.getByText('gateway'));
    // 이제 셸·로그도 지금 터미널에 넣으므로 넣을 자리가 없으면 함께 꺼진다.
    for (const name of ['재시작', '로그', '셸 접속']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  /**
   * 줄에는 이름과 숫자만 둔다. 제어는 전부 펼친 화면에 있다 — 줄 위에 얹으면 CPU·MEM 을 가리고,
   * 흐름에 끼우면 이름이 그만큼 잘린다.
   */
  it('줄에는 제어 버튼을 두지 않는다', async () => {
    renderSection();
    await screen.findByText('gateway');
    expect(screen.queryByRole('button', { name: '셸 접속' })).toBeNull();
    expect(screen.queryByRole('button', { name: '로그' })).toBeNull();

    fireEvent.click(screen.getByText('gateway'));
    expect(screen.getByRole('button', { name: '셸 접속' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '로그' })).toBeTruthy();
  });

  it('스택 머리에서 여러 컨테이너를 한 명령으로 다룬다', async () => {
    const { sender: senderStub } = renderSection();
    await screen.findByText('lime');
    fireEvent.click(screen.getByRole('button', { name: '더 보기 lime' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '스택 재시작' }));
    // 그룹의 컨테이너를 한 명령으로 — 화면에 보이는 순서 그대로.
    expect(senderStub.run).toHaveBeenCalledWith("docker restart 'lime-bid' 'lime-gateway'");
  });

  it('compose down 은 넣기만 하고 디렉터리를 명시한다', async () => {
    const { sender: senderStub } = renderSection();
    await screen.findByText('lime');
    fireEvent.click(screen.getByRole('button', { name: '더 보기 lime' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /compose down/ }));
    // 프로젝트 디렉터리로 들어가서 부른다 — `--project-directory` 는 설정 파일을 찾아 주지
    // 않는다. 괄호 덕에 사용자의 현재 위치는 그대로다.
    expect(senderStub.insert).toHaveBeenCalledWith(
      "(cd '/srv/lime' && docker compose -p 'lime' down)",
    );
  });

  it('compose 가 없는 호스트에서는 그 항목을 만들지 않는다', async () => {
    // 옛 호스트에는 `docker compose` 도 `docker-compose` 도 없을 수 있다. 눌리지 않는 메뉴를
    // 보여 주는 것보다 없는 편이 낫다 — 재시작·정지는 compose 없이 되므로 그대로 남는다.
    render(
      <SessionPanelDocker
        sessionId="session-1"
        hostId="host-1"
        sender={sender()}
        runtime={{ availability: 'available', prefix: 'docker', elevate: false, compose: null }}
      />,
    );
    await screen.findByText('lime');
    fireEvent.click(screen.getByRole('button', { name: '더 보기 lime' }));
    expect(screen.getByRole('menuitem', { name: '스택 재시작' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /compose down/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '스택 로그' })).toBeNull();
  });

  it('행을 누르면 이미 받아 온 값으로 상세를 펼친다(왕복 없음)', async () => {
    renderSection();
    // 목록과 지표는 다른 왕복이다 — 둘 다 온 뒤에 세야 "누를 때" 나가는 것만 잡힌다.
    await screen.findByText('gateway');
    await screen.findByText('12.4%');
    const before = query.mock.calls.length;
    fireEvent.click(screen.getByText('gateway'));
    // 포트는 줄로 나뉘어 그려진다(열 수 있는 단위라서).
    expect(screen.getByText('5050 → 5050/tcp')).toBeTruthy();
    expect(screen.getByText('lime-gateway')).toBeTruthy();
    // 지표는 이미 받아 둔 값으로 그린다 — 누른다고 다시 묻지 않는다.
    // I/O 는 누적값이 아니라 초당 값으로 그린다(첫 표본에서는 '재는 중').
    expect(screen.getByText('I/O')).toBeTruthy();
    expect(query.mock.calls.length).toBe(before);
  });

  /**
   * (a) 의 핵심. `stats --no-stream` 은 데몬이 CPU 차분을 재느라 1~2초가 바닥값인데, 예전에는
   * 목록과 한 왕복이라 이름 몇 줄을 그리는 데 그 시간을 통째로 기다렸다.
   */
  it('목록이 지표를 기다리지 않는다 — stats 가 늦어도 이름이 먼저 뜬다', async () => {
    let releaseStats: () => void = () => undefined;
    query.mockImplementation((_sessionId: string, command: string) => {
      if (command.includes('stats --no-stream')) {
        return new Promise<string>((resolve) => {
          releaseStats = () => resolve(METRICS);
        });
      }
      if (command.includes('ps -a --format')) {
        return Promise.resolve(CONTAINERS);
      }
      return Promise.resolve('');
    });

    // 목록은 호스트 단위로 기억한다 — 앞선 테스트가 남긴 지표와 섞이지 않게 제 호스트를 쓴다.
    renderSection({ hostId: 'host-late-stats' });
    // 지표 왕복이 아직 안 끝났는데 목록은 이미 떠 있다.
    expect(await screen.findByText('gateway')).toBeTruthy();
    expect(screen.getByText('loose')).toBeTruthy();
    expect(screen.queryByText('12.4%')).toBeNull();

    // 뒤늦게 도착하면 그 자리에 채워진다.
    releaseStats();
    expect(await screen.findByText('12.4%')).toBeTruthy();
  });

  /**
   * 지표 왕복이 조용히 실패하면(코어의 완성 타임아웃은 오류가 아니라 빈 문자열로 돌아온다)
   * stdout 이 통째로 빈다. 그것을 "이 호스트는 지표를 못 준다" 로 읽으면 한 번 늦은 것 때문에
   * CPU·MEM 이 영영 사라진다 — 명령이 돌기만 했다면 구분자라도 찍혀 있다.
   */
  it('지표 왕복이 빈손으로 와도 지표를 포기하지 않는다', async () => {
    let metricsCalls = 0;
    query.mockImplementation((_sessionId: string, command: string) => {
      if (command.includes('stats --no-stream')) {
        metricsCalls += 1;
        // 첫 왕복은 빈손(타임아웃), 두 번째부터 제대로 온다.
        return Promise.resolve(metricsCalls === 1 ? '' : METRICS);
      }
      if (command.includes('ps -a --format')) {
        return Promise.resolve(CONTAINERS);
      }
      return Promise.resolve('');
    });

    renderSection();
    await screen.findByText('gateway');
    await waitFor(() => expect(metricsCalls).toBe(1));

    // 새로 받으면 stats 가 그대로 붙어 나가고 값이 채워진다(빼 버리지 않았다).
    requestDockerRefresh('session-1');
    expect(await screen.findByText('12.4%')).toBeTruthy();
  });

  it('행에 CPU·MEM 이 뜨고 머리에 합계가 뜬다', async () => {
    renderSection();
    await screen.findByText('gateway');
    // 지표는 목록 뒤에 오는 두 번째 왕복이라 기다린다.
    expect(await screen.findByText('12.4%')).toBeTruthy();
    expect(screen.getByText('412 MiB')).toBeTruthy();
    // 2/3 실행 · CPU 합 12.7% · MEM 합
    expect(screen.getByText(/2\/3 실행/)).toBeTruthy();
    expect(screen.getByText(/CPU/)).toBeTruthy();
  });

  /**
   * 이력은 표본이 쌓일 때마다 **새 배열**로 온다(제자리에서 고치지 않는다). 그래서 섹션 전체를
   * 흔드는 `historyVersion` 없이도 스파크라인이 다시 그려진다 — 이 테스트가 그 보증이다.
   * 표본이 하나뿐일 때는 자리만 잡고, 둘이 되면 선이 생긴다.
   */
  it('표본이 쌓이면 스파크라인이 자라난다', async () => {
    let cpu = '12.40%';
    query.mockImplementation((_sessionId: string, command: string) => {
      if (command.includes('stats --no-stream')) {
        return Promise.resolve(
          [
            `a1b2c3d4e5f6\t${cpu}\t412MiB / 15.6GiB\t2.58%\t1.2GB / 340MB\t0B / 4.1MB\t18`,
            '@@dolgate@@',
          ].join('\n'),
        );
      }
      if (command.includes('ps -a --format')) {
        return Promise.resolve(CONTAINERS);
      }
      return Promise.resolve('');
    });

    // 이력은 호스트 단위로 앱이 켜져 있는 동안 남는다(다른 탭에서 돌아와도 이어진다) —
    // 이 테스트만 쓰는 호스트를 줘서 앞선 테스트가 쌓아 둔 표본과 섞이지 않게 한다.
    const { container } = renderSection({ hostId: 'host-sparkline' });
    await screen.findByText('12.4%');
    // 표본 하나로는 선을 그리지 않는다.
    expect(container.querySelector('svg polyline')).toBeNull();

    // 두 번째 표본. 새로 받기가 지표 왕복도 다시 돌린다.
    cpu = '31.00%';
    requestDockerRefresh('session-1');
    expect(await screen.findByText('31%')).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector('svg polyline')).not.toBeNull();
    });
  });

  it('재시작이 잦은 컨테이너는 행에서 바로 드러난다', async () => {
    renderSection();
    await screen.findByText('bid');
    // 재시작 횟수는 검사(inspect)에서 온다 — 지표 왕복에 실려 목록보다 뒤에 온다.
    expect(await screen.findByText('재시작 14회')).toBeTruthy();
  });
});

describe('보여 줄 것을 우리가 정한다', () => {
  it('목록이 짧으면 검색줄을 그리지 않는다', async () => {
    renderSection();
    await screen.findByText('gateway');
    expect(screen.queryByLabelText('컨테이너 검색')).toBeNull();
  });

  it('길어지면 검색줄이 생기고 앱에서 거른다(왕복 없음)', async () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      row([`id${index}`, `web-${index}`, 'running', 'Up 1 hour', 'app:1']),
    ).join('\n');
    respond({ 'ps -a --format': many });
    renderSection();
    const search = await screen.findByLabelText('컨테이너 검색');
    const before = query.mock.calls.length;
    fireEvent.change(search, { target: { value: 'web-13' } });
    expect(screen.getByText('web-13')).toBeTruthy();
    expect(screen.queryByText('web-12')).toBeNull();
    expect(query.mock.calls.length).toBe(before);
  });

  it('정지된 것이 많으면 접어 둔다 — 토글이 아니라 그냥 접혀 있다', async () => {
    const rows = [
      row(['r1', 'up-1', 'running', 'Up 1 hour', 'app:1', '', 'lime', 'up-1']),
      ...Array.from({ length: 4 }, (_, index) =>
        row([`s${index}`, `down-${index}`, 'exited', 'Exited (0) 2 days ago', 'app:1', '', 'lime', `down-${index}`]),
      ),
    ].join('\n');
    respond({ 'ps -a --format': rows });
    renderSection();
    expect(await screen.findByText('up-1')).toBeTruthy();
    expect(screen.queryByText('down-0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '정지 4개' }));
    expect(screen.getByText('down-0')).toBeTruthy();
  });
});

describe('다른 탭', () => {
  // 목록은 `docker images`, 총량은 `system df` — 다른 왕복이다. `system df` 는 레이어를 전부
  // 걷느라 초 단위로 걸려서, 목록이 그 뒤에 서면 이미지 탭이 통째로 늦어진다.
  /**
   * 이미지·볼륨 탭은 목록 한 왕복이 전부다. 디스크 총량과 볼륨 크기는 `docker system df` 라야
   * 정확한데, 그건 레이어·볼륨을 전부 걷느라 수십 초가 걸리고 그동안 보조 채널을 혼자 물어
   * 컨테이너 목록까지 함께 멈춰 세웠다.
   */
  it('이미지 탭은 images 한 번으로 끝낸다', async () => {
    respond({
      'ps -a --format': CONTAINERS,
      'images --format': ['app\t1\tsha1\t412MB', 'old\t2\tsha2\t1.1GB'].join('\n'),
    });
    renderSection();
    await screen.findByText('gateway');
    fireEvent.click(screen.getByRole('button', { name: /이미지/ }));
    expect(await screen.findByText('app')).toBeTruthy();
    // app:1 은 컨테이너가 쓰고 있으니 미사용이 아니다 — old 하나만 붙는다.
    expect(screen.getAllByText('미사용')).toHaveLength(1);
    expect(query.mock.calls.some(([, command]) => command.includes('system df'))).toBe(false);
  });

  it('볼륨 탭은 volume ls 한 번으로 끝낸다', async () => {
    respond({
      // 볼륨 명령도 뒤에 ps 를 달고 있으므로 더 좁은 조각을 먼저 둔다.
      'volume ls': ['pgdata\tlocal', '@@dolgate@@', 'pgdata'].join('\n'),
      'ps -a --format': CONTAINERS,
    });
    renderSection();
    await screen.findByText('gateway');
    fireEvent.click(screen.getByRole('button', { name: /볼륨/ }));
    expect(await screen.findByText('pgdata')).toBeTruthy();
    expect(query.mock.calls.some(([, command]) => command.includes('system df'))).toBe(false);
  });
});

describe('알아서 다시 받는다', () => {
  it('헤더의 새로고침 요청을 받아 다시 받아온다', async () => {
    renderSection();
    await screen.findByText('gateway');
    const before = query.mock.calls.length;
    requestDockerRefresh('session-1');
    await waitFor(() => {
      expect(query.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('받아오기가 실패하면 마지막 목록을 남기고 물러난다 — 누를 것은 없다', async () => {
    renderSection();
    await screen.findByText('gateway');
    query.mockRejectedValue(new Error('보조 채널 없음'));
    requestDockerRefresh('session-1');
    expect(await screen.findByText(/다시 받는 중/)).toBeTruthy();
    // 목록은 그대로 남는다.
    expect(screen.getByText('gateway')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /다시 시도|재시도/ })).toBeNull();
  });
});

describe('sudo 까지 해 본 뒤에도 막힌 경우', () => {
  it('한 줄로 말하고 시키지 않는다', () => {
    render(
      <SessionPanelDocker
        sessionId="session-1"
        hostId="host-1"
        sender={sender()}
        runtime={{ availability: 'blocked', prefix: null, elevate: false, compose: null }}
      />,
    );
    expect(screen.getByText('도커를 읽을 수 없습니다')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/**
 * 프로브 왕복이 **실패한 것**은 "도커가 없다" 가 아니다. 보조 채널은 세션 패널의 다른 폴링과
 * 함께 쓰므로 차례를 놓칠 수 있는데, 그걸 부재로 단정하면 섹션이 통째로 사라지고 재시도 TTL
 * 만큼 돌아오지 않는다. 도커가 정말 없는 호스트는 왕복이 **성공하고 빈 출력**으로 온다.
 */
describe('도커를 부를 수 있는지 알아보기', () => {
  function probeOnce(hostId: string, respondWith: (attempt: number) => Promise<string>) {
    let attempts = 0;
    query.mockImplementation((_sessionId: string, command: string) => {
      if (!command.includes('prefix=$c')) {
        return Promise.resolve('');
      }
      attempts += 1;
      return respondWith(attempts);
    });
    const view = renderHook(() => useDockerRuntime('session-probe', hostId));
    return { view, attempts: () => attempts };
  }

  it('왕복이 실패해도 부재로 단정하지 않고 다시 묻는다', async () => {
    vi.useFakeTimers();
    try {
      const { view, attempts } = probeOnce('host-probe-retry', (attempt) =>
        attempt === 1
          ? Promise.reject(new Error('completion lane busy'))
          : Promise.resolve('prefix=docker\nhas=docker\n'),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(attempts()).toBe(1);
      // 아직 아무것도 단정하지 않는다 — 'absent' 였다면 섹션이 사라진다.
      expect(view.result.current.availability).toBe('checking');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      expect(attempts()).toBe(2);
      expect(view.result.current.availability).toBe('available');
      expect(view.result.current.prefix).toBe('docker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('빈 출력은 "없음" 이 아니라 "대답이 없음" 이다 — 몇 번 더 물어본다', async () => {
    // 도커가 없는 호스트도 why= 한 줄은 낸다. 아무 줄도 없으면 명령이 제대로 돌지 않은 것이라
    // (보조 채널이 아직 준비되지 않았거나 이번 차례를 놓쳤다) 단정하면 섹션이 "없습니다" 로
    // 굳는다 — 실기기에서 그렇게 굳었다.
    vi.useFakeTimers();
    try {
      const { view, attempts } = probeOnce('host-probe-empty', () => Promise.resolve(''));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(view.result.current.availability).toBe('checking');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(attempts()).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('이유 줄이 오면 그때는 없다고 단정한다 — 더 묻지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const { view, attempts } = probeOnce('host-probe-absent', () =>
        Promise.resolve('why=sh: 1: docker: not found\n'),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(view.result.current.availability).toBe('absent');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(attempts()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  /**
   * 소켓 권한만 막힌 호스트에서는 접속에 쓴 비밀번호로 sudo 를 **한 번** 되물려 본다.
   * 비밀번호는 코어 안에서만 쓰이고 여기로 오지 않는다 — 렌더러는 `elevate` 표시만 보낸다.
   */
  it('권한만 막혔으면 sudo 로 한 번 되물려 본다', async () => {
    vi.useFakeTimers();
    try {
      const elevated: boolean[] = [];
      query.mockImplementation(
        (_sessionId: string, command: string, options?: { elevate?: boolean }) => {
          if (!command.includes('prefix=$c')) {
            return Promise.resolve('');
          }
          elevated.push(options?.elevate === true);
          // 맨손으로는 권한이 없고, sudo 로 감싸면 통한다.
          return Promise.resolve(
            options?.elevate
              ? ['prefix=docker', 'has=docker', ''].join('\n')
              : [
                  'has=docker',
                  'why=permission denied while trying to connect to the Docker daemon socket',
                  '',
                ].join('\n'),
          );
        },
      );

      const view = renderHook(() => useDockerRuntime('session-probe', 'host-probe-sudo'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // 맨손 한 번, sudo 한 번. 그 이상은 없다 — 틀린 sudo 를 반복하면 계정이 잠긴다.
      expect(elevated).toEqual([false, true]);
      expect(view.result.current.availability).toBe('available');
      expect(view.result.current.elevate).toBe(true);
      // 터미널에 넣는 명령은 사람이 sudo 에 답할 수 있는 자리다 — 여기에는 sudo 를 붙인다.
      expect(view.result.current.prefix).toBe('sudo docker');
      // 보조 채널 조회는 평범한 docker 다 — sudo 는 코어가 씌우므로 안에 또 넣으면 이중이 된다.
      expect(queryPrefixOf(view.result.current)).toBe('docker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sudo 도 통하지 않으면 막힌 것으로 두고 더 시도하지 않는다', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      query.mockImplementation((_sessionId: string, command: string) => {
        if (!command.includes('prefix=$c')) {
          return Promise.resolve('');
        }
        attempts += 1;
        return Promise.resolve(['has=docker', 'why=permission denied', ''].join('\n'));
      });

      const view = renderHook(() => useDockerRuntime('session-probe', 'host-probe-sudo-nope'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(view.result.current.availability).toBe('blocked');
      expect(view.result.current.elevate).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('탭을 오가도 계속 받아온다', () => {
  it('볼륨에 들어갔다 돌아와도 컨테이너가 다시 받아진다', async () => {
    respond({
      // 볼륨 명령도 뒤에 `ps -a --format` 을 달고 있으므로 더 좁은 조각을 먼저 둔다.
      'volume ls': ['pgdata\tlocal', '@@dolgate@@', 'pgdata'].join('\n'),
      'system df -v': 'Local Volumes space usage:',
      'stats --no-stream': METRICS,
      'ps -a --format': CONTAINERS,
    });
    renderSection();
    await screen.findByText('gateway');

    fireEvent.click(screen.getByRole('button', { name: /볼륨/ }));
    expect(await screen.findByText('pgdata')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /컨테이너/ }));
    expect(await screen.findByText('gateway')).toBeTruthy();
  });
});

describe('세션마다 보던 자리를 기억한다', () => {
  /**
   * 패널은 세션 탭을 옮겨도 같은 컴포넌트를 재사용한다. 보던 탭을 그냥 들고 있으면 다른 서버로
   * 가도 그 탭이 따라오고, 돌아왔을 때는 보던 자리를 잃는다.
   */
  it('보던 탭과 검색어가 세션별로 남는다', async () => {
    respond({
      'volume ls': ['pgdata\tlocal', '@@dolgate@@', 'pgdata'].join('\n'),
      'stats --no-stream': METRICS,
      'ps -a --format': CONTAINERS,
    });
    const senderStub = sender();
    const view = render(
      <SessionPanelDocker
        sessionId="session-a"
        hostId="host-a"
        sender={senderStub}
        runtime={{ availability: 'available', prefix: 'docker', elevate: false, compose: 'docker compose' }}
      />,
    );
    await screen.findByText('gateway');
    fireEvent.click(screen.getByRole('button', { name: /볼륨/ }));
    expect(await screen.findByText('pgdata')).toBeTruthy();

    // 다른 세션으로 가면 처음 자리(컨테이너)에서 시작한다.
    view.rerender(
      <SessionPanelDocker
        sessionId="session-b"
        hostId="host-b"
        sender={senderStub}
        runtime={{ availability: 'available', prefix: 'docker', elevate: false, compose: 'docker compose' }}
      />,
    );
    expect(await screen.findByText('gateway')).toBeTruthy();
    expect(screen.queryByText('pgdata')).toBeNull();

    // 돌아오면 보던 탭 그대로.
    view.rerender(
      <SessionPanelDocker
        sessionId="session-a"
        hostId="host-a"
        sender={senderStub}
        runtime={{ availability: 'available', prefix: 'docker', elevate: false, compose: 'docker compose' }}
      />,
    );
    expect(await screen.findByText('pgdata')).toBeTruthy();

    clearSessionScopedState('session-a');
    clearSessionScopedState('session-b');
  });
});

describe('컨테이너 포트 열기', () => {
  it('공개된 포트와 공개 안 된 포트를 함께 보여 준다', async () => {
    renderSection();
    fireEvent.click(await screen.findByText('gateway'));
    expect(screen.getByText('5050 → 5050/tcp')).toBeTruthy();
    // inspect 가 알려 준 것 — ps 에는 없다.
    expect(screen.getByText(/9090\/tcp/)).toBeTruthy();
  });

  it('열기를 누르면 이 세션이 주인인 터널을 연다 — 로컬 포트는 우리가 고른다', async () => {
    renderSection();
    fireEvent.click(await screen.findByText('gateway'));
    fireEvent.click(screen.getAllByRole('button', { name: '포워딩' })[0]);
    await waitFor(() => expect(openTunnel).toHaveBeenCalled());
    expect(openTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        hostId: 'host-1',
        containerId: 'a1b2c3d4e5f6',
        containerName: 'lime-gateway',
        networkName: '',
        targetPort: 5050,
      }),
    );
    // 어디로 연결할지는 검사 결과에 이미 담겨 왔다 — 다시 묻지 않고 그것을 넘긴다.
    await expect(resolveNetworksOf(openTunnel)()).resolves.toEqual([
      { name: 'bridge', ipAddress: '172.17.0.5' },
    ]);
  });

  it('네트워크를 아직 모르면 그때 한 번 묻고 실어 보낸다', async () => {
    // 방금 만든 컨테이너의 공개 포트는 `ps` 가 검사보다 먼저 준다 — 그 순간에 눌린 경우다.
    query.mockImplementation((_sessionId: string, command: string) => {
      if (command.includes('NetworkSettings')) {
        return Promise.resolve('host=;');
      }
      if (command.includes('stats --no-stream')) {
        // 구분자만 온다 = 검사 결과가 아직 없다.
        return Promise.resolve('@@dolgate@@');
      }
      if (command.includes('ps -a --format')) {
        return Promise.resolve(
          row(['c1d2e3f40506', 'fresh', 'running', 'Up 3 seconds', 'nginx', '0.0.0.0:8080->80/tcp']),
        );
      }
      return Promise.resolve('');
    });
    renderSection({ hostId: 'host-fresh-port' });
    fireEvent.click(await screen.findByText('fresh'));
    fireEvent.click(screen.getAllByRole('button', { name: '포워딩' })[0]);
    await waitFor(() => expect(openTunnel).toHaveBeenCalled());
    expect(openTunnel).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'c1d2e3f40506', targetPort: 80 }),
    );
    await expect(resolveNetworksOf(openTunnel)()).resolves.toEqual([
      { name: 'host', ipAddress: '' },
    ]);
  });

  it('빠르게 두 번 눌러도 한 번만 나간다', async () => {
    renderSection();
    fireEvent.click(await screen.findByText('gateway'));
    const open = screen.getAllByRole('button', { name: '포워딩' })[0];
    fireEvent.click(open);
    fireEvent.click(open);
    // 스토어가 "여는 중" 을 남기므로 두 번째 클릭은 그 자리에서 접힌다(터널이 둘 열리지 않게).
    await waitFor(() => expect(openTunnel).toHaveBeenCalledTimes(2));
  });

  it('열려 있으면 주소와 닫기가 뜨고, 접힌 행에도 포트가 붙는다', async () => {
    Object.assign(storeState, {
      sessionContainerTunnels: {
        'session-1': [
          {
            ruleId: 'container-service-tunnel:1',
            containerId: 'a1b2c3d4e5f6',
            containerName: 'lime-gateway',
            targetPort: 5050,
            bindPort: 12345,
            status: 'running',
          },
        ],
      },
    });
    renderSection();
    // 펼치지 않아도 어디가 열렸는지 보인다.
    expect(await screen.findByText(':12345')).toBeTruthy();

    fireEvent.click(screen.getByText('gateway'));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(closeTunnel).toHaveBeenCalledWith('session-1', 'container-service-tunnel:1');
  });

  it('정지된 컨테이너는 열 수 없다', async () => {
    renderSection();
    fireEvent.click(await screen.findByText('loose'));
    const open = screen.queryAllByRole('button', { name: '포워딩' }) as HTMLButtonElement[];
    expect(open.every((button) => button.disabled)).toBe(true);
  });
});

describe('보던 것을 기억한다', () => {
  it('다른 탭을 보다 돌아와도 펼쳐 둔 행은 그대로다', async () => {
    // 세션 패널은 탭을 옮겨도 같은 컴포넌트를 재사용하고 sessionId 만 갈아끼운다. 그냥
    // useState 로 두면 돌아왔을 때 접혀 있어 다시 찾아 눌러야 한다.
    const view = renderSection();
    fireEvent.click(await screen.findByText('gateway'));
    expect(screen.getByText('5050 → 5050/tcp')).toBeTruthy();

    // 세션 패널이 통째로 다시 그려지는 상황(다른 탭에 갔다 옴).
    view.unmount();
    renderSection();
    expect(await screen.findByText('5050 → 5050/tcp')).toBeTruthy();
  });
});

describe('새로 생긴 컨테이너', () => {
  it('훑는 차례를 기다리지 않고 다음 틱에 검사한다 — 포트·헬스가 몇 분씩 비어 있지 않게', async () => {
    vi.useFakeTimers();
    try {
      const commands: string[] = [];
      let listed = CONTAINERS;
      query.mockImplementation((_sessionId: string, command: string) => {
        commands.push(command);
        if (command.includes('stats --no-stream')) {
          return Promise.resolve(METRICS);
        }
        if (command.includes('ps -a --format')) {
          return Promise.resolve(listed);
        }
        return Promise.resolve('');
      });
      renderSection({ hostId: 'host-fresh-container' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // 첫 틱은 전부 훑는다.
      expect(commands.some((command) => command.includes("inspect 'a1b2c3d4e5f6'"))).toBe(true);

      // host 네트워킹 컨테이너를 하나 띄웠다 — `ps` 는 포트를 주지 않으므로 검사만이 출처다.
      listed = [
        CONTAINERS,
        row(['c1d2e3f40506', 'hostnet-test', 'running', 'Up 5 seconds', 'nginx']),
      ].join('\n');
      commands.length = 0;
      // 5초씩 나눠 흘린다 — 한 번에 30초를 흘리면 목록 왕복이 해소되기 전에 지표 틱이 먼저 돈다.
      for (let step = 0; step < 6; step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
      }
      const inspects = commands.filter((command) => command.includes('inspect '));
      expect(inspects.length).toBeGreaterThan(0);
      expect(inspects[0]).toContain("'c1d2e3f40506'");
      // 이미 아는 것은 다시 묻지 않는다 — 왕복이 커지지 않게.
      expect(inspects[0]).not.toContain("'a1b2c3d4e5f6'");
    } finally {
      vi.useRealTimers();
    }
  });
});
