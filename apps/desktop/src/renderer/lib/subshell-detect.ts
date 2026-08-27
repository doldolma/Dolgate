// Detects when an executed terminal command enters a subshell — a nested shell
// process that does NOT carry Dolgate's OSC 133/OSC 7 hooks (nested ssh, mosh,
// sudo su, su, another bash/zsh/fish, docker/podman/kubectl exec, toolbox, …).
// Inside such a subshell command status icons and cwd go stale, so a match
// triggers shell-integration re-injection into the foreground shell.
//
// Matching is intentionally conservative and prefix-anchored: a false negative
// just means integration is not re-established (status stays as-is), while a
// false positive only causes a harmless idempotent re-injection attempt.

const DEFAULT_SUBSHELL_PATTERNS: readonly RegExp[] = [
  /^ssh(\s|$)/, // remote shell — not ssh-add / ssh-keygen / sshpass
  /^mosh(\s|$)/,
  /^sudo\s+(-i|-s|su)(\s|$)/, // sudo -i | sudo -s | sudo su
  /^su(\s|$)/, // su | su - | su <user>
  /^(ba|z|fi)?sh(\s|$)/, // sh | bash | zsh | fish (nested interactive shell)
  /^docker\s+(exec|run)(\s|$)/,
  /^podman\s+(exec|run)(\s|$)/,
  /^kubectl\s+exec(\s|$)/,
  /^(toolbox|distrobox)\s+enter(\s|$)/,
  /^nix-shell(\s|$)/,
  // 윈도우에서 들어가는 서브셸들. `wsl` 안은 리눅스 셸(bash·zsh)이라 POSIX 스크립트가 맞고,
  // `pwsh`·`powershell` 은 그 셸 전용 한 줄이 나간다.
  /^wsl(\s|$)/,
  /^(pwsh|powershell)(\s|$)/,
];

/**
 * `sudo` 로 시작하면 그것과 옵션을 걷어낸 나머지를 돌려준다. 아니면 원문 그대로.
 *
 * 왜 필요한가: 소켓 권한이 없는 호스트에서는 우리가 넣는 명령이 `sudo docker exec …` 가 된다.
 * 패턴은 앞에서부터 맞추므로 `docker` 로 시작하지 않으면 하나도 걸리지 않아, 컨테이너에
 * 들어가도 통합이 안 붙었다(명령 상태가 회색으로 굳는다).
 *
 * 값을 받는 옵션(-u user 등)은 그 값까지 함께 건너뛴다.
 */
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-T', '--user']);

function stripPrivilegePrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== 'sudo' && tokens[0] !== 'doas') {
    return command.trim();
  }
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index];
    index += 1;
    if (SUDO_VALUE_FLAGS.has(flag) && index < tokens.length) {
      index += 1;
    }
  }
  return tokens.slice(index).join(' ');
}

/**
 * Reports whether `command` (the raw line the user just ran) enters a subshell
 * that needs shell-integration re-injection. `customPatterns` are user-provided
 * regex sources (from settings); invalid patterns are ignored.
 */
export function detectsSubshellEntry(
  command: string,
  customPatterns: readonly string[] = [],
): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  // 원문과 `sudo` 를 걷어낸 것 둘 다 본다 — `sudo -i` 는 원문이, `sudo docker exec` 는 걷어낸
  // 쪽이 걸린다.
  const candidates = [trimmed];
  const stripped = stripPrivilegePrefix(trimmed);
  if (stripped && stripped !== trimmed) {
    candidates.push(stripped);
  }
  for (const pattern of DEFAULT_SUBSHELL_PATTERNS) {
    if (candidates.some((candidate) => pattern.test(candidate))) {
      return true;
    }
  }
  for (const source of customPatterns) {
    if (!source.trim()) {
      continue;
    }
    try {
      const pattern = new RegExp(source);
      if (candidates.some((candidate) => pattern.test(candidate))) {
        return true;
      }
    } catch {
      // Ignore invalid user-supplied regex rather than throwing on every command.
    }
  }
  return false;
}
