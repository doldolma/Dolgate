import type { IpcRenderer } from "electron";
import type {
  VncConnectedPayload,
  VncCursorPayload,
  VncFramePayload,
  VncInputEvent,
  VncSessionEvent,
} from "@shared";

import { ipcChannels } from "../../common/ipc-channels";
import {
  subscribeVncCursor,
  subscribeVncEvent,
  subscribeVncFrame,
} from "../events/state";

// RDP 브리지와 같은 모양이되 RFB 에 없는 것들이 빠져 있다 — 오디오·클립보드 동기화·모니터 배치·
// 인증서 프롬프트가 없다(인증서는 VeNCrypt X509 를 쓸 때만 생기고, 그때 붙인다).

export interface VncBridge {
  connect: (sessionId: string, hostId: string) => Promise<VncConnectedPayload>;
  disconnect: (sessionId: string) => Promise<void>;
  sendInput: (sessionId: string, events: VncInputEvent[]) => void;
  /** 지금 로컬 클립보드를 원격에 올려 달라. 값은 메인이 읽는다(클립보드 소유자는 하나여야 한다). */
  syncClipboard: (sessionId: string) => void;
  /** 창 크기에 맞춰 원격 화면 크기를 요청한다. 서버가 지원하지 않으면 코어가 버린다. */
  requestDesktopSize: (sessionId: string, width: number, height: number) => void;
  /** 화면 전체를 다시 받는다. 캔버스가 그림을 잃었을 때 쓴다. */
  refreshScreen: (sessionId: string) => void;
  /** 이미 붙어 있는 세션의 화면 크기. 뒤늦게 붙는 캔버스가 쓴다. */
  describeSession: (sessionId: string) => Promise<VncConnectedPayload | null>;
  onEvent: (listener: (event: VncSessionEvent) => void) => () => void;
  /** 픽셀은 store 를 거치지 않고 캔버스로 직결한다(ssh.data·rdp.frame 과 같은 이유). */
  onFrame: (
    sessionId: string,
    listener: (frame: VncFramePayload) => void,
  ) => () => void;
  /**
   * 서버가 보낸 커서 모양.
   *
   * 코어가 커서 의사 인코딩을 선언했으면 서버는 커서를 화면에 그려 주지 않는다 — 이걸 그리지 않으면
   * 원격 커서가 아예 보이지 않는다.
   */
  onCursor: (
    sessionId: string,
    listener: (cursor: VncCursorPayload) => void,
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
    syncClipboard: (sessionId: string) =>
      ipcRenderer.send(ipcChannels.vnc.syncClipboard, sessionId),
    requestDesktopSize: (sessionId, width, height) =>
      ipcRenderer.send(ipcChannels.vnc.setDesktopSize, sessionId, width, height),
    refreshScreen: (sessionId) => ipcRenderer.send(ipcChannels.vnc.refresh, sessionId),
    describeSession: (sessionId) =>
      ipcRenderer.invoke(ipcChannels.vnc.describeSession, sessionId),
    onEvent: (listener) => subscribeVncEvent(listener),
    onFrame: (sessionId, listener) => subscribeVncFrame(sessionId, listener),
    onCursor: (sessionId, listener) => subscribeVncCursor(sessionId, listener),
  };
}
