import { describe, expect, it, vi } from "vitest";
import type { TeamListItem } from "@shared";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";

// Teams 탭과 참여 카드가 쓰는 스토어 동작. 팀 목록이 바뀌는 동작은 볼트 표를 곧장 다시 읽는다.

const LINK = "https://sync.example.com/invite/k3Hq9xAb#v1.Qm9vYmFy";

function team(id: string, overrides: Partial<TeamListItem> = {}): TeamListItem {
  return { id, name: `Team ${id}`, role: "member", syncState: "ready", syncError: null, ...overrides };
}

describe("createAppStore teams", () => {
  it("re-reads hosts and the vault index after saving or clearing my credentials on a team host", async () => {
    // 메인의 바뀜 알림은 쓴 창에 오지 않는다 — 다시 읽어야 내 이름이 팔레트·SFTP 부제에 바로 보인다.
    const api = createMockApi();
    api.teams.setMyCredentials = vi.fn().mockResolvedValue({ username: "deploy" });
    api.teams.clearMyCredentials = vi.fn().mockResolvedValue(undefined);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    vi.mocked(api.hosts.list).mockClear();
    vi.mocked(api.teams.getVaultIndex).mockClear();
    await expect(store.getState().saveMyHostCredentials("team-web", { username: "deploy" })).resolves.toEqual({ username: "deploy" });
    expect(api.teams.setMyCredentials).toHaveBeenCalledWith("team-web", { username: "deploy" });
    expect(api.hosts.list).toHaveBeenCalledTimes(1);
    expect(api.teams.getVaultIndex).toHaveBeenCalledTimes(1);

    await store.getState().clearMyHostCredentials("team-web");
    expect(api.teams.clearMyCredentials).toHaveBeenCalledWith("team-web");
    expect(api.hosts.list).toHaveBeenCalledTimes(2);
    expect(api.teams.getVaultIndex).toHaveBeenCalledTimes(2);
  });

  it("takes a link the link page handed to the app, and keeps the last one when there is none", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    vi.mocked(api.teams.takePendingInviteLink).mockResolvedValueOnce(LINK).mockResolvedValueOnce(null);

    await store.getState().takePendingInviteLink();
    expect(store.getState().pendingInviteLink).toBe(LINK);

    // 다른 창이 먼저 가져갔으면(null) 지금 것을 지우지 않는다.
    await store.getState().takePendingInviteLink();
    expect(store.getState().pendingInviteLink).toBe(LINK);

    // 메인과 끊겨도 던지지 않는다 — 켤 때 부르는 곳이 실패로 멈추지 않게.
    vi.mocked(api.teams.takePendingInviteLink).mockRejectedValueOnce(new Error("ipc gone"));
    await expect(store.getState().takePendingInviteLink()).resolves.toBeUndefined();
  });

  it("joins with the link, forgets it, shows the new team and re-reads the vault index", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    vi.mocked(api.teams.join).mockResolvedValue(team("team-1"));
    store.getState().openInviteLink(`  ${LINK}  `);
    expect(store.getState().pendingInviteLink).toBe(LINK);

    await expect(store.getState().joinTeam(LINK)).resolves.toEqual(team("team-1"));

    expect(api.teams.join).toHaveBeenCalledWith(LINK);
    expect(store.getState().pendingInviteLink).toBeNull();
    expect(store.getState().teamsPanelTeamId).toBe("team-1");
    expect(api.teams.getVaultIndex).toHaveBeenCalled();
  });

  it("keeps the link when joining fails so the card can say why", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    vi.mocked(api.teams.join).mockRejectedValue(new Error("초대 링크가 만료되었거나 올바르지 않습니다."));
    store.getState().openInviteLink(LINK);

    await expect(store.getState().joinTeam(LINK)).rejects.toThrow("만료");
    expect(store.getState().pendingInviteLink).toBe(LINK);
  });

  it("hands the team over before the owner leaves, and only leaves otherwise", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    const order: string[] = [];
    vi.mocked(api.teams.transferOwnership).mockImplementation(async (teamId, userId) => {
      order.push(`transfer:${teamId}:${userId}`);
    });
    vi.mocked(api.teams.leave).mockImplementation(async (teamId) => {
      order.push(`leave:${teamId}`);
    });

    await store.getState().leaveTeam("team-1", "user-minji");
    await store.getState().leaveTeam("team-2");

    expect(order).toEqual(["transfer:team-1:user-minji", "leave:team-1", "leave:team-2"]);
    expect(api.teams.getVaultIndex).toHaveBeenCalledTimes(2);
  });

  // 넘긴 뒤 나가기만 실패하면 나는 이미 멤버다. 표를 다시 읽어야 창이 다시 누를 때 또 넘기려 하지 않는다.
  it("re-reads the vault index even when leaving fails after handing the team over", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    vi.mocked(api.teams.transferOwnership).mockResolvedValue(undefined);
    vi.mocked(api.teams.leave).mockRejectedValue(new Error("network down"));

    await expect(store.getState().leaveTeam("team-1", "user-minji")).rejects.toThrow("network down");
    expect(api.teams.getVaultIndex).toHaveBeenCalledTimes(1);
  });

  it("creates an invite for the chosen hours and counts the team's own secrets", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    vi.mocked(api.teams.createInvite).mockResolvedValue({ link: LINK, invite: {} as never });
    vi.mocked(api.keychain.list).mockResolvedValue([{ secretRef: "a" }, { secretRef: "b" }] as never);

    await store.getState().createTeamInvite("team-1", 24);
    expect(api.teams.createInvite).toHaveBeenCalledWith("team-1", { expiresInHours: 24 });

    await expect(store.getState().countTeamSecrets("team-1")).resolves.toBe(2);
    expect(api.keychain.list).toHaveBeenCalledWith("team-1");
  });

  it("asks main again whether teams can be used, keeping what it knew when main can't answer", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    vi.mocked(api.teams.getAvailability).mockResolvedValueOnce({ available: true });

    await expect(store.getState().checkTeamAvailability()).resolves.toEqual({ available: true });
    expect(store.getState().teamAvailability).toEqual({ available: true });

    vi.mocked(api.teams.getAvailability).mockRejectedValueOnce(new Error("ipc gone"));
    await expect(store.getState().checkTeamAvailability()).resolves.toEqual({ available: true });
  });

  it("opens the Teams tab on a team", () => {
    const store = createAppStore(createMockApi());
    store.getState().showTeamInPanel("team-9");
    expect(store.getState()).toMatchObject({
      activeWorkspaceTab: "home",
      homeSection: "settings",
      settingsSection: "teams",
      teamsPanelTeamId: "team-9",
    });
  });
});
