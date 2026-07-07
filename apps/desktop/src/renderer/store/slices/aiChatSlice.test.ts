import { describe, expect, it, vi } from "vitest";
import { createAiChatSlice } from "./aiChatSlice";

// 미니 store 하네스: createAppStore 전체를 만들지 않고 슬라이스만 구동한다.
// (createMockApi 는 ai 브리지가 없어서 여기선 최소 api 를 직접 만든다.)
function harness(aiSettings: unknown) {
  const api = {
    ai: {
      chat: vi.fn().mockResolvedValue({ requestId: "req" }),
      cancelChat: vi.fn().mockResolvedValue(undefined),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (partial: any) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createAiChatSlice({ api, set, get } as any);
  state = { ...slice, settings: { ai: aiSettings } };
  return { api, slice, get };
}

const ENABLED = {
  enabled: true,
  providerId: "openai-compat",
  model: "gpt-x",
  temperature: undefined,
};

describe("aiChatSlice", () => {
  it("sends a user message and calls api.ai.chat with system + user messages", async () => {
    const { api, slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "hello");

    const conv = get().aiConversations["s1"];
    expect(conv.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(conv.streaming).toBe(true);
    expect(conv.requestId).toBeTruthy();

    expect(api.ai.chat).toHaveBeenCalledTimes(1);
    const arg = api.ai.chat.mock.calls[0][0];
    expect(arg.request.model).toBe("gpt-x");
    expect(arg.request.messages[0].role).toBe("system");
    expect(arg.request.messages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(arg.requestId).toBe(conv.requestId);
  });

  it("includes terminal context in the request only (not the stored transcript)", async () => {
    const { api, slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "why did it fail?", "build error at line 42");

    // 표시 메시지엔 컨텍스트가 없다.
    expect(get().aiConversations["s1"].messages).toEqual([
      { role: "user", content: "why did it fail?" },
    ]);
    // 요청엔 컨텍스트가 typed 메시지 바로 앞에 실린다.
    const messages = api.ai.chat.mock.calls[0][0].request.messages;
    const contextMessage = messages[messages.length - 2];
    expect(contextMessage.role).toBe("user");
    expect(contextMessage.content).toContain("build error at line 42");
    expect(messages.at(-1)).toEqual({ role: "user", content: "why did it fail?" });
  });

  it("does not send when the assistant is disabled", async () => {
    const { api, slice, get } = harness({ ...ENABLED, enabled: false });
    await slice.sendAiMessage("s1", "hi");
    expect(api.ai.chat).not.toHaveBeenCalled();
    expect(get().aiConversations["s1"].error?.reason).toBe("disabled");
  });

  it("does not send when no model is configured", async () => {
    const { api, slice, get } = harness({ ...ENABLED, model: "" });
    await slice.sendAiMessage("s1", "hi");
    expect(api.ai.chat).not.toHaveBeenCalled();
    expect(get().aiConversations["s1"].error?.reason).toBe("model-not-found");
  });

  it("accumulates delta events and finalizes an assistant message on done (routed by requestId)", async () => {
    const { slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "hi");
    const requestId = get().aiConversations["s1"].requestId as string;

    slice.handleAiChatEvent({ requestId, type: "delta", delta: { kind: "text", text: "he" } });
    slice.handleAiChatEvent({ requestId, type: "delta", delta: { kind: "text", text: "llo" } });
    expect(get().aiConversations["s1"].streamingText).toBe("hello");

    slice.handleAiChatEvent({
      requestId,
      type: "done",
      result: { text: "hello", finishReason: "stop" },
    });
    const conv = get().aiConversations["s1"];
    expect(conv.streaming).toBe(false);
    expect(conv.streamingText).toBe("");
    expect(conv.messages.at(-1)).toEqual({ role: "assistant", content: "hello" });
  });

  it("sets an error on an error event and ignores unknown requestIds", async () => {
    const { slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "hi");
    const requestId = get().aiConversations["s1"].requestId as string;

    slice.handleAiChatEvent({
      requestId: "other",
      type: "delta",
      delta: { kind: "text", text: "x" },
    });
    expect(get().aiConversations["s1"].streamingText).toBe("");

    slice.handleAiChatEvent({
      requestId,
      type: "error",
      error: { reason: "auth", message: "bad key" },
    });
    const conv = get().aiConversations["s1"];
    expect(conv.error?.reason).toBe("auth");
    expect(conv.streaming).toBe(false);
  });

  it("cancels the active request", async () => {
    const { api, slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "hi");
    const requestId = get().aiConversations["s1"].requestId as string;
    slice.cancelAiMessage("s1");
    expect(api.ai.cancelChat).toHaveBeenCalledWith(requestId);
  });

  it("clears a conversation but keeps the panel open state", async () => {
    const { slice, get } = harness(ENABLED);
    slice.toggleAiPanel("s1");
    await slice.sendAiMessage("s1", "hi");
    slice.clearAiConversation("s1");
    const conv = get().aiConversations["s1"];
    expect(conv.messages).toEqual([]);
    expect(conv.open).toBe(true);
  });

  it("toggles the panel and clamps the width", () => {
    const { slice, get } = harness(ENABLED);
    slice.toggleAiPanel("s1");
    expect(get().aiConversations["s1"].open).toBe(true);
    slice.setAiPanelWidth(99999);
    expect(get().aiPanelWidth).toBeLessThanOrEqual(760);
    slice.setAiPanelWidth(10);
    expect(get().aiPanelWidth).toBeGreaterThanOrEqual(280);
  });
});
