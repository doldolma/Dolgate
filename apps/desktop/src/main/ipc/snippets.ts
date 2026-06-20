import { ipcMain } from "electron";
import type { SnippetDraft } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerSnippetsIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.snippets.list, async () => ctx.snippets.list());

  ipcMain.handle(
    ipcChannels.snippets.create,
    async (_event, draft: SnippetDraft) => {
      const record = ctx.snippets.create(draft);
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.snippets.update,
    async (_event, id: string, draft: SnippetDraft) => {
      const record = ctx.snippets.update(id, draft);
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(ipcChannels.snippets.remove, async (_event, id: string) => {
    ctx.snippets.remove(id);
    ctx.syncOutbox.upsertDeletion("snippets", id);
    ctx.queueSync();
  });
}
