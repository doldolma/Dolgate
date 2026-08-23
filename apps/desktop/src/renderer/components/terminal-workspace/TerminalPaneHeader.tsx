import type { ReactNode } from 'react';
import type { HostKind } from '@shared';
import { cn } from '../../lib/cn';
import { IconButton } from '../../ui';
import {
  Cable,
  Cloud,
  Container,
  Maximize2,
  Minimize2,
  Monitor,
  Radio,
  SquareArrowOutUpRight,
  SquareTerminal,
} from '../../ui/icons';
import { useTranslation } from 'react-i18next';

interface TerminalPaneHeaderProps {
  sessionId: string;
  title: string;
  active: boolean;
  draggingDisabled: boolean;
  closingDisabled: boolean;
  onFocus?: () => void;
  onClose?: () => void;
  onStartDrag?: () => void;
  onEndDrag?: () => void;
  /** 연결 종류 — 좌측 아이콘. 호스트를 못 찾는 세션(임시 연결 등)은 생략된다. */
  kind?: HostKind;
  /** `user@host:port` 같은 대상 표기. 좁아지면 가장 먼저 접힌다. */
  subtitle?: string;
  /** 이 pane 이 브로드캐스트에 참여 중인가. */
  broadcastActive?: boolean;
  /** 참여 pane 이 부족해 지금은 켤 수 없음(눌러도 아무 일이 없다는 것을 보여준다). */
  broadcastDisabled?: boolean;
  /** 브로드캐스트 토글. 없으면 아이콘 자체를 그리지 않는다(단일 pane·비워크스페이스). */
  onToggleBroadcast?: () => void;
  /** 이 pane 이 워크스페이스 전체로 확대돼 있는가. */
  zoomed?: boolean;
  /** 확대 토글. 없으면 아이콘을 그리지 않는다. */
  onToggleZoom?: () => void;
  /** 분할에서 빼내 독립 탭으로. 없으면 아이콘을 그리지 않는다. */
  onDetachToTab?: () => void;
  actions?: ReactNode;
}

// 연결 종류 아이콘. 종류를 모르면(구버전이 만든 호스트 등) 터미널 아이콘으로 떨어뜨린다 —
// 아이콘이 통째로 빠지면 헤더 정렬이 pane 마다 어긋나 보인다.
function KindIcon({ kind }: { kind?: HostKind }) {
  const Icon =
    kind === 'aws-ec2'
      ? Cloud
      : kind === 'aws-ecs'
        ? Container
        : kind === 'rdp' || kind === 'vnc'
          ? Monitor
          : kind === 'serial'
            ? Cable
            : SquareTerminal;
  return <Icon className="h-[0.8rem] w-[0.8rem] shrink-0 text-[var(--text-soft)]" aria-hidden />;
}

// 헤더 아이콘 버튼 공통 껍데기.
//
// 헤더는 draggable 이고 클릭하면 pane 포커스가 옮겨간다. 버튼 클릭이 그 둘로 새지 않게
// mousedown 단계에서 끊어야 하는데, 버튼마다 따로 적으면 하나 빠뜨렸을 때 "버튼을 눌렀는데
// pane 이 끌린다"가 된다. 한 곳에 모아 둔다.
function HeaderIconButton({
  label,
  title,
  onClick,
  active = false,
  disabled = false,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <IconButton
      aria-label={label}
      title={title}
      aria-pressed={active}
      aria-disabled={disabled}
      tone="ghost"
      size="sm"
      className={cn(
        'h-[1.25rem] w-[1.25rem] rounded-[5px]',
        active
          ? 'bg-[var(--accent-surface)] text-[var(--accent-strong)]'
          : 'text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)]',
        disabled && !active && 'opacity-45',
      )}
      draggable={false}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) {
          return;
        }
        onClick();
      }}
    >
      {children}
    </IconButton>
  );
}

