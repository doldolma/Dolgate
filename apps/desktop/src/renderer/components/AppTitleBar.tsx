import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DesktopWindowState, HostRecord, SessionConnectionKind, TerminalTab, UpdateState } from '@shared';
import type {
  DynamicTabStripItem,
  TmuxSessionGroup,
  WorkspaceTab,
  WorkspaceTabId
} from '../store/createAppStore';
import { DesktopWindowControls, type DesktopPlatform } from './DesktopWindowControls';
import { cn } from '../lib/cn';
import {
  getSessionConnectedAt,
  getSessionCwd,
  getSessionLastCommandAt,
} from '../lib/terminal-cwd-registry';
import { listWorkspaceSessionIds } from './terminal-workspace/terminalWorkspaceLayout';
import { Badge, Button, IconButton, TabButton, Tabs, Tooltip } from '../ui';
import { ArrowUpRight, Bell, Columns2, Container, Download, Folder, Home, Plus, RefreshCw, Rows2, X } from '../ui/icons';

interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

interface AppTitleBarProps {
  desktopPlatform: DesktopPlatform;
  tabs: TerminalTab[];
  workspaces: WorkspaceTab[];
  tmuxGroups: TmuxSessionGroup[];
  /** 호스트 카탈로그 — tmux 상단 탭에 호스트명을 표시하기 위해 group.hostId 해석에 사용. */
  hosts: HostRecord[];
  tabStrip: DynamicTabStripItem[];
  activeWorkspaceTab: WorkspaceTabId;
  draggedSession: DraggedSessionPayload | null;
  updateState: UpdateState;
  windowState: DesktopWindowState;
  onSelectHome: () => void;
  onSelectSftp: () => void;
  onSelectContainers: () => void;
  /** 열린 컨테이너 탭이 있을 때만 Containers 고정탭을 노출한다(미지정 시 비활성 취급). */
  hasOpenContainers?: boolean;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCloseSession: (sessionId: string) => Promise<void>;
  onCloseWorkspace: (workspaceId: string) => Promise<void>;
  /** tmux 세션 그룹 상단 탭 클릭 → 그룹 활성화. */
  onSelectTmuxGroup: (tmuxGroupId: string) => void;
  /** tmux 세션 그룹 상단 탭 × → detach(서버 세션 유지). */
  onCloseTmuxGroup: (tmuxGroupId: string) => void;
  /** tmux control mode workspace 에 새 tmux window 생성(new-window). 탭의 + 버튼. */
  onNewTmuxWindow?: (workspaceId: string) => void;
  onStartSessionDrag: (sessionId: string) => void;
  onEndSessionDrag: () => void;
  onDetachSessionToStandalone: (workspaceId: string, sessionId: string) => void;
  onReorderDynamicTab: (source: DynamicTabStripItem, target: DynamicTabStripItem, placement: 'before' | 'after') => void;
  onCheckForUpdates: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onDismissUpdate: (version: string) => Promise<void>;
  onOpenReleasePage: (url: string) => Promise<void>;
  onMinimizeWindow: () => Promise<void>;
  onMaximizeWindow: () => Promise<void>;
  onRestoreWindow: () => Promise<void>;
  onCloseWindow: () => Promise<void>;
}

// 탭 인디게이터(터미널 영역 안 먹고 탭 chrome에): 상태 점 + (활성 탭) RTT.
// 하이브리드 — 연결 문제(재연결/에러/대기)는 점이 우선, 정상 연결이면 셸 통합 명령 상태.
type TabConnState = 'connected' | 'reconnecting' | 'error' | 'idle';
type TabDotState = TabConnState | 'running';

const TAB_DOT_COLOR: Record<TabDotState, string> = {
  connected: 'var(--success,#3fae8f)',
  reconnecting: 'var(--warning-text)',
  error: 'var(--danger,#e2504a)',
  idle: 'var(--text-muted,#8b96ad)',
  running: 'var(--accent,#5b9bd5)',
};

function TabStatusDot({ state }: { state: TabDotState }) {
  return (
    <span
      className={cn(
        // TabButton 은 flex 가 아니라 gap 이 안 먹으므로 점 자체에 우측 여백을 준다.
        'mr-2 inline-block h-2 w-2 flex-none rounded-full align-middle',
        (state === 'reconnecting' || state === 'running') && 'animate-pulse',
      )}
      style={{ backgroundColor: TAB_DOT_COLOR[state] }}
      aria-hidden
    />
  );
}

// 탭의 연결 상태(status/reconnect/moshState)에서 점 색을 도출한다.
function tabConnStateFromTab(tab: TerminalTab | undefined): TabConnState {
  if (!tab) {
    return 'idle';
  }
  if (tab.status === 'error' || tab.moshState === 'disconnected') {
    return 'error';
  }
  if (
    tab.reconnect != null ||
    tab.status === 'connecting' ||
    tab.status === 'pending' ||
    tab.moshState === 'reconnecting'
  ) {
    return 'reconnecting';
  }
  if (tab.status === 'connected') {
    return 'connected';
  }
  return 'idle';
}

// 하이브리드 점 상태: 연결 문제(연결 안 정상)는 그대로 우선, 정상 연결이면 셸 통합
// 명령 상태 — 실행 중=running, 실패=error(빨강), 성공/미관측=connected(초록).
function combineDotState(
  conn: TabConnState,
  command: TerminalTab['commandState'],
): TabDotState {
  if (conn !== 'connected') {
    return conn;
  }
  if (command === 'running') {
    return 'running';
  }
  if (command === 'failed') {
    return 'error';
  }
  return 'connected';
}

// 활성 탭 RTT 색: 빠름 초록 / 보통 주황 / 느림 빨강.
function rttColor(ms: number): string {
  if (ms < 80) {
    return 'var(--success,#3fae8f)';
  }
  if (ms < 200) {
    return 'var(--warning-text)';
  }
  return 'var(--danger,#e2504a)';
}

type TitlebarDynamicItem =
  | {
      kind: 'session';
      sessionId: string;
      title: string;
      status: TerminalTab['status'];
      active: boolean;
      dotState: TabDotState;
      rttMs: number | null;
    }
  | {
      kind: 'workspace';
      workspaceId: string;
      title: string;
      paneCount: number;
      active: boolean;
      /** tmux control mode workspace 면 true — 탭 × 닫기를 kill 대신 detach(서버 유지)로 라우팅. */
      isTmux: boolean;
      dotState: TabDotState;
      rttMs: number | null;
    }
  | {
      kind: 'tmux';
      tmuxGroupId: string;
      title: string;
      windowCount: number;
      active: boolean;
      // tmux 는 pane 이 여러 개라 단일 상태점이 모호해 점을 안 쓰고, ⊟/↻ 아이콘으로
      // 연결/재연결만 표시한다.
      reconnecting: boolean;
      rttMs: number | null;
    };

// 연결 종류 라벨(SessionReplay/Logs 와 동일 표기). aws-ec2 는 SSM 으로 연결되므로
// 절대 SSH 로 표기하지 않는다.
function connectionKindLabel(kind: SessionConnectionKind): string {
  switch (kind) {
    case 'local':
      return '로컬 셸';
    case 'ssh':
      return 'SSH';
    case 'mosh':
      return 'Mosh';
    case 'aws-ssm':
      return 'AWS SSM';
    case 'aws-ecs-exec':
      return 'AWS ECS';
    case 'warpgate':
      return 'Warpgate';
    case 'serial':
      return '시리얼';
    default:
      return kind;
  }
}

