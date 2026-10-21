import { ipcMain } from "electron";
import type { MyHostCredentialsInput, MyHostCredentialsSummary, VaultCopyRequest, VaultIndex } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { logMessage } from "../activity-log-message";
import { getTeamInviteInbox } from "../team-invite-inbox";
import type { TeamHostCredentials } from "../team-member-prefs";
import { VaultCopyService } from "../vault-copy-service";
import type { MainIpcContext } from "./context";
import { clearRuntimeSecretCache } from "./coordinators/secret-coordinator";

/**
 * 팀 볼트 관리의 IPC 핸들러. 일은 TeamService 가 하고, 여기는 채널을 잇기만 한다.
 *
 * 팀 목록이 바뀐 것은 팀 동기화가 teams:changed 로 모든 창에 알린다(main.ts). 그래서 여기서는 따로
 * 알리지 않는다.
 */
export function registerTeamsIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.teams.list, async () => ctx.teams.list());
  ipcMain.handle(ipcChannels.teams.getAvailability, async () => ctx.teams.getAvailability());
  ipcMain.handle(ipcChannels.teams.getVaultIndex, async () => buildVaultIndex(ctx));
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
    async (_event, teamId: string, options?: { expiresInHours?: number }) => ctx.teams.createInvite(teamId, options),
  );
  ipcMain.handle(ipcChannels.teams.listInvites, async (_event, teamId: string) => ctx.teams.listInvites(teamId));
  ipcMain.handle(ipcChannels.teams.revokeInvite, async (_event, teamId: string, code: string) =>
    ctx.teams.revokeInvite(teamId, code),
  );
  ipcMain.handle(ipcChannels.teams.getInviteInfo, async (_event, link: string) => ctx.teams.getInviteInfo(link));
  ipcMain.handle(ipcChannels.teams.previewInvite, async (_event, link: string) => ctx.teams.previewInvite(link));
  ipcMain.handle(ipcChannels.teams.join, async (_event, link: string) => ctx.teams.join(link));
  // 브라우저의 링크 페이지가 넘긴 초대 링크(main.ts 의 딥 링크가 넣는다). 한 창만 가져간다.
  ipcMain.handle(ipcChannels.teams.takePendingInviteLink, async () => getTeamInviteInbox().take());

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
      ctx.vaults.setMyHostCredentials(
        hostId,
        mergeMyHostCredentials(ctx.vaults.getMyHostCredentials(hostId), credentials),
      );
      // 이 실행 동안 붙은 값(재연결용 캐시)은 버린다 — 바꾼 내 것이 이기고, 남는 것이 없으면 다시 묻는다.
      clearRuntimeSecretCache(hostId);
      ctx.activityLogs.append("info", "audit", logMessage("teams.myCredentialsSaved"), { hostId });
      ctx.queueSync();
      return summarizeMyCredentials(ctx.vaults.getMyHostCredentials(hostId));
    },
  );
  ipcMain.handle(ipcChannels.teams.clearMyCredentials, async (_event, hostId: string) => {
    ctx.vaults.setMyHostCredentials(hostId, null);
    // 지웠는데 이 실행 동안 붙은 값으로 계속 붙으면 지운 것이 아니다 — 다음 접속은 다시 묻는다.
    clearRuntimeSecretCache(hostId);
    ctx.activityLogs.append("info", "audit", logMessage("teams.myCredentialsCleared"), { hostId });
    ctx.queueSync();
  });
}

/**
 * 화면이 레코드의 볼트를 찾는 표. 팀 이름·역할·상태는 팀 목록에서, 그룹과 레코드의 임자는 카탈로그에서 온다 —
 * 둘 다 이 기기의 상태 파일을 읽으므로 같은 팀들을 본다.
 */
function buildVaultIndex(ctx: Pick<MainIpcContext, "teams" | "vaults">): VaultIndex {
  const { groupsByTeamId, ...index } = ctx.vaults.describeTeamVaults();
  return {
    teams: ctx.teams.list().map((team) => ({ ...team, groups: groupsByTeamId[team.id] ?? [] })),
    ...index,
  };
}

// 비밀값 — 화면으로 돌려주지 않는 칸들.
const SECRET_FIELDS = [
  "password",
  "passphrase",
  "privateKeyPem",
  "certificateText",
  "privateKeyPath",
  "certificatePath",
] as const;

/**
 * 내 자격 증명 저장. 이름·인증 방식·도메인은 보낸 대로 둔다(비우면 팀 것). 비밀값은 화면이 돌려받지 않으니 비워
 * 보내면 그대로 둔다 — 안 그러면 이름만 고쳐도 저장된 비밀번호가 지워진다. 인증 방식을 바꾸면 옛 방식의 비밀값은
 * 버린다(새 방식에 쓰이지 않는 것이 남지 않게). 남는 것이 없으면 null(지운 것과 같다).
 */
export function mergeMyHostCredentials(
  current: TeamHostCredentials | null,
  input: MyHostCredentialsInput,
): TeamHostCredentials | null {
  const sameAuthType = (current?.authType ?? null) === (input.authType ?? null);
  const next: TeamHostCredentials = {};
  const username = input.username?.trim();
  if (username) {
    next.username = username;
  }
  if (input.authType) {
    next.authType = input.authType;
  }
  const domain = input.domain?.trim();
  if (domain) {
    next.domain = domain;
  }
  for (const field of SECRET_FIELDS) {
    const value = input[field] || (sameAuthType ? current?.[field] : undefined);
    if (value) {
      next[field] = value;
    }
  }
  return Object.keys(next).length > 0 ? next : null;
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
