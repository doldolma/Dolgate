import type { SessionReplayEntry } from '@shared';
import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { scanReplayCommands, type ReplayScanSource } from './replay-command-scan';
import { ReplaySnapshotStore } from './replay-player';
import { segmentReplayEntries } from './replay-segments.test-support';

function output(atMs: number, text: string): SessionReplayEntry {
  return { type: 'output', atMs, dataBase64: btoa(text) };
}

function sourceOf(
  entries: SessionReplayEntry[],
  entriesPerSegment = Number.POSITIVE_INFINITY,
): ReplayScanSource {
  return {
    initialCols: 80,
    initialRows: 24,
    ...segmentReplayEntries(entries, entriesPerSegment),
  };
}

// 녹화는 구간 단위로 훑는다. 마커나 시각이 구간 경계에 걸려도 결과가 같아야 하므로 나누는 방식마다 돌린다.
describe.each([
  ['한 구간', Number.POSITIVE_INFINITY],
  ['항목마다 구간', 1],
  ['두 항목씩 구간', 2],
])('scanReplayCommands (%s)', (_label, entriesPerSegment) => {
  const recordingOf = (entries: SessionReplayEntry[]) => sourceOf(entries, entriesPerSegment);

  it('명령어·종료코드·소요시간을 녹화 시각과 함께 뽑는다', async () => {
    const result = await scanReplayCommands(
      recordingOf([
        output(0, 'user@host:~$ \x1b]133;B\x07'),
        output(100, 'ls -la\r\n\x1b]133;C\x07'),
        output(150, 'file-a\r\nfile-b\r\n'),
        output(400, '\x1b]133;D;0\x07'),
        output(410, 'user@host:~$ \x1b]133;B\x07'),
        output(500, 'boom\r\n\x1b]133;C\x07'),
        output(900, 'not found\r\n\x1b]133;D;127\x07'),
      ]),
    );

    expect(result.shellIntegrationDetected).toBe(true);
    expect(result.blocks).toHaveLength(2);

    const [first, second] = result.blocks;
    expect(first.command).toBe('ls -la');
    expect(first.atMs).toBe(100);
    expect(first.endAtMs).toBe(400);
    expect(first.durationMs).toBe(300);
    expect(first.exitCode).toBe(0);
    expect(first.state).toBe('ok');

    expect(second.command).toBe('boom');
    expect(second.exitCode).toBe(127);
    expect(second.state).toBe('failed');
    expect(second.durationMs).toBe(400);
  });

  // 녹화에는 종료코드 숫자만 남고 판정은 볼 때 한다 — 예전 녹화도 새 기준으로 보인다.
  it('Ctrl+C 로 끊은 명령(130)은 실패가 아니라 interrupted 로 뽑는다', async () => {
    const result = await scanReplayCommands(
      recordingOf([
        output(0, 'user@host:~$ \x1b]133;B\x07'),
        output(100, 'tail -f syslog\r\n\x1b]133;C\x07'),
        output(150, 'Oct 12 14:02:11 prod CRON[8830]: (root) CMD (sync)\r\n'),
        output(2_000, '^C\r\n\x1b]133;D;130\x07'),
      ]),
    );

    const [block] = result.blocks;
    expect(block.command).toBe('tail -f syslog');
    expect(block.exitCode).toBe(130);
    expect(block.state).toBe('interrupted');
  });

  it('OSC 7 로 보고된 작업 디렉터리를 블록에 붙인다', async () => {
    const result = await scanReplayCommands(
      recordingOf([
        output(0, '\x1b]7;file:///srv/app\x07user@host:/srv/app$ \x1b]133;B\x07'),
        output(50, 'git pull\r\n\x1b]133;C\x07'),
        output(200, '\x1b]133;D;0\x07'),
      ]),
    );

    expect(result.blocks[0]?.cwd).toBe('/srv/app');
    expect(result.blocks[0]?.command).toBe('git pull');
  });

  it('마커가 청크 경계로 잘려도 인식한다', async () => {
    // 앞 청크가 OSC 를 열어둔 채 끝나고 다음 청크에서 마무리되는 경우.
    const result = await scanReplayCommands(
      recordingOf([
        output(0, 'user@host:~$ \x1b]133;B\x07'),
        output(100, 'whoami\r\n\x1b]13'),
        output(120, '3;C\x07'),
        output(300, 'ubuntu\r\n\x1b]133;D;0\x07'),
      ]),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.command).toBe('whoami');
    expect(result.blocks[0]?.atMs).toBe(120);
    expect(result.blocks[0]?.state).toBe('ok');
  });

  it('청크가 ESC 한 바이트로 끝나게 잘려도 시각이 정확하다', async () => {
    // 이전 휴리스틱은 마지막 바이트의 ESC 를 못 봐서 이 마커의 시각이 녹화 끝으로 튀었다.
    const result = await scanReplayCommands(
      recordingOf([
        output(0, '$ \x1b]133;B\x07'),
        output(100, 'uptime\r\n\x1b'),
        output(110, ']133;C\x07'),
        output(400, '\x1b]133;D;0\x07'),
        output(9000, 'tail\r\n'),
      ]),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.atMs).toBe(110);
    expect(result.blocks[0]?.command).toBe('uptime');
  });

  it('마커가 3조각으로 잘려도 시각이 정확하다', async () => {
    // 가운데 조각에 ESC] 가 없어 이전 구현은 carry 를 잃고 시각을 놓쳤다.
    const result = await scanReplayCommands(
      recordingOf([
        output(0, '$ \x1b]133;B\x07'),
        output(100, 'df -h\r\n\x1b]13'),
        output(110, '3;'),
        output(120, 'C\x07'),
        output(500, '\x1b]133;D;0\x07'),
        output(9000, 'tail\r\n'),
      ]),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.atMs).toBe(120);
    expect(result.blocks[0]?.command).toBe('df -h');
  });

  it('취소되면 즉시 빈 결과를 돌려준다', async () => {
    const result = await scanReplayCommands(
      recordingOf([
        output(0, '$ \x1b]133;B\x07'),
        output(100, 'ls\r\n\x1b]133;C\x07'),
      ]),
      { isCancelled: () => true },
    );
    expect(result.blocks).toHaveLength(0);
  });

  it('명령 없이 프롬프트만 다시 그려지면 블록이 늘지 않는다', async () => {
    const result = await scanReplayCommands(
      recordingOf([
        output(0, '$ \x1b]133;B\x07'),
        output(10, '\r\n$ \x1b]133;B\x07'),
        output(20, '\r\n$ \x1b]133;B\x07'),
        output(30, 'echo hi\r\n\x1b]133;C\x07'),
        output(60, 'hi\r\n\x1b]133;D;0\x07'),
      ]),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.command).toBe('echo hi');
  });

  it('녹화가 명령 도중 끝나면 마지막 블록은 running 으로 남는다', async () => {
    const result = await scanReplayCommands(
      recordingOf([
        output(0, '$ \x1b]133;B\x07'),
        output(10, 'tail -f log\r\n\x1b]133;C\x07'),
        output(50, 'line\r\n'),
      ]),
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.state).toBe('running');
    expect(result.blocks[0]?.endAtMs).toBeNull();
    expect(result.blocks[0]?.durationMs).toBeNull();
  });

  it('셸 통합이 없는 녹화는 빈 목록과 미검출로 표시한다', async () => {
    const result = await scanReplayCommands(
      recordingOf([output(0, 'plain output\r\n'), output(10, 'more\r\n')]),
    );

    expect(result.blocks).toHaveLength(0);
    expect(result.shellIntegrationDetected).toBe(false);
  });

  it('resize 엔트리를 반영해도 명령 텍스트를 읽는다', async () => {
    const result = await scanReplayCommands(
      recordingOf([
        { type: 'resize', atMs: 0, cols: 100, rows: 30 },
        output(10, '$ \x1b]133;B\x07'),
        output(20, 'uname -a\r\n\x1b]133;C\x07'),
        output(40, '\x1b]133;D;0\x07'),
      ]),
    );

    expect(result.blocks[0]?.command).toBe('uname -a');
  });

  it('셸이 알려 준 명령 원문이 있으면 화면 대신 그것을 쓴다', async () => {
    // zsh 녹화. 화면에는 PS2(`heredoc> `)가 찍혀 있지만 E 가 원문을 준다.
    const result = await scanReplayCommands(
      recordingOf([
        output(0, 'user@host ~ % \x1b]133;B\x07'),
        output(100, 'cat <<EOF\r\nheredoc> line1\r\nheredoc> EOF\r\n'),
        output(150, '\x1b]133;E;cat <<EOF\\nline1\\nEOF\x07\x1b]133;C\x07'),
        output(400, 'line1\r\n\x1b]133;D;0\x07'),
      ]),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].command).toBe('cat <<EOF\nline1\nEOF');
  });

  it('이어지는 줄의 프롬프트 폭을 알려주면 PS2 가 섞이지 않는다', async () => {
    // bash 녹화. `> ` 는 화면에 찍힌 PS2 이고, B;2 가 그 폭을 알려준다.
    const result = await scanReplayCommands(
      recordingOf([
        output(0, 'user@host:~$ \x1b]133;B\x07'),
        output(100, 'cat \\\r\n'),
        output(150, '> \x1b]133;B;2\x07test.txt\r\n\x1b]133;C\x07'),
        output(400, '\x1b]133;D;0\x07'),
      ]),
    );
    expect(result.blocks[0].command).toBe('cat \\\ntest.txt');
  });

  it('E 가 없으면 예전처럼 화면을 읽는다', async () => {
    // bash 는 명령 원문을 주지 못한다.
    const result = await scanReplayCommands(
      recordingOf([
        output(0, 'user@host:~$ \x1b]133;B\x07'),
        output(100, 'ls -la\r\n\x1b]133;C\x07'),
        output(400, '\x1b]133;D;0\x07'),
      ]),
    );
    expect(result.blocks[0].command).toBe('ls -la');
  });

  it('명령이 실행되지 않으면 남은 원문을 버린다', async () => {
    // E 뒤에 C 없이 프롬프트가 다시 뜨는 경우(Ctrl-C).
    const result = await scanReplayCommands(
      recordingOf([
        output(0, 'user@host ~ % \x1b]133;B\x07'),
        output(100, '\x1b]133;E;stale\x07'),
        output(150, '^C\r\nuser@host ~ % \x1b]133;B\x07'),
        output(200, 'ls\r\n\x1b]133;C\x07'),
        output(400, '\x1b]133;D;0\x07'),
      ]),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].command).toBe('ls');
  });
});