// 라이브 세션의 실제 연결 종류를 호스트 종류 + 플래그에서 도출한다(메인의 connectionKind
// 결정 로직과 정합: aws-ec2→aws-ssm). 호스트를 못 찾으면 추측하지 않고 null(=SSH 로
// 오표기 방지).
function deriveSessionConnectionKind(
  tab: TerminalTab | undefined,
  host: HostRecord | null,
): SessionConnectionKind | null {
  if (!tab) {
    return null;
  }
  if (tab.source === 'local' || !tab.hostId) {
    return 'local';
  }
  if (!host) {
    return null;
  }
  switch (host.kind) {
    case 'serial':
      return 'serial';
    case 'warpgate-ssh':
      return 'warpgate';
    case 'aws-ecs':
      return 'aws-ecs-exec';
    case 'aws-ec2':
      return 'aws-ssm';
    case 'ssh':
      return host.useMosh || tab.moshState != null ? 'mosh' : 'ssh';
    default:
      return null;
  }
}

// 연결 대상 한 줄(user@host:port 등). 종류/점프/mosh 는 별도 표기하므로 여기선 순수 타겟만.
function formatHostTarget(host: HostRecord): string | null {
  switch (host.kind) {
    case 'ssh':
      return `${host.username}@${host.hostname}:${host.port}`;
    case 'warpgate-ssh':
      return `${host.warpgateUsername}@${host.warpgateSshHost}:${host.warpgateSshPort}`;
    case 'aws-ec2':
      return `${host.awsPrivateIp ?? host.awsInstanceId} · ${host.awsRegion}`;
    case 'aws-ecs':
      return `${host.awsEcsClusterName} · ${host.awsRegion}`;
    case 'serial':
      return host.devicePath
        ? `${host.devicePath} · ${host.baudRate}bps`
        : host.host
          ? `${host.host}:${host.port ?? ''}`
          : `${host.baudRate}bps`;
    default:
      return null;
  }
}

// 경과 시간("3시간 12분"). 연결 경과시간용.
function formatElapsed(sinceMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (sec < 60) {
    return `${sec}초`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}분`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const remMin = min % 60;
    return remMin > 0 ? `${hr}시간 ${remMin}분` : `${hr}시간`;
  }
  const days = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${days}일 ${remHr}시간` : `${days}일`;
}

// 상대 시각("2분 전"). 마지막 명령 시각용.
function formatAgo(atMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  if (sec < 10) {
    return '방금';
  }
  if (sec < 60) {
    return `${sec}초 전`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}분 전`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}시간 전`;
  }
  return `${Math.floor(hr / 24)}일 전`;
}

type TabHoverRow = { label: string; value: string; valueColor?: string };
type TabHoverInfo = {
  heading: string;
  target: string | null;
  rows: TabHoverRow[];
};

// hover 카드 내용: 탭이 이미 보여주는 것(제목·상태점·활성 RTT)은 빼고, 탭만 봐선 모르는
// 것만 모은다 — 연결 종류(헤드라인)·대상·비정상 상태·명령·점프·비활성 RTT·공유.
function buildTabHoverInfo(
  item: TitlebarDynamicItem,
  tabs: TerminalTab[],
  hosts: HostRecord[],
  tmuxGroups: TmuxSessionGroup[],
  workspaces: WorkspaceTab[],
): TabHoverInfo {
  const rows: TabHoverRow[] = [];

  if (item.kind === 'session') {
    const tab = tabs.find((candidate) => candidate.sessionId === item.sessionId);
    const host = tab?.hostId
      ? hosts.find((candidate) => candidate.id === tab.hostId) ?? null
      : null;
    const kind = deriveSessionConnectionKind(tab, host);
    if (host?.kind === 'ssh' && host.jumpHostId) {
      const jump = hosts.find((candidate) => candidate.id === host.jumpHostId);
      rows.push({ label: '점프', value: jump?.label ?? host.jumpHostId });
    }
    if (tab?.reconnect) {
      rows.push({
        label: '재연결',
        value: tab.reconnect.waitingForNetwork
          ? '네트워크 대기 중'
          : `${tab.reconnect.attempt}/${tab.reconnect.maxAttempts}회 시도`,
        valueColor: TAB_DOT_COLOR.reconnecting,
      });
    } else if (tab?.status === 'error' && tab.errorMessage) {
      rows.push({ label: '오류', value: tab.errorMessage, valueColor: TAB_DOT_COLOR.error });
    }
    const cwd = getSessionCwd(item.sessionId);
    if (cwd) {
      rows.push({ label: '현재 위치', value: cwd });
    }
    if (tab?.shellKind) {
      rows.push({ label: '셸', value: tab.shellKind });
    }
    // "연결 경과"는 현재 실제로 연결된 동안만 의미가 있다. tmux control 연결은 SSH 가
    // 붙는 순간 코어가 낙관적으로 connected 를 emit 해 connectedAt 이 찍히는데, 직후
    // tmux 가 없어 실패하면 status 가 error 가 된다. 그 상태에서 경과시간이 계속 늘면
    // 안 되므로 status==='connected' 일 때만 표시한다.
    const connectedAt = getSessionConnectedAt(item.sessionId);
    if (connectedAt != null && tab?.status === 'connected') {
      rows.push({ label: '연결 경과', value: formatElapsed(connectedAt) });
    }
    if (tab?.commandState === 'running') {
      rows.push({ label: '명령', value: '실행 중', valueColor: TAB_DOT_COLOR.running });
    } else {
      const lastCommandAt = getSessionLastCommandAt(item.sessionId);
      if (lastCommandAt != null) {
        rows.push({
          label: '마지막 명령',
          value:
            tab?.commandState === 'failed'
              ? `${formatAgo(lastCommandAt)} · 실패`
              : formatAgo(lastCommandAt),
          valueColor: tab?.commandState === 'failed' ? TAB_DOT_COLOR.error : undefined,
        });
      }
    }
    if (item.rttMs != null) {
      rows.push({ label: '지연', value: `${item.rttMs}ms`, valueColor: rttColor(item.rttMs) });
    }
    if (tab?.sessionShare?.shareUrl) {
      rows.push({
        label: '공유',
        value: `관전 ${tab.sessionShare.viewerCount}명`,
        valueColor: TAB_DOT_COLOR.running,
      });
    }
    return {
      heading: kind ? connectionKindLabel(kind) : '세션',
      target: host ? formatHostTarget(host) : null,
      rows,
    };
  }

  if (item.kind === 'tmux') {
    const group = tmuxGroups.find((candidate) => candidate.id === item.tmuxGroupId);
    const host = group?.hostId
      ? hosts.find((candidate) => candidate.id === group.hostId) ?? null
      : null;
    if (group?.reconnect) {
      rows.push({
        label: '재연결',
        value: group.reconnect.waitingForNetwork
          ? '네트워크 대기 중'
          : `${group.reconnect.attempt}/${group.reconnect.maxAttempts}회 시도`,
        valueColor: TAB_DOT_COLOR.reconnecting,
      });
    }
    rows.push({ label: '윈도우', value: `${item.windowCount}개` });
    if (item.rttMs != null) {
      rows.push({ label: '지연', value: `${item.rttMs}ms`, valueColor: rttColor(item.rttMs) });
    }
    return {
      heading: 'tmux',
      target: host ? formatHostTarget(host) : null,
      rows,
    };
  }

  const workspace = workspaces.find((candidate) => candidate.id === item.workspaceId);
  if (workspace) {
    listWorkspaceSessionIds(workspace.layout).forEach((sessionId, index) => {
      const paneTab = tabs.find((candidate) => candidate.sessionId === sessionId);
      const paneHost = paneTab?.hostId
        ? hosts.find((candidate) => candidate.id === paneTab.hostId) ?? null
        : null;
      rows.push({
        label: `패널 ${index + 1}`,
        value: paneHost?.label ?? paneTab?.title ?? '로컬',
      });
    });
  }
  return {
    heading: item.isTmux ? '분할 · tmux' : '분할 워크스페이스',
    target: null,
    rows,
  };
}

const TAB_DRAG_MIME = 'application/x-dolssh-tab-item';

function serializeDraggedTab(item: DynamicTabStripItem): string {
  if (item.kind === 'session') {
    return `session:${item.sessionId}`;
  }
  if (item.kind === 'tmux') {
    return `tmuxgrp:${item.tmuxGroupId}`;
  }
  return `workspace:${item.workspaceId}`;
}

