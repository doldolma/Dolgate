import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DesktopWindowState, HostRecord, RdpMonitorSelection, SessionConnectionKind, TailnetPeer, TailnetStatus, TerminalTab, UpdateState } from '@shared';
import { describeRdpDrives, isRdpHostRecord, isSshHostRecord, isVncHostRecord } from '@shared';
import type {
  DynamicTabStripItem,
  TmuxSessionGroup,
  WorkspaceTab,
  WorkspaceTabId
} from '../store/createAppStore';
import { DesktopWindowControls, type DesktopPlatform } from './DesktopWindowControls';
import { listTailnets, snapshotTailnets } from '../services/desktop/tailnet';
import { cidrPrefixLength, isAddressInCidr, isIpAddress } from '../lib/ip-prefix';
import { cn } from '../lib/cn';
import { rttColor } from '../lib/rtt';
import { RdpMonitorPicker } from './rdp/RdpMonitorPicker';
import { titleBarMode, useTitleBarAutoHide } from './useTitleBarAutoHide';
import {
  getSessionConnectedAt,
  getSessionCwd,
  getSessionLastCommandAt,
} from '../lib/terminal-cwd-registry';
import { getVncCapabilities } from '../lib/vnc-capability-registry';
import { listWorkspaceSessionIds } from './terminal-workspace/terminalWorkspaceLayout';
import { Badge, Button, IconButton, TabButton, Tabs, Tooltip } from '../ui';
import { ArrowUpRight, Bell, Columns2, Container, Download, Folder, Home, PanelRight, Plus, RefreshCw, Rows2, X } from '../ui/icons';
import { resolveFocusedPaneSessionId } from './terminal-workspace/terminalWorkspaceLayout';
import { useTranslation } from 'react-i18next';
import { getFormatLocale, t } from '../i18n';

interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

/**
 * 상단 바(다크 크롬)의 토글 아이콘 버튼.
 *
 * 평소에는 배경 없이 아이콘만 둔다. 켜지면 옅은 칩 + 얇은 테두리로 바꾸고 아이콘만 완전한
 * 흰색이 된다 — 흰 원으로 채우면 크롬에서 그것만 튀고, hover 배경만으로는 켜진 티가 나지
 * 않는다. IconButton 의 active 색(selection-tint)은 밝은 배경을 가정한 값이라 여기선 못 쓴다.
 */
const CHROME_TOGGLE_CLASS =
  'h-9 w-9 rounded-full border-transparent bg-transparent text-[1.15rem] text-[rgba(255,255,255,0.66)] shadow-none hover:bg-[rgba(255,255,255,0.1)] hover:text-white';
const CHROME_TOGGLE_ON_CLASS =
  'bg-[rgba(255,255,255,0.16)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.24)] hover:bg-[rgba(255,255,255,0.2)]';

interface AppTitleBarProps {
  desktopPlatform: DesktopPlatform;
  tabs: TerminalTab[];
  workspaces: WorkspaceTab[];
  tmuxGroups: TmuxSessionGroup[];
  /** 호스트 카탈로그 — tmux 상단 탭에 호스트명을 표시하기 위해 group.hostId 해석에 사용. */
  hosts: HostRecord[];
  tabStrip: DynamicTabStripItem[];
  /**
   * 이 RDP 세션의 호스트가 쓸 로컬 모니터를 정한다. 선택은 호스트에 남고, 배치는 접속 시점에
   * 정해지므로 적용에 재접속이 따른다.
   */
  onSetRdpMonitors: (sessionId: string, monitors: RdpMonitorSelection[]) => void;
  /** 이 세션의 호스트에 저장된 모니터 선택. 배치도를 열 때 켜둘 화면을 정한다. */
  resolveRdpMonitors: (sessionId: string) => RdpMonitorSelection[] | null;
  activeWorkspaceTab: WorkspaceTabId;
  /** 세션 패널(오른쪽)이 열려 있는가. 셸 세션을 보고 있을 때만 토글이 뜬다. */
  sessionPanelOpen: boolean;
  onToggleSessionPanel: () => void;
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
  onToggleFullScreenWindow: () => Promise<void>;
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

type TitlebarDynamicItem =
  | {
      kind: 'session';
      sessionId: string;
      title: string;
      status: TerminalTab['status'];
      active: boolean;
      dotState: TabDotState;
      /** 원격 화면 세션에만 있는 메뉴를 위해 종류를 구분한다. */
      paneKind: 'terminal' | 'rdp' | 'vnc';
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
      return t('titleBar.kind.local');
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
      return t('titleBar.kind.serial');
    case 'rdp':
      return 'RDP';
    case 'vnc':
      return 'VNC';
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
    case 'rdp':
      return 'rdp';
    case 'vnc':
      return 'vnc';
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
    // 계정은 자격증명에만 있어 여기선 모른다 — 세션 탭 hover 는 접속 응답에 실려 온
    // rdpUsername 으로 user@host 를 따로 만든다(buildTabHoverInfo 참고).
    case 'rdp':
    case 'vnc':
      return `${host.hostname}:${host.port}`;
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
    return t('titleBar.elapsed.seconds', { count: sec });
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return t('titleBar.elapsed.minutes', { count: min });
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const remMin = min % 60;
    return remMin > 0
      ? t('titleBar.elapsed.hoursMinutes', { hours: hr, minutes: remMin })
      : t('titleBar.elapsed.hours', { count: hr });
  }
  const days = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0
    ? t('titleBar.elapsed.daysHours', { days, hours: remHr })
    : t('titleBar.elapsed.days', { count: days });
}

// 상대 시각("2분 전"). 마지막 명령 시각용.
function formatAgo(atMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  if (sec < 10) {
    return t('titleBar.ago.justNow');
  }
  if (sec < 60) {
    return t('titleBar.ago.seconds', { count: sec });
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return t('titleBar.ago.minutes', { count: min });
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return t('titleBar.ago.hours', { count: hr });
  }
  return t('titleBar.ago.days', { count: Math.floor(hr / 24) });
}

