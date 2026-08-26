// 배관 검증. 판정 로직은 lib/session-panel.test.ts 가 덮으므로, 여기서는 "화면의 버튼을 누르면
// 그 세션의 셸에 정확히 무엇이 나가는가" 만 본다 — 레지스트리는 실물을 쓴다.

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerTerminalHooks,
  unregisterTerminalHooks,
  type TerminalHooks,
} from '../../../lib/terminal-write-registry';
import { setShellHistory } from '../../../lib/shell-history-registry';
import { clearSessionScopedState } from './useSessionScopedState';
import {
  clearHostMetrics,
  getHostMetricsWatch,
  publishHostMetrics,
} from '../../../lib/host-metrics-registry';
import { SessionPanel } from './SessionPanel';
import {
  SESSION_PANEL_MOTION_MS,
  useSessionPanelTargetSessionId,
} from './useSessionPanelTarget';

interface FakeBlock {
  id: number;
  command: string | null;
  commandUnreliable: boolean;
  state: 'running' | 'ok' | 'failed';
  exitCode: number | null;
  durationMs: number | null;
  cwd: string | null;
  startedAt: number;
  marker: { line: number };
}

const blocks: FakeBlock[] = [];

// 이 모듈 자체는 terminal-command-blocks.test.ts 가 덮는다(구독·버전 포함). 여기서는 패널이
// 그 목록을 읽어 그리는지만 보므로 목록만 대신 준다.
vi.mock('../../../lib/terminal-command-blocks', () => ({
  getCommandBlocks: () => blocks,
  getCommandBlocksVersion: () => blocks.length,
  subscribeToCommandBlocks: () => () => undefined,
  // 넣기·실행이 우리가 보낸 원문을 남긴다 — 그 이력이 "화면에서 읽었으니 믿을 수 없다" 로
  // 남지 않게 하는 경로다.
  noteInsertedCommand: (...args: unknown[]) => {
    notedInsertions.push(args as [string, string]);
  },
}));

const dockerQuery = vi.fn<(sessionId: string, command: string) => Promise<string>>(
  () => Promise.resolve(''),
);

const reinjectShellIntegration = vi.fn<(sessionId: string, shell?: string) => Promise<void>>(
  () => Promise.resolve(),
);

// 도커 섹션의 프로브와 통합 재주입만 대신한다 — 나머지 서비스 함수는 실물을 그대로 쓴다.
vi.mock('../../../services/desktop/terminal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryTerminalCompletion: (sessionId: string, command: string) =>
    dockerQuery(sessionId, command),
  reinjectTerminalShellIntegration: (sessionId: string, shell?: string) =>
    reinjectShellIntegration(sessionId, shell),
}));

const storeState: Record<string, unknown> = {};

vi.mock('../../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
  // 훅 밖(서브셸 재주입 판정)에서 설정을 읽는 경로도 있다.
  appStore: { getState: () => storeState },
}));

function block(overrides: Partial<FakeBlock> = {}): FakeBlock {
  return {
    id: 1,
    command: 'ls -la',
    commandUnreliable: false,
    state: 'ok',
    exitCode: 0,
    durationMs: 30,
    cwd: '/srv',
    startedAt: Date.now(),
    marker: { line: 7 },
    ...overrides,
  };
}

const sent: string[] = [];
const notedInsertions: Array<[string, string]> = [];
const scrolled: number[] = [];
let bracketedPaste = true;
let hooks: TerminalHooks;

