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

// bash/zsh 의 `exec [-cl] [-a name] command …`. 값이 따라오는 옵션은 -a 하나다.
const EXEC_VALUE_FLAGS = new Set(['-a']);

// `exec <shell>` 은 지금 셸 프로세스를 그 셸로 **갈아탄다.** 훅은 프로세스와 함께 사라지는데
// tmux 의 "이미 심어짐" 표식은 pane 에 붙어 있어 그대로 남으므로, 새 셸이 떠도 코어는 재연결마다
// 이미 깔린 것으로 보고 다시 심지 않았다 — 통합이 그 pane 에서 영영 죽었다. 여기서 `exec` 와 그
// 옵션을 벗겨 나머지를 원래 판정에 태우면, 셸이면 잡히고(→ 재주입) 아니면 안 잡힌다.
// `exec 3>file` 처럼 명령 없는 리다이렉션 전용 exec 는 남는 것이 셸 이름이 아니라 자연히 걸러진다.
function stripExecPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== 'exec') return command.trim();
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index];
    index += 1;
    if (EXEC_VALUE_FLAGS.has(flag) && index < tokens.length) index += 1;
  }
  return tokens.slice(index).join(' ');
}

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
  // 앞머리(sudo/doas, exec)를 벗긴 형태들을 후보로 모은다. 두 종류가 어느 순서로 겹쳐도
  // (`exec sudo -i`, `sudo … exec …`) 다 보이도록, 더 벗겨질 것이 없을 때까지 반복한다.
  // 벗기면 문자열이 짧아지거나 그대로이므로(그대로면 중복으로 버림) 반드시 끝난다.
  const rawCandidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rawCandidates.push(normalized);
  };
  pushCandidate(trimmed);
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const candidate = rawCandidates[index];
    pushCandidate(stripPrivilegePrefix(candidate));
    pushCandidate(stripExecPrefix(candidate));
  }

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
