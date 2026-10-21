import { describe, expect, it, vi } from "vitest";
import type { HostRecord, SavedWorkspaceRecord, TerminalTab, VaultIndex } from "@shared";
import type { WorkspaceTab } from "./types";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { createEmptyVaultIndex } from "./utils";

// 4-6: 포트 포워딩·DNS·스니펫·워크스페이스를 그 볼트에 쓴다. 팀이 있으면 쓴 뒤 볼트 표를 다시 읽어 그 묶음에 바로
// 보이게 하고, 팀이 없으면 지금과 같은 호출이다.

const TEAM = "team-1";

function teamIndex(overrides: Partial<VaultIndex> = {}): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [{ id: TEAM, name: "Acme Infra", role: "owner", syncState: "ready", syncError: null, groups: [] }],
    teamIdByHostId: { "team-web": TEAM },
    teamIdByWorkspaceId: { "team-ws": TEAM },
    ...overrides,
  };
}

async function storeWith(vaultIndex: VaultIndex) {
  const api = createMockApi();
  vi.mocked(api.teams.getVaultIndex).mockResolvedValue(vaultIndex);
  const store = createAppStore(api);
  await store.getState().bootstrap();
  store.setState({ vaultIndex });
  vi.mocked(api.teams.getVaultIndex).mockClear();
  return { api, store };
}

const sshDraft = { label: "app", hostId: "team-web", transport: "ssh", mode: "local", bindAddress: "127.0.0.1", bindPort: 9000, targetHost: "localhost", targetPort: 80 } as const;

describe("createAppStore vault items", () => {
  it("re-reads the vault index after saving a rule only when there are teams", async () => {
    const withTeams = await storeWith(teamIndex());
    vi.mocked(withTeams.api.portForwards.create).mockResolvedValue({ ...sshDraft, id: "rule-1", createdAt: "t", updatedAt: "t" });
    await withTeams.store.getState().savePortForward(null, sshDraft);
    expect(withTeams.api.portForwards.create).toHaveBeenCalledWith(sshDraft);
    expect(withTeams.api.teams.getVaultIndex).toHaveBeenCalledTimes(1);

    const alone = await storeWith(createEmptyVaultIndex());
    vi.mocked(alone.api.portForwards.create).mockResolvedValue({ ...sshDraft, id: "rule-1", createdAt: "t", updatedAt: "t" });
    await alone.store.getState().savePortForward(null, sshDraft);
    expect(alone.api.teams.getVaultIndex).not.toHaveBeenCalled();
  });

  it("creates a snippet in the given vault and edits one by id only", async () => {
    const { api, store } = await storeWith(teamIndex());
    const draft = { label: "Restart", command: "systemctl restart app", keyword: null };
    vi.mocked(api.snippets.create).mockResolvedValue({ ...draft, id: "snip-1", createdAt: "t", updatedAt: "t" });
    vi.mocked(api.snippets.update).mockResolvedValue({ ...draft, id: "snip-1", createdAt: "t", updatedAt: "t" });

    await store.getState().saveSnippet(null, draft, TEAM);
    expect(vi.mocked(api.snippets.create).mock.calls[0]).toEqual([draft, TEAM]);
    expect(api.teams.getVaultIndex).toHaveBeenCalledTimes(1);

    // 볼트를 주지 않으면 옛 호출 모양 그대로(개인).
    await store.getState().saveSnippet(null, draft);
    expect(vi.mocked(api.snippets.create).mock.calls[1]).toEqual([draft]);

    await store.getState().saveSnippet("snip-1", draft, TEAM);
    expect(vi.mocked(api.snippets.update).mock.calls[0]).toEqual(["snip-1", draft]);
  });

  it("creates a static DNS override in the given vault", async () => {
    const { api, store } = await storeWith(teamIndex());
    const draft = { type: "static", hostname: "grafana.lab.test", address: "10.20.0.50" } as const;
    vi.mocked(api.dnsOverrides.create).mockResolvedValue({ ...draft, id: "dns-1", status: "inactive", createdAt: "t", updatedAt: "t" });

    await store.getState().saveDnsOverride(null, draft, TEAM);
    expect(vi.mocked(api.dnsOverrides.create).mock.calls[0]).toEqual([draft, TEAM]);
    await store.getState().saveDnsOverride(null, draft);
    expect(vi.mocked(api.dnsOverrides.create).mock.calls[1]).toEqual([draft]);
  });

  describe("saving a split as a Workspace", () => {
    const host = (id: string, label: string) =>
      ({ id, kind: "ssh", label, hostname: `${id}.test`, port: 22, username: "u", authType: "password", groupName: null, tags: [] }) as unknown as HostRecord;
    const tab = (sessionId: string, hostId: string) =>
      ({ id: sessionId, stableId: sessionId, sessionId, source: "host", hostId, title: hostId, status: "connected" }) as unknown as TerminalTab;
    const split = (first: string, second: string): WorkspaceTab => ({
      id: "ws-tab",
      title: "Split",
      layout: {
        id: "split",
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { id: "leaf-a", kind: "leaf", sessionId: first },
        second: { id: "leaf-b", kind: "leaf", sessionId: second },
      },
      activeSessionId: first,
      broadcastEnabled: false,
    });

    async function storeWithSplit(first: string, second: string) {
      const setup = await storeWith(teamIndex({ teamIdByHostId: { "team-web": TEAM, "team-db": TEAM } }));
      setup.store.setState({
        hosts: [host("my-web", "web-1"), host("team-web", "acme-web-1"), host("team-db", "acme-db")],
        tabs: [tab("s-a", first), tab("s-b", second)],
        workspaces: [split("s-a", "s-b")],
      });
      return setup;
    }

    it("says so the moment Save is pressed when personal and team hosts are mixed", async () => {
      const { api, store } = await storeWithSplit("my-web", "team-web");

      await expect(store.getState().createSavedWorkspace("ws-tab", "Mixed")).rejects.toThrow(
        "개인 호스트와 팀 호스트가 섞여 있어 Workspace로 저장할 수 없습니다",
      );
      expect(api.savedWorkspaces.create).not.toHaveBeenCalled();
    });

    it("saves a team-only split and re-reads the vault index so it shows under the team", async () => {
      const { api, store } = await storeWithSplit("team-web", "team-db");
      vi.mocked(api.savedWorkspaces.create).mockResolvedValue({ id: "new-ws", name: "Acme" } as SavedWorkspaceRecord);

      await store.getState().createSavedWorkspace("ws-tab", "Acme");

      expect(vi.mocked(api.savedWorkspaces.create).mock.calls[0]).toHaveLength(1);
      expect(api.teams.getVaultIndex).toHaveBeenCalledTimes(1);
    });
  });

  it("duplicates a team workspace into its own vault", async () => {
    const { api, store } = await storeWith(teamIndex());
    const source = { id: "team-ws", version: 1, name: "Acme", root: { id: "l", kind: "leaf", target: { kind: "local", label: "L" } }, favorite: false, groupName: "Prod", lastOpenedAt: null, createdAt: "t", updatedAt: "t" } as SavedWorkspaceRecord;
    store.setState({ savedWorkspaces: [source] });
    vi.mocked(api.savedWorkspaces.create).mockResolvedValue({ ...source, id: "copy" });

    await store.getState().duplicateSavedWorkspace("team-ws");

    expect(vi.mocked(api.savedWorkspaces.create).mock.calls[0]).toEqual([
      expect.objectContaining({ groupName: "Prod", favorite: false }),
      TEAM,
    ]);
    expect(api.teams.getVaultIndex).toHaveBeenCalledTimes(1);
  });
});
