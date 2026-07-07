import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";
import { registerAiIpcHandlers } from "./ai";

const electronSpies = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronSpies.ipcMainHandle,
  },
}));

type Handler = (...args: unknown[]) => Promise<unknown>;

describe("registerAiIpcHandlers", () => {
  beforeEach(() => {
    electronSpies.ipcMainHandle.mockReset();
  });

  function setup(aiService: Record<string, unknown>): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    electronSpies.ipcMainHandle.mockImplementation((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    });
    registerAiIpcHandlers({ aiService } as never);
    return handlers;
  }

  it("registers a handler for every invokable ai channel", () => {
    const handlers = setup({});
    for (const channel of Object.values(ipcChannels.ai)) {
      // chatEvent 는 push 전용이라 핸들러가 없다.
      if (channel === ipcChannels.ai.chatEvent) {
        continue;
      }
      expect(handlers.get(channel)).toBeTypeOf("function");
    }
  });

  it("delegates testConnection to the service", async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: true, message: "ok" });
    const handlers = setup({ testConnection });
    const input = { providerId: "anthropic", model: "m" };
    const result = await handlers.get(ipcChannels.ai.testConnection)!({}, input);
    expect(testConnection).toHaveBeenCalledWith(input);
    expect(result).toEqual({ ok: true, message: "ok" });
  });

  it("passes providerId and key straight to setApiKey", async () => {
    const setApiKey = vi.fn().mockResolvedValue({ hasKey: true });
    const handlers = setup({ setApiKey });
    await handlers.get(ipcChannels.ai.setApiKey)!({}, "openai-compat", "sk-x");
    expect(setApiKey).toHaveBeenCalledWith("openai-compat", "sk-x");
  });

  it("apiKeyStatus exposes only hasKey (never the raw key)", async () => {
    const apiKeyStatus = vi.fn().mockResolvedValue({ hasKey: true });
    const handlers = setup({ apiKeyStatus });
    const result = (await handlers.get(ipcChannels.ai.apiKeyStatus)!({}, "anthropic")) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ hasKey: true });
    expect(Object.keys(result)).toEqual(["hasKey"]);
  });

  it("chat returns the requestId and forwards stream events to the sender", async () => {
    const startChat = vi.fn();
    const handlers = setup({ startChat });
    const send = vi.fn();
    const event = { sender: { isDestroyed: () => false, send } };
    const result = await handlers.get(ipcChannels.ai.chat)!(event, {
      requestId: "r1",
      request: { model: "m", messages: [] },
    });
    expect(result).toEqual({ requestId: "r1" });
    expect(startChat).toHaveBeenCalledTimes(1);

    const emit = startChat.mock.calls[0][1] as (payload: unknown) => void;
    emit({ requestId: "r1", type: "done", result: { text: "", finishReason: "stop" } });
    expect(send).toHaveBeenCalledWith(
      ipcChannels.ai.chatEvent,
      expect.objectContaining({ requestId: "r1", type: "done" }),
    );
  });

  it("does not send to a destroyed sender", async () => {
    const startChat = vi.fn();
    const handlers = setup({ startChat });
    const send = vi.fn();
    const event = { sender: { isDestroyed: () => true, send } };
    await handlers.get(ipcChannels.ai.chat)!(event, {
      requestId: "r9",
      request: { model: "m", messages: [] },
    });
    const emit = startChat.mock.calls[0][1] as (payload: unknown) => void;
    emit({ requestId: "r9", type: "done", result: { text: "", finishReason: "stop" } });
    expect(send).not.toHaveBeenCalled();
  });
});
