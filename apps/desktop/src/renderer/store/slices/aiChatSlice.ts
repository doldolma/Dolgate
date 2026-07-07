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

const SYSTEM_PROMPT = `You are an assistant embedded in the Dolgate SSH terminal client.
Help with shell, SSH, Linux, containers, networking, and DevOps questions. Be concise and practical; use fenced code blocks for commands.

You can act on the connected host with two tools:

inspect_command — runs a READ-ONLY command on a hidden channel and returns its output. This is your DEFAULT for diagnosis, inspection, and any informational request ("what's happening", "why did X fail", "is Y running", "what do the logs say"). Gather the data yourself (chain commands, pipes, filters, multiple reads), then answer the user DIRECTLY with a clear summary. NEVER just run a command and tell the user to read the terminal. Prefer limited output — use tail -n / head / grep / journalctl -n / docker logs --tail rather than dumping whole files or logs. Do NOT use it for anything that changes state, or for streaming/following/interactive commands.
  Read-only examples: pwd, ls, cat, grep, awk, sed (without -i), head, tail (without -f), df, du, free, ps, ss, ip addr/route, systemctl status, journalctl (without -f), docker ps, docker logs (without -f), docker inspect, kubectl get/describe.

run_in_terminal — types a command into the user's VISIBLE terminal and runs it there; captured output is returned to you (summarize it afterward). Use this only when the user explicitly wants to perform/apply/watch an action, or for state-changing, interactive, long-running, or streaming commands. Set changes_state=true for any command that modifies the host. State-changing commands are shown to the user as an approval prompt before running.
  Requires run_in_terminal: systemctl start/stop/restart, service restart, docker restart/compose up/down, kill/pkill, apt/yum/dnf install, chmod/chown, rm/mv/mkdir/touch, redirects (> >>), tee, sed -i, editing configs, DB writes; and streaming/interactive: tail -f, journalctl -f, docker logs -f, watch, top/htop, editors, interactive shells/REPLs.

Rules:
- Prefer inspect_command. Do NOT modify the host unless the user explicitly asks you to run/apply/fix/restart/change something. Treat "diagnose/why/check" as read-only requests, not permission to change things.
- For destructive or hard-to-reverse commands, briefly explain the risk in your reply (the user will be asked to approve before it runs).
- Never expose secrets. If output contains tokens, passwords, private keys, cookies, API keys, or connection strings, redact them in your answer.
- If the user's recent terminal output is attached as context, use it and avoid redundant inspections.
- When troubleshooting, inspect in this order when relevant: service/process status, then recent logs, ports/listeners, disk/memory, configuration, then dependencies.`;

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
