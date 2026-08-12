import type {
  VncConnectedPayload,
  VncCursorPayload,
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

/**
 * 지금 로컬 클립보드를 원격에 올려 달라고 메인에 알린다.
 *
 * 값을 렌더러가 읽지 않는다 — 클립보드 소유자를 메인 하나로 두면 원격에서 온 값이 다시 원격으로
 * 되돌아가는 왕복이 생기지 않는다(RDP 와 같은 규칙).
 */
export function syncVncClipboard(sessionId: string): void {
  desktopApi.vnc.syncClipboard(sessionId);
}

/**
 * 창 크기에 맞춰 원격 화면 크기를 요청한다.
 *
 * 서버가 `ExtendedDesktopSize` 를 쓰지 않으면 코어가 조용히 버린다 — 크기를 못 바꾸는 서버가
 * 정상적으로 존재한다(실제 화면을 미러링하는 x11vnc 등).
 */
export function requestVncDesktopSize(
  sessionId: string,
  width: number,
  height: number,
): void {
  desktopApi.vnc.requestDesktopSize(sessionId, width, height);
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

/**
 * 화면 전체를 다시 받는다.
 *
 * 캔버스는 크기가 바뀌면 내용이 지워진다. 그 리사이즈는 프레임 도착과 순서가 보장되지 않아(React
 * 상태를 거친다) 그 사이에 온 프레임이 버려지는데, 서버는 정적인 영역을 다시 보내지 않는다 —
 * 화면 위쪽이 검게 남던 원인이다. 잃은 쪽이 다시 달라고 해야 한다.
 */
export function refreshVncScreen(sessionId: string): void {
  desktopApi.vnc.refreshScreen(sessionId);
}

/** 커서 모양. 서버가 커서를 화면에 그려 주지 않으므로 이걸 받아 우리가 그린다. */
export function subscribeVncCursor(
  sessionId: string,
  listener: (cursor: VncCursorPayload) => void,
): () => void {
  return desktopApi.vnc.onCursor(sessionId, listener);
}
