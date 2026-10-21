import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        electronMocks.handlers.set(channel, handler);
      },
    ),
  },
}));

import { registerSavedWorkspacesIpcHandlers } from "./saved-workspaces";
import { withVaults } from "../vault-catalog.test-support";

describe("saved workspace IPC", () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
  });

  // 팀 워크스페이스도 id 로 그 볼트를 찾아 고친다(예전에는 개인 저장소만 봐서 "찾을 수 없음"이었다).
  it("renames, moves and removes a Workspace through the catalog so team ones work too", async () => {
    const ctx = withVaults({
      savedWorkspaces: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), moveToGroup: vi.fn(), remove: vi.fn() },
      syncOutbox: { upsertDeletion: vi.fn() },
      queueSync: vi.fn(),
      emitWorkspaceChanged: vi.fn(),
    } as any);
    const record = { id: "team-ws", name: "Deploy" };
    ctx.vaults = {
      ...ctx.vaults,
      renameWorkspace: vi.fn(() => record),
      moveWorkspaceToGroup: vi.fn(() => record),
      removeWorkspace: vi.fn(),
    } as any;
    registerSavedWorkspacesIpcHandlers(ctx);

    await expect(
      electronMocks.handlers.get(ipcChannels.savedWorkspaces.rename)?.({ sender: "w" }, "team-ws", "Deploy"),
    ).resolves.toBe(record);
    await electronMocks.handlers.get(ipcChannels.savedWorkspaces.moveToGroup)?.({ sender: "w" }, "team-ws", "Prod");
    await electronMocks.handlers.get(ipcChannels.savedWorkspaces.remove)?.({ sender: "w" }, "team-ws");

    expect(ctx.vaults.renameWorkspace).toHaveBeenCalledWith("team-ws", "Deploy");
    expect(ctx.vaults.moveWorkspaceToGroup).toHaveBeenCalledWith("team-ws", "Prod");
    expect(ctx.vaults.removeWorkspace).toHaveBeenCalledWith("team-ws");
    expect(ctx.savedWorkspaces.remove).not.toHaveBeenCalled();
    expect(ctx.queueSync).toHaveBeenCalledTimes(3);
    expect(ctx.emitWorkspaceChanged).toHaveBeenCalledTimes(3);
  });

  it("removes the local record, writes a workspace tombstone, and queues sync", async () => {
    const ctx = withVaults({
      savedWorkspaces: {
        list: vi.fn(),
        create: vi.fn(),
        rename: vi.fn(),
        moveToGroup: vi.fn(),
        setFavorite: vi.fn(),
        touchOpened: vi.fn(),
        remove: vi.fn(),
      },
      syncOutbox: {
        upsertDeletion: vi.fn(),
      },
      queueSync: vi.fn(),
    } as any);
    registerSavedWorkspacesIpcHandlers(ctx);

    await electronMocks.handlers.get(ipcChannels.savedWorkspaces.remove)?.(
      {},
      "workspace-1",
    );

    expect(ctx.savedWorkspaces.remove).toHaveBeenCalledWith("workspace-1");
    expect(ctx.syncOutbox.upsertDeletion).toHaveBeenCalledWith(
      "workspaces",
      "workspace-1",
    );
    expect(ctx.queueSync).toHaveBeenCalledOnce();
  });

  it("moves a Workspace to a group and queues sync", async () => {
    const record = { id: "workspace-1", groupName: "Clients" };
    const ctx = withVaults({
      savedWorkspaces: {
        list: vi.fn(),
        create: vi.fn(),
        rename: vi.fn(),
        moveToGroup: vi.fn(() => record),
        setFavorite: vi.fn(),
        touchOpened: vi.fn(),
        remove: vi.fn(),
      },
      syncOutbox: { upsertDeletion: vi.fn() },
      queueSync: vi.fn(),
    } as any);
    registerSavedWorkspacesIpcHandlers(ctx);

    const result = await electronMocks.handlers.get(
      ipcChannels.savedWorkspaces.moveToGroup,
    )?.({}, "workspace-1", "Clients");

    expect(ctx.savedWorkspaces.moveToGroup).toHaveBeenCalledWith(
      "workspace-1",
      "Clients",
    );
    expect(ctx.queueSync).toHaveBeenCalledOnce();
    expect(result).toEqual(record);
  });

  // queueSync 만 부르던 동안 다른 창은 아무 통지를 받지 못해, 이 창에서 지운 카드를 계속 보여주고
  // 거기서 이름을 바꾸면 주 프로세스가 "Saved workspace not found" 로 거절했다. 로그인한 온라인
  // 세션은 30초 폴링으로 낫지만 그 폴링은 계정이 있어야 돌고 Workspace 는 계정이 필요 없다.
  it("모든 변경을 다른 창에 알린다", async () => {
    const record = { id: "workspace-1" };
    const ctx = withVaults({
      savedWorkspaces: {
        list: vi.fn(),
        create: vi.fn().mockReturnValue(record),
        rename: vi.fn().mockReturnValue(record),
        moveToGroup: vi.fn().mockReturnValue(record),
        setFavorite: vi.fn().mockReturnValue(record),
        touchOpened: vi.fn().mockReturnValue(record),
        remove: vi.fn(),
      },
      syncOutbox: { upsertDeletion: vi.fn() },
      queueSync: vi.fn(),
      emitWorkspaceChanged: vi.fn(),
    } as any);
    registerSavedWorkspacesIpcHandlers(ctx);

    const sender = { id: 7 };
    const invocations: [string, unknown[]][] = [
      [ipcChannels.savedWorkspaces.create, [{ name: "W", root: {} }]],
      [ipcChannels.savedWorkspaces.rename, ["workspace-1", "W2"]],
      [ipcChannels.savedWorkspaces.moveToGroup, ["workspace-1", "Clients"]],
      [ipcChannels.savedWorkspaces.setFavorite, ["workspace-1", true]],
      [ipcChannels.savedWorkspaces.touchOpened, ["workspace-1"]],
      [ipcChannels.savedWorkspaces.remove, ["workspace-1"]],
    ];
    for (const [channel, args] of invocations) {
      await electronMocks.handlers.get(channel)?.({ sender }, ...args);
    }

    expect(ctx.queueSync).toHaveBeenCalledTimes(invocations.length - 1);
    expect(ctx.emitWorkspaceChanged).toHaveBeenCalledTimes(invocations.length);
    // 보낸 창은 이미 자기 store 를 고쳤으므로 제외한다.
    for (const call of ctx.emitWorkspaceChanged.mock.calls) {
      expect(call[0]).toBe(sender);
    }
  });

  it("목록 조회는 알리지 않는다", async () => {
    const ctx = withVaults({
      savedWorkspaces: { list: vi.fn().mockReturnValue([]) },
      syncOutbox: { upsertDeletion: vi.fn() },
      queueSync: vi.fn(),
      emitWorkspaceChanged: vi.fn(),
    } as any);
    registerSavedWorkspacesIpcHandlers(ctx);

    const handler = electronMocks.handlers.get(ipcChannels.savedWorkspaces.list);
    // 부정 단정만 두면 채널이 등록되지 않아도 테스트가 통과한다(핸들러가 undefined 라
    // 아무것도 불리지 않는다). 조회가 실제로 저장소까지 닿았는지 먼저 못 박는다.
    expect(handler).toBeTypeOf("function");
    await expect(handler?.({})).resolves.toEqual([]);
    expect(ctx.savedWorkspaces.list).toHaveBeenCalledOnce();

    expect(ctx.queueSync).not.toHaveBeenCalled();
    expect(ctx.emitWorkspaceChanged).not.toHaveBeenCalled();
  });
  // 4-6: 새 워크스페이스는 창의 호스트가 든 볼트에 만든다. 섞이면 저장하지 않는다.
  describe("creating a Workspace", () => {
    const leaf = (hostId: string | null) =>
      hostId
        ? { id: `leaf-${hostId}`, kind: "leaf", target: { kind: "host", hostId, label: hostId } }
        : { id: "leaf-local", kind: "leaf", target: { kind: "local", label: "Local" } };
    const split = (first: object, second: object) => ({ id: "split", kind: "split", axis: "horizontal", ratio: 0.5, first, second });
    const vault = (hostIds: string[]) => {
      const hosts = hostIds.map((id) => ({ id, kind: "ssh", label: id }));
      return {
        hosts: { getById: vi.fn((id: string) => hosts.find((host) => host.id === id) ?? null) },
        savedWorkspaces: { create: vi.fn((draft: object) => ({ ...draft, id: "ws-new" })) },
      };
    };
    const prefs = () => ({
      read: () => ({ hosts: new Map(), workspaces: new Map(), terminalThemeByHostId: {} }),
      readHostCredentials: () => null,
      updateWorkspace: vi.fn(),
    });
    function setup() {
      const personal = vault(["p1"]);
      const team = { ...vault(["t1", "t2"]), memberPrefs: prefs() };
      const other = { ...vault(["o1"]), memberPrefs: prefs() };
      const ctx = withVaults(
        { ...personal, queueSync: vi.fn(), emitWorkspaceChanged: vi.fn() },
        { "team-1": team, "team-2": other },
      );
      registerSavedWorkspacesIpcHandlers(ctx as any);
      const create = (root: object, vaultId?: string) =>
        electronMocks.handlers.get(ipcChannels.savedWorkspaces.create)?.({ sender: "w" }, { name: "W", root }, vaultId);
      return { personal, team, other, create };
    }

    it("goes to the vault of its panes' hosts — local panes don't count", async () => {
      const { personal, team, create } = setup();

      await create(split(leaf("t1"), split(leaf(null), leaf("t2"))));
      expect(team.savedWorkspaces.create).toHaveBeenCalledWith(expect.objectContaining({ name: "W", favorite: false }));
      expect(personal.savedWorkspaces.create).not.toHaveBeenCalled();

      await create(split(leaf("p1"), leaf(null)));
      expect(personal.savedWorkspaces.create).toHaveBeenCalledTimes(1);
    });

    it("refuses personal and team hosts together, and two teams together", async () => {
      const { personal, team, other, create } = setup();

      await expect(create(split(leaf("p1"), leaf("t1")))).rejects.toThrow("개인 호스트와 팀 호스트가 섞여 있어");
      await expect(create(split(leaf("t1"), leaf("o1")))).rejects.toThrow("여러 팀의 호스트가 섞여 있어");
      expect(personal.savedWorkspaces.create).not.toHaveBeenCalled();
      expect(team.savedWorkspaces.create).not.toHaveBeenCalled();
      expect(other.savedWorkspaces.create).not.toHaveBeenCalled();
    });

    // 복제는 원본 볼트를 넘긴다 — 로컬 창만 있거나 호스트가 지워졌어도 원본 볼트에 남는다.
    it("uses the given vault when no pane names a host that still exists, and refuses a different one", async () => {
      const { personal, team, create } = setup();

      await create(split(leaf(null), leaf("gone")), "team-1");
      expect(team.savedWorkspaces.create).toHaveBeenCalledTimes(1);

      await create(leaf("t2"), "team-1");
      expect(team.savedWorkspaces.create).toHaveBeenCalledTimes(2);

      await expect(create(leaf("p1"), "team-1")).rejects.toThrow("개인 호스트와 팀 호스트가 섞여 있어");
      await expect(create(leaf(null), "team-gone")).rejects.toThrow();
      expect(personal.savedWorkspaces.create).not.toHaveBeenCalled();
    });
  });
});
