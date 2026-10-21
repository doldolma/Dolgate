import { createVaultCatalog, pickVaultRepositories, type VaultCatalog } from "./vault-catalog";

type PersonalRepositories = Parameters<typeof pickVaultRepositories>[0];
type PersonalSecrets = Parameters<typeof pickVaultRepositories>[1];

/**
 * 시험용: 목으로 만든 컨텍스트(또는 의존성 묶음)에 진짜 VaultCatalog 를 붙인다.
 *
 * 그 객체가 가진 저장소 목(hosts·knownHosts·savedWorkspaces 등)과 secretStore 를 그대로 개인 볼트로
 * 쓴다 — 시험은 지금처럼 그 목만 세우면 된다. 같은 객체에 붙여 돌려주므로 시험이 들고 있는 참조도
 * 그대로다.
 *
 * teams 를 주면 그 팀 볼트들이 이 기기에 있는 것처럼 붙는다(팀 id → 그 팀이 쓰는 저장소 목). 주지 않으면
 * 팀은 없다.
 */
export function withVaults<T extends object>(
  target: T,
  teams: Record<string, object> = {},
): T & { vaults: VaultCatalog } {
  const dependencies = target as PersonalRepositories & { secretStore?: PersonalSecrets };
  return Object.assign(target, {
    vaults: createVaultCatalog(
      pickVaultRepositories(dependencies, dependencies.secretStore as PersonalSecrets),
      {
        listTeamIds: () => Object.keys(teams),
        createScope: (teamId: string) => teams[teamId] as never,
      },
    ),
  });
}
