// 명령 텍스트 읽기는 가짜 버퍼로는 검증할 수 없는 부분이 있다 — 넓은 글자(한글·CJK·이모지)가
// 행 끝에 못 들어갈 때 xterm 이 남는 칸을 어떻게 채우는지는 실제 구현에만 있다.
// 그래서 이 파일은 진짜 터미널에 문자열을 흘려 넣고 읽어낸 명령을 확인한다.

import { Terminal } from 'xterm-headless';
import { describe, expect, it } from 'vitest';
import { readCommandTextFromBuffer } from './terminal-command-blocks';

/** `$ ` 프롬프트 뒤에 명령을 쓰고, 화면에서 다시 읽어낸 결과를 돌려준다. */
async function readCommandFrom(command: string, cols: number) {
  const terminal = new Terminal({ cols, rows: 10, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => {
      terminal.write(`$ ${command}\r\n`, () => resolve());
    });
    const buffer = terminal.buffer.active;
    return readCommandTextFromBuffer(buffer, 0, 2, buffer.baseY + buffer.cursorY);
  } finally {
    terminal.dispose();
  }
}

describe('readCommandTextFromBuffer (실제 xterm)', () => {
  it('한글이 행 끝에서 접혀도 없던 공백이 끼지 않는다', async () => {
    // 마지막 칸에 '갑'(2칸)이 안 들어가면 xterm 이 그 칸을 채우고 다음 행으로 접는다.
    // 그 채움 칸을 공백으로 읽으면 "안녕하세요반 갑습니다" 가 되어, 재실행 시 사용자가
    // 친 적 없는 명령이 나간다.
    const command = 'echo 안녕하세요반갑습니다여러분';
    expect(await readCommandFrom(command, 20)).toEqual({
      text: command,
      unreliable: false,
    });
  });

  it('접히는 폭이 달라져도 항상 원문과 같다', async () => {
    const command = 'grep -rn "설정파일경로" /etc/nginx/conf.d';
    for (let cols = 12; cols <= 40; cols += 1) {
      expect(await readCommandFrom(command, cols)).toEqual({
        text: command,
        unreliable: false,
      });
    }
  });

  it('접힘 경계에 걸친 명령 속 공백은 살린다', async () => {
    // 반대 방향 실수 — 접힌 행을 trimRight 하면 "echo a b" 로 붙어 버린다.
    const command = 'echo aaaaaaaaaaaa   bb';
    expect(await readCommandFrom(command, 20)).toEqual({
      text: command,
      unreliable: false,
    });
  });

  it('이모지가 접혀도 원문과 같다', async () => {
    const command = 'echo 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀';
    expect(await readCommandFrom(command, 15)).toEqual({
      text: command,
      unreliable: false,
    });
  });
});
