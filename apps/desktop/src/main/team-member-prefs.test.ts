import type { HostDraft, HostRecord, SavedWorkspaceRecord } from "@shared";
import { describe, expect, it } from "vitest";
import {
  normalizeTeamAwsProfileCredentials,
  normalizeTeamTailnetCredentials,
  overlayHostMemberPrefs,
  overlayWorkspaceMemberPrefs,
  splitHostDraftMemberPrefs,
  stripHostMemberPrefs,
  stripWorkspaceMemberPrefs,
  type TeamMemberPrefs,
} from "./team-member-prefs";

// 팀 레코드에 실리면 팀원 모두에게 가는 값들이다. 빼는 곳·얹는 곳이 이 모듈 하나라 여기서 지킨다.

const BASE = {
  label: "box",
  groupName: "ops",
  tags: ["prod"],
  favorite: true,
  terminalThemeId: "dolssh-dark",
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

const HOSTS = {
  ssh: { ...BASE, id: "ssh", kind: "ssh", hostname: "h", port: 22, username: "u", authType: "agent", agentForwarding: true },
  ec2: { ...BASE, id: "ec2", kind: "aws-ec2", awsProfileName: "p", awsRegion: "r", awsInstanceId: "i", agentForwarding: true },
  rdp: { ...BASE, id: "rdp", kind: "rdp", hostname: "w", port: 3389 },
} as unknown as Record<"ssh" | "ec2" | "rdp", HostRecord>;

const NO_PREFS: TeamMemberPrefs = { hosts: new Map(), workspaces: new Map(), terminalThemeByHostId: {} };

describe("team member prefs", () => {
  it("strips favorite, theme and agent forwarding from team host records and keeps the rest", () => {
    for (const host of Object.values(HOSTS)) {
      const stripped = stripHostMemberPrefs(host);
      expect(stripped).toMatchObject({ favorite: null, terminalThemeId: null, label: "box", groupName: "ops", tags: ["prod"] });
      if (host.kind === "rdp") {
        // 그 칸이 없는 종류에 새로 만들지 않는다.
        expect(stripped).not.toHaveProperty("agentForwarding");
      } else {
        expect(stripped).toHaveProperty("agentForwarding", null);
      }
    }
  });

  it("lays only my own values over a team host, whatever the record carried", () => {
    const prefs: TeamMemberPrefs = {
      hosts: new Map([["ssh", { id: "ssh", favorite: null, agentForwarding: true, updatedAt: "t" }]]),
      workspaces: new Map(),
      terminalThemeByHostId: { ec2: "kanagawa-wave" },
    };

    expect(overlayHostMemberPrefs(HOSTS.ssh, prefs)).toMatchObject({
      favorite: null,
      agentForwarding: true,
      terminalThemeId: null,
    });
    expect(overlayHostMemberPrefs(HOSTS.ec2, prefs)).toMatchObject({
      favorite: null,
      agentForwarding: null,
      terminalThemeId: "kanagawa-wave",
    });
    expect(overlayHostMemberPrefs(HOSTS.rdp, NO_PREFS)).not.toHaveProperty("agentForwarding");
    expect(overlayHostMemberPrefs(stripHostMemberPrefs(HOSTS.ssh), NO_PREFS)).toEqual(stripHostMemberPrefs(HOSTS.ssh));
  });

  it("splits a host edit into what goes to the team and what stays mine", () => {
    const draft = {
      kind: "ssh",
      label: "box",
      hostname: "h",
      port: 22,
      username: "u",
      authType: "agent",
      agentForwarding: true,
      terminalThemeId: "night-owl",
    } as HostDraft;

    expect(splitHostDraftMemberPrefs(draft)).toEqual({
      teamDraft: { ...draft, agentForwarding: null, terminalThemeId: null },
      hostPrefs: { agentForwarding: true },
      terminalThemeId: "night-owl",
    });

    const rdpDraft = { kind: "rdp", label: "w", hostname: "w", port: 3389 } as HostDraft;
    expect(splitHostDraftMemberPrefs(rdpDraft)).toEqual({
      teamDraft: { ...rdpDraft, terminalThemeId: null },
      hostPrefs: {},
      terminalThemeId: null,
    });
  });

  it("strips and overlays a workspace's favorite and last opened time", () => {
    const workspace = {
      version: 1,
      id: "ws",
      name: "Ops",
      favorite: true,
      lastOpenedAt: "2026-10-19T03:00:00.000Z",
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    } as SavedWorkspaceRecord;

    expect(stripWorkspaceMemberPrefs(workspace)).toMatchObject({ name: "Ops", favorite: false, lastOpenedAt: null });
    expect(overlayWorkspaceMemberPrefs(workspace, NO_PREFS)).toMatchObject({ favorite: false, lastOpenedAt: null });
    expect(
      overlayWorkspaceMemberPrefs(workspace, {
        ...NO_PREFS,
        workspaces: new Map([["ws", { id: "ws", favorite: true, lastOpenedAt: "2026-10-19T05:00:00.000Z", updatedAt: "t" }]]),
      }),
    ).toMatchObject({ favorite: true, lastOpenedAt: "2026-10-19T05:00:00.000Z" });
  });

  // 내 키는 정적 프로필의 키를 통째로 갈아 끼운다 — 한쪽만 있는 것을 받으면 팀 키를 반쪽으로 덮어 못 붙는다.
  it("takes my AWS keys only as a full pair and my auth key only when it is there", () => {
    expect(normalizeTeamAwsProfileCredentials({ accessKeyId: " AKIAMINE ", secretAccessKey: " mine " })).toEqual({
      accessKeyId: "AKIAMINE",
      secretAccessKey: "mine",
    });
    expect(normalizeTeamAwsProfileCredentials({ accessKeyId: "AKIAMINE", secretAccessKey: "" })).toBeNull();
    expect(normalizeTeamAwsProfileCredentials({ accessKeyId: "", secretAccessKey: "mine" })).toBeNull();
    expect(normalizeTeamTailnetCredentials({ authKey: " tskey-mine " })).toEqual({ authKey: "tskey-mine" });
    expect(normalizeTeamTailnetCredentials({ authKey: "  " })).toBeNull();
  });
});
