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
      // chatEvent/terminalOutputRequest 는 push 전용이라 핸들러가 없다.
      if (channel === ipcChannels.ai.chatEvent || channel === ipcChannels.ai.terminalOutputRequest) {
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

  it("delegates codex auth + usage channels to the service", async () => {
    const codexLoginStart = vi.fn().mockResolvedValue({ loginId: "L1", authUrl: "https://auth" });
    const codexAuthStatus = vi.fn().mockResolvedValue({ authenticated: false });
    const codexLogout = vi.fn().mockResolvedValue(undefined);
    const codexUsage = vi.fn().mockResolvedValue({ planType: "plus", primary: null, secondary: null });
    const handlers = setup({ codexLoginStart, codexAuthStatus, codexLogout, codexUsage });

    await expect(handlers.get(ipcChannels.ai.codexLoginStart)!({})).resolves.toEqual({
      loginId: "L1",
      authUrl: "https://auth",
    });
    await expect(handlers.get(ipcChannels.ai.codexAuthStatus)!({})).resolves.toEqual({
      authenticated: false,
    });
    await expect(handlers.get(ipcChannels.ai.codexUsage)!({})).resolves.toMatchObject({
      planType: "plus",
    });
    await handlers.get(ipcChannels.ai.codexLogout)!({});
    expect(codexLogout).toHaveBeenCalledTimes(1);
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

  it("bridges read_terminal_output tool requests to the originating renderer", async () => {
    const startChat = vi.fn();
    const handlers = setup({ startChat });
    const send = vi.fn();
    const sender = {
      id: 42,
      isDestroyed: () => false,
      send,
      once: vi.fn(),
      off: vi.fn(),
    };
    const event = { sender };
    await handlers.get(ipcChannels.ai.chat)!(event, {
      requestId: "r-tool",
      request: { model: "m", messages: [] },
      terminalSnapshot: { snapshotId: "snap-1", recentOutputLines: 100 },
    });

    const clientTools = startChat.mock.calls[0][2] as {
      readTerminalOutput: (
        input: { beforeRecentLines: number; lines: number },
        signal: AbortSignal,
      ) => Promise<unknown>;
    };
    const outputPromise = clientTools.readTerminalOutput(
      { beforeRecentLines: 100, lines: 200 },
      new AbortController().signal,
    );
    expect(send).toHaveBeenCalledWith(
      ipcChannels.ai.terminalOutputRequest,
      expect.objectContaining({
        requestId: "r-tool",
        snapshotId: "snap-1",
        beforeRecentLines: 100,
        lines: 200,
      }),
    );

    const requestPayload = send.mock.calls.find(
      ([channel]) => channel === ipcChannels.ai.terminalOutputRequest,
    )?.[1] as { clientRequestId: string };
    await handlers.get(ipcChannels.ai.terminalOutputResponse)!(
      { sender },
      {
        clientRequestId: requestPayload.clientRequestId,
        text: "older output",
        rangeLabel: "101~300줄 전",
      },
    );

    await expect(outputPromise).resolves.toMatchObject({
      text: "older output",
      rangeLabel: "101~300줄 전",
    });
    expect(sender.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
  });

  it("ignores terminal output responses from a different renderer", async () => {
    const startChat = vi.fn();
    const handlers = setup({ startChat });
    const send = vi.fn();
    const sender = {
      id: 1,
      isDestroyed: () => false,
      send,
      once: vi.fn(),
      off: vi.fn(),
    };
    await handlers.get(ipcChannels.ai.chat)!(
      { sender },
      {
        requestId: "r-tool",
        request: { model: "m", messages: [] },
        terminalSnapshot: { snapshotId: "snap-1", recentOutputLines: 100 },
      },
    );
    const clientTools = startChat.mock.calls[0][2] as {
      readTerminalOutput: (
        input: { beforeRecentLines: number; lines: number },
        signal: AbortSignal,
      ) => Promise<unknown>;
    };
    const controller = new AbortController();
    const outputPromise = clientTools.readTerminalOutput(
      { beforeRecentLines: 100, lines: 200 },
      controller.signal,
    );
    const requestPayload = send.mock.calls.find(
      ([channel]) => channel === ipcChannels.ai.terminalOutputRequest,
    )?.[1] as { clientRequestId: string };

    await handlers.get(ipcChannels.ai.terminalOutputResponse)!(
      { sender: { id: 999 } },
      { clientRequestId: requestPayload.clientRequestId, text: "wrong renderer" },
    );
    controller.abort();

    await expect(outputPromise).resolves.toMatchObject({
      error: "terminal output request aborted",
    });
  });

  it("fails terminal output reads safely when the sender is already destroyed", async () => {
    const startChat = vi.fn();
    const handlers = setup({ startChat });
    const sender = {
      id: 2,
      isDestroyed: () => true,
      send: vi.fn(),
    };
    await handlers.get(ipcChannels.ai.chat)!(
      { sender },
      {
        requestId: "r-tool",
        request: { model: "m", messages: [] },
        terminalSnapshot: { snapshotId: "snap-1", recentOutputLines: 100 },
      },
    );
    const clientTools = startChat.mock.calls[0][2] as {
      readTerminalOutput: (
        input: { beforeRecentLines: number; lines: number },
        signal: AbortSignal,
      ) => Promise<unknown>;
    };

    await expect(
      clientTools.readTerminalOutput(
        { beforeRecentLines: 100, lines: 200 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ error: "renderer is destroyed" });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("times out unanswered terminal output requests", async () => {
    vi.useFakeTimers();
    try {
      const startChat = vi.fn();
      const handlers = setup({ startChat });
      const sender = {
        id: 3,
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
      };
      await handlers.get(ipcChannels.ai.chat)!(
        { sender },
        {
          requestId: "r-timeout",
          request: { model: "m", messages: [] },
          terminalSnapshot: { snapshotId: "snap-timeout", recentOutputLines: 100 },
        },
      );
      const clientTools = startChat.mock.calls[0][2] as {
        readTerminalOutput: (
          input: { beforeRecentLines: number; lines: number },
          signal: AbortSignal,
        ) => Promise<unknown>;
      };
      const outputPromise = clientTools.readTerminalOutput(
        { beforeRecentLines: 100, lines: 200 },
        new AbortController().signal,
      );

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(outputPromise).resolves.toMatchObject({
        error: "terminal output request timed out",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
