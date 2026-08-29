const DEFAULT_SUBSHELL_PATTERNS: readonly RegExp[] = [
  /^ssh(\s|$)/,
  /^mosh(\s|$)/,
  /^sudo\s+(-i|-s|su)(\s|$)/,
  /^su(\s|$)/,
  /^(ba|z|fi)?sh(\s|$)/,
  /^docker\s+(exec|run)(\s|$)/,
  /^podman\s+(exec|run)(\s|$)/,
  /^kubectl\s+exec(\s|$)/,
  /^(toolbox|distrobox)\s+enter(\s|$)/,
  /^nix-shell(\s|$)/,
  /^wsl(\s|$)/,
  /^(pwsh|powershell)(\s|$)/,
];

export type SubshellShellHint = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'powershell';

export interface SubshellEntryDetection {
  shellHint?: SubshellShellHint;
}

interface InvocationCandidate {
  command: string;
  shellHint?: SubshellShellHint;
}

const DIRECT_SHELL_HINTS: Readonly<Record<string, SubshellShellHint>> = {
  bash: 'bash',
  zsh: 'zsh',
  fish: 'fish',
  pwsh: 'pwsh',
  powershell: 'powershell',
};

function normalizeInvocation(command: string): InvocationCandidate | null {
  let remaining = command.trim();
  let hasPowerShellCallOperator = false;
  if (remaining.startsWith('&')) {
    hasPowerShellCallOperator = true;
    remaining = remaining.slice(1).trimStart();
  }
  if (!remaining) return null;

  let executable = '';
  let rest = '';
  const quote = remaining[0];
  if (quote === '"' || quote === "'") {
    let closingQuote = -1;
    for (let index = 1; index < remaining.length; index += 1) {
      if (
        remaining[index] === quote &&
        remaining[index - 1] !== '`' &&
        remaining[index - 1] !== '\\'
      ) {
        closingQuote = index;
        break;
      }
    }
    if (closingQuote < 0) return null;
    executable = remaining.slice(1, closingQuote);
    rest = remaining.slice(closingQuote + 1);
    if (!hasPowerShellCallOperator && /^[a-z]:\\/i.test(executable))
      return null;
  } else {
    const match = /^(\S+)([\s\S]*)$/.exec(remaining);
    if (!match) return null;
    executable = match[1];
    rest = match[2];
  }

  const basename =
    executable.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const name = basename.replace(/\.exe$/i, '').toLowerCase();
  if (!name) return null;
  return {
    command: `${name}${rest}`.trim(),
    shellHint: DIRECT_SHELL_HINTS[name],
  };
}

const SUDO_VALUE_FLAGS = new Set([
  '-u',
  '-g',
  '-p',
  '-C',
  '-h',
  '-r',
  '-t',
  '-T',
  '--user',
]);

function stripPrivilegePrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== 'sudo' && tokens[0] !== 'doas') return command.trim();
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index];
    index += 1;
    if (SUDO_VALUE_FLAGS.has(flag) && index < tokens.length) index += 1;
  }
  return tokens.slice(index).join(' ');
}

export function detectSubshellEntry(
  command: string,
  customPatterns: readonly string[] = [],
): SubshellEntryDetection | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const rawCandidates = [trimmed];
  const stripped = stripPrivilegePrefix(trimmed);
  if (stripped && stripped !== trimmed) rawCandidates.push(stripped);

  const candidates: InvocationCandidate[] = [];
  for (const candidate of rawCandidates) {
    const normalized = normalizeInvocation(candidate);
    if (normalized) candidates.push(normalized);
    if (!normalized || normalized.command !== candidate)
      candidates.push({ command: candidate });
  }
  for (const candidate of candidates) {
    if (
      DEFAULT_SUBSHELL_PATTERNS.some(pattern => pattern.test(candidate.command))
    ) {
      return candidate.shellHint ? { shellHint: candidate.shellHint } : {};
    }
  }
  for (const source of customPatterns) {
    if (!source.trim()) continue;
    try {
      const pattern = new RegExp(source);
      const candidate = candidates.find(value => pattern.test(value.command));
      if (candidate)
        return candidate.shellHint ? { shellHint: candidate.shellHint } : {};
    } catch {
      // Invalid custom patterns are ignored at runtime.
    }
  }
  return null;
}

export function detectsSubshellEntry(
  command: string,
  customPatterns: readonly string[] = [],
): boolean {
  return detectSubshellEntry(command, customPatterns) !== null;
}
