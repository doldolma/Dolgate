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