export function TerminalPaneHeader({
  sessionId,
  title,
  active,
  draggingDisabled,
  closingDisabled,
  onFocus,
  onClose,
  onStartDrag,
  onEndDrag,
  kind,
  subtitle,
  broadcastActive = false,
  broadcastDisabled = false,
  onToggleBroadcast,
  zoomed = false,
  onToggleZoom,
  onDetachToTab,
  actions,
}: TerminalPaneHeaderProps) {
  const { t: translate } = useTranslation();

  return (
    <div
      className={cn(
        // @container: 폭에 따라 접히는 규칙을 pane 헤더 자기 폭 기준으로 건다. 미디어 쿼리는
        // 창 크기를 보므로 분할된 pane 에는 못 쓴다 — 창이 넓어도 pane 은 좁을 수 있다.
        '@container flex cursor-grab select-none items-center gap-[0.3rem] rounded-t-[6px] border border-b-0 py-[0.25rem] pl-[0.45rem] pr-[0.3rem] text-[0.78rem] font-medium',
        'bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)]',
        // 활성 표시는 배경 틴트가 아니라 테두리다. pane 이 3~4개로 늘면 틴트는 서로 구분되지
        // 않는다. 터미널 쪽 테두리도 같이 액센트가 되어 헤더+본문이 한 상자로 읽힌다
        // (TerminalSessionPane 이 같은 조건으로 칠한다).
        active
          ? 'border-[color-mix(in_srgb,var(--accent-strong)_55%,var(--border))]'
          : 'border-[color-mix(in_srgb,var(--border)_88%,transparent_12%)]',
      )}
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
      <KindIcon kind={kind} />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-baseline gap-[0.35rem] overflow-hidden bg-transparent text-left"
        onClick={onFocus}
      >
        {/* 이름이 pane 의 정체다 — 부제보다 뒤에 잘린다(max-w 로 부제 자리를 남겨 둔다). */}
        <span className="max-w-[72%] shrink truncate text-[var(--text)]">{title}</span>
        {subtitle ? (
          <span className="min-w-0 flex-1 truncate text-[0.68rem] text-[var(--text-muted)] @max-[19rem]:hidden">
            {subtitle}
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-[0.15rem]">
        {onToggleBroadcast ? (
          <HeaderIconButton
            label={translate(
              broadcastActive ? 'workspace.broadcastOff' : 'workspace.broadcastOn',
            )}
            title={translate(
              broadcastActive
                ? 'workspace.broadcastActive'
                : broadcastDisabled
                  ? 'workspace.broadcastNeedsPanes'
                  : 'workspace.broadcastOn',
            )}
            active={broadcastActive}
            disabled={broadcastDisabled}
            onClick={onToggleBroadcast}
          >
            {/* 동시 입력 = 동심원 전파 기호. 직접 그린 16×16 SVG 를 쓰다가 13px 로 줄었을 때
                호가 서로 붙어 나비넥타이처럼 뭉개져서, 같은 기호를 24×24 로 튜닝해 둔
                lucide 것으로 바꿨다. */}
            <Radio className="h-[0.8rem] w-[0.8rem]" aria-hidden />
          </HeaderIconButton>
        ) : null}
        {/* 확대·탭 복귀는 좁은 pane 에서 가장 먼저 접는다 — 없어도 다른 경로가 있다
            (확대는 다시 나눠 보면 되고, 탭 복귀는 헤더를 탭 스트립으로 끌면 된다). */}
        {onToggleZoom ? (
          <span className="@max-[13rem]:hidden">
            <HeaderIconButton
              label={translate(zoomed ? 'paneHeader.zoomOut' : 'paneHeader.zoomIn')}
              title={translate(zoomed ? 'paneHeader.zoomOut' : 'paneHeader.zoomIn')}
              active={zoomed}
              onClick={onToggleZoom}
            >
              {zoomed ? (
                <Minimize2 className="h-[0.8rem] w-[0.8rem]" aria-hidden />
              ) : (
                <Maximize2 className="h-[0.8rem] w-[0.8rem]" aria-hidden />
              )}
            </HeaderIconButton>
          </span>
        ) : null}
        {onDetachToTab ? (
          <span className="@max-[13rem]:hidden">
            <HeaderIconButton
              label={translate('paneHeader.detachToTab')}
              title={translate('paneHeader.detachToTab')}
              onClick={onDetachToTab}
            >
              <SquareArrowOutUpRight className="h-[0.8rem] w-[0.8rem]" aria-hidden />
            </HeaderIconButton>
          </span>
        ) : null}
        {actions}
        <IconButton
          aria-label={translate('paneHeader.closeSession', { title })}
          tone="ghost"
          size="sm"
          className="h-[1.25rem] w-[1.25rem] rounded-[5px] text-[0.8rem] text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)]"
          onClick={onClose}
          disabled={closingDisabled}
        >
          ×
        </IconButton>
      </div>
    </div>
  );
}
