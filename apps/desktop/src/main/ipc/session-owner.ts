import type { IpcMainInvokeEvent } from "electron";
import type { MainIpcContext } from "./context";

export function runWithIpcSessionOwner<T>(
  ctx: MainIpcContext,
  event: IpcMainInvokeEvent | null,
  action: () => Promise<T>,
): Promise<T> {
  const ownerWebContentsId = event?.sender?.id;
  if (
    ownerWebContentsId === undefined ||
    typeof ctx.coreManager.runWithSessionOwner !== "function"
  ) {
    return action();
  }
  return ctx.coreManager.runWithSessionOwner(ownerWebContentsId, action);
}
