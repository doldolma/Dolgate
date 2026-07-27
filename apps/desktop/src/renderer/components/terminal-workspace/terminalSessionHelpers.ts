import type {
  SessionShareChatMessage,
  SessionShareSnapshotInput,
  TerminalTab,
} from '@shared';
import { resolveConnectionFailurePresentation } from '../../store/utils';
import { getFormatLocale, t } from '../../i18n';

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
    return tab.errorMessage
      ? resolveConnectionFailurePresentation(tab.errorMessage).title
      : 'Connection Failed';
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

  if (tab.connectionProgress?.stage === 'reconnecting') {
    return 'Reconnecting';
  }

  if (tab.status === 'connected') {
    return 'Connected';
  }

  return 'Connecting';
}

export function resolveConnectionOverlayMessage(
  tab: TerminalTab | undefined,
): string {
  if (
    tab?.status === 'error' &&
    tab.connectionProgress?.message &&
    tab.connectionProgress.blockingKind !== 'none'
  ) {
    return tab.connectionProgress.message;
  }

  if (tab?.status === 'error' && tab.errorMessage) {
    return resolveConnectionFailurePresentation(tab.errorMessage).message;
  }

  if (tab?.connectionProgress?.message) {
    return tab.connectionProgress.message;
  }

  if (tab?.status === 'connected') {
    return t('sessionHelpers.waitingFirstOutput');
  }

  if (tab?.status === 'error') {
    return tab.errorMessage ?? t('sessionHelpers.connectFailed');
  }

  return t('sessionHelpers.connecting');
}

export function formatSessionShareChatTimestamp(sentAt: string): string {
  const timestamp = new Date(sentAt);
  if (Number.isNaN(timestamp.getTime())) {
    return '';
  }

  return timestamp.toLocaleTimeString(getFormatLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isPendingConnectionSessionId(sessionId: string): boolean {
  return sessionId.startsWith('pending:');
}
