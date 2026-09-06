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
import { VncTunnelAuthOverlay } from './vnc/VncTunnelAuthOverlay';
import { RdpConnectionOverlay } from './rdp/RdpConnectionOverlay';
import { TerminalSessionPane } from './terminal-workspace/TerminalSessionPane';
import { TerminalWorkspaceLayoutView } from './terminal-workspace/TerminalWorkspaceLayoutView';
import { resizeTerminal, tmuxCommand } from '../services/desktop/terminal';
import { getTerminalCellSize } from '../lib/terminal-write-registry';
import { SectionLabel } from '../ui';
import { cn } from '../lib/cn';
import type { WorkspaceSplitTarget } from '../lib/workspace-split-target';
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
  /** 세션 패널과 한 카드를 나눠 쓰는가. 그러면 자기 테두리·그림자를 그리지 않는다. */
  sharesCardWithPanel?: boolean;
  activeWorkspace: WorkspaceTab | null;
  viewActivationKey: string | null;
  draggedSession: DraggedSessionPayload | null;
  resolveSplitTarget: (targetSessionId: string) => WorkspaceSplitTarget | null;
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
  onToggleSessionBroadcast: (workspaceId: string, sessionId: string) => void;
  onToggleWorkspaceZoom: (workspaceId: string, sessionId: string) => void;
  /** 분할에서 빼내 독립 탭으로. 로직은 이미 있고(드래그로만 되던 것) 버튼 경로를 추가한다. */
  onDetachSessionToStandalone: (workspaceId: string, sessionId: string) => void;
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
    // 로컬 셸에는 호스트 레코드가 없다 — 그 자리를 설정의 로컬 전용 팔레트가 대신한다.
    tab.source === 'local'
      ? settings.localTerminalThemeId
      : host?.terminalThemeId,
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

const EMPTY_SESSION_IDS: string[] = [];

interface SessionDropPreview extends DropPreview {
  sourceSessionId: string;
  hoveredSessionId: string;
  viewActivationKey: string | null;
  splitTarget?: WorkspaceSplitTarget;
}

