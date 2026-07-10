import type { IpcRenderer } from "electron";
import type { DesktopApi } from "@shared";

import { ipcChannels } from "../../common/ipc-channels";
import { subscribeAiChatEvent, subscribeAiTerminalOutputRequest } from "../events/state";

export function buildAiBridge(ipcRenderer: IpcRenderer): DesktopApi["ai"] {
  return {
    testConnection: (input) => ipcRenderer.invoke(ipcChannels.ai.testConnection, input),
    apiKeyStatus: (providerId) =>
      ipcRenderer.invoke(ipcChannels.ai.apiKeyStatus, providerId),
    setApiKey: (providerId, key) =>
      ipcRenderer.invoke(ipcChannels.ai.setApiKey, providerId, key),
    clearApiKey: (providerId) =>
      ipcRenderer.invoke(ipcChannels.ai.clearApiKey, providerId),
    searchKeyStatus: (backend) =>
      ipcRenderer.invoke(ipcChannels.ai.searchKeyStatus, backend),
    setSearchKey: (backend, key) =>
      ipcRenderer.invoke(ipcChannels.ai.setSearchKey, backend, key),
    clearSearchKey: (backend) =>
      ipcRenderer.invoke(ipcChannels.ai.clearSearchKey, backend),
    chat: (input) => ipcRenderer.invoke(ipcChannels.ai.chat, input),
    cancelChat: (requestId) => ipcRenderer.invoke(ipcChannels.ai.cancelChat, requestId),
    respondApproval: (input) => ipcRenderer.invoke(ipcChannels.ai.respondApproval, input),
    respondTerminalOutput: (input) =>
      ipcRenderer.invoke(ipcChannels.ai.terminalOutputResponse, input),
    codexLoginStart: () => ipcRenderer.invoke(ipcChannels.ai.codexLoginStart),
    codexAuthStatus: () => ipcRenderer.invoke(ipcChannels.ai.codexAuthStatus),
    codexLogout: () => ipcRenderer.invoke(ipcChannels.ai.codexLogout),
    codexUsage: () => ipcRenderer.invoke(ipcChannels.ai.codexUsage),
    codexModels: () => ipcRenderer.invoke(ipcChannels.ai.codexModels),
    // main→renderer 스트리밍 이벤트 구독(해제 함수 반환). requestId 로 필터링은 소비자(2단계) 몫.
    onChatEvent: (listener) => subscribeAiChatEvent(listener),
    onTerminalOutputRequest: (listener) => subscribeAiTerminalOutputRequest(listener),
  };
}
