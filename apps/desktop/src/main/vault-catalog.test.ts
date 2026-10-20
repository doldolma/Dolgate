import type { HostDraft, HostRecord, SavedWorkspaceRecord, TerminalThemeId } from "@shared";
import { describe, expect, it, vi } from "vitest";
import type { HostRepository, SavedWorkspaceRepository } from "./database";
import type { TeamHostPrefsRecord, TeamWorkspacePrefsRecord } from "./state-storage";
import type {
  TeamAwsProfileCredentials,
  TeamHostCredentials,
  TeamMemberPrefsStore,
  TeamTailnetCredentials,
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
    } as unknown as HostRepository & Record<"setFavorite" | "setTerminalTheme" | "update", ReturnType<typeof vi.fn>>,
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
  const awsCredentials = new Map<string, TeamAwsProfileCredentials>();
  const tailnetCredentials = new Map<string, TeamTailnetCredentials>();
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
    readAwsProfileCredentials: vi.fn((profileId: string) => awsCredentials.get(profileId) ?? null),
    writeAwsProfileCredentials: keep(awsCredentials),
    readTailnetCredentials: vi.fn((tailnetId: string) => tailnetCredentials.get(tailnetId) ?? null),
    writeTailnetCredentials: keep(tailnetCredentials),
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
  });
});
