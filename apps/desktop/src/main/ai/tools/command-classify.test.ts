import { describe, expect, it } from "vitest";
import { isLongRunningOrInteractive, looksDestructive } from "./command-classify";

describe("looksDestructive", () => {
  it("allows read-only commands, pipelines, loops, substitutions and /dev/null redirects", () => {
    for (const command of [
      "ls -la /var",
      "cat /etc/hostname",
      "df -h",
      "ps aux | grep nginx",
      "docker ps -a | grep -i plex",
      "docker logs --tail 100 plex",
      "for d in /sys/block/sd*; do cat $d/queue/rotational 2>/dev/null; done",
      "cat /proc/cpuinfo | head -n 40",
      "ls -la /dev/disk/by-id/ 2>/dev/null",
      'echo "=== $(basename /dev/sda) ==="',
      "grep -rn 'error' /var/log/syslog 2>/dev/null | tail -n 20",
    ]) {
      expect(looksDestructive(command), command).toBe(false);
    }
  });

  it("flags destructive, mutating and escalation commands", () => {
    for (const command of [
      "rm -rf /data",
      "rm a",
      "mv a b",
      "sudo cat /etc/shadow",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb1",
      "systemctl restart nginx",
      "docker rm -f web",
      "docker restart plex",
      "git commit -m x",
      "echo hi > /etc/motd",
      "sed -i s/a/b/ f",
      "find . -delete",
      "echo $(rm -rf /tmp/x)",
      "tee /etc/hosts",
      "apt install nginx",
      "reboot",
    ]) {
      expect(looksDestructive(command), command).toBe(true);
    }
  });
});

describe("isLongRunningOrInteractive", () => {
  it("flags streaming/follow and interactive/TTY commands", () => {
    for (const command of [
      "tail -f /var/log/syslog",
      "journalctl -f",
      "journalctl -u nginx -f",
      "docker logs -f plex",
      "docker logs --follow plex",
      "kubectl logs -f pod",
      "watch -n1 df -h",
      "top",
      "htop",
      "vim /etc/hosts",
      "less /var/log/big.log",
      "man ssh",
      "python",
      "psql",
    ]) {
      expect(isLongRunningOrInteractive(command), command).toBe(true);
    }
  });

  it("allows bounded read-only commands (no false positives)", () => {
    for (const command of [
      "tail -n 100 /var/log/syslog",
      "journalctl -n 50",
      "docker logs --tail 100 plex",
      "ls -la",
      "df -h",
      "grep -f patterns.txt file",
      "python analyze.py",
      "psql -c 'select 1'",
    ]) {
      expect(isLongRunningOrInteractive(command), command).toBe(false);
    }
  });
});