export function TerminalWorkspace({
  tabs,
  hosts,
  settings,
  prefersDark,
  activeSessionId,
  sharesCardWithPanel = false,
  activeWorkspace,
  viewActivationKey,
  draggedSession,
  resolveSplitTarget,
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
  onToggleSessionBroadcast,
  onToggleWorkspaceZoom,
  onDetachSessionToStandalone,
  onResizeWorkspaceSplit,
}: TerminalWorkspaceProps) {
  const { t: translate } = useTranslation();
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [dropPreview, setDropPreview] = useState<SessionDropPreview | null>(null);
  const [resizingHandle, setResizingHandle] =
    useState<SplitHandlePlacement | null>(null);
  // tmux pane 리사이즈 드래그 중 마지막으로 보낸 target 칸 수(중복 resize-pane 전송 억제).
  const lastTmuxResizeRef = useRef<number | null>(null);
  // 드래그 시작 시 캡처한 양쪽 pane sessionId. split id 는 %layout-change 마다 재생성되므로
  // 그것 대신 안정적인 pane sessionId 로 매 mousemove 에 resize-pane 을 보낸다.
  const tmuxResizeRef = useRef<{ firstSid: string; secondSid: string } | null>(
    null,
  );

  const terminalController = useTerminalWorkspaceController({
    activeWorkspace,
    tabs,
  });

  const workspaceLayout = useMemo(() => {
    if (!activeWorkspace) {
      return null;
    }

    // 확대 중이면 트리를 펼치지 않고 그 pane 하나에 전체를 준다. 레이아웃 트리는 그대로
    // 두므로 풀면 원래 비율이 그대로 돌아온다. 확대한 세션이 레이아웃에 없으면(닫혔거나
    // 탭으로 빠졌다) 무시하고 평소대로 편다 — 상태를 청소하는 경로를 일일이 좇지 않아도
    // 화면이 멀쩡하다.
    const zoomedSessionId = activeWorkspace.zoomedSessionId ?? null;
    if (
      zoomedSessionId &&
      listWorkspaceSessionIds(activeWorkspace.layout).includes(zoomedSessionId)
    ) {
      return {
        placements: [
          {
            sessionId: zoomedSessionId,
            rect: { x: 0, y: 0, width: 1, height: 1 },
          },
        ],
        // 확대 중에는 나눌 경계가 없으므로 크기 조절 핸들도 없다.
        handles: [] as SplitHandlePlacement[],
      };
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
    // **여기에는 resolveTerminalAppearanceForSession 이 읽는 설정이 다 있어야 한다.** 하나라도
    // 빠지면 그 설정만 바꿔도 pane 이 캐시된 외형을 계속 쓴다 — 골라도 터미널이 그대로다.
    // (로컬 팔레트가 이 목록에서 빠져 그랬다. 호스트 팔레트는 `hosts` 가 있어 살아 있었다.)
    // `settings` 를 통째로 넣지 않는 이유는 설정 객체가 어떤 설정을 바꿔도 새로 만들어져,
    // SFTP 열 너비를 끄는 동안에도 열린 터미널 전부가 외형을 다시 받게 되기 때문이다.
  }, [
    hosts,
    prefersDark,
    settings.globalTerminalThemeId,
    settings.localTerminalThemeId,
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

  // 브로드캐스트는 pane 헤더의 아이콘으로 켠다(예전에는 워크스페이스 우상단에 떠 있는
  // 버튼 하나였다). pane 이 2개 이상일 때만 의미가 있으므로 그때만 아이콘을 그린다.
  // 확대·탭 복귀는 pane 이 2개 이상일 때만 의미가 있다. 혼자면 이미 전체이고, 빼낼 것도 없다.
  const canZoom = Boolean(
    activeWorkspace && activeWorkspaceSessionIds.length >= 2,
  );
  const canBroadcast = Boolean(
    activeWorkspace && activeWorkspaceSessionIds.length >= 2,
  );
  const isWorkspaceBroadcastEnabled = Boolean(
    activeWorkspace?.broadcastEnabled,
  );
  const broadcastExcludedSessionIds =
    activeWorkspace?.broadcastExcludedSessionIds ?? EMPTY_SESSION_IDS;
  const isBroadcastToggleDisabled =
    !isWorkspaceBroadcastEnabled && connectedWorkspaceHostSessionIds.length < 2;

  const canRearrangeActiveWorkspace =
    draggedSession?.source === 'workspace-pane' &&
    Boolean(activeWorkspace) &&
    draggedSession.workspaceId === activeWorkspace?.id;
  const visibleTargetSessionId = activeWorkspace
    ? activeWorkspace.zoomedSessionId ?? activeWorkspace.activeSessionId
    : activeSessionId;
  const canDropDraggedSession = Boolean(
    visibleTargetSessionId && resolveSplitTarget(visibleTargetSessionId),
  );
  const currentPreviewTarget = dropPreview?.splitTarget
    ? resolveSplitTarget(dropPreview.hoveredSessionId)
    : null;
  // 효과가 미리보기를 지우기 전의 렌더에서도 이전 화면/종료된 대상에 드롭하지 않는다.
  // 자기 탭 드래그 중 이웃이 바뀌어도, 이미 보여 준 대상을 다른 탭으로 바꾸지 않는다.
  const validDropPreview = dropPreview &&
    draggedSession?.sessionId === dropPreview.sourceSessionId &&
    viewActivationKey === dropPreview.viewActivationKey &&
    (activeWorkspace
      ? workspaceLayout?.placements.some((pane) => pane.sessionId === dropPreview.hoveredSessionId)
      : activeSessionId === dropPreview.hoveredSessionId) &&
    (draggedSession.source === 'standalone-tab'
      ? currentPreviewTarget &&
        currentPreviewTarget.sessionId === dropPreview.splitTarget?.sessionId &&
        currentPreviewTarget.workspaceId === dropPreview.splitTarget?.workspaceId
      : canRearrangeActiveWorkspace &&
        activeWorkspaceSessionIds.includes(draggedSession.sessionId) &&
        draggedSession.sessionId !== dropPreview.hoveredSessionId)
    ? dropPreview
    : null;

  useEffect(() => {
    if (dropPreview && !validDropPreview) {
      setDropPreview(null);
    }
  }, [dropPreview, validDropPreview]);

  useEffect(() => {
    setDropPreview(null);
    setResizingHandle(null);
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
    const splitTarget = resolveSplitTarget(activeSessionId);
    if (!splitTarget) {
      setDropPreview(null);
      return;
    }

    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const direction = resolveDropDirection(event.clientX, event.clientY, bounds);
    const rootRect = { x: 0, y: 0, width: 1, height: 1 };
    setDropPreview({
      direction,
      targetSessionId: splitTarget.sessionId,
      sourceSessionId: draggedSession.sessionId,
      hoveredSessionId: activeSessionId,
      viewActivationKey,
      splitTarget,
      rect: directionPreviewRect(rootRect, direction),
    });
  };

  // 보이는 pane 이 모두 원격 화면(RDP·VNC)인가.
  //
  // 그 경우 카드 테두리를 두르지 않는다. 터미널은 앱의 한 패널이라 카드로 보이는 것이 맞지만,
  // 원격 화면은 그 자체가 남의 데스크톱이다 — 1px 테두리와 10px 모서리가 화면 가장자리를 깎아,
  // 작업표시줄이나 창 테두리를 조작할 때 실제로 방해가 된다. 하나라도 터미널이 섞여 있으면 그대로
  // 둔다(분할 화면에서 한쪽만 테두리가 없으면 그게 더 어색하다).
  const remoteScreenOnly =
    visibleSessionIds.size > 0 &&
    [...visibleSessionIds].every((sessionId) => {
      const kind = tabs.find((tab) => tab.sessionId === sessionId)?.paneKind;
      return kind === 'rdp' || kind === 'vnc';
    });

  const workspaceClassName = cn(
    // pane 슬롯은 퍼센트로 절대 배치되므로 이 컨테이너는 내용으로 폭을 못 정한다. 세션 패널이
    // 붙으면서 부모가 flex 행이 되었으니 flex-1 을 명시해야 폭이 0 으로 접히지 않는다.
    'relative h-full min-h-0 min-w-0 flex-1 overflow-hidden',
    // 세션 패널이 열리면 테두리·그림자·오른쪽 라운드를 내려놓는다 — 바깥 윤곽은 셸의 래퍼가
    // 한 번만 그리고, 터미널과 패널은 그 한 판을 좌우로 나눠 쓴다. 라운드 카드 옆에 평평한
    // 띠가 붙는 모양을 피하기 위한 것이다.
    !sharesCardWithPanel && 'shadow-[var(--shadow)]',
    !remoteScreenOnly &&
      (sharesCardWithPanel
        ? 'rounded-l-[10px]'
        : 'rounded-[10px] border border-[var(--border)]'),
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

  // 지금 화면에 놓인 pane 수. 스탠드얼론 세션은 늘 1 이다.
  const paneCount = activeWorkspace && workspaceLayout
    ? workspaceLayout.placements.length
    : 1;

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
            const splitTarget = draggedSession?.source === 'standalone-tab'
              ? resolveSplitTarget(tab.sessionId)
              : null;
            if (draggedSession?.source === 'workspace-pane') {
              if (
                !canRearrangeActiveWorkspace ||
                draggedSession.sessionId === tab.sessionId
              ) {
                return;
              }
            } else if (
              draggedSession?.source !== 'standalone-tab' ||
              !splitTarget
            ) {
              setDropPreview(null);
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
              targetSessionId: splitTarget?.sessionId ?? tab.sessionId,
              sourceSessionId: draggedSession.sessionId,
              hoveredSessionId: tab.sessionId,
              viewActivationKey,
              splitTarget: splitTarget ?? undefined,
              rect: directionPreviewRect(placement.rect, direction),
            });
          }
        : undefined,
      onDrop: isWorkspacePane
        ? (event) => {
            if (!validDropPreview || !activeWorkspace || validDropPreview.hoveredSessionId !== tab.sessionId) {
              setDropPreview(null);
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
                validDropPreview.direction,
                tab.sessionId,
              );
            } else {
              onSplitSessionDrop(
                draggedSession.sessionId,
                validDropPreview.direction,
                validDropPreview.targetSessionId,
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
          {/* 경유 SSH 터널이 OTP 를 물으면 그 입력창을 진행 카드 위에 띄운다. 이게 없으면 코드를
              넣을 곳이 없어 연결이 그냥 멈춰 있다(코어는 답을 기다린다). */}
          {visible ? <VncTunnelAuthOverlay sessionId={tab.sessionId} /> : null}
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
            microphone={rdpHostFor(hosts, tab)?.microphoneEnabled === true}
            camera={rdpHostFor(hosts, tab)?.cameraEnabled === true}
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
          // 이 pane 이 화면을 혼자 쓰는가. 하단 상태바는 여기서만 뜬다 — 분할하면 pane 마다
          // 바가 하나씩 늘어 화면 아래가 줄로 가득 찬다.
          soloView={paneCount <= 1}
          zoomed={activeWorkspace?.zoomedSessionId === tab.sessionId}
          onToggleZoom={
            canZoom && activeWorkspace && placement && !tab.tmux
              ? () => {
                  onToggleWorkspaceZoom(activeWorkspace.id, tab.sessionId);
                }
              : undefined
          }
          onDetachToTab={
            canZoom && activeWorkspace && placement && !tab.tmux
              ? () => {
                  onDetachSessionToStandalone(activeWorkspace.id, tab.sessionId);
                }
              : undefined
          }
          broadcastActive={
            isWorkspaceBroadcastEnabled &&
            !broadcastExcludedSessionIds.includes(tab.sessionId)
          }
          broadcastDisabled={isBroadcastToggleDisabled}
          onToggleBroadcast={
            canBroadcast && activeWorkspace && placement && !tab.tmux
              ? () => {
                  onToggleSessionBroadcast(activeWorkspace.id, tab.sessionId);
                }
              : undefined
          }
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
              if (draggedSession?.source !== 'standalone-tab' || !validDropPreview) {
                return;
              }
              event.preventDefault();
              onSplitSessionDrop(
                draggedSession.sessionId,
                validDropPreview.direction,
                validDropPreview.targetSessionId,
              );
              setDropPreview(null);
              onEndSessionDrag();
            }
          : undefined
      }
      paneSlots={workspacePaneSlots}
      handles={activeWorkspace && workspaceLayout ? workspaceLayout.handles : []}
      // tmux 워크스페이스는 핸들의 보이는 액센트 바를 얇은 가운데 선으로 바꾼다(히트영역
      // 12px 은 유지). tmux pane 거터가 좁아 기존의 꽉 찬 12px 바가 경계 글자와 겹쳐
      // 보이던 것을 해소 — 크기/측정/key 는 일절 안 건드리는 순수 시각 변경.
      tmuxThinHandles={Boolean(activeWorkspace?.tmux)}
      resizingSplitId={resizingHandle?.splitId ?? null}
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
      dropPreview={validDropPreview}
    />
  );
}
