import { describe, expect, it } from 'vitest';
import { detectsSubshellEntry, resolveSubshellShell } from './subshell-detect';

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
  it('wsl·pwsh·powershell 진입을 잡는다', () => {
    // 윈도우 터미널에서 들어가는 서브셸의 상당수가 리눅스 셸이다(`wsl`). 예전에는 이 셋이
    // 패턴에 없어 재주입이 아예 불리지 않았다.
    for (const command of ['wsl', 'wsl -d Ubuntu', 'pwsh', 'powershell -NoLogo']) {
      expect(detectsSubshellEntry(command)).toBe(true);
    }
  });

  it('비슷한 이름은 잡지 않는다', () => {
    for (const command of ['wslconfig', 'wsl.exe--help', 'powershellx']) {
      expect(detectsSubshellEntry(command)).toBe(false);
    }
  });

  it('wsl 은 대상 셸을 모른다고 답한다 — 겸용 스크립트가 나가야 한다', () => {
    // `wsl` 안이 bash 인지 zsh 인지는 명령에 적혀 있지 않다. 억지로 짚으면 틀린 문법을 보낸다.
    expect(resolveSubshellShell('wsl')).toBe('');
    expect(resolveSubshellShell('wsl -d Ubuntu')).toBe('');
    // 셸까지 적어 준 경우에는 그 셸이다.
    expect(resolveSubshellShell('wsl bash')).toBe('bash');
  });

  it('pwsh·powershell 은 그 셸로 짚는다', () => {
    expect(resolveSubshellShell('pwsh')).toBe('pwsh');
    expect(resolveSubshellShell('powershell -NoLogo')).toBe('powershell');
  });
});

describe('resolveSubshellShell', () => {
  // 알면 그 셸 것 한 줄로 끝난다 — 특히 fish 는 겸용(POSIX) 스크립트를 받으면 문법 오류가 뜬다.
  it('명령 자체가 셸이면 그 셸이다', () => {
    for (const [command, want] of [
      ['fish', 'fish'],
      ['bash', 'bash'],
      ['bash -l', 'bash'],
      ['/bin/zsh', 'zsh'],
      ['/usr/local/bin/fish -i', 'fish'],
      ['sh', 'sh'],
      ['pwsh', 'pwsh'],
    ] as const) {
      expect(resolveSubshellShell(command), command).toBe(want);
    }
  });

  it('마지막 인자가 셸이면 그 셸이다', () => {
    expect(resolveSubshellShell('docker exec -it web bash')).toBe('bash');
    expect(resolveSubshellShell('kubectl exec -it pod -- sh')).toBe('sh');
    expect(resolveSubshellShell('docker run -it alpine /bin/ash')).toBe('ash');
  });

  // 틀리게 짚는 것보다 모른다고 하는 편이 낫다 — 엉뚱한 문법을 보내면 오류가 화면에 남는다.
  it('명령에 대상 셸이 없으면 모른다고 한다', () => {
    for (const command of [
      'sudo su',
      'su - deploy',
      'ssh host',
      'sudo -i',
      'docker exec -it web',
      'nix-shell',
      '',
    ]) {
      expect(resolveSubshellShell(command), command).toBe('');
    }
  });

  // 중간 인자가 우연히 셸 이름과 같아도 끌려가지 않는다.
  it('중간 인자는 보지 않는다', () => {
    expect(resolveSubshellShell('docker exec -it bash-runner env')).toBe('');
  });
});
