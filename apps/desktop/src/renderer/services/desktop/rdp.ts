import type {
  RdpConnectedPayload,
  RdpAudioPayload,
  RdpFramePayload,
  RdpInputEvent,
  RdpLocalMonitor,
  RdpSessionEvent,
} from '@shared';
import { desktopApi } from '../desktopApi';

export function connectRdp(
  sessionId: string,
  hostId: string,
): Promise<RdpConnectedPayload> {
  return desktopApi.rdp.connect(sessionId, hostId);
}

export function disconnectRdp(sessionId: string): Promise<void> {
  return desktopApi.rdp.disconnect(sessionId);
}

export function sendRdpInput(sessionId: string, events: RdpInputEvent[]): void {
  desktopApi.rdp.sendInput(sessionId, events);
}

export function trustRdpCertificate(sessionId: string, accept: boolean): Promise<void> {
  return desktopApi.rdp.trustCertificate(sessionId, accept);
}

export function requestRdpResize(sessionId: string, width: number, height: number): void {
  desktopApi.rdp.requestResize(sessionId, width, height);
}

export function sendRdpClipboardText(sessionId: string, text: string): void {
  desktopApi.rdp.sendClipboardText(sessionId, text);
}

export function syncRdpClipboard(sessionId: string): void {
  desktopApi.rdp.syncClipboard(sessionId);
}

/**
 * 원격 화면이 키보드를 쥐었는지 메인에 알린다.
 *
 * 메인이 자기 단축키를 비켜 줘야 키가 캔버스까지 온다 — Win/Linux 의 before-input-event 는 렌더러
 * 도달 전이고, macOS 메뉴 accelerator 는 웹 페이지보다 먼저 매칭된다.
 */
export function setRdpKeyboardCapture(active: boolean): void {
  desktopApi.rdp.setKeyboardCapture(active);
}

export function subscribeRdpEvents(
  listener: (event: RdpSessionEvent) => void,
): () => void {
  return desktopApi.rdp.onEvent(listener);
}

export function pickRdpShareFolder(): Promise<string | null> {
  return desktopApi.rdp.pickShareFolder();
}

/** 이미 붙어 있는 세션의 접속 정보. 모니터별 창이 뒤늦게 붙을 때 쓴다. */
export function describeRdpSession(
  sessionId: string,
): Promise<RdpConnectedPayload | null> {
  return desktopApi.rdp.describeSession(sessionId);
}

/**
 * 지금 화면 전체를 한 번 더 보내게 한다.
 *
 * RDP 는 바뀐 부분만 보낸다. 세션 도중에 열린 창은 그때까지의 화면을 못 받아 정지한 영역이
 * 검은 채로 남는다 — 서버는 다시 보내주지 않는다. 창마다 정확히 한 번만 부를 것.
 */
export function requestRdpRefresh(sessionId: string): void {
  desktopApi.rdp.requestRefresh(sessionId);
}

/** 원격 모니터를 물리 화면마다 펼친다. */
export function spreadRdpMonitors(sessionId: string): Promise<number | null> {
  return desktopApi.rdp.spreadMonitors(sessionId);
}

/** 펼친 창을 접는다. */
export function collapseRdpMonitors(sessionId: string): Promise<void> {
  return desktopApi.rdp.collapseMonitors(sessionId);
}

/** 배치도에 그릴 로컬 디스플레이 목록. */
export function listRdpMonitors(): Promise<RdpLocalMonitor[]> {
  return desktopApi.rdp.listMonitors();
}

export function subscribeRdpAudio(
  sessionId: string,
  listener: (audio: RdpAudioPayload) => void,
): () => void {
  return desktopApi.rdp.onAudio(sessionId, listener);
}

export function subscribeRdpFrames(
  sessionId: string,
  listener: (frame: RdpFramePayload) => void,
): () => void {
  return desktopApi.rdp.onFrame(sessionId, listener);
}
