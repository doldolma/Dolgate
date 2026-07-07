import { ipcMain } from "electron";

import { ipcChannels } from "../../common/ipc-channels";
import type {
  AiApiKeyStatus,
  AiChatEvent,
  AiChatStartInput,
  AiProviderId,
  AiTestConnectionInput,
  AiTestResult,
} from "../../shared/ai";
import type { MainIpcContext } from "./context";

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
      ctx.aiService.startChat(input, emit);
      return { requestId: input.requestId };
    },
  );

  ipcMain.handle(
    ipcChannels.ai.cancelChat,
    async (_event, requestId: string): Promise<void> => {
      ctx.aiService.cancelChat(requestId);
    },
  );
}
