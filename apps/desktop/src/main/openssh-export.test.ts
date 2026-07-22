import { describe, expect, it } from "vitest";
import type { HostRecord } from "@shared";
import { buildOpenSshConfig } from "./openssh-export";

const timestamp = "2026-07-22T00:00:00.000Z";

function sshHost(
  id: string,
  label: string,
  hostname: string,
  jumpHostIds: string[] = [],
): HostRecord {
  return {
    id,
    kind: "ssh",
    label,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    hostname,
    port: 22,
    username: "ubuntu",
    authType: "privateKey",
    secretRef: `secret:${id}`,
    jumpHostId: jumpHostIds[0] ?? null,
    jumpHostIds,
    agentForwarding: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("buildOpenSshConfig", () => {
  it("includes SSH jump dependencies, Warpgate hosts, and no credentials", () => {
    const hosts: HostRecord[] = [
      sshHost("jump-1", "Bastion", "bastion.example.com"),
      sshHost("host-1", "Production API", "api.internal", ["jump-1"]),
      {
        id: "warp-1",
        kind: "warpgate-ssh",
        label: "Warpgate DB",
        groupName: null,
        tags: [],
        terminalThemeId: null,
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "database",
        warpgateUsername: "operator",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "ec2-1",
        kind: "aws-ec2",
        label: "EC2 API",
        groupName: null,
        tags: [],
        terminalThemeId: null,
        awsProfileId: "profile-1",
        awsProfileName: "prod",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-123",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];

    const result = buildOpenSshConfig(hosts, ["host-1", "warp-1", "ec2-1"]);

    expect(result.exportedRootCount).toBe(2);
    expect(result.dependencyCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.content).toContain("Host Bastion");
    expect(result.content).toContain("ProxyJump Bastion");
    expect(result.content).toContain("User operator:database");
    expect(result.content).toContain("PreferredAuthentications keyboard-interactive");
    expect(result.content).not.toContain("IdentityFile");
    expect(result.content).not.toContain("secret:host-1");
  });

  it("skips a target when its jump host is not OpenSSH-compatible", () => {
    const target = sshHost("host-1", "API", "api.internal", ["serial-1"]);
    const serial: HostRecord = {
      id: "serial-1",
      kind: "serial",
      label: "Console",
      groupName: null,
      tags: [],
      terminalThemeId: null,
      transport: "local",
      devicePath: "/dev/ttyUSB0",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      transmitLineEnding: "none",
      localEcho: false,
      localLineEditing: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const result = buildOpenSshConfig([target, serial], [target.id]);

    expect(result.content).toBe("");
    expect(result.skippedCount).toBe(1);
    expect(result.warnings[0]).toContain("점프 호스트");
  });
});
