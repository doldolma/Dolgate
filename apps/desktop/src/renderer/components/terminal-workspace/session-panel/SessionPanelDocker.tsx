// 도커 섹션. 컨테이너·이미지·볼륨·네트워크를 보고, 그 자리에서 셸·로그·시작·정지까지 한다.
//
// 어디서 실행되나(이 섹션의 규칙):
//   · 목록·상세 — 보조 채널. 자원·프로세스 섹션과 같은 경로다.
//   · 셸·로그·시작·정지·재시작 — **지금 터미널에 넣고 실행한다.** 명령이 스크롤백에 남아
//     무엇을 했는지 되짚을 수 있고, 셸 접속은 그 자리에서 이어진다(exit 하면 원래 셸로 돌아온다).
//   · 삭제·prune·compose down — 넣기만 하고 엔터는 사람이 친다. 파괴적인 것에만 이 예외를 둔다.
//
// 스택은 탭이 아니라 컨테이너 목록의 그룹 머리다. 스택 단위 동작이 그 머리에 붙으면 한 자리에서
// 끝난다 — 스택 탭을 따로 두면 같은 데이터를 한 단계 더 들어가서 보게 된다.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/appStore';
import { filterByQuery } from '../../../lib/session-panel';
import { formatBytesPerSecond, formatKibibytes } from '../../../lib/host-metrics';
import { queryTerminalCompletion } from '../../../services/desktop/terminal';
import {
  buildContainerNetworksCommand,
  collectUsedImages,
  dockerImagePruneCommand,
  dockerImageRemoveCommand,
  dockerLogsCommand,
  dockerNetworkRemoveCommand,
  dockerRemoveCommand,
  dockerShellCommand,
  dockerStateCommand,
  dockerVolumePruneCommand,
  dockerVolumeRemoveCommand,
  isContainerRunning,
  isImageUsed,
  layoutContainers,
  parseContainerNetworks,
  parseDockerAge,
  resolveContainerPorts,
  stackComposeCommand,
  troubleOf,
  type DockerContainer,
  type DockerContainerNetwork,
  type DockerInspectInfo,
  type DockerPortEntry,
  type DockerStat,
  type DockerImage,
  type DockerNetwork,
  type DockerStack,
  type DockerVolume,
} from '../../../lib/docker';
import { Button, Tooltip } from '../../../ui';
import { ExternalLink, Star } from 'lucide-react';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  MoreVertical,
  Play,
  RefreshCw,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from '../../../ui/icons';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelSearch } from './SessionPanelSearch';
import {
  getDockerHistory,
  toggleStackCollapsed,
  useCollapsedStacks,
  queryPrefixOf,
  useDockerLists,
  type DockerIoRate,
  type DockerRuntime,
  type DockerTabId,
} from './useSessionDocker';
import { useSessionScopedState } from './useSessionScopedState';
import type { SessionPanelSender } from './useSessionPanelTarget';
import type { SessionContainerTunnel } from '../../../store/types';

interface SessionPanelDockerProps {
  sessionId: string;
  hostId: string | null;
  sender: SessionPanelSender;
  runtime: DockerRuntime;
}

const ACTION_CLASS =
  'grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)] disabled:opacity-35 disabled:hover:bg-transparent';

/** 펼친 화면 안의 작은 아이콘 버튼(이름 복사·삭제). */
const ACTION_TIGHT =
  'grid h-5 w-5 shrink-0 place-items-center rounded-[6px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)] disabled:opacity-35 disabled:hover:bg-transparent';

/** 이만큼보다 짧은 목록에는 검색줄을 그리지 않는다 — 여섯 줄을 검색할 일은 없다. */
const SEARCH_MIN_ROWS = 12;

/** 그룹 안 정지된 것이 이보다 많으면 접어 둔다. */
const STOPPED_FOLD_MIN = 3;

const TABS: DockerTabId[] = ['containers', 'images', 'volumes', 'networks'];

/** 셀렉터가 매번 새 배열을 만들지 않게 — 그러면 무한 리렌더가 된다. */
const EMPTY_TUNNELS: readonly SessionContainerTunnel[] = [];

