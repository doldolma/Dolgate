import type { IpcRenderer } from "electron";

/**
 * 볼트를 골라 읽는 목록(설정의 AWS Profiles·Tailscale·Saved Credentials·known hosts). 볼트를 고르지 않았으면
 * 인자 없이 보낸다 — 개인 볼트를 읽는 지금까지의 호출 모양을 그대로 둔다.
 */
export function invokeVaultList<T>(
  ipcRenderer: IpcRenderer,
  channel: string,
  vaultId?: string | null,
): Promise<T> {
  return vaultId ? ipcRenderer.invoke(channel, vaultId) : ipcRenderer.invoke(channel);
}
