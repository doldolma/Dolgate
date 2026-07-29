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
  // 실패했는데도 진행 문구를 남기는 경우가 있다 — 자격증명 재확인처럼 그 화면에서 계속 사람을
  // 기다리는 프롬프트는 그 문구가 사용자가 할 일이다.
  //
  // 브라우저 대기는 다르다. 실패했다는 것은 그 기다림이 끝났다는 뜻이라, 문구를 남기면 "브라우저
  // 에서 로그인을 마쳐 주세요" 라고 하면서 실패로 앉아 있는 화면이 된다 — 실패 이유를 덮어버려서
  // 무엇이 잘못됐는지 알 수 없다.
  if (
    tab?.status === 'error' &&
    tab.connectionProgress?.message &&
    (tab.connectionProgress.blockingKind === 'dialog' ||
      tab.connectionProgress.blockingKind === 'panel')
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

export interface TailnetFailureGuidance {
  message: string;
  /**
   * 그 자리에서 낼 수 있는 복구 동작.
   *
   * 'login' 은 컨트롤 플레인에 등록을 다시 확인시키고 필요하면 브라우저 로그인까지 가는 것이다.
   * auth key 경로에는 다시 할 로그인이 없어서 'none' 이다 — 키가 죽었다면 눌러서 될 일이 아니라
   * 새 키가 필요하다.
   */
  recovery: 'login' | 'none';
}

/**
 * 등록이 만료돼서 못 붙은 실패를 어떻게 말할지.
 *
 * 만료는 Tailscale 계층이 판정해서 알려 준 것만 여기 온다 — 대상까지 못 닿았다는 사실로 만료를
 * 추측하지 않는다. 그러면 멀쩡한 등록을 다시 로그인하라고 권하게 된다.
 *
 * usesAuthKey 가 null 이면(설정을 아직 못 읽음) 브라우저 경로로 떨어진다. 그쪽이 기본이다.
 */
export function resolveTailnetFailureGuidance(
  usesAuthKey: boolean | null,
): TailnetFailureGuidance {
  const recovery = usesAuthKey ? 'none' : 'login';
  return {
    message: `${t('connectFailure.tailnetExpired')} ${t(
      recovery === 'login'
        ? 'connectFailure.tailnetReauthHint'
        : 'connectFailure.tailnetAuthKeyHint',
    )}`,
    recovery,
  };
}

/**
 * tailnet 이 아직 올라오지 않은 동안 그 세션 화면에 무엇을 보여줄지.
 *
 * 진행 문구를 시도를 시작한 세션에만 흘리면, 나머지 화면은 "연결하는 중" 만 보다가 갑자기
 * 브라우저가 뜬다 — 같은 tailnet 을 쓰는 두 번째 터미널이 그렇고, 다른 화면이 올린 노드를
 * 기다리는 경우도 그렇다. 공유 상태에서 직접 만들면 누가 시작했는지와 무관하게 같은 말을 한다.
 *
 * 이미 붙어 있으면(running) null 이다 — 그때는 tailnet 이 할 말이 없고, 세션 자신의 진행이
 * 보여야 한다.
 */
export function resolveTailnetPhaseMessage(
  label: string,
  status: { state?: string; authUrl?: string } | undefined,
): string | null {
  switch (status?.state) {
    case 'starting':
      return t('connectProgress.tailnetConnecting', { label });
    case 'needsAuth':
      // 링크가 오기까지 몇 초에서 십여 초 걸린다. 그동안 "로그인하세요" 라고 하면 사용자는
      // 누를 것을 찾다가 없다는 것만 확인한다.
      return status.authUrl
        ? t('connectProgress.tailnetNeedsAuth', { label })
        : t('connectProgress.tailnetPreparingAuth', { label });
    case 'needsApproval':
      return t('connectProgress.tailnetNeedsApproval', { label });
    default:
      return null;
  }
}
