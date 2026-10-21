// 볼트별 목록 묶기(포트 포워딩·DNS 덮어쓰기·스니펫). 레코드 모양은 그대로 두고, 볼트 표(VaultIndex)의 팀 id 표로
// 어느 볼트 것인지 안다 — 표에 없으면 개인 것이다.

import type { VaultIndex } from '@shared';
import { PERSONAL_VAULT_ID } from '../store/utils/vaults';

/** 묶음 머리에 보일 팀. 개인 묶음은 null. */
export interface VaultSectionTeam {
  id: string;
  name: string;
}

/** 볼트 하나의 묶음. */
export interface VaultSection<T> {
  /** 개인은 PERSONAL_VAULT_ID, 팀은 팀 id. */
  vaultId: string;
  team: VaultSectionTeam | null;
  /** 동기화가 막힌 팀(다시 들어와야 함·업데이트 필요) — 여기에는 만들지 않는다. */
  blocked: boolean;
  items: T[];
}

export function vaultIdOf(teamIdById: Readonly<Record<string, string>> | undefined, id: string): string {
  return teamIdById?.[id] ?? PERSONAL_VAULT_ID;
}

/** 그 볼트의 팀(이름 찾기). 개인이거나 표에 없으면 null. */
export function teamOfVault(index: VaultIndex | null | undefined, vaultId: string): VaultSectionTeam | null {
  const team = vaultId === PERSONAL_VAULT_ID ? undefined : index?.teams.find((entry) => entry.id === vaultId);
  return team ? { id: team.id, name: team.name } : null;
}

/** 팀이 하나라도 있으면 목록을 볼트별로 묶는다. */
export function hasTeamVaults(index: VaultIndex | null | undefined): index is VaultIndex {
  return Boolean(index?.teams?.length);
}

/** 동기화가 막힌 팀(다시 들어와야 함·업데이트 필요) — 그 묶음에는 만들지 않는다. */
function isBlockedTeam(team: VaultIndex['teams'][number]): boolean {
  return team.syncState === 'needs-rejoin' || team.syncState === 'outdated';
}

/**
 * 레코드를 볼트별로 묶는다 — 개인 먼저, 그다음 볼트 표의 팀 순서. 빈 볼트도 묶음으로 둔다(머리의 + 로 거기에
 * 만든다). 볼트 안의 순서는 받은 순서 그대로다. **팀이 없으면 null** — 화면은 묶음 없이 지금처럼 그린다.
 */
export function groupByVault<T extends { id: string }>(
  items: readonly T[],
  teamIdById: Readonly<Record<string, string>> | undefined,
  index: VaultIndex | null | undefined,
): VaultSection<T>[] | null {
  if (!hasTeamVaults(index)) {
    return null;
  }
  const sections: VaultSection<T>[] = [
    { vaultId: PERSONAL_VAULT_ID, team: null, blocked: false, items: [] },
    ...index.teams.map((team) => ({
      vaultId: team.id,
      team: { id: team.id, name: team.name },
      blocked: isBlockedTeam(team),
      items: [] as T[],
    })),
  ];
  const byVault = new Map(sections.map((section) => [section.vaultId, section]));
  for (const item of items) {
    // 표는 팀 목록과 한 번에 오므로 묶음 없는 팀 id 는 드물다. 그때도 빼먹지 않게 개인 묶음에 둔다(표에 없는 것과 같다).
    (byVault.get(vaultIdOf(teamIdById, item.id)) ?? sections[0]).items.push(item);
  }
  return sections;
}

/**
 * 볼트마다 따로 읽은 목록을 묶음으로 — 설정의 AWS Profiles·Tailscale·Saved Credentials·known hosts 는 목록 IPC 가 볼트
 * 하나씩 준다. 개인 먼저, 그다음 볼트 표의 팀 순서. 아직 못 읽은 팀은 빈 묶음이다. **팀이 없으면 null**.
 */
export function sectionsByVault<T>(
  personal: readonly T[],
  byTeamId: Readonly<Record<string, readonly T[]>>,
  index: VaultIndex | null | undefined,
): VaultSection<T>[] | null {
  if (!hasTeamVaults(index)) {
    return null;
  }
  return [
    { vaultId: PERSONAL_VAULT_ID, team: null, blocked: false, items: [...personal] },
    ...index.teams.map((team) => ({
      vaultId: team.id,
      team: { id: team.id, name: team.name },
      blocked: isBlockedTeam(team),
      items: [...(byTeamId[team.id] ?? [])],
    })),
  ];
}

/**
 * 이 볼트 것을 먼저, 그다음 개인, 그다음 다른 팀 — 볼트 안의 순서는 그대로. 팀 호스트 세션의 스니펫 고르기·
 * 자동완성이 쓴다(같은 키워드면 앞의 것이 이긴다). 팀이 없거나 개인 세션이면 받은 목록을 그대로 돌려준다.
 */
export function orderByVault<T extends { id: string }>(
  items: readonly T[],
  teamIdById: Readonly<Record<string, string>> | undefined,
  firstVaultId: string,
): readonly T[] {
  if (firstVaultId === PERSONAL_VAULT_ID || !teamIdById || Object.keys(teamIdById).length === 0) {
    return items;
  }
  const rank = (item: T) => {
    const vaultId = vaultIdOf(teamIdById, item.id);
    return vaultId === firstVaultId ? 0 : vaultId === PERSONAL_VAULT_ID ? 1 : 2;
  };
  return items
    .map((item, position) => ({ item, position, rank: rank(item) }))
    .sort((left, right) => left.rank - right.rank || left.position - right.position)
    .map((entry) => entry.item);
}