function setState(overrides: Record<string, unknown> = {}): void {
  Object.assign(storeState, {
    sessionPanelOpen: true,
    sessionPanelWidth: 340,
    sessionPanelSectionBySessionId: { 'session-1': 'history' },
    toggleSessionPanel: vi.fn(),
    setSessionPanelWidth: vi.fn(),
    selectSessionPanelSection: vi.fn(),
    snippets: [],
    saveSnippet: vi.fn().mockResolvedValue({}),
    removeSnippet: vi.fn().mockResolvedValue(undefined),
    openHomeSection: vi.fn(),
    openPortForwardEditor: vi.fn(),
    // AI·자원·프로세스 섹션이 읽는 것들.
    aiConversations: {},
    settings: { aiAssistantEnabled: true, hostMetricsEnabled: true },
    updateSettings: vi.fn(),
    // 포트·테마 섹션이 읽는 것들.
    portForwards: [],
    portForwardRuntimes: [],
    startPortForward: vi.fn().mockResolvedValue(undefined),
    stopPortForward: vi.fn().mockResolvedValue(undefined),
    setHostTerminalTheme: vi.fn().mockResolvedValue(undefined),
    hosts: [],
    clearAiConversation: vi.fn(),
    sendAiMessage: vi.fn(),
    cancelAiMessage: vi.fn(),
    respondAiApproval: vi.fn(),
    openSettingsSection: vi.fn(),
    openExternalUrl: vi.fn(),
    workspaces: [],
    // 도커 섹션이 읽는 것들(세션이 연 컨테이너 터널).
    sessionContainerTunnels: {},
    openSessionContainerTunnel: vi.fn(),
    closeSessionContainerTunnel: vi.fn(),
    tabs: [
      { sessionId: 'session-1', title: 'Prod', paneKind: 'terminal' },
      { sessionId: 'session-2', title: 'Staging', paneKind: 'terminal' },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  // 검색어·필터는 세션 단위로 앱 수명 동안 남는다(모듈 저장소) — 테스트 사이에도 남으므로
  // 여기서 놓는다. 안 그러면 앞 테스트가 친 검색어가 뒤 테스트의 목록을 통째로 걸러 버린다.
  clearSessionScopedState('session-1');
  reinjectShellIntegration.mockClear();
  dockerQuery.mockReset();
  dockerQuery.mockResolvedValue('');
  blocks.length = 0;
  sent.length = 0;
  notedInsertions.length = 0;
  scrolled.length = 0;
  bracketedPaste = true;
  setState();
  hooks = {
    write: vi.fn(),
    refresh: vi.fn(),
    serialize: vi.fn(() => ''),
    getSessionId: () => 'session-1',
    getCellSize: vi.fn(() => null),
    getSelection: vi.fn(() => ''),
    captureRecentText: vi.fn(() => ''),
    captureTextSnapshot: vi.fn(() => []),
    captureShareSnapshot: () => null,
    sendInput: (data: string) => sent.push(data),
    isBracketedPasteEnabled: () => bracketedPaste,
    scrollToLine: (line: number) => scrolled.push(line),
  };
  registerTerminalHooks('pane-1', hooks);
});

afterEach(() => {
  unregisterTerminalHooks('pane-1', hooks);
  clearHostMetrics('session-1');
  setShellHistory('session-1', null);
});

describe('tmux 창의 지표', () => {
  it('첫 pane 이 아닌 pane 에서도 자원 값을 찾는다', () => {
    // 폴링은 창당 한 번만 돌며 **첫 pane 키**로 발행한다(SessionShell). 패널이 포커스된 pane
    // 키로 읽으면 빈 서랍을 열게 되어 `읽는 중` 으로 남았다.
    setState({
      sessionPanelSectionBySessionId: { 'tmux:ctl:1': 'resources' },
      workspaces: [
        {
          id: 'ws-1',
          activeSessionId: 'tmux:ctl:1',
          tmux: { controlSessionId: 'ctl', windowId: '@0' },
          layout: {
            kind: 'split',
            direction: 'row',
            ratio: 0.5,
            first: { kind: 'leaf', sessionId: 'tmux:ctl:0' },
            second: { kind: 'leaf', sessionId: 'tmux:ctl:1' },
          },
        },
      ],
      tabs: [
        { sessionId: 'tmux:ctl:0', title: 'pane 0', paneKind: 'terminal' },
        { sessionId: 'tmux:ctl:1', title: 'pane 1', paneKind: 'terminal' },
      ],
    });
    publishHostMetrics('tmux:ctl:0', {
      status: 'ready',
      metrics: {
        cpuPercent: 42,
        memUsedKb: 1048576,
        memTotalKb: 2097152,
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
        diskReadBytesPerSec: 0,
        diskWriteBytesPerSec: 0,
        loadAvg1: 0.1,
        cpuCount: 2,
        uptimeSeconds: 60,
        disks: [],
      },
      processes: null,
      system: null,
      updatedAtMs: Date.now(),
    });

    render(<SessionPanel sessionId="tmux:ctl:1" />);
    expect(screen.getByText('42%')).toBeTruthy();

    // 관찰 요청도 발행 키에 걸려야 주기가 좁혀진다.
    expect(getHostMetricsWatch('tmux:ctl:0').boosted).toBe(true);
    clearHostMetrics('tmux:ctl:0');
  });
});

describe('SessionPanel', () => {
  it('대상 세션이 없으면 아무것도 남기지 않는다', () => {
    const { container } = render(<SessionPanel sessionId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  // 드래그 중에 세션이 끊겨 패널이 사라지면(대상이 null 이 되면 이 컴포넌트는 그냥 없어진다)
  // mouseup 이 오기 전까지 window 리스너가 남아 폭을 계속 바꿨다.
  it('드래그 중 언마운트되면 폭 리스너가 남지 않는다', () => {
    const setWidth = vi.fn();
    setState({ setSessionPanelWidth: setWidth });
    const { unmount } = render(<SessionPanel sessionId="session-1" />);
    const handle = document.querySelector('[class*="cursor-col-resize"]');
    expect(handle).toBeTruthy();

    fireEvent.mouseDown(handle as Element, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(setWidth).toHaveBeenCalledTimes(1);

    unmount();
    // 언마운트 뒤의 움직임은 폭을 건드리지 못한다.
    fireEvent.mouseMove(window, { clientX: 100 });
    expect(setWidth).toHaveBeenCalledTimes(1);
  });

  it('고른 섹션은 aria-pressed 로 드러난다', () => {
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'snippets' } });
    render(<SessionPanel sessionId="session-1" />);
    expect(
      screen.getByRole('button', { name: '스니펫' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: '히스토리' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  // 패널을 여는 이유가 대개 "이 서버 지금 어때" 다 — 붙은 호스트면 자원부터 보여 준다.
  it('붙은 호스트 세션을 처음 열면 자원을 보여 준다', () => {
    setState({
      sessionPanelSectionBySessionId: {},
      tabs: [
        {
          sessionId: 'session-1',
          title: 'Prod',
          paneKind: 'terminal',
          source: 'host',
        },
      ],
    });
    publishHostMetrics('session-1', {
      status: 'ready',
      metrics: {
        cpuPercent: 42,
        memUsedKb: 1048576,
        memTotalKb: 2097152,
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
        diskReadBytesPerSec: 0,
        diskWriteBytesPerSec: 0,
        loadAvg1: 0.1,
        cpuCount: 2,
        uptimeSeconds: 60,
        disks: [],
      },
      processes: null,
      system: null,
      updatedAtMs: Date.now(),
    });

    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByText('42%')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '자원' }).getAttribute('aria-pressed'),
    ).toBe('true');
    clearHostMetrics('session-1');
  });

  // 로컬 터미널·시리얼은 원격 부하라는 개념이 없다 — 자원을 기본으로 두면 "읽을 수 없습니다"
  // 만 있는 화면으로 시작하고, 켤 방법도 없다. 빈 레일만 보이면 "이게 뭐지" 가 된다.
  it('지표가 없는 세션을 처음 열면 히스토리를 보여 준다', () => {
    setState({
      sessionPanelSectionBySessionId: {},
      tabs: [
        {
          sessionId: 'session-1',
          title: 'Terminal',
          paneKind: 'terminal',
          source: 'local',
        },
      ],
    });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByPlaceholderText('명령 검색')).toBeTruthy();
  });

  // 사용자가 넣은 뒤 직접 엔터를 쳐서 만들어지는 이력이 재실행 가능하려면, 넣는 시점에 원문을
  // 남겨야 한다(대조로 증명한다 — terminal-command-blocks 참고).
  it('넣기·실행은 보낸 원문을 블록 쪽에 남긴다', () => {
    blocks.push(block({ command: 'ls -la' }));
    render(<SessionPanel sessionId="session-1" />);

    fireEvent.click(screen.getByRole('button', { name: '입력줄에 넣기' }));
    expect(notedInsertions).toEqual([['session-1', 'ls -la']]);

    fireEvent.click(screen.getByRole('button', { name: '넣고 실행' }));
    expect(notedInsertions).toHaveLength(2);
  });

  it('한 줄 명령은 넣기·실행이 그 세션의 셸로 나간다', () => {
    blocks.push(block({ command: 'ls -la' }));
    render(<SessionPanel sessionId="session-1" />);

    fireEvent.click(screen.getByRole('button', { name: '넣고 실행' }));
    expect(sent).toEqual(['\x15ls -la\r']);

    fireEvent.click(screen.getByRole('button', { name: '입력줄에 넣기' }));
    expect(sent[1]).toBe('\x15ls -la');
  });

  it('오염된 여러 줄은 복사만 남는다', () => {
    // 화면에서 읽은 값에 보조 프롬프트(`> `)가 섞였다. 실행하면 `cat > test.txt` 처럼 다른
    // 명령이 되고, 넣기도 막는다 — `> ` 가 셸의 연결 프롬프트와 똑같이 보여 알아챌 수 없다.
    blocks.push(
      block({ command: 'cat <<EOF\n> line1\n> EOF', commandUnreliable: true }),
    );
    render(<SessionPanel sessionId="session-1" />);

    expect(
      (screen.getByRole('button', { name: '넣고 실행' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '입력줄에 넣기' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: '복사' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('셸이 프롬프트 폭을 알려준 여러 줄은 괄호 붙여넣기로 넣는다', () => {
    // OSC 133;B;2(bash) 또는 133;E(zsh)가 있으면 오염이 없다.
    blocks.push(block({ command: 'cat <<EOF\nline1\nEOF', commandUnreliable: false }));
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '입력줄에 넣기' }));
    expect(sent).toEqual(['\x15\x1b[200~cat <<EOF\nline1\nEOF\x1b[201~']);
  });

  it('괄호 붙여넣기가 꺼지면 여러 줄은 넣기까지 잠긴다', () => {
    bracketedPaste = false;
    blocks.push(block({ command: 'a\nb', commandUnreliable: true }));
    render(<SessionPanel sessionId="session-1" />);

    expect(
      (screen.getByRole('button', { name: '입력줄에 넣기' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: '복사' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  // 괄호 붙여넣기는 원격이 보낸 이스케이프로 꺼진다(vim 등). xterm 은 모드 변경을 알려 주지
  // 않으므로 패널이 주기적으로 다시 확인한다 — 확인하지 않으면 버튼은 열린 채로 남고, 눌러도
  // 아무 일이 없어 고장으로 읽힌다.
  it('보는 중에 괄호 붙여넣기가 꺼지면 여러 줄 넣기가 잠긴다', () => {
    vi.useFakeTimers();
    try {
      // 오염 없는 여러 줄이라 괄호 붙여넣기가 켜져 있는 동안에는 넣기가 열린다.
      blocks.push(block({ command: 'cat <<EOF\nline1\nEOF', commandUnreliable: false }));
      render(<SessionPanel sessionId="session-1" />);
      expect(
        (screen.getByRole('button', { name: '입력줄에 넣기' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);

      // 전체화면 프로그램이 모드를 끈다.
      bracketedPaste = false;
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(
        (screen.getByRole('button', { name: '입력줄에 넣기' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('실행 중인 명령이 있으면 아무것도 보내지 않는다', () => {
    blocks.push(block({ id: 1, command: 'ls' }), block({ id: 2, command: 'sleep 10', state: 'running' }));
    render(<SessionPanel sessionId="session-1" />);

    for (const button of screen.getAllByRole('button', { name: '넣고 실행' })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('끊긴 세션에서는 복사만 남고 보내는 버튼은 잠긴다', () => {
    // 끊긴 세션의 탭은 그대로 남으므로(최근 세션 복원) 히스토리는 보이지만 보낼 곳이 없다.
    unregisterTerminalHooks('pane-1', hooks);
    blocks.push(block({ command: 'ls -la' }));
    render(<SessionPanel sessionId="session-1" />);

    expect((screen.getByRole('button', { name: '복사' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole('button', { name: '넣고 실행' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '입력줄에 넣기' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('복사하면 잠깐 체크로 바뀐다', async () => {
    // 클립보드는 눈에 보이는 변화가 없다 — 반응이 없으면 복사가 됐는지 알 수 없다.
    blocks.push(block({ command: 'ls -la' }));
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '복사' }));
    expect(await screen.findByRole('button', { name: '복사했습니다' })).toBeTruthy();
  });

  it('행을 누르면 그 명령 위치로 스크롤한다', () => {
    blocks.push(block({ marker: { line: 21 } }));
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '이 명령 위치로 이동' }));
    expect(scrolled).toEqual([21]);
  });

  it('clear 로 위치를 잃은 항목도 목록에 남고, 이동만 없어진다', () => {
    // `clear` 는 스크롤백까지 지워 마커가 사라진다. 그때 기록까지 지우면 히스토리가 통째로
    // 날아간다 — 셸의 history 도 clear 로 지워지지 않는다.
    blocks.push(block({ command: 'before clear', marker: { line: -1 } }));
    render(<SessionPanel sessionId="session-1" />);

    expect(screen.getByText('before clear')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '이 명령 위치로 이동' })).toBeNull();
    // 보내는 동작은 그대로 된다 — 텍스트는 남아 있다.
    fireEvent.click(screen.getByRole('button', { name: '넣고 실행' }));
    expect(sent).toEqual(['\x15before clear\r']);
  });

  // 실패는 색으로 훑어야 한다 — 종료 코드를 딱지로 두고 상태 점을 함께 준다.
  it('실패한 명령은 종료 코드 딱지와 상태 점을 함께 보여 준다', () => {
    blocks.push(
      block({ id: 1, command: 'ls', state: 'ok', exitCode: 0 }),
      block({ id: 2, command: 'make', state: 'failed', exitCode: 2 }),
    );
    render(<SessionPanel sessionId="session-1" />);

    expect(screen.getByText('exit 2')).toBeTruthy();
    // 성공한 줄에는 종료 코드를 적지 않는다(거의 모든 줄이 그렇다).
    expect(screen.queryByText('exit 0')).toBeNull();
  });

  /**
   * 세션 패널은 탭을 옮겨도 같은 컴포넌트를 재사용하고 sessionId 만 갈아끼운다. 검색어를 그냥
   * 들고 있으면 A 에서 친 것이 B 의 목록을 엉뚱하게 걸러 놓는다 — 옮기면 비고, 돌아오면 남는다.
   */
  it('검색어는 세션마다 따로 기억한다', () => {
    blocks.push(
      block({ id: 1, command: 'ls -la' }),
      block({ id: 2, command: 'grep needle /var/log/syslog' }),
    );
    const view = render(<SessionPanel sessionId="session-1" />);
    fireEvent.change(screen.getByPlaceholderText('명령 검색'), {
      target: { value: 'needle' },
    });
    expect(screen.queryByText('ls -la')).toBeNull();

    // 다른 세션으로 옮기면 검색창이 비고 목록이 전부 보인다.
    view.rerender(<SessionPanel sessionId="session-2" />);
    expect((screen.getByPlaceholderText('명령 검색') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('ls -la')).toBeTruthy();

    // 돌아오면 치던 것이 그대로 있다.
    view.rerender(<SessionPanel sessionId="session-1" />);
    expect((screen.getByPlaceholderText('명령 검색') as HTMLInputElement).value).toBe('needle');
    expect(screen.queryByText('ls -la')).toBeNull();

    clearSessionScopedState('session-2');
  });
  it('검색은 목록만 줄인다', () => {
    blocks.push(
      block({ id: 1, command: 'ls -la' }),
      block({ id: 2, command: 'grep needle /var/log/syslog' }),
    );
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.change(screen.getByPlaceholderText('명령 검색'), {
      target: { value: 'needle' },
    });
    expect(screen.queryByText('ls -la')).toBeNull();
    expect(screen.getByText('grep needle /var/log/syslog')).toBeTruthy();
    // 원격에 아무것도 보내지 않는다.
    expect(sent).toEqual([]);
  });

  it('스니펫은 저장된 원문이라 여러 줄도 실행까지 된다', () => {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'snippets' },
      snippets: [
        { id: 's1', label: 'heredoc', command: 'cat <<EOF\nline1\nEOF', keyword: null },
      ],
    });
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '넣고 실행' }));
    expect(sent).toEqual(['\x15cat <<EOF\nline1\nEOF\r']);
  });

  it('변수가 있는 스니펫은 값을 받은 뒤에 보낸다', () => {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'snippets' },
      snippets: [
        { id: 's2', label: 'ssh', command: 'ssh {{user}}@{{host}}', keyword: null },
      ],
    });
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '넣고 실행' }));
    // 값을 받기 전에는 아무것도 나가지 않는다 — 안 그러면 "{{user}}" 가 그대로 셸에 간다.
    expect(sent).toEqual([]);

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: 'root' } });
    fireEvent.change(inputs[1], { target: { value: 'srv1' } });
    fireEvent.click(screen.getByRole('button', { name: '삽입' }));
    expect(sent).toEqual(['\x15ssh root@srv1\r']);
  });
});

// 목록 관리를 패널에서도 한다. 예전에는 여기서 "관리" 버튼으로 홈 화면으로 보내 버려서, 스니펫
// 하나를 만들려면 작업 중인 세션에서 화면이 튀었다.
describe('SessionPanel 스니펫 관리', () => {
  const snippet = {
    id: 's1',
    label: 'Restart web',
    command: 'systemctl restart web',
    keyword: null,
  };

  function renderSnippets(overrides: Record<string, unknown> = {}): void {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'snippets' },
      snippets: [snippet],
      ...overrides,
    });
    render(<SessionPanel sessionId="session-1" />);
  }

  it('편집을 누르면 그 스니펫이 채워진 폼이 열린다', () => {
    renderSnippets();
    fireEvent.click(screen.getByRole('button', { name: '스니펫 편집' }));
    expect(screen.getByText('스니펫 편집')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Snippet label' }) as HTMLInputElement).value,
    ).toBe('Restart web');
  });

  it('스니펫이 없으면 홈으로 보내지 않고 여기서 만든다', () => {
    const openHomeSection = vi.fn();
    renderSnippets({ snippets: [], openHomeSection });
    fireEvent.click(screen.getByRole('button', { name: '스니펫 만들기' }));
    expect(openHomeSection).not.toHaveBeenCalled();
    // 폼 제목이 떴으면 대화상자가 열린 것이다.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  /**
   * 줄에는 삭제가 없어야 한다.
   *
   * 처음에는 줄의 hover 버튼으로 뒀는데 삭제가 줄의 **가장 바깥**이었다 — 마우스가 오른쪽에서
   * 들어올 때 제일 먼저 닿는 자리다. 확인 대화상자를 붙여도 매번 뜨는 확인은 습관적으로 넘긴다.
   * 게다가 다섯 버튼이 좁은 패널의 명령 텍스트를 그만큼 잘라 먹었다.
   */
  it('줄에는 삭제가 없다 — 보내기 셋과 편집만', () => {
    renderSnippets();
    expect(screen.getByRole('button', { name: '스니펫 편집' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '스니펫 삭제' })).toBeNull();
  });

  it('삭제는 편집을 열고, 그 안에서 확인을 거친다', async () => {
    const removeSnippet = vi.fn().mockResolvedValue(undefined);
    renderSnippets({ removeSnippet });

    fireEvent.click(screen.getByRole('button', { name: '스니펫 편집' }));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    // 확인이 뜨기만 하고 아직 지우지 않는다.
    expect(removeSnippet).not.toHaveBeenCalled();
    expect(screen.getByText('이 스니펫을 지웁니다. 되돌릴 수 없습니다.')).toBeTruthy();

    // 확인 대화상자의 삭제(뒤에 그려진 것)를 누른다.
    const confirms = screen.getAllByRole('button', { name: '삭제' });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(removeSnippet).toHaveBeenCalledWith('s1'));
  });

  it('시작 명령으로 쓰는 호스트가 있으면 몇 개가 풀리는지 알려 준다', () => {
    renderSnippets({
      hosts: [
        { id: 'h1', kind: 'ssh', startupCommand: { type: 'snippet', snippetId: 's1' } },
        { id: 'h2', kind: 'ssh', startupCommand: { type: 'snippet', snippetId: 's1' } },
        { id: 'h3', kind: 'ssh', startupCommand: { type: 'command', command: 'htop' } },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: '스니펫 편집' }));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(screen.getByText(/호스트 2개의 시작 명령으로 쓰이고 있습니다/)).toBeTruthy();
  });

  it('쓰는 호스트가 없으면 경고를 띄우지 않는다', () => {
    renderSnippets({ hosts: [] });
    fireEvent.click(screen.getByRole('button', { name: '스니펫 편집' }));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(screen.queryByText(/시작 명령으로 쓰이고 있습니다/)).toBeNull();
  });
});

describe('SessionPanel AI 섹션', () => {
  it('AI 를 패널 섹션으로 그린다', () => {
    // pane 헤더의 AI 버튼을 없애고 여기로 옮겼다 — 세션에 딸린 것을 찾을 데가 한 곳이 된다.
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'ai' } });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByText('AI 어시스턴트')).toBeTruthy();
    // 대화 지우기는 섹션이 자기 헤더를 또 만들지 않게 패널 헤더에 붙인다.
    expect(screen.getByRole('button', { name: '지우기' })).toBeTruthy();
  });
});

// 레이아웃(카드를 좌우로 나눌지)과 패널 본체가 같은 답을 봐야 하므로 그 판정은 훅 하나에 둔다.
describe('useSessionPanelTargetSessionId', () => {
  function target(activeSessionId: string | null) {
    return renderHook(() => useSessionPanelTargetSessionId(activeSessionId)).result.current;
  }

  it('닫혀 있으면 null', () => {
    setState({ sessionPanelOpen: false });
    expect(target('session-1')).toBeNull();
  });

  it('셸이 없는 탭이면 null', () => {
    // RDP·VNC 에는 히스토리도 스니펫도 성립하지 않는다 — 절반이 회색인 레일은 고장으로 읽힌다.
    setState({ tabs: [{ sessionId: 'session-1', title: 'Win', paneKind: 'rdp' }] });
    expect(target('session-1')).toBeNull();
  });

  it('포커스된 세션을 그대로 본다', () => {
    expect(target('session-2')).toBe('session-2');
  });

  it('포커스가 없으면 null', () => {
    expect(target(null)).toBeNull();
  });

  it('닫은 뒤에도 전환 길이만큼 남는다 — 접히는 모습을 그리려면 필요하다', () => {
    vi.useFakeTimers();
    try {
      setState({ sessionPanelOpen: true });
      const view = renderHook(() => useSessionPanelTargetSessionId('session-1'));
      expect(view.result.current).toBe('session-1');

      setState({ sessionPanelOpen: false });
      view.rerender();
      // 곧바로 들어내면 폭이 줄어드는 모습이 보이지 않는다.
      expect(view.result.current).toBe('session-1');

      act(() => {
        vi.advanceTimersByTime(SESSION_PANEL_MOTION_MS);
      });
      expect(view.result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionPanel 관측 섹션', () => {
  it('자원 섹션은 폴링을 새로 돌리지 않고 발행된 값을 읽는다', () => {
    // 패널이 자기 폴링을 돌리면 같은 프로덕션 서버에 두 배로 나간다.
    publishHostMetrics('session-1', {
      status: 'ready',
      metrics: {
        cpuPercent: 42,
        memUsedKb: 1024 * 1024,
        memTotalKb: 2 * 1024 * 1024,
        rxBytesPerSec: 2048,
        txBytesPerSec: null,
        diskReadBytesPerSec: null,
        diskWriteBytesPerSec: null,
        loadAvg1: 0.5,
        cpuCount: 4,
        uptimeSeconds: 3600,
        disks: [{ mount: '/', usedKb: 512, totalKb: 1024, availableKb: 512 }],
      },
      processes: null,
      system: null,
      updatedAtMs: 1,
    });
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'resources' } });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByText('42%')).toBeTruthy();
    // 부하는 CPU 차트 아래 곁가지로 붙는다(라벨 + 값).
    expect(screen.getByText(/0\.50 \/ 4/)).toBeTruthy();
    expect(screen.getByText('/')).toBeTruthy();
  });

  it('자원 섹션을 보는 동안 프로세스는 요청하지 않는다', () => {
    // 프로세스 출력은 크다 — 필요할 때만 왕복에 태운다.
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'resources' } });
    render(<SessionPanel sessionId="session-1" />);
    // 자원 섹션은 프로세스를 요청하지 않고, 정적 정보만 한 번 요청한다(받으면 그다음부터 꺼진다).
    expect(getHostMetricsWatch('session-1')).toEqual({
      boosted: true,
      processes: false,
      system: true,
    });
  });

  it('프로세스 섹션을 열면 그때 프로세스를 요청한다', () => {
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'processes' } });
    const { unmount } = render(<SessionPanel sessionId="session-1" />);
    expect(getHostMetricsWatch('session-1')).toEqual({
      boosted: true,
      processes: true,
      system: false,
    });
    // 닫으면 요청이 풀려 주기가 원래대로 돌아간다.
    unmount();
    expect(getHostMetricsWatch('session-1')).toEqual({
      boosted: false,
      processes: false,
      system: false,
    });
  });

  it('프로세스는 CPU 내림차순이고 검색으로 걸러진다', () => {
    publishHostMetrics('session-1', {
      status: 'ready',
      metrics: null,
      processes: [
        { pid: 2, user: 'root', cpuPercent: 1, memPercent: 9, rssKb: null, command: 'nginx' },
        { pid: 1, user: 'ubuntu', cpuPercent: 80, memPercent: 1, rssKb: null, command: 'node server.js' },
      ],
    system: null,
      updatedAtMs: 1,
    });
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'processes' } });
    render(<SessionPanel sessionId="session-1" />);

    // 명령은 프로그램 이름과 인자로 나뉘어 그려지므로 행 단위로 본다(헤더 행은 뺀다).
    const rows = () => screen.getAllByRole('row').slice(1);
    expect(rows()[0].textContent).toContain('node server.js');
    expect(rows()[1].textContent).toContain('nginx');

    fireEvent.change(screen.getByPlaceholderText('프로세스 검색'), {
      target: { value: 'nginx' },
    });
    const filtered = rows();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].textContent).toContain('nginx');
  });

  // 무엇으로 정렬할지 고르게 하지 않는다 — CPU 내림차순 하나로 두고 두 값을 함께 보여 준다.
  it('프로세스는 표로 CPU·RAM 을 함께 보여 주고 정렬 토글이 없다', () => {
    publishHostMetrics('session-1', {
      status: 'ready',
      metrics: null,
      processes: [
        { pid: 7, user: 'ubuntu', cpuPercent: 12.34, memPercent: 4.56, rssKb: null, command: 'node' },
      ],
    system: null,
      updatedAtMs: 1,
    });
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'processes' } });
    render(<SessionPanel sessionId="session-1" />);

    // 값이 여러 열이라 표로 그린다 — 열 이름이 있어야 어느 숫자가 무엇인지 알 수 있다.
    expect(screen.getByRole('columnheader', { name: 'CPU' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'RAM' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'PID' })).toBeTruthy();
    const row = screen.getByRole('row', { name: /node/ });
    expect(row.textContent).toContain('12.3%');
    expect(row.textContent).toContain('4.6%');
    expect(row.textContent).toContain('7');
    // 정렬을 고르게 하지 않는다.
    expect(screen.queryByRole('button', { name: 'CPU' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'MEM' })).toBeNull();
  });

  it('프로세스 섹션에는 종료 버튼이 없다', () => {
    // 모니터링만 한다 — 조작은 터미널에서 하는 편이 예측 가능하다.
    publishHostMetrics('session-1', {
      status: 'ready',
      metrics: null,
      processes: [
        { pid: 1, user: 'root', cpuPercent: 1, memPercent: 1, rssKb: null, command: 'nginx' },
      ],
    system: null,
      updatedAtMs: 1,
    });
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'processes' } });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.queryByRole('button', { name: /종료|kill/i })).toBeNull();
  });

  it('호스트 지표를 꺼 두면 켜기 버튼을 보여 준다', () => {
    // 몰래 켜지 않되 죽은 화면으로 두지도 않는다.
    setState({
      settings: { aiAssistantEnabled: true, hostMetricsEnabled: false },
      sessionPanelSectionBySessionId: { 'session-1': 'resources' },
    });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByRole('button', { name: '켜기' })).toBeTruthy();
  });
});

