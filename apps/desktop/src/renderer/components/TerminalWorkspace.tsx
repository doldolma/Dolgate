import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, HostRecord, SessionShareSnapshotInput, SessionShareStartInput, TerminalTab } from '@shared';
import type { Terminal } from '@xterm/xterm';
import type { PendingInteractiveAuth, WorkspaceDropDirection, WorkspaceLayoutNode, WorkspaceTab } from '../store/createAppStore';
import { createTerminalRuntime, type TerminalRuntime } from '../lib/terminal-runtime';
import { useAppStore } from '../store/appStore';
import { getTerminalFontOption, getTerminalThemePreset, type TerminalThemeDefinition } from '../lib/terminal-presets';
import { createTerminalResizeScheduler } from './terminal-resize';

interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SessionPlacement {
  sessionId: string;
  rect: Rect;
}

interface SplitHandlePlacement {
  splitId: string;
  axis: 'horizontal' | 'vertical';
  rect: Rect;
  ratio: number;
}

interface DropPreview {
  direction: WorkspaceDropDirection;
  targetSessionId?: string;
  rect: Rect;
}

interface TerminalSessionViewProps {
  sessionId: string;
  title: string;
  visible: boolean;
  active: boolean;
  layoutKey: string;
  appearance: {
    theme: TerminalThemeDefinition['theme'];
    fontFamily: string;
    fontSize: number;
    scrollbackLines: number;
    lineHeight: number;
    letterSpacing: number;
    minimumContrastRatio: number;
    macOptionIsMeta?: boolean;
  };
  terminalWebglEnabled: boolean;
  style?: React.CSSProperties;
  showHeader?: boolean;
  draggingDisabled?: boolean;
  interactiveAuth: PendingInteractiveAuth | null;
  onFocus?: () => void;
  onClose?: () => Promise<void>;
  onRetry?: () => Promise<void>;
  onStartSessionShare?: (input: SessionShareStartInput) => Promise<void>;
  onUpdateSessionShareSnapshot?: (input: SessionShareSnapshotInput) => Promise<void>;
  onSetSessionShareInputEnabled?: (sessionId: string, inputEnabled: boolean) => Promise<void>;
  onStopSessionShare?: (sessionId: string) => Promise<void>;
  onStartDrag?: () => void;
  onEndDrag?: () => void;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /mac/i.test(navigator.userAgent) || /mac/i.test(navigator.platform);
}

function debugSessionShareRenderer(message: string, payload?: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    return;
  }

  if (payload) {
    console.debug(`[session-share] ${message}`, payload);
    return;
  }

  console.debug(`[session-share] ${message}`);
}

