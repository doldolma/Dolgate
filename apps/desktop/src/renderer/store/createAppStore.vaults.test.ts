import { describe, expect, it, vi } from "vitest";
import type { VaultIndex } from "@shared";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { createEmptyVaultIndex } from "./utils";

// 화면이 레코드의 볼트를 찾는 표(VaultIndex)와 팀을 쓸 수 있는지. 목록을 다시 읽는 곳마다 함께 맞춘다.

function teamIndex(teamId: string, hostId: string): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      {
        id: teamId,
        name: `Team ${teamId}`,
        role: "owner",
        syncState: "ready",
        syncError: null,
        groups: [{ id: `${teamId}-group`, name: "Prod", path: "Prod", parentPath: null } as never],
      },
    ],
    teamIdByHostId: { [hostId]: teamId },
    myUsernameByHostId: { [hostId]: "bob" },
  };
}

describe("createAppStore vault index", () => {
  it("starts with no teams and loads the index and team availability on bootstrap", async () => {
    const api = createMockApi();
    vi.mocked(api.teams.getVaultIndex).mockResolvedValue(teamIndex("team-1", "host-t"));
    vi.mocked(api.teams.getAvailability).mockResolvedValue({ available: true });
    const store = createAppStore(api);

    expect(store.getState().vaultIndex).toEqual(createEmptyVaultIndex());
    expect(store.getState().teamAvailability).toEqual({ available: false, reason: "signed-out" });

    await store.getState().bootstrap();

    expect(store.getState().vaultIndex).toEqual(teamIndex("team-1", "host-t"));
    expect(store.getState().teamAvailability).toEqual({ available: true });
  });

  it("reads the index again wherever the lists are read again", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    const index = vi.mocked(api.teams.getVaultIndex);

    // 동기화로 받은 것(팀 목록·팀 데이터가 바뀌면 메인이 workspaceChanged 를 보낸다).
    index.mockResolvedValue(teamIndex("team-1", "host-a"));
    vi.mocked(api.teams.getAvailability).mockResolvedValue({ available: true });
    await store.getState().refreshSyncedWorkspaceData();
    expect(store.getState().vaultIndex.teamIdByHostId).toEqual({ "host-a": "team-1" });
    expect(store.getState().teamAvailability).toEqual({ available: true });

    index.mockResolvedValue(teamIndex("team-1", "host-b"));
    await store.getState().refreshHostCatalog();
    expect(store.getState().vaultIndex.teamIdByHostId).toEqual({ "host-b": "team-1" });

    index.mockResolvedValue(teamIndex("team-2", "host-c"));
    await store.getState().refreshOperationalData();
    expect(store.getState().vaultIndex.teamIdByHostId).toEqual({ "host-c": "team-2" });

    index.mockResolvedValue(teamIndex("team-3", "host-d"));
    await store.getState().refreshVaultIndex();
    expect(store.getState().vaultIndex.teams.map((team) => team.id)).toEqual(["team-3"]);

    // 자격 증명을 고쳐 호스트를 다시 읽는 곳(지우기·키 만들기·설치)도 함께 맞춘다.
    index.mockResolvedValue(teamIndex("team-4", "host-e"));
    await store.getState().removeKeychainSecrets(["secret-1"]);
    expect(store.getState().vaultIndex.teamIdByHostId).toEqual({ "host-e": "team-4" });
  });

  it("keeps the last index when it cannot be read, without holding back the other lists", async () => {
    const api = createMockApi();
    vi.mocked(api.teams.getVaultIndex).mockRejectedValue(new Error("boom"));
    vi.mocked(api.teams.getAvailability).mockRejectedValue(new Error("boom"));
    const store = createAppStore(api);

    await store.getState().bootstrap();
    expect(store.getState().isReady).toBe(true);
    expect(store.getState().hosts.length).toBeGreaterThan(0);
    expect(store.getState().vaultIndex).toEqual(createEmptyVaultIndex());
    expect(store.getState().teamAvailability).toEqual({ available: false, reason: "signed-out" });

    vi.mocked(api.teams.getVaultIndex).mockResolvedValue(teamIndex("team-1", "host-a"));
    vi.mocked(api.teams.getAvailability).mockResolvedValue({ available: true });
    await store.getState().refreshSyncedWorkspaceData();
    vi.mocked(api.teams.getVaultIndex).mockRejectedValue(new Error("boom"));
    vi.mocked(api.teams.getAvailability).mockRejectedValue(new Error("boom"));
    vi.mocked(api.snippets.list).mockResolvedValue([{ id: "snippet-new" } as never]);

    await store.getState().refreshSyncedWorkspaceData();

    expect(store.getState().snippets).toEqual([{ id: "snippet-new" }]);
    expect(store.getState().vaultIndex.teamIdByHostId).toEqual({ "host-a": "team-1" });
    expect(store.getState().teamAvailability).toEqual({ available: true });
  });

  it("forgets teams when the synced data is cleared on sign-out", async () => {
    const api = createMockApi();
    vi.mocked(api.teams.getVaultIndex).mockResolvedValue(teamIndex("team-1", "host-t"));
    vi.mocked(api.teams.getAvailability).mockResolvedValue({ available: true });
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().clearSyncedWorkspaceData();

    expect(store.getState().vaultIndex).toEqual(createEmptyVaultIndex());
    expect(store.getState().teamAvailability).toEqual({ available: false, reason: "signed-out" });
  });
});
