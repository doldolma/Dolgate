import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { AppSettings, HostRecord, TerminalTab } from '@shared';
import type { WorkspaceDropDirection, WorkspaceLayoutNode, WorkspaceTab } from '../store/createAppStore';
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
  };
  style?: React.CSSProperties;
  showHeader?: boolean;
  draggingDisabled?: boolean;
  onFocus?: () => void;
  onClose?: () => Promise<void>;
  onStartDrag?: () => void;
  onEndDrag?: () => void;
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
  style,
  showHeader = false,
  draggingDisabled = false,
  onFocus,
  onClose,
  onStartDrag,
  onEndDrag
}: TerminalSessionViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeSchedulerRef = useRef<ReturnType<typeof createTerminalResizeScheduler> | null>(null);
  const tabs = useAppStore((state) => state.tabs);
  const currentTab = tabs.find((tab) => tab.sessionId === sessionId);

  function refreshViewport() {
    const terminal = terminalRef.current;
    if (!terminal || terminal.rows <= 0) {
      return;
    }
    terminal.refresh(0, terminal.rows - 1);
  }

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      theme: appearance.theme
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.onData((data) => {
      void window.dolssh.ssh.write(sessionId, data);
    });
    terminal.onBinary((data) => {
      const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0));
      void window.dolssh.ssh.writeBinary(sessionId, bytes);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    resizeSchedulerRef.current = createTerminalResizeScheduler({
      fit: () => {
        fitAddon.fit();
      },
      readSize: () => ({
        cols: terminal.cols,
        rows: terminal.rows
      }),
      afterResize: () => {
        refreshViewport();
      },
      sendResize: ({ cols, rows }) => window.dolssh.ssh.resize(sessionId, cols, rows)
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
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }
    terminalRef.current.options.theme = appearance.theme;
    terminalRef.current.options.fontFamily = appearance.fontFamily;
    terminalRef.current.options.fontSize = appearance.fontSize;
    resizeSchedulerRef.current?.request();
    refreshViewport();
  }, [appearance]);

  useEffect(() => window.dolssh.ssh.onData(sessionId, (chunk) => {
    terminalRef.current?.write(chunk);
  }), [sessionId]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    resizeSchedulerRef.current?.request();
    requestAnimationFrame(() => {
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
    });
  }, [layoutKey, visible]);

  useEffect(() => {
    if (active && visible) {
      terminalRef.current?.focus();
      resizeSchedulerRef.current?.request();
      requestAnimationFrame(() => {
        refreshViewport();
      });
    }
  }, [active, visible]);

  return (
    <div
      className={`terminal-session ${visible ? 'visible' : 'hidden'} ${active ? 'active' : ''} ${showHeader ? 'terminal-session--pane' : ''}`}
      style={style}
      onMouseDown={() => {
        onFocus?.();
      }}
    >
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
      <div ref={containerRef} className="terminal-canvas" />
    </div>
  );
}

function resolveTerminalAppearanceForSession(
  settings: AppSettings,
  hosts: HostRecord[],
  tab: TerminalTab
): TerminalSessionViewProps['appearance'] {
  const host = hosts.find((record) => record.id === tab.hostId);
  const themePreset = getTerminalThemePreset(host?.terminalThemeId ?? settings.globalTerminalThemeId);
  const fontOption = getTerminalFontOption(settings.terminalFontFamily);
  return {
    theme: themePreset.theme,
    fontFamily: fontOption.stack,
    fontSize: settings.terminalFontSize
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
  onStartPaneDrag,
  onEndSessionDrag,
  onSplitSessionDrop,
  onFocusWorkspaceSession,
  onResizeWorkspaceSplit
}: TerminalWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [resizingHandle, setResizingHandle] = useState<SplitHandlePlacement | null>(null);

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
  }, [hosts, settings.globalTerminalThemeId, settings.terminalFontFamily, settings.terminalFontSize, tabs]);

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
              style={activeWorkspace ? undefined : rectStyle}
              showHeader={Boolean(activeWorkspace && placement)}
              onFocus={
                activeWorkspace
                  ? () => {
                      onFocusWorkspaceSession(activeWorkspace.id, tab.sessionId);
                    }
                  : undefined
              }
              onClose={
                placement
                  ? async () => {
                      await onCloseSession(tab.sessionId);
                    }
                  : undefined
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
