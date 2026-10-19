import { createVaultCatalog, type VaultCatalog } from "./vault-catalog";

/**
 * 시험용: 목으로 만든 컨텍스트(또는 의존성 묶음)에 진짜 VaultCatalog 를 붙인다.
 *
 * 그 객체가 가진 hosts·knownHosts·tailnets 목을 그대로 개인 볼트로 쓴다 — 시험은 지금처럼 그 목만
 * 세우면 된다. 같은 객체에 붙여 돌려주므로 시험이 들고 있는 참조도 그대로다.
 */
export function withVaults<T extends object>(target: T): T & { vaults: VaultCatalog } {
  const { hosts, knownHosts, tailnets } = target as Partial<
    Record<"hosts" | "knownHosts" | "tailnets", unknown>
  >;
  return Object.assign(target, {
    vaults: createVaultCatalog({ hosts, knownHosts, tailnets } as Parameters<
      typeof createVaultCatalog
    >[0]),
  });
}
