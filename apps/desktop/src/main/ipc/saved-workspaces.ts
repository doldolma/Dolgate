import { ipcMain } from "electron";
import type { SavedWorkspaceDraft } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

/**
 * 저장된 Workspace 의 IPC 핸들러.
 *
 * **변경 핸들러는 queueSync 와 emitWorkspaceChanged 를 함께 부른다.** queueSync 만 부르던 동안
 * 다른 창은 아무 통지를 받지 못해 삭제한 카드를 계속 보여주고, 거기서 이름을 바꾸면 주 프로세스가
 * "Saved workspace not found" 로 거절했다. 로그인한 온라인 세션은 30초 폴링으로 스스로 낫지만
 * 그 폴링은 계정이 있어야 돌고 Workspace 는 계정이 필요 없는 기능이라, 로컬 전용·오프라인·볼트가
 * 잠긴 세션은 앱을 다시 켤 때까지 낫지 않았다(hosts-groups.ts 의 모든 변경 핸들러가 이 짝을 지킨다).
 */
export function registerSavedWorkspacesIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.savedWorkspaces.list, async () =>
    ctx.savedWorkspaces.list(),
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.create,
    async (event, draft: SavedWorkspaceDraft) => {
      const record = ctx.savedWorkspaces.create(draft);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.rename,
    async (event, id: string, name: string) => {
      const record = ctx.savedWorkspaces.rename(id, name);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.moveToGroup,
    async (event, id: string, groupName: string | null) => {
      const record = ctx.savedWorkspaces.moveToGroup(id, groupName);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.setFavorite,
    async (event, id: string, favorite: boolean) => {
      const record = ctx.savedWorkspaces.setFavorite(id, favorite);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.touchOpened,
    async (event, id: string) => {
      const record = ctx.savedWorkspaces.touchOpened(id);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.remove,
    async (event, id: string) => {
      ctx.savedWorkspaces.remove(id);
      ctx.syncOutbox.upsertDeletion("workspaces", id);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
    },
  );
}
