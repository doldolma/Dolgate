import type { AiChatMessage, AiChatRequest } from "@shared";
import type { AiChatSlice, AiConversation, AiToolRun, SliceDeps } from "../types";

// tool 이벤트를 현재 턴의 실행 목록에 반영한다(같은 id 는 상태 갱신, 없으면 추가).
function upsertToolRun(
  runs: AiToolRun[],
  tool: { id: string; label: string; status: "running" | "done" | "error" },
): AiToolRun[] {
  const next = runs.slice();
  const index = next.findIndex((run) => run.id === tool.id);
  const entry: AiToolRun = { id: tool.id, label: tool.label, status: tool.status };
  if (index >= 0) {
    next[index] = entry;
  } else {
    next.push(entry);
  }
  return next;
}

const DEFAULT_AI_PANEL_WIDTH = 380;
const MIN_AI_PANEL_WIDTH = 280;
const MAX_AI_PANEL_WIDTH = 760;

const SYSTEM_PROMPT =
  "You are an assistant embedded in the Dolgate SSH terminal client. " +
  "Help with shell, SSH, and DevOps questions. Be concise; use fenced code blocks for commands.\n\n" +
  "You can act on the connected host with two tools:\n" +
  "- inspect_command: run a READ-ONLY command on a hidden channel and get its output back. This is your DEFAULT " +
  "whenever the user wants to KNOW or diagnose something. Gather the data YOURSELF (chain/loop/pipe as needed), then " +
  "answer the user DIRECTLY with a clear summary of what you found. NEVER just run a command and tell the user to look " +
  "at their terminal — collect the information and report the answer yourself.\n" +
  "- run_in_terminal: type a command into the user's VISIBLE terminal and run it there. Use ONLY when the user wants to " +
  "perform or watch an action (start/stop/restart services, follow logs, interactive or long-running commands, apply a " +
  "change) or explicitly asks you to run it in their terminal. It also returns captured output — summarize that too.\n\n" +
  "Default to inspect_command for anything informational and answer directly. Change the host only via run_in_terminal " +
  "(the user approves state-changing commands). The user's recent terminal output may be attached as context — use it when relevant.";

function emptyConversation(): AiConversation {
  return {
    open: false,
    messages: [],
    requestId: null,
    streamingText: "",
    streaming: false,
    error: null,
    toolRuns: [],
    pendingApproval: null,
  };
}

function conversationFor(
  conversations: Record<string, AiConversation>,
  sessionId: string,
): AiConversation {
  return conversations[sessionId] ?? emptyConversation();
}

