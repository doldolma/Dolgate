import { describe, expect, it } from 'vitest';
import { detectSubshellEntry, detectsSubshellEntry } from './subshell-detect';

describe('detectsSubshellEntry', () => {
  it('detects shells and remote/exec entry commands', () => {
    for (const cmd of [
      'ssh host',
      'ssh user@10.0.0.1 -p 2222',
      'mosh box',
      'sudo su',
      'sudo su -',
      'sudo -i',
      'sudo -s',
      'su',
      'su - deploy',
      'bash',
      'zsh',
      'sh',
      'fish',
      'docker exec -it web bash',
      'docker run -it alpine sh',
      'podman exec -it c sh',
      'kubectl exec -it pod -- sh',
      'toolbox enter',
      'distrobox enter ubuntu',
      'nix-shell',
    ]) {
      expect(detectsSubshellEntry(cmd), cmd).toBe(true);
    }
  });

  it('does not match unrelated or lookalike commands', () => {
    for (const cmd of [
      '',
      '   ',
      'ls -la',
      'ssh-add ~/.ssh/id_ed25519', // ssh-add is not a subshell
      'ssh-keygen -t ed25519',
      'sudo apt update', // sudo of a normal command
      'sudo systemctl restart nginx',
      'echo ssh', // ssh not at start
      'git push',
      'flush-cache',
      'docker ps',
      'docker build .',
      'kubectl get pods',
    ]) {
      expect(detectsSubshellEntry(cmd), cmd).toBe(false);
    }
  });

  it('honors custom user patterns and ignores invalid ones', () => {
    expect(detectsSubshellEntry('myjump prod', ['^myjump(\\s|$)'])).toBe(true);
    expect(detectsSubshellEntry('ls', ['^myjump(\\s|$)'])).toBe(false);
    // Invalid regex must not throw.
    expect(detectsSubshellEntry('anything', ['([unclosed'])).toBe(false);
  });
});

describe('윈도우 서브셸', () => {
  it('wsl·pwsh·powershell과 exe 이름을 잡는다', () => {
    // 윈도우 터미널에서 들어가는 서브셸의 상당수가 리눅스 셸이다(`wsl`). 예전에는 이 셋이
    // 패턴에 없어 재주입이 아예 불리지 않았다.
    for (const command of [
      'wsl',
      'wsl.exe -d Ubuntu',
      'pwsh',
      'pwsh.exe',
      'powershell -NoLogo',
      'powershell.exe -NoLogo',
    ]) {
      expect(detectsSubshellEntry(command)).toBe(true);
    }
  });

  it('PowerShell 호출 연산자와 인용된 Git Bash 경로를 정규화한다', () => {
    expect(
      detectSubshellEntry('& "C:\\Program Files\\Git\\bin\\bash.exe"'),
    ).toEqual({
      shellHint: 'bash',
    });
    expect(
      detectSubshellEntry("& 'C:\\Program Files\\Git\\usr\\bin\\zsh.exe' -l"),
    ).toEqual({
      shellHint: 'zsh',
    });
    expect(detectSubshellEntry('& C:\\Git\\bin\\fish.exe')).toEqual({
      shellHint: 'fish',
    });
  });

  it('직접 실행한 셸만 힌트로 돌려주고 중간 실행기는 추측하지 않는다', () => {
    expect(detectSubshellEntry('/usr/bin/bash -l')).toEqual({
      shellHint: 'bash',
    });
    expect(detectSubshellEntry('docker exec -it web bash')).toEqual({});
    expect(detectSubshellEntry('wsl -d Ubuntu')).toEqual({});
  });

  it('비슷한 이름은 잡지 않는다', () => {
    for (const command of [
      'wslconfig',
      'wsl.exe--help',
      'powershellx',
      // PowerShell에서는 호출 연산자 없는 인용 경로가 실행이 아니라 문자열 표현식이다.
      '"C:\\Program Files\\Git\\bin\\bash.exe"',
    ]) {
      expect(detectsSubshellEntry(command)).toBe(false);
    }
  });
});

describe('sudo 로 감싼 명령', () => {
  it('`sudo docker exec` 도 서브셸로 본다 — 소켓 권한이 없는 호스트가 그렇게 나간다', () => {
    expect(detectsSubshellEntry("sudo docker exec -it 'web' sh")).toBe(true);
    expect(detectsSubshellEntry('sudo -n docker exec -it web bash')).toBe(true);
    expect(detectsSubshellEntry('sudo -u deploy ssh box')).toBe(true);
  });

  it('sudo 자체로 셸을 여는 것도 그대로 잡힌다', () => {
    expect(detectsSubshellEntry('sudo -i')).toBe(true);
    expect(detectsSubshellEntry('sudo su -')).toBe(true);
  });

  it('sudo 로 도는 평범한 명령은 아니다', () => {
    expect(detectsSubshellEntry('sudo systemctl restart nginx')).toBe(false);
    expect(detectsSubshellEntry('sudo docker ps')).toBe(false);
  });

  it('sudo 뒤의 직접 셸은 힌트를 유지한다', () => {
    expect(detectSubshellEntry('sudo -u deploy /usr/bin/bash')).toEqual({
      shellHint: 'bash',
    });
  });
});

describe('exec 로 셸을 갈아타는 경우', () => {
  // `exec bash` 는 지금 셸 프로세스를 새 bash 로 바꾼다 — 훅은 사라지는데 tmux 의 "이미 심어짐"
  // 표식은 pane 에 남아, 재연결마다 다시 심지 않고 그 pane 의 통합이 영영 죽었다. exec 를 벗기고
  // 나머지가 셸이면 서브셸 진입으로 본다(→ 재주입).
  it('exec 뒤의 셸을 잡고 그 셸을 힌트로 준다', () => {
    expect(detectSubshellEntry('exec bash')).toEqual({ shellHint: 'bash' });
    expect(detectSubshellEntry('exec -l zsh')).toEqual({ shellHint: 'zsh' });
    expect(detectSubshellEntry('exec fish')).toEqual({ shellHint: 'fish' });
    // 로그인 셸 흉내(-a 로 argv[0] 을 "-bash" 로): -a 는 값을 가지는 옵션이라 그 값을 셸로 보면 안 된다.
    expect(detectSubshellEntry('exec -a -bash bash')).toEqual({ shellHint: 'bash' });
    expect(detectSubshellEntry('exec -cl /bin/zsh')).toEqual({ shellHint: 'zsh' });
  });

  it('exec 뒤가 원격·권한 진입이면 그것대로 잡는다(힌트는 추측하지 않음)', () => {
    expect(detectSubshellEntry('exec ssh host')).toEqual({});
    expect(detectSubshellEntry('exec sudo -i')).toEqual({});
    expect(detectSubshellEntry('exec docker exec -it web bash')).toEqual({});
  });

  it('명령 없는 exec(리다이렉션 전용)와 셸이 아닌 exec 는 잡지 않는다', () => {
    for (const cmd of [
      'exec',
      'exec 3>file',
      'exec >log 2>&1',
      'exec vim notes.txt',
      'exec node server.js',
      // -a 는 argv[0] 이름을 주는 값 옵션이다 — 그 값이 셸 이름이어도 실제 프로그램은 뒤의 것이다.
      'exec -a bash vim',
      // 비슷한 이름은 exec 가 아니다.
      'execute bash',
      'exec-helper bash',
    ]) {
      expect(detectsSubshellEntry(cmd), cmd).toBe(false);
    }
  });
});
