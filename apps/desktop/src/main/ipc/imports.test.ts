import { describe, expect, it, vi } from "vitest";

const { handlers, dialogMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dialogMock: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "0.0.0" },
  dialog: dialogMock,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const { registerImportIpcHandlers } = await import("./imports");

describe("registerImportIpcHandlers import file picker", () => {
  it("다음 선택은 마지막으로 가져온 파일이 있던 폴더에서 열고, 취소는 그 위치를 바꾸지 않는다", async () => {
    registerImportIpcHandlers({ resolveWindowFromSender: () => null } as never);
    const pick = handlers.get("host-transfer:pick-import-file")!;

    dialogMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/Users/me/Downloads/team/hosts.dolgate"],
    });
    await expect(pick({ sender: {} })).resolves.toEqual({
      filePath: "/Users/me/Downloads/team/hosts.dolgate",
      fileName: "hosts.dolgate",
    });
    expect(dialogMock.showOpenDialog.mock.calls[0][1]).toMatchObject({ defaultPath: undefined });

    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(pick({ sender: {} })).resolves.toBeNull();
    expect(dialogMock.showOpenDialog.mock.calls[1][1]).toMatchObject({
      defaultPath: "/Users/me/Downloads/team",
    });

    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await pick({ sender: {} });
    expect(dialogMock.showOpenDialog.mock.calls[2][1]).toMatchObject({
      defaultPath: "/Users/me/Downloads/team",
    });
  });
});