describe('SessionPanel 포트 포워딩 섹션', () => {
  const rule = {
    id: 'rule-1',
    label: 'db tunnel',
    hostId: 'host-1',
    transport: 'ssh',
    mode: 'local',
    bindAddress: '127.0.0.1',
    bindPort: 15432,
    targetHost: 'db.internal',
    targetPort: 5432,
    createdAt: '',
    updatedAt: '',
  };

  it('이 호스트의 규칙만 보여 준다', () => {
    // 패널의 유일한 규칙 — 지금 포커스된 세션의 호스트에 대한 것만 담는다.
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule, { ...rule, id: 'rule-2', hostId: 'host-2', bindPort: 19999 }],
      portForwardRuntimes: [
        { ruleId: 'rule-1', hostId: 'host-1', status: 'running', bindAddress: '127.0.0.1', bindPort: 15432, transport: 'ssh', updatedAt: '' },
      ],
    });
    render(<SessionPanel sessionId="session-1" />);
    // 라벨이 제목이고 주소는 매핑 줄에서 본다(기존 포트 화면과 같은 순서).
    expect(screen.getByText('db tunnel')).toBeTruthy();
    expect(screen.getByText('127.0.0.1:15432 → db.internal:5432')).toBeTruthy();
    expect(screen.queryByText(/19999/)).toBeNull();
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('실패한 규칙은 이유까지 보여 준다', () => {
    // 상태만 보면 왜 안 되는지 알 수 없다.
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule],
      portForwardRuntimes: [
        { ruleId: 'rule-1', hostId: 'host-1', status: 'error', message: 'bind: address in use', bindAddress: '127.0.0.1', bindPort: 15432, transport: 'ssh', updatedAt: '' },
      ],
    });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByText('bind: address in use')).toBeTruthy();
  });

  it('멈춰 있으면 시작을, 돌고 있으면 정지를 낸다', () => {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule],
      portForwardRuntimes: [],
    });
    const { unmount } = render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '시작' }));
    expect(storeState.startPortForward).toHaveBeenCalledWith('rule-1');
    unmount();

    // setState 는 기본값을 다시 깔므로 필요한 것을 전부 넘긴다.
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule],
      portForwardRuntimes: [
        { ruleId: 'rule-1', hostId: 'host-1', status: 'running', bindAddress: '127.0.0.1', bindPort: 15432, transport: 'ssh', updatedAt: '' },
      ],
    });
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '정지' }));
    expect(storeState.stopPortForward).toHaveBeenCalledWith('rule-1');
  });

  it('시작 중에도 정지를 남긴다', () => {
    // OTP 를 묻는 호스트면 몇십 초 걸린다 — 접을 방법이 없으면 화면이 굳은 것처럼 보인다.
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule],
      portForwardRuntimes: [
        { ruleId: 'rule-1', hostId: 'host-1', status: 'starting', bindAddress: '127.0.0.1', bindPort: 15432, transport: 'ssh', updatedAt: '' },
      ],
    });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByRole('button', { name: '정지' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '시작' })).toBeNull();
  });

  // 편집은 화면을 옮기지 않는다 — 스토어에 의도만 넣고, 모달은 AppModals 의 인스턴스가 그린다.
  // 이 구분이 이 섹션의 요점이다: 포트 하나 고치려고 작업 중인 터미널을 떠나면 안 된다.
  it('규칙 편집은 화면을 옮기지 않고 편집기 의도만 넣는다', () => {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule],
      portForwardRuntimes: [],
    });
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '편집' }));
    expect(storeState.openPortForwardEditor).toHaveBeenCalledWith({
      kind: 'edit',
      ruleId: 'rule-1',
    });
    expect(storeState.openHomeSection).not.toHaveBeenCalled();
  });

  // 규칙이 있을 때도 추가할 수 있어야 한다. 빈 상태에만 두면 규칙이 하나 생기는 순간 추가할
  // 방법이 사라진다. 그 세션의 호스트로 열려야 하므로 hostId 도 함께 확인한다.
  it('규칙이 있어도 추가할 수 있고, 그 세션의 호스트로 열린다', () => {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule],
      portForwardRuntimes: [],
    });
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '규칙 추가' }));
    expect(storeState.openPortForwardEditor).toHaveBeenCalledWith({
      kind: 'create',
      transport: 'ssh',
      hostId: 'host-1',
    });
    // 이 섹션에서 화면을 옮기는 버튼은 이제 없다.
    expect(storeState.openHomeSection).not.toHaveBeenCalled();
  });
});

