// 가짜 버퍼로는 이 코드를 검증할 수 없다 — 넓은 글자(한글·CJK·이모지)가 몇 칸을 쓰는지,
// 행 끝에서 어떻게 접히는지는 실제 xterm 구현에만 있고, 그 차이가 바로 여기서 나는 실수의
// 원인이다. 그래서 진짜 터미널에 흘려 넣고 읽어낸다.

import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
	readCommandFromTerminalBuffer,
	unescapeReportedCommand,
} from './shell-integration';

const write = (terminal: Terminal, data: string) =>
	new Promise<void>((resolve) => {
		terminal.write(data, () => resolve());
	});

/**
 * 프롬프트를 쓰고, 그 자리의 커서 열을 promptEndX 로 삼아 뒤이은 명령을 다시 읽어낸다.
 *
 * 셸이 OSC 133;B 를 내는 시점이 정확히 이 자리다. 칸 수를 손으로 세어 넘기면 테스트가 넓은
 * 글자 계산을 대신 틀리게 되므로, 실제 코드와 같은 방법으로 얻는다.
 */
async function readCommand(
	prompt: string,
	typed: string,
	cols = 40,
	continuationEndX = new Map<number, number>(),
) {
	const terminal = new Terminal({ cols, rows: 10, allowProposedApi: true });
	try {
		await write(terminal, prompt);
		const promptEndX = terminal.buffer.active.cursorX;
		await write(terminal, typed);
		const buffer = terminal.buffer.active;
		return {
			promptEndX,
			command: readCommandFromTerminalBuffer(
				buffer,
				0,
				promptEndX,
				continuationEndX,
			),
		};
	} finally {
		terminal.dispose();
	}
}

describe('shell integration command reconstruction', () => {
	it('includes a command on the same buffer line as the prompt', async () => {
		const result = await readCommand('$ ', 'docker exec -it app bash');
		expect(result.command).toBe('docker exec -it app bash');
	});

	// promptEndX 는 **칸** 번호다. 넓은 글자가 든 프롬프트에서는 글자 수와 갈라지므로, 그 값으로
	// 문자열을 자르면 잘린 자리가 명령 안쪽으로 들어간다 — `docker ps` 가 `cker ps` 가 됐다.
	// bash·zsh 는 명령 원문을 알려줄 방법이 없어 늘 이 경로로 읽는다.
	it('reads only the command when the prompt holds wide characters', async () => {
		const result = await readCommand('~/문서$ ', 'docker ps');
		// 칸 수와 글자 수가 실제로 갈라지는 경우여야 이 테스트가 의미가 있다.
		expect(result.promptEndX).toBeGreaterThan('~/문서$ '.length);
		expect(result.command).toBe('docker ps');
	});

	it('reads only the command after an emoji prompt', async () => {
		const result = await readCommand('🚀 $ ', 'git status');
		expect(result.command).toBe('git status');
	});

	it('joins visual wraps', async () => {
		// cols=20 이라 명령이 화면에서 접힌다. 접힌 조각은 개행 없이 이어 붙여야 원문이 된다.
		const result = await readCommand('$ ', 'echo aaaaaaaaaaaaaaaaaaaa', 20);
		expect(result.command).toBe('echo aaaaaaaaaaaaaaaaaaaa');
	});

	// 접힌 행을 trimRight 로 읽으면 명령에 속한 공백까지 지워져 접합부에서 단어가 붙는다.
	it('keeps spaces that straddle a wrap boundary', async () => {
		const typed = 'echo aaaaaaaaaaaa   bb';
		const result = await readCommand('$ ', typed, 20);
		expect(result.command).toBe(typed);
	});

	// 반대 방향 실수 — 넓은 글자가 행 끝에 못 들어가면 xterm 이 남은 칸을 코드 0 으로 채우고
	// 다음 행으로 접는다. 그 채움 칸을 공백으로 읽으면 없던 공백이 명령 한가운데 생긴다.
	it('adds no space where a wide glyph forced an early wrap', async () => {
		const typed = 'echo 안녕하세요반갑습니다여러분';
		const result = await readCommand('$ ', typed, 20);
		expect(result.command).toBe(typed);
	});

	it('keeps emoji intact across a wrap', async () => {
		const typed = 'echo 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀';
		const result = await readCommand('$ ', typed, 15);
		expect(result.command).toBe(typed);
	});

	it('removes the continuation prompt from a new line', async () => {
		const result = await readCommand(
			'$ ',
			"echo 'first\r\n> second'",
			40,
			// PS2 `> ` 는 2칸이다. 셸이 133;B;2 로 알려 준 값이 이 자리에 들어간다.
			new Map([[1, 2]]),
		);
		expect(result.command).toBe("echo 'first\nsecond'");
	});

	it('unescapes OSC 133 E command payloads', () => {
		expect(unescapeReportedCommand('printf one\\ntwo\\\\three')).toBe(
			'printf one\ntwo\\three',
		);
	});
});