export function SessionPanelDocker({
  sessionId,
  hostId,
  sender,
  runtime,
}: SessionPanelDockerProps) {
  const { t: translate } = useTranslation();
  const panelOpen = useAppStore((state) => state.sessionPanelOpen);
  // 보던 탭과 검색어는 세션마다 따로 기억한다 — 다른 서버로 옮기면 처음 상태로, 돌아오면
  // 보던 그대로.
  const [tab, setTab] = useSessionScopedState<DockerTabId>(sessionId, 'docker.tab', 'containers');
  const [query, setQuery] = useSessionScopedState(sessionId, 'docker.query', '');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // 펼쳐 둔 행과 펼쳐 본 정지 그룹도 **세션마다** 기억한다. 다른 탭을 보다 돌아왔는데 보던 것이
  // 접혀 있으면 다시 찾아 눌러야 한다 — 검색어·탭을 기억하는 것과 같은 이유다.
  const [expandedId, setExpandedId] = useSessionScopedState<string | null>(
    sessionId,
    'docker.expanded',
    null,
  );
  const [unfoldedStacks, setUnfoldedStacks] = useSessionScopedState<readonly string[]>(
    sessionId,
    'docker.unfoldedStacks',
    [],
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 이력·접힘은 호스트 단위로 기억한다 — 같은 서버의 다른 탭에서도 같은 모양으로 보인다.
  const collapseScope = hostId ?? `session:${sessionId}`;
  const lists = useDockerLists(
    sessionId,
    queryPrefixOf(runtime),
    runtime.elevate,
    tab,
    panelOpen,
    collapseScope,
  );
  /**
   * 터널이 향할 곳의 근거. **검사 결과에 이미 담겨 온다** — 그래서 대개 왕복이 없다. 방금 만든
   * 컨테이너의 공개 포트는 `ps` 가 검사보다 먼저 주므로, 그럴 때만 한 번 묻는다.
   *
   * 이 값을 우리가 실어 보내야 하는 이유: sudo 가 필요한 호스트에서 도커를 읽을 수 있는 것은
   * 이 세션(그 세션의 sudo)뿐이고, 코어의 컨테이너 연결은 같은 비밀번호를 갖고 있지 않다.
   */
  const resolveNetworks = useCallback(
    async (containerId: string): Promise<readonly DockerContainerNetwork[]> => {
      const known = lists.inspect.get(containerId)?.networks ?? [];
      if (known.length > 0) {
        return known;
      }
      const prefix = queryPrefixOf(runtime);
      if (!prefix) {
        return [];
      }
      try {
        return parseContainerNetworks(
          await queryTerminalCompletion(
            sessionId,
            buildContainerNetworksCommand(prefix, containerId),
            { background: true, elevate: runtime.elevate },
          ),
        );
      } catch {
        // 못 물어봤다 — 빈 값으로 넘긴다. 코어가 자기 방식으로 알아내 보고, 그마저 안 되면
        // 그 줄에 실패가 남는다(조용히 사라지지 않는다).
        return [];
      }
    },
    [lists.inspect, runtime, sessionId],
  );

  // 이 세션이 연 컨테이너 터널. 주인이 세션이라 세션이 끝나면 메인이 회수한다(여기서 치우지 않는다).
  const tunnels = useAppStore(
    (state) => state.sessionContainerTunnels[sessionId] ?? EMPTY_TUNNELS,
  );
  const openTunnel = useAppStore((state) => state.openSessionContainerTunnel);
  const closeTunnel = useAppStore((state) => state.closeSessionContainerTunnel);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);
  const collapsedStacks = useCollapsedStacks(collapseScope);

  /**
   * 탭을 옮기면 검색어와 열린 메뉴를 놓는다 — 다른 목록에 남아 있으면 빈 결과처럼 보인다.
   *
   * **세션을 옮긴 것은 탭 이동으로 세지 않는다.** 그때 탭이 바뀌는 것은 그 세션이 보던 자리로
   * 돌아가는 것이고, 함께 기억해 둔 검색어까지 지우면 "돌아오면 그대로" 가 깨진다. 대신 열려
   * 있던 메뉴는 직전 호스트의 컨테이너를 가리키므로 닫는다.
   */
  const lastViewRef = useRef({ sessionId, tab });
  useEffect(() => {
    const previous = lastViewRef.current;
    lastViewRef.current = { sessionId, tab };
    if (previous.sessionId !== sessionId) {
      setOpenMenu(null);
      return;
    }
    if (previous.tab === tab) {
      return;
    }
    setQuery('');
    setOpenMenu(null);
  }, [sessionId, tab, setQuery]);

  // 메뉴는 바깥을 누르면 닫힌다.
  useEffect(() => {
    if (openMenu === null) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const body = bodyRef.current;
      if (body && event.target instanceof Node && body.contains(event.target)) {
        return;
      }
      setOpenMenu(null);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [openMenu]);

  const prefix = runtime.prefix;
  const compose = runtime.compose;

  function runHere(command: string): void {
    sender.run(command);
    setOpenMenu(null);
  }

  function insertHere(command: string): void {
    sender.insert(command);
    setOpenMenu(null);
  }

  function copyText(value: string): void {
    sender.copy(value);
    setOpenMenu(null);
  }

  // 안 되는 호스트에서도 섹션은 그대로 있다 — 왜 안 되는지만 말한다(자원·프로세스와 같은 방식).
  if (!prefix) {
    const state =
      runtime.availability === 'checking'
        ? { title: 'sessionPanel.docker.checking', description: null }
        : runtime.availability === 'down'
          ? { title: 'sessionPanel.docker.downTitle', description: 'sessionPanel.docker.down' }
          : runtime.availability === 'blocked'
            ? // 여기까지 왔으면 우리가 할 수 있는 것은 다 해 봤다 — 소켓, `sudo -n`, 그리고
              // 접속 비밀번호로 sudo 되물리기까지. 무엇을 더 하라고 시킬 것이 없으니 한 줄로만
              // 말한다(예전에는 "터미널에서 sudo 를 한 번 쓰라" 고 안내했다).
              { title: 'sessionPanel.docker.blockedTitle', description: null }
            : { title: 'sessionPanel.docker.absentTitle', description: 'sessionPanel.docker.absent' };
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate(state.title)}
          description={state.description ? translate(state.description) : undefined}
        />
      </div>
    );
  }

  const counts: Record<DockerTabId, number | null> = {
    containers: lists.containers.length || null,
    images: lists.images.length || null,
    volumes: lists.volumes.length || null,
    networks: lists.networks.length || null,
  };

  const rowCount =
    tab === 'containers'
      ? lists.containers.length
      : tab === 'images'
        ? lists.images.length
        : tab === 'volumes'
          ? lists.volumes.length
          : lists.networks.length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-[0.15rem] px-2 pt-2">
        {TABS.map((entry) => {
          const on = entry === tab;
          const count = counts[entry];
          return (
            <button
              key={entry}
              type="button"
              aria-pressed={on}
              onClick={() => setTab(entry)}
              className={cn(
                'flex min-w-0 items-center gap-1 rounded-[8px] px-[0.42rem] py-[0.28rem] text-[0.7rem] transition-colors',
                on
                  ? 'bg-[var(--selection-tint)] font-semibold text-[var(--accent-strong)] shadow-[inset_0_0_0_1px_var(--selection-border)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]',
              )}
            >
              <span className="truncate">
                {translate(`sessionPanel.docker.tab.${entry}`)}
              </span>
              {count === null ? null : (
                <span
                  className={cn(
                    'shrink-0 text-[0.62rem] tabular-nums',
                    on ? 'text-[var(--accent-strong)]' : 'text-[var(--text-muted)]',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {tab === 'containers' && lists.summary.total > 0 ? (
        <div className="flex items-baseline gap-1.5 px-2.5 pt-1.5">
          <span className="min-w-0 flex-1 truncate text-[0.66rem] text-[var(--text-soft)]">
            {translate('sessionPanel.docker.summary.running', {
              running: lists.summary.running,
              total: lists.summary.total,
            })}
            {lists.summary.hasStats ? (
              <>
                {' · CPU '}
                <span className="font-medium tabular-nums text-[var(--text)]">
                  {lists.summary.cpuPercent.toFixed(0)}%
                </span>
                {' · MEM '}
                <span className="tabular-nums">
                  {formatKibibytes(Math.round(lists.summary.memBytes / 1024))}
                </span>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {rowCount >= SEARCH_MIN_ROWS ? (
        <SessionPanelSearch
          value={query}
          onChange={setQuery}
          placeholder={translate(`sessionPanel.docker.search.${tab}`)}
        />
      ) : null}
      {lists.failing ? <StaleBand updatedAtMs={lists.updatedAtMs} /> : null}
      {lists.truncated ? (
        <div className="mx-2.5 mb-1 rounded-[9px] bg-[color-mix(in_srgb,var(--warning-text)_12%,transparent)] px-2 py-[0.35rem] text-[0.66rem] leading-[1.4] text-[var(--warning-text)]">
          {translate('sessionPanel.docker.truncated')}
        </div>
      ) : null}
      <div
        ref={bodyRef}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-1.5 pb-2',
          rowCount >= SEARCH_MIN_ROWS ? null : 'pt-1.5',
          lists.failing ? 'opacity-55' : null,
        )}
      >
        {lists.loading ? (
          <Skeleton />
        ) : tab === 'containers' ? (
          <ContainersView
            containers={lists.containers}
            stats={lists.stats}
            ioRates={lists.ioRates}
            inspect={lists.inspect}
            scope={collapseScope}
            tunnels={tunnels}
            canForward={hostId !== null}
            onOpenPort={(container, port) =>
              void openTunnel({
                sessionId,
                hostId: hostId ?? '',
                containerId: container.id,
                containerName: container.name,
                networkName: '',
                targetPort: port.containerPort,
                // 어디로 연결할지는 **우리가 이미 안다**(검사 결과에 담겨 온다). 스토어가
                // "여는 중" 을 찍은 뒤에 이걸 부르므로, 아직 안 왔으면 한 번 물어야 하는
                // 경우에도 화면은 곧바로 반응한다.
                resolveNetworks: () => resolveNetworks(container.id),
              })
            }
            onClosePort={(tunnel) => void closeTunnel(sessionId, tunnel.ruleId)}
            onOpenBrowser={(tunnel) =>
              openExternalUrl(`http://127.0.0.1:${tunnel.bindPort}`)
            }
            query={query}
            prefix={prefix}
            atPrompt={sender.context.atPrompt}
            expandedId={expandedId}
            openMenu={openMenu}
            unfoldedStacks={unfoldedStacks}
            collapsedStacks={collapsedStacks}
            onToggleCollapse={(project) => toggleStackCollapsed(collapseScope, project)}
            onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
            onToggleMenu={(id) => setOpenMenu((current) => (current === id ? null : id))}
            onUnfoldStack={(key) =>
              setUnfoldedStacks(
                unfoldedStacks.includes(key) ? unfoldedStacks : [...unfoldedStacks, key],
              )
            }
            onShell={(container) => runHere(dockerShellCommand(prefix, container))}
            onLogs={(container) => runHere(dockerLogsCommand(prefix, container))}
            onState={(action, containers) =>
              runHere(dockerStateCommand(prefix, action, containers))
            }
            onRemove={(container) => insertHere(dockerRemoveCommand(prefix, container))}
            compose={compose}
            onCompose={(stack, args) =>
              compose && stack.workingDir
                ? insertHere(stackComposeCommand(compose, stack, args))
                : undefined
            }
            onStackLogs={(stack) =>
              compose && stack.workingDir
                ? runHere(stackComposeCommand(compose, stack, 'logs -f --tail 200'))
                : undefined
            }
            onCopy={copyText}
          />
        ) : tab === 'images' ? (
          <ImagesView
            images={lists.images}
            containers={lists.containers}
            query={query}
            openMenu={openMenu}
            onToggleMenu={(id) => setOpenMenu((current) => (current === id ? null : id))}
            onPrune={() => insertHere(dockerImagePruneCommand(prefix))}
            onRemove={(image) => insertHere(dockerImageRemoveCommand(prefix, image))}
            onCopy={copyText}
          />
        ) : tab === 'volumes' ? (
          <VolumesView
            volumes={lists.volumes}
            query={query}
            openMenu={openMenu}
            onToggleMenu={(id) => setOpenMenu((current) => (current === id ? null : id))}
            onPrune={() => insertHere(dockerVolumePruneCommand(prefix))}
            onRemove={(volume) => insertHere(dockerVolumeRemoveCommand(prefix, volume))}
            onCopy={copyText}
          />
        ) : (
          <NetworksView
            networks={lists.networks}
            query={query}
            openMenu={openMenu}
            onToggleMenu={(id) => setOpenMenu((current) => (current === id ? null : id))}
            onRemove={(network) => insertHere(dockerNetworkRemoveCommand(prefix, network))}
            onCopy={copyText}
          />
        )}
      </div>
    </div>
  );
}

/** 받아오기가 실패했을 때. 누를 것은 없다 — 알아서 물러나며 다시 받는다. */
function StaleBand({ updatedAtMs }: { updatedAtMs: number | null }) {
  const { t: translate } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds =
    updatedAtMs === null ? null : Math.max(0, Math.round((now - updatedAtMs) / 1000));
  const text =
    seconds === null
      ? translate('sessionPanel.docker.retrying')
      : seconds < 60
        ? translate('sessionPanel.docker.staleSeconds', { count: seconds })
        : translate('sessionPanel.docker.staleMinutes', { count: Math.round(seconds / 60) });
  return (
    <div className="mx-2.5 mb-1 flex items-center gap-1.5 rounded-[9px] bg-[var(--danger-bg)] px-2 py-[0.35rem]">
      <RefreshCw
        className="h-3 w-3 shrink-0 animate-spin text-[var(--danger-text)]"
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-[0.66rem] leading-[1.4] text-[var(--danger-text)]">
        {text}
      </span>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse" aria-hidden>
      {[0, 1, 2].map((group) => (
        <div key={group} className="mb-1.5">
          <div className="mx-2 mb-1.5 h-[0.6rem] w-[6.5rem] rounded-[4px] bg-[var(--surface-muted)]" />
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="ml-[1.05rem] mb-1 h-[1.35rem] rounded-[9px] bg-[var(--surface-muted)]"
              style={{ width: `${86 - row * 9}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

interface MenuItemSpec {
  key: string;
  label: string;
  icon: React.ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

function RowMenu({ items }: { items: MenuItemSpec[] }) {
  return (
    <div
      role="menu"
      className="absolute right-1 top-[1.75rem] z-10 grid w-[10.6rem] gap-[0.1rem] rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] p-1 shadow-[var(--shadow-soft)]"
    >
      {items.map((item) => (
        <Button
          key={item.key}
          role="menuitem"
          variant="ghost"
          size="sm"
          disabled={item.disabled}
          onClick={item.onSelect}
          className={cn(
            'min-h-0 justify-start gap-2 rounded-[7px] px-2 py-[0.32rem] text-[0.74rem] font-normal',
            item.danger ? 'text-[var(--danger-text)]' : 'text-[var(--text)]',
          )}
        >
          {item.icon}
          <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
          {item.hint ? (
            <span className="shrink-0 text-[0.6rem] text-[var(--text-muted)]">{item.hint}</span>
          ) : null}
        </Button>
      ))}
    </div>
  );
}

function MoreButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(ACTION_CLASS, 'w-[1.15rem]')}
    >
      <MoreVertical className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

/* ─── 컨테이너 ─────────────────────────────────────────────────────────── */

interface ContainersViewProps {
  containers: readonly DockerContainer[];
  stats: Map<string, DockerStat>;
  ioRates: Map<string, DockerIoRate>;
  inspect: Map<string, DockerInspectInfo>;
  /** 이력을 담는 단위(호스트, 없으면 세션). */
  scope: string;
  /** 이 세션이 연 컨테이너 터널. */
  tunnels: readonly SessionContainerTunnel[];
  /** 포워딩을 걸 호스트가 있는가(로컬 터미널에는 없다). */
  canForward: boolean;
  onOpenPort: (container: DockerContainer, port: DockerPortEntry) => void;
  onClosePort: (tunnel: SessionContainerTunnel) => void;
  onOpenBrowser: (tunnel: SessionContainerTunnel) => void;
  query: string;
  prefix: string;
  atPrompt: boolean;
  expandedId: string | null;
  openMenu: string | null;
  unfoldedStacks: readonly string[];
  /** compose 를 부르는 방법. 없으면 compose 가 필요한 항목을 만들지 않는다. */
  compose: string | null;
  /** 접어 둔 스택 이름들. */
  collapsedStacks: ReadonlySet<string>;
  onToggleCollapse: (project: string) => void;
  onToggleExpand: (id: string) => void;
  onToggleMenu: (id: string) => void;
  onUnfoldStack: (key: string) => void;
  onShell: (container: DockerContainer) => void;
  onLogs: (container: DockerContainer) => void;
  onState: (
    action: 'start' | 'stop' | 'restart',
    containers: readonly DockerContainer[],
  ) => void;
  onRemove: (container: DockerContainer) => void;
  onCompose: (stack: DockerStack, args: string) => void;
  onStackLogs: (stack: DockerStack) => void;
  onCopy: (value: string) => void;
}

function ContainersView(props: ContainersViewProps) {
  const { t: translate } = useTranslation();
  const layout = useMemo(() => {
    const filtered = filterByQuery(
      props.containers,
      props.query,
      (container) =>
        `${container.name} ${container.image} ${container.project ?? ''} ${container.service ?? ''}`,
    );
    return layoutContainers(filtered);
  }, [props.containers, props.query]);

  if (props.containers.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.emptyContainers')} />;
  }
  if (layout.stacks.length === 0 && layout.loose.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.noMatches')} />;
  }

  function renderRow(container: DockerContainer, indented: boolean) {
    return (
      <ContainerRow
        key={container.id}
        container={container}
        stat={props.stats.get(container.id)}
        ioRate={props.ioRates.get(container.id)}
        info={props.inspect.get(container.id)}
        samples={getDockerHistory(props.scope, container.id)}
        tunnels={props.tunnels.filter((tunnel) => tunnel.containerId === container.id)}
        canForward={props.canForward}
        onOpenPort={(port) => props.onOpenPort(container, port)}
        onClosePort={props.onClosePort}
        onOpenBrowser={props.onOpenBrowser}
        // 묶인 줄은 머리가 프로젝트를 말하므로 서비스 이름만, 혼자인 줄은 제 이름을 쓴다.
        label={indented ? (container.service ?? container.name) : container.name}
        indented={indented}
        expanded={props.expandedId === container.id}
        atPrompt={props.atPrompt}
        onToggleExpand={() => props.onToggleExpand(container.id)}
        onShell={() => props.onShell(container)}
        onLogs={() => props.onLogs(container)}
        onState={(action) => props.onState(action, [container])}
        onRemove={() => props.onRemove(container)}
        onCopy={props.onCopy}
      />
    );
  }

  return (
    <>
      {layout.stacks.map((stack) => {
        const key = stack.project ?? '';
        const collapsed = props.collapsedStacks.has(key);
        const running = stack.containers.filter(isContainerRunning);
        const stopped = stack.containers.filter((container) => !isContainerRunning(container));
        const folded =
          stopped.length > STOPPED_FOLD_MIN && !props.unfoldedStacks.includes(key);
        const shown = folded ? running : stack.containers;
        const menuId = `stack:${key}`;
        return (
          <div key={key} className="relative mb-0.5">
            <div className="flex items-center gap-1 px-2 py-[0.3rem]">
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() => props.onToggleCollapse(key)}
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
              >
                {collapsed ? (
                  <ChevronRight
                    className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
                    aria-hidden
                  />
                ) : (
                  <ChevronDown
                    className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-[0.72rem] font-semibold text-[var(--text)]">
                  {stack.project}
                </span>
                <span className="shrink-0 text-[0.62rem] tabular-nums text-[var(--text-muted)]">
                  {stack.runningCount}/{stack.containers.length}
                </span>
              </button>
              <button
                type="button"
                aria-label={`${translate('sessionPanel.docker.more')} ${stack.project}`}
                onClick={() => props.onToggleMenu(menuId)}
                className={cn(ACTION_CLASS, 'h-[1.2rem] w-[1.2rem]')}
              >
                <MoreVertical className="h-3 w-3" aria-hidden />
              </button>
            </div>
            {props.openMenu === menuId ? (
              <RowMenu
                items={[
                  {
                    key: 'restart',
                    label: translate('sessionPanel.docker.stack.restart'),
                    icon: <RefreshCw className="h-3.5 w-3.5" aria-hidden />,
                    disabled: !props.atPrompt,
                    onSelect: () => props.onState('restart', stack.containers),
                  },
                  {
                    key: 'stop',
                    label: translate('sessionPanel.docker.stack.stop'),
                    icon: <Square className="h-3.5 w-3.5" aria-hidden />,
                    disabled: !props.atPrompt || running.length === 0,
                    onSelect: () => props.onState('stop', running),
                  },
                  ...(stack.workingDir && props.compose
                    ? [
                        {
                          key: 'logs',
                          label: translate('sessionPanel.docker.stack.logs'),
                          icon: <ClipboardList className="h-3.5 w-3.5" aria-hidden />,
                          disabled: !props.atPrompt,
                          onSelect: () => props.onStackLogs(stack),
                        },
                        {
                          key: 'path',
                          label: translate('sessionPanel.docker.stack.copyPath'),
                          icon: <Copy className="h-3.5 w-3.5" aria-hidden />,
                          onSelect: () => props.onCopy(stack.workingDir ?? ''),
                        },
                        {
                          key: 'down',
                          label: translate('sessionPanel.docker.stack.down'),
                          icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />,
                          hint: translate('sessionPanel.docker.hint.insertOnly'),
                          danger: true,
                          disabled: !props.atPrompt,
                          onSelect: () => props.onCompose(stack, 'down'),
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
            {collapsed ? null : shown.map((container) => renderRow(container, true))}
            {!collapsed && folded ? (
              <button
                type="button"
                onClick={() => props.onUnfoldStack(key)}
                className="ml-[1.05rem] flex items-center gap-1.5 rounded-[9px] px-2 py-[0.3rem] text-[0.68rem] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
              >
                <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                {translate('sessionPanel.docker.stoppedCount', { count: stopped.length })}
              </button>
            ) : null}
          </div>
        );
      })}
      {/* 혼자인 것들. 머리를 달지 않는다 — 들여쓰기 차이로 이미 갈린다. */}
      {layout.loose.length > 0 ? (
        <div className={layout.stacks.length > 0 ? 'mt-1' : undefined}>
          {layout.loose.map((container) => renderRow(container, false))}
        </div>
      ) : null}
    </>
  );
}

/** 행의 10분 추이. 지금 값만으로는 "치솟았다" 를 못 본다. */
/**
 * 행마다 하나씩, 최대 200개가 붙는다. 값이 안 바뀌었으면 다시 그리지 않는다 — 메뉴를 열거나
 * 검색어를 치는 것만으로 200개의 선을 다시 계산할 이유가 없다.
 *
 * `samples` 는 이력이 쌓일 때마다 **새 배열**로 온다(useSessionDocker 의 pushHistory). 그래서
 * 얕은 비교만으로 "달라졌나" 가 정확히 판정된다 — 예전에는 같은 배열을 제자리에서 고치고
 * `historyVersion` 을 올려 섹션 전체를 다시 그렸다.
 */
const Sparkline = memo(function Sparkline({
  samples,
  tone,
}: {
  samples: readonly { cpuPercent: number }[];
  tone: string;
}) {
  if (samples.length < 2) {
    // 자리는 늘 잡아 둔다 — 표본이 쌓이며 열이 흔들리지 않게.
    return <span className="h-[14px] w-[38px] shrink-0" aria-hidden />;
  }
  const max = Math.max(...samples.map((sample) => sample.cpuPercent), 1);
  const points = samples
    .map((sample, index) => {
      const x = (index / (samples.length - 1)) * 38;
      const y = 13 - (sample.cpuPercent / max) * 11;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width="38" height="14" viewBox="0 0 38 14" className="shrink-0" aria-hidden>
      <polyline points={points} fill="none" stroke={tone} strokeWidth="1.2" />
    </svg>
  );
});

/** 이만큼 다시 뜬 컨테이너는 행에서 바로 말해 준다(지금 돌고 있어도). */
const RESTART_FLAP_MIN = 3;

const CPU_WARN_PERCENT = 20;
const CPU_DANGER_PERCENT = 50;

function cpuToneClass(percent: number): string {
  if (percent >= CPU_DANGER_PERCENT) {
    return 'text-[var(--danger-text)]';
  }
  if (percent >= CPU_WARN_PERCENT) {
    return 'text-[var(--warning-text)]';
  }
  return 'text-[var(--text-soft)]';
}

function ContainerRow({
  container,
  stat,
  ioRate,
  info,
  samples,
  tunnels,
  label,
  indented,
  expanded,
  atPrompt,
  onToggleExpand,
  onShell,
  onLogs,
  onState,
  onRemove,
  onCopy,
  onOpenPort,
  onClosePort,
  onOpenBrowser,
  canForward,
}: {
  container: DockerContainer;
  stat: DockerStat | undefined;
  ioRate: DockerIoRate | undefined;
  info: DockerInspectInfo | undefined;
  samples: readonly { cpuPercent: number }[];
  /** 이 컨테이너로 열려 있는 임시 터널들. */
  tunnels: readonly SessionContainerTunnel[];
  label: string;
  indented: boolean;
  expanded: boolean;
  atPrompt: boolean;
  onToggleExpand: () => void;
  onShell: () => void;
  onLogs: () => void;
  onState: (action: 'start' | 'stop' | 'restart') => void;
  onRemove: () => void;
  onCopy: (value: string) => void;
  onOpenPort: (port: DockerPortEntry) => void;
  onClosePort: (tunnel: SessionContainerTunnel) => void;
  onOpenBrowser: (tunnel: SessionContainerTunnel) => void;
  /** 포워딩을 걸 호스트가 있는가. 로컬 터미널에는 없다 — 그때는 열 수 없다. */
  canForward: boolean;
}) {
  const { t: translate } = useTranslation();
  const running = isContainerRunning(container);
  const ports = resolveContainerPorts(container, info);
  const openTunnel = tunnels.find((tunnel) => tunnel.status === 'running') ?? null;
  const publishedPorts = ports.entries
    .filter((port) => port.publishedPort !== null)
    .map((port) => port.publishedPort as number);
  const age = parseDockerAge(container.status);
  const trouble = troubleOf(container, info);
  const flapping = (info?.restartCount ?? 0) >= RESTART_FLAP_MIN;
  const cpu = stat?.cpuPercent ?? null;
  const dotColor = !running
    ? 'var(--text-muted)'
    : trouble
      ? 'var(--danger-text)'
      : 'var(--success-text)';

  return (
    <div className={cn('group relative', running ? null : 'opacity-55')}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleExpand}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-[9px] px-2 py-[0.28rem] text-left transition-colors',
          indented ? 'ml-[1.05rem] w-[calc(100%-1.05rem)]' : null,
          expanded ? 'bg-[var(--surface-muted)]' : 'hover:bg-[var(--surface-muted)]',
        )}
      >
        <span
          className="h-[6px] w-[6px] shrink-0 rounded-full"
          style={{ background: dotColor }}
          aria-hidden
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-[0.78rem]',
            running ? 'text-[var(--text)]' : 'text-[var(--text-soft)]',
          )}
        >
          {label}
        </span>
        {trouble ? (
          <span className="shrink-0 rounded-[5px] bg-[color-mix(in_srgb,var(--danger-text)_14%,transparent)] px-[0.28rem] text-[0.58rem] font-medium text-[var(--danger-text)]">
            {translate(`sessionPanel.docker.trouble.${trouble}`)}
          </span>
        ) : flapping ? (
          // 지금은 돌고 있어도 여러 번 죽었다 다시 떴다는 것은 봐야 하는 신호다.
          <span className="shrink-0 rounded-[5px] bg-[color-mix(in_srgb,var(--warning-text)_14%,transparent)] px-[0.28rem] text-[0.58rem] font-medium text-[var(--warning-text)]">
            {translate('sessionPanel.docker.trouble.restartCount', {
              count: info?.restartCount ?? 0,
            })}
          </span>
        ) : null}
        {/* 포워딩이 열려 있으면 펼치지 않아도 보인다. 여러 개면 첫 포트와 개수만. */}
        {openTunnel ? (
          <span className="shrink-0 rounded-[5px] bg-[var(--accent-surface)] px-[0.3rem] text-[0.6rem] font-medium tabular-nums text-[var(--accent-strong)]">
            {`:${openTunnel.bindPort}${tunnels.length > 1 ? `+${tunnels.length - 1}` : ''}`}
          </span>
        ) : null}
        {running && cpu !== null ? (
          <>
            <Sparkline
              samples={samples}
              tone={
                cpu >= CPU_DANGER_PERCENT ? 'var(--danger-text)' : 'var(--accent-strong)'
              }
            />
            <span
              className={cn(
                'w-[2.6rem] shrink-0 text-right text-[0.66rem] font-medium tabular-nums',
                cpuToneClass(cpu),
              )}
            >
              {cpu.toFixed(1)}%
            </span>
            <span className="w-[3.4rem] shrink-0 text-right text-[0.62rem] tabular-nums text-[var(--text-muted)]">
              {formatKibibytes(Math.round((stat?.memBytes ?? 0) / 1024))}
            </span>
          </>
        ) : (
          <>
            {publishedPorts.length > 0 ? (
              <span className="shrink-0 text-[0.62rem] tabular-nums text-[var(--text-soft)]">
                {`:${publishedPorts[0]}${
                  publishedPorts.length > 1 ? `+${publishedPorts.length - 1}` : ''
                }`}
              </span>
            ) : null}
            {age ? (
              <span className="shrink-0 text-[0.62rem] tabular-nums text-[var(--text-muted)]">
                {translate(`sessionPanel.docker.age.${age.unit}`, { count: age.count })}
              </span>
            ) : null}
          </>
        )}
      </button>
      {/* 자주 쓰는 둘(셸·로그)은 마우스를 올렸을 때만 행 위에 **겹쳐** 나온다. 버튼 안에 버튼을
          넣으면 유효하지 않은 HTML 이고 접근성 트리에서 안쪽이 사라진다. 숫자를 가려도 되는
          이유: 값을 읽는 중이라면 마우스가 그 행에 있지 않다. */}
      <span
        className={cn(
          'absolute right-1 top-[0.2rem] hidden items-center gap-[0.1rem] rounded-[7px] bg-[var(--surface-muted)] pl-1.5 group-hover:flex',
        )}
      >
        <button
          type="button"
          aria-label={`${translate('sessionPanel.docker.shell')} ${label}`}
          disabled={!running || !atPrompt}
          onClick={onShell}
          className={ACTION_TIGHT}
        >
          <SquareTerminal className="h-3 w-3" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`${translate('sessionPanel.docker.logs')} ${label}`}
          disabled={!atPrompt}
          onClick={onLogs}
          className={ACTION_TIGHT}
        >
          <ClipboardList className="h-3 w-3" aria-hidden />
        </button>
      </span>
      {expanded ? (
        <div
          className={cn(
            'mb-1 rounded-b-[9px] bg-[var(--surface-muted)] px-2 pb-1.5 pt-1',
            indented ? 'ml-[1.05rem]' : null,
          )}
        >
          <dl className="grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-[0.15rem] text-[0.7rem]">
            <DetailRow
              label={translate('sessionPanel.docker.detail.image')}
              value={container.image}
            />
            {ports.entries.length > 0 ? (
              <div className="col-span-2 grid grid-cols-subgrid">
                <dt className="truncate text-[var(--text-muted)]">
                  {translate('sessionPanel.docker.detail.ports')}
                </dt>
                <dd className="min-w-0">
                  <PortLines
                    ports={ports.entries}
                    omitted={ports.omitted}
                    tunnels={tunnels}
                    running={running}
                    canForward={canForward}
                    onOpen={onOpenPort}
                    onClose={onClosePort}
                    onOpenBrowser={onOpenBrowser}
                    onCopy={onCopy}
                  />
                </dd>
              </div>
            ) : null}
            <DetailRow
              label={translate('sessionPanel.docker.detail.status')}
              value={
                info?.restartCount
                  ? `${container.status} · ${translate('sessionPanel.docker.trouble.restartCount', { count: info.restartCount })}`
                  : container.status
              }
            />
            {stat ? (
              <DetailRow
                label={translate('sessionPanel.docker.detail.io')}
                value={
                  ioRate
                    ? `↓${formatBytesPerSecond(ioRate.netIn)} ↑${formatBytesPerSecond(ioRate.netOut)} · ${translate('sessionPanel.docker.detail.disk')} ${formatBytesPerSecond(ioRate.blockRead)}/${formatBytesPerSecond(ioRate.blockWrite)} · ${stat.pids}p`
                    : translate('sessionPanel.docker.detail.ioWaiting')
                }
                title={`${translate('sessionPanel.docker.detail.ioTotal')} ↓${stat.netIn} ↑${stat.netOut} · ${translate('sessionPanel.docker.detail.disk')} ${stat.blockRead}/${stat.blockWrite}`}
              />
            ) : null}
            <DetailRow
              label={translate('sessionPanel.docker.detail.name')}
              value={container.name}
            />
            {container.project ? (
              <DetailRow
                label={translate('sessionPanel.docker.detail.stack')}
                value={
                  container.service
                    ? `${container.project} / ${container.service}`
                    : container.project
                }
              />
            ) : null}
          </dl>
          {/* 제어는 여기 모은다 — 행에는 숫자를 놓고, 누르는 것은 펼친 화면에서. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <DetailAction
              icon={<SquareTerminal className="h-3.5 w-3.5" aria-hidden />}
              label={translate('sessionPanel.docker.shell')}
              accent
              disabled={!running || !atPrompt}
              onClick={onShell}
            />
            <DetailAction
              icon={<ClipboardList className="h-3.5 w-3.5" aria-hidden />}
              label={translate('sessionPanel.docker.logs')}
              disabled={!atPrompt}
              onClick={onLogs}
            />
            {running ? (
              <>
                <DetailAction
                  icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                  label={translate('sessionPanel.docker.action.restart')}
                  disabled={!atPrompt}
                  onClick={() => onState('restart')}
                />
                <DetailAction
                  icon={<Square className="h-3.5 w-3.5" aria-hidden />}
                  label={translate('sessionPanel.docker.action.stop')}
                  disabled={!atPrompt}
                  onClick={() => onState('stop')}
                />
              </>
            ) : (
              <DetailAction
                icon={<Play className="h-3.5 w-3.5" aria-hidden />}
                label={translate('sessionPanel.docker.action.start')}
                disabled={!atPrompt}
                onClick={() => onState('start')}
              />
            )}
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label={`${translate('sessionPanel.docker.action.copyName')} ${label}`}
                onClick={() => onCopy(container.name)}
                className={ACTION_TIGHT}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`${translate('sessionPanel.docker.action.remove')} ${label}`}
                title={translate('sessionPanel.docker.hint.insertOnly')}
                disabled={!atPrompt}
                onClick={onRemove}
                className={cn(ACTION_TIGHT, 'hover:text-[var(--danger-text)]')}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 상세의 포트 줄. 포트마다 한 줄이고, 오른쪽이 그 포트의 상태다.
 *
 * 여는 것은 **임시 터널**이다 — 주인이 이 세션이라 세션이 끝나면 메인이 회수한다. 로컬 포트는
 * 코어가 빈 것을 잡아 알려 준다(사용자가 포트를 고르지 않는다).
 */
function PortLines({
  ports,
  omitted,
  tunnels,
  running,
  canForward,
  onOpen,
  onClose,
  onOpenBrowser,
  onCopy,
}: {
  ports: readonly DockerPortEntry[];
  /** 상한 때문에 빼놓은 포트 수. 조용히 자르지 않고 그렇게 말한다. */
  omitted: number;
  tunnels: readonly SessionContainerTunnel[];
  running: boolean;
  canForward: boolean;
  onOpen: (port: DockerPortEntry) => void;
  onClose: (tunnel: SessionContainerTunnel) => void;
  onOpenBrowser: (tunnel: SessionContainerTunnel) => void;
  onCopy: (value: string) => void;
}) {
  const { t: translate } = useTranslation();
  return (
    <div className="flex flex-col gap-[0.15rem]">
      {ports.map((port) => {
        const tunnel =
          tunnels.find((entry) => entry.targetPort === port.containerPort) ?? null;
        const address = tunnel ? `127.0.0.1:${tunnel.bindPort}` : '';
        return (
          <div key={`${port.containerPort}/${port.protocol}`} className="flex items-center gap-1">
            {/* 동작은 포트 **바로 옆**에 둔다 — 오른쪽 끝으로 밀면 어느 포트의 버튼인지 눈이
                한 번 더 오간다. 남는 자리는 뒤에 둔다. */}
            <span className="shrink truncate font-mono text-[var(--text-soft)]">
              {port.publishedPort
                ? `${port.publishedPort} → ${port.containerPort}/${port.protocol}`
                : `${port.containerPort}/${port.protocol}`}
              {port.publishedPort ? null : (
                <span className="text-[0.6rem] text-[var(--text-muted)]">
                  {' '}
                  {translate('sessionPanel.docker.port.private')}
                </span>
              )}
            </span>
            {tunnel === null ? (
              <button
                type="button"
                disabled={!running || !canForward}
                onClick={() => onOpen(port)}
                title={translate('sessionPanel.docker.port.openHint')}
                className="flex shrink-0 items-center gap-1 rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-1.5 py-[0.12rem] text-[0.68rem] font-medium text-[var(--accent-strong)] transition-colors hover:border-[var(--selection-border)] hover:bg-[var(--selection-tint)] disabled:opacity-35 disabled:hover:border-[var(--border)] disabled:hover:bg-[var(--surface)]"
              >
                <ArrowLeftRight className="h-3 w-3" aria-hidden />
                {translate('sessionPanel.docker.port.open')}
              </button>
            ) : tunnel.status === 'starting' ? (
              <span className="flex shrink-0 items-center gap-1 px-1.5 text-[0.68rem] text-[var(--text-muted)]">
                <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
                {translate('sessionPanel.docker.port.opening')}
              </span>
            ) : tunnel.status === 'error' ? (
              <button
                type="button"
                onClick={() => onOpen(port)}
                title={tunnel.message}
                className="shrink-0 rounded-[7px] border border-[color-mix(in_srgb,var(--danger-text)_30%,var(--border))] bg-[var(--danger-bg)] px-1.5 py-[0.12rem] text-[0.68rem] font-medium text-[var(--danger-text)]"
              >
                {translate('sessionPanel.docker.port.failed')}
              </button>
            ) : (
              <span className="flex shrink-0 items-center gap-[0.1rem]">
                {/* 주소를 누르면 **브라우저로 연다** — 열어 본 뒤에 하는 일이 대개 그것이다.
                    주소 글자만 필요하면 옆의 복사를 쓴다. */}
                <button
                  type="button"
                  aria-label={translate('sessionPanel.docker.port.browser')}
                  title={translate('sessionPanel.docker.port.browser')}
                  onClick={() => onOpenBrowser(tunnel)}
                  className="flex items-center gap-1 rounded-[7px] border border-[var(--selection-border)] bg-[var(--selection-tint)] px-[0.35rem] py-[0.08rem] text-[0.66rem] font-medium tabular-nums text-[var(--accent-strong)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-strong)_16%,transparent)]"
                >
                  {address}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={translate('sessionPanel.docker.port.copy')}
                  title={translate('sessionPanel.docker.port.copy')}
                  onClick={() => onCopy(address)}
                  className={ACTION_TIGHT}
                >
                  <Copy className="h-3 w-3" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={translate('sessionPanel.docker.port.close')}
                  onClick={() => onClose(tunnel)}
                  className={ACTION_TIGHT}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            )}
            <span className="min-w-0 flex-1" />
          </div>
        );
      })}
      {omitted > 0 ? (
        <p className="text-[0.62rem] text-[var(--text-muted)]">
          {translate('sessionPanel.docker.port.omitted', { count: omitted })}
        </p>
      ) : null}
    </div>
  );
}

/** 펼친 화면의 제어 버튼. 글자를 붙여 무엇인지 읽히게 한다. */
function DetailAction({
  icon,
  label,
  accent,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-[7px] px-1.5 py-[0.18rem] text-[0.7rem] font-medium transition-colors disabled:opacity-35',
        accent
          ? 'text-[var(--accent-strong)] hover:bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent)]'
          : 'text-[var(--text-soft)] hover:bg-[var(--surface)] hover:text-[var(--text)]',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function DetailRow({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid">
      <dt className="truncate text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[var(--text-soft)]" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

/* ─── 이미지 · 볼륨 · 네트워크 ─────────────────────────────────────────── */

function SummaryRow({
  text,
  extra,
  trailing,
}: {
  text: string;
  extra?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-1 flex items-center gap-1.5 rounded-[9px] bg-[var(--surface-muted)] px-2 py-[0.35rem]">
      <span className="min-w-0 flex-1 truncate text-[0.68rem] text-[var(--text-soft)]">
        {text}
        {extra ? <span className="text-[var(--warning-text)]"> · {extra}</span> : null}
      </span>
      {trailing}
    </div>
  );
}

function ImagesView({
  images,
  containers,
  query,
  openMenu,
  onToggleMenu,
  onPrune,
  onRemove,
  onCopy,
}: {
  images: readonly DockerImage[];
  containers: readonly DockerContainer[];
  query: string;
  openMenu: string | null;
  onToggleMenu: (id: string) => void;
  onPrune: () => void;
  onRemove: (image: DockerImage) => void;
  onCopy: (value: string) => void;
}) {
  const { t: translate } = useTranslation();
  const used = useMemo(() => collectUsedImages(containers), [containers]);
  const rows = useMemo(
    () => filterByQuery(images, query, (image) => `${image.repository} ${image.tag}`),
    [images, query],
  );
  if (images.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.emptyImages')} />;
  }
  if (rows.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.noMatches')} />;
  }

  return (
    <>
      {/*
        개수만 센다. 디스크 총량·회수 가능량은 `docker system df` 라야 정확한데, 그건 레이어를
        전부 걷느라 이미지가 많은 호스트에서 수십 초가 걸리고 그동안 보조 채널을 혼자 물어
        컨테이너 목록까지 멈춰 세웠다. 크기는 줄마다 이미 보인다.
      */}
      <SummaryRow
        text={translate('sessionPanel.docker.images.summaryCounting', {
          count: images.length,
        })}
        trailing={
          <button
            type="button"
            aria-label={translate('sessionPanel.docker.images.prune')}
            onClick={onPrune}
            className={cn(ACTION_CLASS, 'w-[1.15rem]')}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        }
      />
      {rows.map((image) => {
        const menuId = `image:${image.id}:${image.tag}`;
        const tagged =
          image.tag && image.tag !== '<none>'
            ? `${image.repository}:${image.tag}`
            : image.repository;
        return (
          <div key={menuId} className="relative">
            <div className="flex items-center gap-1.5 rounded-[9px] px-2 py-[0.32rem] transition-colors hover:bg-[var(--surface-muted)]">
              <span className="min-w-0 flex-1 truncate font-mono text-[0.76rem] text-[var(--text)]">
                {image.repository}
                <span className="text-[var(--text-soft)]">
                  :{image.tag || '<none>'}
                </span>
              </span>
              {isImageUsed(image, used) ? null : (
                <span className="shrink-0 rounded-[5px] bg-[color-mix(in_srgb,var(--warning-text)_14%,transparent)] px-[0.3rem] py-[0.05rem] text-[0.58rem] font-medium text-[var(--warning-text)]">
                  {translate('sessionPanel.docker.unused')}
                </span>
              )}
              <span className="shrink-0 text-[0.62rem] tabular-nums text-[var(--text-muted)]">
                {image.size}
              </span>
              <MoreButton
                label={`${translate('sessionPanel.docker.more')} ${image.repository}`}
                onClick={() => onToggleMenu(menuId)}
              />
            </div>
            {openMenu === menuId ? (
              <RowMenu
                items={[
                  {
                    key: 'copy',
                    label: translate('sessionPanel.docker.action.copyImage'),
                    icon: <Copy className="h-3.5 w-3.5" aria-hidden />,
                    onSelect: () => onCopy(tagged),
                  },
                  {
                    key: 'remove',
                    label: translate('sessionPanel.docker.action.remove'),
                    icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />,
                    hint: translate('sessionPanel.docker.hint.insertOnly'),
                    danger: true,
                    onSelect: () => onRemove(image),
                  },
                ]}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function VolumesView({
  volumes,
  query,
  openMenu,
  onToggleMenu,
  onPrune,
  onRemove,
  onCopy,
}: {
  volumes: readonly DockerVolume[];
  query: string;
  openMenu: string | null;
  onToggleMenu: (id: string) => void;
  onPrune: () => void;
  onRemove: (volume: DockerVolume) => void;
  onCopy: (value: string) => void;
}) {
  const { t: translate } = useTranslation();
  const rows = useMemo(
    () => filterByQuery(volumes, query, (volume) => volume.name),
    [query, volumes],
  );

  if (volumes.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.emptyVolumes')} />;
  }
  if (rows.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.noMatches')} />;
  }

  return (
    <>
      <SummaryRow
        text={translate('sessionPanel.docker.volumes.summary', { count: volumes.length })}
        trailing={
          <button
            type="button"
            aria-label={translate('sessionPanel.docker.volumes.prune')}
            onClick={onPrune}
            className={cn(ACTION_CLASS, 'w-[1.15rem]')}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        }
      />
      {rows.map((volume) => {
        const menuId = `volume:${volume.name}`;
        return (
          <div key={menuId} className="relative">
            <div className="flex items-center gap-1.5 rounded-[9px] px-2 py-[0.32rem] transition-colors hover:bg-[var(--surface-muted)]">
              <span className="min-w-0 flex-1 truncate font-mono text-[0.76rem] text-[var(--text)]">
                {volume.name}
              </span>
              {volume.anonymous ? (
                <span className="shrink-0 text-[0.58rem] text-[var(--text-muted)]">
                  {translate('sessionPanel.docker.volumes.anonymous')}
                </span>
              ) : null}
              <span
                className={cn(
                  'shrink-0 text-[0.62rem] tabular-nums',
                  volume.usedBy === 0
                    ? 'text-[var(--warning-text)]'
                    : 'text-[var(--text-muted)]',
                )}
              >
                {translate('sessionPanel.docker.volumes.usedBy', { count: volume.usedBy })}
              </span>
              <MoreButton
                label={`${translate('sessionPanel.docker.more')} ${volume.name}`}
                onClick={() => onToggleMenu(menuId)}
              />
            </div>
            {openMenu === menuId ? (
              <RowMenu
                items={[
                  {
                    key: 'copy',
                    label: translate('sessionPanel.docker.action.copyName'),
                    icon: <Copy className="h-3.5 w-3.5" aria-hidden />,
                    onSelect: () => onCopy(volume.name),
                  },
                  {
                    key: 'remove',
                    label: translate('sessionPanel.docker.action.remove'),
                    icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />,
                    hint: translate('sessionPanel.docker.hint.insertOnly'),
                    danger: true,
                    onSelect: () => onRemove(volume),
                  },
                ]}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function NetworksView({
  networks,
  query,
  openMenu,
  onToggleMenu,
  onRemove,
  onCopy,
}: {
  networks: readonly DockerNetwork[];
  query: string;
  openMenu: string | null;
  onToggleMenu: (id: string) => void;
  onRemove: (network: DockerNetwork) => void;
  onCopy: (value: string) => void;
}) {
  const { t: translate } = useTranslation();
  const rows = useMemo(
    () => filterByQuery(networks, query, (network) => `${network.name} ${network.subnet ?? ''}`),
    [networks, query],
  );

  if (networks.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.emptyNetworks')} />;
  }
  if (rows.length === 0) {
    return <SessionPanelEmpty title={translate('sessionPanel.docker.noMatches')} />;
  }

  return (
    <>
      {rows.map((network) => {
        const menuId = `network:${network.name}`;
        return (
          <div key={menuId} className="relative">
            <div className="rounded-[9px] px-2 py-[0.3rem] transition-colors hover:bg-[var(--surface-muted)]">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.76rem] text-[var(--text)]">
                  {network.name}
                </span>
                <span className="shrink-0 text-[0.62rem] tabular-nums text-[var(--text-muted)]">
                  {translate('sessionPanel.docker.volumes.usedBy', {
                    count: network.containerCount,
                  })}
                </span>
                <MoreButton
                  label={`${translate('sessionPanel.docker.more')} ${network.name}`}
                  onClick={() => onToggleMenu(menuId)}
                />
              </div>
              <div className="flex items-center gap-1.5 pr-6 text-[0.62rem] text-[var(--text-muted)]">
                <span className="shrink-0">{network.driver}</span>
                <span className="min-w-0 truncate font-mono">{network.subnet ?? '—'}</span>
              </div>
            </div>
            {openMenu === menuId ? (
              <RowMenu
                items={[
                  {
                    key: 'copy',
                    label: translate('sessionPanel.docker.action.copyName'),
                    icon: <Copy className="h-3.5 w-3.5" aria-hidden />,
                    onSelect: () => onCopy(network.name),
                  },
                  {
                    key: 'remove',
                    label: translate('sessionPanel.docker.action.remove'),
                    icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />,
                    hint: translate('sessionPanel.docker.hint.insertOnly'),
                    danger: true,
                    onSelect: () => onRemove(network),
                  },
                ]}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
