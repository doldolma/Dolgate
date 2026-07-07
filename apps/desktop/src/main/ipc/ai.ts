import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";

import { ipcChannels } from "../../common/ipc-channels";
import type { TerminalOutputReadInput } from "../ai/tools/read-terminal-output";
import type {
  AiApiKeyStatus,
  AiApprovalResponse,
  AiChatEvent,
  AiChatStartInput,
  AiTerminalOutputResponse,
  AiProviderId,
  AiSearchBackend,
  AiTestConnectionInput,
  AiTestResult,
} from "../../shared/ai";
import type { MainIpcContext } from "./context";

const TERMINAL_OUTPUT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingTerminalOutputRequest {
  senderId: number;
  resolve: (response: AiTerminalOutputResponse) => void;
  cleanup: () => void;
}

const pendingTerminalOutputRequests = new Map<string, PendingTerminalOutputRequest>();

function senderId(sender: WebContents): number {
  return sender.id;
}

function failedTerminalOutputResponse(
  clientRequestId: string,
  error: string,
): AiTerminalOutputResponse {
  return { clientRequestId, error };
}

function requestTerminalOutputFromRenderer({
  sender,
  requestId,
  snapshotId,
  input,
  signal,
}: {
  sender: WebContents;
  requestId: string;
  snapshotId: string;
  input: TerminalOutputReadInput;
  signal: AbortSignal;
}): Promise<AiTerminalOutputResponse> {
  const clientRequestId = randomUUID();
  if (sender.isDestroyed()) {
    return Promise.resolve(failedTerminalOutputResponse(clientRequestId, "renderer is destroyed"));
  }
  if (signal.aborted) {
    return Promise.resolve(failedTerminalOutputResponse(clientRequestId, "terminal output request aborted"));
  }

  return new Promise<AiTerminalOutputResponse>((resolve) => {
    let settled = false;
    const complete = (response: AiTerminalOutputResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      const pending = pendingTerminalOutputRequests.get(clientRequestId);
      pending?.cleanup();
      pendingTerminalOutputRequests.delete(clientRequestId);
      resolve(response);
    };
    const timeout = setTimeout(() => {
      complete(failedTerminalOutputResponse(clientRequestId, "terminal output request timed out"));
    }, TERMINAL_OUTPUT_REQUEST_TIMEOUT_MS);
    const onAbort = () => {
      complete(failedTerminalOutputResponse(clientRequestId, "terminal output request aborted"));
    };
    const onDestroyed = () => {
      complete(failedTerminalOutputResponse(clientRequestId, "renderer is destroyed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sender.once?.("destroyed", onDestroyed);

    pendingTerminalOutputRequests.set(clientRequestId, {
      senderId: senderId(sender),
      resolve: complete,
      cleanup: () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        sender.off?.("destroyed", onDestroyed);
      },
    });

    try {
      sender.send(ipcChannels.ai.terminalOutputRequest, {
        requestId,
        clientRequestId,
        snapshotId,
        beforeRecentLines: input.beforeRecentLines,
        lines: input.lines,
      });
    } catch (error) {
      complete(
        failedTerminalOutputResponse(
          clientRequestId,
          error instanceof Error ? error.message : "failed to request terminal output",
        ),
      );
    }
  });
}

export function registerAiIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.ai.testConnection,
    async (_event, input: AiTestConnectionInput): Promise<AiTestResult> =>
      ctx.aiService.testConnection(input),
  );

  ipcMain.handle(
    ipcChannels.ai.apiKeyStatus,
    async (_event, providerId: AiProviderId): Promise<AiApiKeyStatus> =>
      ctx.aiService.apiKeyStatus(providerId),
  );

  ipcMain.handle(
    ipcChannels.ai.setApiKey,
    async (_event, providerId: AiProviderId, key: string): Promise<AiApiKeyStatus> =>
      ctx.aiService.setApiKey(providerId, key),
  );

  ipcMain.handle(
    ipcChannels.ai.clearApiKey,
    async (_event, providerId: AiProviderId): Promise<AiApiKeyStatus> =>
      ctx.aiService.clearApiKey(providerId),
  );

  ipcMain.handle(
    ipcChannels.ai.searchKeyStatus,
    async (_event, backend: AiSearchBackend): Promise<AiApiKeyStatus> =>
      ctx.aiService.searchKeyStatus(backend),
  );

  ipcMain.handle(
    ipcChannels.ai.setSearchKey,
    async (_event, backend: AiSearchBackend, key: string): Promise<AiApiKeyStatus> =>
      ctx.aiService.setSearchKey(backend, key),
  );

  ipcMain.handle(
    ipcChannels.ai.clearSearchKey,
    async (_event, backend: AiSearchBackend): Promise<AiApiKeyStatus> =>
      ctx.aiService.clearSearchKey(backend),
  );

  // Codex 인증 — URL 은 렌더러가 openExternalUrl 로 연다(브라우저 열기는 렌더러 경계 규칙 준수).
  ipcMain.handle(ipcChannels.ai.codexLoginStart, async () => ctx.aiService.codexLoginStart());
  ipcMain.handle(ipcChannels.ai.codexAuthStatus, async () => ctx.aiService.codexAuthStatus());
  ipcMain.handle(ipcChannels.ai.codexLogout, async () => ctx.aiService.codexLogout());
  ipcMain.handle(ipcChannels.ai.codexUsage, async () => ctx.aiService.codexUsage());

  // chat 은 invoke 로 시작해 { requestId } 를 즉시 반환하고, 이후 delta/done/error 는
  // ai:chat-event 로 초기 요청 window(event.sender)에 스트리밍한다.
  ipcMain.handle(
    ipcChannels.ai.chat,
    async (event, input: AiChatStartInput): Promise<{ requestId: string }> => {
      const sender = event.sender;
      const emit = (payload: AiChatEvent) => {
        if (!sender.isDestroyed()) {
          sender.send(ipcChannels.ai.chatEvent, payload);
        }
      };
      const clientTools = input.terminalSnapshot
        ? {
            readTerminalOutput: (readInput: TerminalOutputReadInput, signal: AbortSignal) =>
              requestTerminalOutputFromRenderer({
                sender,
                requestId: input.requestId,
                snapshotId: input.terminalSnapshot!.snapshotId,
                input: readInput,
                signal,
              }),
          }
        : undefined;
      ctx.aiService.startChat(input, emit, clientTools);
      return { requestId: input.requestId };
    },
  );

  ipcMain.handle(
    ipcChannels.ai.cancelChat,
    async (_event, requestId: string): Promise<void> => {
      ctx.aiService.cancelChat(requestId);
    },
  );

  ipcMain.handle(
    ipcChannels.ai.respondApproval,
    async (_event, input: AiApprovalResponse): Promise<void> => {
      ctx.aiService.resolveApproval(input);
    },
  );

  ipcMain.handle(
    ipcChannels.ai.terminalOutputResponse,
    async (event, input: AiTerminalOutputResponse): Promise<void> => {
      const pending = pendingTerminalOutputRequests.get(input.clientRequestId);
      if (!pending || pending.senderId !== senderId(event.sender)) {
        return;
      }
      pending.resolve(input);
    },
  );
}
