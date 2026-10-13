import { beforeEach, describe, expect, it, vi } from "vitest";

// Electron 44 부터 클립보드 읽기·쓰기는 Promise 다. 테스트마다 값을 바꿔 끼운다.
const { listeners, clipboardMock } = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  clipboardMock: {
    readText: vi.fn(async (): Promise<string> => ""),
    writeText: vi.fn(async (_text: string) => {}),
  },
}));

vi.mock("electron", () => ({
  clipboard: clipboardMock,
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(channel, listener);
    },
  },
}));

const { registerVncIpcHandlers } = await import("./vnc");

function createHarness() {
  const vncManager = {
    onRemoteClipboardText: null as ((text: string) => void) | null,
    sendClipboardText: vi.fn(),
  };
  registerVncIpcHandlers({} as never, vncManager as never);
  return { vncManager };
}

describe("registerVncIpcHandlers clipboard", () => {
  beforeEach(() => {
    clipboardMock.readText.mockReset();
    clipboardMock.writeText.mockReset();
  });

  it("원격 값이 로컬 클립보드와 같으면 다시 쓰지 않는다", async () => {
    const { vncManager } = createHarness();
    clipboardMock.readText.mockResolvedValue("same");

    vncManager.onRemoteClipboardText!("same");
    await vi.waitFor(() => expect(clipboardMock.readText).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("원격 값이 다르면 로컬 클립보드에 쓴다", async () => {
    const { vncManager } = createHarness();
    clipboardMock.readText.mockResolvedValue("old");

    vncManager.onRemoteClipboardText!("new");

    await vi.waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledWith("new"));
  });

  it("포커스 때 로컬 클립보드를 원격으로 올리고, 비어 있으면 보내지 않는다", async () => {
    const { vncManager } = createHarness();
    const sync = listeners.get("vnc:sync-clipboard")!;

    clipboardMock.readText.mockResolvedValue("local text");
    sync({}, "sess-1");
    await vi.waitFor(() =>
      expect(vncManager.sendClipboardText).toHaveBeenCalledWith("sess-1", "local text"),
    );

    vncManager.sendClipboardText.mockClear();
    clipboardMock.readText.mockResolvedValue("");
    sync({}, "sess-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vncManager.sendClipboardText).not.toHaveBeenCalled();
  });
});