type TabHoverRow = { label: string; value: string; valueColor?: string };
type TabHoverInfo = {
  heading: string;
  target: string | null;
  rows: TabHoverRow[];
};

// hover 카드 내용: 탭이 이미 보여주는 것(제목·상태점·활성 RTT)은 빼고, 탭만 봐선 모르는
// 것만 모은다 — 연결 종류(헤드라인)·대상·비정상 상태·명령·점프·비활성 RTT·공유.

/**
 * 이 연결이 tailnet 을 경유하는지, 경유하면 지금 어떤 경로인지 조회하는 함수.
 *
 * 경로는 고정이 아니라서 폴링한다 — 유저스페이스 노드는 붙은 직후 릴레이로 시작해 홀펀칭이
 * 되면 직결로 승격한다. 그 승격이 눈에 보여야 "느리다"를 추측이 아니라 확인으로 판단할 수
 * 있다.
 *
 * tailnet 을 쓰는 탭이 하나도 없으면 아무것도 하지 않는다. tailnet 을 안 쓰는 사용자에게
 * 주기적인 IPC 를 들일 이유가 없다.
 */
type TailnetPathLookup = (host: HostRecord) => TailnetPathInfo | null;

type TailnetPathInfo = {
  label: string;
  /** 노드 자체가 안 붙어 있으면 undefined — 경로를 말할 단계가 아니다. */
  connected: boolean;
  /** 대상 기기를 아직 못 찾았으면 undefined(경로 확인 중). */
  direct?: boolean;
  relay?: string;
  /**
   * 대상이 tailnet 노드가 아니라 서브넷 라우터를 거쳐 닿는 경우, 그 라우터의 이름.
   *
   * 이때 direct·relay 는 라우터까지의 경로다 — 그 구간이 tailnet 이 관여하는 전부이고,
   * 라우터에서 대상까지는 평범한 사내망이라 여기서 말할 것이 없다.
   */
  via?: string;
};

const TAILNET_PATH_POLL_MS = 5_000;

/**
 * 이 호스트가 경유하는 tailnet id. 세 종류가 같은 필드를 쓴다.
 *
 * 판정을 한 곳에 두는 이유는 이 조회가 두 단계(구독할 목록 + 개별 조회)이고, 한쪽만 고치면 상태는
 * 받아 오는데 표시가 안 되거나 그 반대가 되기 때문이다.
 */
export function tailnetIdOf(host: HostRecord | undefined | null): string {
  if (!host) {
    return '';
  }
  if (isSshHostRecord(host) || isRdpHostRecord(host) || isVncHostRecord(host)) {
    return host.tailnetId?.trim() ?? '';
  }
  return '';
}

/**
 * 상태를 폴링해야 하는 tailnet 목록. 화면에 떠 있는 것들이 실제로 쓰는 tailnet 만 모은다.
 *
 * **SSH 만 보면 안 된다.** RDP·VNC 도 tailnet 을 경유해 붙는다(ipc/rdp·ipc/vnc 의
 * openForward). 빼면 그 세션의 상태를 아예 조회하지 않아 hover 에 경로가 안 뜬다 —
 * "느린데 릴레이 경유인지 직결인지" 를 그 줄에서만 알 수 있다.
 *
 * **tmux 그룹도 봐야 한다.** control mode 로 붙으면 원래 SSH 탭이 자리를 내주고 그룹으로
 * 바뀌어 tabs 에서 사라진다. 빠뜨리면 tailnet 을 쓰는 탭이 하나도 없는 것으로 계산돼
 * 호출부가 statuses 를 통째로 비우고, 그룹 hover 는 라벨만 남은 채 "연결 안 됨" 으로
 * 보인다(연결은 멀쩡한데 표시만 깨진다).
 */
export function collectTailnetIdsInUse(
  tabs: Pick<TerminalTab, 'hostId'>[],
  tmuxGroups: Pick<TmuxSessionGroup, 'hostId'>[],
  hosts: HostRecord[],
): Set<string> {
  const ids = new Set<string>();
  const addFor = (hostId: string | null | undefined) => {
    const tailnetId = tailnetIdOf(hosts.find((candidate) => candidate.id === hostId));
    if (tailnetId) {
      ids.add(tailnetId);
    }
  };
  for (const tab of tabs) {
    addFor(tab.hostId);
  }
  for (const group of tmuxGroups) {
    addFor(group.hostId);
  }
  return ids;
}

