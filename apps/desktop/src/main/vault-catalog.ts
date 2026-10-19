import type { HostRecord } from "@shared";
import type { HostRepository, KnownHostRepository, TailnetRepository } from "./database";

export const PERSONAL_VAULT_ID = "personal";

/**
 * 볼트 하나의 저장소 묶음.
 *
 * 저장소들(HostRepository 등)은 개인 볼트(state.data)만 본다. 개인 동기화가 그것을 통째로 올리므로
 * 팀 것을 섞으면 팀 호스트가 개인 볼트로 올라간다. 팀 볼트는 팀마다 따로 담고, 같은 모양의 묶음으로
 * 카탈로그에 더한다.
 */
export interface VaultScope {
  /** 개인 볼트는 PERSONAL_VAULT_ID, 팀 볼트는 팀 ID. */
  readonly id: string;
  readonly hosts: HostRepository;
  readonly knownHosts: KnownHostRepository;
  readonly tailnets: TailnetRepository;
}

/**
 * 메인에서 호스트를 읽는 입구.
 *
 * 호스트를 **읽는** 곳은 모두 이것을 거친다(vault-catalog-boundary.test.ts 가 지킨다). 팀 볼트가
 * 생기면 여기서 모든 볼트를 함께 보게 되고, 부르는 쪽은 그대로다. 개인 볼트만 봐야 하는 곳(개인
 * 동기화, 개인 볼트로 들어가는 가져오기)은 personal 을 명시한다.
 *
 * 쓰기는 아직 저장소로 바로 한다. 어느 볼트에 쓸지는 팀을 얹을 때 scopeOfHost 로 정한다.
 */
export interface VaultCatalog {
  readonly personal: VaultScope;
  /** 모든 볼트에서 id 로 찾는다. id 는 볼트를 넘어 겹치지 않는다(겹치면 개인이 이긴다). */
  getHost(id: string): HostRecord | null;
  /** 모든 볼트의 호스트. */
  listHosts(): HostRecord[];
  /**
   * 그 호스트가 든 볼트.
   *
   * known hosts·tailnet 처럼 id 가 아닌 키로 찾는 것은 이 안에서 찾아야 한다 — 같은 주소가 개인과
   * 팀에 따로 있을 수 있다. 호스트를 못 찾으면(지워진 뒤 등) 개인이다.
   */
  scopeOfHost(hostId: string): VaultScope;
}

export function createVaultCatalog(personal: Omit<VaultScope, "id">): VaultCatalog {
  const personalScope: VaultScope = { id: PERSONAL_VAULT_ID, ...personal };
  return {
    personal: personalScope,
    getHost: (id) => personalScope.hosts.getById(id),
    // 정렬은 저장소가 한다.
    listHosts: () => personalScope.hosts.list(),
    // 아직 볼트가 개인 하나뿐이라 모든 호스트가 개인 볼트에 있다.
    scopeOfHost: () => personalScope,
  };
}
