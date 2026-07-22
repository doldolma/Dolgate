import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type React from 'react';
import type { SessionShareSnapshotInput, TerminalTab } from '@shared';
import type { Terminal } from 'xterm';
import {
  createTerminalRuntime,
  type TerminalRuntime,
} from '../lib/terminal-runtime';
import { createTerminalResizeScheduler } from '../components/terminal-resize';
import {
  loadScrollbackFromSession,
  registerTerminalHooks,
  saveScrollbackSnapshot,
  takeScrollbackSnapshot,
  unregisterTerminalHooks,
  type TerminalHooks,
} from '../lib/terminal-write-registry';
import {
  clearSessionCwd,
  markSessionConnected,
  setSessionCwd,
  setSessionLastCommandAt,
} from '../lib/terminal-cwd-registry';
import {
  registerTerminalFocus,
  unregisterTerminalFocus,
} from '../lib/terminal-focus-registry';
import { createZmodemController } from '../lib/zmodem/zmodem-controller';
import {
  installTerminalShellIntegration,
  reinjectTerminalShellIntegration,
  writeTerminalBinaryInput,
  tmuxSplitPane,
  tmuxNewWindow,
  tmuxKillPane,
  tmuxDetach,
  tmuxCommand,
} from '../services/desktop/terminal';
import {
  applyTerminalInput,
  createEmptyCommandBuffer,
} from '../lib/terminal-autocomplete';
import { detectsSubshellEntry } from '../lib/subshell-detect';
import {
  mapPrefixKey,
  resolveSiblingWindowId,
  tmuxPrefixByteFromKey,
  type TmuxPrefixResolverContext,
} from '../lib/tmux-prefix';
import { saveZmodemDownload } from '../services/desktop/files';
import { appStore } from '../store/appStore';
import {
  clearZmodemAbort,
  registerZmodemAbort,
} from '../store/slices/zmodemSlice';
import type { TerminalSessionPaneProps } from '../components/terminal-workspace/types';
import {
  SESSION_SHARE_CHAT_TOAST_TTL_MS,
  didTerminalSessionJustConnect,
  getVisibleSessionShareChatNotifications,
  isPendingConnectionSessionId,
  mergeSessionShareSnapshotKinds,
  resolveConnectionOverlayMessage,
  resolveConnectionOverlayTitle,
  resolveTerminalRuntimeWebglEnabled,
  shouldOpenTerminalSearch,
  shouldShowSessionOverlay,
} from '../components/terminal-workspace/terminalSessionHelpers';
import {
  parseCwdFromOsc7,
  useTerminalAutocomplete,
} from './useTerminalAutocomplete';
import type { CommandFinishedInfo } from '../lib/command-notification';

// tmux 윈도우 전환(Ctrl-b n/p/숫자/l): 로컬 뷰를 즉시 전환(selectTmuxWindow)하고
// select-window 도 함께 보낸다. 'last'(l)는 직전 윈도우를 로컬에서 추적하지 않으므로
// last-window 명령으로 서버에 맡기고, 포커스는 %window-pane-changed 가 따라온다.
function dispatchTmuxWindowNav(
  paneSessionId: string,
  pane: { controlSessionId: string; windowId: string },
  context: TmuxPrefixResolverContext,
  target: 'next' | 'prev' | 'last' | number,
): void {
  if (target === 'last') {
    void tmuxCommand(paneSessionId, 'last-window');
    return;
  }
  const state = appStore.getState();
  const groupWorkspaces = state.workspaces.filter(
    (w) => w.tmux?.controlSessionId === pane.controlSessionId,
  );
  const targetWorkspace =
    typeof target === 'number'
      ? groupWorkspaces.find((w) => w.tmux?.index === target)
      : (() => {
          const windowId = resolveSiblingWindowId(
            context.orderedWindowIds,
            pane.windowId,
            target === 'next' ? 1 : -1,
          );
          return windowId
            ? groupWorkspaces.find((w) => w.tmux?.windowId === windowId)
            : undefined;
        })();
  if (targetWorkspace) {
    state.selectTmuxWindow(targetWorkspace.id);
  }
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /mac/i.test(navigator.userAgent) || /mac/i.test(navigator.platform);
}

function debugSessionShareRenderer(
  message: string,
  payload?: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) {
    return;
  }

  if (payload) {
    console.debug(`[session-share] ${message}`, payload);
    return;
  }

  console.debug(`[session-share] ${message}`);
}

function hasE2ETerminalHook(): boolean {
  return Boolean((window as Window & { __dolsshE2E?: unknown }).__dolsshE2E);
}

function publishTerminalE2EState(
  sessionId: string,
  state: Record<string, unknown> | null,
): void {
  if (!hasE2ETerminalHook()) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent('dolssh:e2e-terminal-state', {
      detail: {
        sessionId,
        state,
      },
    }),
  );
}

