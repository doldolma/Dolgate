import {
  getE2EBridge,
  isE2ETerminalCaptureEnabled,
  registerE2EWindowEvents,
} from "./events/state";

export function exposePreloadE2E(
  contextBridge: typeof import("electron").contextBridge,
): void {
  if (!isE2ETerminalCaptureEnabled()) {
    return;
  }

  registerE2EWindowEvents();
  contextBridge.exposeInMainWorld("__dolsshE2E", getE2EBridge());
}
