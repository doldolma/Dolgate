import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal, type ITerminalAddon } from '@xterm/headless';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildCharsetDesignators,
  isAtRestBoundary,
  serializeHiddenState,
  type CharsetDesignators,
} from './replay-terminal-state';

function createTerminal(): { terminal: Terminal; serializer: SerializeAddon } {
  const terminal = new Terminal({ cols: 40, rows: 12, allowProposedApi: true, scrollback: 100 });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer as unknown as ITerminalAddon);
  return { terminal, serializer };
}

function writeAll(terminal: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

/** 보이는 화면을 칸마다(글자·색·속성) 적고, 커서 자리와 숨김까지 붙인다. */
function screenState(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.baseY + y);
    let text = '';
    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line?.getCell(x);
      if (!cell) {
        continue;
      }
      const style = [
        cell.getFgColorMode(),
        cell.getFgColor(),
        cell.getBgColorMode(),
        cell.getBgColor(),
        cell.isBold(),
        cell.isItalic(),
        cell.isUnderline(),
        cell.isInverse(),
      ].join(',');
      text += `${cell.getChars() || ' '}${style === '0,-1,0,-1,0,0,0,0' ? '' : `{${style}}`}`;
    }
    rows.push(text.trimEnd());
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hidden = (terminal as any)._core.coreService.isCursorHidden;
  rows.push(`cursor ${buffer.cursorX},${buffer.cursorY} hidden=${hidden}`);
  return rows;
}

describe('serializeHiddenState', () => {
  let designators: CharsetDesignators;

  beforeAll(async () => {
    designators = (await buildCharsetDesignators())!;
  });

  // [이름, 스냅샷 전에 쓴 출력, 스냅샷 뒤에 이어 쓰는 출력]. 이어 쓴 결과가 원래 터미널과 같아야 한다.
  it.each([
    ['스크롤 영역', `\x1b[1;1Hstatus\x1b[2;11r\x1b[11;1H${'line\r\n'.repeat(15)}`, 'more\r\n'.repeat(5)],
    ['선 문자(G0)', '\x1b(0', 'lqqk\r\n'],
    ['G1 선 문자로 바꿔 둔 채(SO)', '\x1b)0\x0e', 'lqqk\x0f x\r\n'],
    ['탭 위치', '\x1b[3g\r\x1b[5G\x1bH\r', 'a\tb\r\n'],
    ['커서 숨김', '\x1b[?25l', 'x'],
    [
      '저장 커서(자리·색·문자셋)',
      `\x1b[5;10H\x1b[31m\x1b(0\x1b7\x1b[0m\x1b(B\x1b[1;1H${'z\r\n'.repeat(3)}`,
      '\x1b8SAVEDq',
    ],
    ['펜(RGB·굵게·물결 밑줄)', 'abc\x1b[38;2;10;20;30;1;4:3m', 'RGB'],
    ['원점 모드 + 스크롤 영역', '\x1b[3;8r\x1b[?6h\x1b[2;2H', 'here\r\nnext'],
    [
      '섞음(영역 + 원점 + 저장 커서)',
      `\x1b[2;10r\x1b[?6h\x1b[3;4H\x1b7\x1b[9;1H${'x\r\n'.repeat(12)}`,
      '\x1b8back\x1b[1;1Htop',
    ],
    ['대체 화면의 스크롤 영역', `\x1b[?1049h\x1b[5;8r\x1b[8;1H${'alt\r\n'.repeat(6)}`, 'more\r\n'.repeat(3)],
  ])('%s', async (_name, before, after) => {
    const original = createTerminal();
    await writeAll(original.terminal, before);
    const hidden = serializeHiddenState(original.terminal, designators);
    expect(hidden).not.toBeNull();

    const serializedOnly = createTerminal();
    await writeAll(serializedOnly.terminal, original.serializer.serialize());
    const restored = createTerminal();
    await writeAll(restored.terminal, original.serializer.serialize() + hidden);

    for (const target of [original, serializedOnly, restored]) {
      await writeAll(target.terminal, after);
    }
    expect(screenState(restored.terminal)).toEqual(screenState(original.terminal));
    // 덧붙이지 않으면 달랐다는 것까지 본다(이 경우를 시험하는 의미가 있는지).
    if (!['펜(RGB·굵게·물결 밑줄)'].includes(_name)) {
      expect(screenState(serializedOnly.terminal)).not.toEqual(screenState(original.terminal));
    }
  });
});

describe('isAtRestBoundary', () => {
  it.each([
    ['글자를 다 쓴 뒤', 'done\r\n', true],
    ['CSI 중간', 'x\x1b[3', false],
    ['OSC 중간', '\x1b]133;A', false],
    ['UTF-8 글자 중간', new Uint8Array([0x61, 0xea, 0xb0]), false],
    ['줄 끝에서 줄바꿈을 기다리는 커서', 'x'.repeat(40), false],
  ] as const)('%s → %s', async (_name, data, expected) => {
    const { terminal } = createTerminal();
    await writeAll(terminal, data);
    expect(isAtRestBoundary(terminal)).toBe(expected);
  });
});
