import { describe, expect, it } from "vitest";
import type { GroupRecord, HostRecord, SavedWorkspaceRecord, VaultIndex } from "@shared";
import { createEmptyVaultIndex } from "../../store/utils";
import { buildBrowserVaults, groupTreeKey, pathOfGroupTreeKey } from "./browserVaults";

// 사이드바 맨 윗단의 볼트 — 레코드를 볼트별로 나누고, 팀이 없으면 아무것도 만들지 않는다(지금 화면 그대로).

const host = (id: string, groupName: string | null = null) =>
  ({ id, label: id, groupName }) as unknown as HostRecord;
const workspace = (id: string) => ({ id, name: id, groupName: null }) as unknown as SavedWorkspaceRecord;
const group = (path: string) => ({ id: `g-${path}`, name: path, path, parentPath: null }) as GroupRecord;

function index(overrides: Partial<VaultIndex> = {}): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      { id: "team-1", name: "Acme Infra", role: "owner", syncState: "ready", syncError: null, groups: [group("Prod")] },
      { id: "team-2", name: "Ops Night", role: "member", syncState: "needs-rejoin", syncError: null, groups: [] },
    ],
    teamIdByHostId: { "team-web": "team-1" },
    teamIdByWorkspaceId: { "team-ws": "team-1" },
    ...overrides,
  };
}

describe("buildBrowserVaults", () => {
  it("makes no vaults without teams, so the home screen stays as it is", () => {
    expect(
      buildBrowserVaults({
        hosts: [host("a")],
        groups: [group("Prod")],
        savedWorkspaces: [],
        vaultIndex: createEmptyVaultIndex(),
        personalName: "Personal",
      }),
    ).toEqual([]);
    // 아직 읽지 못한 표(또는 모양이 다른 값)도 팀이 없는 것과 같다.
    expect(
      buildBrowserVaults({ hosts: [], groups: [], savedWorkspaces: [], vaultIndex: undefined, personalName: "Personal" }),
    ).toEqual([]);
  });

  it("puts personal first, then each team with only its own records", () => {
    const vaults = buildBrowserVaults({
      hosts: [host("my-web", "Prod"), host("team-web", "Prod")],
      groups: [group("Prod"), group("Home")],
      savedWorkspaces: [workspace("my-ws"), workspace("team-ws")],
      vaultIndex: index(),
      personalName: "Personal",
    });

    expect(vaults.map((vault) => [vault.id, vault.kind, vault.name])).toEqual([
      ["personal", "personal", "Personal"],
      ["team-1", "team", "Acme Infra"],
      ["team-2", "team", "Ops Night"],
    ]);
    const [personal, acme, ops] = vaults;
    expect(personal!.hosts.map((record) => record.id)).toEqual(["my-web"]);
    expect(personal!.workspaces.map((record) => record.id)).toEqual(["my-ws"]);
    expect(personal!.groups.map((record) => record.path)).toEqual(["Prod", "Home"]);
    expect(acme!.hosts.map((record) => record.id)).toEqual(["team-web"]);
    expect(acme!.workspaces.map((record) => record.id)).toEqual(["team-ws"]);
    expect(acme!.groups.map((record) => record.path)).toEqual(["Prod"]);
    expect(acme!.role).toBe("owner");
    // 막힌 팀만 표시가 있다.
    expect(acme!.blocked).toBeNull();
    expect(ops!.blocked).toBe("needs-rejoin");
  });

  it("marks a team whose data came from a newer version", () => {
    const vaults = buildBrowserVaults({
      hosts: [],
      groups: [],
      savedWorkspaces: [],
      vaultIndex: index({
        teams: [{ id: "team-1", name: "Acme", role: "member", syncState: "outdated", syncError: null, groups: [] }],
      }),
      personalName: "Personal",
    });
    expect(vaults[1]!.blocked).toBe("outdated");
  });
});

describe("groupTreeKey", () => {
  it("keeps personal paths as they are and sets team paths apart", () => {
    expect(groupTreeKey("personal", "Prod/web")).toBe("Prod/web");
    const teamKey = groupTreeKey("team-1", "Prod/web");
    expect(teamKey).not.toBe("Prod/web");
    expect(teamKey).not.toBe(groupTreeKey("team-2", "Prod/web"));

    expect(pathOfGroupTreeKey("Prod/web", "personal")).toBe("Prod/web");
    expect(pathOfGroupTreeKey(teamKey, "team-1")).toBe("Prod/web");
    // 다른 볼트의 키는 그 볼트의 것이 아니다.
    expect(pathOfGroupTreeKey(teamKey, "personal")).toBeNull();
    expect(pathOfGroupTreeKey(teamKey, "team-2")).toBeNull();
    expect(pathOfGroupTreeKey("Prod/web", "team-1")).toBeNull();
  });
});
