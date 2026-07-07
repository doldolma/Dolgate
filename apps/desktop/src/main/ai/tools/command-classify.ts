// 명령이 "명백히 파괴적/위험"한지 판정하는 seatbelt.
//
// 중요: 완벽한 분류가 아니라 대표적 위험 명령만 잡는 안전장치다(진짜 방어선은 UX 구조 —
// 변경은 run_in_terminal 로 사용자가 보고 승인, 조회는 inspect_command). 읽기 파이프라인/루프/
// 치환(`ps aux | grep`, `for … do cat …; done`, `docker ps | grep`, `2>/dev/null`)은 통과시키고,
// 직접적인 파괴 명령·파일 쓰기·권한상승만 true 로 잡는다.
//  - run_in_terminal: true → 승인 필요(사용자가 보고 승인), false → 바로 실행.
//  - inspect_command: true → 실행 거부(run_in_terminal 로 유도), false → 조회 실행.

const DESTRUCTIVE_FIRST_TOKENS = new Set([
  "rm", "rmdir", "unlink", "mv", "dd", "shred", "truncate", "mkfs", "mkswap", "fdisk", "parted",
  "sgdisk", "wipefs", "tee", "chmod", "chown", "chgrp", "chattr", "ln", "mount", "umount",
  "swapon", "swapoff", "reboot", "shutdown", "halt", "poweroff", "init", "telinit",
  "kill", "pkill", "killall", "systemctl", "service", "rc-service", "initctl",
  "apt", "apt-get", "aptitude", "yum", "dnf", "zypper", "apk", "pacman", "emerge", "brew", "snap",
  "pip", "pip3", "gem", "npm", "yarn", "pnpm", "cargo", "crontab", "useradd", "userdel", "usermod",
  "groupadd", "passwd", "chpasswd", "visudo", "iptables", "ip6tables", "nft", "ufw", "firewall-cmd",
  "ipset", "mknod", "modprobe", "insmod", "rmmod", "sudo", "doas", "su",
]);

// 파이프/치환 안에 숨어도 잡는 위치-무관 파국 패턴.
const CATASTROPHIC = [
  /\brm\s+-\w*[rf]/, /\bmkfs\b/, /\bdd\b[^|;&\n]*\bof=/, /\bshutdown\b/, /\breboot\b/,
  /\bhalt\b/, /\bpoweroff\b/, />\s*\/dev\/(sd|nvme|mmc|vd|disk)/,
];

// 다른 명령을 감싸는(권한상승 아님) 래퍼 — 건너뛰고 감싼 명령을 검사.
const NON_ESCALATION_WRAPPERS = new Set([
  "env", "command", "nohup", "setsid", "nice", "ionice", "stdbuf", "timeout", "time", "watch", "xargs",
]);

