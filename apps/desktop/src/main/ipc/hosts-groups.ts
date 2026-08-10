import type { GroupRemoveMode, HostDraft, HostSecretInput } from "@shared";
import { isRdpHostDraft, isRdpHostRecord, isSshHostDraft, isSshHostRecord } from "@shared";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";
import { t } from '../i18n';
import { logMessage } from "../activity-log-message";

/**
 * RDP 자격증명으로 저장할 값.
 *
 * 필드를 하나하나 나열해 넘기던 자리였는데, 그러다 계정(`username`/`domain`)과 종류(`kind`)를
 * 빠뜨려서 **저장해도 목록에 안 나오는** 상태가 됐다(kind 가 없으면 RDP 목록 필터에 안 걸린다).
 * 한 곳으로 모아 다시 빠뜨리지 않게 한다.
 */
function rdpSecrets(secrets: HostSecretInput): HostSecretInput {
  return {
    kind: 'rdp',
    username: secrets.username,
    domain: secrets.domain,
    password: secrets.password,
  };
}

function normalizeSshDraftForPersistence(
  draft: HostDraft,
  secretRef: string | null,
): HostDraft {
  if (!isSshHostDraft(draft)) {
    return draft;
  }

  return {
    ...draft,
    privateKeyPath: null,
    certificatePath: null,
    secretRef,
  };
}

