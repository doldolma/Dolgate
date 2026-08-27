import { describe, expect, it } from 'vitest';
import {
  resolveSessionPanelQuerySessionId,
  resolveSessionPanelStateKey,
} from './session-panel-scope';

function tmuxWindow() {
  return {
    id: 'ws-1',
    activeSessionId: 'tmux:ctl:%1',
    tmux: { controlSessionId: 'ctl', windowId: '@0' },
    layout: {
      kind: 'split' as const,
      direction: 'row' as const,
      ratio: 0.5,
      first: { kind: 'leaf' as const, sessionId: 'tmux:ctl:%0' },
      second: { kind: 'leaf' as const, sessionId: 'tmux:ctl:%1' },
    },
  } as never;
}

function ourSplit() {
  return {
    id: 'ws-2',
    activeSessionId: 'session-b',
    layout: {
      kind: 'split' as const,
      direction: 'row' as const,
      ratio: 0.5,
      first: { kind: 'leaf' as const, sessionId: 'session-a' },
      second: { kind: 'leaf' as const, sessionId: 'session-b' },
    },
  } as never;
}

describe('세션 패널의 단위', () => {
  it('tmux 창 안에서는 어느 pane 이든 같은 상태 키를 본다', () => {
    const workspaces = [tmuxWindow()];
    expect(resolveSessionPanelStateKey(workspaces, 'tmux:ctl:%0')).toBe('tmuxwin:ctl:@0');
    expect(resolveSessionPanelStateKey(workspaces, 'tmux:ctl:%1')).toBe('tmuxwin:ctl:@0');
  });

  it('상태 키는 pane 세션 id 와 형태가 겹치지 않는다', () => {
    // 같은 맵에 섞이면 창의 상태를 pane 이 덮어쓴다.
    const key = resolveSessionPanelStateKey([tmuxWindow()], 'tmux:ctl:%1');
    expect(key.startsWith('tmux:')).toBe(false);
  });

  it('원격에 묻는 것은 그 창의 첫 pane 으로 고정한다', () => {
    const workspaces = [tmuxWindow()];
    expect(resolveSessionPanelQuerySessionId(workspaces, 'tmux:ctl:%1')).toBe('tmux:ctl:%0');
    expect(resolveSessionPanelQuerySessionId(workspaces, 'tmux:ctl:%0')).toBe('tmux:ctl:%0');
  });

  it('우리 분할은 pane 마다 그대로다 — 서로 다른 호스트일 수 있다', () => {
    const workspaces = [ourSplit()];
    expect(resolveSessionPanelStateKey(workspaces, 'session-b')).toBe('session-b');
    expect(resolveSessionPanelQuerySessionId(workspaces, 'session-b')).toBe('session-b');
  });

  it('워크스페이스를 못 찾으면 세션 그대로', () => {
    expect(resolveSessionPanelStateKey([], 'session-x')).toBe('session-x');
    expect(resolveSessionPanelQuerySessionId(undefined, 'session-x')).toBe('session-x');
  });
});
