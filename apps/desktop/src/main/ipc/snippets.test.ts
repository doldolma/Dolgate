import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";
import { withVaults } from "../vault-catalog.test-support";
import { registerSnippetsIpcHandlers } from "./snippets";

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

// 스니펫은 그것이 든 볼트로 쓴다(4-6). 목록은 모든 볼트 것이다.
function vault(ids: string[]) {
  const snippets = ids.map((id) => ({ id, label: id, command: `echo ${id}`, createdAt: "t", updatedAt: "t" }));
  return {
    snippets: {
      list: vi.fn(() => snippets),
      getById: vi.fn((id: string) => snippets.find((snippet) => snippet.id === id) ?? null),
      create: vi.fn((draft: object) => ({ ...draft, id: "snip-new" })),
      update: vi.fn((id: string, draft: object) => ({ ...draft, id })),
      remove: vi.fn(),
    },
    hosts: { clearStartupSnippetRef: vi.fn() },
    syncOutbox: { upsertDeletion: vi.fn() },
  };
}

function setup() {
  const personal = vault(["snip-p"]);
  const team = { ...vault(["snip-t"]), memberPrefs: { read: () => ({ hosts: new Map(), workspaces: new Map() }) } };
  const ctx = withVaults({ ...personal, queueSync: vi.fn() }, { "team-1": team });
  registerSnippetsIpcHandlers(ctx as never);
  const call = (channel: string, ...args: unknown[]) => electronMocks.handlers.get(channel)?.({}, ...args);
  return { personal, team, ctx, call };
}

describe("registerSnippetsIpcHandlers", () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
  });

  it("lists every vault's snippets", async () => {
    const { call } = setup();

    const listed = (await call(ipcChannels.snippets.list)) as Array<{ id: string }>;

    expect(listed.map((snippet) => snippet.id)).toEqual(["snip-p", "snip-t"]);
  });

  it("creates in the vault the screen picked, or the personal vault", async () => {
    const { personal, team, ctx, call } = setup();
    const draft = { label: "Restart", command: "systemctl restart app" };

    await call(ipcChannels.snippets.create, draft, "team-1");
    expect(team.snippets.create).toHaveBeenCalledWith(draft);
    expect(personal.snippets.create).not.toHaveBeenCalled();

    await call(ipcChannels.snippets.create, draft);
    expect(personal.snippets.create).toHaveBeenCalledWith(draft);
    expect(ctx.queueSync).toHaveBeenCalledTimes(2);

    await expect(call(ipcChannels.snippets.create, draft, "team-gone")).rejects.toThrow();
  });

  it("updates and removes a team snippet in the team vault, freeing that vault's startup commands", async () => {
    const { personal, team, call } = setup();

    await call(ipcChannels.snippets.update, "snip-t", { label: "x", command: "y" });
    expect(team.snippets.update).toHaveBeenCalledWith("snip-t", { label: "x", command: "y" });

    await call(ipcChannels.snippets.remove, "snip-t");
    expect(team.snippets.remove).toHaveBeenCalledWith("snip-t");
    expect(team.hosts.clearStartupSnippetRef).toHaveBeenCalledWith("snip-t");
    expect(team.syncOutbox.upsertDeletion).toHaveBeenCalledWith("snippets", "snip-t");
    expect(personal.snippets.remove).not.toHaveBeenCalled();
    expect(personal.hosts.clearStartupSnippetRef).not.toHaveBeenCalled();

    await call(ipcChannels.snippets.remove, "snip-p");
    expect(personal.snippets.remove).toHaveBeenCalledWith("snip-p");
    expect(personal.hosts.clearStartupSnippetRef).toHaveBeenCalledWith("snip-p");
    expect(personal.syncOutbox.upsertDeletion).toHaveBeenCalledWith("snippets", "snip-p");
  });
});
