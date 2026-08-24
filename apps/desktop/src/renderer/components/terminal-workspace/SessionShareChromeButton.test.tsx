// 터미널 위에 떠 있던 Share 알약이 상단 바(세션 패널 토글 옆)로 옮겨 왔다. 팝오버 내용은
// TerminalSharePopover.test.tsx 가 덮으므로, 여기서는 "이 자리에서 눌렀을 때 공유 백엔드에
// 무엇이 나가는가" 만 본다 — 특히 첫 화면(스냅샷)이 실려 나가는지.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerTerminalHooks,
  unregisterTerminalHooks,
  type TerminalHooks,
} from '../../lib/terminal-write-registry';
import { SessionShareChromeButton } from './SessionShareChromeButton';

const startSessionShare = vi.fn();
const setSessionShareInputEnabled = vi.fn();
const stopSessionShare = vi.fn();
const openOwnerChatWindow = vi.fn();

const storeState: Record<string, unknown> = {};

vi.mock('../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

vi.mock('../../services/desktop/session-shares', () => ({
  openOwnerChatWindow: (sessionId: string) => openOwnerChatWindow(sessionId),
}));

const snapshot = {
  snapshot: 'screen-dump',
  cols: 120,
  rows: 32,
  terminalAppearance: {
    fontFamily: 'MonoLisa',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  viewportPx: { width: 900, height: 500 },
};

let hooks: TerminalHooks;

function tab(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    hostId: 'host-1',
    title: 'Prod',
    source: 'host',
    status: 'connected',
    ...overrides,
  };
}

function setState(overrides: Record<string, unknown> = {}): void {
  Object.assign(storeState, {
    startSessionShare,
    setSessionShareInputEnabled,
    stopSessionShare,
    hosts: [{ id: 'host-1', kind: 'ssh' }],
    tabs: [tab()],
    ...overrides,
  });
}

function registerHooks(capture: () => typeof snapshot | null): void {
  hooks = {
    write: vi.fn(),
    refresh: vi.fn(),
    serialize: () => '',
    getSessionId: () => 'session-1',
    getCellSize: () => null,
    getSelection: () => '',
    captureRecentText: () => '',
    captureTextSnapshot: () => [],
    captureShareSnapshot: capture,
    sendInput: vi.fn(),
    isBracketedPasteEnabled: () => true,
    scrollToLine: vi.fn(),
  };
  registerTerminalHooks('pane-1', hooks);
}

beforeEach(() => {
  startSessionShare.mockClear();
  setSessionShareInputEnabled.mockClear();
  stopSessionShare.mockClear();
  openOwnerChatWindow.mockClear();
  for (const key of Object.keys(storeState)) {
    delete storeState[key];
  }
  setState();
  registerHooks(() => snapshot);
});

afterEach(() => {
  unregisterTerminalHooks('pane-1', hooks);
});

describe('공유 시작', () => {
  it('이 세션의 첫 화면이 함께 나간다', () => {
    render(<SessionShareChromeButton sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('button', { name: '공유 시작' }));
    expect(startSessionShare).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: 'Prod',
      transport: 'ssh',
      ...snapshot,
    });
  });

  it('EC2 호스트는 SSM 전송으로 시작한다', () => {
    setState({ hosts: [{ id: 'host-1', kind: 'aws-ec2' }] });
    render(<SessionShareChromeButton sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('button', { name: '공유 시작' }));
    expect(startSessionShare.mock.calls[0][0].transport).toBe('aws-ssm');
  });

  it('터미널이 없으면 시작하지 않는다', () => {
    // 첫 화면 없이 시작하면 상대가 빈 화면을 본다.
    unregisterTerminalHooks('pane-1', hooks);
    registerHooks(() => null);
    render(<SessionShareChromeButton sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('button', { name: '공유 시작' }));
    expect(startSessionShare).not.toHaveBeenCalled();
  });

  it('연결되지 않은 세션은 시작할 수 없다', () => {
    setState({ tabs: [tab({ status: 'reconnecting' })] });
    render(<SessionShareChromeButton sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByRole('button', { name: '공유 시작' })).toBeDisabled();
  });
});

describe('공유 중', () => {
  beforeEach(() => {
    setState({
      tabs: [
        tab({
          sessionShare: {
            status: 'active',
            shareUrl: 'https://share.test/session-1',
            viewerCount: 3,
            inputEnabled: false,
            errorMessage: null,
          },
        }),
      ],
    });
  });

  it('링크를 복사하고 복사했다고 말한다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<SessionShareChromeButton sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('button', { name: '공유 링크 복사' }));
    expect(writeText).toHaveBeenCalledWith('https://share.test/session-1');
    expect(await screen.findByText('링크를 복사했습니다.')).toBeTruthy();
  });

  it('입력 허용·채팅·종료를 이 세션으로 보낸다', () => {
    render(<SessionShareChromeButton sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('button', { name: '입력 허용' }));
    fireEvent.click(screen.getByRole('button', { name: '채팅 기록' }));
    fireEvent.click(screen.getByRole('button', { name: '공유 종료' }));
    expect(setSessionShareInputEnabled).toHaveBeenCalledWith('session-1', true);
    expect(openOwnerChatWindow).toHaveBeenCalledWith('session-1');
    expect(stopSessionShare).toHaveBeenCalledWith('session-1');
  });
});

describe('공유할 수 없는 세션', () => {
  it('tmux pane 에는 버튼을 두지 않는다', () => {
    setState({ tabs: [tab({ tmux: { controlSessionId: 'ctl', paneId: '%0' } })] });
    render(<SessionShareChromeButton sessionId="session-1" />);
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('로컬 터미널에도 두지 않는다', () => {
    setState({ tabs: [tab({ source: 'local', hostId: null })] });
    render(<SessionShareChromeButton sessionId="session-1" />);
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });
});