function screenLines(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function writeAll(terminal: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

/** 녹화 항목의 출력 바이트(재생기가 터미널에 넘기는 꼴). */
function bytesOf(entry: SessionReplayEntry): Uint8Array {
  if (entry.type !== 'output') {
    throw new Error('output 항목이 아니다');
  }
  return Uint8Array.from(atob(entry.dataBase64), (character) => character.charCodeAt(0));
}

// 구간 하나를 못 읽어도 나머지 구간은 훑는다. 예전에는 스캔 전체가 실패해 명령 목록이 통째로 사라졌다(실측).
describe('scanReplayCommands 구간 읽기 실패', () => {
  it('못 읽은 구간만 비우고 나머지 구간의 명령을 뽑는다', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const parts = segmentReplayEntries(
      [
        output(0, 'user@host:~$ \x1b]133;B\x07'),
        output(100, 'ls\r\n\x1b]133;C\x07'),
        output(400, '\x1b]133;D;0\x07'),
        output(410, 'lost\r\n'),
        output(500, 'user@host:~$ \x1b]133;B\x07'),
        output(600, 'pwd\r\n\x1b]133;C\x07'),
        output(700, '\x1b]133;D;0\x07'),
      ],
      1,
    );

    const result = await scanReplayCommands({
      initialCols: 80,
      initialRows: 24,
      segments: parts.segments,
      readSegment: (index) =>
        index === 3 ? Promise.reject(new Error('broken')) : parts.readSegment(index),
    });

    expect(result.shellIntegrationDetected).toBe(true);
    expect(result.blocks.map((block) => block.command)).toEqual(['ls', 'pwd']);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});

describe('scanReplayCommands snapshots', () => {
  // 재생 창은 되감거나 멀리 건너뛸 때 이 화면부터 그린다. 새 터미널에 쓰면 그 시점까지 그린 화면과 같아야 한다.
  it('구간 경계에서 그때까지의 화면을 떠 둔다', async () => {
    const entries: SessionReplayEntry[] = [
      output(0, 'one\r\n'),
      output(10, '\x1b[31mtwo\x1b[0m\r\n'),
      { type: 'resize', atMs: 15, cols: 60, rows: 20 },
      output(20, 'three\r\n'),
      output(30, 'four'),
    ];
    const snapshots = new ReplaySnapshotStore(Number.POSITIVE_INFINITY, 1);

    await scanReplayCommands(sourceOf(entries, 2), {
      snapshots,
      snapshotScrollback: () => 100,
    });

    // 구간 셋(두 항목씩)의 경계 둘. 마지막 구간 뒤는 뜨지 않는다.
    expect(snapshots.size).toBe(2);
    expect(snapshots.latest(9)).toBeNull();
    const snapshot = snapshots.latest(25)!;
    expect(snapshot).toMatchObject({ segment: 2, atMs: 20, cols: 60, rows: 20 });

    // 그 시점까지(앞 두 구간) 차례로 그린 화면.
    const expected = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    for (const entry of entries.slice(0, 4)) {
      if (entry.type === 'resize') {
        expected.resize(entry.cols, entry.rows);
      } else {
        await writeAll(expected, atob(entry.dataBase64));
      }
    }
    const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    restored.resize(snapshot.cols, snapshot.rows);
    await writeAll(restored, snapshot.data);

    expect(screenLines(restored)).toEqual(['one', 'two', 'three']);
    expect(screenLines(restored)).toEqual(screenLines(expected));
    expect(restored.buffer.active.cursorY).toBe(expected.buffer.active.cursorY);
    expect(restored.buffer.active.cursorX).toBe(expected.buffer.active.cursorX);
    expected.dispose();
    restored.dispose();
  });

  // 이스케이프나 UTF-8 글자 중간에서 끝난 구간 경계에서 뜨면, 다음 구간이 그 나머지로 시작해 글자로 찍혔다
  // (실측: `가m나다`). 그런 경계는 건너뛰고 다음 경계에서 뜬다.
  it('이스케이프·글자 중간인 구간 경계에서는 스냅샷을 뜨지 않는다', async () => {
    const entries: SessionReplayEntry[] = [
      output(0, 'one\r\n\x1b[3'),
      output(10, '1mred\x1b[0m\r\n\xea'),
      output(20, '\xb0\x80\r\n'),
      output(30, 'end\r\n'),
    ];
    const snapshots = new ReplaySnapshotStore(Number.POSITIVE_INFINITY, 1);

    await scanReplayCommands(sourceOf(entries, 1), {
      snapshots,
      snapshotScrollback: () => 100,
    });

    expect(snapshots.size).toBe(1);
    const snapshot = snapshots.latest(Number.POSITIVE_INFINITY)!;
    expect(snapshot.segment).toBe(3);
    const expected = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    for (const entry of entries) {
      await writeAll(expected, bytesOf(entry));
    }
    const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await writeAll(restored, snapshot.data);
    await writeAll(restored, bytesOf(entries[3]!));
    expect(screenLines(restored)).toEqual(['one', 'red', '가', 'end']);
    expect(screenLines(restored)).toEqual(screenLines(expected));
    expected.dispose();
    restored.dispose();
  });

  // SerializeAddon 은 스크롤 영역을 쓰지 않아, 그 스냅샷에서 이어 그리면 상태줄이 밀려 사라졌다(실측).
  it('SerializeAddon 이 잃는 상태(스크롤 영역)를 되살려 뒤 출력이 같게 그려진다', async () => {
    const entries: SessionReplayEntry[] = [
      output(0, `\x1b[1;1Hstatus\x1b[2;11r\x1b[11;1H${'line\r\n'.repeat(15)}`),
      output(10, 'more\r\n'.repeat(5)),
    ];
    const snapshots = new ReplaySnapshotStore(Number.POSITIVE_INFINITY, 1);

    await scanReplayCommands(sourceOf(entries, 1), {
      snapshots,
      snapshotScrollback: () => 100,
    });

    const snapshot = snapshots.latest(10)!;
    expect(snapshot.segment).toBe(1);
    const expected = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    for (const entry of entries) {
      await writeAll(expected, bytesOf(entry));
    }
    const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await writeAll(restored, snapshot.data);
    await writeAll(restored, bytesOf(entries[1]!));
    expect(screenLines(restored)[0]).toBe('status');
    expect(screenLines(restored)).toEqual(screenLines(expected));
    expect(restored.buffer.active.cursorY).toBe(expected.buffer.active.cursorY);
    expected.dispose();
    restored.dispose();
  });

  it('스냅샷을 받지 않으면 구간만 차례로 훑는다', async () => {
    const parts = segmentReplayEntries([output(0, 'a\r\n'), output(10, 'b\r\n')], 1);
    const result = await scanReplayCommands({ initialCols: 80, initialRows: 24, ...parts });
    expect(result.blocks).toHaveLength(0);
    expect(parts.readSegment.mock.calls).toEqual([[0], [1]]);
  });
});
