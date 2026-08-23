import { createStore } from "zustand/vanilla";
import type { DesktopApi } from "@shared";
import { createAiChatSlice } from "./slices/aiChatSlice";
import { createCatalogSlice } from "./slices/catalogSlice";
import { createContainersSlice } from "./slices/containersSlice";
import { createNetworkSlice } from "./slices/networkSlice";
import { createRuntimeEventSlice } from "./slices/runtimeEventSlice";
import { createSessionPanelSlice } from "./slices/sessionPanelSlice";
import { createSessionSlice } from "./slices/sessionSlice";
import { createSettingsSlice } from "./slices/settingsSlice";
import { createSftpSlice } from "./slices/sftpSlice";
import { createZmodemSlice } from "./slices/zmodemSlice";
import { upsertTransferJob } from "./services/sftp";
import type { AppState } from "./types";

export * from "./types";
export { upsertTransferJob };

export function createAppStore(api: DesktopApi) {
  return createStore<AppState>((set, get) => {
    const deps = { api, set, get };
    return {
      ...createCatalogSlice(deps),
      ...createSessionSlice(deps),
      ...createContainersSlice(deps),
      ...createSftpSlice(deps),
      ...createNetworkSlice(deps),
      ...createSettingsSlice(deps),
      ...createRuntimeEventSlice(deps),
      ...createZmodemSlice(deps),
      ...createAiChatSlice(deps),
      ...createSessionPanelSlice(deps),
    };
  });
}
