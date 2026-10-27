import { canEditTeamVault } from '@shared';
import { t } from './i18n';
import type { DesktopStateFile, DesktopVaultData, DesktopVaultSecure } from './state-storage';

export const PERSONAL_VAULT_ID = 'personal';

/** 이 기기에 없는 팀 볼트를 만지려 했다(팀에서 빠져 로컬 사본이 지워진 뒤 등). */
export class TeamVaultNotFoundError extends Error {
  constructor(readonly teamId: string) {
    super(t('teams.notOnDevice'));
    this.name = 'TeamVaultNotFoundError';
  }
}

/**
 * 읽기 전용 팀 볼트를 고치려 했다. 서버도 거절한다(team_read_only) — 화면이 길을 닫지 못한 곳의 마지막 관문이다.
 */
export class TeamVaultReadOnlyError extends Error {
  constructor(readonly teamId: string) {
    super(t('teams.readOnly'));
    this.name = 'TeamVaultReadOnlyError';
  }
}

/** 그 팀 볼트를 이 사람이 고칠 수 있는지(멤버 이상). 이 기기에 없는 팀이면 TeamVaultNotFoundError. */
export function assertTeamVaultEditable(state: DesktopStateFile, teamId: string): void {
  const team = state.teams[teamId];
  if (!team) {
    throw new TeamVaultNotFoundError(teamId);
  }
  if (!canEditTeamVault(team.info.role)) {
    throw new TeamVaultReadOnlyError(teamId);
  }
}

/**
 * 저장소 클래스(HostRepository 등)가 읽고 쓰는 볼트 하나의 자리.
 *
 * 개인 볼트는 `state.data`·`state.secure`, 팀 볼트는 `state.teams[팀 ID].data`·`.secure` 다. 모양이
 * 같아서 저장소 클래스는 뿌리만 바꿔 끼우면 팀 볼트에도 그대로 쓴다.
 */
export interface VaultRoot {
  /** 개인 볼트는 PERSONAL_VAULT_ID, 팀 볼트는 팀 ID. */
  readonly vaultId: string;
  /** 팀 볼트면 팀 ID, 개인 볼트면 null. */
  readonly teamId: string | null;
  data(state: DesktopStateFile): DesktopVaultData;
  /**
   * 쓰기용 data. 읽기 전용 팀이면 TeamVaultReadOnlyError 를 던진다. 저장소 클래스는 레코드를 쓸 때(updateState
   * 안) 반드시 이것을 쓴다 — vault-root-boundary.test.ts 가 지킨다. 이 기기에만 두는 것(동기화 장부, AWS 정적
   * 키·tailnet auth key 같은 secure 의 키)은 읽기 전용이어도 쓴다.
   */
  edit(state: DesktopStateFile): DesktopVaultData;
  secure(state: DesktopStateFile): DesktopVaultSecure;
}

export const PERSONAL_VAULT_ROOT: VaultRoot = {
  vaultId: PERSONAL_VAULT_ID,
  teamId: null,
  data: (state) => state.data,
  edit: (state) => state.data,
  secure: (state) => state.secure,
};

/** 팀 볼트의 뿌리. 그 팀이 이 기기에 없으면 읽기·쓰기 모두 TeamVaultNotFoundError 를 던진다. */
export function teamVaultRoot(teamId: string): VaultRoot {
  const team = (state: DesktopStateFile) => {
    const value = state.teams[teamId];
    if (!value) {
      throw new TeamVaultNotFoundError(teamId);
    }
    return value;
  };
  return {
    vaultId: teamId,
    teamId,
    data: (state) => team(state).data,
    edit: (state) => {
      assertTeamVaultEditable(state, teamId);
      return team(state).data;
    },
    secure: (state) => team(state).secure,
  };
}
