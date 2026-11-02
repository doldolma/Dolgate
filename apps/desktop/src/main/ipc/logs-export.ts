import path from "node:path";
import { app, dialog, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { LogsCsvExportInput, LogsCsvExportResult } from "../../shared/ipc";
import { logMessage } from "../activity-log-message";
import { t } from "../i18n";
import type { MainIpcContext } from "./context";
import { ensureExtension, writeFileAtomically } from "./save-file";

/**
 * 기록 화면의 CSV 내보내기. 글은 화면이 지금 거른 줄로 만들고, 여기서는 저장 창을 띄워 쓴다. 암호를 푼 글이라 저장 창에
 * 한 줄로 알린다(macOS 저장 창). 내보냈다는 줄을 기록에 남긴다 — 팀 기록이면 그 팀을 실어 팀 기록에도 남는다.
 */
export function registerLogsExportIpcHandlers(
  ctx: Pick<MainIpcContext, "activityLogs" | "resolveWindowFromSender">,
): void {
  ipcMain.handle(
    ipcChannels.logs.exportCsv,
    async (event, input: LogsCsvExportInput): Promise<LogsCsvExportResult> => {
      if (!input || typeof input.content !== "string" || typeof input.fileName !== "string") {
        throw new Error(t("logsExport.invalid"));
      }
      const window = ctx.resolveWindowFromSender(event.sender);
      const result = await dialog.showSaveDialog(window, {
        title: t("logsExport.title"),
        message: t("logsExport.plaintext"),
        // 이름만 받는다 — 폴더는 저장 창에서 사람이 고른다.
        defaultPath: path.join(app.getPath("documents"), path.basename(input.fileName)),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (result.canceled || !result.filePath) {
        return { canceled: true, savedPath: null };
      }
      const savedPath = ensureExtension(result.filePath, ".csv");
      await writeFileAtomically(savedPath, input.content);
      const rowCount = Number.isFinite(input.rowCount) ? input.rowCount : 0;
      ctx.activityLogs.append(
        "info",
        "audit",
        logMessage("logsExport.exported", { count: rowCount }),
        { rowCount, ...(input.vaultId ? { vaultId: input.vaultId } : {}) },
      );
      return { canceled: false, savedPath };
    },
  );
}
