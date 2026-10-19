import { randomUUID } from "node:crypto";
import {
  createTeamDek,
  createTeamInviteSecret,
  deriveTeamInviteJoinToken,
  formatTeamInviteLink,
  hashTeamInviteJoinToken,
  normalizeServerUrl,
  parseTeamInviteLink,
  sealTeamInviteBox,
  unwrapTeamDek,
  wrapTeamDek,
  type TeamInvite,
  type TeamInviteCreated,
  type TeamInviteInfo,
  type TeamListItem,
  type TeamMember,
} from "@shared";
import { t } from "./i18n";
import { getDesktopStateStorage } from "./state-storage";
import { TeamApi, type TeamRequestLease } from "./team-api";
import { captureTeamContext, type TeamSyncAuth, type TeamSyncService } from "./team-sync-service";

/*
 * 팀 관리 — 만들기·이름·삭제·소유권·멤버·나가기·초대 링크·참여. 화면(작업 4)은 IPC(ipc/teams.ts)로
 * 이것을 부른다.
 *
 * 서버가 바꾼 것은 팀 동기화(team-sync-service.ts)가 다시 읽어 이 기기에 맞춘다. 내 목록에서 바로
 * 보여야 하는 것(만든 팀·나간 팀·이름·역할)은 서버에 반영되면 로컬 목록도 곧장 고친다 — 그 뒤 목록
 * 다시 읽기가 실패해도 화면이 어긋나지 않게.
 */

export const DEFAULT_TEAM_INVITE_DAYS = 7;
export const MAX_TEAM_INVITE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type DesktopStateStorage = ReturnType<typeof getDesktopStateStorage>;

interface ManagementLease extends TeamRequestLease {
  personalDek: Uint8Array;
}

export interface TeamServiceOptions {
  auth: TeamSyncAuth;
  teamSync: Pick<
    TeamSyncService,
    "refreshTeams" | "joinWithLink" | "listStatuses" | "notifyChanged" | "forgetTeamLocally"
  >;
  api?: TeamApi;
  storage?: DesktopStateStorage;
}

export class TeamService {
  private readonly auth: TeamSyncAuth;
  private readonly teamSync: TeamServiceOptions["teamSync"];
  private readonly api: TeamApi;
  private readonly storage: DesktopStateStorage;

  constructor(options: TeamServiceOptions) {
    this.auth = options.auth;
    this.teamSync = options.teamSync;
    this.api = options.api ?? new TeamApi(options.auth);
    this.storage = options.storage ?? getDesktopStateStorage();
  }

