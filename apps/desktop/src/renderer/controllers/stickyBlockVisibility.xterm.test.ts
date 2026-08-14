import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginCommandBlock,
  clearCommandBlocks,
  finishCommandBlock,
  getCommandBlockAtLine,
  notePromptCommandStart,
} from '../lib/terminal-command-blocks';
import { shouldShowStickyBlockHeader } from './stickyBlockVisibility';

// 실제 xterm 으로 Ctrl+L 상황을 만든다.
//
// 이 판정은 "화면을 지웠을 때 버퍼가 어떻게 되는가" 에 걸려 있다 — 추측으로 두면 안 된다.
// readline 의 clear-screen 은 ESC[H ESC[2J 를 보낸다: 스크롤백은 남고 보이는 화면만 지워지며,
// 셸이 그 자리에 새 프롬프트를 그린다.

const SESSIONS: string[] = [];

function openTerminal(rows = 10) {
  if (typeof window.matchMedia !== 'function') {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const terminal = new Terminal({ cols: 40, rows, allowProposedApi: true });
  terminal.open(container);
  return { terminal, container };
}

/** write 는 비동기로 파싱된다. 다음 검사 전에 반영되기를 기다린다. */
function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

afterEach(() => {
  for (const session of SESSIONS.splice(0)) {
    clearCommandBlocks(session);
  }
});

describe('Ctrl+L 뒤의 스티키 헤더', () => {
  it('화면을 지우면 헤더를 내린다 — 지우기 전에는 붙어 있다', async () => {
    const session = 'sticky-clear';
    SESSIONS.push(session);
    const { terminal, container } = openTerminal(10);

    // 프롬프트 → 명령 → 출력 → 종료. 출력이 화면보다 길어서 명령 줄이 스크롤백으로 올라간다.
    await write(terminal, '$ ');
    notePromptCommandStart(session, terminal);
    await write(terminal, 'ls -al\r\n');
    beginCommandBlock(session, terminal, 'ls -al');
    for (let line = 0; line < 14; line += 1) {
      await write(terminal, `entry-${line}\r\n`);
    }
    finishCommandBlock(session, terminal, 0);
    await write(terminal, '$ ');

    const buffer = terminal.buffer.active;
    const blockBefore = getCommandBlockAtLine(session, buffer.viewportY);
    expect(blockBefore).not.toBeNull();
    // 이 상황이 헤더의 존재 이유다: 명령 줄은 화면 위로 사라졌고 출력은 화면에 남아 있다.
    expect(
      shouldShowStickyBlockHeader({
        blockStart: blockBefore!.marker.line,
        blockEnd: blockBefore!.endLine,
        viewportY: buffer.viewportY,
        cursorLine: buffer.baseY + buffer.cursorY,
      }),
    ).toBe(true);

    // Ctrl+L: readline 이 보내는 것과 같은 시퀀스. 그 뒤 셸이 프롬프트를 다시 그린다.
    await write(terminal, '[H[2J');
    await write(terminal, '$ ');

    const cleared = terminal.buffer.active;
    const blockAfter = getCommandBlockAtLine(session, cleared.viewportY);
    // 블록은 **여전히** 그 행들을 자기 영역으로 본다 — 지우기는 행 번호를 건드리지 않고, 스크롤
    // 위치도 그대로다. 그래서 "블록이 화면에 걸쳐 있는가" 만으로는 구분할 수 없고, 커서가 근거가
    // 된다(그 자리에 새 프롬프트가 그려졌다).
    expect(blockAfter).not.toBeNull();
    expect(cleared.viewportY).toBe(buffer.viewportY);
    expect(cleared.baseY + cleared.cursorY).toBeLessThan(blockAfter!.endLine!);
    expect(
      shouldShowStickyBlockHeader({
        blockStart: blockAfter!.marker.line,
        blockEnd: blockAfter!.endLine,
        viewportY: cleared.viewportY,
        cursorLine: cleared.baseY + cleared.cursorY,
      }),
    ).toBe(false);

    terminal.dispose();
    container.remove();
  });
});
