import type {
  SessionShareChatMessage,
  SessionShareSnapshotInput,
  TerminalTab,
} from '@shared';

export const SESSION_SHARE_CHAT_TOAST_LIMIT = 3;
export const SESSION_SHARE_CHAT_TOAST_TTL_MS = 8000;

export function shouldOpenTerminalSearch(input: {
  active: boolean;
  visible: boolean;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return (
    input.active &&
    input.visible &&
    (input.metaKey || input.ctrlKey) &&
    input.key.toLowerCase() === 'f'
  );
}

export function didTerminalSessionJustConnect(
  previousStatus: TerminalTab['status'] | null | undefined,
  nextStatus: TerminalTab['status'] | null | undefined,
): boolean {
  return previousStatus !== 'connected' && nextStatus === 'connected';
}

export function resolveTerminalRuntimeWebglEnabled(input: {
  isMac: boolean;
  terminalWebglEnabled: boolean;
  sessionSource: TerminalTab['source'] | null | undefined;
  shareStatus: string | null | undefined;
}): boolean {
  if (
    input.isMac &&
    input.sessionSource === 'host' &&
    input.shareStatus === 'active'
  ) {
    return false;
  }

  return input.terminalWebglEnabled;
}

export function mergeSessionShareSnapshotKinds(
  currentKind: SessionShareSnapshotInput['kind'] | null,
  nextKind: SessionShareSnapshotInput['kind'],
): SessionShareSnapshotInput['kind'] {
  if (currentKind === 'resync' || nextKind === 'resync') {
    return 'resync';
  }

  return 'refresh';
}

export function getVisibleSessionShareChatNotifications(
  notifications: SessionShareChatMessage[],
): SessionShareChatMessage[] {
  if (notifications.length <= SESSION_SHARE_CHAT_TOAST_LIMIT) {
    return notifications;
  }

  return notifications.slice(-SESSION_SHARE_CHAT_TOAST_LIMIT);
}

export function shouldShowSessionOverlay(
  tab: TerminalTab | undefined,
  terminalInitError: string | null,
): boolean {
  if (!tab || terminalInitError) {
    return false;
  }

  if (
    tab.status === 'pending' ||
    tab.status === 'connecting' ||
    tab.status === 'error'
  ) {
    return true;
  }

  if (tab.status === 'connected' && tab.shellKind === 'aws-ecs-exec') {
    return false;
  }

  return tab.status === 'connected' && !tab.hasReceivedOutput;
}

export function resolveConnectionOverlayTitle(
  tab: TerminalTab | undefined,
): string {
  if (!tab) {
    return 'Connecting';
  }

  if (tab.status === 'error') {
    return 'Connection Failed';
  }

  if (tab.connectionProgress?.blockingKind === 'browser') {
    return 'Continue in Browser';
  }

  if (
    tab.connectionProgress?.blockingKind === 'dialog' ||
    tab.connectionProgress?.blockingKind === 'panel'
  ) {
    return 'Action Required';
  }

  if (tab.status === 'connected') {
    return 'Connected';
  }

  return 'Connecting';
}

export function resolveConnectionOverlayMessage(
  tab: TerminalTab | undefined,
): string {
  if (tab?.connectionProgress?.message) {
    return tab.connectionProgress.message;
  }

  if (tab?.status === 'connected') {
    return '원격 셸이 첫 출력을 보내는 중입니다...';
  }

  if (tab?.status === 'error') {
    return tab.errorMessage ?? '세션 연결에 실패했습니다.';
  }

  return '세션을 연결하는 중입니다...';
}

export function formatSessionShareChatTimestamp(sentAt: string): string {
  const timestamp = new Date(sentAt);
  if (Number.isNaN(timestamp.getTime())) {
    return '';
  }

  return timestamp.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isPendingConnectionSessionId(sessionId: string): boolean {
  return sessionId.startsWith('pending:');
}