describe('SessionPanel 테마 섹션', () => {
  function withHost(terminalThemeId: string | null) {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'theme' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      hosts: [{ id: 'host-1', kind: 'ssh', label: 'Prod', terminalThemeId }],
      settings: {
        aiAssistantEnabled: true,
        hostMetricsEnabled: true,
        globalTerminalThemeId: 'system',
      },
    });
  }

  it('호스트에 저장된 테마를 고른 것으로 표시한다', () => {
    // 값은 호스트 레코드 하나에만 있다 — 패널이 따로 들지 않는다.
    withHost('kanagawa-wave');
    render(<SessionPanel sessionId="session-1" />);
    expect(
      screen.getByRole('button', { name: /Kanagawa Wave/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /앱 설정 따르기/ }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('고르면 그 호스트의 테마만 바꾼다', () => {
    withHost(null);
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Kanagawa Wave/ }));
    expect(storeState.setHostTerminalTheme).toHaveBeenCalledWith('host-1', 'kanagawa-wave');
  });

  it('저장이 실패하면 이유를 보여 준다', async () => {
    // 예전에는 `void` 로 던져 버려서 아무 반응이 없었다 — 그러면 "안 된다" 와 "실패했다" 를
    // 구분할 수 없다.
    withHost(null);
    (storeState.setHostTerminalTheme as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No handler registered'),
    );
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Kanagawa Wave/ }));
    expect(
      await screen.findByText(/테마를 저장하지 못했습니다: No handler registered/),
    ).toBeTruthy();
  });

  // 글꼴·크기는 한 번 맞추면 끝인 값이라 접어 둔다. 펼친 채로 두면 테마 목록이 그만큼
  // 아래로 밀린다.
  it('글꼴 항목은 접혀 있고, 머리글을 눌러야 열린다', () => {
    withHost(null);
    render(<SessionPanel sessionId="session-1" />);
    // 접혀 있어도 지금 크기는 머리글에 보인다.
    expect(screen.getByText(/13px/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Increase Font Size' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /13px/ }));
    expect(screen.getByRole('button', { name: 'Increase Font Size' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /13px/ }));
    expect(screen.queryByRole('button', { name: 'Increase Font Size' })).toBeNull();
  });

  it('같은 것을 다시 눌러도 저장하지 않는다', () => {
    withHost('kanagawa-wave');
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Kanagawa Wave/ }));
    expect(storeState.setHostTerminalTheme).not.toHaveBeenCalled();
  });
});

