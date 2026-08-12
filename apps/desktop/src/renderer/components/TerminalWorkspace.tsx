import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { VncHostRecord,
  AppSettings,
  HostRecord,
  RdpHostRecord,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  TerminalTab,
} from '@shared';
import { isVncHostRecord, isRdpHostRecord } from '@shared';
import { useTerminalWorkspaceController } from '../controllers/useTerminalWorkspaceController';
import type {
  WorkspaceDropDirection,
  WorkspaceLayoutNode,
  WorkspaceTab,
} from '../store/createAppStore';
import {
  getTerminalFontOption,
  getTerminalThemePreset,
  resolveTerminalThemeIdForSession,
} from '../lib/terminal-presets';
import { RdpSessionCanvas } from './rdp/RdpSessionCanvas';
import { VncSessionCanvas } from './vnc/VncSessionCanvas';
import { VncConnectionOverlay } from './vnc/VncConnectionOverlay';
import { RdpConnectionOverlay } from './rdp/RdpConnectionOverlay';
import { TerminalSessionPane } from './terminal-workspace/TerminalSessionPane';
import { TerminalWorkspaceLayoutView } from './terminal-workspace/TerminalWorkspaceLayoutView';
import { resizeTerminal, tmuxCommand } from '../services/desktop/terminal';
import { getTerminalCellSize } from '../lib/terminal-write-registry';
import { SectionLabel } from '../ui';
import { cn } from '../lib/cn';
import {
  collectWorkspacePlacements,
  directionPreviewRect,
  findSplitNodeById,
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
import { useTranslation } from 'react-i18next';

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
  onCancelReconnect: (sessionId: string) => void;
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

/** 이 탭의 RDP 호스트. 오디오·클립보드처럼 호스트에 저장된 설정을 읽는 데 쓴다. */
function rdpHostFor(hosts: HostRecord[], tab: TerminalTab): RdpHostRecord | undefined {
  if (!tab.hostId) {
    return undefined;
  }
  const host = hosts.find((record) => record.id === tab.hostId);
  return host && isRdpHostRecord(host) ? host : undefined;
}

function vncHostFor(hosts: HostRecord[], tab: TerminalTab): VncHostRecord | undefined {
  if (!tab.hostId) {
    return undefined;
  }
  const host = hosts.find((record) => record.id === tab.hostId);
  return host && isVncHostRecord(host) ? host : undefined;
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
  onCancelReconnect,
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
  const { t: translate } = useTranslation();
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [resizingHandle, setResizingHandle] =
    useState<SplitHandlePlacement | null>(null);
  // tmux pane 리사이즈 드래그 중 마지막으로 보낸 target 칸 수(중복 resize-pane 전송 억제).
  const lastTmuxResizeRef = useRef<number | null>(null);
  // 드래그 시작 시 캡처한 양쪽 pane sessionId. split id 는 %layout-change 마다 재생성되므로
  // 그것 대신 안정적인 pane sessionId 로 매 mousemove 에 resize-pane 을 보낸다.
  const tmuxResizeRef = useRef<{ firstSid: string; secondSid: string } | null>(
    null,
  );
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

  // tmux pane 별 tmux 레이아웃 칸 수(cols×rows). leaf 에 실린 값을 sessionId 로 모은다.
  // pane 의 xterm 을 이 크기로 고정해 tmux pane 크기와 1:1 일치 → 분할 셰이크 제거.
  const tmuxCellBySessionId = useMemo(() => {
    const map = new Map<string, { cols: number; rows: number }>();
    if (!activeWorkspace) {
      return map;
    }
    const walk = (node: WorkspaceLayoutNode) => {
      if (node.kind === 'leaf') {
        if (node.cols && node.rows) {
          map.set(node.sessionId, { cols: node.cols, rows: node.rows });
        }
        return;
      }
      walk(node.first);
      walk(node.second);
    };
    walk(activeWorkspace.layout);
    return map;
  }, [activeWorkspace]);

  // tmux control-client 크기 보고: 워크스페이스 컨테이너 전체를 칸 수로 환산해 1회 보고한다.
  // pane 들은 개별 보고를 하지 않으므로(셰이크 방지) 여기가 유일한 드라이버다. tmux 가 이
  // total 을 layout 에 따라 pane 들에 나눠주고, 각 pane 의 xterm 은 그 layout 칸 수로 고정된다.
  // 컨테이너 픽셀 크기는 %layout-change 재렌더로 바뀌지 않으므로(앱 창 리사이즈 때만) 루프 없음.
  const liveTmuxWorkspaceRef = useRef(activeWorkspace);
  liveTmuxWorkspaceRef.current = activeWorkspace;
  const liveTabsForCellRef = useRef(tabs);
  liveTabsForCellRef.current = tabs;
  const lastReportedClientSizeRef = useRef({ cols: 0, rows: 0 });
  const tmuxControlSessionId = activeWorkspace?.tmux?.controlSessionId ?? null;
  useEffect(() => {
    const container = workspaceRef.current;
    if (!container || !tmuxControlSessionId) {
      return;
    }
    lastReportedClientSizeRef.current = { cols: 0, rows: 0 };
    let frame = 0;
    let cellRetries = 0;
    const measureAndReport = () => {
      frame = 0;
      const workspace = liveTmuxWorkspaceRef.current;
      const paneSessionId = workspace
        ? listWorkspaceSessionIds(workspace.layout).find((sessionId) =>
            sessionId.startsWith('tmux:'),
          )
        : undefined;
      if (!paneSessionId) {
        return;
      }
      const stableId = liveTabsForCellRef.current.find(
        (tab) => tab.sessionId === paneSessionId,
      )?.stableId;
      const cell = stableId ? getTerminalCellSize(stableId) : null;
      if (!cell) {
        if (cellRetries < 60) {
          cellRetries += 1;
          frame = requestAnimationFrame(measureAndReport);
        }
        return;
      }
      cellRetries = 0;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      const cols = Math.max(1, Math.floor(rect.width / cell.width));
      const rows = Math.max(1, Math.floor(rect.height / cell.height));
      const last = lastReportedClientSizeRef.current;
      if (cols === last.cols && rows === last.rows) {
        return;
      }
      lastReportedClientSizeRef.current = { cols, rows };
      void resizeTerminal(paneSessionId, cols, rows);
    };
    const observer = new ResizeObserver(() => {
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(measureAndReport);
    });
    observer.observe(container);
    frame = requestAnimationFrame(measureAndReport);
    return () => {
      observer.disconnect();
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, [tmuxControlSessionId, activeWorkspace?.id]);

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
    ? translate('workspace.broadcastOff')
    : translate('workspace.broadcastOn');
  const broadcastTooltipText = isWorkspaceBroadcastEnabled
    ? translate('workspace.broadcastActive')
    : isBroadcastToggleDisabled
      ? translate('workspace.broadcastNeedsPanes')
      : translate('workspace.broadcastOn');
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

    // tmux pane 은 xterm 이 tmux 셀 격자에 고정돼 있어 DOM 비율만 바꾸면 크기가 안 변한다.
    // 드래그 비율을 첫 pane 의 목표 칸 수로 환산해 resize-pane 을 보내고, tmux 의
    // %layout-change 가 셀 수를 갱신하면 xterm 이 따라온다(중복 전송은 ref 로 억제).
    const applyTmuxSplitResize = (ratio: number) => {
      const panes = tmuxResizeRef.current;
      if (!panes) {
        return;
      }
      const first = tmuxCellBySessionId.get(panes.firstSid);
      const second = tmuxCellBySessionId.get(panes.secondSid);
      if (!first || !second) {
        return;
      }
      const paneId = `%${panes.firstSid.slice(panes.firstSid.lastIndexOf(':') + 1)}`;
      const horizontal = resizingHandle.axis === 'horizontal';
      const total = horizontal
        ? first.cols + second.cols + 1
        : first.rows + second.rows + 1;
      const target = Math.min(Math.max(Math.round(ratio * total), 1), total - 1);
      if (
        target === lastTmuxResizeRef.current ||
        target === (horizontal ? first.cols : first.rows)
      ) {
        return;
      }
      lastTmuxResizeRef.current = target;
      void tmuxCommand(
        panes.firstSid,
        `resize-pane -t ${paneId} -${horizontal ? 'x' : 'y'} ${target}`,
      );
    };

    const handlePointerMove = (event: MouseEvent) => {
      const container = workspaceRef.current;
      if (!container || !activeWorkspace) {
        return;
      }
      const bounds = container.getBoundingClientRect();
      let ratio: number | null = null;
      if (resizingHandle.axis === 'horizontal') {
        const splitLeft = bounds.left + resizingHandle.rect.x * bounds.width;
        const splitWidth = resizingHandle.rect.width * bounds.width;
        if (splitWidth > 0) {
          ratio = (event.clientX - splitLeft) / splitWidth;
        }
      } else {
        const splitTop = bounds.top + resizingHandle.rect.y * bounds.height;
        const splitHeight = resizingHandle.rect.height * bounds.height;
        if (splitHeight > 0) {
          ratio = (event.clientY - splitTop) / splitHeight;
        }
      }
      if (ratio === null) {
        return;
      }

      // tmux workspace 는 tmux 가 레이아웃 권위이므로 resize-pane 으로 보낸다.
      if (activeWorkspace.tmux) {
        applyTmuxSplitResize(ratio);
        return;
      }
      onResizeWorkspaceSplit(activeWorkspace.id, resizingHandle.splitId, ratio);
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
  }, [
    activeWorkspace,
    onResizeWorkspaceSplit,
    resizingHandle,
    tmuxCellBySessionId,
  ]);

  if (tabs.length === 0) {
    return (
      <div className="grid h-full min-h-0 place-items-center rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-6 shadow-[var(--shadow-soft)]">
        <div className="grid w-full max-w-[46rem] gap-4 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] px-9 py-8 shadow-[var(--shadow)]">
          <SectionLabel>{translate('workspace.readySection')}</SectionLabel>
          <h3>{translate('workspace.readyTitle')}</h3>
          <p className="text-[var(--text-soft)] leading-[1.7]">
            {translate('workspace.readyHint')}
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

  const workspaceClassName = cn(
    'relative h-full min-h-0 overflow-hidden rounded-[10px] border border-[var(--border)] shadow-[var(--shadow)]',
    activeWorkspace ? '' : '',
    ((draggedSession?.source === 'standalone-tab' && canDropDraggedSession) ||
      canRearrangeActiveWorkspace) &&
      'ring-1 ring-[color-mix(in_srgb,var(--accent-strong)_24%,transparent)]',
  );

  // tmux 그룹(controlSessionId)별 재연결/에러 오버레이 "대표 pane".
  // 그룹 재연결 시 그룹 내 모든 pane 이 reconnecting 이 되어 오버레이가 분할마다
  // 중복되므로, 그룹당 하나(활성 pane 우선, 없으면 sessionId 최솟값)에서만 그린다.
  const activePaneSessionId = activeWorkspace?.activeSessionId ?? activeSessionId;
  const tmuxOverlayPrimary = new Map<string, string>();
  for (const paneTab of tabs) {
    const controlSessionId = paneTab.tmux?.controlSessionId;
    if (!controlSessionId) {
      continue;
    }
    const current = tmuxOverlayPrimary.get(controlSessionId);
    if (current === undefined) {
      tmuxOverlayPrimary.set(controlSessionId, paneTab.sessionId);
    } else if (
      current !== activePaneSessionId &&
      (paneTab.sessionId === activePaneSessionId || paneTab.sessionId < current)
    ) {
      tmuxOverlayPrimary.set(controlSessionId, paneTab.sessionId);
    }
  }

  const workspacePaneSlots: TerminalWorkspacePaneSlot[] = tabs.map((tab) => {
    const placement = placementBySessionId.get(tab.sessionId);
    const visible = visibleSessionIds.has(tab.sessionId);
    const isWorkspacePane = Boolean(activeWorkspace && placement);
    const rectStyle = placement ? toPercentRectStyle(placement.rect) : undefined;

    return {
      // stableId 만으로 key 를 잡는다(워크스페이스/스탠드얼론 suffix 금지). suffix 를
      // activeWorkspace 전역 플래그로 붙이면, tmux/워크스페이스 탭 ↔ 스탠드얼론 세션 탭
      // 전환 시 모든 pane 의 key 가 뒤집혀 전부 remount→dispose 되고, dispose 된 터미널의
      // 큐잉된 resize 태스크가 xterm IdleTaskQueue 에서 크래시(handleResize undefined)한다.
      // 모드 전환은 remount 없이 className/style 재배치 + ResizeObserver 재fit 으로 충분.
      key: tab.stableId,
      className: isWorkspacePane ? 'absolute p-[0.25rem]' : undefined,
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
      content: tab.paneKind === 'vnc' ? (
        // VNC 탭도 터미널이 아니다. RDP 와 달리 오디오·클립보드 채널이 없어 프롭이 적다.
        <>
          <VncSessionCanvas
            sessionId={tab.sessionId}
            visible={visible}
            viewOnly={vncHostFor(hosts, tab)?.viewOnly === true}
          />
          {/* 연결 진행·실패·재연결을 pane 위에 덮는다. 이게 없으면 끊긴 세션에서 다시 시도할
              방법이 없고, 재연결 중이라는 것도 보이지 않는다. */}
          {visible ? <VncConnectionOverlay sessionId={tab.sessionId} /> : null}
        </>
      ) : tab.paneKind === 'rdp' ? (
        // RDP 탭은 터미널이 아니다 — xterm 대신 원격 화면 캔버스를 띄운다.
        //
        // 오디오·클립보드는 호스트 설정을 따른다. 코어가 채널을 안 붙였으면 데이터가 오지도
        // 가지도 않지만, 훅을 돌릴 이유도 없다(오디오는 AudioContext 를 만든다).
        <>
          <RdpSessionCanvas
            sessionId={tab.sessionId}
            visible={visible}
            audio={rdpHostFor(hosts, tab)?.audioEnabled !== false}
            clipboard={rdpHostFor(hosts, tab)?.clipboardEnabled !== false}
          />
          {/* 연결 진행·실패를 pane 위에 덮는다. tailnet 을 경유하면 그 계층의 단계까지 보인다 —
              Tailscale 에서 막힌 것인지 원격이 거절한 것인지가 여기서 갈린다. */}
          {visible ? <RdpConnectionOverlay sessionId={tab.sessionId} /> : null}
        </>
      ) : (
        <TerminalSessionPane
          sessionId={tab.sessionId}
          tab={tab}
          tmuxCell={tmuxCellBySessionId.get(tab.sessionId)}
          title={tab.title}
          visible={visible}
          active={
            activeWorkspace
              ? activeWorkspace.activeSessionId === tab.sessionId
              : activeSessionId === tab.sessionId
          }
          isPrimaryTmuxOverlayPane={
            !tab.tmux ||
            tmuxOverlayPrimary.get(tab.tmux.controlSessionId) === tab.sessionId
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
          terminalAutocompleteEnabled={settings.terminalAutocompleteEnabled}
          tmuxPrefixKey={settings.tmuxPrefixKey ?? 'C-b'}
          style={activeWorkspace ? undefined : rectStyle}
          // tmux pane 은 헤더 없이 슬롯을 꽉 채운다(컨테이너 px = tmux 셀 그리드 → 밑 짤림 제거).
          // pane 식별/조작은 상단 윈도우 바 + tmux 자체 경계선/단축키가 담당.
          showHeader={Boolean(activeWorkspace && placement) && !tab.tmux}
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
          onCancelReconnect={() => {
            onCancelReconnect(tab.sessionId);
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
      style={{
        background:
          'radial-gradient(circle at top left, color-mix(in srgb, var(--accent-strong) 10%, transparent 90%), transparent 32%), color-mix(in srgb, var(--surface) 94%, transparent 6%)',
      }}
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
      // tmux 워크스페이스는 핸들의 보이는 액센트 바를 얇은 가운데 선으로 바꾼다(히트영역
      // 12px 은 유지). tmux pane 거터가 좁아 기존의 꽉 찬 12px 바가 경계 글자와 겹쳐
      // 보이던 것을 해소 — 크기/측정/key 는 일절 안 건드리는 순수 시각 변경.
      tmuxThinHandles={Boolean(activeWorkspace?.tmux)}
      onStartResizeHandle={(handle) => {
        lastTmuxResizeRef.current = null;
        // tmux: 드래그 동안 split id 가 %layout-change 로 바뀌므로, 시작 시점에 양쪽
        // pane sessionId 를 잡아둔다(이후 mousemove 는 이 안정적 id 로 resize-pane).
        tmuxResizeRef.current = null;
        if (activeWorkspace?.tmux) {
          const node = findSplitNodeById(
            activeWorkspace.layout,
            handle.splitId,
          );
          if (node) {
            const firstSid = listWorkspaceSessionIds(node.first)[0];
            const secondSid = listWorkspaceSessionIds(node.second)[0];
            if (firstSid && secondSid) {
              tmuxResizeRef.current = { firstSid, secondSid };
            }
          }
        }
        setResizingHandle(handle);
      }}
      dropPreview={dropPreview}
    />
  );
}
