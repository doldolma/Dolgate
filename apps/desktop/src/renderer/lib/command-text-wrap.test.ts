// 명령 텍스트 읽기는 가짜 버퍼로는 검증할 수 없는 부분이 있다 — 넓은 글자(한글·CJK·이모지)가
// 행 끝에 못 들어갈 때 xterm 이 남는 칸을 어떻게 채우는지는 실제 구현에만 있다.
// 그래서 이 파일은 진짜 터미널에 문자열을 흘려 넣고 읽어낸 명령을 확인한다.

import { Terminal } from '@xterm/headless';
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

/**
 * 임의의 프롬프트를 쓰고 그 뒤의 명령을 다시 읽어낸다.
 *
 * promptEndX 는 실제 코드와 같은 방법으로 얻는다 — 프롬프트만 먼저 흘려 넣고 그때의 커서
 * 열을 읽는다(셸이 133;B 를 내는 시점이 바로 그 자리다). 손으로 센 칸 수를 넘기면 넓은 글자
 * 계산을 테스트가 틀리게 하고, 그러면 무엇을 검증하는지 알 수 없게 된다.
 */
async function readCommandAfterPrompt(
  prompt: string,
  command: string,
  cols: number,
) {
  const terminal = new Terminal({ cols, rows: 10, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => {
      terminal.write(prompt, () => resolve());
    });
    const promptEndX = terminal.buffer.active.cursorX;
    await new Promise<void>((resolve) => {
      terminal.write(`${command}\r\n`, () => resolve());
    });
    const buffer = terminal.buffer.active;
    return {
      promptEndX,
      command: readCommandTextFromBuffer(
        buffer,
        0,
        promptEndX,
        buffer.baseY + buffer.cursorY,
      ),
    };
  } finally {
    terminal.dispose();
  }
}

describe('readCommandTextFromBuffer (실제 xterm)', () => {
  // 프롬프트에 한글이 들어가면 칸 수(promptEndX)와 글자 수가 갈라진다. 그 값으로 문자열을
  // 자르면 명령 앞부분이 함께 잘려 나가, 기록·재실행·자동완성 통계에 없는 명령이 들어간다.
  it('프롬프트에 한글이 있어도 명령만 읽는다', async () => {
    const result = await readCommandAfterPrompt('~/문서$ ', 'docker ps', 40);
    // 칸 수와 글자 수가 실제로 갈라지는 경우여야 이 테스트가 의미가 있다.
    expect(result.promptEndX).toBeGreaterThan('~/문서$ '.length);
    expect(result.command).toEqual({ text: 'docker ps', unreliable: false });
  });

  it('이모지 프롬프트에서도 명령만 읽는다', async () => {
    const result = await readCommandAfterPrompt('🚀 $ ', 'git status', 40);
    expect(result.command).toEqual({ text: 'git status', unreliable: false });
  });

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
