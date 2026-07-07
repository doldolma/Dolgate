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
