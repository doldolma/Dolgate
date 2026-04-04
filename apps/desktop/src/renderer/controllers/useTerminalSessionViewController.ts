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
}: TerminalSessionPaneProps) {
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

  useEffect(() => {
    liveSessionIdRef.current = sessionId;
    liveSessionStatusRef.current = tab?.status ?? null;
    liveSessionShareStatusRef.current = tab?.sessionShare?.status ?? 'inactive';
  }, [sessionId, tab?.sessionShare?.status, tab?.status]);

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
          liveOnSendInputRef.current?.(currentSessionId, data);
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
      runtime.dispose();
      publishTerminalE2EState(liveSessionIdRef.current, null);
      runtimeRef.current = null;
      terminalRef.current = null;
    };
  }, [
    publishCurrentTerminalE2EState,
    refreshViewport,
    requestShareSnapshot,
    sessionId,
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

  useEffect(
    () =>
      onSessionData(sessionId, (chunk) => {
        if (chunk.byteLength > 0) {
          debugSessionShareRenderer('terminal stream chunk received', {
            sessionId,
            byteLength: chunk.byteLength,
            shareStatus: liveSessionShareStatusRef.current,
          });
          if (liveSessionShareStatusRef.current === 'active') {
            shareSnapshotDirtyRef.current = true;
          }
        }
        runtimeRef.current?.write(chunk);
        if (e2eTerminalHookEnabledRef.current) {
          runtimeRef.current?.scheduleAfterWriteDrain(() => {
            publishCurrentTerminalE2EState();
          });
        }
      }),
    [onSessionData, publishCurrentTerminalE2EState, sessionId],
  );

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
