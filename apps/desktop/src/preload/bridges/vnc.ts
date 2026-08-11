import type { IpcRenderer } from "electron";
import type {
  VncConnectedPayload,
  VncFramePayload,
  VncInputEvent,
  VncSessionEvent,
} from "@shared";

import { ipcChannels } from "../../common/ipc-channels";
import { subscribeVncEvent, subscribeVncFrame } from "../events/state";

// RDP 브리지와 같은 모양이되 RFB 에 없는 것들이 빠져 있다 — 오디오·클립보드 동기화·모니터 배치·
// 인증서 프롬프트가 없다(인증서는 VeNCrypt X509 를 쓸 때만 생기고, 그때 붙인다).

export interface VncBridge {
  connect: (sessionId: string, hostId: string) => Promise<VncConnectedPayload>;
  disconnect: (sessionId: string) => Promise<void>;
  sendInput: (sessionId: string, events: VncInputEvent[]) => void;
  /** 이미 붙어 있는 세션의 화면 크기. 뒤늦게 붙는 캔버스가 쓴다. */
  describeSession: (sessionId: string) => Promise<VncConnectedPayload | null>;
  onEvent: (listener: (event: VncSessionEvent) => void) => () => void;
  /** 픽셀은 store 를 거치지 않고 캔버스로 직결한다(ssh.data·rdp.frame 과 같은 이유). */
  onFrame: (
    sessionId: string,
    listener: (frame: VncFramePayload) => void,
  ) => () => void;
}

export function buildVncBridge(ipcRenderer: IpcRenderer): VncBridge {
  return {
    connect: (sessionId, hostId) =>
      ipcRenderer.invoke(ipcChannels.vnc.connect, sessionId, hostId),
    disconnect: (sessionId) =>
      ipcRenderer.invoke(ipcChannels.vnc.disconnect, sessionId),
    sendInput: (sessionId, events) =>
      ipcRenderer.send(ipcChannels.vnc.input, sessionId, events),
    describeSession: (sessionId) =>
      ipcRenderer.invoke(ipcChannels.vnc.describeSession, sessionId),
    onEvent: (listener) => subscribeVncEvent(listener),
    onFrame: (sessionId, listener) => subscribeVncFrame(sessionId, listener),
  };
}
