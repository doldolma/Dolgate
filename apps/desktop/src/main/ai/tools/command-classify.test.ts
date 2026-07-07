import { describe, expect, it } from "vitest";
import { looksDestructive } from "./command-classify";

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
