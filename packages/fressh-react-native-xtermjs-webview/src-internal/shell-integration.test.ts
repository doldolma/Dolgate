import { describe, expect, it } from 'vitest';
import {
	readCommandFromTerminalBuffer,
	unescapeReportedCommand,
} from './shell-integration';

function buffer(
	lines: Array<{ text: string; isWrapped?: boolean }>,
	cursorY: number,
) {
	return {
		baseY: 0,
		cursorY,
		getLine: (line: number) => {
			const item = lines[line];
			return item
				? {
						isWrapped: item.isWrapped ?? false,
						translateToString: () => item.text,
					}
				: undefined;
		},
	};
}

describe('shell integration command reconstruction', () => {
	it('includes a command on the same buffer line as the prompt', () => {
		expect(
			readCommandFromTerminalBuffer(
				buffer([{ text: '$ docker exec -it app bash' }], 0),
				0,
				2,
				new Map(),
			),
		).toBe('docker exec -it app bash');
	});

	it('joins visual wraps and removes continuation prompts', () => {
		expect(
			readCommandFromTerminalBuffer(
				buffer(
					[
						{ text: '$ echo first\\' },
						{ text: 'wrapped', isWrapped: true },
						{ text: '> second' },
					],
					2,
				),
				0,
				2,
				new Map([[2, 2]]),
			),
		).toBe('echo first\\wrapped\nsecond');
	});

	it('unescapes OSC 133 E command payloads', () => {
		expect(unescapeReportedCommand('printf one\\ntwo\\\\three')).toBe(
			'printf one\ntwo\\three',
		);
	});
});
