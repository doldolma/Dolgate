import type {
  VncConnectedPayload,
  VncFramePayload,
  VncInputEvent,
  VncSessionEvent,
} from '@shared';

import { desktopApi } from '../desktopApi';

// RDP 서비스와 같은 자리·같은 모양이다(services/desktop/rdp.ts). 렌더러가 IPC 채널 이름을 직접
// 알지 않게 하는 얇은 층이다.

export function connectVnc(
  sessionId: string,
  hostId: string,
): Promise<VncConnectedPayload> {
  return desktopApi.vnc.connect(sessionId, hostId);
}

export function disconnectVnc(sessionId: string): Promise<void> {
  return desktopApi.vnc.disconnect(sessionId);
}

export function sendVncInput(sessionId: string, events: VncInputEvent[]): void {
  desktopApi.vnc.sendInput(sessionId, events);
}

export function describeVncSession(
  sessionId: string,
): Promise<VncConnectedPayload | null> {
  return desktopApi.vnc.describeSession(sessionId);
}

export function subscribeVncEvents(
  listener: (event: VncSessionEvent) => void,
): () => void {
  return desktopApi.vnc.onEvent(listener);
}

/** 픽셀은 store 를 거치지 않고 캔버스로 직결한다(RDP 와 같은 이유). */
export function subscribeVncFrames(
  sessionId: string,
  listener: (frame: VncFramePayload) => void,
): () => void {
  return desktopApi.vnc.onFrame(sessionId, listener);
}