  list(): TeamListItem[] {
    const statuses = this.teamSync.listStatuses();
    return this.storage
      .listTeamIds()
      .map((teamId): TeamListItem | null => {
        const info = this.storage.getTeamState(teamId)?.info;
        if (!info) {
          return null;
        }
        const status = statuses[teamId];
        return {
          id: teamId,
          name: info.name,
          role: info.role,
          syncState: status?.state ?? "idle",
          syncError: status?.errorMessage ?? null,
        };
      })
      .filter((team): team is TeamListItem => team !== null)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async refresh(): Promise<TeamListItem[]> {
    await this.teamSync.refreshTeams();
    return this.list();
  }

  /** 팀을 만든다. 팀 ID 와 팀 키를 이 기기에서 만들고, 내 사본만 서버에 올린다. */
  async create(name: string): Promise<TeamListItem> {
    const lease = this.requireLease();
    const teamName = requireName(name);
    // 소문자 표준 UUID — 서버는 이 모양만 받고, 사본의 AAD 에 이 문자열을 그대로 묶는다.
    const teamId = randomUUID();
    const wrappedTeamDek = wrapTeamDek(createTeamDek(), lease.personalDek, teamId);
    const created = await this.api.createTeam(lease, { id: teamId, name: teamName, wrappedTeamDek });
    this.storage.upsertTeamInfo(teamId, {
      name: created.name,
      role: "owner",
      wrappedTeamDek,
      dataFloor: created.dataFloor,
      updatedAt: new Date().toISOString(),
    });
    this.teamSync.notifyChanged();
    // 팀 키를 풀어 동기화를 시작한다. 실패해도 팀은 만들어졌다 — 다음 목록 읽기가 이어 간다.
    await this.teamSync.refreshTeams().catch(() => undefined);
    return this.require(teamId);
  }

  async rename(teamId: string, name: string): Promise<void> {
    const lease = this.requireLease();
    const teamName = requireName(name);
    await this.api.renameTeam(lease, teamId, teamName);
    this.patchInfo(teamId, { name: teamName });
  }

  async remove(teamId: string): Promise<void> {
    await this.api.deleteTeam(this.requireLease(), teamId);
    await this.teamSync.forgetTeamLocally(teamId);
  }

  async transferOwnership(teamId: string, userId: string): Promise<void> {
    await this.api.transferOwnership(this.requireLease(), teamId, userId);
    this.patchInfo(teamId, { role: "member" });
  }

  async listMembers(teamId: string): Promise<TeamMember[]> {
    return this.api.listMembers(this.requireLease(), teamId);
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.api.removeMember(this.requireLease(), teamId, userId);
  }

  async leave(teamId: string): Promise<void> {
    await this.api.leaveTeam(this.requireLease(), teamId);
    await this.teamSync.forgetTeamLocally(teamId);
  }

  /**
   * 초대 링크를 만든다. 비밀값 S 로 팀 키를 상자에 봉해 올리고, 서버에는 참여 토큰의 해시만 둔다. S 는
   * 링크의 # 뒤에만 있다 — 서버에도 이 기기에도 남지 않는다.
   */
  async createInvite(teamId: string, options?: { expiresInDays?: number }): Promise<TeamInviteCreated> {
    const lease = this.requireLease();
    const days = options?.expiresInDays ?? DEFAULT_TEAM_INVITE_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_TEAM_INVITE_DAYS) {
      throw new Error(t("teams.inviteDaysRange", { max: MAX_TEAM_INVITE_DAYS }));
    }
    const wrapped = this.storage.getTeamState(teamId)?.info.wrappedTeamDek;
    if (!wrapped) {
      throw new Error(t("teams.needsRejoin"));
    }
    const teamDek = unwrapTeamDek(wrapped, lease.personalDek, teamId);
    const secret = createTeamInviteSecret();
    const expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();
    const invite = await this.api.createInvite(lease, teamId, {
      inviteBox: sealTeamInviteBox({ secret, teamId, teamDek, expiresAt }),
      joinTokenHash: hashTeamInviteJoinToken(deriveTeamInviteJoinToken(secret)),
      expiresAt,
    });
    return { invite, link: formatTeamInviteLink(lease.serverUrl, invite.code, secret) };
  }

  async listInvites(teamId: string): Promise<TeamInvite[]> {
    return this.api.listInvites(this.requireLease(), teamId);
  }

  async revokeInvite(teamId: string, code: string): Promise<void> {
    await this.api.revokeInvite(this.requireLease(), teamId, code);
  }

  /** 참여 카드에 보일 것. 상자는 받지 않는다 — 상자는 참여할 때만 온다. */
  async getInviteInfo(link: string): Promise<TeamInviteInfo> {
    const lease = this.requireLease();
    const parsed = parseTeamInviteLink(link);
    if (normalizeServerUrl(parsed.serverUrl) !== normalizeServerUrl(lease.serverUrl)) {
      throw new Error(t("teams.inviteOtherServer"));
    }
    const info = await this.api.getInviteInfo(lease, parsed.code, deriveTeamInviteJoinToken(parsed.secret));
    return { ...info, alreadyJoined: Boolean(this.storage.getTeamState(info.teamId)?.info.wrappedTeamDek) };
  }

  async join(link: string): Promise<TeamListItem> {
    return this.require(await this.teamSync.joinWithLink(link));
  }

  private requireLease(): ManagementLease {
    const context = captureTeamContext(this.auth);
    if (!context) {
      throw new Error(t("teams.needsUnlockedVault"));
    }
    return {
      serverUrl: context.serverUrl,
      accessToken: context.accessToken,
      vaultEpoch: context.vaultEpoch,
      personalDek: Buffer.from(context.vaultKeyBase64, "base64"),
      signal: new AbortController().signal,
      isActive: () => this.auth.isSyncContextCurrent(context),
    };
  }

  private require(teamId: string): TeamListItem {
    const team = this.list().find((candidate) => candidate.id === teamId);
    if (!team) {
      throw new Error(t("teams.notOnDevice"));
    }
    return team;
  }

  private patchInfo(teamId: string, patch: { name?: string; role?: "owner" | "member" }): void {
    const info = this.storage.getTeamState(teamId)?.info;
    if (info && this.storage.upsertTeamInfo(teamId, { ...info, ...patch, updatedAt: new Date().toISOString() })) {
      this.teamSync.notifyChanged();
    }
  }
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error(t("teams.nameRequired"));
  }
  return trimmed;
}
