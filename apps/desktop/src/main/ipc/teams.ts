import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

/**
 * 팀 볼트 관리의 IPC 핸들러. 일은 TeamService 가 하고, 여기는 채널을 잇기만 한다.
 *
 * 팀 목록이 바뀐 것은 팀 동기화가 teams:changed 로 모든 창에 알린다(main.ts). 그래서 여기서는 따로
 * 알리지 않는다.
 */
export function registerTeamsIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.teams.list, async () => ctx.teams.list());
  ipcMain.handle(ipcChannels.teams.refresh, async () => ctx.teams.refresh());
  ipcMain.handle(ipcChannels.teams.create, async (_event, name: string) => ctx.teams.create(name));
  ipcMain.handle(ipcChannels.teams.rename, async (_event, teamId: string, name: string) =>
    ctx.teams.rename(teamId, name),
  );
  ipcMain.handle(ipcChannels.teams.remove, async (_event, teamId: string) => ctx.teams.remove(teamId));
  ipcMain.handle(ipcChannels.teams.transferOwnership, async (_event, teamId: string, userId: string) =>
    ctx.teams.transferOwnership(teamId, userId),
  );
  ipcMain.handle(ipcChannels.teams.listMembers, async (_event, teamId: string) => ctx.teams.listMembers(teamId));
  ipcMain.handle(ipcChannels.teams.removeMember, async (_event, teamId: string, userId: string) =>
    ctx.teams.removeMember(teamId, userId),
  );
  ipcMain.handle(ipcChannels.teams.leave, async (_event, teamId: string) => ctx.teams.leave(teamId));
  ipcMain.handle(
    ipcChannels.teams.createInvite,
    async (_event, teamId: string, options?: { expiresInDays?: number }) => ctx.teams.createInvite(teamId, options),
  );
  ipcMain.handle(ipcChannels.teams.listInvites, async (_event, teamId: string) => ctx.teams.listInvites(teamId));
  ipcMain.handle(ipcChannels.teams.revokeInvite, async (_event, teamId: string, code: string) =>
    ctx.teams.revokeInvite(teamId, code),
  );
  ipcMain.handle(ipcChannels.teams.getInviteInfo, async (_event, link: string) => ctx.teams.getInviteInfo(link));
  ipcMain.handle(ipcChannels.teams.join, async (_event, link: string) => ctx.teams.join(link));
}