describe('SessionPanel 히스토리 — 이전 명령', () => {
  it('셸 히스토리를 같은 목록 아래에 이어 붙인다', () => {
    // 연결 시점 스냅샷이라 이번 세션 것과 겹치지 않는다 — 중복 걱정 없이 이어 붙인다.
    blocks.push(block({ command: 'ls -la' }));
    setShellHistory('session-1', ['docker ps', 'pwd']);
    render(<SessionPanel sessionId="session-1" />);

    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(screen.getByText('이전 명령')).toBeTruthy();
    expect(screen.getByText('pwd')).toBeTruthy();
    expect(screen.getByText('docker ps')).toBeTruthy();
  });

  // 파일에는 같은 명령이 사이사이 섞여 수십 번 나온다 — 그대로 늘어놓으면 목록이 그 반복으로
  // 채워진다. 한 줄로 접고 몇 번인지만 적는다.
  it('같은 명령은 한 줄로 접고 몇 번인지 적는다', () => {
    setShellHistory('session-1', ['ls', 'pwd', 'ls', 'clear', 'ls']);
    render(<SessionPanel sessionId="session-1" />);

    expect(screen.getAllByText('ls')).toHaveLength(1);
    expect(screen.getByText('×3')).toBeTruthy();
    // 한 번만 친 명령에는 숫자를 붙이지 않는다.
    expect(screen.queryByText('×1')).toBeNull();
  });

  it('이전 명령도 실행까지 된다 — 셸이 기록한 원문이다', () => {
    setShellHistory('session-1', ['docker ps']);
    render(<SessionPanel sessionId="session-1" />);
    const runButtons = screen.getAllByRole('button', { name: '넣고 실행' });
    fireEvent.click(runButtons[runButtons.length - 1]);
    expect(sent).toEqual(['\x15docker ps\r']);
  });

  it('검색은 두 갈래를 함께 훑는다', () => {
    blocks.push(block({ command: 'ls -la' }));
    setShellHistory('session-1', ['docker ps']);
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.change(screen.getByPlaceholderText('명령 검색'), {
      target: { value: 'docker' },
    });
    expect(screen.queryByText('ls -la')).toBeNull();
    expect(screen.getByText('docker ps')).toBeTruthy();
  });

  it('실패만 보기에서는 이전 명령을 감춘다', () => {
    // 히스토리 파일에는 종료 코드가 없어 "실패" 로 걸러낼 수가 없다.
    blocks.push(block({ command: 'boom', state: 'failed', exitCode: 1 }));
    setShellHistory('session-1', ['docker ps']);
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '실패한 명령만' }));
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.queryByText('이전 명령')).toBeNull();
    expect(screen.queryByText('docker ps')).toBeNull();
  });

  it('이번 세션 것이 없어도 이전 명령만으로 목록이 선다', () => {
    setShellHistory('session-1', ['docker ps']);
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.queryByText('아직 없습니다')).toBeNull();
    expect(screen.getByText('docker ps')).toBeTruthy();
  });
});

