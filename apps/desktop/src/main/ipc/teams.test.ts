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

describe("teams IPC", () => {
  it("hands every channel to the team service with its arguments", async () => {
    const teams = {
      list: vi.fn(() => "list"),
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
      join: vi.fn(async () => "joined"),
    };
    registerTeamsIpcHandlers({ teams } as never);

    const calls: Array<[string, unknown[], keyof typeof teams, unknown[]]> = [
      [ipcChannels.teams.list, [], "list", []],
      [ipcChannels.teams.refresh, [], "refresh", []],
      [ipcChannels.teams.create, ["Acme"], "create", ["Acme"]],
      [ipcChannels.teams.rename, ["t1", "Ops"], "rename", ["t1", "Ops"]],
      [ipcChannels.teams.remove, ["t1"], "remove", ["t1"]],
      [ipcChannels.teams.transferOwnership, ["t1", "u2"], "transferOwnership", ["t1", "u2"]],
      [ipcChannels.teams.listMembers, ["t1"], "listMembers", ["t1"]],
      [ipcChannels.teams.removeMember, ["t1", "u2"], "removeMember", ["t1", "u2"]],
      [ipcChannels.teams.leave, ["t1"], "leave", ["t1"]],
      [ipcChannels.teams.createInvite, ["t1", { expiresInDays: 3 }], "createInvite", ["t1", { expiresInDays: 3 }]],
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
});