function useTailnetPathLookup(
  tabs: TerminalTab[],
  tmuxGroups: TmuxSessionGroup[],
  hosts: HostRecord[],
): TailnetPathLookup {
  const tailnetIdsInUse = useMemo(
    () => collectTailnetIdsInUse(tabs, tmuxGroups, hosts),
    [tabs, tmuxGroups, hosts],
  );
  // Set 은 매번 새 객체라 의존성으로 쓰면 효과가 매 렌더 재실행된다. 내용으로 비교한다.
  const tailnetKey = useMemo(() => [...tailnetIdsInUse].sort().join(','), [tailnetIdsInUse]);

  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [statuses, setStatuses] = useState<Map<string, TailnetStatus>>(new Map());

  useEffect(() => {
    if (!tailnetKey) {
      setStatuses(new Map());
      return;
    }
    let cancelled = false;
    // 브리지가 없으면 이 함수들이 동기적으로 던진다 — Promise 로 감싸야 .catch 가 잡는다.
    void Promise.resolve()
      .then(listTailnets)
      .then((records) => {
        if (!cancelled) {
          setLabels(new Map(records.map((record) => [record.id, record.label])));
        }
      })
      .catch(() => {
        // 이름을 못 읽어도 경로는 보여줄 수 있다.
      });

    const poll = () => {
      void Promise.resolve()
        .then(snapshotTailnets)
        .then((snapshot) => {
          if (!cancelled) {
            setStatuses(new Map(snapshot.statuses.map((status) => [status.id, status])));
          }
        })
        .catch(() => {
          // 스냅샷을 못 읽는 것이 툴팁 전체를 막을 이유는 없다.
        });
    };
    poll();
    const timer = window.setInterval(poll, TAILNET_PATH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tailnetKey]);

  return useCallback(
    (host: HostRecord): TailnetPathInfo | null => {
      const tailnetId = tailnetIdOf(host);
      if (!tailnetId) {
        return null;
      }
      // 주소도 종류별로 다른 필드에 있다. tailnet 을 쓰는 세 종류는 모두 hostname 이지만,
      // 그 사실을 여기서 좁혀 두지 않으면 AWS 레코드까지 들어와 타입이 안 맞는다.
      if (!isSshHostRecord(host) && !isRdpHostRecord(host) && !isVncHostRecord(host)) {
        return null;
      }
      const label = labels.get(tailnetId) ?? tailnetId;
      const status = statuses.get(tailnetId);
      if (!status || status.state !== 'running') {
        return { label, connected: false };
      }
      const peer = findTailnetPeer(status.peers, host.hostname);
      if (peer) {
        return { label, connected: true, direct: peer.direct, relay: peer.relay };
      }
      // 대상이 tailnet 노드가 아니면 그것으로 끝이 아니다 — 서브넷 라우터를 거쳐 닿는
      // 호스트가 흔하다. 라우터를 못 찾을 때만 "경로 확인 중"이다.
      const router = findTailnetSubnetRouter(status.peers, host.hostname);
      if (!router) {
        return { label, connected: true };
      }
      return {
        label,
        connected: true,
        direct: router.direct,
        relay: router.relay,
        via: router.hostName || router.dnsName?.split('.')[0] || undefined,
      };
    },
    [labels, statuses],
  );
}

/**
 * 호스트 주소로 tailnet 기기를 찾는다.
 *
 * 주소는 MagicDNS 짧은 이름("agt-1")일 수도, FQDN 일 수도, tailnet IP 일 수도 있다. 셋 다
 * 맞춰야 한다 — 하나라도 빠뜨리면 그 형태를 쓰는 사용자에게는 늘 "경로 확인 중"으로 보인다.
 */
export function findTailnetPeer(
  peers: TailnetPeer[] | undefined,
  hostname: string,
): TailnetPeer | null {
  const target = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!target || !peers) {
    return null;
  }
  return (
    peers.find((peer) => {
      if (peer.hostName?.toLowerCase() === target) {
        return true;
      }
      const dnsName = peer.dnsName?.toLowerCase();
      if (dnsName === target) {
        return true;
      }
      // 짧은 이름으로 저장한 호스트를 FQDN peer 에 맞춘다(그 역도 위에서 처리된다).
      if (dnsName && dnsName.split('.')[0] === target) {
        return true;
      }
      return peer.ips?.includes(target) === true;
    }) ?? null
  );
}

/**
 * 이 주소를 담당하는 서브넷 라우터를 찾는다.
 *
 * tailnet 을 거쳐 가는 호스트가 전부 tailnet 노드인 것은 아니다 — tailscale 이 깔려 있지 않은
 * 사내망 장비는 라우터가 광고하는 대역을 통해 닿는다. 그런 호스트는 peer 목록의 어떤 IP 와도
 * 맞지 않아, 라우터를 찾지 않으면 경로가 영영 "확인 중"으로 남는다.
 *
 * 이름이 아니라 IP 일 때만 찾는다. MagicDNS 이름이 대역에 속하는지는 물어볼 수 없다.
 * 여러 대역이 걸리면 더 구체적인 쪽(접두가 긴 쪽)이 실제 경로다.
 */
export function findTailnetSubnetRouter(
  peers: TailnetPeer[] | undefined,
  hostname: string,
): TailnetPeer | null {
  const target = hostname.trim();
  if (!target || !peers || !isIpAddress(target)) {
    return null;
  }
  let best: TailnetPeer | null = null;
  let bestBits = -1;
  for (const peer of peers) {
    for (const route of peer.routes ?? []) {
      if (!isAddressInCidr(target, route)) {
        continue;
      }
      const bits = cidrPrefixLength(route);
      if (bits > bestBits) {
        best = peer;
        bestBits = bits;
      }
    }
  }
  return best;
}

/**
 * 라우터 이름이 길면 이름 쪽을 줄인다.
 *
 * 값 칸은 CSS 로 잘리는데 잘리는 쪽이 **끝**이라, 그대로 두면 `…경유 · 직결` 에서 정작
 * 중요한 직결/릴레이가 먼저 사라진다. 경로를 남기려면 이름을 우리가 먼저 줄여야 한다.
 *
 * 앞쪽을 남긴다 — 호스트 이름은 보통 앞이 구별하는 부분이다(`seoul-rtr-01` 의 `seoul-rtr`).
 */
export function shortenRouterName(name: string, max = 14): string {
  const trimmed = name.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  // 말줄임표가 한 글자를 차지하므로 그만큼 덜 남긴다.
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}

/** 경로 한 줄을 만든다. 릴레이면 어느 DERP 지역인지까지 보여 준다. */
function tailnetPathRow(info: TailnetPathInfo): TabHoverRow {
  if (!info.connected) {
    return {
      label: t('titleBar.hover.tailnet'),
      value: `${info.label} · ${t('titleBar.hover.tailnetNotConnected')}`,
      valueColor: TAB_DOT_COLOR.error,
    };
  }
  if (info.direct === undefined) {
    return {
      label: t('titleBar.hover.tailnet'),
      value: `${info.label} · ${t('titleBar.hover.tailnetPathUnknown')}`,
    };
  }
  // 라우터 경유면 그 사실을 먼저 말한다 — 경로(직결/릴레이)가 대상이 아니라 라우터까지의
  // 것이라, 그 말이 없으면 숫자를 잘못 읽는다.
  const path = info.direct
    ? t('titleBar.hover.tailnetPathDirect')
    : info.relay
      ? t('titleBar.hover.tailnetPathRelay', { relay: info.relay })
      : t('titleBar.hover.tailnetPathRelayUnknown');
  const detail = info.via
    ? t('titleBar.hover.tailnetPathViaRouter', {
        router: shortenRouterName(info.via),
        path,
      })
    : path;
  return {
    label: t('titleBar.hover.tailnet'),
    value: `${info.label} · ${detail}`,
    valueColor: info.direct ? 'var(--success,#3fae8f)' : 'var(--warning-text)',
  };
}

