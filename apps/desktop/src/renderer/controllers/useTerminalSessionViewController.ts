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
  setSessionCwd,
} from '../lib/terminal-cwd-registry';
import { createZmodemController } from '../lib/zmodem/zmodem-controller';
import {
  installTerminalShellIntegration,
  writeTerminalBinaryInput,
} from '../services/desktop/terminal';
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
  const liveHasOutputRef = useRef(tab?.hasReceivedOutput ?? false);
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

  const autocomplete = useTerminalAutocomplete({
    sessionId,
    enabled:
      terminalAutocompleteEnabled &&
      host?.kind !== 'serial' &&
      tab?.shellKind !== 'aws-ecs-exec',
    connected: tab?.status === 'connected',
    // 셸 통합 init을 연결 직후 주입한다(lazy 미사용). 통합 프롬프트가 곧 첫 프롬프트라
    // (core-manager가 133;A를 본 뒤 startup command를 flush) 더블 프롬프트는 없다.
    // eager로 둬야 OSC 7(cwd)·OSC 133이 첫 프롬프트부터 흘러, SSM(aws-ec2)에서도 파일
    // 드롭 업로드가 현재 경로를 인식한다(lazy면 cwd 미보고로 홈에 폴백됐었다).
    lazyPrepare: false,
    sendInput: sendAutocompleteInput,
    snippets,
    onCommandFinished,
  });
  const liveAutocompleteInputRef = useRef(autocomplete.handleInput);
  const liveAutocompleteVisibleRef = useRef(false);
  const liveAutocompleteShellMarkerRef = useRef(autocomplete.handleShellMarker);
  const liveAutocompleteCwdRef = useRef(autocomplete.handleCwd);

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
          liveAutocompleteInputRef.current(data);
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
        runtime.fitAddon.fit();
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
      saveScrollbackSnapshot(stableId, runtime.captureRestoreSnapshot());
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
  }, [sessionId, tab?.sessionShare?.status, tab?.source, terminalWebglEnabled]);

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
    if (!payload || !canShareSession || !host) {
      return;
    }

    await onStartSessionShare?.({
      sessionId,
      title,
      transport: host.kind === 'aws-ec2' ? 'aws-ssm' : 'ssh',
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
