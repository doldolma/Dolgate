import type { HostRecord } from '@dolssh/shared-core';
import {
  createStartupCommandFlusher,
  looksLikeShellPrompt,
  normalizeStartupCommand,
  resolveStartupCommand,
  STARTUP_COMMAND_MAX_WAIT_MS,
  STARTUP_COMMAND_QUIET_MS,
} from '../src/lib/startup-command';

function sshHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'nas',
    hostname: 'nas.example.com',
    port: 22,
    username: 'doyoung',
    ...overrides,
  } as HostRecord;
}

describe('looksLikeShellPrompt', () => {
  // 이 판별이 틀리면 명령이 프롬프트보다 먼저 들어가 사라진다. 흔한 프롬프트 모양은 전부 잡아야
  // 한다.
  it.each([
    ['bash', 'doyoung@nas:~$ '],
    ['root', 'root@nas:/# '],
    ['zsh', 'nas% '],
    ['fish/powershell 류', 'PS C:\\> '],
    ['starship', '~/work ❯ '],
  ])('%s 프롬프트를 알아본다', (_name, tail) => {
    expect(looksLikeShellPrompt(tail)).toBe(true);
  });

  it('oh-my-zsh 기본 프롬프트는 알아보지 못한다(상한 타이머가 받는다)', () => {
    // `➜  ~` 는 기호가 앞에 오고 경로로 끝난다. 마지막 문자를 보는 이 판별로는 잡히지 않는다.
    // 판별을 경로까지 이해하도록 넓히면 명령 출력을 프롬프트로 오인할 위험이 커지므로,
    // 이 경우는 상한 대기(STARTUP_COMMAND_MAX_WAIT_MS)에 맡기는 것이 의도된 선택이다.
    expect(looksLikeShellPrompt('➜  work ')).toBe(false);
  });

  it('색상 코드가 섞여 있어도 알아본다', () => {
    expect(looksLikeShellPrompt('\x1b[32mdoyoung@nas\x1b[0m:~\x1b[34m~\x1b[0m$ ')).toBe(true);
  });

  it('창 제목 OSC 뒤에 프롬프트가 와도 알아본다', () => {
    expect(looksLikeShellPrompt('\x1b]0;doyoung@nas\x07doyoung@nas:~$ ')).toBe(true);
  });

  it('명령이 실행 중인 출력은 프롬프트로 보지 않는다', () => {
    // rc 파일 sourcing·명령 출력 중간에 발사하면 입력이 두 번 echo 된다.
    expect(looksLikeShellPrompt('Last login: Tue Aug  4 23:35:49 2026')).toBe(false);
    expect(looksLikeShellPrompt('top - 10:01:47 up 3 days')).toBe(false);
  });
});

describe('normalizeStartupCommand', () => {
  it('앞뒤 공백만인 값은 보낼 것이 없다', () => {
    expect(normalizeStartupCommand('   ')).toBeNull();
    expect(normalizeStartupCommand('')).toBeNull();
    expect(normalizeStartupCommand(undefined)).toBeNull();
  });

  it('CRLF 를 LF 로 바꾸고 끝의 개행을 지운다', () => {
    // 끝에 개행이 남으면 타이핑할 때 빈 명령이 한 번 더 실행된다.
    expect(normalizeStartupCommand('cd /var/log\r\n\r\n')).toBe('cd /var/log');
  });

  it('상한을 넘는 값은 거부한다', () => {
    expect(normalizeStartupCommand('x'.repeat(32 * 1024 + 1))).toBeNull();
  });
});

describe('resolveStartupCommand', () => {
  it('command 타입을 그대로 돌려준다', () => {
    const host = sshHost({
      startupCommand: { type: 'command', command: 'tmux new-session -A -s work' },
    } as Partial<HostRecord>);
    expect(resolveStartupCommand(host)).toBe('tmux new-session -A -s work');
  });

  it('snippet 타입은 건너뛴다', () => {
    // 모바일에는 스니펫 상태가 없어 id 를 명령으로 풀 수 없다. 오류를 내지 않고 넘긴다 —
    // 데스크톱에서 스니펫을 지정한 사용자가 접속마다 경고를 보지 않게.
    const host = sshHost({
      startupCommand: { type: 'snippet', snippetId: 'snippet-1' },
    } as Partial<HostRecord>);
    expect(resolveStartupCommand(host)).toBeNull();
  });

  it('설정이 없으면 null', () => {
    expect(resolveStartupCommand(sshHost())).toBeNull();
  });

  it.each(['aws-ec2', 'warpgate-ssh'])('%s 에도 적용한다', kind => {
    const host = sshHost({
      kind,
      startupCommand: { type: 'command', command: 'cd /srv' },
    } as unknown as Partial<HostRecord>);
    expect(resolveStartupCommand(host)).toBe('cd /srv');
  });

  it.each(['aws-ecs', 'serial'])('%s 은 대화형 로그인 셸이 아니라 제외한다', kind => {
    const host = sshHost({
      kind,
      startupCommand: { type: 'command', command: 'cd /srv' },
    } as unknown as Partial<HostRecord>);
    expect(resolveStartupCommand(host)).toBeNull();
  });
});

describe('createStartupCommandFlusher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('출력이 멈추고 꼬리가 프롬프트면 보낸다', () => {
    const send = jest.fn();
    const flusher = createStartupCommandFlusher(send);
    flusher.noteOutput('doyoung@nas:~$ ');
    expect(send).not.toHaveBeenCalled(); // 아직 조용해지지 않았다
    jest.advanceTimersByTime(STARTUP_COMMAND_QUIET_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('프롬프트가 아니면 기다리다가 상한에서 보낸다', () => {
    const send = jest.fn();
    const flusher = createStartupCommandFlusher(send);
    flusher.noteOutput('Last login: Tue Aug  4');
    jest.advanceTimersByTime(STARTUP_COMMAND_QUIET_MS);
    expect(send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(STARTUP_COMMAND_MAX_WAIT_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('출력이 계속 오는 동안에는 보내지 않는다', () => {
    // rc 파일 sourcing 중간의 짧은 공백에 속으면 안 된다.
    const send = jest.fn();
    const flusher = createStartupCommandFlusher(send);
    for (let i = 0; i < 5; i += 1) {
      flusher.noteOutput('sourcing...\n');
      jest.advanceTimersByTime(STARTUP_COMMAND_QUIET_MS - 20);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('여러 조건이 겹쳐도 한 번만 보낸다', () => {
    const send = jest.fn();
    const flusher = createStartupCommandFlusher(send);
    flusher.noteOutput('doyoung@nas:~$ ');
    jest.advanceTimersByTime(STARTUP_COMMAND_QUIET_MS);
    flusher.noteOutput('doyoung@nas:~$ ');
    jest.advanceTimersByTime(STARTUP_COMMAND_MAX_WAIT_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('dispose 뒤에는 보내지 않는다', () => {
    // 세션이 닫힌 뒤 타이머가 살아 있으면 없는 셸에 쓰기를 시도한다.
    const send = jest.fn();
    const flusher = createStartupCommandFlusher(send);
    flusher.dispose();
    flusher.noteOutput('doyoung@nas:~$ ');
    jest.advanceTimersByTime(STARTUP_COMMAND_MAX_WAIT_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });
});
