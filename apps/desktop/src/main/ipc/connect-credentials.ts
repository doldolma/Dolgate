import { isSshHostRecord, jumpHostIdAtDepth, normalizeJumpHostIds, resolveCredentialRetryKind } from "@shared";
import type { HostSecretInput } from "@shared";
import { jumpDepthOfCoreError } from "../core-manager";
import type { MainIpcContext, PendingHopSecret, SshHostRecord } from "./context";

type CredentialContext = Pick<MainIpcContext, "vaults" | "resolveSshAuth">;

/**
 * 붙기 전에 체인(점프 첫 홉 → … → 대상)을 훑어, 비밀번호 방식인데 쓸 비밀번호가 없는 첫 호스트를 찾는다.
 *
 * 내 자격 증명·팀 것·저장된 것·이번 시도에서 넣은 값(secrets·jumpSecrets)을 모두 본 뒤다. 코어는 대상의
 * 인증을 점프보다 먼저 만들어서, 맡겨 두면 대상부터 묻고 점프 홉의 실패도 대상의 요청 창으로 와 점프 호스트
 * 비밀번호를 넣을 길이 없었다(비밀번호 빼고 공유한 팀 호스트). 여기서는 체인 순서대로 — 베스천 먼저 — 찾는다.
 *
 * 체인이 깨졌으면(지워진 점프 호스트 등) 판정하지 않는다 — 접속이 그 까닭을 문구로 알린다.
 */
export async function findHostNeedingPassword(
  ctx: CredentialContext,
  host: SshHostRecord,
  secrets?: HostSecretInput,
  jumpSecrets?: Record<string, HostSecretInput>,
): Promise<string | null> {
  for (const jumpHostId of normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)) {
    const jumpHost = ctx.vaults.getHostInSameVault(host.id, jumpHostId);
    if (!jumpHost || !isSshHostRecord(jumpHost)) {
      return null;
    }
    if (await lacksPassword(ctx, jumpHost, jumpSecrets?.[jumpHostId])) {
      return jumpHostId;
    }
  }
  return (await lacksPassword(ctx, host, secrets)) ? host.id : null;
}

async function lacksPassword(
  ctx: CredentialContext,
  host: SshHostRecord,
  provided?: HostSecretInput,
): Promise<boolean> {
  const auth = await ctx.resolveSshAuth(host, provided);
  return auth.authType === "password" && !auth.secrets.password;
}

/** 이번 시도에서 넣은 점프 호스트의 값 가운데 붙은 뒤 제자리에 저장할 것. 이 호스트의 체인 밖 id 는 버린다. */
export async function collectHopSecretsToPersist(
  ctx: CredentialContext,
  host: SshHostRecord,
  jumpSecrets?: Record<string, HostSecretInput>,
): Promise<PendingHopSecret[]> {
  if (!jumpSecrets) {
    return [];
  }
  const entries: PendingHopSecret[] = [];
  for (const jumpHostId of normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)) {
    const provided = jumpSecrets[jumpHostId];
    const jumpHost = provided ? ctx.vaults.getHostInSameVault(host.id, jumpHostId) : null;
    if (!provided || !jumpHost || !isSshHostRecord(jumpHost)) {
      continue;
    }
    const auth = await ctx.resolveSshAuth(jumpHost, provided);
    if (auth.shouldPersistHostSecret) {
      entries.push({
        hostId: jumpHost.id,
        label: jumpHost.label,
        secrets: auth.secrets,
        username: auth.typedUsername,
      });
    }
  }
  return entries;
}

/**
 * 코어 오류가 점프 홉의 인증 거절이면 그 점프 호스트. 아니면(대상 자신·네트워크 문제) null.
 *
 * 코어는 어느 홉인지를 깊이로 싣는다(jumpDepthOfCoreError) — 문구를 뜯지 않는다. 판정은 화면의 요청 창과
 * 같은 규칙(resolveCredentialRetryKind)을 그 홉에 적용한다.
 */
export function jumpHostRejectingAuth(
  ctx: Pick<MainIpcContext, "vaults">,
  host: SshHostRecord,
  error: unknown,
): SshHostRecord | null {
  const hopId = jumpHostIdAtDepth(host, jumpDepthOfCoreError(error));
  const hop = hopId ? ctx.vaults.getHostInSameVault(host.id, hopId) : null;
  if (!hop || !isSshHostRecord(hop)) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  return resolveCredentialRetryKind(hop, message) ? hop : null;
}
