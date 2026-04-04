import type { SessionShareChatMessage, SessionShareState, TerminalTab } from "@shared";

export function createInactiveSessionShareState(): SessionShareState {
  return {
    status: "inactive",
    shareUrl: null,
    inputEnabled: false,
    viewerCount: 0,
    errorMessage: null,
  };
}

export function normalizeSessionShareState(
  state?: SessionShareState | null,
): SessionShareState {
  return state ?? createInactiveSessionShareState();
}

export function setSessionShareState(
  tabs: TerminalTab[],
  sessionId: string,
  nextState: SessionShareState,
): TerminalTab[] {
  return tabs.map((tab) =>
    tab.sessionId === sessionId
      ? {
          ...tab,
          sessionShare: nextState,
        }
      : tab,
  );
}

export function clearSessionShareChatNotifications(
  notifications: Record<string, SessionShareChatMessage[]>,
  sessionId: string,
): Record<string, SessionShareChatMessage[]> {
  if (!(sessionId in notifications)) {
    return notifications;
  }

  const next = { ...notifications };
  delete next[sessionId];
  return next;
}

export function appendSessionShareChatNotification(
  notifications: Record<string, SessionShareChatMessage[]>,
  sessionId: string,
  message: SessionShareChatMessage,
): Record<string, SessionShareChatMessage[]> {
  return {
    ...notifications,
    [sessionId]: [...(notifications[sessionId] ?? []), message],
  };
}

export function dismissSessionShareChatNotification(
  notifications: Record<string, SessionShareChatMessage[]>,
  sessionId: string,
  messageId: string,
): Record<string, SessionShareChatMessage[]> {
  const current = notifications[sessionId];
  if (!current) {
    return notifications;
  }

  const nextMessages = current.filter((message) => message.id !== messageId);
  if (nextMessages.length === current.length) {
    return notifications;
  }

  if (nextMessages.length === 0) {
    return clearSessionShareChatNotifications(notifications, sessionId);
  }

  return {
    ...notifications,
    [sessionId]: nextMessages,
  };
}
