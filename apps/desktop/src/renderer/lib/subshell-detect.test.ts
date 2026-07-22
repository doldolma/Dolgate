import { describe, expect, it } from 'vitest';
import { detectsSubshellEntry } from './subshell-detect';

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
