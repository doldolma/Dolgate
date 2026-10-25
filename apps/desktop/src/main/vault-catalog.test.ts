import type { HostDraft, HostRecord, SavedWorkspaceRecord, TerminalThemeId } from "@shared";
import { describe, expect, it, vi } from "vitest";
import type { HostRepository, SavedWorkspaceRepository } from "./database";
import type { TeamHostPrefsRecord, TeamWorkspacePrefsRecord } from "./state-storage";
import type {
  TeamHostCredentials,
  TeamMemberPrefsStore,
} from "./team-member-prefs";
import {
  createVaultCatalog,
  PERSONAL_VAULT_ID,
  pickVaultRepositories,
  type TeamVaultScope,
  type TeamVaultSource,
  type VaultScope,
} from "./vault-catalog";

function createHost(id: string, label: string, extra: Partial<HostRecord> = {}): HostRecord {
  return { id, label, kind: "ssh", hostname: `${label}.example.com`, port: 22, ...extra } as HostRecord;
}

function createWorkspace(id: string, extra: Partial<SavedWorkspaceRecord> = {}): SavedWorkspaceRecord {
  return { id, version: 1, name: id, favorite: false, lastOpenedAt: null, ...extra } as SavedWorkspaceRecord;
}

// 카탈로그가 부르는 것만 흉내 낸다. 나머지 저장소는 들고 다니기만 하므로 빈 객체로 둔다.
function createRepositories(
  hosts: HostRecord[],
  options: { secrets?: Record<string, string>; workspaces?: SavedWorkspaceRecord[] } = {},
) {
  const workspaces = options.workspaces ?? [];
  return {
    hosts: {
      getById: vi.fn((id: string) => hosts.find((host) => host.id === id) ?? null),
      list: vi.fn(() => hosts),
      setFavorite: vi.fn((id: string, favorite: boolean) => ({ ...hosts.find((host) => host.id === id), favorite })),
      setTerminalTheme: vi.fn(),
      update: vi.fn((id: string, draft: HostDraft) => ({ ...hosts.find((host) => host.id === id), ...draft })),
      removeMany: vi.fn(),
    } as unknown as HostRepository &
      Record<"setFavorite" | "setTerminalTheme" | "update" | "removeMany", ReturnType<typeof vi.fn>>,
    savedWorkspaces: {
      getById: vi.fn((id: string) => workspaces.find((workspace) => workspace.id === id) ?? null),
      list: vi.fn(() => workspaces),
      setFavorite: vi.fn(),
      touchOpened: vi.fn(),
    } as unknown as SavedWorkspaceRepository & Record<"setFavorite" | "touchOpened", ReturnType<typeof vi.fn>>,
    secrets: {
      load: vi.fn(async (secretRef: string) => options.secrets?.[secretRef] ?? null),
      save: vi.fn(),
      remove: vi.fn(),
    },
    syncOutbox: { upsertDeletions: vi.fn() },
    memberPrefs: null,
  };
}

// 사람마다 다른 값을 메모리에 두는 가짜. 고친 값은 다음 read 에 보인다.
function createMemberPrefs(
  initial: {
    hosts?: TeamHostPrefsRecord[];
    workspaces?: TeamWorkspacePrefsRecord[];
    themes?: Record<string, TerminalThemeId>;
  } = {},
) {
  const hosts = new Map((initial.hosts ?? []).map((record) => [record.id, record]));
  const workspaces = new Map((initial.workspaces ?? []).map((record) => [record.id, record]));
  const themes: Record<string, TerminalThemeId> = { ...initial.themes };
  const credentials = new Map<string, TeamHostCredentials>();
  const keep = <T>(map: Map<string, T>) =>
    vi.fn((id: string, value: T | null) => {
      if (value) {
        map.set(id, value);
      } else {
        map.delete(id);
      }
    });
  const store = {
    read: vi.fn(() => ({ hosts: new Map(hosts), workspaces: new Map(workspaces), terminalThemeByHostId: { ...themes } })),
    updateHost: vi.fn((hostId: string, patch: { favorite?: boolean | null; agentForwarding?: boolean | null }) => {
      const current = hosts.get(hostId);
      hosts.set(hostId, {
        id: hostId,
        favorite: patch.favorite === undefined ? (current?.favorite ?? null) : patch.favorite ? true : null,
        agentForwarding:
          patch.agentForwarding === undefined ? (current?.agentForwarding ?? null) : patch.agentForwarding ? true : null,
        updatedAt: "now",
      });
    }),
    updateWorkspace: vi.fn((workspaceId: string, patch: { favorite?: boolean; lastOpenedAt?: string | null }) => {
      const current = workspaces.get(workspaceId);
      workspaces.set(workspaceId, {
        id: workspaceId,
        favorite: patch.favorite ?? current?.favorite ?? false,
        lastOpenedAt: patch.lastOpenedAt === undefined ? (current?.lastOpenedAt ?? null) : patch.lastOpenedAt,
        updatedAt: "now",
      });
    }),
    setHostTerminalTheme: vi.fn((hostId: string, themeId: TerminalThemeId | null) => {
      if (themeId === null) {
        delete themes[hostId];
      } else {
        themes[hostId] = themeId;
      }
    }),
    readHostCredentials: vi.fn((hostId: string) => credentials.get(hostId) ?? null),
    writeHostCredentials: keep(credentials),
  };
  return store satisfies TeamMemberPrefsStore;
}

