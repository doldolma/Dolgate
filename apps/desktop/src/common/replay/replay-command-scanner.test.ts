import type { SessionReplayEntry } from '@shared';
import { describe, expect, it } from 'vitest';
import { packReplaySegment, segmentReplayEntries } from '../../renderer/lib/replay-segments.test-support';
import { ReplayCommandScanner, scanReplayCommands, type ReplayCommandBlock } from './replay-command-scan';

function output(atMs: number, text: string): SessionReplayEntry {
  return { type: 'output', atMs, dataBase64: Buffer.from(text, 'utf8').toString('base64') };
}

const ENTRIES: SessionReplayEntry[] = [
  output(0, 'user@host:~$ \x1b]133;B\x07'),
  output(100, 'ls -la\r\n\x1b]133;C\x07'),
  output(150, 'file-a\r\nfile-b\r\n'),
  output(400, '\x1b]133;D;0\x07'),
  output(410, 'user@host:~$ \x1b]133;B\x07'),
  output(500, '\x1b]133;E;sleep 9\x07sleep 9\r\n\x1b]133;C\x07'),
  output(900, '^C\r\n\x1b]133;D;130\x07'),
  output(950, 'user@host:~$ \x1b]133;B\x07'),
];

/** 구간별로 받은 명령을 id 로 합친다(같은 id 의 나중 것이 앞의 것을 대신한다) — 보는 쪽이 하는 일. */
function merge(pieces: ReplayCommandBlock[][]): ReplayCommandBlock[] {
  const byId = new Map<number, ReplayCommandBlock>();
  for (const piece of pieces) {
    for (const block of piece) {
      byId.set(block.id, block);
    }
  }
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

describe('ReplayCommandScanner (녹화하는 동안 이어 훑기)', () => {
  // 메인은 다음 구간의 시작을 모른 채 구간을 하나씩 먹인다. 결과는 재생 창이 한 번에 훑은 것과 같아야
  // 한다 — 보는 쪽이 받은 구간별 목록을 합쳐 그 목록 대신 쓴다.
  it.each([1, 2, 3])('matches a one-shot scan when fed %i entries at a time', async (perSegment) => {
    const { segments, readSegment } = segmentReplayEntries(ENTRIES, perSegment);
    const whole = await scanReplayCommands({ initialCols: 80, initialRows: 24, segments, readSegment });

    const scanner = new ReplayCommandScanner({ initialCols: 80, initialRows: 24 });
    await scanner.open(null);
    const pieces: ReplayCommandBlock[][] = [];
    for (let start = 0, index = 0; start < ENTRIES.length; start += perSegment, index += 1) {
      const step = await scanner.feed(packReplaySegment(ENTRIES.slice(start, start + perSegment)), index, {
        startAtMs: null,
        exists: true,
      });
      pieces.push(step!.changed);
    }
    scanner.dispose();

    expect(whole.blocks).toHaveLength(2);
    expect(merge(pieces)).toEqual(whole.blocks);
    expect(merge(pieces)[1]).toMatchObject({ command: 'sleep 9', atMs: 500, endAtMs: 900, state: 'interrupted' });
  });

  it('reports a command when it starts and again when it ends', async () => {
    const scanner = new ReplayCommandScanner({ initialCols: 80, initialRows: 24 });
    await scanner.open(null);
    const started = await scanner.feed(packReplaySegment(ENTRIES.slice(0, 3)), 0, { startAtMs: null, exists: true });
    expect(started!.changed).toEqual([expect.objectContaining({ id: 1, command: 'ls -la', state: 'running' })]);
    const ended = await scanner.feed(packReplaySegment(ENTRIES.slice(3, 4)), 1, { startAtMs: null, exists: true });
    expect(ended!.changed).toEqual([expect.objectContaining({ id: 1, endAtMs: 400, state: 'ok' })]);
    const quiet = await scanner.feed(packReplaySegment([output(420, 'nothing new\r\n')]), 2, { startAtMs: null, exists: true });
    expect(quiet!.changed).toEqual([]);
    expect(scanner.detectedShellIntegration).toBe(true);
    scanner.dispose();
  });

  it('takes a snapshot once enough output has gone by', async () => {
    const scanner = new ReplayCommandScanner({ initialCols: 80, initialRows: 24, snapshots: { spacingBytes: 10 } });
    await scanner.open(null);
    const step = await scanner.feed(packReplaySegment([output(0, 'hello world\r\n')]), 0, { startAtMs: null, exists: true });
    expect(step!.snapshot).toMatchObject({ segment: 1, atMs: 0, cols: 80, rows: 24 });
    expect(step!.snapshot!.data).toContain('hello world');
    scanner.dispose();
  });
});
