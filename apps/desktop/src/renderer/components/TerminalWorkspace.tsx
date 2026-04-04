import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type {
  AppSettings,
  HostRecord,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  TerminalTab,
} from '@shared';
import { useTerminalWorkspaceController } from '../controllers/useTerminalWorkspaceController';
import type { WorkspaceDropDirection, WorkspaceTab } from '../store/createAppStore';
import {
  getTerminalFontOption,
  getTerminalThemePreset,
  resolveTerminalThemeIdForSession,
} from '../lib/terminal-presets';
import { TerminalSessionPane } from './terminal-workspace/TerminalSessionPane';
import { TerminalWorkspaceLayoutView } from './terminal-workspace/TerminalWorkspaceLayoutView';
import {
  collectWorkspacePlacements,
  directionPreviewRect,
  listWorkspaceSessionIds,
  resolveDropDirection,
  toPercentRectStyle,
} from './terminal-workspace/terminalWorkspaceLayout';
import type {
  DraggedSessionPayload,
  DropPreview,
  SessionPlacement,
  SplitHandlePlacement,
  TerminalSessionAppearance,
  TerminalWorkspacePaneSlot,
} from './terminal-workspace/types';

export {
  didTerminalSessionJustConnect,
  getVisibleSessionShareChatNotifications,
  mergeSessionShareSnapshotKinds,
  resolveTerminalRuntimeWebglEnabled,
  SESSION_SHARE_CHAT_TOAST_LIMIT,
  SESSION_SHARE_CHAT_TOAST_TTL_MS,
  shouldOpenTerminalSearch,
  shouldShowSessionOverlay,
} from './terminal-workspace/terminalSessionHelpers';

interface TerminalWorkspaceProps {
  tabs: TerminalTab[];
  hosts: HostRecord[];
  settings: AppSettings;
  prefersDark: boolean;
  activeSessionId: string | null;
  activeWorkspace: WorkspaceTab | null;
  viewActivationKey: string | null;
  draggedSession: DraggedSessionPayload | null;
  canDropDraggedSession: boolean;
  onCloseSession: (sessionId: string) => Promise<void>;
  onRetryConnection: (sessionId: string) => Promise<void>;
  onStartSessionShare: (input: SessionShareStartInput) => Promise<void>;
  onUpdateSessionShareSnapshot: (
    input: SessionShareSnapshotInput,
  ) => Promise<void>;
  onSetSessionShareInputEnabled: (
    sessionId: string,
    inputEnabled: boolean,
  ) => Promise<void>;
  onStopSessionShare: (sessionId: string) => Promise<void>;
  onOpenSessionShareChatWindow?: (sessionId: string) => Promise<void>;
  onStartPaneDrag: (workspaceId: string, sessionId: string) => void;
  onEndSessionDrag: () => void;
  onSplitSessionDrop: (
    sessionId: string,
    direction: WorkspaceDropDirection,
    targetSessionId?: string,
  ) => boolean;
  onMoveWorkspaceSession: (
    workspaceId: string,
    sessionId: string,
    direction: WorkspaceDropDirection,
    targetSessionId: string,
  ) => boolean;
  onFocusWorkspaceSession: (workspaceId: string, sessionId: string) => void;
  onToggleWorkspaceBroadcast: (workspaceId: string) => void;
  onResizeWorkspaceSplit: (
    workspaceId: string,
    splitId: string,
    ratio: number,
  ) => void;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /mac/i.test(navigator.userAgent) || /mac/i.test(navigator.platform);
}

function isConnectedHostSession(tab: TerminalTab | undefined): boolean {
  return tab?.source === 'host' && tab.status === 'connected';
}