function createTeam(
  hosts: HostRecord[],
  options: Parameters<typeof createRepositories>[1] & { prefs?: ReturnType<typeof createMemberPrefs> } = {},
) {
  return { ...createRepositories(hosts, options), memberPrefs: options.prefs ?? createMemberPrefs() };
}

function createTeams(teams: Record<string, Omit<TeamVaultScope, "id">>): TeamVaultSource & {
  teams: Record<string, Omit<TeamVaultScope, "id">>;
} {
  return {
    teams,
    listTeamIds: () => Object.keys(teams),
    createScope: vi.fn((teamId: string) => teams[teamId]),
  };
}

const asScope = (value: unknown) => value as Omit<VaultScope, "id">;
const asTeam = (value: unknown) => value as Omit<TeamVaultScope, "id">;

describe("pickVaultRepositories", () => {
  it("keeps only the vault repositories from main's dependency bag", () => {
    const names = [
      "hosts",
      "groups",
      "tailnets",
      "portForwards",
      "dnsOverrides",
      "snippets",
      "savedWorkspaces",
      "knownHosts",
      "secretMetadata",
      "awsProfiles",
      "syncOutbox",
    ];
    const bag = Object.fromEntries([...names, "settings", "activityLogs"].map((name) => [name, { name }]));
    const secrets = { load: vi.fn(), save: vi.fn(), remove: vi.fn() };

    const picked = pickVaultRepositories(bag as never, secrets);

    expect(Object.keys(picked).sort()).toEqual([...names, "secrets", "memberPrefs"].sort());
    expect(picked.hosts).toBe(bag.hosts);
    expect(picked.secrets).toBe(secrets);
    // 개인 볼트는 사람마다 다른 값을 레코드 안에 둔다.
    expect(picked.memberPrefs).toBeNull();
  });
});

