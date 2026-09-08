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

describe("saved workspace IPC", () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
  });

  it("removes the local record, writes a workspace tombstone, and queues sync", async () => {
    const ctx = {
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
    } as any;
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
    const ctx = {
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
    } as any;
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
    const ctx = {
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
    } as any;
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

    expect(ctx.queueSync).toHaveBeenCalledTimes(invocations.length);
    expect(ctx.emitWorkspaceChanged).toHaveBeenCalledTimes(invocations.length);
    // 보낸 창은 이미 자기 store 를 고쳤으므로 제외한다.
    for (const call of ctx.emitWorkspaceChanged.mock.calls) {
      expect(call[0]).toBe(sender);
    }
  });

  it("목록 조회는 알리지 않는다", async () => {
    const ctx = {
      savedWorkspaces: { list: vi.fn().mockReturnValue([]) },
      syncOutbox: { upsertDeletion: vi.fn() },
      queueSync: vi.fn(),
      emitWorkspaceChanged: vi.fn(),
    } as any;
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
});