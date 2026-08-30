interface BufferLineLike {
	isWrapped: boolean;
	/**
	 * `startColumn`·`endColumn` 은 **칸** 번호다(글자 수가 아니다). 넓은 글자(한글·CJK·
	 * 이모지)는 2칸을 쓰지만 문자열에서는 1글자라, 칸 번호로 문자열을 자르면 어긋난다.
	 */
	translateToString(
		trimRight?: boolean,
		startColumn?: number,
		endColumn?: number,
	): string;
}

export function unescapeReportedCommand(value: string): string {
	let out = '';
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== '\\') {
			out += value[index];
			continue;
		}
		const next = value[index + 1];
		if (next === 'n') {
			out += '\n';
			index += 1;
		} else if (next === '\\') {
			out += '\\';
			index += 1;
		} else {
			out += '\\';
		}
	}
	return out;
}

export function readCommandFromTerminalBuffer(
	buffer: BufferLike,
	promptLine: number,
	promptEndX: number,
	continuationEndX: ReadonlyMap<number, number>,
): string | undefined {
	const endLine = buffer.baseY + buffer.cursorY;
	let text = '';
	const lastLine = Math.min(endLine, promptLine + 127);
	for (let line = promptLine; line <= lastLine; line += 1) {
		const bufferLine = buffer.getLine(line);
		if (!bufferLine) break;
		if (line === promptLine) {
			// **열 번호로 문자열을 자르면 안 된다.** `~/문서$ ` 처럼 넓은 글자가 든 프롬프트에서는
			// promptEndX(칸)가 글자 수보다 커서, 잘라낸 자리가 명령 안쪽으로 들어간다 — `docker ps`
			// 가 `cker ps` 로 읽혔다. 자르는 일은 칸을 아는 xterm 에게 맡긴다.
			text = bufferLine.translateToString(true, promptEndX);
		} else if (bufferLine.isWrapped) {
			text += bufferLine.translateToString(true);
		} else {
			const continuationX = continuationEndX.get(line);
			text += '\n' + bufferLine.translateToString(true, continuationX ?? 0);
		}
	}
	const command = text.trim();
	return command || undefined;
}
