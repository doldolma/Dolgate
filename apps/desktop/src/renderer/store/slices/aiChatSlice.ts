import type { AiChatMessage, AiChatRequest } from "@shared";
import type { AiChatSlice, AiConversation, SliceDeps } from "../types";

const DEFAULT_AI_PANEL_WIDTH = 380;
const MIN_AI_PANEL_WIDTH = 280;
const MAX_AI_PANEL_WIDTH = 760;

// 읽기전용 어시스턴트 system 프롬프트(도구·실행 없음 — Phase 2).
const SYSTEM_PROMPT =
  "You are an assistant embedded in the Dolgate SSH terminal client. " +
  "Help with shell, SSH, and DevOps questions. Be concise and use fenced code blocks for commands. " +
  "You cannot execute commands or access the machine directly. " +
  "The user may include their recent terminal output as context — use it when relevant.";

function emptyConversation(): AiConversation {
  return {
    open: false,
    messages: [],
    requestId: null,
    streamingText: "",
    streaming: false,
    error: null,
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
        await api.ai.chat({ requestId, request });
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

        if (event.type === "done") {
          const finalText = conv.streamingText || event.result.text;
          const messages: AiChatMessage[] = finalText
            ? [...conv.messages, { role: "assistant", content: finalText }]
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
            },
          },
        };
      });
    },
  };
}
