interface BufferLineLike {
	isWrapped: boolean;
	translateToString(trimRight?: boolean): string;
}

interface BufferLike {
	baseY: number;
	cursorY: number;
	getLine(line: number): BufferLineLike | undefined;
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
		const raw = bufferLine.translateToString(true);
		if (line === promptLine) {
			text = raw.slice(promptEndX);
		} else if (bufferLine.isWrapped) {
			text += raw;
		} else {
			const continuationX = continuationEndX.get(line);
			text += '\n' + raw.slice(continuationX ?? 0);
		}
	}
	const command = text.trim();
	return command || undefined;
}
