/**
 * 팀 볼트의 역할. 서버가 역할마다 막고(services/sync-api 의 team_store.go), 앱은 그것을 따라 길을 닫는다 —
 * 앱의 판단은 화면을 위한 것이고, 막는 것은 서버다.
 * - owner: 한 명. 이름 바꾸기·소유권 넘기기·팀 삭제와, 관리자를 빼거나 바꾸기
 * - admin: 초대 링크·멤버 빼기·역할 바꾸기(멤버 ↔ 읽기 전용)·되살리기, 모두의 녹화 보기
 * - member: 팀 볼트를 고치고 지우고 공유해 넣는다
 * - viewer: 보고 접속만 한다. 접속하려면 비밀값을 풀어야 하므로 볼 수는 있다
 */
export type TeamRole = "owner" | "admin" | "member" | "viewer";

/** 초대 링크로 줄 수 있는 역할. 관리자는 들어온 뒤 소유자가 올린다. */
export type TeamInviteRole = "member" | "viewer";

/** 역할 바꾸기로 줄 수 있는 역할. 소유자는 소유권 넘기기로만 바뀐다. */
export type TeamAssignableRole = "admin" | "member" | "viewer";

const TEAM_ROLE_RANK: Readonly<Record<TeamRole, number>> = { owner: 4, admin: 3, member: 2, viewer: 1 };

/**
 * 서버나 상태 파일의 역할 값을 읽는다. 모르는 값(더 새 서버가 만든 역할 등)은 가장 좁은 읽기 전용으로 본다 —
 * 넓게 읽으면 화면이 서버가 거절할 편집 길을 열어 둔다.
 */
export function normalizeTeamRole(value: unknown): TeamRole {
  return typeof value === "string" && value in TEAM_ROLE_RANK ? (value as TeamRole) : "viewer";
}

/** 링크의 역할. 읽기 전용이 아니면 멤버다(서버와 같은 규칙 — 링크로는 관리자를 주지 않는다). */
export function normalizeTeamInviteRole(value: unknown): TeamInviteRole {
  return value === "viewer" ? "viewer" : "member";
}

export function teamRoleAtLeast(role: TeamRole, minimum: TeamRole): boolean {
  return TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK[minimum];
}

/** 팀 볼트를 고칠 수 있는지 — 멤버 이상. */
export function canEditTeamVault(role: TeamRole): boolean {
  return teamRoleAtLeast(role, "member");
}

/** 초대 링크·멤버 빼기·역할 바꾸기·되살리기를 하는지 — 관리자 이상. */
export function canManageTeam(role: TeamRole): boolean {
  return teamRoleAtLeast(role, "admin");
}

/**
 * actor 가 target 을 뺄 수 있는지. 관리자는 멤버·읽기 전용만, 소유자는 자기 말고 누구나 뺀다(서버와 같은 규칙).
 */
export function canRemoveTeamMember(actor: TeamRole, target: TeamRole): boolean {
  if (actor === "owner") {
    return target !== "owner";
  }
  return actor === "admin" && !teamRoleAtLeast(target, "admin");
}

/**
 * actor 가 target 의 역할을 to 로 바꿀 수 있는지. 소유자의 역할은 넘기기로만 바뀌고, 관리자는 멤버 ↔ 읽기
 * 전용만 바꾼다(서버와 같은 규칙).
 */
export function canChangeTeamRole(actor: TeamRole, target: TeamRole, to: TeamAssignableRole): boolean {
  if (target === "owner") {
    return false;
  }
  if (actor === "owner") {
    return true;
  }
  return actor === "admin" && target !== "admin" && to !== "admin";
}
