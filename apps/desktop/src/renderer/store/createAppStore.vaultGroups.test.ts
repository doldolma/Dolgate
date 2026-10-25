import { describe, expect, it, vi } from "vitest";
import type { GroupRecord, HostRecord, SavedWorkspaceRecord, VaultIndex } from "@shared";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { createEmptyVaultIndex } from "./utils";

// 지금 위치는 "볼트 + 경로"다. 팀 그룹을 쓰면 그 팀으로 가고, 쓴 뒤에는 목록과 볼트 표를 다시 읽는다.

const TEAM = "team-1";

function host(id: string, groupName: string | null): HostRecord {
  return { id, kind: "ssh", label: id, hostname: `${id}.example.com`, port: 22, username: "ubuntu", authType: "password", groupName, tags: [] } as unknown as HostRecord;
}

function group(id: string, path: string, sortRank?: number): GroupRecord {
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
  return { id, name: path.split("/").at(-1)!, path, parentPath, sortRank } as GroupRecord;
}

function teamIndex(): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      {
        id: TEAM,
        name: "Acme Infra",
        role: "owner",
        syncState: "ready",
        syncError: null,
        groups: [group("tg-prod", "Prod", 1), group("tg-bastion", "Bastion", 2)],
      },
    ],
    teamIdByHostId: { "team-web": TEAM, "team-api": TEAM },
  };
}

async function setup() {
  const api = createMockApi();
  const hosts = [host("my-web", "Prod"), host("team-web", "Prod"), host("team-api", "Bastion")];
  vi.mocked(api.hosts.list).mockResolvedValue(hosts);
  vi.mocked(api.groups.list).mockResolvedValue([group("pg-prod", "Prod")]);
  vi.mocked(api.teams.getVaultIndex).mockResolvedValue(teamIndex());
  const store = createAppStore(api);
  store.setState({ hosts, groups: [group("pg-prod", "Prod")], vaultIndex: teamIndex() });
  return { api, store };
}