export function createAiChatSlice(deps: SliceDeps): AiChatSlice {
  const { api, set, get } = deps;

  function patch(sessionId: string, updater: (conv: AiConversation) => AiConversation): void {
    set((state) => ({
      aiConversations: {
        ...state.aiConversations,
        [sessionId]: updater(conversationFor(state.aiConversations, sessionId)),
      },
    }));
  }

  return {
    aiConversations: {},
    aiPanelWidth: DEFAULT_AI_PANEL_WIDTH,

    toggleAiPanel: (sessionId) => {
      patch(sessionId, (conv) => ({ ...conv, open: !conv.open }));
    },

    setAiPanelWidth: (width) => {
      const clamped = Math.min(
        MAX_AI_PANEL_WIDTH,
        Math.max(MIN_AI_PANEL_WIDTH, Math.round(width)),
      );
      set({ aiPanelWidth: clamped });
    },

    clearAiConversation: (sessionId) => {
      const conv = get().aiConversations[sessionId];
      if (conv?.requestId) {
        void api.ai.cancelChat(conv.requestId);
      }
      patch(sessionId, (current) => ({ ...emptyConversation(), open: current.open }));
    },

    cancelAiMessage: (sessionId) => {
      const conv = get().aiConversations[sessionId];
      if (conv?.requestId) {
        void api.ai.cancelChat(conv.requestId);
      }
    },

    sendAiMessage: async (sessionId, text, context) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const ai = get().settings.ai;
      if (!ai?.enabled) {
        patch(sessionId, (conv) => ({
          ...conv,
          error: {
            reason: "disabled",
            message: "AI 어시스턴트가 꺼져 있습니다. 설정 → AI에서 켜세요.",
          },
        }));
        return;
      }
      if (!ai.model) {
        patch(sessionId, (conv) => ({
          ...conv,
          error: { reason: "model-not-found", message: "설정 → AI에서 모델을 지정하세요." },
        }));
        return;
      }

      const conv = conversationFor(get().aiConversations, sessionId);
      if (conv.streaming) {
        return;
      }

      // 표시용 메시지는 사용자가 친 텍스트만. 터미널 컨텍스트는 요청에만 실어 트랜스크립트를 깔끔히.
      const userMessage: AiChatMessage = { role: "user", content: trimmed };
      const nextMessages = [...conv.messages, userMessage];
      const requestId = globalThis.crypto.randomUUID();

      set((state) => ({
        aiConversations: {
          ...state.aiConversations,
          [sessionId]: {
            ...conversationFor(state.aiConversations, sessionId),
            messages: nextMessages,
            requestId,
            streamingText: "",
            streaming: true,
            error: null,
            toolRuns: [],
            pendingApproval: null,
          },
        },
      }));

      const contextMessages: AiChatMessage[] =
        context && context.trim()
          ? [{ role: "user", content: `현재 터미널 최근 출력:\n\`\`\`\n${context}\n\`\`\`` }]
          : [];
      const request: AiChatRequest = {
        model: ai.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...conv.messages,
          ...contextMessages,
          userMessage,
        ],
        temperature: ai.temperature,
      };

      try {
        await api.ai.chat({ requestId, sessionId, request });
      } catch (error) {
        patch(sessionId, (current) =>
          current.requestId === requestId
            ? {
                ...current,
                streaming: false,
                requestId: null,
                error: {
                  reason: "network",
                  message: error instanceof Error ? error.message : "요청에 실패했습니다.",
                },
              }
            : current,
        );
      }
    },

    handleAiChatEvent: (event) => {
      set((state) => {
        const entry = Object.entries(state.aiConversations).find(
          ([, conv]) => conv.requestId === event.requestId,
        );
        if (!entry) {
          return state;
        }
        const [sessionId, conv] = entry;

        if (event.type === "delta") {
          if (event.delta.kind !== "text") {
            return state;
          }
          return {
            aiConversations: {
              ...state.aiConversations,
              [sessionId]: { ...conv, streamingText: conv.streamingText + event.delta.text },
            },
          };
        }

        if (event.type === "tool") {
          // 도구가 시작되면 그 직전까지 스트리밍된 "중간 사고" 텍스트는 지운다.
          // (여러 번 도구를 부르는 동안 반복적 사고가 벽처럼 쌓이는 것 방지 — 최종 답만 남긴다.)
          const clearStreaming = event.tool.status === "running";
          return {
            aiConversations: {
              ...state.aiConversations,
              [sessionId]: {
                ...conv,
                toolRuns: upsertToolRun(conv.toolRuns, event.tool),
                ...(clearStreaming ? { streamingText: "" } : {}),
              },
            },
          };
        }

        if (event.type === "approval-required") {
          return {
            aiConversations: {
              ...state.aiConversations,
              [sessionId]: {
                ...conv,
                pendingApproval: {
                  toolCallId: event.approval.toolCallId,
                  command: event.approval.command,
                  reason: event.approval.reason,
                },
              },
            },
          };
        }

        if (event.type === "done") {
          const finalText = conv.streamingText || event.result.text;
          const runs = conv.toolRuns;
          const messages = finalText
            ? [
                ...conv.messages,
                {
                  role: "assistant" as const,
                  content: finalText,
                  ...(runs.length ? { toolRuns: runs } : {}),
                },
              ]
            : conv.messages;
          return {
            aiConversations: {
              ...state.aiConversations,
              [sessionId]: {
                ...conv,
                messages,
                requestId: null,
                streaming: false,
                streamingText: "",
                toolRuns: [],
                pendingApproval: null,
              },
            },
          };
        }

        // event.type === "error"
        return {
          aiConversations: {
            ...state.aiConversations,
            [sessionId]: {
              ...conv,
              requestId: null,
              streaming: false,
              streamingText: "",
              error: event.error,
              toolRuns: [],
              pendingApproval: null,
            },
          },
        };
      });
    },

    respondAiApproval: async (sessionId, toolCallId, approved, remember) => {
      const conv = get().aiConversations[sessionId];
      const requestId = conv?.requestId;
      if (!requestId) {
        return;
      }
      // 사용자가 응답했으니 카드는 즉시 감춘다(실행 상태는 이어지는 tool 이벤트로 표시).
      patch(sessionId, (current) => ({ ...current, pendingApproval: null }));
      await api.ai.respondApproval({ requestId, toolCallId, approved, remember });
    },
  };
}
