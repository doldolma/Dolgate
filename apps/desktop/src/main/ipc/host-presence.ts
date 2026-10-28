import { HostGoneError } from "../host-gone-error";
import { t } from "../i18n";
import { PERSONAL_VAULT_ID } from "../vault-catalog";
import type { MainIpcContext } from "./context";

/**
 * 기다린 뒤 다이얼하기 전에 그 호스트가 아직 볼트에 있는지 본다.
 *
 * AWS 를 부르는 동안(SSO 로그인·EIC 키 올리기·SSM 터널) 팀에서 빠지면, 메인의 닫기(`closeHostConnections`)는 아직
 * 적히지 않은 이 연결을 모른다 — 그대로 두면 기다림이 끝난 뒤 빠진 팀 호스트에 붙는다. 그래서 기다림마다 뒤에서 돌려준
 * 함수를 부른다. 팀 호스트였으면 '팀에서 빠져…'(닫을 때와 같은 문구)로, 개인 호스트를 지웠으면 'Host not found' 로 멈춘다
 * (IPC 가 처음 호스트를 찾을 때와 같은 문구).
 */
export function hostPresenceGuard(
  ctx: Pick<MainIpcContext, "vaults">,
  hostId: string,
): () => void {
  const teamHost = ctx.vaults.scopeOfHost(hostId).id !== PERSONAL_VAULT_ID;
  return () => {
    if (!ctx.vaults.getHost(hostId)) {
      throw new HostGoneError(teamHost ? t("teams.connectionsClosed.notice") : "Host not found");
    }
  };
}