/**
 * VNC 세션에서 실제로 켜진 확장을 hover 행으로 만든다.
 *
 * **선언과 실제가 다르다.** 코어는 늘 같은 목록을 선언하지만 켜지는 것은 서버마다 갈리고, 그
 * 결과를 볼 방법이 지금까지 없었다. 특히 클립보드는 여기서만 설명된다 — 서버가 UTF-8 확장을
 * 지원하지 않으면 한글을 붙여넣을 수 없고 우리가 할 수 있는 일이 없다.
 */
export function vncCapabilityRows(sessionId: string): TabHoverRow[] {
  const capabilities = getVncCapabilities(sessionId);
  if (!capabilities) {
    return [];
  }
  const rows: TabHoverRow[] = [];
  const enabled = [
    capabilities.cursor ? t('titleBar.hover.capabilityCursor') : null,
    capabilities.desktopResize ? t('titleBar.hover.capabilityResize') : null,
    capabilities.continuousUpdates ? t('titleBar.hover.capabilityContinuous') : null,
    capabilities.qemuKeys ? t('titleBar.hover.capabilityScancode') : null,
  ].filter((name): name is string => name !== null);
  rows.push({
    label: t('titleBar.hover.capabilities'),
    value: enabled.length > 0 ? enabled.join(' · ') : t('titleBar.hover.capabilityNone'),
  });
  rows.push({
    label: t('titleBar.hover.clipboard'),
    value: capabilities.extendedClipboard
      ? t('titleBar.hover.clipboardUtf8')
      : t('titleBar.hover.clipboardAscii'),
  });
  // 인코딩은 대역폭을 설명한다 — Raw 만 오면 화면 한 장이 수 MB 다. 아직 픽셀을 못 받았으면 뺀다.
  if (capabilities.encoding) {
    rows.push({ label: t('titleBar.hover.encoding'), value: capabilities.encoding });
  }
  return rows;
}

