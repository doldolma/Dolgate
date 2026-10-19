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
  secure(state: DesktopStateFile): DesktopVaultSecure;
}

export const PERSONAL_VAULT_ROOT: VaultRoot = {
  vaultId: PERSONAL_VAULT_ID,
  teamId: null,
  data: (state) => state.data,
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
    secure: (state) => team(state).secure,
  };
}
