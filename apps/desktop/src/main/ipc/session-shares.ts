import type {
  SessionShareInputToggleInput,
  SessionShareSnapshotInput,
  SessionShareStartInput,
} from "@shared";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerSessionShareIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.sessionShares.start,
    async (_event, input: SessionShareStartInput) =>
      ctx.sessionShareService.start(input),
  );
  ipcMain.handle(
    ipcChannels.sessionShares.updateSnapshot,
    async (_event, input: SessionShareSnapshotInput) => {
      await ctx.sessionShareService.updateSnapshot(input);
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.setInputEnabled,
    async (_event, input: SessionShareInputToggleInput) =>
      ctx.sessionShareService.setInputEnabled(input),
  );
  ipcMain.handle(
    ipcChannels.sessionShares.stop,
    async (_event, sessionId: string) => {
      await ctx.sessionShareService.stop(sessionId);
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.openOwnerChatWindow,
    async (event, sessionId: string) => {
      await ctx.sessionShareService.openOwnerChatWindow(
        sessionId,
        ctx.resolveWindowFromSender(event.sender),
      );
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.sendOwnerChatMessage,
    async (_event, sessionId: string, text: string) => {
      await ctx.sessionShareService.sendOwnerChatMessage(sessionId, text);
    },
  );
  ipcMain.handle(
    ipcChannels.sessionShares.getOwnerChatSnapshot,
    async (_event, sessionId: string) =>
      ctx.sessionShareService.getOwnerChatSnapshot(sessionId),
  );
}

