// 배관 검증. 명령 문자열과 파싱은 lib/docker.test.ts 가 덮으므로, 여기서는 "화면에서 누르면
// 어디로 무엇이 나가는가" 만 본다 — 읽기는 보조 채널, 셸·로그는 새 탭, 상태 변경은 지금
// 터미널, 파괴적인 것은 넣기만.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanelDocker } from './SessionPanelDocker';
import { requestDockerRefresh } from './useSessionDocker';
import type { SessionPanelSender } from './useSessionPanelTarget';

const connectHost = vi.fn();
const query = vi.fn();

const storeState: Record<string, unknown> = {};

vi.mock('../../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

vi.mock('../../../services/desktop/terminal', () => ({
  queryTerminalCompletion: (sessionId: string, command: string) => query(sessionId, command),
}));

function row(cells: string[]): string {
  return [...cells, ...Array.from({ length: 9 - cells.length }, () => '')].join('\t');
}

const CONTAINERS = [
  row(['a1b2c3d4e5f6', 'lime-gateway', 'running', 'Up 22 hours (healthy)', 'app:1', '0.0.0.0:5050->5050/tcp', 'lime', 'gateway', '/srv/lime']),
  row(['a2b3c4d5e6f7', 'lime-bid', 'running', 'Up 22 hours', 'app:1', '', 'lime', 'bid', '/srv/lime']),
  row(['b1c2d3e4f506', 'loose', 'exited', 'Exited (137) 3 days ago', 'redis:7']),
].join('\n');

/** 한 왕복이 돌려주는 것: 목록 · 지표 · 검사(구분자로 갈라 온다). */
const SNAPSHOT = [
  CONTAINERS,
  '@@dolgate@@',
  ['a1b2c3d4e5f6\t12.40%\t412MiB / 15.6GiB\t2.58%\t1.2GB / 340MB\t0B / 4.1MB\t18',
   'a2b3c4d5e6f7\t0.30%\t96MiB / 15.6GiB\t0.60%\t2MB / 1MB\t0B / 0B\t7'].join('\n'),
  '@@dolgate@@',
  [
    `a1b2c3d4e5f6${'0'.repeat(52)}\t0\thealthy\tfalse`,
    `a2b3c4d5e6f7${'0'.repeat(52)}\t14\t\tfalse`,
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
      runtime={{ availability: 'available', prefix: 'docker' }}
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
  connectHost.mockReset();
  query.mockReset();
  Object.assign(storeState, { connectHost, sessionPanelOpen: true });
  respond({ 'ps -a --format': SNAPSHOT });
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

  it('셸은 새 탭에서 열고 지금 셸을 건드리지 않는다', async () => {
    const { sender: senderStub } = renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '셸 접속 gateway' }));
    expect(connectHost).toHaveBeenCalledTimes(1);
    const args = connectHost.mock.calls[0];
    expect(args[0]).toBe('host-1');
    expect(args[9]).toContain("docker exec -it 'lime-gateway'");
    expect(senderStub.run).not.toHaveBeenCalled();
  });

  it('호스트가 없는 로컬 터미널에서는 지금 셸에서 그대로 실행한다', async () => {
    const { sender: senderStub } = renderSection({ hostId: null });
    fireEvent.click(await screen.findByRole('button', { name: '셸 접속 gateway' }));
    expect(connectHost).not.toHaveBeenCalled();
    expect(senderStub.run).toHaveBeenCalledWith(
      expect.stringContaining("docker exec -it 'lime-gateway'"),
    );
  });

  it('정지된 컨테이너는 셸이 꺼지고 로그는 따라가지 않는다', async () => {
    renderSection();
    await screen.findByText('loose');
    expect(
      (screen.getByRole('button', { name: '셸 접속 loose' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '셸 접속 gateway' }) as HTMLButtonElement).disabled,
    ).toBe(false);
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
    expect((screen.getByRole('button', { name: '재시작' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // 셸·로그는 새 탭이라 프롬프트와 무관하게 된다.
    expect((screen.getByRole('button', { name: '로그' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
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
    expect(senderStub.insert).toHaveBeenCalledWith(
      "docker compose --project-directory '/srv/lime' down",
    );
  });

  it('행을 누르면 이미 받아 온 값으로 상세를 펼친다(왕복 없음)', async () => {
    renderSection();
    const before = query.mock.calls.length;
    fireEvent.click(await screen.findByText('gateway'));
    expect(screen.getByText('0.0.0.0:5050->5050/tcp')).toBeTruthy();
    expect(screen.getByText('lime-gateway')).toBeTruthy();
    // 지표도 같은 왕복에서 온 것이다.
    expect(screen.getByText(/↓1\.2GB ↑340MB/)).toBeTruthy();
    expect(query.mock.calls.length).toBe(before);
  });

  it('행에 CPU·MEM 이 뜨고 머리에 합계가 뜬다', async () => {
    renderSection();
    await screen.findByText('gateway');
    expect(screen.getByText('12.4%')).toBeTruthy();
    expect(screen.getByText('412 MiB')).toBeTruthy();
    // 2/3 실행 · CPU 합 12.7% · MEM 합
    expect(screen.getByText(/2\/3 실행/)).toBeTruthy();
    expect(screen.getByText(/CPU/)).toBeTruthy();
  });

  it('재시작이 잦은 컨테이너는 행에서 바로 드러난다', async () => {
    renderSection();
    await screen.findByText('bid');
    expect(screen.getByText('재시작 14회')).toBeTruthy();
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
  it('이미지 탭은 총량을 system df 에서 받고 미사용을 표시한다', async () => {
    respond({
      'ps -a --format': SNAPSHOT,
      'images --format': [
        'app\t1\tsha1\t412MB',
        'old\t2\tsha2\t1.1GB',
        '@@dolgate@@',
        'Images\t24\t15\t8.4GB\t2.1GB (25%)',
      ].join('\n'),
    });
    renderSection();
    await screen.findByText('gateway');
    fireEvent.click(screen.getByRole('button', { name: /이미지/ }));
    expect(await screen.findByText(/8\.4GB/)).toBeTruthy();
    // app:1 은 컨테이너가 쓰고 있으니 미사용이 아니다 — old 하나만 붙는다.
    expect(screen.getAllByText('미사용')).toHaveLength(1);
  });

  it('볼륨 탭은 목록을 먼저 그리고 크기는 뒤에서 재 온다', async () => {
    respond({
      // 볼륨 명령도 뒤에 ps 를 달고 있으므로 더 좁은 조각을 먼저 둔다.
      'volume ls': ['pgdata\tlocal', '@@dolgate@@', 'pgdata'].join('\n'),
      'system df -v': [
        'Local Volumes space usage:',
        'VOLUME NAME   LINKS     SIZE',
        'pgdata        1         3.6GB',
      ].join('\n'),
      'ps -a --format': SNAPSHOT,
    });
    renderSection();
    await screen.findByText('gateway');
    fireEvent.click(screen.getByRole('button', { name: /볼륨/ }));
    expect(await screen.findByText('pgdata')).toBeTruthy();
    expect(await screen.findByText('3.6GB')).toBeTruthy();
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
        runtime={{ availability: 'blocked', prefix: null }}
      />,
    );
    expect(screen.getByText('도커를 읽을 수 없습니다')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
