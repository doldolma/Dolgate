import { ipcMain } from "electron";
import type { SnippetDraft } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { t } from "../i18n";
import { PERSONAL_VAULT_ID } from "../vault-catalog";
import type { MainIpcContext } from "./context";

export function registerSnippetsIpcHandlers(ctx: MainIpcContext): void {
  // 목록은 모든 볼트의 스니펫이다 — 화면이 볼트 표로 묶는다. 쓰기는 그 스니펫이 든 볼트로 간다.
  ipcMain.handle(ipcChannels.snippets.list, async () => ctx.vaults.listSnippets());

  ipcMain.handle(
    ipcChannels.snippets.create,
    async (_event, draft: SnippetDraft, vaultId?: string) => {
      const scope = ctx.vaults.getScope(vaultId ?? PERSONAL_VAULT_ID);
      if (!scope) {
        throw new Error(t("teams.notOnDevice"));
      }
      const record = scope.snippets.create(draft);
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.snippets.update,
    async (_event, id: string, draft: SnippetDraft) => {
      const record = ctx.vaults.scopeOfSnippet(id).snippets.update(id, draft);
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(ipcChannels.snippets.remove, async (_event, id: string) => {
    // 시작 스니펫으로 쓰던 호스트는 같은 볼트에만 있다(볼트 넘는 참조는 저장하지 않는다).
    const scope = ctx.vaults.scopeOfSnippet(id);
    scope.snippets.remove(id);
    scope.hosts.clearStartupSnippetRef(id);
    scope.syncOutbox.upsertDeletion("snippets", id);
    ctx.queueSync();
  });
}
