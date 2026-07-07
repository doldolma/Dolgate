import { describe, expect, it } from "vitest";
import type { HostRecord, TerminalTab } from "@shared";
import { AI_RECENT_OUTPUT_LINES, buildAiSessionContext, buildHostContext } from "./ai-session-context";

const tab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: "s1",
  stableId: "stable-1",
  sessionId: "s1",
  source: "host",
  hostId: "host-1",
  title: "Prod",
  status: "connected",
  sessionShare: null,
  lastEventAt: "2026-07-07T00:00:00.000Z",
  ...overrides,
});

const sshHost = (overrides: Partial<Extract<HostRecord, { kind: "ssh" }>> = {}) =>
  ({
    id: "host-1",
    kind: "ssh",
    label: "Prod SSH",
    hostname: "prod.example.com",
    port: 22,
    username: "ubuntu",
    authType: "privateKey",
    privateKeyPath: "/Users/alice/.ssh/prod.pem",
    certificatePath: "/Users/alice/.ssh/prod-cert.pub",
    secretRef: "host:secret-ref",
    jumpHostIds: ["jump-1", "jump-2"],
    groupName: "Servers",
    tags: ["prod"],
    terminalThemeId: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  }) satisfies HostRecord;

describe("ai-session-context", () => {
  it("summarizes useful SSH host metadata without secret-bearing fields", () => {
    const summary = buildHostContext(tab(), sshHost());

    expect(summary).toContain("title: Prod");
    expect(summary).toContain("label: Prod SSH");
    expect(summary).toContain("address: ubuntu@prod.example.com:22");
    expect(summary).toContain("authType: privateKey");
    expect(summary).toContain("jumpHosts: 2 configured");

    expect(summary).not.toContain("secret-ref");
    expect(summary).not.toContain("prod.pem");
    expect(summary).not.toContain("prod-cert.pub");
  });

  it("includes AWS EC2 details and redacted recent terminal output", () => {
    const host = {
      id: "aws-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileName: "default",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-123",
      awsAvailabilityZone: "ap-northeast-2a",
      awsInstanceName: "prod-web",
      awsPlatform: "Linux/UNIX",
      awsPrivateIp: "10.0.0.20",
      awsState: "running",
      awsSshUsername: "ubuntu",
      awsSshPort: 22,
      awsSsmServerProxyEnabled: true,
      groupName: null,
      terminalThemeId: null,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    } satisfies HostRecord;

    const context = buildAiSessionContext({
      tab: tab({ hostId: "aws-1", title: "AWS Prod" }),
      host,
      recentTerminalText: "export OPENAI_API_KEY=sk-abcdef1234567890\nuptime",
    });

    expect(context).toContain("호스트 정보:");
    expect(context).toContain("kind: aws-ec2");
    expect(context).toContain("instanceId: i-123");
    expect(context).toContain("privateIp: 10.0.0.20");
    expect(context).toContain("ssmServerProxy: yes");
    expect(context).toContain(`최근 터미널 출력 (최근 ${AI_RECENT_OUTPUT_LINES}줄):`);
    expect(context).toContain("sk-***");
    expect(context).not.toContain("abcdef1234567890");
  });

  it("returns undefined when there is no host, tab, or terminal context", () => {
    expect(
      buildAiSessionContext({
        tab: null,
        host: null,
        recentTerminalText: "",
      }),
    ).toBeUndefined();
  });
});