function resolveTerminalAppearanceForSession(
  settings: AppSettings,
  hosts: HostRecord[],
  tab: TerminalTab,
  prefersDark: boolean,
): TerminalSessionAppearance {
  const host =
    tab.source === 'host' && tab.hostId
      ? hosts.find((record) => record.id === tab.hostId)
      : undefined;
  const resolvedThemeId = resolveTerminalThemeIdForSession(
    host?.terminalThemeId,
    settings.globalTerminalThemeId,
    prefersDark,
  );
  const themePreset = getTerminalThemePreset(resolvedThemeId);
  const fontOption = getTerminalFontOption(settings.terminalFontFamily);
  return {
    theme: themePreset.theme,
    fontFamily: fontOption.stack,
    fontSize: settings.terminalFontSize,
    scrollbackLines: settings.terminalScrollbackLines,
    lineHeight: settings.terminalLineHeight,
    letterSpacing: settings.terminalLetterSpacing,
    minimumContrastRatio: settings.terminalMinimumContrastRatio,
    macOptionIsMeta: isMacPlatform() ? settings.terminalAltIsMeta : undefined,
  };
}

export function TerminalWorkspace({
  tabs,
  hosts,
  settings,
  prefersDark,
  activeSessionId,
  activeWorkspace,
  viewActivationKey,
  draggedSession,
  canDropDraggedSession,
  onCloseSession,
  onRetryConnection,
  onStartSessionShare,
  onUpdateSessionShareSnapshot,
  onSetSessionShareInputEnabled,
  onStopSessionShare,
  onOpenSessionShareChatWindow,
  onStartPaneDrag,
  onEndSessionDrag,
  onSplitSessionDrop,
  onMoveWorkspaceSession,
  onFocusWorkspaceSession,
  onToggleWorkspaceBroadcast,
  onResizeWorkspaceSplit,
}: TerminalWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [resizingHandle, setResizingHandle] =
    useState<SplitHandlePlacement | null>(null);
  const [isBroadcastTooltipVisible, setIsBroadcastTooltipVisible] =
    useState(false);
  const terminalController = useTerminalWorkspaceController({
    activeWorkspace,
    tabs,
  });

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
        height: 1,
      },
      placements,
      handles,
    );
    return { placements, handles };
  }, [activeWorkspace]);

  const appearanceBySessionId = useMemo(() => {
    const next = new Map<string, TerminalSessionAppearance>();
    for (const tab of tabs) {
      next.set(
        tab.sessionId,
        resolveTerminalAppearanceForSession(settings, hosts, tab, prefersDark),
      );
    }
    return next;
  }, [
    hosts,
    prefersDark,
    settings.globalTerminalThemeId,
    settings.terminalAltIsMeta,
    settings.terminalFontFamily,
    settings.terminalFontSize,
    settings.terminalLetterSpacing,
    settings.terminalLineHeight,
    settings.terminalMinimumContrastRatio,
    settings.terminalScrollbackLines,
    tabs,
  ]);

  const tabsBySessionId = terminalController.tabsBySessionId;

  const activeWorkspaceSessionIds = useMemo(() => {
    if (!activeWorkspace) {
      return [];
    }

    return listWorkspaceSessionIds(activeWorkspace.layout);
  }, [activeWorkspace]);

  const connectedWorkspaceHostSessionIds = useMemo(
    () =>
      activeWorkspaceSessionIds.filter((sessionId) =>
        isConnectedHostSession(tabsBySessionId.get(sessionId)),
      ),
    [activeWorkspaceSessionIds, tabsBySessionId],
  );

  const shouldShowBroadcastControl = Boolean(
    activeWorkspace && activeWorkspaceSessionIds.length >= 2,
  );
  const isWorkspaceBroadcastEnabled = Boolean(
    activeWorkspace?.broadcastEnabled,
  );
  const isBroadcastToggleDisabled =
    !isWorkspaceBroadcastEnabled && connectedWorkspaceHostSessionIds.length < 2;
  const broadcastButtonLabel = isWorkspaceBroadcastEnabled
    ? '브로드캐스트 끄기'
    : '브로드캐스트 켜기';
  const broadcastTooltipText = isWorkspaceBroadcastEnabled
    ? '브로드캐스트 활성 상태'
    : isBroadcastToggleDisabled
      ? '원격 pane 2개 이상 연결 시 사용 가능'
      : '브로드캐스트 켜기';
  const broadcastTooltipId = activeWorkspace
    ? `workspace-broadcast-tooltip-${activeWorkspace.id}`
    : undefined;

  useEffect(() => {
    if (draggedSession?.source !== 'standalone-tab' || !canDropDraggedSession) {
      setDropPreview(null);
    }
  }, [canDropDraggedSession, draggedSession]);

  useEffect(() => {
    setDropPreview(null);
    setResizingHandle(null);
    setIsBroadcastTooltipVisible(false);
  }, [viewActivationKey]);

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
          <p>
            호스트 카드를 더블클릭하면 새 세션이 탭으로 열리고, 탭을 아래로
            끌어내리면 여러 세션을 나란히 볼 수 있습니다.
          </p>
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
      rect: { x: 0, y: 0, width: 1, height: 1 },
    });
  }

  const handleStandaloneDropPreview = (event: DragEvent<HTMLDivElement>) => {
    if (
      draggedSession?.source !== 'standalone-tab' ||
      !canDropDraggedSession ||
      !activeSessionId
    ) {
      return;
    }

    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const direction = resolveDropDirection(event.clientX, event.clientY, bounds);
    const rootRect = { x: 0, y: 0, width: 1, height: 1 };
    setDropPreview({
      direction,
      targetSessionId: activeSessionId,
      rect: directionPreviewRect(rootRect, direction),
    });
  };

  const canRearrangeActiveWorkspace =
    draggedSession?.source === 'workspace-pane' &&
    Boolean(activeWorkspace) &&
    draggedSession.workspaceId === activeWorkspace?.id;

  const workspaceClassName = `terminal-workspace ${
    activeWorkspace
      ? 'terminal-workspace--split'
      : 'terminal-workspace--standalone'
  } ${
    (draggedSession?.source === 'standalone-tab' && canDropDraggedSession) ||
    canRearrangeActiveWorkspace
      ? 'drag-accepting'
      : ''
  }`;

  const workspacePaneSlots: TerminalWorkspacePaneSlot[] = tabs.map((tab) => {
    const placement = placementBySessionId.get(tab.sessionId);
    const visible = visibleSessionIds.has(tab.sessionId);
    const isWorkspacePane = Boolean(activeWorkspace && placement);
    const rectStyle = placement ? toPercentRectStyle(placement.rect) : undefined;

    return {
      key: `${tab.sessionId}:${activeWorkspace ? 'workspace' : 'standalone'}`,
      className: isWorkspacePane ? 'terminal-pane-slot' : undefined,
      style: isWorkspacePane ? rectStyle : undefined,
      onDragOver: isWorkspacePane
        ? (event) => {
            if (!placement) {
              return;
            }
            if (draggedSession?.source === 'workspace-pane') {
              if (
                !canRearrangeActiveWorkspace ||
                draggedSession.sessionId === tab.sessionId
              ) {
                return;
              }
            } else if (
              draggedSession?.source !== 'standalone-tab' ||
              !canDropDraggedSession
            ) {
              return;
            }
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            const direction = resolveDropDirection(
              event.clientX,
              event.clientY,
              bounds,
            );
            setDropPreview({
              direction,
              targetSessionId: tab.sessionId,
              rect: directionPreviewRect(placement.rect, direction),
            });
          }
        : undefined,
      onDrop: isWorkspacePane
        ? (event) => {
            if (!dropPreview || !activeWorkspace) {
              return;
            }
            if (
              draggedSession?.source === 'workspace-pane' &&
              (!canRearrangeActiveWorkspace ||
                draggedSession.sessionId === tab.sessionId)
            ) {
              return;
            }
            if (
              draggedSession?.source !== 'workspace-pane' &&
              draggedSession?.source !== 'standalone-tab'
            ) {
              return;
            }
            event.preventDefault();
            if (draggedSession.source === 'workspace-pane') {
              onMoveWorkspaceSession(
                activeWorkspace.id,
                draggedSession.sessionId,
                dropPreview.direction,
                tab.sessionId,
              );
            } else {
              onSplitSessionDrop(
                draggedSession.sessionId,
                dropPreview.direction,
                tab.sessionId,
              );
            }
            setDropPreview(null);
            onEndSessionDrag();
          }
        : undefined,
      content: (
        <TerminalSessionPane
          sessionId={tab.sessionId}
          tab={tab}
          title={tab.title}
          visible={visible}
          active={
            activeWorkspace
              ? activeWorkspace.activeSessionId === tab.sessionId
              : activeSessionId === tab.sessionId
          }
          viewActivationKey={viewActivationKey}
          layoutKey={
            placement
              ? `${placement.rect.x}:${placement.rect.y}:${placement.rect.width}:${placement.rect.height}`
              : 'hidden'
          }
          appearance={
            appearanceBySessionId.get(tab.sessionId) ??
            resolveTerminalAppearanceForSession(settings, hosts, tab, prefersDark)
          }
          terminalWebglEnabled={settings.terminalWebglEnabled}
          style={activeWorkspace ? undefined : rectStyle}
          showHeader={Boolean(activeWorkspace && placement)}
          host={
            tab.source === 'host' && tab.hostId
              ? hosts.find((record) => record.id === tab.hostId)
              : undefined
          }
          interactiveAuth={terminalController.getInteractiveAuth(tab.sessionId)}
          sessionShareChatNotifications={terminalController.getSessionShareChatNotifications(
            tab.sessionId,
          )}
          onDismissSessionShareChatNotification={
            terminalController.dismissSessionShareChatNotification
          }
          onRespondInteractiveAuth={terminalController.respondInteractiveAuth}
          onReopenInteractiveAuthUrl={
            terminalController.reopenInteractiveAuthUrl
          }
          onClearPendingInteractiveAuth={
            terminalController.clearPendingInteractiveAuth
          }
          onSessionData={terminalController.onSessionData}
          onResizeSession={terminalController.onResizeSession}
          onStartSessionShare={onStartSessionShare}
          onUpdateSessionShareSnapshot={onUpdateSessionShareSnapshot}
          onSetSessionShareInputEnabled={onSetSessionShareInputEnabled}
          onStopSessionShare={onStopSessionShare}
          onOpenSessionShareChatWindow={onOpenSessionShareChatWindow}
          onSendInput={(sessionId, data) => {
            terminalController.sendSessionInput(sessionId, data);
          }}
          onSendBinaryInput={(sessionId, data) => {
            terminalController.sendSessionBinaryInput(sessionId, data);
          }}
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
          onRetry={async () => {
            await onRetryConnection(tab.sessionId);
          }}
          onStartDrag={
            activeWorkspace && placement
              ? () => {
                  onStartPaneDrag(activeWorkspace.id, tab.sessionId);
                }
              : undefined
          }
          onEndDrag={activeWorkspace && placement ? onEndSessionDrag : undefined}
        />
      ),
    };
  });

  return (
    <TerminalWorkspaceLayoutView
      workspaceRef={workspaceRef}
      className={workspaceClassName}
      onDragLeave={(event: DragEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        setDropPreview(null);
      }}
      onDragOver={!activeWorkspace ? handleStandaloneDropPreview : undefined}
      onDrop={
        !activeWorkspace
          ? (event: DragEvent<HTMLDivElement>) => {
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
      shouldShowBroadcastControl={shouldShowBroadcastControl && Boolean(activeWorkspace)}
      isWorkspaceBroadcastEnabled={isWorkspaceBroadcastEnabled}
      isBroadcastToggleDisabled={isBroadcastToggleDisabled}
      broadcastButtonLabel={broadcastButtonLabel}
      broadcastTooltipText={broadcastTooltipText}
      broadcastTooltipId={broadcastTooltipId}
      isBroadcastTooltipVisible={isBroadcastTooltipVisible}
      onBroadcastTooltipVisibleChange={setIsBroadcastTooltipVisible}
      onToggleBroadcast={() => {
        if (!activeWorkspace) {
          return;
        }
        onToggleWorkspaceBroadcast(activeWorkspace.id);
      }}
      paneSlots={workspacePaneSlots}
      handles={activeWorkspace && workspaceLayout ? workspaceLayout.handles : []}
      onStartResizeHandle={setResizingHandle}
      dropPreview={dropPreview}
    />
  );
}
