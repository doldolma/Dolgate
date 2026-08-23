import type { GroupRemoveMode, HostDraft, HostSecretInput, TerminalThemeId } from "@shared";
import {
  isRdpHostDraft,
  isRdpHostRecord,
  isSshHostDraft,
  isSshHostRecord,
  isVncHostDraft,
  isVncHostRecord,
} from "@shared";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";
import { t } from '../i18n';
import { logMessage } from "../activity-log-message";

/**
 * 비밀번호로 붙는 종류(RDP·VNC)의 자격증명으로 저장할 값.
 *
 * 필드를 하나하나 나열해 넘기던 자리였는데, 그러다 계정(`username`/`domain`)과 종류(`kind`)를
 * 빠뜨려서 **저장해도 목록에 안 나오는** 상태가 됐다(kind 가 없으면 목록 필터에 안 걸린다).
 * 한 곳으로 모아 다시 빠뜨리지 않게 한다.
 *
 * `kind` 는 호출부가 넘긴다 — 종류마다 자격증명 목록이 갈리므로 여기서 'rdp' 로 굳히면 VNC
 * 자격증명이 RDP 목록에 섞인다. VNC 는 계정이 없는 경우가 많지만(VncAuth 는 비밀번호만) 폼이
 * 넘긴 값은 그대로 실어 보낸다 — VeNCrypt 의 Plain 계열은 계정을 쓴다.
 */
function passwordSecrets(
  kind: 'rdp' | 'vnc',
  secrets: HostSecretInput,
): HostSecretInput {
  return {
    kind,
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
      // RDP·VNC 는 비밀번호를 자격증명으로 저장한다. 한쪽만 보면 다른 쪽 비밀번호가 조용히
      // 사라진다(RDP 에서 한 번 겪었고, VNC 를 추가할 때 같은 자리에서 또 새어 나왔다).
      // boolean 별칭을 따로 둔다 — 종류 문자열로는 draft 유니온이 좁혀지지 않아서 아래에서
      // draft.secretRef 를 읽을 수 없다(TS 의 aliased condition 은 boolean 에만 적용된다).
      const isRdpDraft = isRdpHostDraft(draft);
      const isVncDraft = isVncHostDraft(draft);
      const passwordKind = isRdpDraft ? ('rdp' as const) : isVncDraft ? ('vnc' as const) : null;
      const existingSecretRef =
        isSshHostDraft(draft) || isRdpDraft || isVncDraft
          ? (draft.secretRef ?? null)
          : null;
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
        : passwordKind && secrets?.password
          ? await ctx.persistSecret(
              ctx.describeHostLabel(draft),
              passwordSecrets(passwordKind, secrets),
            )
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
      const isVncUpdate = isVncHostDraft(draft) && isVncHostRecord(current);
      const passwordUpdateKind = isRdpUpdate
        ? ('rdp' as const)
        : isVncUpdate
          ? ('vnc' as const)
          : null;
      let secretRef =
        (isSshHostDraft(draft) && isSshHostRecord(current)) || isRdpUpdate || isVncUpdate
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
      } else if (passwordUpdateKind && secrets?.password) {
        // 새 비밀번호를 받은 경우에만 다시 저장한다. 비워 두면 기존 ref 를 그대로 유지한다.
        secretRef = await ctx.persistSecret(
          ctx.describeHostLabel(draft),
          passwordSecrets(passwordUpdateKind, secrets),
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

  ipcMain.handle(
    ipcChannels.hosts.setTerminalTheme,
    async (event, id: string, terminalThemeId: TerminalThemeId | null) => {
      const record = ctx.hosts.setTerminalTheme(id, terminalThemeId);
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
    ipcChannels.groups.setOrder,
    async (event, assignments: Array<{ id: string; sortRank: number }>) => {
      // 삭제가 아니므로 outbox 툼스톤은 없다 — create/move/rename 과 같이 queueSync 가
      // 다음 push 에서 바뀐 레코드를 실어 간다.
      const groups = ctx.groups.setSortRanks(assignments);
      ctx.queueSync();
      ctx.emitWorkspaceChanged?.(event?.sender);
      return groups;
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
