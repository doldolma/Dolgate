import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./api";
import { registerPreloadEventBindings } from "./events/register";
import { exposePreloadE2E } from "./e2e";

registerPreloadEventBindings(ipcRenderer);

// preload는 renderer에 필요한 최소 기능만 안전하게 노출하는 보안 경계다.
contextBridge.exposeInMainWorld("dolssh", createDesktopApi(ipcRenderer));
exposePreloadE2E(contextBridge);
