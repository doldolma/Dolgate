import type { GroupRemoveMode, HostDraft, HostSecretInput } from "@shared";
import { isSshHostDraft, isSshHostRecord } from "@shared";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerHostsGroupsIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.hosts.list, async () => ctx.hosts.list());

  ipcMain.handle(
    ipcChannels.hosts.create,
    async (_event, draft: HostDraft, secrets?: HostSecretInput) => {
      const hostId = randomUUID();
      const resolvedSecrets: HostSecretInput = isSshHostDraft(draft)
        ? {
            ...secrets,
            privateKeyPem: await ctx.resolveManagedPrivateKeyPem(draft, null),
          }
        : {};
      const secretRef = isSshHostDraft(draft)
        ? await ctx.persistSecret(
            ctx.describeHostLabel(draft),
            resolvedSecrets,
          )
        : null;
      if (secretRef) {
        ctx.activityLogs.append("info", "audit", "호스트 secret이 저장되었습니다.", {
          hostId,
          secretRef,
        });
      }
      const record = ctx.hosts.create(hostId, draft, secretRef);
      ctx.activityLogs.append("info", "audit", "호스트를 생성했습니다.", {
        hostId: record.id,
        label: record.label,
        kind: record.kind,
        target: ctx.describeHostTarget(record),
        groupName: record.groupName ?? null,
      });
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.hosts.update,
    async (_event, id: string, draft: HostDraft, secrets?: HostSecretInput) => {
      const current = ctx.hosts.getById(id);
      if (!current) {
        throw new Error("Host not found");
      }
      let secretRef =
        isSshHostDraft(draft) && isSshHostRecord(current)
          ? draft.secretRef !== undefined
            ? draft.secretRef
            : (current.secretRef ?? null)
          : null;
      const resolvedSecrets: HostSecretInput = isSshHostDraft(draft)
        ? {
            ...secrets,
            privateKeyPem: await ctx.resolveManagedPrivateKeyPem(
              draft,
              isSshHostRecord(current) ? (current.secretRef ?? null) : null,
            ),
          }
        : {};
      if (
        isSshHostDraft(draft) &&
        (resolvedSecrets.password ||
          resolvedSecrets.passphrase ||
          resolvedSecrets.privateKeyPem)
      ) {
        secretRef = await ctx.persistSecret(
          ctx.describeHostLabel(draft),
          resolvedSecrets,
        );
        ctx.activityLogs.append("info", "audit", "호스트 secret이 갱신되었습니다.", {
          hostId: id,
          secretRef,
        });
      } else if (isSshHostDraft(draft) && secrets) {
        secretRef = isSshHostRecord(current) ? (current.secretRef ?? null) : null;
      }
      const record = ctx.hosts.update(id, draft, secretRef);
      ctx.activityLogs.append("info", "audit", "호스트를 수정했습니다.", {
        hostId: record.id,
        label: record.label,
        kind: record.kind,
        target: ctx.describeHostTarget(record),
        groupName: record.groupName ?? null,
      });
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(ipcChannels.hosts.remove, async (_event, id: string) => {
    const current = ctx.hosts.getById(id);
    ctx.syncOutbox.upsertDeletion("hosts", id);
    ctx.hosts.remove(id);
    if (current) {
      ctx.activityLogs.append("warn", "audit", "호스트를 삭제했습니다.", {
        hostId: current.id,
        label: current.label,
        kind: current.kind,
        target: ctx.describeHostTarget(current),
      });
    }
    ctx.queueSync();
  });

  ipcMain.handle(ipcChannels.groups.list, async () => ctx.groups.list());

  ipcMain.handle(
    ipcChannels.groups.create,
    async (_event, name: string, parentPath?: string | null) => {
      const group = ctx.groups.create(randomUUID(), name, parentPath);
      ctx.activityLogs.append("info", "audit", "그룹을 생성했습니다.", {
        groupId: group.id,
        name: group.name,
        path: group.path,
        parentPath: group.parentPath ?? null,
      });
      ctx.queueSync();
      return group;
    },
  );

  ipcMain.handle(
    ipcChannels.groups.remove,
    async (_event, path: string, mode: GroupRemoveMode) => {
      const result = ctx.groups.remove(path, mode);
      for (const groupId of result.removedGroupIds) {
        ctx.syncOutbox.upsertDeletion("groups", groupId);
      }
      for (const hostId of result.removedHostIds) {
        ctx.syncOutbox.upsertDeletion("hosts", hostId);
      }
      ctx.activityLogs.append("warn", "audit", "그룹을 삭제했습니다.", {
        path,
        mode,
        removedGroupCount: result.removedGroupIds.length,
        removedHostCount: result.removedHostIds.length,
      });
      ctx.queueSync();
      return {
        groups: result.groups,
        hosts: result.hosts,
      };
    },
  );

  ipcMain.handle(
    ipcChannels.groups.move,
    async (_event, path: string, targetParentPath: string | null) => {
      const result = ctx.groups.move(path, targetParentPath);
      ctx.activityLogs.append("info", "audit", "그룹을 이동했습니다.", {
        path,
        targetParentPath: targetParentPath ?? null,
        nextPath: result.nextPath,
      });
      ctx.queueSync();
      return result;
    },
  );

  ipcMain.handle(
    ipcChannels.groups.rename,
    async (_event, path: string, name: string) => {
      const result = ctx.groups.rename(path, name);
      ctx.activityLogs.append("info", "audit", "그룹 이름을 변경했습니다.", {
        path,
        nextPath: result.nextPath,
        name,
      });
      ctx.queueSync();
      return result;
    },
  );
}
