// 하단바 두 개(감지 바·세션 푸터)가 하던 일을 이 섹션이 받았다. 그래서 여기서 보는 것은
// "누르면 원격에 정확히 무엇이 나가는가" 다 — 예전 TerminalTmuxBar 테스트가 보던 지점이다.

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanelTmux } from './SessionPanelTmux';

const connectHost = vi.fn();
const killTmuxSession = vi.fn();
const detachTmuxWorkspace = vi.fn();
const refreshTmuxSessions = vi.fn();

const storeState: Record<string, unknown> = {};

vi.mock('../../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

vi.mock('../../../services/desktop/terminal', () => ({
  refreshTmuxSessions: (sessionId: string) => refreshTmuxSessions(sessionId),
}));

function setState(overrides: Record<string, unknown> = {}): void {
  Object.assign(storeState, {
    connectHost,
    killTmuxSession,
    detachTmuxWorkspace,
    tabs: [
      {
        sessionId: 'session-1',
        hostId: 'host-1',
        tmuxAvailable: {
          version: '3.4',
          sessions: [
            { name: 'work', windows: 3, attached: false },
            { name: 'logs', windows: 1, attached: true },
          ],
        },
      },
    ],
    tmuxGroups: [],
    workspaces: [],
    ...overrides,
  });
}

beforeEach(() => {
  connectHost.mockClear();
  killTmuxSession.mockClear();
  detachTmuxWorkspace.mockClear();
  refreshTmuxSessions.mockClear();
  for (const key of Object.keys(storeState)) {
    delete storeState[key];
  }
  setState();
});

describe('감지만 된 상태', () => {
  it('버전은 목록 머리에 붙고 세션이 목록으로 펼쳐진다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    expect(screen.getByText('tmux 3.4')).toBeTruthy();
    expect(screen.getByText('work')).toBeTruthy();
    expect(screen.getByText('창 3개')).toBeTruthy();
  });

  it('세션을 고르면 새 탭에서 control mode 로 attach 한다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'work 세션으로' }));
    expect(connectHost).toHaveBeenCalledWith(
      'host-1',
      120,
      32,
      undefined,
      true,
      "tmux -CC attach -t 'work'",
      // 탭 자리를 재사용하지 않는다 — 보고 있던 셸을 닫지 않고 새 탭에서 연다.
      undefined,
      undefined,
      '3.4',
      // control mode 경로에는 startup 명령 덮어쓰기가 없다(passthrough 전용).
      undefined,
    );
  });

  it('새 세션은 strict new 로 만든다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.change(screen.getByPlaceholderText('새 세션 이름'), {
      target: { value: 'deploy' },
    });
    fireEvent.click(screen.getByText('만들기'));
    expect(connectHost).toHaveBeenCalledWith(
      'host-1',
      120,
      32,
      undefined,
      true,
      "tmux -CC new-session -s 'deploy'",
      undefined,
      undefined,
      '3.4',
      // control mode 경로에는 startup 명령 덮어쓰기가 없다(passthrough 전용).
      undefined,
    );
  });

  it('이름에 따옴표가 있어도 셸에 그대로 나가지 않는다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.change(screen.getByPlaceholderText('새 세션 이름'), {
      target: { value: "it's" },
    });
    fireEvent.click(screen.getByText('만들기'));
    expect(connectHost.mock.calls[0][5]).toBe("tmux -CC new-session -s 'it'\\''s'");
  });

  it('세션 종료는 attach 없이 이 세션을 통해 보낸다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.click(screen.getAllByRole('button', { name: '세션 종료' })[0]);
    expect(killTmuxSession).toHaveBeenCalledWith('session-1', 'work');
  });

  it('다른 클라이언트가 쓰고 있는 세션을 표시한다', () => {
    // tmux 는 한 세션에 클라이언트 여럿이 붙을 수 있고 그때 창 크기가 가장 작은 쪽에 맞춰진다
    // — 들어가기 전에 알려 준다.
    render(<SessionPanelTmux sessionId="session-1" />);
    expect(screen.getByText('다른 곳에서 사용 중')).toBeTruthy();
  });

  it('control mode 를 못 쓰는 버전에서만 열기를 남긴다', () => {
    setState({
      tabs: [
        {
          sessionId: 'session-1',
          hostId: 'host-1',
          tmuxAvailable: { version: '2.3', sessions: [] },
        },
      ],
    });
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.click(screen.getByText('열기'));
    // tmux=false + 시작 명령 자동 입력(passthrough) — 구버전의 유일한 진입점이다.
    expect(connectHost).toHaveBeenCalledWith(
      'host-1',
      120,
      32,
      undefined,
      false,
      undefined,
      'session-1',
      undefined,
      undefined,
      'tmux attach 2>/dev/null || tmux new',
    );
  });
});

