import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";

const { handlers, dialogMock, documents } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dialogMock: { showSaveDialog: vi.fn() },
  documents: { path: "" },
}));

vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "documents" ? documents.path : "/tmp") },
  dialog: dialogMock,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const { registerLogsExportIpcHandlers } = await import("./logs-export");

const folder = mkdtempSync(path.join(os.tmpdir(), "dolgate-logs-export-"));
documents.path = path.join(folder, "Documents");
const CSV = "﻿Time,Kind\r\n2026-11-02 10:00:00,SSH\r\n";

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

function harness() {
  const ctx = {
    activityLogs: { append: vi.fn() },
    resolveWindowFromSender: vi.fn(() => ({ id: 1 })),
  };
  registerLogsExportIpcHandlers(ctx as never);
  const exportCsv = (input: unknown) => handlers.get("logs:export-csv")!({ sender: {} }, input);
  return { ctx, exportCsv };
}

beforeEach(() => {
  handlers.clear();
  dialogMock.showSaveDialog.mockReset();
});

describe("logs:export-csv", () => {
  it("saves the CSV where the save window says, and records the export with the team", async () => {
    const { ctx, exportCsv } = harness();
    const target = path.join(folder, "team-logs");
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });

    const result = await exportCsv({
      content: CSV,
      fileName: "dolgate-logs-platform-2026-11-02.csv",
      rowCount: 1,
      vaultId: "team-1",
    });

    // 확장자가 없으면 붙인다.
    expect(result).toEqual({ canceled: false, savedPath: `${target}.csv` });
    expect(readFileSync(`${target}.csv`, "utf8")).toBe(CSV);
    // 암호를 푼 글이라 나만 읽게 쓴다.
    expect(statSync(`${target}.csv`).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const [window, options] = dialogMock.showSaveDialog.mock.calls[0]!;
    expect(window).toEqual({ id: 1 });
    expect(options).toMatchObject({
      title: t("logsExport.title"),
      message: t("logsExport.plaintext"),
      defaultPath: path.join(documents.path, "dolgate-logs-platform-2026-11-02.csv"),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    // 팀을 실어 남긴다 — 그래야 그 팀 기록에도 올라간다.
    expect(ctx.activityLogs.append).toHaveBeenCalledWith(
      "info",
      "audit",
      expect.objectContaining({ messageKey: "logsExport.exported", messageParams: { count: 1 } }),
      { rowCount: 1, vaultId: "team-1" },
    );
  });

  it("records a personal export without a vault", async () => {
    const { ctx, exportCsv } = harness();
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(folder, "mine.csv") });

    await exportCsv({ content: CSV, fileName: "dolgate-logs-personal-2026-11-02.csv", rowCount: 3, vaultId: null });

    expect(readFileSync(path.join(folder, "mine.csv"), "utf8")).toBe(CSV);
    expect(ctx.activityLogs.append.mock.calls[0]?.[3]).toEqual({ rowCount: 3 });
  });

  it("writes nothing and records nothing when the save window is cancelled", async () => {
    const { ctx, exportCsv } = harness();
    // 취소해도 경로가 실려 올 수 있다 — 그래도 쓰지 않는다(경로는 시험 폴더 안이라 잘못 써도 저장소를 더럽히지 않는다).
    const notHere = path.join(folder, "cancelled.csv");
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: notHere });

    await expect(exportCsv({ content: CSV, fileName: "x.csv", rowCount: 1 })).resolves.toEqual({
      canceled: true,
      savedPath: null,
    });
    expect(ctx.activityLogs.append).not.toHaveBeenCalled();
    expect(existsSync(notHere)).toBe(false);
  });

  it("only takes a name from the screen — the folder is the person's pick", async () => {
    const { exportCsv } = harness();
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: path.join(folder, "evil-cancelled.csv") });

    await exportCsv({ content: CSV, fileName: "../../etc/evil.csv", rowCount: 1 });

    expect(dialogMock.showSaveDialog.mock.calls[0]?.[1]).toMatchObject({
      defaultPath: path.join(documents.path, "evil.csv"),
    });
  });

  it("refuses a request without CSV text", async () => {
    const { exportCsv } = harness();
    await expect(exportCsv({ fileName: "x.csv", rowCount: 1 })).rejects.toThrow(t("logsExport.invalid"));
    await expect(exportCsv(null)).rejects.toThrow(t("logsExport.invalid"));
    expect(dialogMock.showSaveDialog).not.toHaveBeenCalled();
  });
});
