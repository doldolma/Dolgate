import type { VaultCopyCounts, VaultCopyRequest, VaultCopyResult } from "@shared";
import { encodeSecretForStorage } from "./secret-store";
import { getDesktopStateStorage, type VaultCopyWrite } from "./state-storage";
import type { VaultCatalog } from "./vault-catalog";
import { planVaultCopy, type VaultCopyPlan } from "./vault-copy";
import { PERSONAL_VAULT_ID } from "./vault-root";

export interface VaultCopyServiceDeps {
  vaults: Pick<VaultCatalog, "getScope">;
  /** 쓴 뒤에 부른다 — 기록을 남기고 개인·팀 동기화를 건다. */
  onCopied: (copied: { request: VaultCopyRequest; counts: VaultCopyCounts }) => void;
}

/**
 * 볼트 사이 복사(개인 ↔ 팀). 계획은 vault-copy.ts 가 세우고, 쓰기는 상태 저장소가 한 번에 한다 — 비밀값을
 * 잠그다 실패하면 아무것도 쓰지 않는다.
 */
export class VaultCopyService {
  constructor(private readonly deps: VaultCopyServiceDeps) {}

  /** 무엇이 몇 개 오는지. 쓰지 않는다. */
  preview(request: VaultCopyRequest): VaultCopyCounts {
    return this.plan(request).counts;
  }

  copy(request: VaultCopyRequest): VaultCopyResult {
    const plan = this.plan(request);
    const write = toVaultCopyWrite(plan, new Date().toISOString());
    getDesktopStateStorage().applyVaultCopy(request.targetVaultId, write);
    this.deps.onCopied({ request, counts: plan.counts });
    return { hostIds: plan.hostIdMap, workspaceIds: plan.workspaceIdMap, counts: plan.counts };
  }

  private plan(request: VaultCopyRequest): VaultCopyPlan {
    if (request.sourceVaultId === request.targetVaultId) {
      throw new Error("vault copy needs two different vaults");
    }
    const storage = getDesktopStateStorage();
    const source = storage.readVaultContents(request.sourceVaultId);
    const target = storage.readVaultContents(request.targetVaultId);
    // 팀 것을 가져올 때는 그 팀의 내 개인 칸(즐겨찾기·agent forwarding·테마·내 자격 증명)이 따라간다.
    const sourceMemberPrefs =
      request.sourceVaultId === PERSONAL_VAULT_ID
        ? null
        : (this.deps.vaults.getScope(request.sourceVaultId)?.memberPrefs ?? null);
    return planVaultCopy(source, target, request.selection, {
      targetGroupPath: request.targetGroupPath ?? null,
      targetIsTeam: request.targetVaultId !== PERSONAL_VAULT_ID,
      shareSecrets: request.shareSecrets !== false,
      sourceMemberPrefs: sourceMemberPrefs?.read() ?? null,
      sourceMyCredentials: sourceMemberPrefs,
    });
  }
}

/** 계획을 저장할 모양으로 — 비밀값·AWS 프로필·tailnet auth key·복사한 사람의 내 자격 증명은 여기서 잠근다. */
export function toVaultCopyWrite(plan: VaultCopyPlan, now: string): VaultCopyWrite {
  return {
    groups: plan.groups,
    hosts: plan.hosts,
    knownHosts: plan.knownHosts,
    portForwards: plan.portForwards,
    dnsOverrides: plan.dnsOverrides,
    secretMetadata: plan.secretMetadata,
    awsProfiles: plan.awsProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      updatedAt: profile.updatedAt,
    })),
    snippets: plan.snippets,
    savedWorkspaces: plan.savedWorkspaces,
    tailnets: plan.tailnets.map(({ authKey, ...tailnet }) => ({ ...tailnet, hasAuthKey: Boolean(authKey) })),
    secrets: Object.fromEntries(
      plan.secrets.map((secret) => [secret.secretRef, encodeSecretForStorage(JSON.stringify(secret))]),
    ),
    awsProfilePayloads: Object.fromEntries(
      plan.awsProfiles.map((profile) => [profile.id, encodeSecretForStorage(JSON.stringify(profile))]),
    ),
    tailnetAuthKeys: Object.fromEntries(
      plan.tailnets.flatMap((tailnet) =>
        tailnet.authKey ? [[tailnet.id, encodeSecretForStorage(tailnet.authKey)]] : [],
      ),
    ),
    memberSecrets: {
      hostCredentials: plan.memberCredentials.hostCredentials.map(lockMemberCredentials),
      awsProfileCredentials: plan.memberCredentials.awsProfileCredentials.map(lockMemberCredentials),
      tailnetCredentials: plan.memberCredentials.tailnetCredentials.map(lockMemberCredentials),
    },
    memberHostPrefs: plan.memberValues
      .filter((values) => values.favorite || values.agentForwarding)
      .map((values) => ({
        id: values.hostId,
        favorite: values.favorite,
        agentForwarding: values.agentForwarding,
        updatedAt: now,
      })),
    terminalThemeByHostId: Object.fromEntries(
      plan.memberValues.flatMap((values) => (values.terminalThemeId ? [[values.hostId, values.terminalThemeId]] : [])),
    ),
  };
}

function lockMemberCredentials({ id, credentials }: { id: string; credentials: object }) {
  return { id, value: encodeSecretForStorage(JSON.stringify(credentials)) };
}
