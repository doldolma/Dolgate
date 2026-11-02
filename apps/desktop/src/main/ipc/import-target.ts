import { randomUUID } from "node:crypto";
import type {
  GroupRecord,
  HostDraft,
  HostRecord,
  HostSecretInput,
  ImportVaultTarget,
  TeamHostCredentials,
} from "@shared";
import type { GroupRepository, HostRepository } from "../database";
import { t } from "../i18n";
import { PERSONAL_VAULT_ID } from "../vault-root";
import type { MainIpcContext } from "./context";

/**
 * 가져온 비밀번호·SSH 키를 둔 자리. 팀에 함께 공유하지 않으면 팀에는 두지 않고 값을 들고 있다가, 그 값을 쓰는 호스트마다
 * 내 자격 증명에 넣는다(mine).
 */
export interface ImportedSecret {
  secretRef: string | null;
  mine?: HostSecretInput;
}

/**
 * 가져오기(Termius·OpenSSH·Xshell)를 쓰는 볼트 — 그룹·비밀값·호스트를 그 볼트에 만든다. 가져오기는 어느 볼트든 같은 순서로
 * 이것만 부른다.
 */
export interface ImportTarget {
  readonly vaultId: string;
  listGroupPaths(): string[];
  createGroup(name: string, parentPath: string | null): GroupRecord;
  persistSecret(label: string, secrets: HostSecretInput): Promise<ImportedSecret | null>;
  createHost(id: string, draft: HostDraft, secret: ImportedSecret | null): HostRecord;
}

/** 개인 볼트 — 지금까지와 같은 저장소 쓰기. */
export function createPersonalImportTarget(deps: {
  groups: Pick<GroupRepository, "list" | "create">;
  hosts: Pick<HostRepository, "create">;
  persistSecret: (label: string, secrets: HostSecretInput) => Promise<string | null>;
}): ImportTarget {
  return {
    vaultId: PERSONAL_VAULT_ID,
    listGroupPaths: () => deps.groups.list().map((group) => group.path),
    createGroup: (name, parentPath) => deps.groups.create(randomUUID(), name, parentPath),
    persistSecret: async (label, secrets) => {
      const secretRef = await deps.persistSecret(label, secrets);
      return secretRef ? { secretRef } : null;
    },
    createHost: (id, draft, secret) => deps.hosts.create(id, draft, secret?.secretRef ?? null),
  };
}

/**
 * 가져오기 요청이 고른 볼트. 팀이면 그 팀 볼트에 바로 쓴다 — 개인에는 아무것도 안 남는다(전에는 개인에 쓴 뒤 끌어다 놓아야
 * 했고, 그 복사는 개인에 사본을 남겼다). 이 기기에 없는 팀이나 읽기 전용 팀이면 쓰기 전에 거절한다.
 */
export function resolveImportTarget(
  ctx: Pick<
    MainIpcContext,
    "groups" | "hosts" | "persistImportedSecret" | "persistSecret" | "hasSecretValue" | "vaults"
  >,
  request: ImportVaultTarget,
): ImportTarget {
  const vaultId = request.vaultId?.trim();
  if (!vaultId || vaultId === PERSONAL_VAULT_ID) {
    return createPersonalImportTarget({
      groups: ctx.groups,
      hosts: ctx.hosts,
      persistSecret: ctx.persistImportedSecret,
    });
  }
  const scope = ctx.vaults.getScope(vaultId);
  if (!scope) {
    throw new Error(t("teams.notOnDevice"));
  }
  if (!ctx.vaults.canEditVault(vaultId)) {
    throw new Error(t("teams.readOnly"));
  }
  const share = request.shareSecrets !== false;
  return {
    vaultId,
    listGroupPaths: () => scope.groups.list().map((group) => group.path),
    createGroup: (name, parentPath) => scope.groups.create(randomUUID(), name, parentPath),
    persistSecret: async (label, secrets) => {
      if (!ctx.hasSecretValue(secrets)) {
        return null;
      }
      if (!share) {
        return { secretRef: null, mine: secrets };
      }
      const secretRef = await ctx.persistSecret(label, secrets, scope);
      return secretRef ? { secretRef } : null;
    },
    createHost: (id, draft, secret) => {
      const record = ctx.vaults.createHost(vaultId, id, draft, secret?.secretRef ?? null);
      if (secret?.mine) {
        ctx.vaults.setMyHostCredentials(id, toMyCredentials(secret.mine));
      }
      return record;
    },
  };
}

/** 내 자격 증명 칸으로 — 비밀번호·키만 옮긴다. 사용자 이름은 팀 레코드에 있다. */
function toMyCredentials(secrets: HostSecretInput): TeamHostCredentials {
  const credentials: TeamHostCredentials = {};
  for (const field of ["password", "passphrase", "privateKeyPem", "certificateText"] as const) {
    const value = secrets[field];
    if (value) {
      credentials[field] = value;
    }
  }
  return credentials;
}