describe("createVaultCatalog", () => {
  describe("with only the personal vault", () => {
    it("finds a host in the personal vault and returns null when it is missing", () => {
      const web = createHost("host-1", "web");
      const catalog = createVaultCatalog(asScope(createRepositories([web])));

      expect(catalog.getHost("host-1")).toBe(web);
      expect(catalog.getHost("missing")).toBeNull();
    });

    it("lists hosts in the order the repository returns them", () => {
      const hosts = [createHost("host-b", "b"), createHost("host-a", "a")];
      const catalog = createVaultCatalog(asScope(createRepositories(hosts)));

      expect(catalog.listHosts()).toEqual(hosts);
    });

    it("puts every host in the personal vault, including ones it cannot find", () => {
      const repositories = asScope(createRepositories([createHost("host-1", "web")]));
      const catalog = createVaultCatalog(repositories);

      expect(catalog.personal).toEqual({ id: PERSONAL_VAULT_ID, ...repositories });
      expect(catalog.scopeOfHost("host-1")).toBe(catalog.personal);
      expect(catalog.scopeOfHost("missing")).toBe(catalog.personal);
      expect(catalog.listScopes()).toEqual([catalog.personal]);
      expect(catalog.getScope(PERSONAL_VAULT_ID)).toBe(catalog.personal);
      expect(catalog.getScope("team-1")).toBeNull();
    });

    // 팀이 없는 사용자에게는 팀 볼트가 생기기 전과 똑같이 동작해야 한다 — 쓰기 전에 찾아보지도 않는다.
    it("hands writes straight to the personal repositories without looking anything up", () => {
      const repositories = createRepositories([createHost("host-1", "web")], {
        workspaces: [createWorkspace("workspace-1")],
      });
      const catalog = createVaultCatalog(asScope(repositories));
      const draft = { kind: "ssh", label: "web", hostname: "web.example.com", port: 22, agentForwarding: true } as HostDraft;

      catalog.setHostFavorite("host-1", true);
      catalog.setHostTerminalTheme("host-1", "dolssh-dark");
      catalog.updateHost("host-1", draft, "secret:1");
      catalog.setWorkspaceFavorite("workspace-1", true);
      catalog.touchWorkspaceOpened("workspace-1");

      expect(repositories.hosts.setFavorite).toHaveBeenCalledWith("host-1", true);
      expect(repositories.hosts.setTerminalTheme).toHaveBeenCalledWith("host-1", "dolssh-dark");
      expect(repositories.hosts.update).toHaveBeenCalledWith("host-1", draft, "secret:1");
      expect(repositories.savedWorkspaces.setFavorite).toHaveBeenCalledWith("workspace-1", true);
      expect(repositories.savedWorkspaces.touchOpened).toHaveBeenCalledWith("workspace-1");
      expect(repositories.hosts.getById).not.toHaveBeenCalled();
      expect(repositories.savedWorkspaces.getById).not.toHaveBeenCalled();
    });
  });

  describe("with team vaults", () => {
    it("reads team hosts after the personal ones and knows which vault holds each", () => {
      const personalHost = createHost("host-p", "personal");
      const teamHost = createHost("host-t", "team", { favorite: null, terminalThemeId: null, agentForwarding: null });
      const catalog = createVaultCatalog(
        asScope(createRepositories([personalHost])),
        createTeams({ "team-1": asTeam(createTeam([teamHost])) }),
      );

      expect(catalog.listHosts()).toEqual([personalHost, teamHost]);
      expect(catalog.getHost("host-t")).toEqual(teamHost);
      expect(catalog.scopeOfHost("host-t").id).toBe("team-1");
      expect(catalog.scopeOfHost("host-p")).toBe(catalog.personal);
    });

    it("lets the personal vault win when an id is in both, and the earlier team between teams", () => {
      const personal = createHost("shared", "personal");
      const fromTeam1 = createHost("shared", "team-1");
      const team1Only = createHost("team-dup", "team-1-only");
      const team2Dup = createHost("team-dup", "team-2");
      const catalog = createVaultCatalog(
        asScope(createRepositories([personal])),
        createTeams({
          "team-1": asTeam(createTeam([fromTeam1, team1Only])),
          "team-2": asTeam(createTeam([team2Dup])),
        }),
      );

      expect(catalog.getHost("shared")).toBe(personal);
      expect(catalog.scopeOfHost("shared")).toBe(catalog.personal);
      expect(catalog.getHost("team-dup")?.label).toBe("team-1-only");
      expect(catalog.scopeOfHost("team-dup").id).toBe("team-1");
      expect(catalog.listHosts().map((host) => host.label)).toEqual(["personal", "team-1-only"]);
    });

    // 여러 개를 지울 때도 목록이 보여 주는 볼트에서 지운다(개인이 이기고, 팀끼리는 앞선 팀). 볼트마다 한 번에 쓴다.
    it("removes each host from the vault the lists show it from, once per vault", () => {
      const personal = createRepositories([createHost("shared", "personal")]);
      const team1 = createTeam([createHost("shared", "team-1"), createHost("team-dup", "team-1-only")]);
      const team2 = createTeam([createHost("team-dup", "team-2"), createHost("team-2-only", "team-2")]);
      const catalog = createVaultCatalog(
        asScope(personal),
        createTeams({ "team-1": asTeam(team1), "team-2": asTeam(team2) }),
      );

      const removed = catalog.removeHosts(["shared", "team-dup", "team-2-only", "gone"]);

      expect(removed.map(({ host, vaultId }) => [host.label, vaultId])).toEqual([
        ["personal", PERSONAL_VAULT_ID],
        ["team-1-only", "team-1"],
        ["team-2", "team-2"],
      ]);
      // 못 찾은 것은 개인 볼트에 지움 표시만 남긴다(하나씩 지우던 때와 같다).
      expect(personal.syncOutbox.upsertDeletions).toHaveBeenCalledWith("hosts", ["shared", "gone"]);
      expect(personal.hosts.removeMany).toHaveBeenCalledWith(["shared", "gone"]);
      expect(team1.syncOutbox.upsertDeletions).toHaveBeenCalledWith("hosts", ["team-dup"]);
      expect(team1.hosts.removeMany).toHaveBeenCalledWith(["team-dup"]);
      expect(team2.hosts.removeMany).toHaveBeenCalledTimes(1);
      expect(team2.hosts.removeMany).toHaveBeenCalledWith(["team-2-only"]);
    });

    it("follows teams coming and going and reuses one scope per team", () => {
      const source = createTeams({ "team-1": asTeam(createTeam([])) });
      const catalog = createVaultCatalog(asScope(createRepositories([])), source);

      const first = catalog.getScope("team-1");
      expect(first?.id).toBe("team-1");
      expect(catalog.getScope("team-1")).toBe(first);
      expect(source.createScope).toHaveBeenCalledTimes(1);

      delete source.teams["team-1"];
      expect(catalog.getScope("team-1")).toBeNull();
      expect(catalog.listScopes()).toEqual([catalog.personal]);

      source.teams["team-2"] = asTeam(createTeam([createHost("late", "late")]));
      expect(catalog.listScopes().map((scope) => scope.id)).toEqual([PERSONAL_VAULT_ID, "team-2"]);
      expect(catalog.getHost("late")?.id).toBe("late");
    });

    it("never treats a team called like the personal vault as a team", () => {
      const catalog = createVaultCatalog(
        asScope(createRepositories([])),
        createTeams({ [PERSONAL_VAULT_ID]: asTeam(createTeam([createHost("odd", "odd")])) }),
      );

      expect(catalog.listScopes()).toEqual([catalog.personal]);
      expect(catalog.getScope(PERSONAL_VAULT_ID)).toBe(catalog.personal);
      expect(catalog.getHost("odd")).toBeNull();
    });

    it("finds a secret in whichever vault holds it, personal first", async () => {
      const catalog = createVaultCatalog(
        asScope(createRepositories([], { secrets: { "secret:mine": "personal-value", "secret:both": "personal-both" } })),
        createTeams({
          "team-1": asTeam(createTeam([], { secrets: { "secret:team": "team-value", "secret:both": "team-both" } })),
        }),
      );

      await expect(catalog.loadSecret("secret:mine")).resolves.toBe("personal-value");
      await expect(catalog.loadSecret("secret:team")).resolves.toBe("team-value");
      await expect(catalog.loadSecret("secret:both")).resolves.toBe("personal-both");
      await expect(catalog.loadSecret("secret:none")).resolves.toBeNull();
    });

    it("finds a port forward rule in whichever vault holds it, personal first", () => {
      const withRules = (repositories: object, rules: Array<{ id: string; label: string }>) => ({
        ...repositories,
        portForwards: { getById: vi.fn((id: string) => rules.find((rule) => rule.id === id) ?? null) },
      });
      const catalog = createVaultCatalog(
        asScope(withRules(createRepositories([]), [{ id: "rule-mine", label: "mine" }, { id: "rule-both", label: "personal" }])),
        createTeams({
          "team-1": asTeam(withRules(createTeam([]), [{ id: "rule-team", label: "team" }, { id: "rule-both", label: "team" }])),
        }),
      );

      expect(catalog.getPortForward("rule-mine")?.label).toBe("mine");
      expect(catalog.getPortForward("rule-team")?.label).toBe("team");
      expect(catalog.getPortForward("rule-both")?.label).toBe("personal");
      expect(catalog.getPortForward("rule-none")).toBeNull();
    });
  });

  describe("values that differ per member on team vaults", () => {
    it("lays my favorite, agent forwarding and theme over team hosts, ignoring what the record carries", () => {
      // 레코드에 남아 있던 값(옛 기기·다른 멤버가 실수로 실은 것)은 쓰지 않는다.
      const mine = createHost("host-a", "a", { favorite: null, agentForwarding: true, terminalThemeId: "dolssh-light" } as never);
      const other = createHost("host-b", "b", { favorite: true, agentForwarding: true, terminalThemeId: "dolssh-light" } as never);
      const personalHost = createHost("host-p", "p", { favorite: true, terminalThemeId: "dolssh-light" } as never);
      const prefs = createMemberPrefs({
        hosts: [{ id: "host-a", favorite: true, agentForwarding: null, updatedAt: "t" }],
        themes: { "host-a": "dolssh-dark" },
      });
      const catalog = createVaultCatalog(
        asScope(createRepositories([personalHost])),
        createTeams({ "team-1": asTeam(createTeam([mine, other], { prefs })) }),
      );

      expect(catalog.getHost("host-a")).toMatchObject({ favorite: true, agentForwarding: null, terminalThemeId: "dolssh-dark" });
      expect(catalog.getHost("host-b")).toMatchObject({ favorite: null, agentForwarding: null, terminalThemeId: null });
      expect(catalog.listHosts()).toEqual([personalHost, catalog.getHost("host-a"), catalog.getHost("host-b")]);
      // 개인 호스트는 자기 레코드의 값을 그대로 쓴다.
      expect(catalog.getHost("host-p")).toBe(personalHost);
    });

    it("keeps favorite and theme changes on a team host in my own place, not in the team record", () => {
      const team = createTeam([createHost("host-t", "t")]);
      const personal = createRepositories([createHost("host-p", "p")]);
      const catalog = createVaultCatalog(asScope(personal), createTeams({ "team-1": asTeam(team) }));

      expect(catalog.setHostFavorite("host-t", true)).toMatchObject({ id: "host-t", favorite: true });
      expect(catalog.setHostTerminalTheme("host-t", "dolssh-dark")).toMatchObject({ terminalThemeId: "dolssh-dark" });
      expect(team.memberPrefs.updateHost).toHaveBeenCalledWith("host-t", { favorite: true });
      expect(team.memberPrefs.setHostTerminalTheme).toHaveBeenCalledWith("host-t", "dolssh-dark");
      expect(team.hosts.setFavorite).not.toHaveBeenCalled();
      expect(team.hosts.setTerminalTheme).not.toHaveBeenCalled();

      catalog.setHostFavorite("host-p", true);
      expect(personal.hosts.setFavorite).toHaveBeenCalledWith("host-p", true);
      expect(team.memberPrefs.updateHost).toHaveBeenCalledTimes(1);
    });

    it("splits a team host edit into the team record and my own values", () => {
      const team = createTeam([createHost("host-t", "t")]);
      const catalog = createVaultCatalog(asScope(createRepositories([])), createTeams({ "team-1": asTeam(team) }));
      const draft = {
        kind: "ssh",
        label: "renamed",
        hostname: "t.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        agentForwarding: true,
        terminalThemeId: "dolssh-dark",
      } as HostDraft;

      const record = catalog.updateHost("host-t", draft, "secret:team");

      expect(team.hosts.update).toHaveBeenCalledWith(
        "host-t",
        { ...draft, agentForwarding: null, terminalThemeId: null },
        "secret:team",
      );
      expect(team.memberPrefs.updateHost).toHaveBeenCalledWith("host-t", { agentForwarding: true });
      expect(team.memberPrefs.setHostTerminalTheme).toHaveBeenCalledWith("host-t", "dolssh-dark");
      expect(record).toMatchObject({ label: "renamed", agentForwarding: true, terminalThemeId: "dolssh-dark" });
    });

    it("creates a host in the vault it is asked for, splitting my own values off team hosts", () => {
      const team = createTeam([]);
      (team.hosts as unknown as Record<string, unknown>).create = vi.fn((id: string, draft: HostDraft) => ({ id, ...draft }));
      const personal = createRepositories([]);
      (personal.hosts as unknown as Record<string, unknown>).create = vi.fn((id: string, draft: HostDraft) => ({ id, ...draft }));
      const catalog = createVaultCatalog(asScope(personal), createTeams({ "team-1": asTeam(team) }));
      const draft = { kind: "ssh", label: "Prod", agentForwarding: true, terminalThemeId: "night-owl" } as HostDraft;

      expect(catalog.createHost("team-1", "host-t", draft, "secret:t")).toMatchObject({
        id: "host-t",
        agentForwarding: true,
        terminalThemeId: "night-owl",
      });
      expect(team.hosts.create).toHaveBeenCalledWith(
        "host-t",
        { ...draft, agentForwarding: null, terminalThemeId: null },
        "secret:t",
      );
      expect(team.memberPrefs.updateHost).toHaveBeenCalledWith("host-t", { agentForwarding: true });

      catalog.createHost(PERSONAL_VAULT_ID, "host-p", draft, null);
      expect(personal.hosts.create).toHaveBeenCalledWith("host-p", draft, null);
      expect(() => catalog.createHost("team-x", "host-x", draft)).toThrow("이 기기에 없는 팀입니다.");
    });

    it("does the same for team workspaces' favorite and last opened time", () => {
      const prefs = createMemberPrefs({
        workspaces: [{ id: "ws-t", favorite: true, lastOpenedAt: "2026-10-19T01:00:00.000Z", updatedAt: "t" }],
      });
      const team = createTeam([], {
        prefs,
        workspaces: [createWorkspace("ws-t", { favorite: false, lastOpenedAt: null }), createWorkspace("ws-u")],
      });
      const personal = createRepositories([], { workspaces: [createWorkspace("ws-p", { favorite: true })] });
      const catalog = createVaultCatalog(asScope(personal), createTeams({ "team-1": asTeam(team) }));

      expect(catalog.listWorkspaces().map((workspace) => [workspace.id, workspace.favorite, workspace.lastOpenedAt])).toEqual([
        ["ws-p", true, null],
        ["ws-t", true, "2026-10-19T01:00:00.000Z"],
        ["ws-u", false, null],
      ]);

      expect(catalog.setWorkspaceFavorite("ws-u", true)).toMatchObject({ id: "ws-u", favorite: true });
      const opened = catalog.touchWorkspaceOpened("ws-u");
      expect(opened.lastOpenedAt).toEqual(expect.any(String));
      expect(team.savedWorkspaces.setFavorite).not.toHaveBeenCalled();
      expect(team.savedWorkspaces.touchOpened).not.toHaveBeenCalled();

      catalog.touchWorkspaceOpened("ws-p");
      expect(personal.savedWorkspaces.touchOpened).toHaveBeenCalledWith("ws-p");
    });

    it("renames, moves and removes a workspace in the vault that has it", () => {
      const prefs = createMemberPrefs({
        workspaces: [{ id: "ws-t", favorite: true, lastOpenedAt: null, updatedAt: "t" }],
      });
      const team = createTeam([], { prefs, workspaces: [createWorkspace("ws-t")] });
      const teamWorkspaces = team.savedWorkspaces as unknown as Record<string, unknown>;
      teamWorkspaces.rename = vi.fn((id: string, name: string) => createWorkspace(id, { name }));
      teamWorkspaces.moveToGroup = vi.fn((id: string, groupName: string | null) => createWorkspace(id, { groupName }));
      teamWorkspaces.remove = vi.fn();
      const teamOutbox = { upsertDeletion: vi.fn() };
      (team as unknown as Record<string, unknown>).syncOutbox = teamOutbox;
      const personal = createRepositories([], { workspaces: [createWorkspace("ws-p")] });
      const personalWorkspaces = personal.savedWorkspaces as unknown as Record<string, unknown>;
      personalWorkspaces.rename = vi.fn((id: string, name: string) => createWorkspace(id, { name }));
      personalWorkspaces.remove = vi.fn();
      const personalOutbox = { upsertDeletion: vi.fn() };
      (personal as unknown as Record<string, unknown>).syncOutbox = personalOutbox;
      const catalog = createVaultCatalog(asScope(personal), createTeams({ "team-1": asTeam(team) }));

      // 팀 것은 팀 저장소로, 돌려줄 때 내 즐겨찾기를 얹는다.
      expect(catalog.renameWorkspace("ws-t", "Deploy")).toMatchObject({ id: "ws-t", name: "Deploy", favorite: true });
      expect(catalog.moveWorkspaceToGroup("ws-t", "Prod")).toMatchObject({ groupName: "Prod", favorite: true });
      catalog.removeWorkspace("ws-t");
      expect(teamWorkspaces.remove).toHaveBeenCalledWith("ws-t");
      expect(teamOutbox.upsertDeletion).toHaveBeenCalledWith("workspaces", "ws-t");

      catalog.renameWorkspace("ws-p", "Mine");
      expect(personalWorkspaces.rename).toHaveBeenCalledWith("ws-p", "Mine");
      catalog.removeWorkspace("ws-p");
      expect(personalWorkspaces.remove).toHaveBeenCalledWith("ws-p");
      expect(personalOutbox.upsertDeletion).toHaveBeenCalledWith("workspaces", "ws-p");
      expect(teamOutbox.upsertDeletion).toHaveBeenCalledTimes(1);
    });
  });

  describe("the vault index the screen reads", () => {
    // 볼트 표가 읽는 목록들. 카탈로그의 다른 시험이 쓰는 가짜에 없는 것만 더한다.
    const withLists = <T extends object>(
      repositories: T,
      lists: {
        groups?: Array<{ id: string; path: string }>;
        portForwards?: Array<{ id: string }>;
        dnsOverrides?: Array<{ id: string }>;
        snippets?: Array<{ id: string }>;
      } = {},
    ) => ({
      ...repositories,
      groups: { list: vi.fn(() => lists.groups ?? []) },
      portForwards: { list: vi.fn(() => lists.portForwards ?? []) },
      dnsOverrides: { list: vi.fn(() => lists.dnsOverrides ?? []) },
      snippets: { list: vi.fn(() => lists.snippets ?? []) },
    });

    it("is empty without teams and reads nothing from the personal vault", () => {
      const personal = withLists(createRepositories([createHost("host-p", "p")]));
      const catalog = createVaultCatalog(asScope(personal));

      expect(catalog.describeTeamVaults()).toEqual({
        groupsByTeamId: {},
        teamIdByHostId: {},
        teamIdByWorkspaceId: {},
        teamIdByPortForwardId: {},
        teamIdByDnsOverrideId: {},
        teamIdBySnippetId: {},
        myUsernameByHostId: {},
      });
      expect(personal.hosts.list).not.toHaveBeenCalled();
      expect(personal.snippets.list).not.toHaveBeenCalled();
    });

    it("maps every kind of team record to its team and leaves personal ones out", () => {
      const team1 = withLists(
        createTeam([createHost("host-t1", "t1")], { workspaces: [createWorkspace("ws-t1")] }),
        {
          groups: [{ id: "g-1", path: "Prod" }],
          portForwards: [{ id: "pf-t1" }],
          dnsOverrides: [{ id: "dns-t1" }],
          snippets: [{ id: "snip-t1" }],
        },
      );
      const team2 = withLists(createTeam([createHost("host-t2", "t2")]), {
        groups: [{ id: "g-2", path: "Prod" }],
        snippets: [{ id: "snip-t2" }],
      });
      const personal = withLists(createRepositories([createHost("host-p", "p")], { workspaces: [createWorkspace("ws-p")] }), {
        groups: [{ id: "g-p", path: "Prod" }],
        portForwards: [{ id: "pf-p" }],
        dnsOverrides: [{ id: "dns-p" }],
        snippets: [{ id: "snip-p" }],
      });
      const catalog = createVaultCatalog(
        asScope(personal),
        createTeams({ "team-1": asTeam(team1), "team-2": asTeam(team2) }),
      );

      const layout = catalog.describeTeamVaults();

      // 그룹 경로는 볼트 안에서만 유일하다 — 같은 "Prod" 가 팀마다 따로 온다. 개인 그룹은 groups.list 로 따로 읽는다.
      expect(layout.groupsByTeamId).toEqual({
        "team-1": [{ id: "g-1", path: "Prod" }],
        "team-2": [{ id: "g-2", path: "Prod" }],
      });
      expect(layout.teamIdByHostId).toEqual({ "host-t1": "team-1", "host-t2": "team-2" });
      expect(layout.teamIdByWorkspaceId).toEqual({ "ws-t1": "team-1" });
      expect(layout.teamIdByPortForwardId).toEqual({ "pf-t1": "team-1" });
      expect(layout.teamIdByDnsOverrideId).toEqual({ "dns-t1": "team-1" });
      expect(layout.teamIdBySnippetId).toEqual({ "snip-t1": "team-1", "snip-t2": "team-2" });
    });

    // 목록(listHosts 등)에 나온 레코드와 표가 늘 맞아야 한다 — 겹친 id 는 목록과 같은 볼트가 가진다.
    it("gives a colliding id to the same vault the lists show it from", () => {
      const team1 = withLists(createTeam([createHost("shared", "t1"), createHost("team-dup", "t1-dup")]), {
        snippets: [{ id: "snip-shared" }, { id: "snip-dup" }],
      });
      const team2 = withLists(createTeam([createHost("team-dup", "t2-dup")]), { snippets: [{ id: "snip-dup" }] });
      const personal = withLists(createRepositories([createHost("shared", "p")]), { snippets: [{ id: "snip-shared" }] });
      const catalog = createVaultCatalog(
        asScope(personal),
        createTeams({ "team-1": asTeam(team1), "team-2": asTeam(team2) }),
      );

      const layout = catalog.describeTeamVaults();

      expect(layout.teamIdByHostId).toEqual({ "team-dup": "team-1" });
      expect(layout.teamIdBySnippetId).toEqual({ "snip-dup": "team-1" });
      expect(catalog.listHosts().map((host) => host.label)).toEqual(["p", "t1-dup"]);
    });

    it("carries my own username for the team hosts I set one on", () => {
      const prefs = createMemberPrefs();
      prefs.writeHostCredentials("host-mine", { username: "  bob  " });
      prefs.writeHostCredentials("host-key-only", { password: "pw" });
      prefs.writeHostCredentials("shared", { username: "not-used" });
      const team = withLists(
        createTeam([createHost("host-mine", "a"), createHost("host-key-only", "b"), createHost("shared", "c")], { prefs }),
      );
      const catalog = createVaultCatalog(
        asScope(withLists(createRepositories([createHost("shared", "personal")]))),
        createTeams({ "team-1": asTeam(team) }),
      );

      // 개인이 가진 id 는 팀 호스트가 아니므로 내 칸을 읽지도 않는다.
      expect(catalog.describeTeamVaults().myUsernameByHostId).toEqual({ "host-mine": "bob" });
      expect(prefs.readHostCredentials).not.toHaveBeenCalledWith("shared");
    });
  });

  // 포트 포워딩·DNS·스니펫은 레코드가 든 볼트로 쓴다(4-6). 목록·볼트 찾기는 호스트와 같은 규칙이다 — 개인이 이기고,
  // 못 찾으면 개인이다.
  describe("port forwards, DNS overrides, snippets and new workspaces", () => {
    const records = (items: Array<{ id: string }>) => ({
      list: vi.fn(() => items),
      getById: vi.fn((id: string) => items.find((item) => item.id === id) ?? null),
    });
    const withRecords = <T extends object>(
      repositories: T,
      lists: { portForwards?: Array<{ id: string }>; dnsOverrides?: Array<{ id: string }>; snippets?: Array<{ id: string }> },
    ) => ({
      ...repositories,
      portForwards: records(lists.portForwards ?? []),
      dnsOverrides: records(lists.dnsOverrides ?? []),
      snippets: records(lists.snippets ?? []),
    });

    it("lists every vault's records and finds the vault each one is in", () => {
      const personal = withRecords(createRepositories([]), {
        portForwards: [{ id: "rule-p" }, { id: "dup" }],
        dnsOverrides: [{ id: "dns-p" }],
        snippets: [{ id: "snip-p" }],
      });
      const team = withRecords(createTeam([]), {
        portForwards: [{ id: "rule-t" }, { id: "dup" }],
        dnsOverrides: [{ id: "dns-t" }],
        snippets: [{ id: "snip-t" }],
      });
      const catalog = createVaultCatalog(asScope(personal), createTeams({ "team-1": asTeam(team) }));

      expect(catalog.listPortForwards().map((rule) => rule.id)).toEqual(["rule-p", "dup", "rule-t"]);
      expect(catalog.listSnippets().map((snippet) => snippet.id)).toEqual(["snip-p", "snip-t"]);
      expect(catalog.scopeOfPortForward("rule-t").id).toBe("team-1");
      expect(catalog.scopeOfPortForward("rule-p")).toBe(catalog.personal);
      // id 가 겹치면 개인이 이긴다(목록과 같다).
      expect(catalog.scopeOfPortForward("dup")).toBe(catalog.personal);
      expect(catalog.scopeOfPortForward("missing")).toBe(catalog.personal);
      expect(catalog.scopeOfDnsOverride("dns-t").id).toBe("team-1");
      expect(catalog.getDnsOverride("dns-t")).toEqual({ id: "dns-t" });
      expect(catalog.getDnsOverride("missing")).toBeNull();
      expect(catalog.scopeOfSnippet("snip-t").id).toBe("team-1");
      expect(catalog.scopeOfSnippet("snip-p")).toBe(catalog.personal);
    });

    it("creates a team workspace with my favorite kept out of the team record", () => {
      const prefs = createMemberPrefs();
      const team = createTeam([], { prefs });
      const create = vi.fn((draft: object) => ({ id: "ws-new", version: 1, lastOpenedAt: null, ...draft }));
      (team.savedWorkspaces as unknown as { create: typeof create }).create = create;
      const personal = createRepositories([]);
      const personalCreate = vi.fn();
      (personal.savedWorkspaces as unknown as { create: typeof personalCreate }).create = personalCreate;
      const catalog = createVaultCatalog(asScope(personal), createTeams({ "team-1": asTeam(team) }));
      const root = { id: "leaf", kind: "leaf", target: { kind: "local", label: "Local" } } as const;

      const record = catalog.createWorkspace("team-1", { name: "W", root, favorite: true });

      expect(create).toHaveBeenCalledWith({ name: "W", root, favorite: false });
      expect(prefs.updateWorkspace).toHaveBeenCalledWith("ws-new", { favorite: true });
      expect(record.favorite).toBe(true);
      expect(personalCreate).not.toHaveBeenCalled();
      expect(() => catalog.createWorkspace("team-gone", { name: "W", root })).toThrow();
    });

    it("creates a personal workspace with the draft as given", () => {
      const personal = createRepositories([]);
      const create = vi.fn(() => ({ id: "ws-p" }));
      (personal.savedWorkspaces as unknown as { create: typeof create }).create = create;
      const catalog = createVaultCatalog(asScope(personal));
      const draft = { name: "W", root: { id: "leaf", kind: "leaf", target: { kind: "local", label: "L" } } as const, favorite: true };

      expect(catalog.createWorkspace(PERSONAL_VAULT_ID, draft)).toEqual({ id: "ws-p" });
      expect(create).toHaveBeenCalledWith(draft);
    });
  });
});