export function shouldOpenTerminalSearch(input: {
  active: boolean;
  visible: boolean;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return input.active && input.visible && (input.metaKey || input.ctrlKey) && input.key.toLowerCase() === 'f';
}

export function didTerminalSessionJustConnect(
  previousStatus: TerminalTab['status'] | null | undefined,
  nextStatus: TerminalTab['status'] | null | undefined
): boolean {
  return previousStatus !== 'connected' && nextStatus === 'connected';
}

export function resolveTerminalRuntimeWebglEnabled(input: {
  isMac: boolean;
  terminalWebglEnabled: boolean;
  sessionSource: TerminalTab['source'] | null | undefined;
  shareStatus: TerminalTab['sessionShare'] extends { status: infer T } ? T : string | null | undefined;
}): boolean {
  if (input.isMac && input.sessionSource === 'host' && input.shareStatus === 'active') {
    return false;
  }

  return input.terminalWebglEnabled;
}

export function mergeSessionShareSnapshotKinds(
  currentKind: SessionShareSnapshotInput['kind'] | null,
  nextKind: SessionShareSnapshotInput['kind']
): SessionShareSnapshotInput['kind'] {
  if (currentKind === 'resync' || nextKind === 'resync') {
    return 'resync';
  }

  return 'refresh';
}

function isPendingConnectionSessionId(sessionId: string): boolean {
  return sessionId.startsWith('pending:');
}

function shouldShowSessionOverlay(tab: TerminalTab | undefined, terminalInitError: string | null): boolean {
  if (!tab || terminalInitError) {
    return false;
  }

  if (tab.status === 'pending' || tab.status === 'connecting' || tab.status === 'error') {
    return true;
  }

  return tab.status === 'connected' && !tab.hasReceivedOutput;
}

function resolveOverlayTitle(tab: TerminalTab | undefined): string {
  if (!tab) {
    return 'Connecting';
  }

  if (tab.status === 'error') {
    return 'Connection Failed';
  }

  if (tab.connectionProgress?.blockingKind === 'browser') {
    return 'Continue in Browser';
  }

  if (tab.connectionProgress?.blockingKind === 'dialog' || tab.connectionProgress?.blockingKind === 'panel') {
    return 'Action Required';
  }

  if (tab.status === 'connected') {
    return 'Connected';
  }

  return 'Connecting';
}

function resolveOverlayMessage(tab: TerminalTab | undefined): string {
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

interface TerminalWorkspaceProps {
  tabs: TerminalTab[];
  hosts: HostRecord[];
  settings: AppSettings;
  activeSessionId: string | null;
  activeWorkspace: WorkspaceTab | null;
  draggedSession: DraggedSessionPayload | null;
  canDropDraggedSession: boolean;
  onCloseSession: (sessionId: string) => Promise<void>;
  onRetryConnection: (sessionId: string) => Promise<void>;
  onStartSessionShare: (input: SessionShareStartInput) => Promise<void>;
  onUpdateSessionShareSnapshot: (input: SessionShareSnapshotInput) => Promise<void>;
  onSetSessionShareInputEnabled: (sessionId: string, inputEnabled: boolean) => Promise<void>;
  onStopSessionShare: (sessionId: string) => Promise<void>;
  onStartPaneDrag: (workspaceId: string, sessionId: string) => void;
  onEndSessionDrag: () => void;
  onSplitSessionDrop: (sessionId: string, direction: WorkspaceDropDirection, targetSessionId?: string) => boolean;
  onFocusWorkspaceSession: (workspaceId: string, sessionId: string) => void;
  onResizeWorkspaceSplit: (workspaceId: string, splitId: string, ratio: number) => void;
}

function toPercentRectStyle(rect: Rect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`
  };
}

function directionPreviewRect(rect: Rect, direction: WorkspaceDropDirection): Rect {
  if (direction === 'left') {
    return { ...rect, width: rect.width * 0.5 };
  }
  if (direction === 'right') {
    return { ...rect, x: rect.x + rect.width * 0.5, width: rect.width * 0.5 };
  }
  if (direction === 'top') {
    return { ...rect, height: rect.height * 0.5 };
  }
  return {
    ...rect,
    y: rect.y + rect.height * 0.5,
    height: rect.height * 0.5
  };
}

function resolveDropDirection(clientX: number, clientY: number, rect: DOMRect): WorkspaceDropDirection {
  const normalizedX = rect.width <= 0 ? 0.5 : Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const normalizedY = rect.height <= 0 ? 0.5 : Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  const distances: Array<{ direction: WorkspaceDropDirection; value: number }> = [
    { direction: 'left', value: normalizedX },
    { direction: 'right', value: 1 - normalizedX },
    { direction: 'top', value: normalizedY },
    { direction: 'bottom', value: 1 - normalizedY }
  ];

  distances.sort((left, right) => left.value - right.value);
  return distances[0].direction;
}

function collectWorkspacePlacements(
  node: WorkspaceLayoutNode,
  rect: Rect,
  placements: SessionPlacement[],
  handles: SplitHandlePlacement[]
) {
  if (node.kind === 'leaf') {
    placements.push({
      sessionId: node.sessionId,
      rect
    });
    return;
  }

  handles.push({
    splitId: node.id,
    axis: node.axis,
    rect,
    ratio: node.ratio
  });

  if (node.axis === 'horizontal') {
    const firstWidth = rect.width * node.ratio;
    collectWorkspacePlacements(
      node.first,
      {
        x: rect.x,
        y: rect.y,
        width: firstWidth,
        height: rect.height
      },
      placements,
      handles
    );
    collectWorkspacePlacements(
      node.second,
      {
        x: rect.x + firstWidth,
        y: rect.y,
        width: rect.width - firstWidth,
        height: rect.height
      },
      placements,
      handles
    );
    return;
  }

  const firstHeight = rect.height * node.ratio;
  collectWorkspacePlacements(
    node.first,
    {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: firstHeight
    },
    placements,
    handles
  );
  collectWorkspacePlacements(
    node.second,
    {
      x: rect.x,
      y: rect.y + firstHeight,
      width: rect.width,
      height: rect.height - firstHeight
    },
    placements,
    handles
  );
}

function TerminalSessionView({
  sessionId,
  title,
  visible,
  active,
  layoutKey,
  appearance,
  terminalWebglEnabled,
  style,
  showHeader = false,
  draggingDisabled = false,
  interactiveAuth,
  onFocus,
  onClose,
  onRetry,
  onStartSessionShare,
  onUpdateSessionShareSnapshot,
  onSetSessionShareInputEnabled,
  onStopSessionShare,
  onStartDrag,
  onEndDrag
}: TerminalSessionViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const runtimeRef = useRef<TerminalRuntime | null>(null);
  const resizeSchedulerRef = useRef<ReturnType<typeof createTerminalResizeScheduler> | null>(null);
  const tabs = useAppStore((state) => state.tabs);
  const currentTab = tabs.find((tab) => tab.sessionId === sessionId);
  const respondInteractiveAuth = useAppStore((state) => state.respondInteractiveAuth);
  const reopenInteractiveAuthUrl = useAppStore((state) => state.reopenInteractiveAuthUrl);
  const clearPendingInteractiveAuth = useAppStore((state) => state.clearPendingInteractiveAuth);
  const updatePendingConnectionSize = useAppStore((state) => state.updatePendingConnectionSize);
  const markSessionOutput = useAppStore((state) => state.markSessionOutput);
  const [promptResponses, setPromptResponses] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sharePopoverOpen, setSharePopoverOpen] = useState(false);
  const [shareCopyStatus, setShareCopyStatus] = useState<string | null>(null);
  const [terminalInitError, setTerminalInitError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sharePopoverRef = useRef<HTMLDivElement | null>(null);
  const previousSessionStatusRef = useRef<TerminalTab['status'] | null>(null);
  const liveSessionIdRef = useRef(sessionId);
  const liveSessionStatusRef = useRef<TerminalTab['status'] | null>(currentTab?.status ?? null);
  const liveSessionShareStatusRef = useRef(currentTab?.sessionShare?.status ?? 'inactive');
  const liveAppearanceRef = useRef(appearance);
  const liveUpdateSessionShareSnapshotRef = useRef(onUpdateSessionShareSnapshot);
  const shareSnapshotDirtyRef = useRef(false);
  const pendingShareSnapshotKindRef = useRef<SessionShareSnapshotInput['kind'] | null>(null);
  const shareSnapshotInFlightRef = useRef(false);

  useEffect(() => {
    if (!interactiveAuth || interactiveAuth.sessionId !== sessionId) {
      setPromptResponses([]);
      return;
    }
    setPromptResponses(interactiveAuth.prompts.map(() => ''));
  }, [interactiveAuth, sessionId]);

  useEffect(() => {
    setTerminalInitError(null);
    previousSessionStatusRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    liveSessionIdRef.current = sessionId;
    liveSessionStatusRef.current = currentTab?.status ?? null;
    liveSessionShareStatusRef.current = currentTab?.sessionShare?.status ?? 'inactive';
  }, [currentTab?.sessionShare?.status, currentTab?.status, sessionId]);

  useEffect(() => {
    liveAppearanceRef.current = appearance;
  }, [appearance]);

  useEffect(() => {
    liveUpdateSessionShareSnapshotRef.current = onUpdateSessionShareSnapshot;
  }, [onUpdateSessionShareSnapshot]);

  useEffect(() => {
    setSharePopoverOpen(false);
    setShareCopyStatus(null);
    shareSnapshotDirtyRef.current = false;
    pendingShareSnapshotKindRef.current = null;
    shareSnapshotInFlightRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (currentTab?.sessionShare?.status === 'active') {
      return;
    }

    shareSnapshotDirtyRef.current = false;
    pendingShareSnapshotKindRef.current = null;
    shareSnapshotInFlightRef.current = false;
  }, [currentTab?.sessionShare?.status]);

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

  function refreshViewport() {
    const terminal = terminalRef.current;
    if (!terminal || terminal.rows <= 0) {
      return;
    }
    terminal.refresh(0, terminal.rows - 1);
  }

  function captureShareSnapshot():
    | Pick<
        SessionShareSnapshotInput,
        'snapshot' | 'cols' | 'rows' | 'terminalAppearance' | 'viewportPx'
      >
    | null {
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
        letterSpacing: liveAppearanceRef.current.letterSpacing
      },
      viewportPx:
        viewportWidth > 0 && viewportHeight > 0
          ? {
              width: viewportWidth,
              height: viewportHeight
            }
          : null
    };
  }

  async function flushRequestedShareSnapshot() {
    const runtime = runtimeRef.current;
    const updateSnapshot = liveUpdateSessionShareSnapshotRef.current;
    const kind = pendingShareSnapshotKindRef.current;

    if (!runtime || !updateSnapshot || !kind || liveSessionShareStatusRef.current !== 'active') {
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
      kind
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
        kind
      });
    } finally {
      shareSnapshotInFlightRef.current = false;
      if (pendingShareSnapshotKindRef.current) {
        runtime.scheduleAfterWriteDrain(() => {
          debugSessionShareRenderer('owner runtime write drain reached', {
            sessionId: liveSessionIdRef.current,
            kind: pendingShareSnapshotKindRef.current
          });
          if (shareSnapshotInFlightRef.current) {
            return;
          }
          void flushRequestedShareSnapshot();
        });
      }
    }
  }

  function requestShareSnapshot(kind: 'refresh' | 'resync' = 'refresh') {
    if (liveSessionShareStatusRef.current !== 'active') {
      return;
    }

    if (kind === 'refresh' && !shareSnapshotDirtyRef.current) {
      return;
    }

    pendingShareSnapshotKindRef.current = mergeSessionShareSnapshotKinds(pendingShareSnapshotKindRef.current, kind);
    debugSessionShareRenderer('snapshot requested', {
      sessionId: liveSessionIdRef.current,
      kind: pendingShareSnapshotKindRef.current
    });

    runtimeRef.current?.scheduleAfterWriteDrain(() => {
      debugSessionShareRenderer('owner runtime write drain reached', {
        sessionId: liveSessionIdRef.current,
        kind: pendingShareSnapshotKindRef.current
      });
      if (shareSnapshotInFlightRef.current) {
        return;
      }
      void flushRequestedShareSnapshot();
    });
  }

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
          if (isPendingConnectionSessionId(currentSessionId) || currentStatus === 'pending' || currentStatus === 'error' || currentStatus === 'disconnecting') {
            return;
          }
          void window.dolssh.ssh.write(currentSessionId, data);
        },
        onBinary: (data) => {
          const currentSessionId = liveSessionIdRef.current;
          const currentStatus = liveSessionStatusRef.current;
          if (isPendingConnectionSessionId(currentSessionId) || currentStatus === 'pending' || currentStatus === 'error' || currentStatus === 'disconnecting') {
            return;
          }
          const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0));
          void window.dolssh.ssh.writeBinary(currentSessionId, bytes);
        }
      });
      setTerminalInitError(null);
    } catch (error) {
      console.error('Failed to initialize terminal runtime.', error);
      setTerminalInitError('터미널을 초기화하지 못했습니다. 설정을 확인하거나 앱을 다시 열어주세요.');
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
        rows: runtime.terminal.rows
      }),
      afterResize: () => {
        refreshViewport();
        if (liveSessionShareStatusRef.current !== 'active') {
          return;
        }
        requestShareSnapshot('resync');
      },
      sendResize: ({ cols, rows }) => {
        const currentSessionId = liveSessionIdRef.current;
        if (isPendingConnectionSessionId(currentSessionId)) {
          updatePendingConnectionSize(currentSessionId, cols, rows);
          return Promise.resolve();
        }
        return window.dolssh.ssh.resize(currentSessionId, cols, rows);
      }
    });

    const handlePointerActivate = () => {
      onFocus?.();
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

    return () => {
      resizeObserver.disconnect();
      containerRef.current?.removeEventListener('mousedown', handlePointerActivate);
      containerRef.current?.removeEventListener('focusin', handleFocusIn);
      containerRef.current?.removeEventListener('focusout', handleFocusOut);
      resizeSchedulerRef.current?.reset();
      resizeSchedulerRef.current = null;
      runtime.dispose();
      runtimeRef.current = null;
      terminalRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!runtimeRef.current) {
      return;
    }
    runtimeRef.current.setAppearance(appearance);
    resizeSchedulerRef.current?.request();
    refreshViewport();
  }, [appearance]);

  useEffect(() => {
    const nextWebglEnabled = resolveTerminalRuntimeWebglEnabled({
      isMac: isMacPlatform(),
      terminalWebglEnabled,
      sessionSource: currentTab?.source,
      shareStatus: currentTab?.sessionShare?.status
    });
    if (!runtimeRef.current) {
      return;
    }

    debugSessionShareRenderer(nextWebglEnabled ? 'restoring owner WebGL renderer' : 'disabling owner WebGL renderer', {
      sessionId,
      isMac: isMacPlatform(),
      shareStatus: currentTab?.sessionShare?.status ?? 'inactive'
    });
    void runtimeRef.current.setWebglEnabled(nextWebglEnabled);
  }, [currentTab?.sessionShare?.status, currentTab?.source, sessionId, terminalWebglEnabled]);

  useEffect(
    () =>
      window.dolssh.ssh.onData(sessionId, (chunk) => {
        if (chunk.byteLength > 0) {
          debugSessionShareRenderer('terminal stream chunk received', {
            sessionId,
            byteLength: chunk.byteLength,
            shareStatus: liveSessionShareStatusRef.current
          });
          markSessionOutput(sessionId);
          if (liveSessionShareStatusRef.current === 'active') {
            shareSnapshotDirtyRef.current = true;
          }
        }
        runtimeRef.current?.write(chunk);
      }),
    [markSessionOutput, sessionId]
  );

  const shouldShowConnectionOverlay = shouldShowSessionOverlay(currentTab, terminalInitError);
  const connectionOverlayTitle = resolveOverlayTitle(currentTab);
  const connectionOverlayMessage = resolveOverlayMessage(currentTab);

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
  }, [currentTab?.sessionShare?.status, layoutKey, visible]);

  useEffect(() => {
    const previousStatus = previousSessionStatusRef.current;
    previousSessionStatusRef.current = currentTab?.status ?? null;

    if (!didTerminalSessionJustConnect(previousStatus, currentTab?.status)) {
      return;
    }

    runtimeRef.current?.syncDisplayMetrics();
    resizeSchedulerRef.current?.request();
    requestAnimationFrame(() => {
      refreshViewport();
    });
  }, [currentTab?.status]);

  useEffect(() => {
    if (active && visible) {
      runtimeRef.current?.syncDisplayMetrics();
      runtimeRef.current?.focus();
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
    }
  }, [active, visible]);

  useEffect(() => {
    if (currentTab?.sessionShare?.status !== 'active') {
      return;
    }

    const timer = window.setInterval(() => {
      requestShareSnapshot('refresh');
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [currentTab?.sessionShare?.status, sessionId]);

  useEffect(() => {
    const handleWindowResize = () => {
      runtimeRef.current?.syncDisplayMetrics();
    };

    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  function closeSearchOverlay() {
    setSearchOpen(false);
    setSearchQuery('');
    runtimeRef.current?.clearSearch();
    runtimeRef.current?.focus();
  }

  const shareState = currentTab?.sessionShare ?? null;
  const canShareSession = currentTab?.source === 'host';
  const canStartShare = canShareSession && currentTab?.status === 'connected' && shareState?.status !== 'starting';

  async function handleStartShare() {
    const payload = captureShareSnapshot();
    if (!payload || !canShareSession) {
      return;
    }

    await onStartSessionShare?.({
      sessionId,
      title,
      ...payload
    });
    setSharePopoverOpen(true);
    setShareCopyStatus(null);
  }

  async function handleCopyShareUrl() {
    if (!shareState?.shareUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(shareState.shareUrl);
      setShareCopyStatus('링크를 복사했습니다.');
    } catch {
      setShareCopyStatus('링크를 복사하지 못했습니다.');
    }
  }

  return (
    <div
      className={`terminal-session ${visible ? 'visible' : 'hidden'} ${active ? 'active' : ''} ${showHeader ? 'terminal-session--pane' : ''}`}
      style={style}
      onKeyDownCapture={(event) => {
        if (
          shouldOpenTerminalSearch({
            active,
            visible,
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey
          })
        ) {
          event.preventDefault();
          setSearchOpen(true);
          return;
        }

        if (!active || !visible) {
          return;
        }

        if (!searchOpen) {
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          closeSearchOverlay();
        }
      }}
      onMouseDown={() => {
        onFocus?.();
      }}
    >
      {canShareSession ? (
        <div
          ref={sharePopoverRef}
          className={`terminal-share-anchor ${showHeader ? 'terminal-share-anchor--pane' : ''}`}
        >
          <button
            type="button"
            className="terminal-share-button"
            onClick={() => {
              setSharePopoverOpen((open) => !open);
              setShareCopyStatus(null);
            }}
          >
            Share
          </button>
          {sharePopoverOpen ? (
            <div className="terminal-share-popover">
              {shareState?.status === 'inactive' || !shareState ? (
                <>
                  <div className="terminal-share-popover__eyebrow">Session Share</div>
                  <strong>현재 세션을 브라우저로 공유합니다.</strong>
                  <p>링크를 아는 사용자는 로그인 없이 접속할 수 있습니다.</p>
                  <button
                    type="button"
                    className="primary-button terminal-share-popover__action"
                    onClick={() => {
                      void handleStartShare();
                    }}
                    disabled={!canStartShare}
                  >
                    공유 시작
                  </button>
                </>
              ) : (
                <>
                  <div className="terminal-share-popover__eyebrow">Session Share</div>
                  <strong>{shareState.status === 'starting' ? '공유를 준비하는 중입니다.' : '공유 링크가 준비되었습니다.'}</strong>
                  {shareState.errorMessage ? <p className="terminal-share-popover__error">{shareState.errorMessage}</p> : null}
                  {shareState.shareUrl ? (
                    <div className="terminal-share-popover__url">{shareState.shareUrl}</div>
                  ) : (
                    <p>공유 링크를 생성하는 중입니다.</p>
                  )}
                  <div className="terminal-share-popover__meta">
                    <span>시청자 {shareState.viewerCount}명</span>
                    <div className="terminal-share-popover__mode" role="group" aria-label="세션 공유 입력 모드">
                      <button
                        type="button"
                        className={`terminal-share-popover__mode-button ${!shareState.inputEnabled ? 'is-active' : ''}`}
                        onClick={() => {
                          void onSetSessionShareInputEnabled?.(sessionId, false);
                        }}
                        disabled={shareState.status !== 'active' && shareState.status !== 'starting'}
                        aria-pressed={!shareState.inputEnabled}
                      >
                        읽기 전용
                      </button>
                      <button
                        type="button"
                        className={`terminal-share-popover__mode-button ${shareState.inputEnabled ? 'is-active' : ''}`}
                        onClick={() => {
                          void onSetSessionShareInputEnabled?.(sessionId, true);
                        }}
                        disabled={shareState.status !== 'active' && shareState.status !== 'starting'}
                        aria-pressed={shareState.inputEnabled}
                      >
                        입력 허용
                      </button>
                    </div>
                  </div>
                  {shareCopyStatus ? <div className="terminal-share-popover__hint">{shareCopyStatus}</div> : null}
                  <div className="terminal-share-popover__actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        void handleCopyShareUrl();
                      }}
                      disabled={!shareState.shareUrl}
                    >
                      링크 복사
                    </button>
                    <button
                      type="button"
                      className="ghost-button terminal-share-popover__danger"
                      onClick={() => {
                        void onStopSessionShare?.(sessionId);
                        setSharePopoverOpen(false);
                      }}
                    >
                      공유 종료
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {showHeader ? (
        <div
          className={`terminal-pane-header ${active ? 'active' : ''}`}
          draggable={!draggingDisabled}
          onDragStart={(event) => {
            if (draggingDisabled || !onStartDrag) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-dolssh-session-id', sessionId);
            onStartDrag();
          }}
          onDragEnd={() => {
            onEndDrag?.();
          }}
        >
          <button type="button" className="terminal-pane-header__title" onClick={onFocus}>
            {title}
          </button>
          <button
            type="button"
            className="terminal-pane-header__close"
            aria-label={`${title} 세션 종료`}
            onClick={() => {
              void onClose?.();
            }}
            disabled={!onClose || currentTab?.status === 'disconnecting'}
          >
            ×
          </button>
        </div>
      ) : null}
      {currentTab?.errorMessage ? <div className="terminal-error-banner">{currentTab.errorMessage}</div> : null}
      {terminalInitError ? <div className="terminal-error-banner">{terminalInitError}</div> : null}
      {interactiveAuth ? (
        <div className="terminal-interactive-auth">
          {interactiveAuth.provider === 'warpgate' ? (
            <>
              <div className="terminal-interactive-auth__eyebrow">Warpgate Approval</div>
              <strong>Warpgate 승인을 기다리는 중입니다.</strong>
              <p>
                브라우저에서 Warpgate 로그인 후 <code>Authorize</code>를 눌러 주세요. 가능한 입력은 앱이 자동으로 처리합니다.
              </p>
              {interactiveAuth.authCode ? (
                <p className="terminal-interactive-auth__code">
                  인증 코드 <code>{interactiveAuth.authCode}</code> 는 자동으로 입력됩니다.
                </p>
              ) : null}
              <div className="terminal-interactive-auth__actions">
                {interactiveAuth.approvalUrl ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      void reopenInteractiveAuthUrl();
                    }}
                  >
                    브라우저 다시 열기
                  </button>
                ) : null}
                {interactiveAuth.approvalUrl ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(interactiveAuth.approvalUrl ?? '');
                    }}
                  >
                    링크 복사
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    clearPendingInteractiveAuth();
                  }}
                >
                  닫기
                </button>
              </div>
              <pre className="terminal-interactive-auth__raw">{interactiveAuth.instruction}</pre>
            </>
          ) : (
            <form
              className="terminal-interactive-auth__form"
              onSubmit={(event) => {
                event.preventDefault();
                void respondInteractiveAuth(interactiveAuth.challengeId, promptResponses);
              }}
            >
              <div className="terminal-interactive-auth__eyebrow">Additional Authentication</div>
              <strong>추가 인증 입력이 필요합니다.</strong>
              {interactiveAuth.instruction ? <p>{interactiveAuth.instruction}</p> : null}
              {interactiveAuth.prompts.map((prompt, index) => (
                <label key={`${interactiveAuth.challengeId}:${index}`} className="terminal-interactive-auth__field">
                  <span>{prompt.label || `Prompt ${index + 1}`}</span>
                  <input
                    type={prompt.echo ? 'text' : 'password'}
                    value={promptResponses[index] ?? ''}
                    onChange={(inputEvent) => {
                      const nextResponses = [...promptResponses];
                      nextResponses[index] = inputEvent.target.value;
                      setPromptResponses(nextResponses);
                    }}
                  />
                </label>
              ))}
              <div className="terminal-interactive-auth__actions">
                <button type="submit" className="primary-button">
                  응답 보내기
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    clearPendingInteractiveAuth();
                  }}
                >
                  닫기
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
      {searchOpen ? (
        <div className="terminal-search-overlay" onMouseDown={(event) => event.stopPropagation()}>
          <input
            ref={searchInputRef}
            aria-label="Search terminal output"
            type="text"
            value={searchQuery}
            placeholder="Search terminal output"
            onBlur={() => {
              runtimeRef.current?.blurSearch();
            }}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setSearchQuery(nextQuery);
              if (!nextQuery.trim()) {
                runtimeRef.current?.clearSearch();
                return;
              }
              runtimeRef.current?.findNext(nextQuery);
            }}
            onKeyDown={(event) => {
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
            }}
          />
          <button
            type="button"
            className="terminal-search-overlay__button"
            onClick={() => {
              runtimeRef.current?.findPrevious(searchQuery);
            }}
          >
            Prev
          </button>
          <button
            type="button"
            className="terminal-search-overlay__button"
            onClick={() => {
              runtimeRef.current?.findNext(searchQuery);
            }}
          >
            Next
          </button>
          <button type="button" className="terminal-search-overlay__button" onClick={closeSearchOverlay}>
            Close
          </button>
        </div>
      ) : null}
      <div ref={containerRef} className="terminal-canvas">
        {shouldShowConnectionOverlay ? (
          <div
            className={`terminal-connection-overlay ${
              currentTab?.status === 'error' ? 'terminal-connection-overlay--error' : 'terminal-connection-overlay--blocking'
            }`}
          >
            <strong>{connectionOverlayTitle}</strong>
            <span>{connectionOverlayMessage}</span>
            {currentTab?.status === 'error' ? (
              <div className="terminal-connection-overlay__actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    void onRetry?.();
                  }}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    void onClose?.();
                  }}
                >
                  Close
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function resolveTerminalAppearanceForSession(
  settings: AppSettings,
  hosts: HostRecord[],
  tab: TerminalTab
): TerminalSessionViewProps['appearance'] {
  const host =
    tab.source === 'host' && tab.hostId ? hosts.find((record) => record.id === tab.hostId) : undefined;
  const themePreset = getTerminalThemePreset(host?.terminalThemeId ?? settings.globalTerminalThemeId);
  const fontOption = getTerminalFontOption(settings.terminalFontFamily);
  return {
    theme: themePreset.theme,
    fontFamily: fontOption.stack,
    fontSize: settings.terminalFontSize,
    scrollbackLines: settings.terminalScrollbackLines,
    lineHeight: settings.terminalLineHeight,
    letterSpacing: settings.terminalLetterSpacing,
    minimumContrastRatio: settings.terminalMinimumContrastRatio,
    macOptionIsMeta: isMacPlatform() ? settings.terminalAltIsMeta : undefined
  };
}

export function TerminalWorkspace({
  tabs,
  hosts,
  settings,
  activeSessionId,
  activeWorkspace,
  draggedSession,
  canDropDraggedSession,
  onCloseSession,
  onRetryConnection,
  onStartSessionShare,
  onUpdateSessionShareSnapshot,
  onSetSessionShareInputEnabled,
  onStopSessionShare,
  onStartPaneDrag,
  onEndSessionDrag,
  onSplitSessionDrop,
  onFocusWorkspaceSession,
  onResizeWorkspaceSplit
}: TerminalWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [resizingHandle, setResizingHandle] = useState<SplitHandlePlacement | null>(null);
  const pendingInteractiveAuth = useAppStore((state) => state.pendingInteractiveAuth);

  const workspaceLayout = useMemo(() => {
    if (!activeWorkspace) {
      return null;
    }
    const placements: SessionPlacement[] = [];
    const handles: SplitHandlePlacement[] = [];
    collectWorkspacePlacements(
      activeWorkspace.layout,
      {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      placements,
      handles
    );
    return { placements, handles };
  }, [activeWorkspace]);

  const appearanceBySessionId = useMemo(() => {
    const next = new Map<string, TerminalSessionViewProps['appearance']>();
    for (const tab of tabs) {
      next.set(tab.sessionId, resolveTerminalAppearanceForSession(settings, hosts, tab));
    }
    return next;
  }, [
    hosts,
    settings.globalTerminalThemeId,
    settings.terminalFontFamily,
    settings.terminalFontSize,
    settings.terminalScrollbackLines,
    settings.terminalLineHeight,
    settings.terminalLetterSpacing,
    settings.terminalMinimumContrastRatio,
    settings.terminalAltIsMeta,
    tabs
  ]);

  useEffect(() => {
    if (draggedSession?.source !== 'standalone-tab' || !canDropDraggedSession) {
      setDropPreview(null);
    }
  }, [canDropDraggedSession, draggedSession]);

  useEffect(() => {
    if (!resizingHandle) {
      return;
    }

    const handlePointerMove = (event: MouseEvent) => {
      const container = workspaceRef.current;
      if (!container || !activeWorkspace) {
        return;
      }
      const bounds = container.getBoundingClientRect();
      const splitLeft = bounds.left + resizingHandle.rect.x * bounds.width;
      const splitTop = bounds.top + resizingHandle.rect.y * bounds.height;
      const splitWidth = resizingHandle.rect.width * bounds.width;
      const splitHeight = resizingHandle.rect.height * bounds.height;

      if (resizingHandle.axis === 'horizontal' && splitWidth > 0) {
        const ratio = (event.clientX - splitLeft) / splitWidth;
        onResizeWorkspaceSplit(activeWorkspace.id, resizingHandle.splitId, ratio);
        return;
      }

      if (resizingHandle.axis === 'vertical' && splitHeight > 0) {
        const ratio = (event.clientY - splitTop) / splitHeight;
        onResizeWorkspaceSplit(activeWorkspace.id, resizingHandle.splitId, ratio);
      }
    };

    const handlePointerUp = () => {
      setResizingHandle(null);
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
    };
  }, [activeWorkspace, onResizeWorkspaceSplit, resizingHandle]);

  if (tabs.length === 0) {
    return (
      <div className="terminal-empty">
        <div className="empty-state-card">
          <div className="section-title">연결 준비 완료</div>
          <h3>첫 SSH 세션을 시작해보세요</h3>
          <p>호스트 카드를 더블클릭하면 새 세션이 탭으로 열리고, 탭을 아래로 끌어내리면 여러 세션을 나란히 볼 수 있습니다.</p>
        </div>
      </div>
    );
  }

  const visibleSessionIds = new Set<string>();
  const placementBySessionId = new Map<string, SessionPlacement>();

  if (activeWorkspace && workspaceLayout) {
    for (const placement of workspaceLayout.placements) {
      visibleSessionIds.add(placement.sessionId);
      placementBySessionId.set(placement.sessionId, placement);
    }
  } else if (activeSessionId) {
    visibleSessionIds.add(activeSessionId);
    placementBySessionId.set(activeSessionId, {
      sessionId: activeSessionId,
      rect: { x: 0, y: 0, width: 1, height: 1 }
    });
  }

  const handleStandaloneDropPreview = (event: React.DragEvent<HTMLDivElement>) => {
    if (draggedSession?.source !== 'standalone-tab' || !canDropDraggedSession || !activeSessionId) {
      return;
    }
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const direction = resolveDropDirection(event.clientX, event.clientY, bounds);
    const rootRect = { x: 0, y: 0, width: 1, height: 1 };
    setDropPreview({
      direction,
      targetSessionId: activeSessionId,
      rect: directionPreviewRect(rootRect, direction)
    });
  };

  return (
    <div
      ref={workspaceRef}
      className={`terminal-workspace ${activeWorkspace ? 'terminal-workspace--split' : 'terminal-workspace--standalone'} ${
        draggedSession?.source === 'standalone-tab' && canDropDraggedSession ? 'drag-accepting' : ''
      }`}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        setDropPreview(null);
      }}
      onDragOver={!activeWorkspace ? handleStandaloneDropPreview : undefined}
      onDrop={
        !activeWorkspace
          ? (event) => {
              if (draggedSession?.source !== 'standalone-tab' || !dropPreview) {
                return;
              }
              event.preventDefault();
              onSplitSessionDrop(draggedSession.sessionId, dropPreview.direction);
              setDropPreview(null);
              onEndSessionDrag();
            }
          : undefined
      }
    >
      {tabs.map((tab) => {
        const placement = placementBySessionId.get(tab.sessionId);
        const visible = visibleSessionIds.has(tab.sessionId);
        const isWorkspacePane = Boolean(activeWorkspace && placement);
        const rectStyle = placement ? toPercentRectStyle(placement.rect) : undefined;

        return (
          <div
            key={`${tab.sessionId}:${activeWorkspace ? 'workspace' : 'standalone'}`}
            className={isWorkspacePane ? 'terminal-pane-slot' : undefined}
            style={isWorkspacePane ? rectStyle : undefined}
            onDragOver={
              isWorkspacePane
                ? (event) => {
                    if (draggedSession?.source !== 'standalone-tab' || !canDropDraggedSession) {
                      return;
                    }
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const direction = resolveDropDirection(event.clientX, event.clientY, bounds);
                    if (!placement) {
                      return;
                    }
                    setDropPreview({
                      direction,
                      targetSessionId: tab.sessionId,
                      rect: directionPreviewRect(placement.rect, direction)
                    });
                  }
                : undefined
            }
            onDrop={
              isWorkspacePane
                ? (event) => {
                    if (draggedSession?.source !== 'standalone-tab' || !dropPreview) {
                      return;
                    }
                    event.preventDefault();
                    onSplitSessionDrop(draggedSession.sessionId, dropPreview.direction, tab.sessionId);
                    setDropPreview(null);
                    onEndSessionDrag();
                  }
                : undefined
            }
          >
            <TerminalSessionView
              sessionId={tab.sessionId}
              title={tab.title}
              visible={visible}
              active={activeWorkspace ? activeWorkspace.activeSessionId === tab.sessionId : activeSessionId === tab.sessionId}
              layoutKey={placement ? `${placement.rect.x}:${placement.rect.y}:${placement.rect.width}:${placement.rect.height}` : 'hidden'}
              appearance={appearanceBySessionId.get(tab.sessionId) ?? resolveTerminalAppearanceForSession(settings, hosts, tab)}
              terminalWebglEnabled={settings.terminalWebglEnabled}
              style={activeWorkspace ? undefined : rectStyle}
              showHeader={Boolean(activeWorkspace && placement)}
              interactiveAuth={pendingInteractiveAuth?.sessionId === tab.sessionId ? pendingInteractiveAuth : null}
              onStartSessionShare={onStartSessionShare}
              onUpdateSessionShareSnapshot={onUpdateSessionShareSnapshot}
              onSetSessionShareInputEnabled={onSetSessionShareInputEnabled}
              onStopSessionShare={onStopSessionShare}
              onFocus={
                activeWorkspace
                  ? () => {
                      onFocusWorkspaceSession(activeWorkspace.id, tab.sessionId);
                    }
                  : undefined
              }
              onClose={async () => {
                await onCloseSession(tab.sessionId);
              }}
              onRetry={
                async () => {
                  await onRetryConnection(tab.sessionId);
                }
              }
              onStartDrag={
                activeWorkspace && placement
                  ? () => {
                      onStartPaneDrag(activeWorkspace.id, tab.sessionId);
                    }
                  : undefined
              }
              onEndDrag={activeWorkspace && placement ? onEndSessionDrag : undefined}
            />
          </div>
        );
      })}

      {activeWorkspace && workspaceLayout
        ? workspaceLayout.handles.map((handle) => {
            const style: React.CSSProperties =
              handle.axis === 'horizontal'
                ? {
                    left: `${(handle.rect.x + handle.rect.width * handle.ratio) * 100}%`,
                    top: `${handle.rect.y * 100}%`,
                    height: `${handle.rect.height * 100}%`
                  }
                : {
                    top: `${(handle.rect.y + handle.rect.height * handle.ratio) * 100}%`,
                    left: `${handle.rect.x * 100}%`,
                    width: `${handle.rect.width * 100}%`
                  };

            return (
              <div
                key={handle.splitId}
                className={`workspace-split-handle ${handle.axis === 'horizontal' ? 'vertical' : 'horizontal'}`}
                style={style}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setResizingHandle(handle);
                }}
              />
            );
          })
        : null}

      {dropPreview ? <div className="workspace-drop-preview" style={toPercentRectStyle(dropPreview.rect)} /> : null}
    </div>
  );
}
