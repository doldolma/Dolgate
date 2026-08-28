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
