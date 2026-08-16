import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import {
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from '@shared';
import { cn } from '../../lib/cn';
import { resolveTailnetTargetAddress } from '../../lib/host-tailnet';
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
import { AiChatPanel } from './AiChatPanel';
import { TerminalChatToastRegion } from './TerminalChatToastRegion';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';
import { TerminalHostStatusBar } from './TerminalHostStatusBar';
import { TerminalMoshStatusBar } from './TerminalMoshStatusBar';
import { TerminalTmuxStatusBar } from './TerminalTmuxStatusBar';
import { statusBarStack } from './terminalStatusBarChrome';
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
import { supportsTmuxControlMode } from '../../lib/tmux-version';
import { useTranslation } from 'react-i18next';

// PASSTHROUGH_TMUX_COMMAND: control mode floor(2.6) 미만 tmux 를 일반 SSH 세션으로 띄울
// 때 접속 직후 셸에 자동 입력하는 호환 attach-or-create 명령. 모든 tmux 버전에서 동작
// (attach 실패 시 new 로 폴백). 1.8+ 면 'tmux new -A' 한 줄도 되지만, floor 미만(=구버전)
// 환경의 폭넓은 호환을 위해 가장 보수적인 폴백 형태를 쓴다.
const PASSTHROUGH_TMUX_COMMAND = 'tmux attach 2>/dev/null || tmux new';

export function TerminalSessionPane(props: TerminalSessionPaneProps) {
  const { t: translate } = useTranslation();
  const {
    sessionId,
    title,
    visible,
    active,
    style,
    showHeader = false,
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
  const tailnetIdOfHost =
    props.host && isSshHostRecord(props.host) ? props.host.tailnetId?.trim() : undefined;
  // 진단줄이 넷맵에서 찾아야 하는 기기를 고르는 데 쓴다(점프가 있으면 첫 홉).
  const hosts = useAppStore((state) => state.hosts);


  const connectHost = useAppStore((state) => state.connectHost);
  const killTmuxSession = useAppStore((state) => state.killTmuxSession);
  // tmux 하단바 "열기" — 같은 호스트로 control mode(tmux -CC) 연결을 시작한다(기본 dolgate 세션).
  // 이 세션(tab.sessionId)의 탭 자리를 재사용해 "현재 화면에서" tmux 가 열리게 한다.
  const handleOpenTmux = useCallback(() => {
    if (!tab?.hostId) {
      return;
    }
    const version = tab.tmuxAvailable?.version;
    // control mode floor(2.6) 미만 tmux 는 control client 사이즈 모델(refresh-client -C)
    // 이 없어 -CC 가 제대로 동작하지 않는다. 이 경우 control mode 대신 일반 SSH 세션을
    // 열고 접속 직후 호환 attach-or-create 명령을 자동 입력해 passthrough 로 tmux 를 띄운다.
    if (!supportsTmuxControlMode(version)) {
      void connectHost(
        tab.hostId,
        120,
        32,
        undefined,
        false, // tmux=false → 일반 SSH 세션(control mode 아님)
        undefined,
        tab.sessionId,
        undefined,
        undefined,
        PASSTHROUGH_TMUX_COMMAND, // startupCommandOverride
      );
      return;
    }
    void connectHost(
      tab.hostId,
      120,
      32,
      undefined,
      true,
      undefined,
      tab.sessionId,
      undefined,
      version,
    );
  }, [connectHost, tab?.hostId, tab?.sessionId, tab?.tmuxAvailable?.version]);
  // 하단바 드롭다운에서 감지된 특정 tmux 세션 [attach] — 그 세션 이름으로 control mode 진입.
  const handleAttachTmuxSession = useCallback(
    (name: string) => {
      if (!tab?.hostId) {
        return;
      }
      // tmux 세션 이름은 작은따옴표로 감싸 셸 인젝션을 막는다(이름 내 ' 는 escape).
      const quoted = `'${name.replace(/'/g, "'\\''")}'`;
      void connectHost(
        tab.hostId,
        120,
        32,
        undefined,
        true,
        `tmux -CC attach -t ${quoted}`,
        tab.sessionId,
        undefined,
        tab.tmuxAvailable?.version,
      );
    },
    [connectHost, tab?.hostId, tab?.sessionId, tab?.tmuxAvailable?.version],
  );
  // 하단바 드롭다운에서 이름 지정 신규 tmux 세션 생성 — new-session -s <name>(strict new;
  // 이름 충돌 시 tmux 에러 → 연결 실패 오버레이). attach 와 동일 escape, 현재 탭 재사용.
  const handleCreateTmuxSession = useCallback(
    (name: string) => {
      if (!tab?.hostId) {
        return;
      }
      const quoted = `'${name.replace(/'/g, "'\\''")}'`;
      void connectHost(
        tab.hostId,
        120,
        32,
        undefined,
        true,
        `tmux -CC new-session -s ${quoted}`,
        tab.sessionId,
        undefined,
        tab.tmuxAvailable?.version,
      );
    },
    [connectHost, tab?.hostId, tab?.sessionId, tab?.tmuxAvailable?.version],
  );
  // 감지 하단바에서 원격 tmux 세션 종료 — attach 없이. sessionId(이 SSH 세션)를 넘기면
  // Go runtime 이 control 세션이 아님을 보고 보조 exec 채널로 kill-session 후 목록을 재감지한다.
  const handleKillTmuxSession = useCallback(
    (name: string) => {
      killTmuxSession(sessionId, name);
    },
    [killTmuxSession, sessionId],
  );
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
  const aiPanelOpen = useAppStore(
    (state) => state.aiConversations?.[sessionId]?.open ?? false,
  );
  const aiPanelWidth = useAppStore((state) => state.aiPanelWidth);
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
    enabled:
      hostMetricsEnabled &&
      tab?.source === 'host' &&
      tab?.status === 'connected' &&
      !tab?.tmux,
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
  const toggleAiPanel = useAppStore((state) => state.toggleAiPanel);
  // 선택/출력 캡처는 stableId 로 살아있는 런타임에서 읽는다(재연결로 sessionId가 바뀌어도 안정).
  const stableId = tab?.stableId ?? sessionId;
  const handlePaneKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // ⌘I / Ctrl+I: AI 패널 토글. 나머지 단축키(검색 등)는 컨트롤러로 위임.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (event.key === 'i' || event.key === 'I')
      ) {
        event.preventDefault();
        toggleAiPanel(sessionId);
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
    [controller, sessionId, toggleAiPanel],
  );

  const [serialNotice, setSerialNotice] = useState<string | null>(null);

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

  // Share 옆에 놓이는 AI 패널 토글(누르면 열림/닫힘). active=열림 상태 강조.
  const aiToggleButton = (
    <Button
      variant="secondary"
      size="sm"
      active={aiPanelOpen}
      className="min-h-9 rounded-full px-3.5"
      onClick={() => toggleAiPanel(sessionId)}
      title={translate('sessionPane.aiTitle')}
      aria-label={translate(aiPanelOpen ? 'sessionPane.aiClose' : 'sessionPane.aiOpen')}
    >
      AI
    </Button>
  );

  return (
    <div
      className={cn(
        'absolute inset-0 min-h-0 flex-col gap-[0.7rem]',
        visible || active
          ? 'flex pointer-events-auto opacity-100'
          : 'hidden pointer-events-none opacity-0',
        showHeader && 'p-[0.4rem]',
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

      {showHeader ? (
        <TerminalPaneHeader
          sessionId={sessionId}
          title={title}
          active={active}
          draggingDisabled={draggingDisabled}
          closingDisabled={!onClose || tab?.status === 'disconnecting'}
          onFocus={onFocus}
          onClose={() => {
            void onClose?.();
          }}
          onStartDrag={props.onStartDrag}
          onEndDrag={props.onEndDrag}
        />
      ) : null}

      {tab?.errorMessage ? (
        <NoticeCard tone="danger" className="mx-[0.55rem] mt-[0.55rem]" role="alert">
          {tailnetFailureMessage ?? connectionFailurePresentation?.message ?? tab.errorMessage}
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
          {controller.canShareSession ? (
            <TerminalSharePopover
              anchorRef={controller.sharePopoverRef}
              showHeader={showHeader}
              open={controller.sharePopoverOpen}
              actions={serialActions}
              aiToggle={aiToggleButton}
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
          ) : (
            // 공유 불가 세션엔 Share 팝오버가 없으므로 AI 토글만 같은 위치에 띄운다.
            <div
              className={cn(
                'absolute right-[0.85rem] top-[0.85rem] z-[4] flex items-center',
                showHeader && 'right-[0.8rem] top-[0.8rem]',
              )}
            >
              {aiToggleButton}
            </div>
          )}

          <div
            ref={controller.containerRef}
            className={cn(
              'relative mx-[0.35rem] mt-[0.35rem] mb-[0.2rem] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[6px] bg-[color-mix(in_srgb,var(--surface)_96%,transparent_4%)] p-0 [&_.xterm]:min-h-full [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm-viewport]:min-h-full [&_.xterm-viewport]:h-full [&_.xterm-viewport]:w-full [&_.xterm-viewport]:bg-transparent [&_.xterm-viewport]:rounded-none',
              showHeader &&
                'mx-[0.35rem] mb-[0.35rem] mt-0 rounded-b-[6px] rounded-t-none border border-[var(--border)] border-t-0',
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
        {aiPanelOpen ? (
          <AiChatPanel sessionId={sessionId} stableId={stableId} width={aiPanelWidth} />
        ) : null}
      </div>
      {/* 하단 상태바들은 서로 바짝 붙이고, 아래 여백은 이 컨테이너에서 한 번만 준다.
          각 바가 아래 여백을 들고 있으면 여러 개가 쌓일 때 간격이 그만큼 배로 벌어진다.
          tmux 경로(SessionShell)도 같은 statusBarStack 을 쓴다 — 컨테이너가 갈리면 같은
          바가 연결 방식에 따라 다른 간격으로 놓인다. */}
      <div className={statusBarStack}>
        <TerminalHostStatusBar
          status={hostMetrics.status}
          metrics={hostMetrics.metrics}
          onRetry={hostMetrics.retry}
        />
        {tab?.moshState ? (
          <TerminalMoshStatusBar
            state={tab.moshState}
            lastResponseAt={tab.lastMoshResponseAt ?? null}
          />
        ) : null}
        {tab?.tmuxAvailable && !tab.tmux ? (
          <TerminalTmuxStatusBar
            version={tab.tmuxAvailable.version}
            sessions={tab.tmuxAvailable.sessions}
            onOpen={handleOpenTmux}
            onAttachSession={handleAttachTmuxSession}
            onCreateSession={handleCreateTmuxSession}
            onKillSession={handleKillTmuxSession}
          />
        ) : null}
      </div>
    </div>
  );
}
