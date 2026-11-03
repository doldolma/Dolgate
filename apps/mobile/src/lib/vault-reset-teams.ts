import { t } from '../i18n';

/** 동기화 암호를 초기화하거나 탈퇴하면 빠질 팀 하나. 혼자인지는 서버 목록에서만 안다 — 못 읽었으면 null. */
export interface VaultResetTeam {
  name: string;
  soleMember: boolean | null;
}

export function compareVaultResetTeams(
  left: VaultResetTeam,
  right: VaultResetTeam,
): number {
  return left.name.localeCompare(right.name);
}

/**
 * 초기화·탈퇴 확인 창에 붙일 팀 안내(데스크톱과 같은 안내). 서버는 초기화·탈퇴할 때 그 사람을 모든 팀에서 빼고, 혼자인 팀은
 * 서버에서도 지운다. 첫 문장만 창마다 다르다(탈퇴는 계정이 없어지니 다시 들어오기를 말하지 않는다). 팀이 없으면 null.
 */
export function describeTeamsLeftOnVaultReset(
  teams: readonly VaultResetTeam[],
  kind: 'vaultReset' | 'accountDelete' = 'vaultReset',
): string | null {
  if (teams.length === 0) {
    return null;
  }
  const leave = t(kind === 'accountDelete' ? 'settings.deleteAccount.teamsLeave' : 'vaultGate.resetTeamsLeave', {
    names: teams.map(team => team.name).join(', '),
  });
  const soleNames = teams
    .filter(team => team.soleMember === true)
    .map(team => team.name);
  if (soleNames.length > 0) {
    return `${leave} ${t('vaultGate.resetTeamsSoleDeleted', { names: soleNames.join(', ') })}`;
  }
  if (teams.some(team => team.soleMember === null)) {
    return `${leave} ${t('vaultGate.resetTeamsSoleMaybe')}`;
  }
  return leave;
}
