import { describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
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
});
