import type { SessionReplayEntry, SessionReplayRecording } from '@shared';
import { describe, expect, it } from 'vitest';
import { scanReplayCommands } from './replay-command-scan';

function output(atMs: number, text: string): SessionReplayEntry {
  return { type: 'output', atMs, dataBase64: btoa(text) };
}

function recordingOf(entries: SessionReplayEntry[]): SessionReplayRecording {
  return {
    recordingId: 'rec-1',
    sessionId: 'session-1',
    hostId: 'host-1',
    hostLabel: 'host',
    title: 'host',
    connectionKind: 'ssh',
    connectedAt: new Date(0).toISOString(),
    disconnectedAt: new Date(10_000).toISOString(),
    durationMs: 10_000,
    initialCols: 80,
    initialRows: 24,
    entries,
  } as SessionReplayRecording;
}

describe('scanReplayCommands', () => {
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