export function useTerminalSessionViewController({
  sessionId,
  title,
  visible,
  active,
  viewActivationKey,
  layoutKey,
  appearance,
  terminalWebglEnabled,
  terminalAutocompleteEnabled,
  tmuxPrefixKey,
  tmuxCell,
  interactiveAuth,
  onFocus,
  onStartSessionShare,
  onUpdateSessionShareSnapshot,
  onSetSessionShareInputEnabled,
  onStopSessionShare,
  onOpenSessionShareChatWindow,
  onSendInput,
  onSendBinaryInput,
  host,
  tab,
  sessionShareChatNotifications,
  onDismissSessionShareChatNotification,
  onRespondInteractiveAuth,
  onReopenInteractiveAuthUrl,
  onClearPendingInteractiveAuth,
  onSessionData,
  onResizeSession,
  snippets,
  onCommandFinished,
}: TerminalSessionPaneProps & {
  snippets?: readonly { label: string; command: string; keyword?: string | null }[];
  onCommandFinished?: (info: CommandFinishedInfo) => void;
}) {
  // 재연결로 sessionId가 바뀌어도 불변인 안정 식별자. 터미널(xterm) 인스턴스 생성/해제를
  // 이 값에 묶어, 재연결 시 dispose/recreate 없이 스크롤백을 보존한다(입력·resize·데이터
  // 구독은 계속 sessionId 기준으로 동작 — liveSessionIdRef/데이터 구독 effect 참고).
  const stableId = tab?.stableId ?? sessionId;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const runtimeRef = useRef<TerminalRuntime | null>(null);
  const resizeSchedulerRef = useRef<ReturnType<
    typeof createTerminalResizeScheduler
  > | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sharePopoverRef = useRef<HTMLDivElement | null>(null);
  const previousSessionStatusRef = useRef<TerminalTab['status'] | null>(null);
  const liveSessionIdRef = useRef(sessionId);
  const liveSessionStatusRef = useRef<TerminalTab['status'] | null>(
    tab?.status ?? null,
  );
  const liveSessionShareStatusRef = useRef(
    tab?.sessionShare?.status ?? 'inactive',
  );
  const liveAppearanceRef = useRef(appearance);
  const liveOnFocusRef = useRef(onFocus);
  const liveUpdateSessionShareSnapshotRef = useRef(onUpdateSessionShareSnapshot);
  const liveOnSendInputRef = useRef(onSendInput);
  const liveOnSendBinaryInputRef = useRef(onSendBinaryInput);
  const liveOnResizeSessionRef = useRef(onResizeSession);
  // tmux prefix(Ctrl-b) 상태머신. control mode pane + 토글 on 일 때만 동작한다.
  // tab.tmux 정보(controlSessionId/windowId)와 토글 값을 live ref 로 들고, onData 에서
  // prefix 다음 키 한 개를 가로채 네이티브 tmux 동작으로 매핑한다.
  const liveTmuxPaneRef = useRef(tab?.tmux ?? null);
  const liveTmuxPrefixByteRef = useRef(tmuxPrefixByteFromKey(tmuxPrefixKey));
  const tmuxPrefixArmedRef = useRef(false);
  // onData(터미널 init effect) 에서 최신 핸들러를 쓰기 위한 live ref. 초기값은 no-op.
  const liveHandleTmuxPrefixInputRef = useRef<(data: string) => boolean>(
    () => false,
  );
  const liveHasOutputRef = useRef(tab?.hasReceivedOutput ?? false);
  // tmux control mode pane 여부 + tmux 레이아웃 칸 수. pane 의 xterm 을 컨테이너에 fit 하지
  // 않고 이 칸 수로 고정해 tmux pane 크기와 1:1 일치시킨다(분할 셰이크 제거). 개별 resize
  // 보고도 막는다(워크스페이스가 control-client total 을 1회 보고).
  const liveIsTmuxPaneRef = useRef(Boolean(tab?.tmux));
  const liveTmuxCellRef = useRef<{ cols: number; rows: number } | null>(
    tmuxCell ?? null,
  );
  const shareSnapshotDirtyRef = useRef(false);
  const pendingShareSnapshotKindRef =
    useRef<SessionShareSnapshotInput['kind'] | null>(null);
  const shareSnapshotInFlightRef = useRef(false);
  const chatNotificationTimeoutsRef = useRef<Map<string, number>>(new Map());
  const e2eTerminalHookEnabledRef = useRef(hasE2ETerminalHook());
  const [promptResponses, setPromptResponses] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sharePopoverOpen, setSharePopoverOpen] = useState(false);
  const [shareCopyStatus, setShareCopyStatus] = useState<string | null>(null);
  const [terminalInitError, setTerminalInitError] = useState<string | null>(
    null,
  );
  const [autocompleteAnchor, setAutocompleteAnchor] = useState({
    left: 8,
    top: 32,
    openAbove: false,
  });
  const [terminalAlternateScreen, setTerminalAlternateScreen] = useState(false);

  const sendAutocompleteInput = useCallback((data: string) => {
    const currentSessionId = liveSessionIdRef.current;
    const currentStatus = liveSessionStatusRef.current;
    if (
      isPendingConnectionSessionId(currentSessionId) ||
      currentStatus === 'pending' ||
      currentStatus === 'error' ||
      currentStatus === 'disconnecting'
    ) {
      return;
    }
    liveOnSendInputRef.current?.(currentSessionId, data);
  }, []);

  // 같은 control 세션의 window id 목록을 tabStrip(워크스페이스 탭) 순서대로 모은다.
  // n/p(다음/이전 window) 전환의 순서 기준이다.
  const resolveTmuxWindowOrder = useCallback(
    (controlSessionId: string): string[] => {
      // tmux 윈도우는 top-level tabStrip 이 아니라 그룹 안의 workspace 들이다.
      // controlSessionId 로 묶어 tmux index 순으로 정렬해 윈도우 id 순서를 만든다(n/p 전환).
      const state = appStore.getState();
      return state.workspaces
        .filter(
          (w) => w.tmux?.controlSessionId === controlSessionId && w.tmux.windowId,
        )
        .slice()
        .sort((a, b) => (a.tmux?.index ?? 0) - (b.tmux?.index ?? 0))
        .map((w) => w.tmux!.windowId);
    },
    [],
  );

  // prefix(Ctrl-b) 직후 키를 네이티브 tmux 동작으로 실행한다. control 명령은 pane 의
  // 가상 sessionId 로 보내며(Go 가 controlSessionId 로 라우팅), passthrough 면 그대로 send-keys 한다.
  const dispatchTmuxPrefixData = useCallback(
    (data: string): boolean => {
      const pane = liveTmuxPaneRef.current;
      if (!pane) {
        return false;
      }
      const paneSessionId = liveSessionIdRef.current;
      const context: TmuxPrefixResolverContext = {
        orderedWindowIds: resolveTmuxWindowOrder(pane.controlSessionId),
        currentWindowId: pane.windowId,
        currentPaneId: pane.paneId,
        prefixByte: liveTmuxPrefixByteRef.current,
      };
      const mapped = mapPrefixKey(data, context);
      if (!mapped) {
        return false;
      }
      const { action } = mapped;
      switch (action.kind) {
        case 'newWindow':
          void tmuxNewWindow(paneSessionId);
          break;
        case 'splitPane':
          void tmuxSplitPane(paneSessionId, action.direction);
          break;
        case 'command':
          // 타깃까지 포함한 완전한 tmux 명령(select-pane/resize-pane/...)을 그대로 보낸다.
          void tmuxCommand(paneSessionId, action.command);
          break;
        case 'windowNav':
          dispatchTmuxWindowNav(paneSessionId, pane, context, action.target);
          break;
        case 'prompt': {
          // 텍스트 입력이 필요한 명령(rename/명령 프롬프트) → 하단 입력 오버레이를 연다.
          const state = appStore.getState();
          const currentName =
            action.mode === 'rename-window'
              ? (state.workspaces.find(
                  (w) =>
                    w.tmux?.controlSessionId === pane.controlSessionId &&
                    w.tmux?.windowId === pane.windowId,
                )?.tmux?.name ?? '')
              : '';
          state.openTmuxCommandPrompt({
            sessionId: paneSessionId,
            mode: action.mode,
            windowId:
              action.mode === 'rename-window' ? pane.windowId : undefined,
            initialValue: currentName,
          });
          break;
        }
        case 'killWindow': {
          const state = appStore.getState();
          const ws = state.workspaces.find(
            (w) =>
              w.tmux?.controlSessionId === pane.controlSessionId &&
              w.tmux?.windowId === pane.windowId,
          );
          if (ws) {
            void state.closeWorkspace(ws.id);
          }
          break;
        }
        case 'detach': {
          // 탭 × detach 와 동일한 정리 경로(로컬 그룹/워크스페이스 제거 + 탭 전환)를 탄다.
          // raw tmuxDetach 만 보내면 control 채널은 끊겨도 UI 가 죽은 pane 을 남겨 화면이 멈춘다.
          const state = appStore.getState();
          const ws = state.workspaces.find(
            (w) => w.tmux?.controlSessionId === pane.controlSessionId,
          );
          if (ws) {
            void state.detachTmuxWorkspace(ws.id);
          } else {
            void tmuxDetach(paneSessionId);
          }
          break;
        }
        case 'killPane':
          void tmuxKillPane(paneSessionId);
          break;
        case 'passthrough':
          // 미매핑 키나 리터럴 Ctrl-b 는 그대로 send-keys 로 전달한다.
          sendAutocompleteInput(action.data);
          break;
      }
      // 첫 문자만 소비했고 뒤에 더 있으면(붙여넣기 등) 일반 입력으로 다시 처리한다.
      const rest = data.slice(mapped.consumed);
      if (rest.length > 0) {
        liveAutocompleteInputRef.current(rest);
      }
      return true;
    },
    [resolveTmuxWindowOrder, sendAutocompleteInput],
  );

  // onData 진입점. tmux prefix 토글이 켜진 control mode pane 에서 Ctrl-b 시퀀스를
  // 가로채 네이티브 동작으로 매핑하고, 그 외에는 false 를 돌려 평소 경로로 흘린다.
  const handleTmuxPrefixInput = useCallback(
    (data: string): boolean => {
      if (!liveTmuxPaneRef.current || data.length === 0) {
        tmuxPrefixArmedRef.current = false;
        return false;
      }
      if (tmuxPrefixArmedRef.current) {
        tmuxPrefixArmedRef.current = false;
        return dispatchTmuxPrefixData(data);
      }
      const prefixByte = liveTmuxPrefixByteRef.current;
      if (data === prefixByte) {
        // prefix 단독 청크 → arm 하고 키 입력을 보류한다(다음 청크에서 매핑).
        tmuxPrefixArmedRef.current = true;
        return true;
      }
      const prefixIndex = data.indexOf(prefixByte);
      if (prefixIndex < 0) {
        return false;
      }
      // 한 청크 안에 Ctrl-b 와 다음 키가 함께 온 경우(빠른 타이핑/붙여넣기). 앞부분은
      // 평소대로 보내고, Ctrl-b 다음 키부터 매핑한다.
      const before = data.slice(0, prefixIndex);
      const after = data.slice(prefixIndex + 1);
      if (before.length > 0) {
        liveAutocompleteInputRef.current(before);
      }
      if (after.length === 0) {
        tmuxPrefixArmedRef.current = true;
        return true;
      }
      dispatchTmuxPrefixData(after);
      return true;
    },
    [dispatchTmuxPrefixData],
  );

  useEffect(() => {
    liveHandleTmuxPrefixInputRef.current = handleTmuxPrefixInput;
  }, [handleTmuxPrefixInput]);

  const autocomplete = useTerminalAutocomplete({
    sessionId,
    enabled:
      terminalAutocompleteEnabled &&
      host?.kind !== 'serial' &&
      tab?.shellKind !== 'aws-ecs-exec',
    connected: tab?.status === 'connected',
    // AWS SSM도 Go manager가 연결 직후 shell integration을 1회 설치하고,
    // autocomplete probe는 첫 OSC 133 prompt marker 이후에만 보내므로 eager prepare가 안전하다.
    lazyPrepare: false,
    sendInput: sendAutocompleteInput,
    snippets,
    onCommandFinished,
  });
  const liveAutocompleteInputRef = useRef(autocomplete.handleInput);
  const liveAutocompleteVisibleRef = useRef(false);
  const liveAutocompleteShellMarkerRef = useRef(autocomplete.handleShellMarker);
  const liveAutocompleteCwdRef = useRef(autocomplete.handleCwd);
  // 서브셸 진입 감지용 명령줄 버퍼. autocomplete 훅과 독립적으로(설정 off 여도) 실행돼
  // 사용자가 방금 실행한 명령을 재구성한다. \r 마다 리셋되므로 세션 간 오염은 없다.
  const subshellCommandBufferRef = useRef(createEmptyCommandBuffer());

  useEffect(() => {
    liveAutocompleteInputRef.current = terminalAlternateScreen
      ? sendAutocompleteInput
      : autocomplete.handleInput;
    liveAutocompleteVisibleRef.current =
      !terminalAlternateScreen && autocomplete.suggestions.length > 0;
    liveAutocompleteShellMarkerRef.current = autocomplete.handleShellMarker;
    liveAutocompleteCwdRef.current = autocomplete.handleCwd;
  }, [
    autocomplete.handleCwd,
    autocomplete.handleInput,
    autocomplete.handleShellMarker,
    autocomplete.suggestions.length,
    sendAutocompleteInput,
    terminalAlternateScreen,
  ]);

  // 셸 통합(OSC 7 cwd / OSC 133)은 평소 autocomplete prepare 안에서 설치되지만,
  // autocomplete를 꺼도 파일 드롭 업로드의 cwd 인식·명령 알림이 동작하도록,
  // 업로드 가능한(ssh/aws-ec2/warpgate) 연결 세션에서는 probe 없는 전용 경로로
  // 한 번 보장한다. autocomplete가 켜져 있으면 그 훅이 이미 설치하므로 생략한다.
  const shellIntegrationEnsuredRef = useRef(false);
  useEffect(() => {
    if (tab?.status !== 'connected') {
      shellIntegrationEnsuredRef.current = false;
      return;
    }
    // control mode tmux pane(가상 세션)은 자동완성 prepare 경로가 OSC 133 통합을 깔아주지
    // 않는다. 명시적으로 1회 설치해 pane 셸에서도 마커가 흐르게 한다(→ integrationReady →
    // 자동완성 동작). 설치 명령의 에코는 Go(tmux Manager)의 pane 핸드셰이크가 숨긴다.
    if (tab?.tmux) {
      if (shellIntegrationEnsuredRef.current) {
        return;
      }
      shellIntegrationEnsuredRef.current = true;
      void installTerminalShellIntegration(sessionId).catch(() => undefined);
      return;
    }
    const autocompleteActive =
      terminalAutocompleteEnabled &&
      host?.kind !== 'serial' &&
      tab?.shellKind !== 'aws-ecs-exec';
    const sftpCapable =
      host?.kind === 'ssh' ||
      host?.kind === 'aws-ec2' ||
      host?.kind === 'warpgate-ssh';
    if (
      autocompleteActive ||
      !sftpCapable ||
      shellIntegrationEnsuredRef.current
    ) {
      return;
    }
    shellIntegrationEnsuredRef.current = true;
    void installTerminalShellIntegration(sessionId).catch(() => undefined);
  }, [
    host?.kind,
    sessionId,
    tab?.shellKind,
    tab?.status,
    tab?.tmux,
    terminalAutocompleteEnabled,
  ]);

  useEffect(() => {
    if (!interactiveAuth || interactiveAuth.sessionId !== sessionId) {
      setPromptResponses([]);
      return;
    }

    setPromptResponses(interactiveAuth.prompts.map(() => ''));
  }, [interactiveAuth, sessionId]);

  useEffect(() => {
    setTerminalInitError(null);
    setSearchOpen(false);
    setSearchQuery('');
    previousSessionStatusRef.current = null;
  }, [sessionId]);

  const liveSourceLabelRef = useRef('');
  useEffect(() => {
    liveSessionIdRef.current = sessionId;
    liveSessionStatusRef.current = tab?.status ?? null;
    liveSessionShareStatusRef.current = tab?.sessionShare?.status ?? 'inactive';
    liveSourceLabelRef.current = host?.label ?? title;
    // 연결 경과시간 표시용: 처음 connected 된 시각을 1회 기록(hover 카드가 동기 조회).
    if (tab?.status === 'connected') {
      markSessionConnected(sessionId);
    }
  }, [host?.label, sessionId, tab?.sessionShare?.status, tab?.status, title]);

  useEffect(() => {
    liveAppearanceRef.current = appearance;
  }, [appearance]);

  useEffect(() => {
    liveOnFocusRef.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    liveUpdateSessionShareSnapshotRef.current = onUpdateSessionShareSnapshot;
  }, [onUpdateSessionShareSnapshot]);

  useEffect(() => {
    liveOnSendInputRef.current = onSendInput;
  }, [onSendInput]);

  useEffect(() => {
    liveOnSendBinaryInputRef.current = onSendBinaryInput;
  }, [onSendBinaryInput]);

  useEffect(() => {
    liveTmuxPaneRef.current = tab?.tmux ?? null;
    liveIsTmuxPaneRef.current = Boolean(tab?.tmux);
    liveTmuxPrefixByteRef.current = tmuxPrefixByteFromKey(tmuxPrefixKey);
    // pane/세션이 바뀌면 미완 prefix 상태는 폐기한다(다른 pane 으로 키가 새지 않도록).
    tmuxPrefixArmedRef.current = false;
  }, [tab?.tmux, tmuxPrefixKey, sessionId]);

  // tmux 레이아웃 칸 수가 바뀌면(분할/리사이즈로 %layout-change) xterm 을 그 크기로
  // 다시 고정한다. request() → fit(=tmux pane 이면 terminal.resize) → 보고는 억제됨.
  useEffect(() => {
    liveTmuxCellRef.current = tmuxCell ?? null;
    if (tmuxCell) {
      resizeSchedulerRef.current?.request();
    }
  }, [tmuxCell?.cols, tmuxCell?.rows]);

  useEffect(() => {
    liveOnResizeSessionRef.current = onResizeSession;
  }, [onResizeSession]);

  useEffect(() => {
    liveHasOutputRef.current = tab?.hasReceivedOutput ?? false;
  }, [tab?.hasReceivedOutput]);

  useEffect(() => {
    setSharePopoverOpen(false);
    setShareCopyStatus(null);
    shareSnapshotDirtyRef.current = false;
    pendingShareSnapshotKindRef.current = null;
    shareSnapshotInFlightRef.current = false;

    for (const timeoutId of chatNotificationTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    chatNotificationTimeoutsRef.current.clear();
  }, [sessionId]);

  useEffect(
    () => () => {
      for (const timeoutId of chatNotificationTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      chatNotificationTimeoutsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const activeNotificationIds = new Set(
      sessionShareChatNotifications.map((notification) => notification.id),
    );

    for (const notification of sessionShareChatNotifications) {
      if (chatNotificationTimeoutsRef.current.has(notification.id)) {
        continue;
      }

      const timeoutId = window.setTimeout(() => {
        chatNotificationTimeoutsRef.current.delete(notification.id);
        onDismissSessionShareChatNotification(sessionId, notification.id);
      }, SESSION_SHARE_CHAT_TOAST_TTL_MS);
      chatNotificationTimeoutsRef.current.set(notification.id, timeoutId);
    }

    for (const [notificationId, timeoutId] of chatNotificationTimeoutsRef.current.entries()) {
      if (activeNotificationIds.has(notificationId)) {
        continue;
      }

      window.clearTimeout(timeoutId);
      chatNotificationTimeoutsRef.current.delete(notificationId);
    }
  }, [
    onDismissSessionShareChatNotification,
    sessionId,
    sessionShareChatNotifications,
  ]);

  useEffect(() => {
    if (tab?.sessionShare?.status === 'active') {
      return;
    }

    shareSnapshotDirtyRef.current = false;
    pendingShareSnapshotKindRef.current = null;
    shareSnapshotInFlightRef.current = false;
  }, [tab?.sessionShare?.status]);

  useEffect(() => {
    if (!sharePopoverOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (sharePopoverRef.current?.contains(target)) {
        return;
      }
      setSharePopoverOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSharePopoverOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [sharePopoverOpen]);

  const refreshViewport = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal || terminal.rows <= 0) {
      return;
    }
    terminal.refresh(0, terminal.rows - 1);
  }, []);

  const publishCurrentTerminalE2EState = useCallback(() => {
    if (!hasE2ETerminalHook()) {
      return;
    }

    const runtime = runtimeRef.current;
    if (!runtime) {
      publishTerminalE2EState(liveSessionIdRef.current, null);
      return;
    }

    publishTerminalE2EState(liveSessionIdRef.current, {
      snapshot: runtime.captureSnapshot(),
      cols: runtime.terminal.cols,
      rows: runtime.terminal.rows,
      hasOutput: liveHasOutputRef.current,
    });
  }, []);

  const captureShareSnapshot = useCallback(() => {
    const runtime = runtimeRef.current;
    const container = containerRef.current;
    if (!runtime || !container) {
      return null;
    }

    const bounds = container.getBoundingClientRect();
    const viewportWidth = Math.max(0, Math.floor(bounds.width));
    const viewportHeight = Math.max(0, Math.floor(bounds.height));

    return {
      snapshot: runtime.captureSnapshot(),
      cols: runtime.terminal.cols,
      rows: runtime.terminal.rows,
      terminalAppearance: {
        fontFamily: liveAppearanceRef.current.fontFamily,
        fontSize: liveAppearanceRef.current.fontSize,
        lineHeight: liveAppearanceRef.current.lineHeight,
        letterSpacing: liveAppearanceRef.current.letterSpacing,
      },
      viewportPx:
        viewportWidth > 0 && viewportHeight > 0
          ? {
              width: viewportWidth,
              height: viewportHeight,
            }
          : null,
    };
  }, []);

  const flushRequestedShareSnapshot = useCallback(async () => {
    const runtime = runtimeRef.current;
    const updateSnapshot = liveUpdateSessionShareSnapshotRef.current;
    const kind = pendingShareSnapshotKindRef.current;

    if (
      !runtime ||
      !updateSnapshot ||
      !kind ||
      liveSessionShareStatusRef.current !== 'active'
    ) {
      return;
    }

    if (kind === 'refresh' && !shareSnapshotDirtyRef.current) {
      pendingShareSnapshotKindRef.current = null;
      return;
    }

    pendingShareSnapshotKindRef.current = null;
    shareSnapshotInFlightRef.current = true;
    debugSessionShareRenderer('snapshot flushed', {
      sessionId: liveSessionIdRef.current,
      kind,
    });

    const payload = captureShareSnapshot();
    try {
      if (!payload) {
        return;
      }

      shareSnapshotDirtyRef.current = false;
      await updateSnapshot({
        sessionId: liveSessionIdRef.current,
        ...payload,
        kind,
      });
    } finally {
      shareSnapshotInFlightRef.current = false;
      if (pendingShareSnapshotKindRef.current) {
        runtime.scheduleAfterWriteDrain(() => {
          debugSessionShareRenderer('owner runtime write drain reached', {
            sessionId: liveSessionIdRef.current,
            kind: pendingShareSnapshotKindRef.current,
          });
          if (shareSnapshotInFlightRef.current) {
            return;
          }
          void flushRequestedShareSnapshot();
        });
      }
    }
  }, [captureShareSnapshot]);

  const requestShareSnapshot = useCallback(
    (kind: 'refresh' | 'resync' = 'refresh') => {
      if (liveSessionShareStatusRef.current !== 'active') {
        return;
      }

      if (kind === 'refresh' && !shareSnapshotDirtyRef.current) {
        return;
      }

      pendingShareSnapshotKindRef.current = mergeSessionShareSnapshotKinds(
        pendingShareSnapshotKindRef.current,
        kind,
      );
      debugSessionShareRenderer('snapshot requested', {
        sessionId: liveSessionIdRef.current,
        kind: pendingShareSnapshotKindRef.current,
      });

      runtimeRef.current?.scheduleAfterWriteDrain(() => {
        debugSessionShareRenderer('owner runtime write drain reached', {
          sessionId: liveSessionIdRef.current,
          kind: pendingShareSnapshotKindRef.current,
        });
        if (shareSnapshotInFlightRef.current) {
          return;
        }
        void flushRequestedShareSnapshot();
      });
    },
    [flushRequestedShareSnapshot],
  );

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    let runtime: TerminalRuntime;
    try {
      runtime = createTerminalRuntime({
        container: containerRef.current,
        appearance,
        onData: (data) => {
          const currentSessionId = liveSessionIdRef.current;
          const currentStatus = liveSessionStatusRef.current;
          if (
            isPendingConnectionSessionId(currentSessionId) ||
            currentStatus === 'pending' ||
            currentStatus === 'error' ||
            currentStatus === 'disconnecting'
          ) {
            return;
          }
          // tmux prefix(Ctrl-b) 토글이 켜진 control mode pane 이면 prefix 시퀀스를 먼저
          // 가로챈다. 소비했으면(true) 평소 입력 경로로 흘리지 않는다.
          if (liveHandleTmuxPrefixInputRef.current(data)) {
            return;
          }
          liveAutocompleteInputRef.current(data);
          // 서브셸(중첩 ssh·sudo su·docker exec …) 진입을 감지해 셸 통합을 다시 주입한다.
          // autocomplete 게이트와 무관하게 항상 추적하므로 자동완성을 꺼도 동작한다.
          const trackedInput = applyTerminalInput(
            subshellCommandBufferRef.current,
            data,
          );
          subshellCommandBufferRef.current = trackedInput.state;
          if (trackedInput.executed) {
            const currentSettings = appStore.getState().settings;
            if (
              currentSettings?.subshellReinjectEnabled !== false &&
              detectsSubshellEntry(
                trackedInput.executed,
                currentSettings?.subshellReinjectPatterns ?? [],
              )
            ) {
              void reinjectTerminalShellIntegration(
                liveSessionIdRef.current,
              ).catch(() => undefined);
            }
          }
        },
        onBinary: (data) => {
          const currentSessionId = liveSessionIdRef.current;
          const currentStatus = liveSessionStatusRef.current;
          if (
            isPendingConnectionSessionId(currentSessionId) ||
            currentStatus === 'pending' ||
            currentStatus === 'error' ||
            currentStatus === 'disconnecting'
          ) {
            return;
          }
          const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0));
          liveOnSendBinaryInputRef.current?.(currentSessionId, bytes);
        },
        onShellIntegration: (marker) => {
          liveAutocompleteShellMarkerRef.current(marker);
          // 탭 상태 점(하이브리드)용 명령 상태: C=명령 실행 시작, D;<exit>=완료(성공/실패).
          // A/B(프롬프트/입력)는 직전 결과를 유지한다.
          if (marker === 'C') {
            appStore
              .getState()
              .applyTabCommandState(liveSessionIdRef.current, 'running');
          } else if (marker === 'D' || marker.startsWith('D;')) {
            const code =
              marker === 'D' ? 0 : Number(marker.slice(2).split(';')[0]);
            appStore
              .getState()
              .applyTabCommandState(
                liveSessionIdRef.current,
                Number.isFinite(code) && code === 0 ? 'ok' : 'failed',
              );
            setSessionLastCommandAt(liveSessionIdRef.current);
          }
        },
        onCwd: (data) => {
          liveAutocompleteCwdRef.current(data);
          // 터미널 파일 드롭(SFTP 업로드) 핸들러가 드롭 시점에 읽을 수 있도록
          // 세션 cwd를 모듈 레지스트리에 보관한다.
          setSessionCwd(liveSessionIdRef.current, parseCwdFromOsc7(data));
        },
      });
      setTerminalInitError(null);
    } catch (error) {
      console.error('Failed to initialize terminal runtime.', error);
      setTerminalInitError(
        '터미널을 초기화하지 못했습니다. 설정을 확인하거나 앱을 다시 열어주세요.',
      );
      return;
    }

    terminalRef.current = runtime.terminal;
    runtimeRef.current = runtime;
    // 자동 재연결 안내선 출력(write) + 절전 복귀 시 강제 재렌더(refresh)를 위해
    // stableId 기준으로 훅을 등록한다.
    const terminalHooks: TerminalHooks = {
      write: (text: string) => {
        runtime.write(text);
      },
      refresh: () => {
        runtime.repaint();
        resizeSchedulerRef.current?.request();
      },
      serialize: () => runtime.captureRestoreSnapshot(),
      getSessionId: () => liveSessionIdRef.current,
      getCellSize: () => runtime.getCellSize(),
      getSelection: () => runtime.getSelection(),
      captureRecentText: (maxLines: number) => runtime.captureRecentText(maxLines),
      captureTextSnapshot: () => runtime.captureTextSnapshot(),
    };
    registerTerminalHooks(stableId, terminalHooks);
    // 안전망: 이전 터미널이 남긴 스크롤백이 있으면 복원한다.
    //  1) 같은 세션 내 재생성: 모듈 Map(stableId 키) — B1b로 보존되면 비어 있어 no-op.
    //  2) 페이지 리로드(dev vite 등): sessionStorage(sessionId 키) — 리로드에도 살아남는다.
    const restoredSnapshot =
      takeScrollbackSnapshot(stableId) ??
      loadScrollbackFromSession(liveSessionIdRef.current);
    if (restoredSnapshot) {
      runtime.write(restoredSnapshot);
    }
    resizeSchedulerRef.current = createTerminalResizeScheduler({
      fit: () => {
        const cell = liveTmuxCellRef.current;
        if (liveIsTmuxPaneRef.current && cell) {
          // tmux pane: 컨테이너에 fit 하지 않고 tmux 레이아웃 칸 수로 고정한다(셰이크 방지).
          // 단, 숨겨진(display:none → clientWidth/Height 0) pane 에는 resize 하지 않는다.
          // 측정 불가 상태의 xterm 렌더러에 resize 를 강제하면 IdleTaskQueue 의
          // handleResize 가 undefined 렌더러를 건드려 크래시한다(fitAddon.fit 은 0 크기에서
          // 스스로 bail 하지만 terminal.resize 는 무조건 적용되므로 직접 가드한다). 다시
          // 보이면 컨테이너 ResizeObserver(0→N) 가 재요청해 그때 resize 된다.
          const el = containerRef.current;
          if (!el || el.clientWidth === 0 || el.clientHeight === 0) {
            return;
          }
          runtime.terminal.resize(cell.cols, cell.rows);
        } else {
          runtime.fitAddon.fit();
        }
      },
      readSize: () => ({
        cols: runtime.terminal.cols,
        rows: runtime.terminal.rows,
      }),
      afterResize: () => {
        refreshViewport();
        publishCurrentTerminalE2EState();
        if (liveSessionShareStatusRef.current !== 'active') {
          return;
        }
        requestShareSnapshot('resync');
      },
      sendResize: ({ cols, rows }) => {
        // tmux pane 은 개별 크기를 보고하지 않는다(여러 pane 이 단일 control-client 크기를
        // 공유 → pane 별 보고가 서로 덮어써 셰이크). 대신 워크스페이스가 total 을 1회 보고.
        if (liveIsTmuxPaneRef.current) {
          return;
        }
        return liveOnResizeSessionRef.current(liveSessionIdRef.current, cols, rows);
      },
    });

    const handlePointerActivate = () => {
      liveOnFocusRef.current?.();
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
    };
    const handleFocusIn = () => {
      handlePointerActivate();
    };
    const handleFocusOut = () => {
      requestAnimationFrame(() => {
        refreshViewport();
      });
    };

    containerRef.current.addEventListener('mousedown', handlePointerActivate);
    containerRef.current.addEventListener('focusin', handleFocusIn);
    containerRef.current.addEventListener('focusout', handleFocusOut);

    const resizeObserver = new ResizeObserver(() => {
      resizeSchedulerRef.current?.request();
    });
    resizeObserver.observe(containerRef.current);

    resizeSchedulerRef.current.request();
    publishCurrentTerminalE2EState();

    return () => {
      resizeObserver.disconnect();
      containerRef.current?.removeEventListener('mousedown', handlePointerActivate);
      containerRef.current?.removeEventListener('focusin', handleFocusIn);
      containerRef.current?.removeEventListener('focusout', handleFocusOut);
      resizeSchedulerRef.current?.reset();
      resizeSchedulerRef.current = null;
      unregisterTerminalHooks(stableId, terminalHooks);
      clearSessionCwd(liveSessionIdRef.current);
      // 안전망: 파괴 직전 스크롤백을 저장해, 같은 stableId로 재생성되면 복원한다.
      // 단 tmux pane 은 제외한다 — 내용이 서버(tmux) 권위라 재attach 시 %output 으로
      // 전체 화면을 다시 replay 한다. 스냅샷까지 복원하면 그 위에 replay 가 덧그려져
      // 프롬프트가 누적된다(탭 닫았다 재연결할 때마다 "$ $ $"). 네트워크 끊김 자동
      // 재연결은 pane 을 unmount 하지 않아(같은 stableId 유지) 이 경로를 타지 않으므로
      // 스크롤백 보존에는 영향이 없다.
      if (!liveIsTmuxPaneRef.current) {
        saveScrollbackSnapshot(stableId, runtime.captureRestoreSnapshot());
      }
      runtime.dispose();
      publishTerminalE2EState(liveSessionIdRef.current, null);
      runtimeRef.current = null;
      terminalRef.current = null;
    };
  }, [
    publishCurrentTerminalE2EState,
    refreshViewport,
    requestShareSnapshot,
    // sessionId가 아닌 stableId에 묶는다 — 재연결로 sessionId가 바뀌어도 터미널을
    // dispose/recreate 하지 않아 스크롤백이 보존된다.
    stableId,
  ]);

  useEffect(() => {
    if (!runtimeRef.current) {
      return;
    }
    runtimeRef.current.setAppearance(appearance);
    resizeSchedulerRef.current?.request();
    refreshViewport();
    publishCurrentTerminalE2EState();
  }, [appearance, publishCurrentTerminalE2EState, refreshViewport]);

  const refreshAutocompleteAnchor = useCallback(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const screen = terminal?.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!terminal || !container || !screen || terminal.cols <= 0 || terminal.rows <= 0) {
      return;
    }
    const containerBounds = container.getBoundingClientRect();
    const screenBounds = screen.getBoundingClientRect();
    const cellWidth = screenBounds.width / terminal.cols;
    const cellHeight = screenBounds.height / terminal.rows;
    const cursor = terminal.buffer.active;
    const left =
      screenBounds.left - containerBounds.left +
      Math.min(terminal.cols - 1, cursor.cursorX) * cellWidth;
    const top =
      screenBounds.top - containerBounds.top +
      (Math.min(terminal.rows - 1, cursor.cursorY) + 1) * cellHeight + 4;
    setAutocompleteAnchor({
      left: Math.min(Math.max(4, left), Math.max(4, containerBounds.width - 288)),
      top,
      openAbove: containerBounds.height - top < 190,
    });
  }, []);

  useEffect(() => {
    if (autocomplete.suggestions.length === 0) {
      return;
    }
    const frame = requestAnimationFrame(refreshAutocompleteAnchor);
    return () => cancelAnimationFrame(frame);
  }, [
    autocomplete.command.cursor,
    autocomplete.command.value,
    autocomplete.suggestions.length,
    refreshAutocompleteAnchor,
  ]);

  useEffect(() => {
    const nextWebglEnabled = resolveTerminalRuntimeWebglEnabled({
      isMac: isMacPlatform(),
      terminalWebglEnabled,
      sessionSource: tab?.source,
      shareStatus: tab?.sessionShare?.status,
    });
    if (!runtimeRef.current) {
      return;
    }

    debugSessionShareRenderer(
      nextWebglEnabled
        ? 'restoring owner WebGL renderer'
        : 'disabling owner WebGL renderer',
      {
        sessionId,
        isMac: isMacPlatform(),
        shareStatus: tab?.sessionShare?.status ?? 'inactive',
      },
    );
    void runtimeRef.current.setWebglEnabled(nextWebglEnabled);
  }, [
    sessionId,
    tab?.sessionShare?.status,
    tab?.source,
    terminalWebglEnabled,
  ]);

  useEffect(() => {
    // Sentry의 to_terminal(ZMODEM이 아닌 일반 출력)만 기존 소비자(화면/공유/E2E)에게
    // 흘린다. ZMODEM 프로토콜 바이트는 sentry가 가로채 화면/공유/E2E에 도달하지 않는다.
    const writeToTerminal = (bytes: Uint8Array) => {
      if (
        bytes.byteLength > 0 &&
        liveSessionShareStatusRef.current === 'active'
      ) {
        shareSnapshotDirtyRef.current = true;
      }
      runtimeRef.current?.write(bytes);
      runtimeRef.current?.scheduleAfterWriteDrain(() => {
        const terminal = runtimeRef.current?.terminal;
        if (!terminal) {
          return;
        }
        const buffer = terminal.buffer?.active;
        if (!buffer) {
          return;
        }
        // Prompt boundaries now come from OSC 133 markers (onShellIntegration),
        // so the only thing tracked from raw output here is alternate-screen
        // state (vim/less/htop) to suspend the autocomplete overlay.
        setTerminalAlternateScreen(buffer.type === 'alternate');
      });
      if (liveAutocompleteVisibleRef.current) {
        runtimeRef.current?.scheduleAfterWriteDrain(refreshAutocompleteAnchor);
      }
      if (e2eTerminalHookEnabledRef.current) {
        runtimeRef.current?.scheduleAfterWriteDrain(() => {
          publishCurrentTerminalE2EState();
        });
      }
    };

    // 세션당 ZMODEM Sentry. sessionId 키잉이라 재연결(effect 재실행) 시 dispose되어
    // 진행 중 전송이 abort된다(스크롤백은 stableId 보존이라 유지).
    const zmodem = createZmodemController({
      sessionId,
      hostLabel: liveSourceLabelRef.current || 'ZMODEM',
      // SSM(aws-ec2)은 데이터 채널이 ZMODEM 바이너리 스트림을 신뢰성 있게 전달하지
      // 못해(꼬리 바이트 누락) 비활성. SSH/Warpgate 등 8-bit clean 전송만 사용.
      enabled: host?.kind !== 'aws-ec2',
      writeToTerminal,
      // ZMODEM 회신은 활성 세션에만 보낸다(브로드캐스트 팬아웃 금지).
      sendToRemote: (bytes) => {
        void writeTerminalBinaryInput(liveSessionIdRef.current, bytes);
      },
      saveDownload: saveZmodemDownload,
      upsertJob: (job) => appStore.getState().upsertZmodemTransfer(job),
      registerAbort: registerZmodemAbort,
      clearAbort: clearZmodemAbort,
    });

    const unsubscribe = onSessionData(sessionId, (chunk) => {
      zmodem.consume(chunk);
    });

    return () => {
      unsubscribe();
      zmodem.dispose();
      clearSessionCwd(sessionId);
    };
  }, [
    host?.kind,
    onSessionData,
    publishCurrentTerminalE2EState,
    refreshAutocompleteAnchor,
    sessionId,
  ]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [searchOpen]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    runtimeRef.current?.syncDisplayMetrics();
    resizeSchedulerRef.current?.request();
    requestAnimationFrame(() => {
      runtimeRef.current?.syncDisplayMetrics();
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
      if (liveSessionShareStatusRef.current === 'active') {
        requestShareSnapshot('refresh');
      }
    });
  }, [layoutKey, refreshViewport, requestShareSnapshot, tab?.sessionShare?.status, viewActivationKey, visible]);

  useEffect(() => {
    const previousStatus = previousSessionStatusRef.current;
    previousSessionStatusRef.current = tab?.status ?? null;

    if (!didTerminalSessionJustConnect(previousStatus, tab?.status)) {
      return;
    }

    runtimeRef.current?.syncDisplayMetrics();
    resizeSchedulerRef.current?.request();
    requestAnimationFrame(() => {
      refreshViewport();
    });
  }, [refreshViewport, tab?.status]);

  useEffect(() => {
    if (active && visible) {
      runtimeRef.current?.syncDisplayMetrics();
      runtimeRef.current?.focus();
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
    }
  }, [active, refreshViewport, viewActivationKey, visible]);

  // tmux 명령 프롬프트가 닫힌 뒤 이 pane 의 xterm 으로 포커스를 되돌릴 수 있게 등록한다.
  useEffect(() => {
    const focus = () => runtimeRef.current?.focus();
    registerTerminalFocus(sessionId, focus);
    return () => unregisterTerminalFocus(sessionId, focus);
  }, [sessionId]);

  useEffect(() => {
    if (tab?.sessionShare?.status !== 'active') {
      return;
    }

    const timer = window.setInterval(() => {
      requestShareSnapshot('refresh');
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [requestShareSnapshot, sessionId, tab?.sessionShare?.status]);

  useEffect(() => {
    const handleWindowResize = () => {
      runtimeRef.current?.syncDisplayMetrics();
    };

    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  const closeSearchOverlay = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    runtimeRef.current?.clearSearch();
    runtimeRef.current?.focus();
  }, []);

  const shareState = tab?.sessionShare ?? null;
  const canShareSession = tab?.source === 'host';
  const canStartShare =
    canShareSession && tab?.status === 'connected' && shareState?.status !== 'starting';
  const visibleSessionShareChatNotifications = useMemo(
    () =>
      getVisibleSessionShareChatNotifications(sessionShareChatNotifications),
    [sessionShareChatNotifications],
  );

  const shouldShowConnectionOverlay = shouldShowSessionOverlay(
    tab,
    terminalInitError,
  );
  const connectionOverlayTitle = resolveConnectionOverlayTitle(tab);
  const connectionOverlayMessage = resolveConnectionOverlayMessage(tab);

  const handleStartShare = useCallback(async () => {
    const payload = captureShareSnapshot();
    if (!payload || !canShareSession) {
      return;
    }
    // tmux pane 은 hostId 가 null 이라 host 가 undefined 다(이전엔 !host 로 early-return →
    // 공유 버튼이 눌려도 no-op). share 백엔드는 sessionId(tmux:<ctl>:<pane> 포함) 기준으로
    // 스트림을 중계하므로 host 없이도 동작한다 — transport 만 도출한다.
    // 이 값은 추측(호스트 종류)일 뿐이고, main(SessionShareService.start)이 세션의 실제
    // 전송(getSessionTransport)으로 재판정한다 — EC2 기본 연결은 SSH-over-SSM("ssh")이라
    // 여기서 aws-ssm 으로 보내도 SSM 셸 폴백 세션만 aws-ssm 으로 공유된다.
    const transport = host?.kind === 'aws-ec2' ? 'aws-ssm' : 'ssh';
    await onStartSessionShare?.({
      sessionId,
      title,
      transport,
      ...payload,
    });
    setSharePopoverOpen(true);
    setShareCopyStatus(null);
  }, [canShareSession, captureShareSnapshot, host, onStartSessionShare, sessionId, title]);

  const handleCopyShareUrl = useCallback(async () => {
    if (!shareState?.shareUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(shareState.shareUrl);
      setShareCopyStatus('링크를 복사했습니다.');
    } catch {
      setShareCopyStatus('링크를 복사하지 못했습니다.');
    }
  }, [shareState?.shareUrl]);

  const handleSearchQueryChange = useCallback((nextQuery: string) => {
    setSearchQuery(nextQuery);
    if (!nextQuery.trim()) {
      runtimeRef.current?.clearSearch();
      return;
    }
    runtimeRef.current?.findNext(nextQuery);
  }, []);

  const handleSearchInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          runtimeRef.current?.findPrevious(searchQuery);
          return;
        }
        runtimeRef.current?.findNext(searchQuery);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearchOverlay();
      }
    },
    [closeSearchOverlay, searchQuery],
  );

  const handlePaneKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        shouldOpenTerminalSearch({
          active,
          visible,
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        })
      ) {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (!active || !visible || !searchOpen) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearchOverlay();
      }
    },
    [active, closeSearchOverlay, searchOpen, visible],
  );

  const handlePaneMouseDown = useCallback(() => {
    liveOnFocusRef.current?.();
  }, []);

  const handleInteractiveAuthPromptChange = useCallback(
    (index: number, value: string) => {
      setPromptResponses((current) => {
        const nextResponses = [...current];
        nextResponses[index] = value;
        return nextResponses;
      });
    },
    [],
  );

  const handleInteractiveAuthSubmit = useCallback(() => {
    if (!interactiveAuth) {
      return Promise.resolve();
    }

    return onRespondInteractiveAuth(
      interactiveAuth.challengeId,
      promptResponses,
    );
  }, [interactiveAuth, onRespondInteractiveAuth, promptResponses]);

  const handleCopyInteractiveAuthApprovalUrl = useCallback(async () => {
    await navigator.clipboard.writeText(interactiveAuth?.approvalUrl ?? '');
  }, [interactiveAuth?.approvalUrl]);

  const handleOpenShareChatWindow = useCallback(() => {
    void onOpenSessionShareChatWindow?.(sessionId);
  }, [onOpenSessionShareChatWindow, sessionId]);

  const handleStopShare = useCallback(() => {
    void onStopSessionShare?.(sessionId);
    setSharePopoverOpen(false);
  }, [onStopSessionShare, sessionId]);

  const handleSetSessionShareInputMode = useCallback(
    (inputEnabled: boolean) => {
      void onSetSessionShareInputEnabled?.(sessionId, inputEnabled);
    },
    [onSetSessionShareInputEnabled, sessionId],
  );

  const toggleSharePopover = useCallback(() => {
    setSharePopoverOpen((open) => !open);
    setShareCopyStatus(null);
  }, []);

  return {
    containerRef,
    searchInputRef,
    sharePopoverRef,
    promptResponses,
    searchOpen,
    searchQuery,
    sharePopoverOpen,
    shareCopyStatus,
    terminalInitError,
    autocompleteSuggestions: terminalAlternateScreen
      ? []
      : autocomplete.suggestions,
    autocompleteCommand: autocomplete.command.value,
    autocompleteSelectedIndex: autocomplete.selectedIndex,
    autocompleteAnchor,
    acceptAutocompleteSuggestion: autocomplete.acceptSuggestion,
    autocompletePendingSnippet: autocomplete.pendingSnippet,
    confirmAutocompleteSnippet: autocomplete.confirmSnippet,
    cancelAutocompleteSnippet: autocomplete.cancelSnippet,
    shareState,
    canShareSession,
    canStartShare,
    visibleSessionShareChatNotifications,
    shouldShowConnectionOverlay,
    connectionOverlayTitle,
    connectionOverlayMessage,
    handlePaneKeyDownCapture,
    handlePaneMouseDown,
    toggleSharePopover,
    closeSearchOverlay,
    handleSearchQueryChange,
    handleSearchInputKeyDown,
    handleStartShare,
    handleCopyShareUrl,
    handleSetSessionShareInputMode,
    handleOpenShareChatWindow,
    handleStopShare,
    handleInteractiveAuthPromptChange,
    handleInteractiveAuthSubmit,
    handleCopyInteractiveAuthApprovalUrl,
    findPreviousSearchMatch: () => {
      runtimeRef.current?.findPrevious(searchQuery);
    },
    findNextSearchMatch: () => {
      runtimeRef.current?.findNext(searchQuery);
    },
    blurSearch: () => {
      runtimeRef.current?.blurSearch();
    },
    clearSearch: () => {
      runtimeRef.current?.clearSearch();
    },
    focusTerminal: () => {
      runtimeRef.current?.focus();
    },
  };
}
