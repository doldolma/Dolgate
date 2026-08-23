// 배관 검증. 판정 로직은 lib/session-panel.test.ts 가 덮으므로, 여기서는 "화면의 버튼을 누르면
// 그 세션의 셸에 정확히 무엇이 나가는가" 만 본다 — 레지스트리는 실물을 쓴다.

import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerTerminalHooks,
  unregisterTerminalHooks,
  type TerminalHooks,
} from '../../../lib/terminal-write-registry';
import { setShellHistory } from '../../../lib/shell-history-registry';
import {
  clearHostMetrics,
  getHostMetricsWatch,
  publishHostMetrics,
} from '../../../lib/host-metrics-registry';
import { SessionPanel } from './SessionPanel';
import { useSessionPanelTargetSessionId } from './useSessionPanelTarget';

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
}));

const storeState: Record<string, unknown> = {};

vi.mock('../../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
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
    openHomeSection: vi.fn(),
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
    tabs: [
      { sessionId: 'session-1', title: 'Prod', paneKind: 'terminal' },
      { sessionId: 'session-2', title: 'Staging', paneKind: 'terminal' },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  blocks.length = 0;
  sent.length = 0;
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

describe('SessionPanel', () => {
  it('대상 세션이 없으면 아무것도 남기지 않는다', () => {
    const { container } = render(<SessionPanel sessionId={null} />);
    expect(container).toBeEmptyDOMElement();
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

  it('섹션을 처음 열면 히스토리를 보여 준다', () => {
    // 빈 레일만 보이면 "이게 뭐지" 가 된다.
    setState({ sessionPanelSectionBySessionId: {} });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByPlaceholderText('명령 검색')).toBeTruthy();
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
        disks: [{ mount: '/', usedKb: 512, totalKb: 1024 }],
      },
      processes: null,
      updatedAtMs: 1,
    });
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'resources' } });
    render(<SessionPanel sessionId="session-1" />);
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('0.50 / 4')).toBeTruthy();
    expect(screen.getByText('/')).toBeTruthy();
  });

  it('자원 섹션을 보는 동안 프로세스는 요청하지 않는다', () => {
    // 프로세스 출력은 크다 — 필요할 때만 왕복에 태운다.
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'resources' } });
    render(<SessionPanel sessionId="session-1" />);
    expect(getHostMetricsWatch('session-1')).toEqual({ boosted: true, processes: false });
  });

  it('프로세스 섹션을 열면 그때 프로세스를 요청한다', () => {
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'processes' } });
    const { unmount } = render(<SessionPanel sessionId="session-1" />);
    expect(getHostMetricsWatch('session-1')).toEqual({ boosted: true, processes: true });
    // 닫으면 요청이 풀려 주기가 원래대로 돌아간다.
    unmount();
    expect(getHostMetricsWatch('session-1')).toEqual({ boosted: false, processes: false });
  });

  it('프로세스는 CPU 내림차순이고 검색으로 걸러진다', () => {
    publishHostMetrics('session-1', {
      status: 'ready',
      metrics: null,
      processes: [
        { pid: 2, user: 'root', cpuPercent: 1, memPercent: 9, rssKb: null, command: 'nginx' },
        { pid: 1, user: 'ubuntu', cpuPercent: 80, memPercent: 1, rssKb: null, command: 'node server.js' },
      ],
      updatedAtMs: 1,
    });
    setState({ sessionPanelSectionBySessionId: { 'session-1': 'processes' } });
    render(<SessionPanel sessionId="session-1" />);

    const commands = screen.getAllByText(/nginx|node server\.js/);
    expect(commands[0].textContent).toBe('node server.js');

    fireEvent.change(screen.getByPlaceholderText('프로세스 검색'), {
      target: { value: 'nginx' },
    });
    expect(screen.queryByText('node server.js')).toBeNull();
    expect(screen.getByText('nginx')).toBeTruthy();
  });

  it('프로세스 섹션에는 종료 버튼이 없다', () => {
    // 모니터링만 한다 — 조작은 터미널에서 하는 편이 예측 가능하다.
    publishHostMetrics('session-1', {
      status: 'ready',
      metrics: null,
      processes: [
        { pid: 1, user: 'root', cpuPercent: 1, memPercent: 1, rssKb: null, command: 'nginx' },
      ],
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

  it('규칙 추가·편집은 기존 화면으로 넘긴다', () => {
    setState({
      sessionPanelSectionBySessionId: { 'session-1': 'ports' },
      tabs: [{ sessionId: 'session-1', title: 'Prod', paneKind: 'terminal', hostId: 'host-1' }],
      portForwards: [rule],
      portForwardRuntimes: [],
    });
    render(<SessionPanel sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: '규칙 추가·편집' }));
    expect(storeState.openHomeSection).toHaveBeenCalledWith('portForwarding');
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