// 도커 섹션은 **늘 레일에 있다.** 다른 섹션과 다르게 취급하지 않는다 — 안 되는 호스트에서는
// 자리를 없애는 대신 섹션 안에서 이유를 말한다.
describe('도커 섹션', () => {
  it('레일에는 늘 있고, 열기 전에는 왕복을 쓰지 않는다', () => {
    setState({
      tabs: [{ sessionId: 'session-3', title: 'Nodocker', paneKind: 'terminal' }],
    });
    render(<SessionPanel sessionId="session-3" />);
    expect(screen.getByRole('button', { name: '도커' })).toBeTruthy();
    // 다른 섹션을 보는 동안에는 도커를 찾아보지 않는다.
    expect(dockerQuery).not.toHaveBeenCalled();
  });

  it('열었을 때 못 부르면 그 자리에서 이유를 말한다', async () => {
    // 도커가 없는 호스트도 이유 한 줄은 낸다 — 빈 출력은 "대답 없음" 으로 따로 다룬다.
    dockerQuery.mockResolvedValue('why=sh: 1: docker: not found\n');
    setState({
      tabs: [{ sessionId: 'session-4', title: 'Nodocker', paneKind: 'terminal' }],
      sessionPanelSectionBySessionId: { 'session-4': 'docker' },
    });
    render(<SessionPanel sessionId="session-4" />);
    await waitFor(() => {
      expect(dockerQuery).toHaveBeenCalled();
    });
    // 보조 채널은 로그인 셸이 아니라 PATH 를 넓혀 물어본다(snap·/usr/local 의 도커).
    expect(dockerQuery.mock.calls[0][1]).toContain('/snap/bin');
    expect(await screen.findByText('도커가 없습니다')).toBeTruthy();
    expect(screen.getByRole('button', { name: '도커' })).toBeTruthy();
  });

  it('부를 수 있으면 목록을 받고, 헤더에 새로 받기가 붙는다', async () => {
    dockerQuery.mockImplementation((_sessionId: string, command: string) =>
      Promise.resolve(command.includes('for c in') ? 'prefix=docker\nhas=docker\n' : ''),
    );
    setState({ sessionPanelSectionBySessionId: { 'session-2': 'docker' } });
    render(<SessionPanel sessionId="session-2" />);
    expect(
      (await screen.findByRole('button', { name: '도커' })).getAttribute('aria-pressed'),
    ).toBe('true');
    // 섹션이 자기 헤더를 또 만들지 않는다 — 새로고침은 패널 헤더의 섹션 동작 자리에 있다.
    expect(screen.getByRole('button', { name: '새로 받기' })).toBeTruthy();
    await waitFor(() => {
      expect(
        dockerQuery.mock.calls.some(([, command]) => command.includes('ps -a --format')),
      ).toBe(true);
    });
  });
});

// 패널이 보낸 명령은 xterm 의 onData 를 타지 않는다 — 서브셸 판정을 거기서만 하면 패널로
// 컨테이너에 들어갔을 때 통합이 안 붙어 명령 상태가 회색으로 굳는다.
describe('패널이 보낸 명령의 서브셸 진입', () => {
  it('서브셸로 들어가는 명령이면 셸 통합을 다시 넣는다', () => {
    blocks.push(block({ command: "docker exec -it 'web' bash" }));
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '넣고 실행' }));
    expect(reinjectShellIntegration).toHaveBeenCalledWith('session-1', 'bash');
  });

  it('평범한 명령에는 손대지 않는다', () => {
    blocks.push(block({ command: 'ls -la' }));
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '넣고 실행' }));
    expect(reinjectShellIntegration).not.toHaveBeenCalled();
  });
});
