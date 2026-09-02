import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import {
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from '@shared';
import { cn } from '../../lib/cn';
import {
  resolveHostTailnetId,
  resolveTailnetTargetAddress,
} from '../../lib/host-tailnet';
import { useAppStore } from '../../store/appStore';
import { cancelTailnet, listTailnets } from '../../services/desktop/tailnet';
import { acquireTailnetWatch } from '../../services/desktop/tailnet-watch';
import {
  extractDroppedAbsolutePaths,
  hasExternalFileDrop,
} from '../../lib/file-drop';
import { getSessionCwd } from '../../lib/terminal-cwd-registry';
import { getPathForDroppedFile } from '../../services/desktop/files';
import { useTerminalSessionViewController } from '../../controllers/useTerminalSessionViewController';
import { TerminalChatToastRegion } from './TerminalChatToastRegion';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';
import { TerminalSessionStatusBar } from './TerminalSessionStatusBar';
import { TerminalMoshStatusBar } from './TerminalMoshStatusBar';
import { statusBarStack } from './terminalStatusBarChrome';
import {
  buildHopRows,
  resolveSessionKindChip,
} from '../../lib/session-status-bar';
import { useHostMetrics } from '../../controllers/useHostMetrics';
import { TerminalHostKeyTrustCard } from './TerminalHostKeyTrustCard';
import { TerminalInteractiveAuthOverlay } from './TerminalInteractiveAuthOverlay';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SerialSessionActions } from './SerialSessionActions';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalSharePopover } from './TerminalSharePopover';
import type { TerminalSessionPaneProps } from './types';
import { Button, NoticeCard } from '../../ui';
import { findHostKeyPromptForSession, resolveConnectionFailurePresentation } from '../../store/utils';
import {
  describeAwsTransport,
  canReadHostMetrics,
  resolveAwsFailureNotice,
  resolveTailnetFailureGuidance,
  resolveTailnetLoginRejectedGuidance,
  resolveTailnetPhaseMessage,
} from './terminalSessionHelpers';
import { resolveConnectionStages, stageSubjectFromTab } from './connectionStages';
import { TerminalAutocompleteOverlay } from './TerminalAutocompleteOverlay';
import { TerminalBlockOverlay } from './TerminalBlockOverlay';
import { TerminalBlockStickyHeader } from './TerminalBlockStickyHeader';
import { TerminalCommandPalette } from './TerminalCommandPalette';
import { SnippetVariablesDialog } from './SnippetVariablesDialog';
import type { CommandFinishedInfo } from '../../lib/command-notification';
import { getHostSubtitle } from '@shared';
import { hostSubtitleLabels } from '../../../common/shared-messages';
import { useTranslation } from 'react-i18next';


