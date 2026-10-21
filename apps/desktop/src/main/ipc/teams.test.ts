import { describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

// 볼트 사이 복사는 서비스가 한다. 여기서는 채널이 서비스로 가고, 복사 뒤 기록·동기화가 걸리는지만 본다.
const copyMocks = vi.hoisted(() => ({
  deps: null as null | { vaults: unknown; onCopied: (copied: unknown) => void },
  preview: vi.fn(() => ({ hosts: 2 })),
  copy: vi.fn(() => ({ hostIds: { web: "web-copy" }, counts: { hosts: 2 } })),
}));

vi.mock("../vault-copy-service", () => ({
  VaultCopyService: class {
    constructor(deps: { vaults: unknown; onCopied: (copied: unknown) => void }) {
      copyMocks.deps = deps;
    }
    preview = copyMocks.preview;
    copy = copyMocks.copy;
  },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

import { registerTeamsIpcHandlers } from "./teams";
import { clearRuntimeSecretCache, createSecretCoordinator } from "./coordinators/secret-coordinator";
import { getTeamInviteInbox } from "../team-invite-inbox";

describe("teams IPC", () => {
  it("hands every channel to the team service with its arguments", async () => {
    const teams = {
      list: vi.fn(() => "list"),
      getAvailability: vi.fn(async () => "availability"),
      refresh: vi.fn(async () => "refreshed"),
      create: vi.fn(async () => "created"),
      rename: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      transferOwnership: vi.fn(async () => undefined),
      listMembers: vi.fn(async () => "members"),
      removeMember: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
      createInvite: vi.fn(async () => "invite"),
      listInvites: vi.fn(async () => "invites"),
      revokeInvite: vi.fn(async () => undefined),
      getInviteInfo: vi.fn(async () => "info"),
      previewInvite: vi.fn(async () => "preview"),
      join: vi.fn(async () => "joined"),
    };
    registerTeamsIpcHandlers({ teams } as never);

    const calls: Array<[string, unknown[], keyof typeof teams, unknown[]]> = [
      [ipcChannels.teams.list, [], "list", []],
      [ipcChannels.teams.getAvailability, [], "getAvailability", []],
      [ipcChannels.teams.refresh, [], "refresh", []],
      [ipcChannels.teams.create, ["Acme"], "create", ["Acme"]],
      [ipcChannels.teams.rename, ["t1", "Ops"], "rename", ["t1", "Ops"]],
      [ipcChannels.teams.remove, ["t1"], "remove", ["t1"]],
      [ipcChannels.teams.transferOwnership, ["t1", "u2"], "transferOwnership", ["t1", "u2"]],
      [ipcChannels.teams.listMembers, ["t1"], "listMembers", ["t1"]],
      [ipcChannels.teams.removeMember, ["t1", "u2"], "removeMember", ["t1", "u2"]],
      [ipcChannels.teams.leave, ["t1"], "leave", ["t1"]],
      [ipcChannels.teams.createInvite, ["t1", { expiresInHours: 72 }], "createInvite", ["t1", { expiresInHours: 72 }]],
      [ipcChannels.teams.previewInvite, ["https://s/invite/c#v1.x"], "previewInvite", ["https://s/invite/c#v1.x"]],
      [ipcChannels.teams.listInvites, ["t1"], "listInvites", ["t1"]],
      [ipcChannels.teams.revokeInvite, ["t1", "code-1"], "revokeInvite", ["t1", "code-1"]],
      [ipcChannels.teams.getInviteInfo, ["https://s/invite/c#v1.x"], "getInviteInfo", ["https://s/invite/c#v1.x"]],
      [ipcChannels.teams.join, ["https://s/invite/c#v1.x"], "join", ["https://s/invite/c#v1.x"]],
    ];
    for (const [channel, args, method, expected] of calls) {
      const handler = electronMocks.handlers.get(channel);
      expect(handler, channel).toBeTypeOf("function");
      await expect(handler?.({}, ...args)).resolves.toBe(await teams[method].getMockImplementation()?.());
      expect(teams[method]).toHaveBeenLastCalledWith(...expected);
    }
  });

  it("hands the invite link the link page passed on to the window that asks first", async () => {
    registerTeamsIpcHandlers({ teams: {} } as never);
    const take = electronMocks.handlers.get(ipcChannels.teams.takePendingInviteLink)!;
    getTeamInviteInbox().receive("https://s/invite/c#v1.x");

    await expect(take({})).resolves.toBe("https://s/invite/c#v1.x");
    await expect(take({})).resolves.toBeNull();
  });

  it("builds the vault index from the team list and the catalog's layout", async () => {
    const acme = { id: "team-1", name: "Acme", role: "owner", syncState: "ready", syncError: null };
    const beta = { id: "team-2", name: "Beta", role: "member", syncState: "idle", syncError: null };
    const prod = { id: "g-1", name: "Prod", path: "Prod" };
    const teams = { list: vi.fn(() => [acme, beta]) };
    const vaults = {
      describeTeamVaults: vi.fn(() => ({
        groupsByTeamId: { "team-1": [prod] },
        teamIdByHostId: { "host-t": "team-1" },
        teamIdByWorkspaceId: { "ws-t": "team-1" },
        teamIdByPortForwardId: { "pf-t": "team-2" },
        teamIdByDnsOverrideId: { "dns-t": "team-2" },
        teamIdBySnippetId: { "snip-t": "team-1" },
        myUsernameByHostId: { "host-t": "bob" },
      })),
    };
    registerTeamsIpcHandlers({ teams, vaults } as never);

    await expect(electronMocks.handlers.get(ipcChannels.teams.getVaultIndex)?.({})).resolves.toEqual({
      // 그룹이 없는 팀도 빈 목록으로 온다 — 화면은 팀마다 그룹 목록이 있다고 믿는다.
      teams: [
        { ...acme, groups: [prod] },
        { ...beta, groups: [] },
      ],
      teamIdByHostId: { "host-t": "team-1" },
      teamIdByWorkspaceId: { "ws-t": "team-1" },
      teamIdByPortForwardId: { "pf-t": "team-2" },
      teamIdByDnsOverrideId: { "dns-t": "team-2" },
      teamIdBySnippetId: { "snip-t": "team-1" },
      myUsernameByHostId: { "host-t": "bob" },
    });
  });

  it("hands vault copies to the copy service and logs and syncs after one", async () => {
    const vaults = { name: "catalog" };
    const append = vi.fn();
    const queueSync = vi.fn();
    registerTeamsIpcHandlers({ teams: {}, vaults, activityLogs: { append }, queueSync } as never);
    const request = {
      sourceVaultId: "personal",
      targetVaultId: "t1",
      selection: { kind: "hosts", hostIds: ["web"] },
      targetGroupPath: null,
    };

    await expect(electronMocks.handlers.get(ipcChannels.teams.previewCopy)?.({}, request)).resolves.toEqual({ hosts: 2 });
    expect(copyMocks.preview).toHaveBeenLastCalledWith(request);
    await expect(electronMocks.handlers.get(ipcChannels.teams.copy)?.({}, request)).resolves.toEqual({
      hostIds: { web: "web-copy" },
      counts: { hosts: 2 },
    });
    expect(copyMocks.copy).toHaveBeenLastCalledWith(request);
    expect(copyMocks.deps?.vaults).toBe(vaults);

    copyMocks.deps?.onCopied({ request, counts: { hosts: 2 } });
    expect(append).toHaveBeenCalledWith(
      "info",
      "audit",
      { message: "2개 호스트를 다른 볼트로 복사했습니다.", messageKey: "teams.copied", messageParams: { hosts: 2 } },
      { sourceVaultId: "personal", targetVaultId: "t1", hosts: 2 },
    );
    expect(queueSync).toHaveBeenCalledTimes(1);
  });

  it("keeps my credentials for a team host and never hands their secrets to the screen", async () => {
    let stored: Record<string, string> | null = null;
    const vaults = {
      getMyHostCredentials: vi.fn(() => stored),
      setMyHostCredentials: vi.fn((_hostId: string, credentials: Record<string, string> | null) => {
        stored = credentials;
      }),
    };
    const append = vi.fn();
    const queueSync = vi.fn();
    registerTeamsIpcHandlers({ teams: {}, vaults, activityLogs: { append }, queueSync } as never);
    const call = (channel: string, ...args: unknown[]) => electronMocks.handlers.get(channel)?.({}, ...args);

    await expect(call(ipcChannels.teams.getMyCredentials, "team-host")).resolves.toBeNull();
    const summary = await call(ipcChannels.teams.setMyCredentials, "team-host", {
      username: "alice",
      authType: "privateKey",
      privateKeyPem: "PEM",
      passphrase: "pp",
    });
    expect(vaults.setMyHostCredentials).toHaveBeenCalledWith("team-host", expect.objectContaining({ privateKeyPem: "PEM" }));
    expect(summary).toEqual({
      username: "alice",
      authType: "privateKey",
      domain: null,
      hasPassword: false,
      hasPrivateKey: true,
      hasCertificate: false,
      hasPassphrase: true,
    });
    expect(JSON.stringify(summary)).not.toContain("PEM");
    expect(append).toHaveBeenLastCalledWith("info", "audit", expect.objectContaining({ messageKey: "teams.myCredentialsSaved" }), { hostId: "team-host" });

    await call(ipcChannels.teams.clearMyCredentials, "team-host");
    expect(vaults.setMyHostCredentials).toHaveBeenLastCalledWith("team-host", null);
    expect(append).toHaveBeenLastCalledWith("info", "audit", expect.objectContaining({ messageKey: "teams.myCredentialsCleared" }), { hostId: "team-host" });
    expect(queueSync).toHaveBeenCalledTimes(2);
  });

  // 내 자격 증명을 지우거나 바꾼 뒤에도 이 실행 동안 붙은 값(재연결용 캐시)으로 붙으면 지운 것이 아니다 — 4-9 에서 C 가
  // 지운 뒤 SFTP 를 열자 베스천을 묻지 않았다. 바꾸거나 지우면 그 호스트의 캐시도 버린다.
  describe("the value remembered for reconnecting", () => {
    const teamHost = {
      id: "team-host",
      kind: "ssh",
      label: "Shared",
      hostname: "shared.example.com",
      port: 22,
      username: "deploy",
      authType: "password",
      secretRef: null,
    } as never;

    function setup() {
      clearRuntimeSecretCache();
      let stored: Record<string, string> | null = null;
      const vaults = {
        loadSecret: vi.fn(async () => null),
        scopeOfHost: vi.fn(() => ({ id: "team-1" })),
        getHost: vi.fn(() => teamHost),
        getMyHostCredentials: vi.fn(() => stored),
        setMyHostCredentials: vi.fn((_hostId: string, credentials: Record<string, string> | null) => {
          stored = credentials;
        }),
        setHostLoginUsername: vi.fn(),
      };
      const secrets = createSecretCoordinator({ vaults, queueSync: vi.fn(), activityLogs: { append: vi.fn() } } as never);
      registerTeamsIpcHandlers({ teams: {}, vaults, activityLogs: { append: vi.fn() }, queueSync: vi.fn() } as never);
      const call = (channel: string, ...args: unknown[]) => electronMocks.handlers.get(channel)?.({}, ...args);
      const passwordToConnectWith = async () => (await secrets.resolveSshAuth(teamHost)).secrets.password;
      return { secrets, call, passwordToConnectWith };
    }

    it("is forgotten when my credentials are cleared", async () => {
      const { secrets, call, passwordToConnectWith } = setup();
      // 요청 창에 넣어 붙은 값 — 내 자격 증명에 저장되고 이 실행 동안 재연결용으로 기억된다.
      await secrets.persistHostSpecificSecret("team-host", "Shared", { password: "typed" });
      await expect(passwordToConnectWith()).resolves.toBe("typed");

      await call(ipcChannels.teams.clearMyCredentials, "team-host");

      await expect(passwordToConnectWith()).resolves.toBeUndefined();
      clearRuntimeSecretCache();
    });

    it("is forgotten when my credentials are changed", async () => {
      const { secrets, call, passwordToConnectWith } = setup();
      await secrets.persistHostSpecificSecret("team-host", "Shared", { password: "typed" });

      // 비밀값이 남지 않는 방식으로 바꾸면 그 값으로 붙지 않는다.
      await call(ipcChannels.teams.setMyCredentials, "team-host", { authType: "agent" });

      await expect(passwordToConnectWith()).resolves.toBeUndefined();
      clearRuntimeSecretCache();
    });
  });

  it("keeps the secrets you leave blank when saving my credentials, and drops them when the auth type changes", async () => {
    let stored: Record<string, string> | null = { username: "alice", authType: "password", password: "pw" };
    const vaults = {
      getMyHostCredentials: vi.fn(() => stored),
      setMyHostCredentials: vi.fn((_hostId: string, credentials: Record<string, string> | null) => {
        stored = credentials;
      }),
    };
    registerTeamsIpcHandlers({ teams: {}, vaults, activityLogs: { append: vi.fn() }, queueSync: vi.fn() } as never);
    const call = (channel: string, ...args: unknown[]) => electronMocks.handlers.get(channel)?.({}, ...args);

    // 이름만 고쳐도 비밀번호는 남는다 — 화면은 비밀값을 모른다.
    let summary = await call(ipcChannels.teams.setMyCredentials, "team-host", { username: " bob ", authType: "password" });
    expect(stored).toEqual({ username: "bob", authType: "password", password: "pw" });
    expect(summary).toMatchObject({ username: "bob", hasPassword: true });

    // 방식을 바꾸면 옛 비밀번호는 버리고 새 키만.
    summary = await call(ipcChannels.teams.setMyCredentials, "team-host", {
      username: "bob",
      authType: "privateKey",
      privateKeyPem: "PEM",
    });
    expect(stored).toEqual({ username: "bob", authType: "privateKey", privateKeyPem: "PEM" });
    expect(summary).toMatchObject({ hasPassword: false, hasPrivateKey: true });

    // 이름을 비우면 팀 것으로 돌아간다(이름 칸이 없어진다). 남는 것이 없으면 지운 것과 같다.
    await call(ipcChannels.teams.setMyCredentials, "team-host", { authType: "privateKey" });
    expect(stored).toEqual({ authType: "privateKey", privateKeyPem: "PEM" });
    stored = { password: "pw" };
    await call(ipcChannels.teams.setMyCredentials, "team-host", { authType: "agent" });
    expect(stored).toEqual({ authType: "agent" });
    stored = { password: "pw" };
    await call(ipcChannels.teams.setMyCredentials, "team-host", { authType: "agent", username: "" });
    expect(vaults.setMyHostCredentials).toHaveBeenLastCalledWith("team-host", { authType: "agent" });
  });
});
