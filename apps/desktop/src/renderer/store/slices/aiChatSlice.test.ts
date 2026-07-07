import { describe, expect, it, vi } from "vitest";
import { createAiChatSlice } from "./aiChatSlice";

// 미니 store 하네스: createAppStore 전체를 만들지 않고 슬라이스만 구동한다.
// (createMockApi 는 ai 브리지가 없어서 여기선 최소 api 를 직접 만든다.)
function harness(aiSettings: unknown) {
  const api = {
    ai: {
      chat: vi.fn().mockResolvedValue({ requestId: "req" }),
      cancelChat: vi.fn().mockResolvedValue(undefined),
      respondApproval: vi.fn().mockResolvedValue(undefined),
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
    expect(arg.request.messages[0].content).toContain("Dolgate AI Assistant");
    expect(arg.request.messages[0].content).toContain('"gpt-x"');
    expect(arg.request.messages[0].content).toContain(
      "Only mention the configured model identifier when the user explicitly asks what model is being used",
    );
    expect(arg.request.messages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(arg.requestId).toBe(conv.requestId);
    // sessionId 를 함께 전달해야 main 의 run_command 가 어느 세션에서 실행할지 안다.
    expect(arg.sessionId).toBe("s1");
  });

  it("includes session context in the request only (not the stored transcript)", async () => {
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
    expect(contextMessage.content).toContain("현재 세션 컨텍스트");
    expect(contextMessage.content).toContain("build error at line 42");
    expect(messages.at(-1)).toEqual({ role: "user", content: "why did it fail?" });
  });

  it("passes terminal snapshot metadata with the chat request and clears it on completion", async () => {
    const { api, slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "read older output", undefined, {
      snapshotId: "snapshot-1",
      recentOutputLines: 100,
    });

    const conv = get().aiConversations["s1"];
    expect(conv.terminalSnapshotId).toBe("snapshot-1");
    expect(api.ai.chat.mock.calls[0][0].terminalSnapshot).toEqual({
      snapshotId: "snapshot-1",
      recentOutputLines: 100,
    });

    slice.handleAiChatEvent({
      requestId: conv.requestId,
      type: "done",
      result: { text: "ok", finishReason: "stop" },
    });
    expect(get().aiConversations["s1"].terminalSnapshotId).toBeNull();
  });

  it("carries attachments on both the stored message and the wire message", async () => {
    const { api, slice, get } = harness(ENABLED);
    const attachments = [
      { kind: "image" as const, mediaType: "image/png", dataBase64: "aGk=" },
      { kind: "text" as const, name: "app.log", text: "line1" },
    ];
    await slice.sendAiMessage("s1", "이거 봐줘", undefined, undefined, attachments);

    expect(get().aiConversations["s1"].messages).toEqual([
      { role: "user", content: "이거 봐줘", attachments },
    ]);
    const messages = api.ai.chat.mock.calls[0][0].request.messages;
    expect(messages.at(-1)).toEqual({ role: "user", content: "이거 봐줘", attachments });
  });

  it("allows an attachment-only send (empty text)", async () => {
    const { api, slice, get } = harness(ENABLED);
    const attachments = [{ kind: "image" as const, mediaType: "image/png", dataBase64: "aGk=" }];
    await slice.sendAiMessage("s1", "   ", undefined, undefined, attachments);

    expect(api.ai.chat).toHaveBeenCalledTimes(1);
    expect(get().aiConversations["s1"].messages).toEqual([
      { role: "user", content: "", attachments },
    ]);
  });

  it("still ignores an empty send without attachments", async () => {
    const { api, slice } = harness(ENABLED);
    await slice.sendAiMessage("s1", "   ");
    expect(api.ai.chat).not.toHaveBeenCalled();
  });

  it("re-sends history attachments on the next turn via toWireMessage", async () => {
    const { api, slice, get } = harness(ENABLED);
    const attachments = [{ kind: "image" as const, mediaType: "image/png", dataBase64: "aGk=" }];
    await slice.sendAiMessage("s1", "첫 질문", undefined, undefined, attachments);
    slice.handleAiChatEvent({
      requestId: get().aiConversations["s1"].requestId,
      type: "done",
      result: { text: "답", finishReason: "stop" },
    });

    await slice.sendAiMessage("s1", "후속 질문");
    const messages = api.ai.chat.mock.calls[1][0].request.messages;
    const historyUser = messages.find((m: { content: string }) => m.content === "첫 질문");
    expect(historyUser.attachments).toEqual(attachments);
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

  it("keeps different streamed text as collapsed generation trace on the final assistant message", async () => {
    const { slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "hi");
    const requestId = get().aiConversations["s1"].requestId as string;

    slice.handleAiChatEvent({
      requestId,
      type: "delta",
      delta: { kind: "text", text: "검사 중입니다..." },
    });
    slice.handleAiChatEvent({
      requestId,
      type: "done",
      result: { text: "원인은 SSH 키 권한 문제입니다.", finishReason: "stop" },
    });

    expect(get().aiConversations["s1"].messages.at(-1)).toEqual({
      role: "assistant",
      content: "원인은 SSH 키 권한 문제입니다.",
      generationTrace: "검사 중입니다...",
    });
  });

  it("preserves streamed text that is cleared when a tool starts", async () => {
    const { slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "inspect it");
    const requestId = get().aiConversations["s1"].requestId as string;

    slice.handleAiChatEvent({
      requestId,
      type: "delta",
      delta: { kind: "text", text: "최근 로그를 먼저 확인합니다." },
    });
    slice.handleAiChatEvent({
      requestId,
      type: "tool",
      tool: { id: "tool-1", name: "inspect_command", status: "running", label: "journalctl" },
    });
    expect(get().aiConversations["s1"].streamingText).toBe("");
    expect(get().aiConversations["s1"].generationTrace).toBe("최근 로그를 먼저 확인합니다.");

    slice.handleAiChatEvent({
      requestId,
      type: "tool",
      tool: { id: "tool-1", name: "inspect_command", status: "done", label: "journalctl" },
    });
    slice.handleAiChatEvent({
      requestId,
      type: "done",
      result: { text: "로그상 서비스 재시작이 필요합니다.", finishReason: "stop" },
    });

    expect(get().aiConversations["s1"].messages.at(-1)).toEqual({
      role: "assistant",
      content: "로그상 서비스 재시작이 필요합니다.",
      toolRuns: [{ id: "tool-1", label: "journalctl", status: "done" }],
      generationTrace: "최근 로그를 먼저 확인합니다.",
    });
  });

  it("omits display-only generation trace when sending conversation history", async () => {
    const { api, slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "first");
    const requestId = get().aiConversations["s1"].requestId as string;

    slice.handleAiChatEvent({
      requestId,
      type: "delta",
      delta: { kind: "text", text: "중간 생성 내용" },
    });
    slice.handleAiChatEvent({
      requestId,
      type: "done",
      result: { text: "최종 답변", finishReason: "stop" },
    });

    await slice.sendAiMessage("s1", "second");
    const messages = api.ai.chat.mock.calls[1][0].request.messages;
    const assistantHistory = messages.find(
      (message: { role: string; content: string }) =>
        message.role === "assistant" && message.content === "최종 답변",
    );
    expect(assistantHistory).toEqual({ role: "assistant", content: "최종 답변" });
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

  it("sets pendingApproval on an approval-required event and clears it on done", async () => {
    const { slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "delete it");
    const requestId = get().aiConversations["s1"].requestId as string;

    slice.handleAiChatEvent({
      requestId,
      type: "approval-required",
      approval: { toolCallId: "tc1", command: "rm -rf /x", reason: "변경 가능성이 있는 명령" },
    });
    expect(get().aiConversations["s1"].pendingApproval).toEqual({
      toolCallId: "tc1",
      command: "rm -rf /x",
      reason: "변경 가능성이 있는 명령",
    });

    slice.handleAiChatEvent({ requestId, type: "done", result: { text: "ok", finishReason: "stop" } });
    expect(get().aiConversations["s1"].pendingApproval).toBeNull();
  });

  it("respondAiApproval forwards the decision and hides the card", async () => {
    const { api, slice, get } = harness(ENABLED);
    await slice.sendAiMessage("s1", "delete it");
    const requestId = get().aiConversations["s1"].requestId as string;
    slice.handleAiChatEvent({
      requestId,
      type: "approval-required",
      approval: { toolCallId: "tc1", command: "rm x", reason: "변경 가능성이 있는 명령" },
    });

    await slice.respondAiApproval("s1", "tc1", true, true);
    expect(api.ai.respondApproval).toHaveBeenCalledWith({
      requestId,
      toolCallId: "tc1",
      approved: true,
      remember: true,
    });
    expect(get().aiConversations["s1"].pendingApproval).toBeNull();
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