export function TerminalSessionPane(props: TerminalSessionPaneProps) {
  const { t: translate } = useTranslation();
  const {
    sessionId,
    title,
    visible,
    active,
    style,
    showHeader = false,
    soloView = true,
    draggingDisabled = false,
    interactiveAuth,
    onFocus,
    onClose,
    onRetry,
    onCancelReconnect,
    isPrimaryTmuxOverlayPane = true,
    onReopenInteractiveAuthUrl,
    onClearPendingInteractiveAuth,
    onOpenSessionShareChatWindow,
    tab,
  } = props;

  const snippets = useAppStore((state) => state.snippets);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);

  // tailnet 복구 동작은 이 화면에 없다.
  //
  // 만료 감지·재인증 개시·링크가 안 올 때 노드를 다시 세우는 것은 모두 코어가 한다. 여기서
  // 조립하면(확인 표시 → 재연결, 취소 → 플래그 → 재시도) 같은 일에 대한 판단이 두 곳에 생기고,
  // 화면이 코어보다 앞서 결정하게 된다. 이 화면은 상태를 그리고, 사용자의 의사(취소·다시 시도)만
  // 전달한다.
  // 넷맵에서 찾아야 하는 기기와, 올라와 있어야 하는 노드를 고르는 데 쓴다(점프가 있으면 첫 홉).
  const hosts = useAppStore((state) => state.hosts);
  /**
   * 이 연결이 거치는 tailnet.
   *
   * **관문과 같은 판정을 쓴다.** 대상의 tailnetId 만 직접 읽던 시절에는 "점프 호스트에만
   * tailnet" 구성에서 관문은 도는데(trust-auth 의 needsTailnetReady 가 이 헬퍼를 쓴다)
   * 오버레이에는 tailnet 계층이 통째로 안 그려졌다 — 노드가 올라오는 동안 화면에는 이유 없는
   * "연결 중…" 만 남고, 인증이 필요한 경우에는 누를 링크조차 나오지 않았다.
   *
   * 바로 아래 targetAddress 는 이미 첫 홉 규칙을 쓰고 있었다. 한 화면이 두 규칙을 쓰면
   * "Tailscale 은 안 쓴다고 하면서 tailnet 안의 기기를 찾는" 상태가 된다.
   */
  const tailnetIdOfHost = resolveHostTailnetId(props.host, hosts);


  // tmux pane 분할은 상단 윈도우 바의 "분할" 버튼(또는 Ctrl-b % / ")이 담당한다.
  // pane 헤더/floating 의 │·─ 버튼은 헷갈려서 제거했다.
  // tmux pane 은 헤더/여백 없이 슬롯을 꽉 채운다 — 그래야 컨테이너 픽셀과 tmux 셀 그리드가
  // 일치해(여백만큼 행이 더 보고돼 밑이 짤리던 문제 제거) tmux 가 자기 경계선을 직접 그린다.
  const isTmuxPane = Boolean(tab?.tmux);
  const notifyCommandFinished = useAppStore(
    (state) => state.notifyCommandFinished,
  );
  const onCommandFinished = useCallback(
    (info: CommandFinishedInfo) => {
      // 사용자가 이 명령의 출력을 지금 보고 있으면(앱 포커스 + 활성 탭) 알리지 않는다.
      notifyCommandFinished(info, {
        visibleToUser: document.hasFocus() && active,
        hostLabel: props.host?.label ?? '',
      });
    },
    [notifyCommandFinished, active, props.host],
  );
  const controller = useTerminalSessionViewController({
    ...props,
    snippets,
    onCommandFinished,
  });
  // 블록 툴바의 AI 버튼은 AI 기능이 켜져 있을 때만 노출한다.
  const aiAssistantEnabled = useAppStore(
    (state) => state.settings?.ai?.enabled ?? false,
  );
  const hostMetricsEnabled = useAppStore(
    (state) => state.settings?.hostMetricsEnabled ?? false,
  );
  // 연결된 호스트 세션에서만. 로컬 터미널은 원격 부하라는 개념이 없다.
  //
  // tmux pane 은 제외한다. 한 그룹의 pane 들은 모두 같은 호스트라 같은 값이 pane 수만큼
  // 반복되고, pane 폭이 좁으면 바가 경계에서 잘려 옆 pane 것과 겹쳐 읽힌다. 그룹당 하나만
  // 셸 하단에서 그린다(SessionShell). enabled 를 끄는 것으로 표시와 샘플링이 함께 멈춘다 —
  // 바는 status 'off' 에서 null 을 반환하고, 호스트를 pane 수만큼 폴링하던 것도 없어진다.
  const hostMetrics = useHostMetrics({
    sessionId,
    // 어떤 세션을 읽는지는 canReadHostMetrics 가 정한다 — 규칙과 그 이유를 한 곳에 둔다.
    enabled: hostMetricsEnabled && canReadHostMetrics(tab),
    // 로컬 셸이면 코어가 이 기계를 직접 읽는다 — 셸에 물어볼 것이 없고, Windows 에는 그
    // POSIX 스크립트를 돌릴 셸이 아예 없어 여기가 통째로 비어 있었다.
    local: tab?.source === 'local',
    visible,
  });
  // 스티키 헤더가 떠 있고 hover 한 블록이 그 아래로 파고들면(=블록 상단이 화면 위로 잘린
  // 상태) 툴바가 헤더에 가린다. 그 겹치는 만큼만 툴바를 내린다.
  const blockToolbarTopOffset = (() => {
    const { blockOverlay, blockSticky } = controller;
    if (!blockOverlay || !blockSticky) {
      return 0;
    }
    const stickyBottom = blockSticky.top + blockSticky.height;
    return blockOverlay.top < stickyBottom
      ? stickyBottom - blockOverlay.top + 2
      : 0;
  })();
  // ⌘I 는 세션 패널의 AI 섹션을 여닫는다. AI 는 pane 헤더의 버튼에서 패널 섹션으로 옮겼다.
  const toggleSessionPanelSection = useAppStore(
    (state) => state.toggleSessionPanelSection,
  );
  // 선택/출력 캡처는 stableId 로 살아있는 런타임에서 읽는다(재연결로 sessionId가 바뀌어도 안정).
  const stableId = tab?.stableId ?? sessionId;
  const handlePaneKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // ⌘I / Ctrl+I: AI 여닫기. 나머지 단축키(검색 등)는 컨트롤러로 위임.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (event.key === 'i' || event.key === 'I')
      ) {
        event.preventDefault();
        toggleSessionPanelSection(sessionId, 'ai');
        return;
      }
      // ⌘/Ctrl+Shift+P: 명령 팔레트. 팔레트 표준 단축키라 다른 도구와 감각이 같고,
      // Ctrl+Shift+* 는 셸(readline)이 쓰지 않아 터미널 입력을 뺏지 않는다.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        (event.key === 'p' || event.key === 'P')
      ) {
        event.preventDefault();
        // 이미 열려 있으면 다시 열지 않는다 — 컴포넌트가 리마운트되지 않아 검색어와
        // 선택 위치는 그대로인 채 목록만 새로 떠서, 강조된 행의 의미가 조용히 바뀐다.
        if (!controller.commandPaletteOpen) {
          controller.openCommandPalette();
        }
        return;
      }
      controller.handlePaneKeyDownCapture(event);
    },
    [controller, sessionId, toggleSessionPanelSection],
  );

  const [serialNotice, setSerialNotice] = useState<string | null>(null);

  // EC2 전송 설명. 칩 툴팁(상시)과 폴백 토스트(한 번)에 나눠 쓴다.
  const awsTransportText = useMemo(
    () => describeAwsTransport(tab, translate),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 두 필드만 본다
    [tab?.awsTransport, tab?.awsFallback, translate],
  );
  /**
   * SSM 셸로 물러났다는 토스트. **한 번만, 잠시만.** 지속되어야 할 정보("지금 SSM 셸이다")는
   * 하단 칩과 그 툴팁이 맡고, 여기서는 사건이 일어났다는 것만 알린다.
   */
  const [awsToast, setAwsToast] = useState<string | null>(null);
  useEffect(() => {
    setAwsToast(tab?.status === 'connected' ? awsTransportText.toast : null);
  }, [awsTransportText.toast, tab?.status]);
  useEffect(() => {
    if (!awsToast) {
      return;
    }
    const timeoutId = window.setTimeout(() => setAwsToast(null), 8000);
    return () => window.clearTimeout(timeoutId);
  }, [awsToast]);

  useEffect(() => {
    setSerialNotice(null);
  }, [sessionId]);

  useEffect(() => {
    if (!serialNotice) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSerialNotice(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [serialNotice]);

  const serialActions = useMemo(
    () => (
      <SerialSessionActions
        sessionId={sessionId}
        host={props.host}
        connected={tab?.status === 'connected'}
        onNotice={setSerialNotice}
      />
    ),
    [props.host, sessionId, tab?.status],
  );
  const connectionFailurePresentation = useMemo(
    () =>
      tab?.errorMessage
        ? resolveConnectionFailurePresentation(tab.errorMessage)
        : null,
    [tab?.errorMessage],
  );
  const awsFailureNotice = useMemo(
    () =>
      resolveAwsFailureNotice({
        reasonCode: tab?.awsDiagnosticReasonCode,
        errorMessage: tab?.errorMessage,
      }),
    [tab?.awsDiagnosticReasonCode, tab?.errorMessage],
  );
  /**
   * 이 호스트의 tailnet 이 지금 어떤 상태인지. 설정 화면과 같은 값을 본다.
   *
   * 화면마다 따로 읽으면 서로 다른 말을 한다 — 설정에서는 인증이 진행 중인데 여기는 실패한
   * 채로 멈춰 있고, 로그인을 마쳐도 여기만 그대로 남는다. 노드는 tailnet 단위로 공유되므로
   * 상태도 하나여야 한다.
   */
  const tailnetStatus = useAppStore((state) =>
    tailnetIdOfHost ? state.tailnetStatuses[tailnetIdOfHost] : undefined,
  );

  /**
   * Tailscale 계층이 직접 알린 실패인지.
   *
   * 대상까지 못 닿았다는 사실(타임아웃)로는 판단하지 않는다 — 등록이 유효한지는 그 계층이 이미
   * 확인했고, 그러고도 못 닿는 것은 대상이나 경로의 문제다. 섞으면 멀쩡한 등록을 다시 로그인하라고
   * 권하게 된다.
   */
  const failureKind = connectionFailurePresentation?.kind;

  const tailscaleFailure =
    Boolean(tailnetIdOfHost) &&
    (failureKind === 'tailscale-expired' || failureKind === 'tailscale-auth');


  /**
   * 아직 붙지 못한 tailnet 세션인 동안만 상태를 읽는다. 붙은 연결에는 이 왕복이 얹히지 않는다.
   *
   * 실패한 경우만 보면 안 된다 — 같은 tailnet 을 쓰는 터미널을 하나 더 열면 그 세션은 진행 중인
   * 인증에 합류하는데, 진행 문구는 시도를 시작한 세션에만 간다. 그 세션도 여기서 같은 상태를
   * 읽어야 "무엇을 기다리는지" 를 알 수 있다.
   */
  //
  // 'pending' 을 빼먹으면 아무것도 보이지 않는다 — 연결을 시작한 탭은 세션 id 를 받기 전까지
  // pending 이고, tailnet 을 올리는 구간이 바로 그 안이다.
  //
  // 실패 종류로 가르면 안 된다 — Tailscale 이 아닌 이유로 실패한 화면도 그 계층 상태를 보여주고
  // 있어서, 감시를 끊으면 그 표시가 실패한 순간 값으로 얼어붙는다. 그러면 설정 화면은 살아 있는
  // 값을, 이 화면은 굳은 값을 보여줘서 둘이 다른 말을 한다.
  const tailnetSessionPending = Boolean(tailnetIdOfHost) && tab?.status !== 'connected';
  useEffect(() => {
    if (!tailnetSessionPending) {
      return;
    }
    return acquireTailnetWatch();
  }, [tailnetSessionPending]);

  /**
   * tailnet 이 지금 사람을 기다리는 중인지(브라우저 로그인·관리자 승인).
   *
   * 그 경우 실패 화면을 그대로 두면 거짓말이 된다 — 이미 인증이 진행 중인데 "다시 로그인"을
   * 권하게 된다. 진행 중이라고 말하고, 설정 화면과 같은 동작(브라우저 다시 열기·취소)을 준다.
   */
  /**
   * 컨트롤 플레인이 로그인을 거부했는지.
   *
   * 거부돼도 상태는 needsAuth 로 남는다 — 잘못된 auth key 가 그렇다. 이것을 보지 않으면 아래
   * 판정이 "인증 진행 중" 으로 기울어, 오지 않을 링크를 기다리라고 말하게 된다. 단계 목록과
   * 설정 화면은 이미 이 신호를 보고 실패로 그리므로, 여기만 안 보면 한 화면이 서로 다른 말을 한다.
   */
  const tailnetLoginRejected = Boolean(tailnetStatus?.loginError?.trim());
  const tailnetAuthInFlight =
    tailnetSessionPending &&
    !tailnetLoginRejected &&
    (tailnetStatus?.state === 'needsAuth' || tailnetStatus?.state === 'needsApproval');

  /**
   * 실패를 어떻게 말할지 정하는 데 필요한 사실들.
   *
   * 만료 여부는 공유 상태에서 오고, 인증 방식은 이 tailnet 의 설정에서 온다(auth key 경로에는
   * 다시 할 로그인이 없어서 낼 수 있는 동작이 다르다).
   */
  const [tailnetUsesAuthKey, setTailnetUsesAuthKey] = useState<boolean | null>(null);
  const [tailnetLabel, setTailnetLabel] = useState('');
  useEffect(() => {
    if (!tailnetSessionPending || !tailnetIdOfHost) {
      setTailnetUsesAuthKey(null);
      return;
    }
    let cancelled = false;
    void Promise.resolve()
      .then(listTailnets)
      .then((records) => {
        if (!cancelled) {
          const record = records.find((entry) => entry.id === tailnetIdOfHost);
          setTailnetUsesAuthKey(record?.hasAuthKey === true);
          setTailnetLabel(record?.label ?? '');
        }
      })
      .catch(() => {
        // 못 읽으면 브라우저 경로로 떨어진다 — 그쪽이 기본이다.
      });
    return () => {
      cancelled = true;
    };
  }, [tailnetIdOfHost, tailnetSessionPending]);

  // 만료만 그 자리에서 다시 로그인해서 풀린다. 인증이 진행 중인 경우는 새 로그인을 걸면 진행
  // 중인 것을 버리게 되므로 브라우저로 보낸다.
  //
  // 거부는 기다려서 풀리지 않으므로 무엇이 막혔는지 말해 준다 — 특히 auth key 로 등록한
  // tailnet 은 다시 할 로그인이 없어서 새 키가 필요하다는 것까지 알려야 손을 쓸 수 있다.
  const tailnetGuidance =
    failureKind === 'tailscale-expired'
      ? resolveTailnetFailureGuidance(tailnetUsesAuthKey)
      : tailnetLoginRejected
        ? resolveTailnetLoginRejectedGuidance(tailnetUsesAuthKey)
        : null;

  const pendingHostKeyPrompt = useAppStore((state) => state.pendingHostKeyPrompt);
  // 이 판이 기다리는 신뢰 물음. 전역 슬롯 하나만 보면 다른 탭의 물음이 이 판에 뜬다.
  const hostKeyPromptForPane = useAppStore((state) =>
    findHostKeyPromptForSession(state, sessionId),
  );
  const acceptPendingHostKeyPrompt = useAppStore(
    (state) => state.acceptPendingHostKeyPrompt,
  );
  const dismissPendingHostKeyPrompt = useAppStore(
    (state) => state.dismissPendingHostKeyPrompt,
  );

  /**
   * 이 연결이 거치는 단계들. 오버레이가 이것을 그린다.
   *
   * 한 줄 문구는 새 단계가 앞 단계를 덮어써서, 빨리 지나간 단계는 사용자가 못 본 것과 같았다.
   * 실패해도 어디까지 갔는지 알 수 없어서 Tailscale 문제인지 SSH 문제인지 구분이 안 됐다.
   */
  const connectionStages = useMemo(
    () =>
      resolveConnectionStages({
        subject: stageSubjectFromTab(tab),
        hasTailscale: Boolean(tailnetIdOfHost),
        // 대상 주소로 넷맵에서 그 기기를 찾아 경로를 보여준다 — Tailscale 이 붙어 있어도 대상에
        // 못 가는 경우가 있고, 그것을 안 보여주면 "설정은 연결됨인데 왜 안 되지" 가 된다.
        // 점프 호스트가 있으면 tailnet 이 닿아야 하는 기기는 첫 홉이다 — 헬퍼가 그 판정을
        // 갖고 있다(VNC 터널에서 같은 거짓 진단을 겪고 만든 것).
        targetAddress: resolveTailnetTargetAddress(props.host, hosts),
        // 종류에 따라 호스트 계층 단계가 달라진다 — 로컬 셸에 "SSH 연결" 을 세우면 안 된다.
        hostKind: props.host?.kind,
        // Windows EC2 는 같은 aws-ec2 라도 SSM 셸로 붙어서 SSH·호스트 키 관문이 없다.
        awsPlatform:
          props.host && isAwsEc2HostRecord(props.host) ? props.host.awsPlatform : undefined,
        tailnetStatus,
        failureLayer: connectionFailurePresentation?.layer ?? null,
        failureMessage: connectionFailurePresentation?.message,
        hostKeyPrompted:
          pendingHostKeyPrompt != null &&
          pendingHostKeyPrompt.action.hostId === props.host?.id,
      }),
    [
      connectionFailurePresentation?.layer,
      connectionFailurePresentation?.message,
      pendingHostKeyPrompt,
      // targetAddress·tailnetIdOfHost 가 둘 다 이 목록에서 첫 홉을 찾는다. 빼면 점프 설정을
      // 바꾼 뒤에도 낡은 진단이 그대로 남는다.
      hosts,
      props.host,
      tab,
      tailnetIdOfHost,
      tailnetLabel,
      tailnetStatus,
    ],
  );

  const tailnetPhaseMessage = tailnetSessionPending
    ? resolveTailnetPhaseMessage(tailnetLabel, tailnetStatus)
    : null;
  /**
   * 지금 열어야 할 인증 링크.
   *
   * 누가 그 인증을 시작했는지는 상관없다 — 노드가 tailnet 단위로 공유되므로 링크도 공유 상태
   * 하나에서 온다. 세션별로 따로 들고 있으면 다른 화면이 시작한 인증을 이 화면이 모른다.
   */
  const tailnetAuthUrl = tailnetAuthInFlight ? tailnetStatus?.authUrl : undefined;

  const tailnetFailureMessage =
    tab?.status === 'error'
      ? // 실패한 화면에서는 "브라우저에서 로그인을 마쳐 주세요" 라고 하면 안 된다 — 실패로
        // 앉아 있으면서 진행 중인 것처럼 말하게 된다. 인증이 아직 살아 있다는 사실만 알리고,
        // 로그인을 마치면 여기서 이어 붙는다는 것까지 말한다.
        (tailnetGuidance?.message ??
        (tailnetAuthInFlight ? translate('connectFailure.tailnetAuthInFlight') : null))
      : tailnetPhaseMessage;


  // --- 터미널 파일 드롭 → 현재 cwd로 SFTP 업로드 ---
  const uploadLocalFilesToHost = useAppStore(
    (state) => state.uploadLocalFilesToHost,
  );
  const uploadHost = props.host;
  const canReceiveFileUpload =
    tab?.status === 'connected' &&
    tab?.source === 'host' &&
    !!uploadHost &&
    (isSshHostRecord(uploadHost) ||
      isAwsEc2HostRecord(uploadHost) ||
      isWarpgateSshHostRecord(uploadHost));
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<{
    tone: 'info' | 'warning' | 'danger';
    message: string;
  } | null>(null);
  // SFTP 연결을 새로 여는 동안(특히 SSM은 수 초 소요) 보여줄 준비 상태.
  // 전송이 실제 시작되기 전까지의 공백을 메운다. 자동 사라지지 않는다.
  const [uploadPending, setUploadPending] = useState<string | null>(null);

  useEffect(() => {
    if (!uploadNotice) {
      return;
    }
    const timeoutId = window.setTimeout(() => setUploadNotice(null), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [uploadNotice]);

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // 자식(AI 패널)이 이미 처리한 드래그면 SFTP 업로드 오버레이를 끄고 물러난다.
      if (event.defaultPrevented) {
        setIsFileDropActive(false);
        return;
      }
      if (!canReceiveFileUpload || !hasExternalFileDrop(event.dataTransfer)) {
        return;
      }
      // 세션 탭(분할) 드래그가 아닌 OS 파일 드롭만 가로챈다.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsFileDropActive(true);
    },
    [canReceiveFileUpload],
  );

  const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsFileDropActive(false);
  }, []);

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // 자식(AI 패널)이 이미 처리한 드롭이면 업로드하지 않는다.
      if (event.defaultPrevented) {
        setIsFileDropActive(false);
        return;
      }
      if (!canReceiveFileUpload || !hasExternalFileDrop(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      setIsFileDropActive(false);
      const hostId = tab?.hostId;
      if (!hostId) {
        return;
      }
      const droppedFiles = Array.from(event.dataTransfer.files);
      void (async () => {
        const localPaths = await extractDroppedAbsolutePaths(
          droppedFiles,
          getPathForDroppedFile,
        );
        if (localPaths.length === 0) {
          setUploadNotice({
            tone: 'danger',
            message: translate('sessionPane.dropPathFailed'),
          });
          return;
        }
        setUploadNotice(null);
        setUploadPending(
          translate('sessionPane.uploadPreparing', { count: localPaths.length }),
        );
        try {
          const result = await uploadLocalFilesToHost(
            {
              hostId,
              targetPath: getSessionCwd(sessionId),
              localPaths,
            },
            (message) => setUploadPending(message),
          );
          if (!result.ok) {
            const awaitingHostTrust = result.reason === 'awaiting-host-trust';
            setUploadNotice({
              tone: awaitingHostTrust ? 'info' : 'danger',
              message: awaitingHostTrust
                ? (result.message ?? translate('sessionPane.hostKeyPrompt'))
                : result.reason === 'unsupported'
                  ? translate('sessionPane.uploadUnsupported')
                  : result.reason === 'connect-failed'
                    ? translate('sessionPane.sftpFailed', { message: result.message ?? '' })
                    : (result.message ?? translate('sessionPane.nothingToUpload')),
            });
            return;
          }
          setUploadNotice(
            result.usedHomeFallback
              ? {
                  tone: 'warning',
                  message: translate('sessionPane.cwdFallback', { path: result.targetPath }),
                }
              : {
                  tone: 'info',
                  message: translate('sessionPane.uploadStarted', { path: result.targetPath }),
                },
          );
        } finally {
          setUploadPending(null);
        }
      })();
    },
    [canReceiveFileUpload, tab?.hostId, sessionId, uploadLocalFilesToHost],
  );

  // pane 헤더(분할 화면)에 놓이는 한 줄 묶음 — 시리얼 액션 · Share.
  //
  // 헤더가 그 pane 을 가리키므로 어느 pane 을 공유하는지가 분명하다. **헤더가 없는 단독
  // 화면에는 두지 않는다** — 예전에는 터미널 오른쪽 위에 알약이 떠서 화면을 늘 가리고 있었고,
  // 세션에 딸린 것들(히스토리·자원·tmux·테마)이 이미 세션 패널에 모여 있는데 공유만 화면 위에
  // 떠 있었다. 지금은 패널의 `공유` 섹션이 그 일을 한다(AI 토글도 같은 이유로 옮겼다).
  // 하단 줄에 담을 것이 있는가. 세션 상태바는 화면을 혼자 쓸 때만, mosh 바는 늘 자기 줄에.
  const showStatusBarStack = Boolean(tab?.moshState) || (!isTmuxPane && soloView);

  const renderPaneActions = () =>
    controller.canShareSession ? (
      <TerminalSharePopover
        anchorRef={controller.sharePopoverRef}
        open={controller.sharePopoverOpen}
        actions={serialActions}
        canStartShare={controller.canStartShare}
        shareCopyStatus={controller.shareCopyStatus}
        shareState={controller.shareState}
        onToggle={controller.toggleSharePopover}
        onStartShare={() => {
          void controller.handleStartShare();
        }}
        onCopyShareUrl={() => {
          void controller.handleCopyShareUrl();
        }}
        onSetInputEnabled={controller.handleSetSessionShareInputMode}
        onOpenChatWindow={controller.handleOpenShareChatWindow}
        onStopShare={controller.handleStopShare}
        canOpenChatWindow={Boolean(onOpenSessionShareChatWindow)}
      />
    ) : // 공유 불가 세션(로컬 터미널 등)엔 Share 팝오버가 없고, 이제 띄울 다른 버튼도 없다.
    null;

  return (
    <div
      className={cn(
        'absolute inset-0 min-h-0 flex-col gap-[0.7rem]',
        visible || active
          ? 'flex pointer-events-auto opacity-100'
          : 'hidden pointer-events-none opacity-0',
        // 브로드캐스트 참여 표시.
        //
        // 카드 테두리는 **포커스**를 뜻하므로 겹쳐 쓰지 않는다 — 카드 바로 밖에 점선 한 겹을
        // 두른다(실선=포커스, 점선=동시 입력). 색은 액센트다: 앰버·초록·빨강은 이미 상태
        // 어휘(재연결·warn·실패)이고, 바로 옆 지연 칩이 그 색을 쓰므로 링에 쓰면 "이 pane 지연이
        // 주황" 으로 읽힌다. 브로드캐스트는 상태가 아니라 모드다.
        //
        // outline + 음수 offset 인 이유: 이 루트는 슬롯을 꽉 채우므로 가장자리에 그리면 창
        // 경계에서 잘리고 이웃 pane 의 선과 겹쳐 두께가 들쭉날쭉해진다. 루트 padding(4px)만큼
        // 안으로 넣어 카드 경계에 딱 맞춘다.
        props.broadcastActive &&
          !isTmuxPane &&
          'outline-2 outline-dashed -outline-offset-4 outline-[color-mix(in_srgb,var(--accent-strong)_70%,transparent)]',
        // 헤더가 있으면 gap 을 없앤다. 헤더와 터미널은 위아래로 맞붙어 한 상자로 읽혀야 하는데
        // (헤더 border-b-0 + 터미널 border-t-0 이 이어지는 구조) flex gap 이 그 사이를 벌리면
        // 테두리가 끊긴 것처럼 보인다. 사이가 필요한 요소(알림 카드 등)는 자기 margin 을 갖고
        // 있으므로 gap 이 없어도 붙지 않는다. 헤더가 없는 경로(tmux·standalone)는 그대로 둔다.
        showHeader && 'gap-0 p-[0.25rem]',
      )}
      style={style}
      onKeyDownCapture={handlePaneKeyDownCapture}
      onMouseDown={controller.handlePaneMouseDown}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      {controller.canShareSession ? (
        <TerminalChatToastRegion
          notifications={controller.visibleSessionShareChatNotifications}
        />
      ) : null}
      {awsToast ? (
        <div
          className="pointer-events-none absolute bottom-[0.85rem] right-[0.85rem] z-[4] w-[min(100%,340px)]"
          aria-live="polite"
        >
          <NoticeCard tone="warning" role="status" className="text-[0.82rem] leading-[1.45]">
            {awsToast}
          </NoticeCard>
        </div>
      ) : null}

      {showHeader ? (
        <TerminalPaneHeader
          sessionId={sessionId}
          title={title}
          active={active}
          draggingDisabled={draggingDisabled}
          closingDisabled={!onClose || tab?.status === 'disconnecting'}
          kind={props.host?.kind}
          // 대상 표기는 앱의 다른 목록과 같은 헬퍼를 쓴다 — pane 헤더만 따로 만들면 같은
          // 호스트가 화면마다 다르게 적힌다(AWS·Warpgate·시리얼은 형식이 제각각이다).
          subtitle={props.host ? getHostSubtitle(props.host, hostSubtitleLabels()) : undefined}
          // 지연은 하단바가 없는 분할에서 헤더가 든다. 이력은 재연결을 건너 이어져야 하므로
          // stableId 를 키로 쓴다(sessionId 는 재연결마다 새로 난다).
          rttMs={tab?.lastRttMs ?? null}
          rttHistoryKey={tab?.stableId ?? null}
          zoomed={props.zoomed}
          onToggleZoom={props.onToggleZoom}
          onDetachToTab={props.onDetachToTab}
          broadcastActive={props.broadcastActive}
          broadcastDisabled={props.broadcastDisabled}
          onToggleBroadcast={props.onToggleBroadcast}
          onFocus={onFocus}
          onClose={() => {
            void onClose?.();
          }}
          onStartDrag={props.onStartDrag}
          onEndDrag={props.onEndDrag}
          actions={renderPaneActions()}
        />
      ) : null}

      {tab?.errorMessage ? (
        <NoticeCard tone="danger" className="mx-[0.55rem] mt-[0.55rem]" role="alert">
          {awsFailureNotice ? (
            <span className="grid gap-[0.2rem]">
              <strong className="text-[var(--text)]">
                {awsFailureNotice.title}
              </strong>
              <span>
                {tailnetFailureMessage ??
                  connectionFailurePresentation?.message ??
                  tab.errorMessage}
              </span>
              {awsFailureNotice.action ? (
                <span className="text-[var(--text-soft)]">
                  {awsFailureNotice.action}
                </span>
              ) : null}
            </span>
          ) : (
            (tailnetFailureMessage ??
              connectionFailurePresentation?.message ??
              tab.errorMessage)
          )}
        </NoticeCard>
      ) : null}
      {serialNotice ? (
        <NoticeCard tone="warning" className="mx-[0.55rem] mt-[0.55rem]" role="status">
          {serialNotice}
        </NoticeCard>
      ) : null}
      {uploadPending ? (
        <NoticeCard
          tone="info"
          className="mx-[0.55rem] mt-[0.55rem] animate-pulse"
          role="status"
        >
          {uploadPending}
        </NoticeCard>
      ) : null}
      {uploadNotice ? (
        <NoticeCard
          tone={uploadNotice.tone}
          className="mx-[0.55rem] mt-[0.55rem]"
          role="status"
        >
          {uploadNotice.message}
        </NoticeCard>
      ) : null}
      {controller.terminalInitError ? (
        <NoticeCard tone="danger" className="mx-[0.55rem] mt-[0.55rem]" role="alert">
          {controller.terminalInitError}
        </NoticeCard>
      ) : null}

      {/* 신뢰 물음은 인증보다 앞이다 — 키를 받아들이기 전에는 인증을 시작하지도 않는다. */}
      {hostKeyPromptForPane ? (
        <TerminalHostKeyTrustCard
          pending={hostKeyPromptForPane}
          onAccept={(mode) => {
            void acceptPendingHostKeyPrompt(mode, sessionId);
          }}
          onCancel={() => {
            dismissPendingHostKeyPrompt(sessionId);
          }}
        />
      ) : null}

      {interactiveAuth ? (
        <TerminalInteractiveAuthOverlay
          interactiveAuth={interactiveAuth}
          promptResponses={controller.promptResponses}
          storedPasswordPrompts={controller.storedPasswordPrompts}
          onPromptResponseChange={controller.handleInteractiveAuthPromptChange}
          onStoredPasswordToggle={
            controller.handleInteractiveAuthStoredPasswordToggle
          }
          onSubmit={() => {
            void controller.handleInteractiveAuthSubmit();
          }}
          onCopyApprovalUrl={controller.handleCopyInteractiveAuthApprovalUrl}
          onReopenApprovalUrl={() => {
            void onReopenInteractiveAuthUrl();
          }}
          onClose={() => {
            void onClearPendingInteractiveAuth(interactiveAuth.challengeId);
          }}
        />
      ) : null}

      {controller.searchOpen ? (
        <TerminalSearchOverlay
          inputRef={controller.searchInputRef}
          searchQuery={controller.searchQuery}
          onBlur={controller.blurSearch}
          onChange={controller.handleSearchQueryChange}
          onKeyDown={controller.handleSearchInputKeyDown}
          onFindPrevious={controller.findPreviousSearchMatch}
          onFindNext={controller.findNextSearchMatch}
          onClose={controller.closeSearchOverlay}
        />
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {/* 단독 화면에는 Share 알약을 띄우지 않는다(세션 패널의 `공유` 섹션으로 갔다).
              시리얼 제어만 남는다 — 그것은 이 터미널에 바로 보내는 신호라 화면 옆이 자리다. */}
          {showHeader ? null : (
            <div className="absolute right-[0.85rem] top-[0.85rem] z-[4] flex items-center gap-2">
              {serialActions}
            </div>
          )}

          <div
            ref={controller.containerRef}
            className={cn(
              'relative mx-[0.35rem] mt-[0.35rem] mb-[0.2rem] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[6px] bg-[color-mix(in_srgb,var(--surface)_96%,transparent_4%)] p-0 [&_.xterm]:min-h-full [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm-viewport]:min-h-full [&_.xterm-viewport]:h-full [&_.xterm-viewport]:w-full [&_.xterm-viewport]:bg-transparent [&_.xterm-viewport]:rounded-none',
              // 좌우 margin 을 두지 않는다 — 헤더는 margin 이 없어서 터미널만 안쪽으로 들어가면
              // 세로 테두리가 어긋난다. 바깥 여백은 pane 루트의 padding 이 한 번만 준다.
              showHeader &&
                'mx-0 mb-0 mt-0 rounded-b-[6px] rounded-t-none border border-t-0',
              // 헤더가 활성 테두리를 두르므로 본문도 같이 둘러야 한 상자로 읽힌다.
              showHeader &&
                (active
                  ? 'border-[color-mix(in_srgb,var(--accent-strong)_55%,var(--border))]'
                  : 'border-[var(--border)]'),
              // 명령 블록 점 마커가 들어갈 왼쪽 거터. 이 여백이 없으면 마커가 열 0 위에 그려져
              // 글자와 겹친다(GUTTER_WIDTH_PX 와 맞춰야 함). FitAddon 은 부모의 content width 로
              // cols 를 계산하므로 패딩만큼 자동 반영된다. tmux pane 은 컨테이너 px = tmux 셀
              // 그리드라 제외한다.
              !isTmuxPane && 'pl-[10px]',
              // tmux pane: 여백/라운드 제거 → 슬롯을 꽉 채워 컨테이너 px = tmux 셀 그리드.
              isTmuxPane && 'm-0 rounded-none border-0',
              // tmux control mode dead-zone 완화(최소·안전): 공유 크기 탓에 pane 렌더 영역보다
              // cell grid 가 작아 생기는 빈 영역(.xterm 요소 중 .xterm-screen 바깥)을, 컨테이너와
              // .xterm 배경을 패널 surface 로 맞춰 회색으로 튀지 않게 블렌딩한다. 실제 문자 셀
              // (.xterm-screen)의 터미널 테마 배경은 건드리지 않고, xterm 크기/FitAddon 측정도
              // 그대로 둬(렌더 안정성 보존) 그리드는 좌상단 정렬이되 여백이 배경과 동색이라 덜 띈다.
              tab?.tmux && 'bg-[var(--surface)] [&_.xterm]:bg-[var(--surface)]',
            )}
            // 마커 거터까지 터미널 테마 배경으로 칠한다. 앱 surface 로 두면 xterm 배경이 거터
            // 오른쪽에서 각지게 시작해 터미널 블록이 "오른쪽만 둥글게" 보인다 — 테마 배경을
            // 컨테이너 전체에 깔아야 양쪽 모서리가 같은 rounded-[6px] 를 따라간다. tmux pane 은
            // 위의 dead-zone 블렌딩(bg surface)을 그대로 쓴다.
            style={
              isTmuxPane
                ? undefined
                : { backgroundColor: props.appearance.theme.background }
            }
            data-terminal-canvas="true"
            data-tmux-pane={tab?.tmux ? 'true' : undefined}
            onMouseMove={controller.handleBlockPointerMove}
            onMouseLeave={controller.clearBlockHover}
          >
            {controller.commandPaletteOpen ? (
              <TerminalCommandPalette
                items={controller.commandPaletteItems}
                onClose={controller.closeCommandPalette}
                onJump={controller.handleCommandPaletteJump}
                onRerun={controller.handleCommandPaletteRerun}
              />
            ) : null}
            {controller.blockSticky ? (
              <TerminalBlockStickyHeader
                sticky={controller.blockSticky}
                onJumpToCommand={controller.scrollToStickyBlock}
              />
            ) : null}
            {controller.blockOverlay ? (
              <TerminalBlockOverlay
                overlay={controller.blockOverlay}
                onCopyOutput={controller.handleBlockCopyOutput}
                onCopyCommand={controller.handleBlockCopyCommand}
                onRerun={controller.handleBlockRerun}
                rerunEnabled={controller.blockRerunEnabled}
                onAskAi={controller.handleBlockAskAi}
                aiEnabled={aiAssistantEnabled}
                toolbarTopOffset={blockToolbarTopOffset}
              />
            ) : null}
            {isFileDropActive ? (
              <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center rounded-[6px] border-2 border-dashed border-[color-mix(in_srgb,var(--accent-strong)_60%,transparent)] bg-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)]">
                <span className="rounded-[6px] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)] shadow-[var(--shadow)]">
                  {translate('sessionPane.dropHere', {
                    path: getSessionCwd(sessionId) ?? translate('sessionPane.homeDirectory'),
                  })}
                </span>
              </div>
            ) : null}
            {/* tmux pane 분할은 상단 윈도우 바의 "분할" 버튼(또는 Ctrl-b % / ")으로 한다.
                pane 마다 떠 헷갈리던 floating │/─ 버튼은 제거했다. */}
            {controller.shouldShowConnectionOverlay && isPrimaryTmuxOverlayPane ? (
              <TerminalConnectionOverlay
                error={tab?.status === 'error'}
                title={controller.connectionOverlayTitle}
                message={tailnetFailureMessage ?? controller.connectionOverlayMessage}
                stages={connectionStages}
                steps={tab?.connectionHops}
                showRetry={tab?.connectionProgress?.retryable !== false}
                onRetry={() => {
                  void onRetry?.();
                }}
                onClose={() => {
                  void onClose?.();
                }}
                showCancel={
                  (tab?.connectionProgress?.stage === 'reconnecting' ||
                    tailnetAuthInFlight) &&
                  tab?.status !== 'error'
                }
                cancelLabel={
                  tailnetAuthInFlight ? translate('common.cancel') : undefined
                }
                onCancel={() => {
                  if (tailnetAuthInFlight && tailnetIdOfHost) {
                    // 인증을 접으면 준비 단계가 실패로 끝나고 연결도 그 이유로 멈춘다.
                    // 노드도 함께 내려간다(코어가 처리) — 설정 화면도 같이 정리된다.
                    void cancelTailnet(tailnetIdOfHost);
                    return;
                  }
                  void onCancelReconnect?.();
                }}
                secondaryActionLabel={
                  // 링크가 있으면 할 일은 브라우저로 돌아가는 것뿐이다. 복구 동작을 내밀지
                  // 않는다 — 그 판단은 코어가 한다.
                  tailnetAuthUrl ? translate('misc.reopenBrowser') : undefined
                }
                onSecondaryAction={
                  tailnetAuthUrl
                    ? () => void openExternalUrl(tailnetAuthUrl)
                    : undefined
                }
              />
            ) : null}
            <TerminalAutocompleteOverlay
              suggestions={controller.autocompleteSuggestions}
              command={controller.autocompleteCommand}
              anchor={controller.autocompleteAnchor}
              selectedIndex={controller.autocompleteSelectedIndex}
              onAccept={controller.acceptAutocompleteSuggestion}
            />
            <SnippetVariablesDialog
              pending={controller.autocompletePendingSnippet}
              onConfirm={controller.confirmAutocompleteSnippet}
              onCancel={controller.cancelAutocompleteSnippet}
            />
          </div>
        </div>

      </div>
      {/* 하단 상태바들은 서로 바짝 붙이고, 아래 여백은 이 컨테이너에서 한 번만 준다.
          각 바가 아래 여백을 들고 있으면 여러 개가 쌓일 때 간격이 그만큼 배로 벌어진다.
          tmux 경로(SessionShell)도 같은 statusBarStack 을 쓴다 — 컨테이너가 갈리면 같은
          바가 연결 방식에 따라 다른 간격으로 놓인다.
          담을 바가 하나도 없으면(분할 pane 등) 이 줄 자체를 두지 않는다 — 빈 컨테이너의
          padding 이 pane 바닥에 몇 px 씩 남는다. */}
      {showStatusBarStack ? (
        <div
          className={cn(
            statusBarStack,
            // 아래 여백만 없애 바가 카드 바닥에 닿게 한다. 위쪽 gap 을 음수 마진으로 지우려
            // 했다가 pane 이 화면 밖으로 11px 흘러나갔다 — flex 에서 마지막 자식의 음수 top
            // 마진은 남는 공간 계산을 키워 flex-1 인 터미널이 컨테이너보다 커진다.
            'pb-0',
            showHeader && 'px-0 pt-[0.25rem]',
          )}
        >
          {/* mosh 는 자기 줄에 둔다. tmux·자원 바와 같이 뜨는 조합이 아니라 어차피 한 줄이다. */}
          {tab?.moshState ? (
            <TerminalMoshStatusBar
              state={tab.moshState}
              lastResponseAt={tab.lastMoshResponseAt ?? null}
            />
          ) : null}
          {/* 세션 상태바. 화면을 혼자 쓸 때만 그린다 — 분할이면 pane 마다 바가 하나씩 붙어
              아래가 줄로 가득 찬다(그쪽은 pane 헤더가 종류·대상을 들고 있다). tmux pane 도
              그리지 않는다: 그룹 하단에 한 줄이 따로 있어 같은 값이 두 줄로 뜬다. */}
          {isTmuxPane || !soloView ? null : (
            <TerminalSessionStatusBar
              sessionId={sessionId}
              status={hostMetrics.status}
              metrics={hostMetrics.metrics}
              onRetry={hostMetrics.retry}
              rttMs={tab?.lastRttMs ?? null}
              // 이력은 재연결을 건너 이어져야 한다 — sessionId 는 재연결마다 새로 발급된다.
              historyKey={tab?.stableId ?? null}
              // 분할이면 종류·대상은 pane 헤더가 이미 들고 있다 — 같은 것을 두 번 두지 않는다.
              kindChip={
                showHeader
                  ? null
                  : resolveSessionKindChip({
                      host: props.host,
                      shellKind: tab?.shellKind,
                      hops: tab?.connectionHops,
                      awsTransport: tab?.awsTransport,
                    })
              }
              kindDetail={showHeader ? null : awsTransportText.tooltip}
              hopRows={showHeader ? [] : buildHopRows(tab?.connectionHops)}
              // 감지만 된 상태에서는 버전을, 붙어 있으면 그룹 하단바가 세션명을 보여 준다.
              tmuxLabel={
                tab?.tmuxAvailable && !tab.tmux
                  ? translate('sessionStatusBar.tmuxDetected', {
                      version: tab.tmuxAvailable.version,
                    })
                  : null
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
