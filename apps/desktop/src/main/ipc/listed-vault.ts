import { PERSONAL_VAULT_ID, type VaultCatalog, type VaultScope } from "../vault-catalog";

/**
 * 설정 화면이 골라 읽는 볼트(AWS Profiles·Tailscale·Saved Credentials·known hosts).
 *
 * 고르지 않았거나 개인이면 "personal" 이다 — 부르는 쪽은 지금까지의 개인 경로를 그대로 탄다. 이 기기에 없는
 * 팀이면 null 이고 빈 목록을 돌려준다(화면이 막 빠진 팀을 아직 들고 있을 수 있다).
 */
export function resolveListedVault(
  vaults: Pick<VaultCatalog, "getScope">,
  vaultId: string | null | undefined,
): VaultScope | "personal" | null {
  if (!vaultId || vaultId === PERSONAL_VAULT_ID) {
    return "personal";
  }
  return vaults.getScope(vaultId);
}
