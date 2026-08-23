// 세션 패널은 pane 밖에 있어 sessionId 로 터미널을 찾는다. 레지스트리 키는 stableId(pane
// 수명)이므로 그 조회가 맞아야 "다른 pane 의 셸에 입력이 들어가는" 사고를 피할 수 있다.

import { describe, expect, it, vi } from 'vitest';
import {
  isTerminalBracketedPasteEnabled,
  registerTerminalHooks,
  scrollTerminalToLine,
  sendTerminalInput,
  unregisterTerminalHooks,
  type TerminalHooks,
} from './terminal-write-registry';

function fakeHooks(sessionId: string, bracketedPaste = false) {
  const sent: string[] = [];
  const scrolled: number[] = [];
  const hooks: TerminalHooks = {
    write: vi.fn(),
    refresh: vi.fn(),
    serialize: vi.fn(() => ''),
    getSessionId: () => sessionId,
    getCellSize: vi.fn(() => null),
    getSelection: vi.fn(() => ''),
    captureRecentText: vi.fn(() => ''),
    captureTextSnapshot: vi.fn(() => []),
    sendInput: (data: string) => {
      sent.push(data);
    },
    isBracketedPasteEnabled: () => bracketedPaste,
    scrollToLine: (line: number) => {
      scrolled.push(line);
    },
  };
  return { hooks, sent, scrolled };
}

describe('sessionId 로 터미널 찾기', () => {
  it('그 세션의 터미널에만 입력을 보낸다', () => {
    const first = fakeHooks('session-a');
    const second = fakeHooks('session-b');
    registerTerminalHooks('pane-1', first.hooks);
    registerTerminalHooks('pane-2', second.hooks);
    try {
      expect(sendTerminalInput('session-b', '\x15ls\r')).toBe(true);
      expect(second.sent).toEqual(['\x15ls\r']);
      expect(first.sent).toEqual([]);
    } finally {
      unregisterTerminalHooks('pane-1', first.hooks);
      unregisterTerminalHooks('pane-2', second.hooks);
    }
  });

  it('살아 있는 터미널이 없으면 false — 조용히 삼키지 않는다', () => {
    expect(sendTerminalInput('session-gone', 'ls')).toBe(false);
    expect(sendTerminalInput('', 'ls')).toBe(false);
  });

  it('붙여넣기 모드를 못 알아내면 false 로 본다(여러 줄 넣기를 막는 쪽)', () => {
    const { hooks } = fakeHooks('session-c', true);
    registerTerminalHooks('pane-3', hooks);
    try {
      expect(isTerminalBracketedPasteEnabled('session-c')).toBe(true);
      expect(isTerminalBracketedPasteEnabled('session-missing')).toBe(false);
    } finally {
      unregisterTerminalHooks('pane-3', hooks);
    }
  });

  it('스크롤 이동도 같은 세션으로만 간다', () => {
    const target = fakeHooks('session-d');
    const other = fakeHooks('session-e');
    registerTerminalHooks('pane-4', target.hooks);
    registerTerminalHooks('pane-5', other.hooks);
    try {
      scrollTerminalToLine('session-d', 42);
      expect(target.scrolled).toEqual([42]);
      expect(other.scrolled).toEqual([]);
      // 없는 세션은 아무 일도 일어나지 않는다(던지지 않는다).
      expect(() => scrollTerminalToLine('session-nope', 1)).not.toThrow();
    } finally {
      unregisterTerminalHooks('pane-4', target.hooks);
      unregisterTerminalHooks('pane-5', other.hooks);
    }
  });

  it('pane 이 사라진 뒤에는 보내지 않는다', () => {
    const { hooks, sent } = fakeHooks('session-f');
    registerTerminalHooks('pane-6', hooks);
    unregisterTerminalHooks('pane-6', hooks);
    expect(sendTerminalInput('session-f', 'ls')).toBe(false);
    expect(sent).toEqual([]);
  });
});
