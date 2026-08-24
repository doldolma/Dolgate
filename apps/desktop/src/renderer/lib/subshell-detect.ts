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
];

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
  for (const pattern of DEFAULT_SUBSHELL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  for (const source of customPatterns) {
    if (!source.trim()) {
      continue;
    }
    try {
      if (new RegExp(source).test(trimmed)) {
        return true;
      }
    } catch {
      // Ignore invalid user-supplied regex rather than throwing on every command.
    }
  }
  return false;
}

// 셸 이름으로 볼 수 있는 것들. 통합 스크립트가 셸마다 다르므로(POSIX·fish·pwsh) 이름을 알면
// 그 셸 것만 보낼 수 있다 — 모르면 bash·zsh 겸용을 보내는데, fish 에 그것을 보내면 문법 오류가
// 화면에 뜬다(실제로 그렇게 동작하고 있었다).
const SHELL_NAMES = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ash',
  'ksh',
  'pwsh',
  'powershell',
]);

/** 인자에서 셸 이름을 뽑는다. 경로·확장자·로그인 대시를 걷어낸 뒤 판정한다. */
function shellNameOf(token: string): string {
  const base = token
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
  return base && SHELL_NAMES.has(base) ? base : '';
}

/**
 * 서브셸 진입 명령에서 **어떤 셸로 들어가는지**를 알아낸다. 모르면 빈 문자열.
 *
 * 알면 그 셸 전용 스크립트 한 줄로 끝난다. 모르면 호출부가 겸용(여러 줄)을 보낸다 — 되도록
 * 알아내는 편이 좋지만, 틀리게 짚는 것보다는 모른다고 하는 편이 낫다(엉뚱한 셸에 엉뚱한 문법을
 * 보내면 오류가 화면에 남는다). 그래서 `sudo su`·`ssh host` 처럼 대상 셸이 명령에 없는 것은
 * 추측하지 않는다.
 */
export function resolveSubshellShell(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return '';
  }
  // `bash -l`, `/bin/zsh`, `fish` 처럼 명령 자체가 셸인 경우.
  const direct = shellNameOf(tokens[0]);
  if (direct) {
    return direct;
  }
  // `docker exec -it web bash`, `kubectl exec -it pod -- sh` 처럼 마지막이 셸인 경우.
  // 중간 인자(이미지·pod 이름)가 우연히 셸 이름과 같을 수 있으니 **마지막 토큰만** 본다.
  return shellNameOf(tokens[tokens.length - 1]);
}
