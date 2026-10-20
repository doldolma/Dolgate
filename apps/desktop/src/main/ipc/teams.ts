import { ipcMain } from "electron";
import type { MyHostCredentialsInput, MyHostCredentialsSummary, VaultCopyRequest } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { logMessage } from "../activity-log-message";
import type { TeamHostCredentials } from "../team-member-prefs";
import { VaultCopyService } from "../vault-copy-service";
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

  // 볼트 사이 복사(공유 = 복사). 쓰고 나면 기록을 남기고 개인·팀 동기화를 건다.
  const vaultCopies = new VaultCopyService({
    vaults: ctx.vaults,
    onCopied: ({ request, counts }) => {
      ctx.activityLogs.append("info", "audit", logMessage("teams.copied", { hosts: counts.hosts }), {
        sourceVaultId: request.sourceVaultId,
        targetVaultId: request.targetVaultId,
        hosts: counts.hosts,
      });
      ctx.queueSync();
    },
  });
  ipcMain.handle(ipcChannels.teams.previewCopy, async (_event, request: VaultCopyRequest) =>
    vaultCopies.preview(request),
  );
  ipcMain.handle(ipcChannels.teams.copy, async (_event, request: VaultCopyRequest) => vaultCopies.copy(request));

  // 팀 호스트에 쓰는 내 자격 증명(멤버 개인 칸). 비밀값은 화면으로 돌려주지 않는다.
  ipcMain.handle(ipcChannels.teams.getMyCredentials, async (_event, hostId: string) =>
    summarizeMyCredentials(ctx.vaults.getMyHostCredentials(hostId)),
  );
  ipcMain.handle(
    ipcChannels.teams.setMyCredentials,
    async (_event, hostId: string, credentials: MyHostCredentialsInput) => {
      ctx.vaults.setMyHostCredentials(hostId, credentials);
      ctx.activityLogs.append("info", "audit", logMessage("teams.myCredentialsSaved"), { hostId });
      ctx.queueSync();
      return summarizeMyCredentials(ctx.vaults.getMyHostCredentials(hostId));
    },
  );
  ipcMain.handle(ipcChannels.teams.clearMyCredentials, async (_event, hostId: string) => {
    ctx.vaults.setMyHostCredentials(hostId, null);
    ctx.activityLogs.append("info", "audit", logMessage("teams.myCredentialsCleared"), { hostId });
    ctx.queueSync();
  });
}

function summarizeMyCredentials(credentials: TeamHostCredentials | null): MyHostCredentialsSummary | null {
  if (!credentials) {
    return null;
  }
  return {
    username: credentials.username ?? null,
    authType: credentials.authType ?? null,
    domain: credentials.domain ?? null,
    hasPassword: Boolean(credentials.password),
    hasPrivateKey: Boolean(credentials.privateKeyPem),
    hasCertificate: Boolean(credentials.certificateText),
    hasPassphrase: Boolean(credentials.passphrase),
  };
}