export function buildTabHoverInfo(
  item: TitlebarDynamicItem,
  tabs: TerminalTab[],
  hosts: HostRecord[],
  tmuxGroups: TmuxSessionGroup[],
  workspaces: WorkspaceTab[],
  tailnetPath: TailnetPathLookup,
): TabHoverInfo {
  const rows: TabHoverRow[] = [];

  if (item.kind === 'session') {
    const tab = tabs.find((candidate) => candidate.sessionId === item.sessionId);
    const host = tab?.hostId
      ? hosts.find((candidate) => candidate.id === tab.hostId) ?? null
      : null;
    const kind = deriveSessionConnectionKind(tab, host);
    // 연결할 때 감지한 운영체제. 뱃지는 마크가 있을 때만 바뀌므로(Windows·NAS 는 글자로 남는다)
    // 실제로 무엇을 잡았는지는 여기서만 볼 수 있다.
    if (host?.detectedOs) {
      rows.push({
        label: t('titleBar.hover.os'),
        value: host.detectedOs.prettyName || host.detectedOs.id,
      });
    }
    if (host?.kind === 'ssh' && host.jumpHostId) {
      const jump = hosts.find((candidate) => candidate.id === host.jumpHostId);
      rows.push({ label: t('titleBar.hover.jump'), value: jump?.label ?? host.jumpHostId });
    }
    if (tab?.reconnect) {
      rows.push({
        label: t('titleBar.hover.reconnect'),
        value: tab.reconnect.waitingForNetwork
          ? t('titleBar.hover.waitingNetwork')
          : t('titleBar.hover.attempts', {
              attempt: tab.reconnect.attempt,
              max: tab.reconnect.maxAttempts,
            }),
        valueColor: TAB_DOT_COLOR.reconnecting,
      });
    } else if (tab?.status === 'error' && tab.errorMessage) {
      rows.push({ label: t('titleBar.hover.error'), value: tab.errorMessage, valueColor: TAB_DOT_COLOR.error });
    }

    // 마이크를 보낼 수 없으면 그 이유. **조용히 실패하면 사용자는 마이크가 켜진 줄 알고 원격에서
    // 말한다** — 그래서 어딘가에는 반드시 보여야 하고, 그 자리가 여기다(예전에는 원격 화면 위에
    // 배너로 겹쳐 두었는데 작업 표시줄과 섞여 읽히지 않았다).
    if (tab?.rdpMicrophoneProblem) {
      rows.push({
        label: t('titleBar.hover.microphone'),
        // hover 행은 좁고 잘린다(truncate). 긴 안내 문장 대신 짧은 상태 말을 쓴다.
        value: t(`rdp.microphone.short.${tab.rdpMicrophoneProblem}`),
        valueColor: 'var(--warning-text)',
      });
    }

    if (tab?.rdpCameraProblem) {
      rows.push({
        label: t('titleBar.hover.camera'),
        value: t(`rdp.camera.short.${tab.rdpCameraProblem}`),
        valueColor: 'var(--warning-text)',
      });
    }
    const cwd = getSessionCwd(item.sessionId);
    if (cwd) {
      rows.push({ label: t('titleBar.hover.cwd'), value: cwd });
    }
    if (tab?.shellKind) {
      rows.push({ label: t('titleBar.hover.shell'), value: tab.shellKind });
    }
    // "연결 경과"는 현재 실제로 연결된 동안만 의미가 있다. tmux control 연결은 SSH 가
    // 붙는 순간 코어가 낙관적으로 connected 를 emit 해 connectedAt 이 찍히는데, 직후
    // tmux 가 없어 실패하면 status 가 error 가 된다. 그 상태에서 경과시간이 계속 늘면
    // 안 되므로 status==='connected' 일 때만 표시한다.
    const connectedAt = getSessionConnectedAt(item.sessionId);
    if (connectedAt != null && tab?.status === 'connected') {
      rows.push({ label: t('titleBar.hover.connectedFor'), value: formatElapsed(connectedAt) });
    }
    if (tab?.commandState === 'running') {
      rows.push({
        label: t('titleBar.hover.command'),
        value: t('titleBar.hover.running'),
        valueColor: TAB_DOT_COLOR.running,
      });
    } else {
      const lastCommandAt = getSessionLastCommandAt(item.sessionId);
      if (lastCommandAt != null) {
        rows.push({
          label: t('titleBar.hover.lastCommand'),
          value:
            tab?.commandState === 'failed'
              ? t('titleBar.hover.lastCommandFailed', { ago: formatAgo(lastCommandAt) })
              : formatAgo(lastCommandAt),
          valueColor: tab?.commandState === 'failed' ? TAB_DOT_COLOR.error : undefined,
        });
      }
    }
    // RDP 는 터미널 개념(cwd·셸·명령)이 없는 대신 화면과 공유 자원이 있다. 해상도는 항상,
    // 옵션(드라이브·오디오·클립보드·관리 세션)은 기본값과 다를 때만 — 아무것도 안 바꾼
    // 세션에서는 행이 늘지 않는다.
    if (tab && host && isRdpHostRecord(host)) {
      if (tab.rdpDesktopSize) {
        const monitorCount = tab.rdpMonitorCount ?? 1;
        const size = `${tab.rdpDesktopSize.width}×${tab.rdpDesktopSize.height}`;
        rows.push({
          label: t('titleBar.hover.resolution'),
          value:
            monitorCount > 1
              ? `${size} · ${t('titleBar.hover.monitorCount', { count: monitorCount })}`
              : size,
        });
      }
      const drives = describeRdpDrives(host.drives);
      if (drives.length > 0) {
        const names = drives
          .slice(0, 2)
          .map((drive) =>
            drive.readOnly
              ? t('titleBar.hover.driveReadOnly', { name: drive.name })
              : drive.name,
          )
          .join(', ');
        rows.push({
          label: t('titleBar.hover.drives'),
          value:
            drives.length > 2
              ? t('titleBar.hover.drivesMore', { names, count: drives.length - 2 })
              : names,
        });
      }
      if (host.audioEnabled === false) {
        rows.push({ label: t('titleBar.hover.audio'), value: t('titleBar.hover.off') });
      }
      if (host.clipboardEnabled === false) {
        rows.push({ label: t('titleBar.hover.clipboard'), value: t('titleBar.hover.off') });
      }
      if (host.adminSession === true) {
        rows.push({ label: t('titleBar.hover.adminSession'), value: t('titleBar.hover.on') });
      }
    }
    // VNC 는 RDP 와 같은 순서로 읽는다 — **무엇이 보이는가(해상도)** 다음에 **내가 바꾼 설정**,
    // 마지막에 **협상 결과**다. 설정은 기본값과 다를 때만 넣는다: 아무것도 안 바꾼 세션에서 행이
    // 늘면 정작 다른 값이 묻힌다(RDP 블록과 같은 규칙).
    if (tab && host && isVncHostRecord(host)) {
      if (tab.rdpDesktopSize) {
        rows.push({
          label: t('titleBar.hover.resolution'),
          value: `${tab.rdpDesktopSize.width}×${tab.rdpDesktopSize.height}`,
        });
      }
      if (host.imageQuality === 'balanced' || host.imageQuality === 'fast') {
        rows.push({
          label: t('titleBar.hover.quality'),
          value: t(
            host.imageQuality === 'balanced'
              ? 'titleBar.hover.qualityBalanced'
              : 'titleBar.hover.qualityFast',
          ),
        });
      }
      if (host.viewOnly === true) {
        rows.push({
          label: t('titleBar.hover.viewOnly'),
          value: t('titleBar.hover.on'),
        });
      }
      if (host.shared === false) {
        rows.push({
          label: t('titleBar.hover.screenShare'),
          value: t('titleBar.hover.off'),
        });
      }
      // SSH 터널을 경유하면 그 호스트를 이름으로 보여준다 — 주소만 보면 왜 localhost 로 붙는지
      // 알 수 없다(SSH 의 점프 행과 같은 뜻이라 같은 라벨을 쓴다).
      if (host.sshTunnelHostId) {
        const tunnel = hosts.find((candidate) => candidate.id === host.sshTunnelHostId);
        rows.push({
          label: t('titleBar.hover.jump'),
          value: tunnel?.label ?? host.sshTunnelHostId,
        });
      }
      rows.push(...vncCapabilityRows(item.sessionId));
    }
    // 지연 바로 위에 둔다. "느리다"를 판단할 때 이 둘을 같이 읽어야 한다 — 릴레이 경유면
    // 지연이 큰 이유가 설명되고, 직결인데도 크면 원인이 다른 데 있다.
    if (host) {
      const path = tailnetPath(host);
      if (path) {
        rows.push(tailnetPathRow(path));
      }
    }
    if (item.rttMs != null) {
      rows.push({ label: t('titleBar.hover.latency'), value: `${item.rttMs}ms`, valueColor: rttColor(item.rttMs) });
    }
    if (tab?.sessionShare?.shareUrl) {
      rows.push({
        label: t('titleBar.hover.share'),
        value: t('titleBar.hover.viewers', { count: tab.sessionShare.viewerCount }),
        valueColor: TAB_DOT_COLOR.running,
      });
    }
    return {
      heading: kind ? connectionKindLabel(kind) : t('titleBar.kind.session'),
      // RDP 계정은 호스트 레코드에 없어 접속 응답에서 온 rdpUsername 으로 붙인다.
      target:
        host && isRdpHostRecord(host) && tab?.rdpUsername
          ? `${tab.rdpUsername}@${host.hostname}:${host.port}`
          : host
            ? formatHostTarget(host)
            : null,
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
        label: t('titleBar.hover.reconnect'),
        value: group.reconnect.waitingForNetwork
          ? t('titleBar.hover.waitingNetwork')
          : t('titleBar.hover.attempts', {
              attempt: group.reconnect.attempt,
              max: group.reconnect.maxAttempts,
            }),
        valueColor: TAB_DOT_COLOR.reconnecting,
      });
    }
    rows.push({
      label: t('titleBar.hover.windows'),
      value: t('titleBar.hover.windowCount', { count: item.windowCount }),
    });
    if (host) {
      const path = tailnetPath(host);
      if (path) {
        rows.push(tailnetPathRow(path));
      }
    }
    if (item.rttMs != null) {
      rows.push({ label: t('titleBar.hover.latency'), value: `${item.rttMs}ms`, valueColor: rttColor(item.rttMs) });
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
        label: t('titleBar.hover.pane', { index: index + 1 }),
        value: paneHost?.label ?? paneTab?.title ?? t('titleBar.kind.local'),
      });
    });
  }
  return {
    heading: t(item.isTmux ? 'titleBar.kind.splitTmux' : 'titleBar.kind.split'),
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
    return t('titleBar.update.checking');
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

  return new Intl.DateTimeFormat(getFormatLocale(), {
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
  onSetRdpMonitors,
  resolveRdpMonitors,
  activeWorkspaceTab,
  sessionPanelOpen,
  onToggleSessionPanel,
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
  onToggleFullScreenWindow,
  onCloseWindow
}: AppTitleBarProps) {
  const { t: translate } = useTranslation();
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

  // 전체화면에서는 타이틀바를 감추고 상단 가장자리에서만 부른다.
  const titleBar = useTitleBarAutoHide(
    titleBarMode(windowState.isFullScreen, desktopPlatform),
  );

  /**
   * 상단바의 빈 배경이 창 드래그 영역인지.
   *
   * 전체화면에서는 드래그 영역을 두지 않는다. 창을 옮길 수 없으므로 잃는 것이 없고, 대신 이 배경이
   * **더블클릭을 받을 수 있게** 된다 — `-webkit-app-region: drag` 영역은 OS 캡션으로 취급돼서
   * 더블클릭이 페이지까지 오지 않는다(그 자리에서 OS 가 최대화를 시도한다). 그래서 드래그를 켠 채로는
   * "빈 곳 더블클릭으로 전체화면 종료" 를 만들 수 없다.
   */
  const chromeDragRegion = windowState.isFullScreen
    ? '[-webkit-app-region:no-drag]'
    : '[-webkit-app-region:drag]';

  /**
   * 상단바 빈 곳 더블클릭 → 전체화면 종료.
   *
   * 전체화면에서 이 바는 상단 가장자리에 마우스를 올려야 내려온다. 그렇게 불러낸 바에서 나가는
   * 방법이 버튼 하나뿐이면, 그 버튼을 못 찾은 사용자는 F11 을 모르는 한 갇힌다. 창 모드에서 캡션
   * 더블클릭이 최대화인 것과 같은 자리, 같은 동작이라 배우지 않아도 짚인다.
   *
   * **헤더 한 곳에만 붙인다.** 배경을 이루는 요소마다 붙이면 버블링으로 같은 더블클릭이 여러 번
   * 들어와 전체화면이 나갔다 다시 들어온다(테스트에서 2회 호출로 잡혔다).
   */
  const handleChromeDoubleClick = useCallback(
    (event: { target: EventTarget | null }) => {
      if (!windowState.isFullScreen) {
        return;
      }
      // 조작 가능한 것 위에서만 비켜난다(거부 목록).
      //
      // 처음에는 반대로 했다 — "이벤트 대상이 이 배경 자신일 때만" 이라는 화이트리스트였는데, 그러면
      // 자식이 덮은 자리가 전부 빠져서 실제로 먹는 곳이 바 양 끝 몇 px 뿐이었다. 배경은 한 요소가
      // 아니라 헤더·탭 영역·스트립·여백이 겹쳐 만드는 면이라, 그것을 일일이 나열하는 방식은 새는
      // 곳이 계속 생긴다. 탭은 div 라서 button 검사만으로는 걸리지 않아 마커를 붙였다.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-titlebar-tab-item], button, a, input, select, textarea, [role="button"]',
        )
      ) {
        return;
      }
      void onToggleFullScreenWindow();
    },
    [onToggleFullScreenWindow, windowState.isFullScreen],
  );

  // 모니터 배치도를 띄운 RDP 세션. null 이면 닫혀 있다.
  const [monitorPicker, setMonitorPicker] = useState<string | null>(null);

  // RDP 탭 우클릭 메뉴. 지금은 항목이 하나뿐이라 전용 컴포넌트를 만들지 않았다.
  const [tabMenu, setTabMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);

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
              // RDP 탭에만 뜨는 메뉴가 있어 종류를 함께 싣는다.
              paneKind: tab.paneKind ?? 'terminal',
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

  // 세션 패널을 열 수 있는 대상. 세션 셸과 같은 계산을 써야 토글이 켜는 패널과 실제로 열리는
  // 패널의 대상이 갈리지 않는다. RDP·VNC 에는 히스토리도 스니펫도 성립하지 않아 제외한다.
  const sessionPanelSessionId = useMemo(() => {
    const focused = resolveFocusedPaneSessionId(
      activeWorkspaceTab,
      workspaces,
      tmuxGroups,
    );
    if (!focused) {
      return null;
    }
    const tab = tabs.find((item) => item.sessionId === focused);
    if (!tab || (tab.paneKind ?? 'terminal') !== 'terminal') {
      return null;
    }
    return focused;
  }, [activeWorkspaceTab, tabs, tmuxGroups, workspaces]);

  const showBadge = shouldShowBadge(updateState);
  const publishedAt = formatPublishedAt(updateState.release?.publishedAt);
  const releaseUrl = resolveReleaseUrl(updateState);
  const showInstallAction = updateState.status === 'downloaded';

  // Installing quits and relaunches the app, and the gap before the window goes
  // away reads as the click not having registered. Spin until then.
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);

  // The updater action reports failure by moving updateState to 'error' rather
  // than rejecting, so that — not the promise — is what un-sticks the button.
  // There is deliberately no reset on success: the app is on its way out, and
  // dropping the spinner first would just flash the idle button.
  useEffect(() => {
    if (updateState.status === 'error') {
      setIsInstallingUpdate(false);
    }
  }, [updateState.status]);

  const handleInstallUpdate = useCallback(() => {
    if (isInstallingUpdate) {
      return;
    }
    setIsInstallingUpdate(true);
    void onInstallUpdate();
  }, [isInstallingUpdate, onInstallUpdate]);
  const showCheckAction =
    updateState.enabled &&
    (updateState.status === 'idle' ||
      updateState.status === 'upToDate' ||
      updateState.status === 'error');
  const showDevDisabledAction = !updateState.enabled;
  const isAutoDownloading =
    updateState.status === 'available' || updateState.status === 'downloading';
  const titleText = showInstallAction
    ? translate('titleBar.update.readyTitle')
    : isAutoDownloading
      ? translate('titleBar.update.downloadingTitle')
      : translate('titleBar.update.title');
  const installTooltip = updateState.release?.version
    ? translate('titleBar.update.installTooltip', {
        version: `${updateState.release.version.startsWith('v') ? '' : 'v'}${updateState.release.version}`,
      })
    : translate('titleBar.update.installTooltipFallback');

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
  const tailnetPath = useTailnetPathLookup(tabs, tmuxGroups, hosts);
  const hoverInfo = hoveredItem
    ? buildTabHoverInfo(hoveredItem, tabs, hosts, tmuxGroups, workspaces, tailnetPath)
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
      onPointerEnter={titleBar.onPointerEnter}
      onPointerLeave={titleBar.onPointerLeave}
      onDoubleClick={handleChromeDoubleClick}
      className={cn(
        // 상단바 chrome 배경 전체를 창 드래그 영역으로 둔다(macOS·Windows 공통). 실제 탭/버튼처럼
        // 조작 가능한 요소만 no-drag 로 좁혀, 같은 배경처럼 보이는 빈 영역은 일관되게 창을 움직인다.
        'fixed inset-x-0 top-0 z-[7] flex min-h-[2.95rem] select-none items-stretch gap-4 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--chrome-bg)_94%,white_6%),color-mix(in_srgb,var(--chrome-bg)_98%,black_2%))] px-[0.9rem] pt-[0.42rem] pb-0 text-[#f3f7fb] max-[760px]:px-[0.9rem] max-[760px]:pr-[0.9rem]',
        chromeDragRegion,
        // 신호등 자리는 창 모드에서만 비워둔다. macOS 전체화면에서는 신호등이 OS 오버레이로
        // 올라가 우리 바에 없다 — 그대로 두면 왼쪽이 이유 없이 5.7rem 비어 보인다.
        desktopPlatform === 'darwin' &&
          !windowState.isFullScreen &&
          'pl-[5.7rem] max-[1040px]:pl-[5.1rem] max-[760px]:px-[5.1rem] max-[760px]:pr-[0.9rem]',
        // 전체화면에서는 위로 밀어 감춘다. display 대신 transform 을 쓰는 이유는 두 가지다:
        // 레이아웃을 유지해야 내려올 때 흔들리지 않고, 숨은 동안에도 포인터 진입을 받을 수 있다.
        'transition-transform duration-150',
        !titleBar.visible && '-translate-y-full',
      )}
    >
      {/* ① 좌측 드래그 존: macOS 신호등 영역(헤더 좌측 패딩). 스크롤 스트립과 겹치지 않는
          고정 rect 라 위치-의존 버그가 없다. 네이티브 신호등 클릭은 그대로, 빈 곳은 창 드래그. */}
      {desktopPlatform === 'darwin' && !windowState.isFullScreen ? (
        <div
          aria-hidden
          className={cn('absolute left-0 top-0 bottom-0 w-[5.7rem] max-[1040px]:w-[5.1rem]', chromeDragRegion)}
        />
      ) : null}
      <div
        data-testid="titlebar-tab-region"
        className={cn(
          'relative flex min-w-0 flex-1 self-stretch transition-[background-color,box-shadow] duration-140',
          !isTitlebarInternalDragActive
            ? chromeDragRegion
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
                ? chromeDragRegion
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
                    data-titlebar-tab-item="true"
                    className={cn(
                      'group relative flex flex-none items-center gap-1 self-center mb-[0.42rem] rounded-[10px] border pr-1.5 scroll-mx-2 transition-[box-shadow,background-color,border-color,transform] duration-150 [-webkit-app-region:no-drag]',
                      getTitlebarDynamicTabContainerClass(item.active),
                      isDragSource && tabDragSourceHidden && 'opacity-0',
                    )}
                    draggable
                onMouseEnter={(event) => showTabHover(targetKey, event.currentTarget)}
                onMouseLeave={() => hideTabHover(targetKey)}
                onContextMenu={(event) => {
                  // 지금은 RDP 세션에만 메뉴가 있다(모니터 펼치기). VNC 는 프레임버퍼가 하나라
                  // 그 메뉴가 성립하지 않는다. 다른 탭은 기본 동작을 막지 않는다.
                  if (item.paneKind !== 'rdp') {
                    return;
                  }
                  event.preventDefault();
                  hideTabHover(targetKey);
                  setTabMenu({
                    sessionId: item.sessionId,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
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
                  // 제목은 잘려서 보이고(truncate) 상태 점·지연 시간이 같은 버튼 안에 섞여 있다.
                  // 이름을 따로 주지 않으면 화면 낭독이 "● Prod 42ms" 처럼 읽고, 자동화도 이 탭을
                  // 특정할 수 없다(닫기 버튼에만 이름이 있었다).
                  aria-label={translate('titleBar.tab.selectSession', { title: item.title })}
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
                  aria-label={translate('titleBar.tab.closeSession', { title: item.title })}
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
                data-titlebar-tab-item="true"
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
                  aria-label={translate('titleBar.tab.detachTmux', { title: item.title })}
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
              data-titlebar-tab-item="true"
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
                  aria-label={translate('titleBar.tab.newTmuxWindow', { title: item.title })}
                  title={translate('titleBar.tab.newTmuxWindowTitle')}
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
                    ? translate('titleBar.tab.closeThisWindow', { title: item.title })
                    : translate('titleBar.tab.close', { title: item.title })
                }
                title={
                  item.isTmux
                    ? translate('titleBar.tab.closeThisWindowTooltip')
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
        className={cn('min-w-16 flex-none self-stretch', chromeDragRegion)}
      />
      <div className="relative flex items-center self-center mb-[0.42rem] gap-[0.55rem] [-webkit-app-region:no-drag]">
        {/* 아래 두 버튼(패널 토글·알림)은 같은 규칙을 쓴다: 평소엔 아이콘만, 켜져 있으면 채운
            칩. 예전에는 항상 옅은 배경이 깔려 있어 눌러도 달라진 티가 나지 않았다. */}
        {/* 세션 패널 토글. 셸이 있는 세션을 보고 있을 때만 뜬다 — RDP·VNC 나 홈에서는 열 것이
            없다. 패널은 이 버튼으로만 열린다(늘 붙어 있는 세로 줄을 두지 않는다). */}
        {sessionPanelSessionId ? (
          <IconButton
            tone="default"
            className={cn(CHROME_TOGGLE_CLASS, sessionPanelOpen && CHROME_TOGGLE_ON_CLASS)}
            aria-pressed={sessionPanelOpen}
            aria-label={translate('sessionPanel.toggle')}
            title={translate('sessionPanel.toggle')}
            onClick={onToggleSessionPanel}
          >
            <PanelRight className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />
          </IconButton>
        ) : null}
        <div className="relative [-webkit-app-region:no-drag]" ref={updateMenuRef}>
          {showInstallAction ? (
            <Tooltip label={installTooltip}>
              <Button
                variant="primary"
                size="sm"
                className="h-9 min-h-9 whitespace-nowrap rounded-[9px] px-3"
                aria-label={translate('titleBar.update.label')}
                aria-busy={isInstallingUpdate}
                disabled={isInstallingUpdate}
                onClick={handleInstallUpdate}
              >
                {isInstallingUpdate ? (
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="h-4 w-4" aria-hidden="true" />
                )}
                {isInstallingUpdate
                  ? translate('titleBar.update.installing')
                  : translate('titleBar.update.badge')}
              </Button>
            </Tooltip>
          ) : (
            <IconButton
              tone="default"
              className={cn(
                'relative',
                CHROME_TOGGLE_CLASS,
                isUpdateOpen && CHROME_TOGGLE_ON_CLASS,
              )}
              aria-pressed={isUpdateOpen}
              aria-label={translate('titleBar.update.viewStatus')}
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
                  <p>{translate('titleBar.update.devOnly')}</p>
                ) : null}

                {!updateState.release && getEmptyReleaseMessage(updateState) ? (
                  <p>{getEmptyReleaseMessage(updateState)}</p>
                ) : null}

                {updateState.status === 'upToDate' ? <p>{translate('titleBar.update.upToDate')}</p> : null}
                {updateState.status === 'available' ? (
                  <p>{translate('titleBar.update.available')}</p>
                ) : null}
                {updateState.status === 'downloading' ? (
                  <p>
                    {translate('titleBar.update.downloading', {
                      percent: formatProgressPercent(updateState),
                    })}
                  </p>
                ) : null}
                {updateState.status === 'downloaded' ? (
                  <p>{translate('titleBar.update.downloaded')}</p>
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
                    {translate(updateState.status === 'error' ? 'titleBar.update.retry' : 'titleBar.update.check')}
                  </Button>
                ) : null}
                {showDevDisabledAction ? (
                  <Button variant="secondary" disabled>
                    {translate('titleBar.update.devDisabled')}
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
          onToggleFullScreenWindow={onToggleFullScreenWindow}
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

      {monitorPicker ? (
        <RdpMonitorPicker
          selected={resolveRdpMonitors(monitorPicker)}
          onCancel={() => setMonitorPicker(null)}
          onApply={(monitors) => {
            const sessionId = monitorPicker;
            setMonitorPicker(null);
            onSetRdpMonitors(sessionId, monitors);
          }}
        />
      ) : null}

      {tabMenu ? (
        <>
          {/* 바깥을 누르면 닫는다. 메뉴보다 아래에 깔되 나머지 UI 는 덮는다. */}
          <div
            className="fixed inset-0 z-[60] [-webkit-app-region:no-drag]"
            onClick={() => setTabMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setTabMenu(null);
            }}
          />
          <div
            className="fixed z-[61] min-w-[13rem] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[0_14px_28px_rgba(0,0,0,0.22)] [-webkit-app-region:no-drag]"
            style={{ left: tabMenu.x, top: tabMenu.y }}
          >
            <button
              type="button"
              className="block w-full px-3 py-[0.4rem] text-left text-[0.82rem] text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)]"
              onClick={() => {
                const sessionId = tabMenu.sessionId;
                setTabMenu(null);
                setMonitorPicker(sessionId);
              }}
            >
              사용할 모니터…
              <span className="mt-[0.15rem] block text-[0.72rem] leading-[1.35] text-[var(--text-soft)]">
                호스트에 저장됩니다. 적용하면 다시 접속합니다.
              </span>
            </button>
          </div>
        </>
      ) : null}
    </header>
  );
}