function parseDraggedTab(payload: string): DynamicTabStripItem | null {
  if (payload.startsWith('session:')) {
    const sessionId = payload.slice('session:'.length);
    return sessionId ? { kind: 'session', sessionId } : null;
  }
  if (payload.startsWith('tmuxgrp:')) {
    const tmuxGroupId = payload.slice('tmuxgrp:'.length);
    return tmuxGroupId ? { kind: 'tmux', tmuxGroupId } : null;
  }
  if (payload.startsWith('workspace:')) {
    const workspaceId = payload.slice('workspace:'.length);
    return workspaceId ? { kind: 'workspace', workspaceId } : null;
  }
  return null;
}

function formatProgressPercent(updateState: UpdateState): string {
  if (!updateState.progress) {
    return '';
  }
  return `${Math.round(updateState.progress.percent)}%`;
}

function shouldShowBadge(updateState: UpdateState): boolean {
  if (updateState.status === 'downloading' || updateState.status === 'downloaded') {
    return true;
  }
  return updateState.status === 'available' && updateState.release?.version !== updateState.dismissedVersion;
}

export function getEmptyReleaseMessage(updateState: UpdateState): string | null {
  if (updateState.status === 'checking') {
    return 'GitHub Releases에서 새 버전을 확인하고 있습니다.';
  }
  return null;
}

function formatPublishedAt(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric'
  }).format(parsed);
}

function resolveReleaseUrl(updateState: UpdateState): string {
  const version = updateState.release?.version;
  if (!version) {
    return 'https://github.com/doldolma/dolgate/releases';
  }
  return `https://github.com/doldolma/dolgate/releases/tag/v${version}`;
}

function countWorkspacePanes(workspace: WorkspaceTab): number {
  const stack = [workspace.layout];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'leaf') {
      count += 1;
      continue;
    }
    stack.push(node.first, node.second);
  }
  return count;
}

// 풀하이트 브라우저 탭: 윗모서리만 둥글고(아래는 네모) 바 하단 경계선에 붙는다.
// 활성=콘텐츠 배경(--app-bg)으로 아래 영역에 도킹된 것처럼 이어지고(테마 무관 — 다크에서
// 흰 탭이 붕 뜨지 않게), 비활성=투명(바에 녹아듦) + 밝은 글자. 크롬은 두 테마 모두 어두움.
function getTitlebarTabClass(active: boolean): string {
  const base =
    'h-full gap-2 !rounded-t-[10px] !rounded-b-none border-transparent px-[0.95rem] py-0 text-[0.86rem]';
  if (active) {
    return `${base} bg-[var(--app-bg)] text-[var(--text)] shadow-none hover:text-[var(--text)]`;
  }

  return `${base} bg-transparent text-[rgba(243,247,251,0.74)] shadow-none hover:bg-[rgba(255,255,255,0.08)] hover:text-white`;
}

// 세션탭은 도킹하지 않고 위아래 여백을 두고 떠 있는 알약(self-center). 비활성도 옅은
// 배경+테두리로 경계가 보여 "어디까지 탭인지" 알 수 있게 한다. 활성은 콘텐츠 배경색으로
// 또렷이(정적 탭과 동일 규칙 — 다크 테마에서 흰 알약이 튀지 않게).
function getTitlebarDynamicTabContainerClass(active: boolean): string {
  if (active) {
    return 'border-[rgba(255,255,255,0.16)] bg-[var(--app-bg)] shadow-none';
  }

  return 'border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.07)] shadow-none hover:bg-[rgba(255,255,255,0.12)]';
}

function getTitlebarDynamicTabButtonClass(active: boolean): string {
  return cn(
    'min-w-0 justify-start rounded-none border-transparent bg-transparent px-3 py-[0.3rem] shadow-none hover:bg-transparent',
    active
      ? 'text-[var(--text)] hover:text-[var(--text)]'
      : 'text-[rgba(243,247,251,0.82)] hover:text-white',
  );
}

function getTitlebarCloseButtonClass(active: boolean): string {
  if (active) {
    return 'h-8 w-8 rounded-full text-[0.9rem] text-[color-mix(in_srgb,var(--accent-strong)_84%,var(--text)_16%)] hover:bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent)] hover:text-[var(--accent-strong)]';
  }

  return 'h-8 w-8 rounded-full text-[0.9rem] text-[rgba(243,247,251,0.78)] hover:bg-[rgba(255,255,255,0.12)] hover:text-white';
}

function isDynamicWorkspaceTab(tabId: WorkspaceTabId): boolean {
  return (
    tabId.startsWith('session:') ||
    tabId.startsWith('workspace:') ||
    tabId.startsWith('tmuxgrp:')
  );
}