describe("createAppStore vault locations and group writes", () => {
  it("moves between All, a vault's top and a group in a vault", async () => {
    const { store } = await setup();

    store.getState().navigateGroup(null, TEAM);
    expect(store.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: null });
    store.getState().navigateGroup("Prod", TEAM);
    expect(store.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: "Prod" });
    // 볼트를 안 주는 옛 호출: 경로가 있으면 개인, 없으면 All.
    store.getState().navigateGroup("Prod");
    expect(store.getState()).toMatchObject({ currentVaultId: "personal", currentGroupPath: "Prod" });
    store.getState().navigateGroup(null);
    expect(store.getState()).toMatchObject({ currentVaultId: null, currentGroupPath: null });
  });

  it("creates a group in a team under the current group only when that team is where you are", async () => {
    const { api, store } = await setup();
    vi.mocked(api.groups.create).mockResolvedValue(group("new", "Prod/web"));

    store.getState().navigateGroup("Prod", TEAM);
    await store.getState().createGroup("web", undefined, TEAM);
    expect(api.groups.create).toHaveBeenLastCalledWith("web", "Prod", TEAM);
    expect(api.teams.getVaultIndex).toHaveBeenCalled();
    // 팀 그룹은 개인 그룹 목록에 들어가지 않는다.
    expect(store.getState().groups.map((record) => record.path)).toEqual(["Prod"]);

    // 개인에 만들 때 팀의 지금 경로를 부모로 쓰지 않는다.
    vi.mocked(api.groups.create).mockResolvedValue(group("pg-new", "Home"));
    await store.getState().createGroup("Home");
    expect(api.groups.create).toHaveBeenLastCalledWith("Home", null);
  });

  it("renames, moves and removes a team group in that team, following the current path only in that team", async () => {
    const { api, store } = await setup();
    const mutation = { groups: [], hosts: [], savedWorkspaces: [] };
    vi.mocked(api.groups.rename).mockResolvedValue({ ...mutation, nextPath: "Live" } as never);
    vi.mocked(api.groups.move).mockResolvedValue({ ...mutation, nextPath: "Ops/Live" } as never);
    vi.mocked(api.groups.remove).mockResolvedValue(mutation as never);

    // 개인 Prod 에 있는 동안 팀 Prod 의 이름을 바꿔도 지금 경로는 그대로다.
    store.getState().navigateGroup("Prod", "personal");
    await store.getState().renameGroup("Prod", "Live", TEAM);
    expect(api.groups.rename).toHaveBeenCalledWith("Prod", "Live", TEAM);
    expect(store.getState().currentGroupPath).toBe("Prod");
    // 다시 읽는다 — 메인이 돌려준 팀 목록으로 개인 목록을 덮지 않는다.
    expect(api.hosts.list).toHaveBeenCalled();
    expect(api.savedWorkspaces.list).toHaveBeenCalled();
    expect(store.getState().hosts.map((record) => record.id).sort()).toEqual(["my-web", "team-api", "team-web"]);

    // 그 팀 안에 있으면 따라간다.
    store.getState().navigateGroup("Live", TEAM);
    await store.getState().moveGroup("Live", "Ops", TEAM);
    expect(api.groups.move).toHaveBeenCalledWith("Live", "Ops", TEAM);
    expect(store.getState().currentGroupPath).toBe("Ops/Live");

    await store.getState().removeGroup("Ops/Live", "delete-subtree", TEAM);
    expect(api.groups.remove).toHaveBeenCalledWith("Ops/Live", "delete-subtree", TEAM);
    expect(store.getState().currentGroupPath).toBe("Ops");
  });

  it("orders a team's groups among that team's siblings", async () => {
    const { api, store } = await setup();
    api.groups.setOrder = vi.fn().mockResolvedValue([]);

    await store.getState().reorderGroup("Bastion", null, 0, TEAM);

    // 형제는 그 팀의 Prod·Bastion 이다(개인 Prod 은 끼지 않는다).
    expect(api.groups.setOrder).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "tg-bastion" })]),
      TEAM,
    );
    expect(vi.mocked(api.groups.setOrder).mock.calls[0]![0].some((assignment) => assignment.id === "pg-prod")).toBe(false);
    expect(api.groups.move).not.toHaveBeenCalled();
  });

  it("keeps the team's hosts and workspaces when a personal group is renamed, moved or removed", async () => {
    const { api, store } = await setup();
    const workspace = (id: string) =>
      ({ id, name: id, favorite: false, groupName: "Prod" }) as unknown as SavedWorkspaceRecord;
    store.setState({
      savedWorkspaces: [workspace("my-ws"), workspace("team-ws")],
      vaultIndex: { ...teamIndex(), teamIdByWorkspaceId: { "team-ws": TEAM } },
    });
    // 메인은 개인 볼트의 목록만 돌려준다.
    const personalResult = (nextPath: string | null) =>
      ({
        groups: [group("pg-live", "Live")],
        hosts: [host("my-web", "Live")],
        savedWorkspaces: [{ ...workspace("my-ws"), groupName: "Live" }],
        nextPath,
      }) as never;
    vi.mocked(api.groups.rename).mockResolvedValue(personalResult("Live"));
    vi.mocked(api.groups.move).mockResolvedValue(personalResult("Live"));
    vi.mocked(api.groups.remove).mockResolvedValue(personalResult(null));

    const ids = () => ({
      hosts: store.getState().hosts.map((record) => record.id).sort(),
      workspaces: store.getState().savedWorkspaces.map((record) => record.id).sort(),
    });
    await store.getState().renameGroup("Prod", "Live");
    expect(ids()).toEqual({ hosts: ["my-web", "team-api", "team-web"], workspaces: ["my-ws", "team-ws"] });
    // 개인 것은 메인이 준 새 값으로 바뀐다.
    expect(store.getState().hosts.find((record) => record.id === "my-web")?.groupName).toBe("Live");
    await store.getState().moveGroup("Live", null);
    expect(ids()).toEqual({ hosts: ["my-web", "team-api", "team-web"], workspaces: ["my-ws", "team-ws"] });
    await store.getState().removeGroup("Live", "reparent-descendants");
    expect(ids()).toEqual({ hosts: ["my-web", "team-api", "team-web"], workspaces: ["my-ws", "team-ws"] });
  });

  it("does not count a team's group paths as personal siblings when ordering personal groups", async () => {
    const { api, store } = await setup();
    api.groups.setOrder = vi.fn().mockResolvedValue([group("pg-prod", "Prod", 1)]);
    store.setState({
      savedWorkspaces: [{ id: "team-ws", name: "team-ws", favorite: false, groupName: "Runbooks" } as never],
      vaultIndex: { ...teamIndex(), teamIdByWorkspaceId: { "team-ws": TEAM } },
    });

    // 팀 호스트 team-api 가 든 Bastion, 팀 워크스페이스가 든 Runbooks 는 개인 그룹이 아니다 — 개인 볼트에 빈 그룹을
    // 만들면 안 된다.
    await store.getState().reorderGroup("Prod", null, 0);

    expect(api.groups.create).not.toHaveBeenCalled();
    expect(store.getState().hosts.map((record) => record.id).sort()).toEqual(["my-web", "team-api", "team-web"]);
  });

  it("remembers which vault the SFTP host picker is in", async () => {
    const { store } = await setup();

    store.getState().navigateSftpHostGroup("right", "Prod", TEAM);
    expect(store.getState().sftp.rightPane).toMatchObject({ hostGroupPath: "Prod", hostVaultId: TEAM });
    // 볼트를 안 주면(맨 위·팀 없음) 볼트도 없다.
    store.getState().navigateSftpHostGroup("right", null);
    expect(store.getState().sftp.rightPane).toMatchObject({ hostGroupPath: null, hostVaultId: null });

    // 판을 로컬로 바꿨다 돌아오면 맨 위부터다.
    store.getState().navigateSftpHostGroup("right", "Prod", TEAM);
    await store.getState().setSftpPaneSource("right", "local").catch(() => undefined);
    await store.getState().setSftpPaneSource("right", "host").catch(() => undefined);
    expect(store.getState().sftp.rightPane).toMatchObject({ hostGroupPath: null, hostVaultId: null });
  });

  it("creates a new host in the vault you are in, and duplicates a host into its own vault", async () => {
    const { api, store } = await setup();
    vi.mocked(api.hosts.create).mockImplementation(async (draft) => ({ ...(draft as object), id: "new-host" }) as HostRecord);

    store.getState().navigateGroup("Prod", TEAM);
    store.getState().openCreateHostDrawer();
    expect(store.getState().hostDrawer).toEqual({ mode: "create", defaultGroupPath: "Prod", kind: "ssh", vaultId: TEAM });
    // 볼트 줄 메뉴처럼 볼트·그룹을 정해서 열 수도 있다.
    store.getState().openCreateHostDrawer({ vaultId: "personal", groupPath: null });
    expect(store.getState().hostDrawer).toMatchObject({ vaultId: "personal", defaultGroupPath: null });

    const draft = { kind: "ssh", label: "new", hostname: "new", port: 22, username: "u", authType: "password" } as never;
    await store.getState().saveHost(null, draft, undefined, TEAM);
    expect(api.hosts.create).toHaveBeenLastCalledWith(draft, undefined, TEAM);
    await store.getState().saveHost(null, draft);
    expect(api.hosts.create).toHaveBeenLastCalledWith(draft, undefined);

    await store.getState().duplicateHosts(["team-web"]);
    expect(vi.mocked(api.hosts.create).mock.lastCall?.[2]).toBe(TEAM);
    await store.getState().duplicateHosts(["my-web"]);
    expect(vi.mocked(api.hosts.create).mock.lastCall).toHaveLength(1);
  });

  // 서랍 맨 위 Vault 로 다른 볼트를 고르면 그 볼트 맨 위에 만든다. 서랍은 그대로 열려 있다.
  it("moves the host being created to another vault, starting at its top", async () => {
    const { store } = await setup();

    store.getState().navigateGroup("Prod", TEAM);
    store.getState().openCreateHostDrawer();
    store.getState().setCreateHostVault("personal");
    expect(store.getState().hostDrawer).toEqual({ mode: "create", defaultGroupPath: null, kind: "ssh", vaultId: "personal" });
    // 고르는 것은 만들 곳일 뿐이다 — 보고 있던 자리는 그대로다.
    expect(store.getState()).toMatchObject({ currentVaultId: TEAM, currentGroupPath: "Prod" });

    // 만드는 중이 아니면 아무 일도 없다.
    store.getState().openEditHostDrawer("team-web");
    store.getState().setCreateHostVault("personal");
    expect(store.getState().hostDrawer).toEqual({ mode: "edit", hostId: "team-web" });
  });
});