describe('붙어 있는 상태', () => {
  beforeEach(() => {
    setState({
      tabs: [{ sessionId: 'session-1', hostId: 'host-1' }],
      workspaces: [
        {
          id: 'ws-1',
          layout: { kind: 'leaf', sessionId: 'session-1' },
          activeSessionId: 'session-1',
          tmux: { controlSessionId: 'ctl-1', windowId: '@1' },
        },
      ],
      tmuxGroups: [
        {
          id: 'grp-1',
          controlSessionId: 'ctl-1',
          sessionName: 'work',
          activeWorkspaceId: 'ws-1',
          hostId: 'host-1',
          tmuxVersion: '3.4',
          sessions: [
            { name: 'work', windows: 3, attached: true },
            { name: 'logs', windows: 1, attached: false },
          ],
        },
      ],
    });
  });

  it('지금 보고 있는 세션을 표시하고 그 행은 누를 수 없다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    // 붙어 있는 세션에는 "현재 화면" 딱지가 붙는다.
    expect(screen.getByText('현재 화면')).toBeTruthy();
    // 전환할 수 있는 행은 다른 세션(logs)뿐이다.
    expect(screen.getByRole('button', { name: 'logs 세션으로' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'work 세션으로' })).toBeNull();
  });

  it('다른 세션으로 전환하면 현재 tmux 를 살린 채 새 탭으로 붙는다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'logs 세션으로' }));
    expect(connectHost).toHaveBeenCalledWith(
      'host-1',
      120,
      32,
      undefined,
      true,
      "tmux -CC attach -t 'logs'",
      // 탭 자리를 재사용하지 않는다 — 지금 붙어 있는 세션이 닫히면 안 된다.
      undefined,
      undefined,
      '3.4',
      // control mode 경로에는 startup 명령 덮어쓰기가 없다(passthrough 전용).
      undefined,
    );
  });

  it('detach 는 이 워크스페이스만 뗀다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'detach' }));
    expect(detachTmuxWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('목록 새로고침은 이 세션으로 재조회한다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
    expect(refreshTmuxSessions).toHaveBeenCalledWith('session-1');
  });

  // 요청이 실패해도 처리되지 않은 rejection 을 남기지 않는다. 렌더러에는 전역
  // `unhandledrejection` 핸들러가 없어서, 안 잡으면 콘솔에 그대로 올라온다.
  it('새로고침이 실패해도 rejection 을 남기지 않고 표시를 되돌린다', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    // jsdom 은 window 로 `unhandledrejection` 을 던지지 않는다 — 노드가 판정하므로 process 에서
    // 듣는다(그렇게 안 하면 이 시험은 잡지 않아도 통과한다).
    process.on('unhandledRejection', onUnhandled);
    refreshTmuxSessions.mockImplementationOnce(() =>
      Promise.reject(new Error('IPC 실패')),
    );
    try {
      render(<SessionPanelTmux sessionId="session-1" />);
      const button = screen.getByRole('button', { name: '목록 새로고침' });
      fireEvent.click(button);
      // 노드는 마이크로태스크 큐가 빈 뒤에 판정한다 — 매크로태스크 한 번을 지나야 보인다.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // 새로고침은 목록을 이벤트로 받으므로 "끝났다" 를 알 수 없다. 최소한 눌렀다는 표시는
  // 있어야 한다 — 예전에는 눌러도 아무 변화가 없어서 고장과 구분되지 않았다.
  it('새로고침을 누르면 도는 표시가 남는다', () => {
    render(<SessionPanelTmux sessionId="session-1" />);
    const button = screen.getByRole('button', { name: '목록 새로고침' });
    fireEvent.click(button);
    expect(button.querySelector('.animate-spin')).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

// attach 전 감지 상태(control 채널이 없다). 예전에는 이 상태에서 새로고침이 control 명령으로
// 나가 조용히 무시됐다 — 목록은 접속 시 스냅샷에 멈춰 있었다.
describe('감지 상태의 새로고침', () => {
  it('control 세션이 없어도 같은 경로로 재조회를 요청한다', () => {
    setState({
      tabs: [
        {
          sessionId: 'session-plain',
          hostId: 'host-1',
          tmuxAvailable: { version: '3.4', sessions: ['work'] },
        },
      ],
      tmuxWorkspaces: [],
    });
    render(<SessionPanelTmux sessionId="session-plain" />);
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
    expect(refreshTmuxSessions).toHaveBeenCalledWith('session-plain');
  });
});

describe('쓸 수 없을 때', () => {
  it('호스트가 없으면 그렇게 말한다', () => {
    setState({ tabs: [{ sessionId: 'session-1', hostId: null }] });
    render(<SessionPanelTmux sessionId="session-1" />);
    expect(screen.getByText('이 세션에는 호스트가 없어 tmux 를 다룰 수 없습니다.')).toBeTruthy();
  });

  it('감지되지 않았으면 그렇게 말한다', () => {
    setState({ tabs: [{ sessionId: 'session-1', hostId: 'host-1' }] });
    render(<SessionPanelTmux sessionId="session-1" />);
    expect(screen.getByText('이 호스트에서 tmux 를 찾지 못했습니다.')).toBeTruthy();
  });
});
