import {
  extractAwsIamAction,
  type AwsSftpDiagnosticReasonCode,
  type SessionShareChatMessage,
  type SessionShareSnapshotInput,
  type TerminalTab,
} from '@shared';
import {
  getAwsSftpDiagnosticAction,
  getAwsSftpDiagnosticTitle,
} from '../../../common/aws-diagnostics';
import { resolveConnectionFailurePresentation } from '../../store/utils';
import { getFormatLocale, t } from '../../i18n';

/**
 * AWS preflight 가 판정한 실패에 얹을 제목과 "할 일" 한 줄.
 *
 * 판정은 이미 메인에서 끝났다 — 화면은 오류 문장을 다시 뜯지 않고 그 코드로 문구를 고른다.
 * SFTP 실패 화면이 쓰는 것과 같은 카탈로그라 두 화면이 같은 말을 한다.
 *
 * 조치 줄은 **실패 문구가 아직 말하지 않은 경우에만** 얹는다. 권한 거부는 문구 쪽이 이미
 * 거부된 액션 이름까지 말하므로 대개 제목만 남고, 관리 대상 아님·사용자명 없음처럼 "무엇을
 * 하라" 는 말이 없던 실패에는 조치 줄이 새로 붙는다 — 같은 말을 두 번 하면 둘 다 안 읽힌다.
 */
export function resolveAwsFailureNotice(input: {
  reasonCode?: AwsSftpDiagnosticReasonCode | null;
  errorMessage?: string | null;
}): { title: string; action: string | null } | null {
  const reasonCode = input.reasonCode;
  const errorMessage = input.errorMessage?.trim();
  if (!reasonCode || !errorMessage) {
    return null;
  }
  const action = getAwsSftpDiagnosticAction(reasonCode);
  const spokenAction = extractAwsIamAction(
    resolveConnectionFailurePresentation(errorMessage).message,
  );
  return {
    title: getAwsSftpDiagnosticTitle(reasonCode),
    action: spokenAction && action.includes(spokenAction) ? null : action,
  };
}

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

/**
 * 이 세션을 공유할 수 있는가.
 *
 * 상단 바의 Share 버튼과 pane 헤더의 Share 버튼이 **같은 답**을 봐야 한다 — 한쪽만 열리면
 * "버튼은 있는데 눌러도 아무 일이 없다" 가 된다. tmux pane 은 제외한다: control mode 는 pane
 * 이 여럿이라 공유가 가리키는 대상이 흐리고, 로컬 터미널(source !== 'host')은 공유할 원격이
 * 없다.
 */
export function canShareSessionTab(
  tab: { source?: string | null; tmux?: unknown } | null | undefined,
): boolean {
  return tab?.source === 'host' && !tab.tmux;
}

/**
 * 이 세션의 자원·프로세스를 읽어도 되는가.
 *
 * 지표는 대화형 PTY 가 아니라 **보조 채널**에서 읽는다. 그래서 답은 늘 "그 보조 채널이 사는
 * 기계" 다 — 로컬 터미널에서 `ssh prod` 를 쳐도 패널은 계속 이 기계를 보여주는데, 그건 못
 * 고치는 것이 아니라 그것이 맞는 답이다(사용자가 PTY 안에서 옮겨간 것이고, 앱은 그 탭을
 * 여전히 로컬 터미널이라고 부르고 있다).
 *
 * **ECS exec 만 뺀다.** 그 탭은 `호스트 · 서비스 · 컨테이너` 라는 이름을 **앱이** 붙여 만든
 * 것인데, 전송은 로컬(`aws ecs execute-command` 를 이 기계에서 띄운다)이라 보조 채널도 이
 * 기계다. 사용자가 아무 데도 가지 않았는데 탭 이름과 자원 섹션이 서로 다른 기계를 가리키게
 * 된다. 컨테이너의 진짜 지표를 보여줄 길은 없다 — PTY 가 하나뿐이라 보조 채널을 못 연다.
 * 그래서 "이 세션에서는 지표를 읽지 않습니다" 로 둔다.
 *
 * tmux pane 은 control 세션이 따로 재고 있어 여기서 다시 재지 않는다.
 */
export function canReadHostMetrics(
  tab:
    | { source?: string | null; status?: string | null; shellKind?: string | null; tmux?: unknown }
    | null
    | undefined,
): boolean {
  if (!tab || tab.status !== 'connected' || tab.tmux) {
    return false;
  }
  if (tab.source !== 'host' && tab.source !== 'local') {
    return false;
  }
  return tab.shellKind !== 'aws-ecs-exec';
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

  /**
   * 서버가 배너로 사람에게 할 일을 말했고, 그 글이 터미널에 찍혀 있다.
   *
   * 그 시점엔 이 오버레이가 추적하는 것이 **모두 끝나 있다** — tailnet, TCP, 키 교환, 호스트 키.
   * 남은 단계는 서버가 사람을 기다리는 것뿐이고, 카드로 화면을 덮으면 정작 그 안내를 가린다.
   * 실패로 끝나면(아래 error 분기) 다시 보여 준다.
   */
  if (tab.serverBannerShown && tab.status !== 'error') {
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
      ? resolveConnectionFailurePresentation(tab.errorMessage, {
          failure: tab.errorFailure,
        }).title
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
    return resolveConnectionFailurePresentation(tab.errorMessage, {
      failure: tab.errorFailure,
    }).message;
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
}

/**
 * 등록이 만료돼서 못 붙은 실패를 어떻게 말할지.
 *
 * 만료는 Tailscale 계층이 판정해서 알려 준 것만 여기 온다 — 대상까지 못 닿았다는 사실로 만료를
 * 추측하지 않는다. 그러면 멀쩡한 등록을 다시 로그인하라고 권하게 된다.
 *
 * 복구 동작은 내밀지 않는다. 만료를 감지하고 재인증을 개시하는 것은 코어의 일이고, 화면이 그것을
 * 대신 결정하면 판단이 두 곳으로 갈린다. 여기서는 무엇이 일어났는지와 무엇이 필요한지만 말한다.
 *
 * usesAuthKey 가 null 이면(설정을 아직 못 읽음) 브라우저 경로로 떨어진다. 그쪽이 기본이다 —
 * auth key 경로는 다시 할 로그인이 없어서 새 키가 필요하다는 점이 다르다.
 */
export function resolveTailnetFailureGuidance(
  usesAuthKey: boolean | null,
): TailnetFailureGuidance {
  return buildTailnetGuidance(t('connectFailure.tailnetExpired'), usesAuthKey);
}

/**
 * 컨트롤 플레인이 로그인을 거부해서 못 붙은 실패를 어떻게 말할지.
 *
 * 만료와 나눠 두는 이유는 사용자가 할 일이 아니라 **일어난 일**이 다르기 때문이다. 만료는
 * 유효했던 등록이 수명을 다한 것이고, 거부는 애초에 받아들여지지 않은 것이다(없는 auth key,
 * 취소된 키). 뒤이어 붙는 안내는 같다 — 어느 쪽이든 auth key 경로에는 다시 할 로그인이 없다.
 */
export function resolveTailnetLoginRejectedGuidance(
  usesAuthKey: boolean | null,
): TailnetFailureGuidance {
  return buildTailnetGuidance(t('connectFailure.tailnetLoginRejected'), usesAuthKey);
}

function buildTailnetGuidance(
  lead: string,
  usesAuthKey: boolean | null,
): TailnetFailureGuidance {
  return {
    message: `${lead} ${t(
      usesAuthKey
        ? 'connectFailure.tailnetAuthKeyHint'
        : 'connectFailure.tailnetReauthHint',
    )}`,
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
