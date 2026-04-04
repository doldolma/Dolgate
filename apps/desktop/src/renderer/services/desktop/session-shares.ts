import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';

type SessionSharesApi = DesktopApi['sessionShares'];

export function getOwnerChatSnapshot(sessionId: string) {
  return desktopApi.sessionShares.getOwnerChatSnapshot(sessionId);
}

export function onSessionShareEvent(listener: Parameters<SessionSharesApi['onEvent']>[0]) {
  return desktopApi.sessionShares.onEvent(listener);
}

export function onSessionShareChatEvent(listener: Parameters<SessionSharesApi['onChatEvent']>[0]) {
  return desktopApi.sessionShares.onChatEvent(listener);
}

export function sendOwnerChatMessage(sessionId: string, message: string) {
  return desktopApi.sessionShares.sendOwnerChatMessage(sessionId, message);
}

export function openOwnerChatWindow(sessionId: string) {
  return desktopApi.sessionShares.openOwnerChatWindow(sessionId);
}
