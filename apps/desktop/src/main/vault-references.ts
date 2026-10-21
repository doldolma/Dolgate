import type { HostDraft, HostRecord } from "@shared";
import type { VaultCatalog, VaultScope } from "./vault-catalog";

/** 호스트가 가리키는 다른 레코드의 종류. */
export type VaultReferenceKind = "jumpHost" | "tunnelHost" | "tailnet" | "awsProfile" | "snippet" | "secret";

export interface VaultReference {
  kind: VaultReferenceKind;
  id: string;
}

/** 호스트(초안 또는 레코드)가 가리키는 다른 레코드들. 종류마다 칸 이름이 달라 한 곳에서 모은다. */
export function listHostReferences(host: HostDraft | HostRecord): VaultReference[] {
  const references: VaultReference[] = [];
  const add = (kind: VaultReferenceKind, id: unknown) => {
    const value = typeof id === "string" ? id.trim() : "";
    if (value) {
      references.push({ kind, id: value });
    }
  };
  if ("jumpHostIds" in host) {
    for (const id of host.jumpHostIds ?? []) {
      add("jumpHost", id);
    }
  }
  if ("jumpHostId" in host) {
    add("jumpHost", host.jumpHostId);
  }
  if ("sshTunnelHostId" in host) {
    add("tunnelHost", host.sshTunnelHostId);
  }
  if ("tailnetId" in host) {
    add("tailnet", host.tailnetId);
  }
  if ("awsProfileId" in host) {
    add("awsProfile", host.awsProfileId);
  }
  if ("startupCommand" in host && host.startupCommand?.type === "snippet") {
    add("snippet", host.startupCommand.snippetId);
  }
  if ("secretRef" in host) {
    add("secret", host.secretRef);
  }
  return references;
}

type RecordReference = VaultReference & { kind: Exclude<VaultReferenceKind, "jumpHost" | "tunnelHost"> };

function isHostReference(reference: VaultReference): boolean {
  return reference.kind === "jumpHost" || reference.kind === "tunnelHost";
}

function holds(scope: VaultScope, reference: RecordReference): boolean {
  switch (reference.kind) {
    case "tailnet":
      return scope.tailnets.list().some((record) => record.id === reference.id);
    case "awsProfile":
      return Boolean(scope.awsProfiles.getMetadataById(reference.id));
    case "snippet":
      return Boolean(scope.snippets.getById(reference.id));
    case "secret":
      return Boolean(scope.secretMetadata.getBySecretRef(reference.id));
  }
}

/**
 * 호스트를 그 볼트에 저장할 때 **다른 볼트를 가리키는** 첫 참조. 없으면 null.
 *
 * 볼트는 완전히 나뉜다 — 팀 호스트가 개인 점프 호스트·tailnet·스니펫을 가리키면 팀원에게는 없는 것을 가리키고,
 * 개인 호스트가 팀 자격 증명을 가리키면 팀에서 빠진 뒤 깨진다. 화면이 같은 볼트 것만 보여 주지만 메인에서도 지킨다.
 *
 * 다른 볼트에 **실제로 있는** 것만 문제 삼는다. 그 볼트에 있거나, 어디에도 없거나(지워짐 — 화면이 "이 기기에 없음"
 * 으로 보인다), 고치기 전과 같은 참조는 그대로 둔다 — 옛 레코드의 다른 칸을 고칠 때 저장을 막지 않게.
 * 팀이 없으면 넘을 볼트가 없다.
 */
export function findCrossVaultReference(
  vaults: Pick<VaultCatalog, "listScopes" | "getHost" | "scopeOfHost">,
  scope: VaultScope,
  host: HostDraft,
  current: HostRecord | null = null,
): VaultReference | null {
  const scopes = vaults.listScopes();
  if (scopes.length < 2) {
    return null;
  }
  const unchanged = new Set(
    (current ? listHostReferences(current) : []).map((reference) => `${reference.kind}:${reference.id}`),
  );
  for (const reference of listHostReferences(host)) {
    if (unchanged.has(`${reference.kind}:${reference.id}`)) {
      continue;
    }
    if (isHostReference(reference)) {
      // 호스트는 볼트 카탈로그로 찾는다 — 어느 볼트에 든 것인지도 카탈로그가 안다.
      if (vaults.getHost(reference.id) && vaults.scopeOfHost(reference.id).id !== scope.id) {
        return reference;
      }
      continue;
    }
    const record = reference as RecordReference;
    if (holds(scope, record)) {
      continue;
    }
    if (scopes.some((other) => other.id !== scope.id && holds(other, record))) {
      return reference;
    }
  }
  return null;
}
