import { ipcMain } from "electron";
import type { SavedWorkspaceDraft, SavedWorkspaceNode } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { t } from "../i18n";
import { PERSONAL_VAULT_ID } from "../vault-catalog";
import type { MainIpcContext } from "./context";

/** 창이 가리키는 호스트 id(로컬 창 빼고). 모양이 틀린 마디는 건너뛴다 — 검사는 저장소가 한다. */
export function listWorkspaceHostIds(node: SavedWorkspaceNode | null | undefined): string[] {
  if (node?.kind === "leaf") {
    return node.target?.kind === "host" ? [node.target.hostId] : [];
  }
  if (node?.kind === "split") {
    return [...listWorkspaceHostIds(node.first), ...listWorkspaceHostIds(node.second)];
  }
  return [];
}

/**
 * 새 워크스페이스가 들어갈 볼트 — 창의 호스트가 든 볼트다(로컬 창만이면 vaultId, 없으면 개인). 지워져 어디에도 없는
 * 호스트는 세지 않는다. 볼트가 섞였거나 vaultId 와 다르면 거절한다 — 팀 워크스페이스가 개인 호스트를(또는 그 반대를)
 * 가리키면 팀원에게는 없는 창이 된다.
 */
function resolveWorkspaceVault(ctx: MainIpcContext, draft: SavedWorkspaceDraft, vaultId?: string): string {
  const vaultIds = new Set(
    listWorkspaceHostIds(draft.root)
      .filter((hostId) => ctx.vaults.getHost(hostId) !== null)
      .map((hostId) => ctx.vaults.scopeOfHost(hostId).id),
  );
  if (vaultIds.size > 1 || (vaultId !== undefined && vaultIds.size === 1 && !vaultIds.has(vaultId))) {
    const involved = new Set([...vaultIds, ...(vaultId === undefined ? [] : [vaultId])]);
    throw new Error(t(involved.has(PERSONAL_VAULT_ID) ? "savedWorkspace.mixedVaults" : "savedWorkspace.mixedTeams"));
  }
  return [...vaultIds][0] ?? vaultId ?? PERSONAL_VAULT_ID;
}

/**
 * 저장된 Workspace 의 IPC 핸들러.
 *
 * 내용 변경은 queueSync 와 emitWorkspaceChanged 를 함께 부른다. 기기별 열기 기록은
 * emitWorkspaceChanged만 사용한다. queueSync 만 부르던 동안
 * 다른 창은 아무 통지를 받지 못해 삭제한 카드를 계속 보여주고, 거기서 이름을 바꾸면 주 프로세스가
 * "Saved workspace not found" 로 거절했다. 로그인한 온라인 세션은 30초 폴링으로 스스로 낫지만
 * 그 폴링은 계정이 있어야 돌고 Workspace 는 계정이 필요 없는 기능이라, 로컬 전용·오프라인·볼트가
 * 잠긴 세션은 앱을 다시 켤 때까지 낫지 않았다(hosts-groups.ts 의 모든 변경 핸들러가 이 짝을 지킨다).
 */
export function registerSavedWorkspacesIpcHandlers(ctx: MainIpcContext): void {
  // 목록·즐겨찾기·열기는 팀 워크스페이스까지 본다(팀 것은 즐겨찾기·연 시각이 내 칸에 있다).
  ipcMain.handle(ipcChannels.savedWorkspaces.list, async () =>
    ctx.vaults.listWorkspaces(),
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.create,
    async (event, draft: SavedWorkspaceDraft, vaultId?: string) => {
      const record = ctx.vaults.createWorkspace(resolveWorkspaceVault(ctx, draft, vaultId), draft);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.rename,
    async (event, id: string, name: string) => {
      const record = ctx.vaults.renameWorkspace(id, name);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.moveToGroup,
    async (event, id: string, groupName: string | null) => {
      const record = ctx.vaults.moveWorkspaceToGroup(id, groupName);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.setFavorite,
    async (event, id: string, favorite: boolean) => {
      const record = ctx.vaults.setWorkspaceFavorite(id, favorite);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.touchOpened,
    async (event, id: string) => {
      const record = ctx.vaults.touchWorkspaceOpened(id);
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.savedWorkspaces.remove,
    async (event, id: string) => {
      ctx.vaults.removeWorkspace(id);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
    },
  );
}