// 파괴/변경/권한상승 가능성이 큰 명령인지. (읽기/조회성 명령은 false)
export function looksDestructive(command: string): boolean {
  const lower = command.toLowerCase();
  if (CATASTROPHIC.some((re) => re.test(lower))) {
    return true;
  }
  // 파일 쓰기 리다이렉트(>, >>) — /dev/null 로 버리거나 fd 병합(2>&1)은 제외.
  const stripped = command
    .replace(/\d*>>?\s*\/dev\/null/g, "")
    .replace(/&>>?\s*\/dev\/null/g, "")
    .replace(/\d*>&\d*/g, "");
  if (/>>?/.test(stripped)) {
    return true;
  }
  if (/\b(sed|perl)\b[^|;&\n]*\s-i\b/.test(lower)) {
    return true;
  }
  if (/\bfind\b[^|;&\n]*(-delete|-exec|-execdir)\b/.test(lower)) {
    return true;
  }
  if (/\bgit\s+(commit|push|reset|checkout|clean|rm|merge|rebase|stash|cherry-pick|revert|apply|am)\b/.test(lower)) {
    return true;
  }
  if (/\b(docker|podman)\s+(run|rm|rmi|stop|start|restart|kill|build|exec|prune|create|push|pull|load|import|tag|commit|volume|network|compose)\b/.test(lower)) {
    return true;
  }
  if (/\bkubectl\s+(apply|delete|create|edit|scale|patch|replace|rollout|drain|cordon|uncordon|label|annotate|taint)\b/.test(lower)) {
    return true;
  }
  // 각 파이프라인 세그먼트(치환 경계 포함)의 첫 명령이 파괴 목록에 있는지.
  for (const segment of command.split(/\||;|&&|\|\||\n|`|\$\(/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (
      index < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/.test(tokens[index]) ||
        NON_ESCALATION_WRAPPERS.has(tokens[index].split("/").pop() ?? ""))
    ) {
      index += 1;
    }
    const base = (tokens[index] ?? "").split("/").pop() ?? "";
    if (DESTRUCTIVE_FIRST_TOKENS.has(base)) {
      return true;
    }
  }
  return false;
}

// 첫 명령 세그먼트의 첫 실행 토큰(환경변수·래퍼 건너뜀, basename).
function firstCommandToken(command: string): string {
  const segment = command.split(/\||;|&&|\|\||\n/)[0] ?? "";
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (
    index < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/.test(tokens[index]) ||
      NON_ESCALATION_WRAPPERS.has(tokens[index].split("/").pop() ?? ""))
  ) {
    index += 1;
  }
  return (tokens[index] ?? "").split("/").pop() ?? "";
}

// TTY 가 있어야 하거나 끝나지 않는(대화형/스트리밍) 명령 — 항상 대화형.
const ALWAYS_INTERACTIVE = new Set([
  "top", "htop", "watch", "vim", "vi", "nano", "emacs", "less", "more", "man", "ssh", "telnet",
  "tmux", "screen",
]);
// 인자 없이 단독 실행하면 대화형 REPL 로 뜨는 것(스크립트/-c/-e 가 있으면 아님).
const REPL_WHEN_BARE = new Set([
  "mysql", "psql", "redis-cli", "mongo", "mongosh", "sqlite3", "python", "python3", "node", "irb",
  "ftp", "sftp",
]);

// inspect_command(숨은 exec) 로 돌리면 채널이 물리는(끝나지 않거나 TTY 필요) 명령인지.
// true 면 inspect 대신 run_in_terminal(사용자가 보고 Ctrl-C 가능) 로 보내야 한다.
export function isLongRunningOrInteractive(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  // 로그 follow/스트리밍(-f/--follow) — grep -f 같은 오탐을 피하려고 스트리밍 명령과 함께일 때만.
  if (/\b(tail|journalctl)\b[^|;&\n]*(\s-f\b|\s--follow\b)/.test(lower)) {
    return true;
  }
  if (/\b(docker|podman|kubectl)\b[^|;&\n]*\blogs\b[^|;&\n]*(-f\b|--follow\b)/.test(lower)) {
    return true;
  }
  // watch 는 반복 실행(장기)이라 잡아야 하는데 NON_ESCALATION_WRAPPERS 에 있어 firstCommandToken 이
  // 건너뛴다 → 래퍼 skip 전 원시 첫 토큰(환경변수만 제외)으로 확인.
  const rawTokens = trimmed.split(/\s+/).filter(Boolean);
  let raw = 0;
  while (raw < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/.test(rawTokens[raw])) {
    raw += 1;
  }
  const rawFirst = (rawTokens[raw] ?? "").split("/").pop() ?? "";
  if (rawFirst === "watch") {
    return true;
  }
  const first = firstCommandToken(trimmed);
  if (ALWAYS_INTERACTIVE.has(first)) {
    return true;
  }
  // REPL 은 인자 없이 단독일 때만(예: `python` → REPL, `python x.py` → 정상 실행).
  if (REPL_WHEN_BARE.has(first) && rawTokens.length - raw === 1) {
    return true;
  }
  return false;
}