export function AppTitleBar({
  desktopPlatform,
  tabs,
  workspaces,
  tmuxGroups,
  hosts,
  tabStrip,
  activeWorkspaceTab,
  draggedSession,
  updateState,
  windowState,
  onSelectHome,
  onSelectSftp,
  onSelectContainers,
  hasOpenContainers,
  onSelectSession,
  onSelectWorkspace,
  onCloseSession,
  onCloseWorkspace,
  onSelectTmuxGroup,
  onCloseTmuxGroup,
  onNewTmuxWindow,
  onStartSessionDrag,
  onEndSessionDrag,
  onDetachSessionToStandalone,
  onReorderDynamicTab,
  onCheckForUpdates,
  onInstallUpdate,
  onOpenReleasePage,
  onMinimizeWindow,
  onMaximizeWindow,
  onRestoreWindow,
  onCloseWindow
}: AppTitleBarProps) {
  const [isUpdateOpen, setIsUpdateOpen] = useState(false);
  const [isDetachHovering, setIsDetachHovering] = useState(false);
  const [tabDropPreview, setTabDropPreview] = useState<{ targetKey: string; placement: 'before' | 'after' } | null>(null);
  const [isTabDragging, setIsTabDragging] = useState(false);
  // 끌고 있는 탭을 투명하게 가리는 플래그. dragstart 와 같은 틱에 숨기면 Chromium 이
  // 드래그를 취소하므로(드래그 이미지 캡처 전 소스 소멸), 다음 틱으로 지연시킨다.
  const [tabDragSourceHidden, setTabDragSourceHidden] = useState(false);
  // hover 카드(호스트·상태·RTT). fixed 위치라 스크롤 스트립에 안 잘린다.
  const [hoveredTab, setHoveredTab] = useState<{ key: string; left: number; top: number } | null>(null);
  const draggedTabRef = useRef<DynamicTabStripItem | null>(null);
  const updateMenuRef = useRef<HTMLDivElement | null>(null);
  const titlebarTabStripRef = useRef<HTMLDivElement | null>(null);
  const titlebarTabItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // 드래그가 스트립 좌/우 끝에 닿으면 자동 가로 스크롤(화면 밖 위치로도 이동 가능).
  const tabAutoScrollDirRef = useRef(0);
  const tabAutoScrollRafRef = useRef<number | null>(null);
  // 드래그 시작 순간의 탭 중심 좌표(스크롤 무관 content 좌표)를 고정 캡처한다.
  // 히트 테스트를 이 정적 값으로 하면, 옆 탭이 transform 으로 비켜나도 드롭
  // 위치가 흔들리지(재계산 진동) 않는다.
  const tabDragLayoutRef = useRef<{ key: string; center: number }[]>([]);
  const tabDragSourceWidthRef = useRef(0);
  const [showLeftTabStripFade, setShowLeftTabStripFade] = useState(false);
  const [showRightTabStripFade, setShowRightTabStripFade] = useState(false);

  const dynamicItems = useMemo<TitlebarDynamicItem[]>(
    () =>
      tabStrip
        .map((item) => {
          if (item.kind === 'session') {
            const tab = tabs.find((candidate) => candidate.sessionId === item.sessionId);
            if (!tab) {
              return null;
            }
            return {
              kind: 'session',
              sessionId: tab.sessionId,
              title: tab.title,
              status: tab.status,
              active: activeWorkspaceTab === `session:${tab.sessionId}`,
              dotState: combineDotState(
                tabConnStateFromTab(tab),
                tab.commandState,
              ),
              rttMs: tab.lastRttMs ?? null
            } satisfies TitlebarDynamicItem;
          }

          if (item.kind === 'workspace') {
            const workspace = workspaces.find((candidate) => candidate.id === item.workspaceId);
            if (!workspace) {
              return null;
            }
            // 분할 워크스페이스는 pane 들의 최악 상태로 집계한다(error > reconnecting > connected).
            const paneStates = listWorkspaceSessionIds(workspace.layout).map((id) =>
              tabConnStateFromTab(tabs.find((candidate) => candidate.sessionId === id)),
            );
            const wsConnState: TabConnState = paneStates.includes('error')
              ? 'error'
              : paneStates.includes('reconnecting')
                ? 'reconnecting'
                : paneStates.length > 0 && paneStates.every((s) => s === 'connected')
                  ? 'connected'
                  : 'idle';
            const wsActivePaneTab = tabs.find(
              (candidate) => candidate.sessionId === workspace.activeSessionId,
            );
            return {
              kind: 'workspace',
              workspaceId: workspace.id,
              title: workspace.title,
              paneCount: countWorkspacePanes(workspace),
              active: activeWorkspaceTab === `workspace:${workspace.id}`,
              isTmux: Boolean(workspace.tmux),
              dotState: combineDotState(
                wsConnState,
                wsActivePaneTab?.commandState ?? null,
              ),
              rttMs: wsActivePaneTab?.lastRttMs ?? null
            } satisfies TitlebarDynamicItem;
          }

          if (item.kind === 'tmux') {
            const group = tmuxGroups.find((candidate) => candidate.id === item.tmuxGroupId);
            if (!group) {
              return null;
            }
            // 상단 탭은 "호스트명-세션명"으로 표시. hostId 없거나 호스트 레코드 미발견이면
            // 세션명만.
            const host = group.hostId
              ? hosts.find((candidate) => candidate.id === group.hostId)
              : undefined;
            return {
              kind: 'tmux',
              tmuxGroupId: group.id,
              title: host?.label
                ? `${host.label}-${group.sessionName}`
                : group.sessionName,
              windowCount: workspaces.filter(
                (workspace) =>
                  workspace.tmux?.controlSessionId === group.controlSessionId,
              ).length,
              active: activeWorkspaceTab === `tmuxgrp:${group.id}`,
              reconnecting: group.reconnect != null,
              rttMs: group.lastRttMs ?? null
            } satisfies TitlebarDynamicItem;
          }

        })
        .filter((item): item is TitlebarDynamicItem => item !== null),
    [activeWorkspaceTab, hosts, tabStrip, tabs, tmuxGroups, workspaces]
  );

  const showBadge = shouldShowBadge(updateState);
  const publishedAt = formatPublishedAt(updateState.release?.publishedAt);
  const releaseUrl = resolveReleaseUrl(updateState);
  const showInstallAction = updateState.status === 'downloaded';
  const showCheckAction =
    updateState.enabled &&
    (updateState.status === 'idle' ||
      updateState.status === 'upToDate' ||
      updateState.status === 'error');
  const showDevDisabledAction = !updateState.enabled;
  const isAutoDownloading =
    updateState.status === 'available' || updateState.status === 'downloading';
  const titleText = showInstallAction
    ? '업데이트를 적용할 준비가 됐습니다'
    : isAutoDownloading
      ? '업데이트를 다운로드하고 있습니다'
      : '앱 업데이트';
  const installTooltip = updateState.release?.version
    ? `${updateState.release.version.startsWith('v') ? '' : 'v'}${updateState.release.version} 업데이트 준비됨`
    : '업데이트 준비됨';

  const canDetachToTabs = draggedSession?.source === 'workspace-pane' && Boolean(draggedSession.workspaceId);
  const isTitlebarInternalDragActive = isTabDragging || canDetachToTabs;

  const updateTitlebarTabStripFades = useCallback(() => {
    const container = titlebarTabStripRef.current;
    if (!container) {
      setShowLeftTabStripFade(false);
      setShowRightTabStripFade(false);
      return;
    }

    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextShowLeft = container.scrollLeft > 1;
    const nextShowRight = container.scrollLeft < maxScrollLeft - 1;
    setShowLeftTabStripFade((previous) =>
      previous === nextShowLeft ? previous : nextShowLeft,
    );
    setShowRightTabStripFade((previous) =>
      previous === nextShowRight ? previous : nextShowRight,
    );
  }, []);

  const stepTabAutoScroll = useCallback(() => {
    const el = titlebarTabStripRef.current;
    const dir = tabAutoScrollDirRef.current;
    if (!el || dir === 0) {
      tabAutoScrollRafRef.current = null;
      return;
    }
    el.scrollLeft += dir * 14;
    updateTitlebarTabStripFades();
    tabAutoScrollRafRef.current = window.requestAnimationFrame(stepTabAutoScroll);
  }, [updateTitlebarTabStripFades]);

  const updateTabAutoScroll = useCallback(
    (clientX: number) => {
      const el = titlebarTabStripRef.current;
      if (!el) {
        return;
      }
      const rect = el.getBoundingClientRect();
      const EDGE = 56;
      let dir = 0;
      if (el.scrollWidth > el.clientWidth) {
        if (clientX < rect.left + EDGE) {
          dir = -1;
        } else if (clientX > rect.right - EDGE) {
          dir = 1;
        }
      }
      tabAutoScrollDirRef.current = dir;
      if (
        dir !== 0 &&
        tabAutoScrollRafRef.current == null &&
        typeof window.requestAnimationFrame === 'function'
      ) {
        tabAutoScrollRafRef.current = window.requestAnimationFrame(stepTabAutoScroll);
      }
    },
    [stepTabAutoScroll],
  );

  const stopTabAutoScroll = useCallback(() => {
    tabAutoScrollDirRef.current = 0;
    if (tabAutoScrollRafRef.current != null) {
      window.cancelAnimationFrame(tabAutoScrollRafRef.current);
      tabAutoScrollRafRef.current = null;
    }
  }, []);

  function getTabKey(item: DynamicTabStripItem): string {
    if (item.kind === 'session') {
      return `session:${item.sessionId}`;
    }
    if (item.kind === 'tmux') {
      return `tmuxgrp:${item.tmuxGroupId}`;
    }
    return `workspace:${item.workspaceId}`;
  }

  function itemToTarget(item: TitlebarDynamicItem): DynamicTabStripItem {
    if (item.kind === 'session') {
      return { kind: 'session', sessionId: item.sessionId };
    }
    if (item.kind === 'tmux') {
      return { kind: 'tmux', tmuxGroupId: item.tmuxGroupId };
    }
    return { kind: 'workspace', workspaceId: item.workspaceId };
  }

  // 드래그 시작 시 호출: 각 탭의 중심을 content 좌표(스크롤 무관)로 고정 캡처하고,
  // 끌고 있는 탭의 폭(슬롯 크기)을 기록한다.
  function captureTabDragLayout(sourceWidth: number) {
    const el = titlebarTabStripRef.current;
    tabDragSourceWidthRef.current = sourceWidth;
    if (!el) {
      tabDragLayoutRef.current = [];
      return;
    }
    const stripLeft = el.getBoundingClientRect().left;
    const scrollLeft = el.scrollLeft;
    tabDragLayoutRef.current = dynamicItems.map((item) => {
      const key = getTabKey(itemToTarget(item));
      const node = titlebarTabItemRefs.current[key];
      const rect = node?.getBoundingClientRect();
      const center = rect ? rect.left + rect.width / 2 - stripLeft + scrollLeft : 0;
      return { key, center };
    });
  }

  // 포인터 X 좌표만으로 "어느 탭 사이에 떨어질지"를 계산한다. 캡처해 둔 정적 중심과
  // 비교하므로(transform 영향 없음) 진동이 없다. 특정 드롭 존을 조준할 필요가 없고,
  // 맨 오른쪽 너머로 끌면 자연히 마지막 위치가 된다.
  function computeTabDrop(
    clientX: number,
  ): { target: DynamicTabStripItem; placement: 'before' | 'after' } | null {
    if (dynamicItems.length === 0) {
      return null;
    }
    const el = titlebarTabStripRef.current;
    const layout = tabDragLayoutRef.current;
    if (el && layout.length === dynamicItems.length) {
      const pointerX = clientX - el.getBoundingClientRect().left + el.scrollLeft;
      for (let i = 0; i < dynamicItems.length; i += 1) {
        if (pointerX < layout[i].center) {
          return { target: itemToTarget(dynamicItems[i]), placement: 'before' };
        }
      }
      return {
        target: itemToTarget(dynamicItems[dynamicItems.length - 1]),
        placement: 'after',
      };
    }
    // 캡처가 없으면 라이브 측정으로 폴백.
    for (const item of dynamicItems) {
      const node = titlebarTabItemRefs.current[getTabKey(itemToTarget(item))];
      if (!node) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return { target: itemToTarget(item), placement: 'before' };
      }
    }
    return {
      target: itemToTarget(dynamicItems[dynamicItems.length - 1]),
      placement: 'after',
    };
  }

  // 드래그 중 각 탭의 좌우 이동량(px). 끌고 있는 탭은 보이지 않게 하고(드래그
  // 이미지가 커서를 따라감), 그 슬롯이 드롭 지점으로 미끄러져 오도록 사이 탭들을
  // 통째로 한 칸(슬롯 폭)씩 밀어 빈 자리를 연다. dragSourceIndex/dropGap 은 렌더에서 계산.
  function tabSlideX(
    index: number,
    dragSourceIndex: number,
    dropGap: number,
  ): number {
    if (dragSourceIndex < 0 || dropGap < 0 || index === dragSourceIndex) {
      return 0;
    }
    const width = tabDragSourceWidthRef.current;
    if (dragSourceIndex < dropGap && index > dragSourceIndex && index < dropGap) {
      return -width;
    }
    if (dropGap < dragSourceIndex && index >= dropGap && index < dragSourceIndex) {
      return width;
    }
    return 0;
  }

  // hover 카드를 해당 탭 아래에 띄운다(fixed, 우측 화면 밖으로 안 나가게 clamp).
  function showTabHover(key: string, node: HTMLElement) {
    if (isTabDragging) {
      return;
    }
    const rect = node.getBoundingClientRect();
    setHoveredTab({
      key,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 312)),
      top: rect.bottom + 6,
    });
  }

  function hideTabHover(key: string) {
    setHoveredTab((current) => (current?.key === key ? null : current));
  }

  useEffect(() => {
    if (!isUpdateOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (updateMenuRef.current?.contains(target)) {
        return;
      }
      setIsUpdateOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isUpdateOpen]);

  useEffect(() => {
    updateTitlebarTabStripFades();
  }, [activeWorkspaceTab, dynamicItems.length, updateTitlebarTabStripFades]);

  useEffect(() => {
    const handleResize = () => {
      updateTitlebarTabStripFades();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [updateTitlebarTabStripFades]);

  useEffect(() => stopTabAutoScroll, [stopTabAutoScroll]);

  // 드래그가 확립된 다음 틱에 소스 탭을 숨긴다(같은 틱에 숨기면 드래그가 취소됨).
  useEffect(() => {
    if (!isTabDragging) {
      setTabDragSourceHidden(false);
      return;
    }
    setHoveredTab(null);
    const timer = window.setTimeout(() => setTabDragSourceHidden(true), 0);
    return () => window.clearTimeout(timer);
  }, [isTabDragging]);

  // 탭 두 개를 합쳐 워크스페이스를 만들 때처럼 끌던 pill 이 drop 전에 unmount 되면
  // 그 pill 의 onDragEnd 가 오지 않아 isTabDragging 이 영구히 true 로 남고, showTabHover
  // 가 막혀 hover 가 먹통이 된다. document 레벨 dragend/drop 으로 확실히 리셋한다.
  useEffect(() => {
    if (!isTabDragging) {
      return;
    }
    const reset = () => {
      draggedTabRef.current = null;
      setTabDropPreview(null);
      setTabDragSourceHidden(false);
      setIsTabDragging(false);
      stopTabAutoScroll();
    };
    document.addEventListener('dragend', reset);
    document.addEventListener('drop', reset);
    return () => {
      document.removeEventListener('dragend', reset);
      document.removeEventListener('drop', reset);
    };
  }, [isTabDragging, stopTabAutoScroll]);

  useLayoutEffect(() => {
    if (isTabDragging) {
      return;
    }

    const activeItem = isDynamicWorkspaceTab(activeWorkspaceTab)
      ? titlebarTabItemRefs.current[activeWorkspaceTab]
      : null;
    if (!activeItem) {
      updateTitlebarTabStripFades();
      return;
    }

    if (typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    if (typeof window.requestAnimationFrame !== 'function') {
      updateTitlebarTabStripFades();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      updateTitlebarTabStripFades();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeWorkspaceTab, isTabDragging, updateTitlebarTabStripFades]);

  // 라이브 슬라이드 애니메이션용: 끌고 있는 탭의 인덱스와, 떨어질 틈(gap)의 인덱스.
  const draggedKey =
    isTabDragging && draggedTabRef.current
      ? getTabKey(draggedTabRef.current)
      : null;
  const dragSourceIndex = draggedKey
    ? dynamicItems.findIndex((item) => getTabKey(itemToTarget(item)) === draggedKey)
    : -1;
  let dropGap = -1;
  if (isTabDragging && tabDropPreview) {
    const targetIndex = dynamicItems.findIndex(
      (item) => getTabKey(itemToTarget(item)) === tabDropPreview.targetKey,
    );
    if (targetIndex >= 0) {
      dropGap = tabDropPreview.placement === 'before' ? targetIndex : targetIndex + 1;
    }
  }

  const hoveredItem =
    hoveredTab && !isTabDragging
      ? dynamicItems.find(
          (item) => getTabKey(itemToTarget(item)) === hoveredTab.key,
        ) ?? null
      : null;
  const hoverInfo = hoveredItem
    ? buildTabHoverInfo(hoveredItem, tabs, hosts, tmuxGroups, workspaces)
    : null;

  // 오버플로우로 잘리는 끝 탭을 직각으로 자르지 않고 알파(투명도)로 부드럽게 페이드한다.
  // overflow clip 은 사각이라 흰 활성 탭이 "깨진" 사각으로 보이는데, mask 로 색 무관하게
  // 자연스러운 가장자리를 만든다. 더 보일 게 있는 쪽(showLeft/showRight)만 페이드.
  const FADE = '34px';
  const stripMaskImage =
    showLeftTabStripFade && showRightTabStripFade
      ? `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`
      : showRightTabStripFade
        ? `linear-gradient(to right, #000 calc(100% - ${FADE}), transparent)`
        : showLeftTabStripFade
          ? `linear-gradient(to right, transparent, #000 ${FADE})`
          : undefined;

  return (
    <header
      className={cn(
        // 상단바 chrome 배경 전체를 창 드래그 영역으로 둔다(macOS·Windows 공통). 실제 탭/버튼처럼
        // 조작 가능한 요소만 no-drag 로 좁혀, 같은 배경처럼 보이는 빈 영역은 일관되게 창을 움직인다.
        'fixed inset-x-0 top-0 z-[7] flex min-h-[2.95rem] select-none items-stretch gap-4 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--chrome-bg)_94%,white_6%),color-mix(in_srgb,var(--chrome-bg)_98%,black_2%))] px-[0.9rem] pt-[0.42rem] pb-0 text-[#f3f7fb] max-[760px]:px-[0.9rem] max-[760px]:pr-[0.9rem] [-webkit-app-region:drag]',
        desktopPlatform === 'darwin' && 'pl-[5.7rem] max-[1040px]:pl-[5.1rem] max-[760px]:px-[5.1rem] max-[760px]:pr-[0.9rem]',
      )}
    >
      {/* ① 좌측 드래그 존: macOS 신호등 영역(헤더 좌측 패딩). 스크롤 스트립과 겹치지 않는
          고정 rect 라 위치-의존 버그가 없다. 네이티브 신호등 클릭은 그대로, 빈 곳은 창 드래그. */}
      {desktopPlatform === 'darwin' ? (
        <div
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[5.7rem] max-[1040px]:w-[5.1rem] [-webkit-app-region:drag]"
        />
      ) : null}
      <div
        data-testid="titlebar-tab-region"
        className={cn(
          'relative flex min-w-0 flex-1 self-stretch transition-[background-color,box-shadow] duration-140',
          !isTitlebarInternalDragActive
            ? '[-webkit-app-region:drag]'
            : '[-webkit-app-region:no-drag]',
          isDetachHovering &&
            'bg-[rgba(142,209,194,0.08)] shadow-[inset_0_0_0_1px_rgba(142,209,194,0.16)]',
        )}
        onDragOver={(event) => {
          if (!canDetachToTabs) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setIsDetachHovering(true);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
          }
          setIsDetachHovering(false);
        }}
        onDrop={(event) => {
          if (!draggedSession || draggedSession.source !== 'workspace-pane' || !draggedSession.workspaceId) {
            return;
          }
          event.preventDefault();
          setIsDetachHovering(false);
          onDetachSessionToStandalone(draggedSession.workspaceId, draggedSession.sessionId);
          onEndSessionDrag();
        }}
      >
        <Tabs
          data-testid="titlebar-fixed-tabs"
          className="flex-none self-stretch items-stretch bg-transparent p-0 shadow-none border-0 gap-0 [-webkit-app-region:no-drag]"
        >
          <div
            ref={(node) => {
              titlebarTabItemRefs.current.home = node;
            }}
            className="shrink-0 flex"
          >
            <TabButton
              active={activeWorkspaceTab === 'home'}
              className={getTitlebarTabClass(activeWorkspaceTab === 'home')}
              onClick={onSelectHome}
            >
              <Home className="h-4 w-4 flex-none" aria-hidden />
              Home
            </TabButton>
          </div>
          <div
            ref={(node) => {
              titlebarTabItemRefs.current.sftp = node;
            }}
            className="shrink-0 flex"
          >
            <TabButton
              active={activeWorkspaceTab === 'sftp'}
              className={getTitlebarTabClass(activeWorkspaceTab === 'sftp')}
              onClick={onSelectSftp}
            >
              <Folder className="h-4 w-4 flex-none" aria-hidden />
              SFTP
            </TabButton>
          </div>
          {hasOpenContainers || activeWorkspaceTab === 'containers' ? (
            <div
              ref={(node) => {
                titlebarTabItemRefs.current.containers = node;
              }}
              className="shrink-0 flex"
            >
              <TabButton
                active={activeWorkspaceTab === 'containers'}
                className={getTitlebarTabClass(activeWorkspaceTab === 'containers')}
                onClick={onSelectContainers}
              >
                <Container className="h-4 w-4 flex-none" aria-hidden />
                Containers
              </TabButton>
            </div>
          ) : null}
        </Tabs>
        {dynamicItems.length > 0 ? (
          <div
            aria-hidden
            className="mx-1.5 my-[0.7rem] w-px flex-none bg-[rgba(255,255,255,0.12)]"
          />
        ) : null}
        <div className="relative min-w-0 flex-1 self-stretch">
          {showLeftTabStripFade ? (
            <div
              data-testid="titlebar-tab-strip-fade-left"
              className="pointer-events-none absolute inset-y-[0.24rem] left-[0.2rem] z-[1] w-11 rounded-l-[12px] bg-[linear-gradient(90deg,color-mix(in_srgb,var(--chrome-bg)_92%,rgba(255,255,255,0.08)_8%),transparent)]"
            />
          ) : null}
          {showRightTabStripFade ? (
            <div
              data-testid="titlebar-tab-strip-fade-right"
              className="pointer-events-none absolute inset-y-[0.24rem] right-[0.2rem] z-[1] w-11 rounded-r-[12px] bg-[linear-gradient(270deg,color-mix(in_srgb,var(--chrome-bg)_92%,rgba(255,255,255,0.08)_8%),transparent)]"
            />
          ) : null}
          <div
            ref={titlebarTabStripRef}
            data-titlebar-tab-strip="true"
            className={cn(
              'flex min-w-0 items-stretch gap-[0.3rem] overflow-x-auto overflow-y-hidden pl-1.5 h-full',
              !isTitlebarInternalDragActive
                ? '[-webkit-app-region:drag]'
                : '[-webkit-app-region:no-drag]',
            )}
            style={{ maskImage: stripMaskImage, WebkitMaskImage: stripMaskImage }}
            onScroll={updateTitlebarTabStripFades}
            onWheel={(event) => {
              // 탭이 많아 가로 오버플로우가 있을 때, 마우스 세로 휠을 가로 스크롤로
              // 변환한다(데스크톱 마우스엔 가로 스크롤 수단이 없어 탭을 못 고르던 문제).
              // 트랙패드 가로 스와이프(deltaX 우세)는 네이티브로 그대로 두고, 세로 휠
              // (deltaY 우세)일 때만 가로로 돌린다. preventDefault 없이 scrollLeft 만
              // 조정해 passive 리스너 경고를 피한다(타이틀바엔 세로 스크롤 대상이 없음).
              const el = event.currentTarget;
              if (el.scrollWidth <= el.clientWidth) {
                return;
              }
              if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                el.scrollLeft += event.deltaY;
              }
            }}
            onDragOver={(event) => {
              // 탭 재정렬 드래그만 처리. 패널 분할용 세션/페인 드래그(draggedTabRef
              // 없음)는 그대로 통과시켜 워크스페이스 병합·detach 가 깨지지 않게 한다.
              if (!draggedTabRef.current) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const drop = computeTabDrop(event.clientX);
              if (drop) {
                const targetKey = getTabKey(drop.target);
                setTabDropPreview((current) =>
                  current &&
                  current.targetKey === targetKey &&
                  current.placement === drop.placement
                    ? current
                    : { targetKey, placement: drop.placement },
                );
              }
              updateTabAutoScroll(event.clientX);
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                nextTarget instanceof Node &&
                event.currentTarget.contains(nextTarget)
              ) {
                return;
              }
              setTabDropPreview(null);
              stopTabAutoScroll();
            }}
            onDrop={(event) => {
              const payload = parseDraggedTab(
                event.dataTransfer.getData(TAB_DRAG_MIME),
              );
              const sourceTab = payload ?? draggedTabRef.current;
              stopTabAutoScroll();
              if (!sourceTab) {
                return;
              }
              const drop = computeTabDrop(event.clientX);
              if (!drop) {
                return;
              }
              event.preventDefault();
              setTabDropPreview(null);
              onReorderDynamicTab(sourceTab, drop.target, drop.placement);
            }}
          >
            {dynamicItems.map((item, idx) => {
              const slideX = tabSlideX(idx, dragSourceIndex, dropGap);
              const isDragSource = idx === dragSourceIndex;
              // 슬라이드는 컨테이너 className 의 transition 목록에 transform 을 더해 애니메이션.
              const tabSlideStyle: CSSProperties = {
                transform: slideX ? `translateX(${slideX}px)` : undefined,
              };
              if (item.kind === 'session') {
                const target = { kind: 'session', sessionId: item.sessionId } as const;
                const targetKey = getTabKey(target);
                return (
                  <div
                    key={item.sessionId}
                    ref={(node) => {
                      titlebarTabItemRefs.current[targetKey] = node;
                    }}
                    style={tabSlideStyle}
                    className={cn(
                      'group relative flex flex-none items-center gap-1 self-center mb-[0.42rem] rounded-[10px] border pr-1.5 scroll-mx-2 transition-[box-shadow,background-color,border-color,transform] duration-150 [-webkit-app-region:no-drag]',
                      getTitlebarDynamicTabContainerClass(item.active),
                      isDragSource && tabDragSourceHidden && 'opacity-0',
                    )}
                    draggable
                onMouseEnter={(event) => showTabHover(targetKey, event.currentTarget)}
                onMouseLeave={() => hideTabHover(targetKey)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-dolssh-session-id', item.sessionId);
                  event.dataTransfer.setData(TAB_DRAG_MIME, serializeDraggedTab({ kind: 'session', sessionId: item.sessionId }));
                  const nextDraggedTab = { kind: 'session', sessionId: item.sessionId } as const;
                  draggedTabRef.current = nextDraggedTab;
                  captureTabDragLayout(event.currentTarget.offsetWidth);
                  setIsTabDragging(true);
                  onStartSessionDrag(item.sessionId);
                }}
                onDragEnd={() => {
                  draggedTabRef.current = null;
                  setTabDropPreview(null);
                  setIsTabDragging(false);
                  setIsDetachHovering(false);
                  stopTabAutoScroll();
                  onEndSessionDrag();
                }}
              >
                <TabButton
                  active={item.active}
                  className={cn(
                    'min-w-[8.5rem]',
                    getTitlebarDynamicTabButtonClass(item.active),
                  )}
                  onClick={() => onSelectSession(item.sessionId)}
                >
                  <TabStatusDot state={item.dotState} />
                  <span className="truncate">{item.title}</span>
                  {item.active && item.rttMs != null ? (
                    <span
                      className="ml-1 flex-none text-[10px] tabular-nums"
                      style={{ color: rttColor(item.rttMs) }}
                    >
                      {item.rttMs}ms
                    </span>
                  ) : null}
                </TabButton>
                <IconButton
                  size="sm"
                  tone="ghost"
                  className={getTitlebarCloseButtonClass(item.active)}
                  aria-label={`${item.title} 세션 종료`}
                  onClick={async (event) => {
                    event.stopPropagation();
                    await onCloseSession(item.sessionId);
                  }}
                  disabled={item.status === 'disconnecting'}
                >
                  ×
                </IconButton>
              </div>
            );
          }

          if (item.kind === 'tmux') {
            const target = {
              kind: 'tmux',
              tmuxGroupId: item.tmuxGroupId,
            } as const;
            const tmuxTargetKey = getTabKey(target);
            return (
              <div
                key={`tmuxgrp:${item.tmuxGroupId}`}
                ref={(node) => {
                  titlebarTabItemRefs.current[tmuxTargetKey] = node;
                }}
                style={tabSlideStyle}
                className={cn(
                  'group relative flex flex-none items-center gap-1 self-center mb-[0.42rem] rounded-[10px] border pr-1.5 scroll-mx-2 transition-[box-shadow,background-color,border-color,transform] duration-150 [-webkit-app-region:no-drag]',
                  getTitlebarDynamicTabContainerClass(item.active),
                  isDragSource && tabDragSourceHidden && 'opacity-0',
                )}
                draggable
                onMouseEnter={(event) => showTabHover(tmuxTargetKey, event.currentTarget)}
                onMouseLeave={() => hideTabHover(tmuxTargetKey)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', item.title);
                  event.dataTransfer.setData(
                    TAB_DRAG_MIME,
                    serializeDraggedTab({
                      kind: 'tmux',
                      tmuxGroupId: item.tmuxGroupId,
                    }),
                  );
                  draggedTabRef.current = {
                    kind: 'tmux',
                    tmuxGroupId: item.tmuxGroupId,
                  };
                  captureTabDragLayout(event.currentTarget.offsetWidth);
                  setIsTabDragging(true);
                }}
                onDragEnd={() => {
                  draggedTabRef.current = null;
                  setTabDropPreview(null);
                  setIsTabDragging(false);
                  setIsDetachHovering(false);
                  stopTabAutoScroll();
                }}
              >
                <TabButton
                  active={item.active}
                  className={cn(
                    'min-w-[8.5rem]',
                    getTitlebarDynamicTabButtonClass(item.active),
                  )}
                  onClick={() => onSelectTmuxGroup(item.tmuxGroupId)}
                >
                  <span
                    className={cn(
                      'mr-1.5',
                      item.reconnecting
                        ? 'animate-spin text-[var(--warning-text)]'
                        : 'text-[var(--accent)]',
                    )}
                    aria-hidden
                  >
                    {item.reconnecting ? (
                      <RefreshCw className="h-4 w-4" />
                    ) : (
                      <Columns2 className="h-4 w-4" />
                    )}
                  </span>
                  <span className="truncate">{item.title}</span>
                  {item.active && item.rttMs != null ? (
                    <span
                      className="ml-1 flex-none text-[10px] tabular-nums"
                      style={{ color: rttColor(item.rttMs) }}
                    >
                      {item.rttMs}ms
                    </span>
                  ) : null}
                </TabButton>
                <IconButton
                  size="sm"
                  tone="ghost"
                  className={getTitlebarCloseButtonClass(item.active)}
                  aria-label={`${item.title} tmux 세션 detach`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTmuxGroup(item.tmuxGroupId);
                  }}
                >
                  ×
                </IconButton>
              </div>
            );
          }

          const target = { kind: 'workspace', workspaceId: item.workspaceId } as const;
          const targetKey = getTabKey(target);
          return (
            <div
              key={item.workspaceId}
              ref={(node) => {
                titlebarTabItemRefs.current[targetKey] = node;
              }}
              style={tabSlideStyle}
              className={cn(
                'group relative flex flex-none items-center gap-1 self-center mb-[0.42rem] rounded-[10px] border pr-1.5 scroll-mx-2 transition-[box-shadow,background-color,border-color,transform] duration-150 [-webkit-app-region:no-drag]',
                getTitlebarDynamicTabContainerClass(item.active),
                isDragSource && tabDragSourceHidden && 'opacity-0',
              )}
              draggable
              onMouseEnter={(event) => showTabHover(targetKey, event.currentTarget)}
              onMouseLeave={() => hideTabHover(targetKey)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.title);
                event.dataTransfer.setData(TAB_DRAG_MIME, serializeDraggedTab({ kind: 'workspace', workspaceId: item.workspaceId }));
                const nextDraggedTab = { kind: 'workspace', workspaceId: item.workspaceId } as const;
                draggedTabRef.current = nextDraggedTab;
                captureTabDragLayout(event.currentTarget.offsetWidth);
                setIsTabDragging(true);
              }}
              onDragEnd={() => {
                draggedTabRef.current = null;
                setTabDropPreview(null);
                setIsTabDragging(false);
                setIsDetachHovering(false);
                stopTabAutoScroll();
              }}
            >
              <TabButton
                active={item.active}
                className={cn(
                  'min-w-[10.5rem] gap-2',
                  getTitlebarDynamicTabButtonClass(item.active),
                )}
                onClick={() => onSelectWorkspace(item.workspaceId)}
              >
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full text-[0.9rem]',
                    item.active
                      ? 'bg-[var(--accent-surface)] text-[var(--accent-strong)]'
                      : 'bg-[rgba(255,255,255,0.08)] text-[rgba(243,247,251,0.78)]',
                  )}
                  aria-hidden="true"
                >
                  <Rows2 className="h-4 w-4" />
                </span>
                <span className="truncate">{item.title}</span>
                <span
                  className={cn(
                    'ml-auto inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-[0.7rem] font-semibold',
                    item.active
                      ? 'bg-[var(--accent-surface)] text-[var(--accent-strong)]'
                      : 'bg-[rgba(255,255,255,0.08)] text-[rgba(243,247,251,0.78)]',
                  )}
                >
                  {item.paneCount}
                </span>
              </TabButton>
              {item.isTmux ? (
                <IconButton
                  size="sm"
                  tone="ghost"
                  className={getTitlebarCloseButtonClass(item.active)}
                  aria-label={`${item.title} 새 tmux 창`}
                  title="새 tmux 창 (new-window)"
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewTmuxWindow?.(item.workspaceId);
                  }}
                >
                  <Plus className="h-4 w-4" />
                </IconButton>
              ) : null}
              <IconButton
                size="sm"
                tone="ghost"
                className={getTitlebarCloseButtonClass(item.active)}
                // tmux workspace 의 × 는 그 window 하나만 닫는다(closeWorkspace → 그 window 의
                // pane 만 kill-pane; tmux 가 마지막 pane kill 시 해당 window 만 닫음). 세션 전체
                // detach 는 pane 하단 control 바의 Detach 로만 한다.
                aria-label={
                  item.isTmux
                    ? `${item.title} 이 창 닫기`
                    : `${item.title} 닫기`
                }
                title={
                  item.isTmux
                    ? '이 창 닫기 — 이 tmux window 만 닫습니다. 세션 전체는 하단 바의 Detach/Kill 을 쓰세요.'
                    : undefined
                }
                onClick={async (event) => {
                  event.stopPropagation();
                  await onCloseWorkspace(item.workspaceId);
                }}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          );
        })}
        {/* 마지막 탭 뒤 여백 스페이서. flex + overflow-x 컨테이너는 스크롤 끝에서
            오른쪽 padding 을 무시해(Chromium) 마지막 탭의 둥근 모서리가 잘린다 → 패딩 대신
            항상 스페이서로 여백을 확보한다. 드래그 중엔 넓혀 '맨 끝으로 놓기'도 쉽게. */}
        {dynamicItems.length > 0 ? (
          <div
            aria-hidden
            className={cn('h-10 flex-none', isTabDragging ? 'w-8' : 'w-2')}
          />
        ) : null}
          </div>
        </div>
      </div>
      {/* ② 우측 드래그 존: 탭과 컨트롤 사이 빈 공간. self-stretch 로 헤더 높이를 채워
          실제 드래그 면적을 갖고(0-height 버그 방지), min-w-16 으로 탭이 많아도 종 옆에
          항상 드래그 영역이 남는다. 스크롤 스트립과 겹치지 않는 형제라 안전. */}
      <div
        aria-hidden
        className="min-w-16 flex-none self-stretch [-webkit-app-region:drag]"
      />
      <div className="relative flex items-center self-center mb-[0.42rem] gap-[0.55rem] [-webkit-app-region:no-drag]">
        <div className="relative [-webkit-app-region:no-drag]" ref={updateMenuRef}>
          {showInstallAction ? (
            <Tooltip label={installTooltip}>
              <Button
                variant="primary"
                size="sm"
                className="h-9 min-h-9 whitespace-nowrap rounded-[9px] px-3"
                aria-label="업데이트"
                onClick={onInstallUpdate}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                업데이트
              </Button>
            </Tooltip>
          ) : (
            <IconButton
              tone="default"
              active={isUpdateOpen}
              className="relative h-9 w-9 rounded-full border-transparent bg-[rgba(255,255,255,0.06)] text-[1.15rem] text-white shadow-none hover:bg-[rgba(255,255,255,0.1)]"
              aria-label="업데이트 상태 보기"
              onClick={() => setIsUpdateOpen((current) => !current)}
            >
              <Bell className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />
              {showBadge ? <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[var(--accent-strong)] ring-2 ring-[var(--chrome-bg)]" /> : null}
            </IconButton>
          )}

          {!showInstallAction && isUpdateOpen ? (
            <div
              data-testid="update-popover"
              className="absolute right-0 top-[calc(100%+0.8rem)] z-20 w-[min(24rem,calc(100vw-2rem))] rounded-[12px] border border-[var(--border)] bg-[var(--dialog-surface)] p-5 shadow-[var(--shadow-floating)]"
            >
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 text-[var(--text)]">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent-strong)_14%,var(--surface))] text-[var(--accent-strong)]" aria-hidden="true">
                      <ArrowUpRight className="h-[1.05rem] w-[1.05rem]" />
                    </span>
                    <strong>{titleText}</strong>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.82rem] text-[var(--text-soft)]">
                    {publishedAt ? <span>{publishedAt}</span> : null}
                    {updateState.release?.version ? <span>Version {updateState.release.version}</span> : null}
                  </div>
                </div>
                <Badge>{updateState.currentVersion}</Badge>
              </div>

              <div className="space-y-3 pb-4 text-[0.9rem] leading-[1.55] text-[var(--text-soft)]">
                {!updateState.enabled ? (
                  <p>자동 업데이트는 패키지된 릴리즈 빌드에서만 동작합니다.</p>
                ) : null}

                {!updateState.release && getEmptyReleaseMessage(updateState) ? (
                  <p>{getEmptyReleaseMessage(updateState)}</p>
                ) : null}

                {updateState.status === 'upToDate' ? <p>현재 최신 버전을 사용 중입니다.</p> : null}
                {updateState.status === 'available' ? (
                  <p>새 버전을 확인했습니다. 백그라운드 다운로드를 준비하고 있습니다.</p>
                ) : null}
                {updateState.status === 'downloading' ? (
                  <p>업데이트를 다운로드하는 중입니다. {formatProgressPercent(updateState)}</p>
                ) : null}
                {updateState.status === 'downloaded' ? (
                  <p>업데이트가 준비되었습니다. 재시작하면 새 버전이 적용됩니다.</p>
                ) : null}
                {updateState.status === 'error' && updateState.errorMessage ? (
                  <p className="text-[var(--danger-text)]">{updateState.errorMessage}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[color-mix(in_srgb,var(--border)_82%,white_18%)] pt-4">
                <Button variant="secondary" onClick={async () => {
                  await onOpenReleasePage(releaseUrl);
                }}>
                  Changelog
                  <ArrowUpRight className="h-[0.9rem] w-[0.9rem]" />
                </Button>
                {showCheckAction ? (
                  <Button variant="primary" onClick={onCheckForUpdates}>
                    {updateState.status === 'error' ? '다시 시도' : '업데이트 확인'}
                  </Button>
                ) : null}
                {showDevDisabledAction ? (
                  <Button variant="secondary" disabled>
                    개발 실행에서는 비활성
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <DesktopWindowControls
          desktopPlatform={desktopPlatform}
          windowState={windowState}
          onMinimizeWindow={onMinimizeWindow}
          onMaximizeWindow={onMaximizeWindow}
          onRestoreWindow={onRestoreWindow}
          onCloseWindow={onCloseWindow}
        />
      </div>
      {hoveredTab && hoverInfo ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[200] w-max max-w-[300px] rounded-[10px] border border-[var(--chrome-border)] bg-[color-mix(in_srgb,var(--chrome-bg)_92%,black_8%)] px-3 py-2.5 text-[#f3f7fb] shadow-[0_12px_32px_rgba(0,0,0,0.45)] [-webkit-app-region:no-drag]"
          style={{ left: hoveredTab.left, top: hoveredTab.top }}
        >
          <div className="text-[0.82rem] font-semibold tracking-[0.01em]">
            {hoverInfo.heading}
          </div>
          {hoverInfo.target ? (
            <div className="mt-0.5 max-w-[276px] truncate font-mono text-[0.7rem] text-[rgba(243,247,251,0.62)]">
              {hoverInfo.target}
            </div>
          ) : null}
          {hoverInfo.rows.length > 0 ? (
            <div className="mt-2 space-y-1 border-t border-[rgba(255,255,255,0.08)] pt-2">
              {hoverInfo.rows.map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between gap-5 text-[0.7rem]"
                >
                  <span className="flex-none text-[rgba(243,247,251,0.45)]">
                    {row.label}
                  </span>
                  <span
                    className="max-w-[190px] truncate text-right text-[rgba(243,247,251,0.9)]"
                    style={row.valueColor ? { color: row.valueColor } : undefined}
                  >
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