export function registerHostsGroupsIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.hosts.list, async () => ctx.hosts.list());

  ipcMain.handle(
    ipcChannels.hosts.create,
    async (event, draft: HostDraft, secrets?: HostSecretInput) => {
      const hostId = randomUUID();
      // RDP 도 비밀번호를 시크릿 저장소에 둔다. SSH 처럼 키/인증서까지 다루지는 않으므로
      // 관리형 키 해석 없이 비밀번호만 넣는다.
      const isRdpDraft = isRdpHostDraft(draft);
      const existingSecretRef =
        isSshHostDraft(draft) || isRdpDraft ? (draft.secretRef ?? null) : null;
      const resolvedSecrets: HostSecretInput = isSshHostDraft(draft)
        ? {
            ...secrets,
            privateKeyPem: await ctx.resolveManagedPrivateKeyPem(draft, secrets, null),
            certificateText: await ctx.resolveManagedCertificateText(draft, secrets, null),
          }
        : {};
      const createdSecretRef = isSshHostDraft(draft)
        ? await ctx.persistSecret(
            ctx.describeHostLabel(draft),
            resolvedSecrets,
          )
        : isRdpDraft && secrets?.password
          ? await ctx.persistSecret(ctx.describeHostLabel(draft), rdpSecrets(secrets))
          : null;
      const secretRef = createdSecretRef ?? existingSecretRef;
      if (secretRef) {
        ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.secretSaved'), {
          hostId,
          secretRef,
        });
      }
      const persistedDraft = normalizeSshDraftForPersistence(draft, secretRef);
      const record = ctx.hosts.create(hostId, persistedDraft, secretRef);
      ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.hostCreated'), {
        hostId: record.id,
        label: record.label,
        kind: record.kind,
        target: ctx.describeHostTarget(record),
        groupName: record.groupName ?? null,
      });
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.hosts.update,
    async (event, id: string, draft: HostDraft, secrets?: HostSecretInput) => {
      const current = ctx.hosts.getById(id);
      if (!current) {
        throw new Error("Host not found");
      }
      const isRdpUpdate = isRdpHostDraft(draft) && isRdpHostRecord(current);
      let secretRef =
        (isSshHostDraft(draft) && isSshHostRecord(current)) || isRdpUpdate
          ? draft.secretRef !== undefined
            ? draft.secretRef
            : (current.secretRef ?? null)
          : null;
      const shouldReuseCurrentSecretMaterial =
        Boolean(
          secrets &&
            (secrets.password !== undefined ||
              secrets.passphrase !== undefined ||
              secrets.privateKeyPem !== undefined ||
              secrets.certificateText !== undefined),
        );
      const resolvedSecrets: HostSecretInput = isSshHostDraft(draft)
        ? {
            ...secrets,
            privateKeyPem: await ctx.resolveManagedPrivateKeyPem(
              draft,
              secrets,
              shouldReuseCurrentSecretMaterial && isSshHostRecord(current)
                ? (current.secretRef ?? null)
                : null,
            ),
            certificateText: await ctx.resolveManagedCertificateText(
              draft,
              secrets,
              shouldReuseCurrentSecretMaterial && isSshHostRecord(current)
                ? (current.secretRef ?? null)
                : null,
            ),
          }
        : {};
      if (
        isSshHostDraft(draft) &&
        (resolvedSecrets.password ||
          resolvedSecrets.passphrase ||
          resolvedSecrets.privateKeyPem ||
          resolvedSecrets.certificateText)
      ) {
        secretRef = await ctx.persistSecret(
          ctx.describeHostLabel(draft),
          resolvedSecrets,
        );
        ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.secretUpdated'), {
          hostId: id,
          secretRef,
        });
      } else if (isSshHostDraft(draft) && secrets) {
        secretRef = isSshHostRecord(current) ? (current.secretRef ?? null) : null;
      } else if (isRdpUpdate && secrets?.password) {
        // 새 비밀번호를 받은 경우에만 다시 저장한다. 비워 두면 기존 ref 를 그대로 유지한다.
        secretRef = await ctx.persistSecret(
          ctx.describeHostLabel(draft),
          rdpSecrets(secrets),
        );
        ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.secretUpdated'), {
          hostId: id,
          secretRef,
        });
      }
      const persistedDraft = normalizeSshDraftForPersistence(draft, secretRef);
      const record = ctx.hosts.update(id, persistedDraft, secretRef);
      ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.hostUpdated'), {
        hostId: record.id,
        label: record.label,
        kind: record.kind,
        target: ctx.describeHostTarget(record),
        groupName: record.groupName ?? null,
      });
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(ipcChannels.hosts.remove, async (event, id: string) => {
    const current = ctx.hosts.getById(id);
    ctx.syncOutbox.upsertDeletion("hosts", id);
    ctx.hosts.remove(id);
    if (current) {
      ctx.activityLogs.append("warn", "audit", logMessage('hostsIpc.hostDeleted'), {
        hostId: current.id,
        label: current.label,
        kind: current.kind,
        target: ctx.describeHostTarget(current),
      });
    }
    ctx.queueSync();
    ctx.emitWorkspaceChanged?.(event?.sender);
  });

  ipcMain.handle(
    ipcChannels.hosts.setFavorite,
    async (event, id: string, favorite: boolean) => {
      const record = ctx.hosts.setFavorite(id, favorite);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return record;
    },
  );

  ipcMain.handle(ipcChannels.groups.list, async () => ctx.groups.list());

  ipcMain.handle(
    ipcChannels.groups.create,
    async (event, name: string, parentPath?: string | null) => {
      const group = ctx.groups.create(randomUUID(), name, parentPath);
      ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.groupCreated'), {
        groupId: group.id,
        name: group.name,
        path: group.path,
        parentPath: group.parentPath ?? null,
      });
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return group;
    },
  );

  ipcMain.handle(
    ipcChannels.groups.remove,
    async (event, path: string, mode: GroupRemoveMode) => {
      const result = ctx.groups.remove(path, mode);
      for (const groupId of result.removedGroupIds) {
        ctx.syncOutbox.upsertDeletion("groups", groupId);
      }
      for (const hostId of result.removedHostIds) {
        ctx.syncOutbox.upsertDeletion("hosts", hostId);
      }
      ctx.activityLogs.append("warn", "audit", logMessage('hostsIpc.groupDeleted'), {
        path,
        mode,
        removedGroupCount: result.removedGroupIds.length,
        removedHostCount: result.removedHostIds.length,
      });
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return {
        groups: result.groups,
        hosts: result.hosts,
      };
    },
  );

  ipcMain.handle(
    ipcChannels.groups.move,
    async (event, path: string, targetParentPath: string | null) => {
      const result = ctx.groups.move(path, targetParentPath);
      ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.groupMoved'), {
        path,
        targetParentPath: targetParentPath ?? null,
        nextPath: result.nextPath,
      });
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return result;
    },
  );

  ipcMain.handle(
    ipcChannels.groups.rename,
    async (event, path: string, name: string) => {
      const result = ctx.groups.rename(path, name);
      ctx.activityLogs.append("info", "audit", logMessage('hostsIpc.groupRenamed'), {
        path,
        nextPath: result.nextPath,
        name,
      });
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return result;
    },
  );
}
