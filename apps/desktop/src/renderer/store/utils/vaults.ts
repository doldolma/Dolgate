import { canEditTeamVault, type TeamAvailability, type VaultIndex } from "@shared";

/** 화면이 쓰는 볼트 id — 개인은 이 값, 팀은 팀 ID(볼트 사이 복사 요청과 같은 값). */
export const PERSONAL_VAULT_ID = "personal";

/** 팀 볼트 id 인가(없거나 개인이면 아니다). */
export function isTeamVaultId(vaultId: string | null | undefined): vaultId is string {
  return Boolean(vaultId) && vaultId !== PERSONAL_VAULT_ID;
}

/**
 * 내가 읽기 전용(Viewer)인 팀 볼트인가 — 그 볼트의 것은 만들고 고치고 지우는 길을 닫는다(서버와 메인도 막는다).
 * 개인이거나 표에 없으면 false.
 */
export function isReadOnlyVault(index: VaultIndex | null | undefined, vaultId: string | null | undefined): boolean {
  if (!isTeamVaultId(vaultId)) {
    return false;
  }
  const team = index?.teams.find((entry) => entry.id === vaultId);
  return team ? !canEditTeamVault(team.role) : false;
}

/** 그 호스트가 내가 읽기 전용인 팀의 것인가 — 편집 창을 열지 않는다. */
export function isReadOnlyHost(index: VaultIndex | null | undefined, hostId: string): boolean {
  return isReadOnlyVault(index, index?.teamIdByHostId?.[hostId]);
}

/** 그 호스트·워크스페이스가 든 볼트. 볼트 표에 없으면 개인이다. */
export function vaultIdOfHost(index: VaultIndex, hostId: string): string {
  return index.teamIdByHostId[hostId] ?? PERSONAL_VAULT_ID;
}

/**
 * 팀 호스트에 둔 내 사용자 이름(내 자격 증명). 붙을 때는 이 이름이 먼저라, 묻는 창의 미리 채움도 이것이 먼저다.
 * 없거나 개인 호스트면 null.
 */
export function myUsernameOf(index: VaultIndex | null | undefined, hostId: string): string | null {
  return index?.myUsernameByHostId?.[hostId] ?? null;
}

export function vaultIdOfWorkspace(index: VaultIndex, workspaceId: string): string {
  return index.teamIdByWorkspaceId[workspaceId] ?? PERSONAL_VAULT_ID;
}

/** 팀이 없을 때의 볼트 표 — 모든 레코드가 개인 볼트 것이다. */
export function createEmptyVaultIndex(): VaultIndex {
  return {
    teams: [],
    teamIdByHostId: {},
    teamIdByWorkspaceId: {},
    teamIdByPortForwardId: {},
    teamIdByDnsOverrideId: {},
    teamIdBySnippetId: {},
    myUsernameByHostId: {},
  };
}

/** 메인에 묻기 전·로그아웃 뒤의 값. 팀 메뉴를 그리지 않는다. */
export const TEAMS_SIGNED_OUT: TeamAvailability = { available: false, reason: "signed-out" };
