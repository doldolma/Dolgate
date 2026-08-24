// 세션 하단 1줄 바. 이 연결의 상태(지연·연결종류)와 원격 머신의 부하 요약을 한 줄에 둔다.
//
// 예전에는 자원 지표만 그리는 바였고, 지표를 못 읽는 연결에서는 `null` 을 반환해 **바 자체가
// 사라졌다.** 지연이 여기로 내려왔으므로 그럴 수 없다 — 연결돼 있으면 바는 늘 그리고 지표만
// 빠진다.
//
// 자세한 값은 담지 않는다. 지표를 누르면 세션 패널의 자원 섹션이 열리고, 거기에 uptime·코어
// 수·디스크 사용량·프로세스가 이미 있다. 같은 값을 두 곳에서 관리하지 않기 위해 예전의 hover
// 툴팁은 없앴다.
//
// 좁아질 때 무엇부터 버리는지는 lib/session-status-bar.ts 가 정한다(폭만 넘긴다).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import {
  Boxes,
  Columns2,
  Container,
  Network,
  Plug,
  RefreshCw,
  Waypoints,
} from '../../ui/icons';
import { Tooltip } from '../../ui';
import { useAppStore } from '../../store/appStore';
import { rttBandColor, rttColor } from '../../lib/rtt';
import {
  formatBytesPerSecond,
  formatKibibytes,
  formatPercent,
  isHostMetricAlarming,
  type HostMetrics,
} from '../../lib/host-metrics';
import {
  resolveStatusBarFold,
  shortenRatio,
  type SessionHopRow,
  type SessionKindChip,
} from '../../lib/session-status-bar';
import {
  buildSparklineSegments,
  getRttHistoryVersion,
  getRttSamples,
  subscribeToRttHistory,
  summarizeRtt,
  type RttSummary,
} from '../../lib/rtt-history';
import type { HostMetricsStatus } from '../../controllers/useHostMetrics';
import {
  StatusBarIcon,
  statusBarChrome,
  statusBarDivider,
  statusBarIconSize,
  statusBarSpacing,
} from './terminalStatusBarChrome';

interface TerminalSessionStatusBarProps {
  /** 지표·tmux 를 눌렀을 때 패널을 열 세션. */
  sessionId: string;
  status: HostMetricsStatus;
  metrics: HostMetrics | null;
  onRetry: () => void;
  /** keepalive 왕복 지연. 연결 직후·재연결 중에는 null 이라 아무것도 그리지 않는다. */
  rttMs: number | null;
  /** 평범한 SSH 면 null — 모든 세션에 붙는 라벨은 정보가 아니다. */
  kindChip: SessionKindChip | null;
  /** 종류 칩 hover 에 뿌릴 홉 목록(점프에서만 채워진다). */
  hopRows: SessionHopRow[];
  /** tmux 칩 라벨. 감지되지도, 붙어 있지도 않으면 null. */
  tmuxLabel: string | null;
  /**
   * 지연 이력을 찾을 키. 재연결에도 이어져야 하므로 sessionId 가 아니라 stableId 다(tmux
   * 그룹은 group.id). 없으면 hover 에 이력을 그리지 않는다.
   */
  historyKey?: string | null;
  /**
   * 접힘 판정에 쓸 폭. 넘기지 않으면 스스로 잰다 — 테스트에서만 넘긴다(ResizeObserver 가
   * 없는 환경에서 접힘 단계를 확인할 방법이 필요하다).
   */
  width?: number;
}

// 이 바에는 테두리·배경 상자를 두지 않는다(statusBarChrome 의 규칙). 상자를 두르면 한 줄
// 상태바가 알약 여러 개로 조각나 보이고, 터미널 바로 아래에 선이 하나 더 생긴다.
//
// hover 표시는 **줄 전체 높이를 채우는 띠**다. 글자에 딱 맞춘 알약으로 깔면(바 26px 안에 18px
// 배경) 그 조각만 떠 보여 조잡하다. `self-stretch` 로 높이를 채우고 세로 여백을 상쇄해 바와
// 같은 높이가 되게 한다. 색은 테마마다 세기가 달라야 해서(어두운 배경에서는 같은 비율이 훨씬
// 약하게 읽힌다) tokens.css 의 `--status-hover-bg` 가 정한다.
// hover 띠는 자기 높이로만 그린다. `self-stretch` + 음수 세로 마진으로 줄 높이를 채우려 하면
// 부모(내용 기반 높이) 계산에 끼어들어 pane 높이가 미세하게 흔들릴 수 있다.
const PRESSABLE_CLASS =
  'group flex items-center gap-1.5 rounded-[4px] px-[0.3rem] py-[0.1rem] transition-colors hover:bg-[var(--status-hover-bg)]';

/** hover 시 라벨이 한 단계 진해진다(자식에 직접 건다). */
const HOVER_LABEL_CLASS =
  'transition-colors group-hover:text-[var(--text)]';

/** 평소 액센트, hover 시 한 단계 진한 액센트. 아이콘은 이 색을 물려받는다(currentColor). */
const HOVER_ICON_CLASS =
  'inline-flex text-[var(--accent)] transition-colors group-hover:text-[var(--accent-strong)]';

/**
 * 자원 영역은 구분선에서 tmux 칩까지를 통째로 차지한다 — 좌우 여백(바의 gap)을 음수 마진으로
 * 상쇄하고 같은 값을 패딩으로 돌려주므로, 글자 위치는 그대로인데 띠만 이웃까지 닿는다.
 */
const ZONE_CLASS = `${PRESSABLE_CLASS} min-w-0 flex-1 gap-[0.9rem]`;

/** 스파크라인 크기. 10분 창은 10초 간격이라 60점이고, 60px 이면 1점이 1px 이다. */
const SPARKLINE_WIDTH = 132;
const SPARKLINE_HEIGHT = 34;

const KIND_ICON = {
  jump: Waypoints,
  ssm: Network,
  ecs: Boxes,
  warpgate: Network,
  serial: Plug,
  container: Container,
} as const;

function Metric({
  label,
  value,
  alarming,
}: {
  label: string | null;
  value: string;
  alarming?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      {label ? (
        <span className={cn('text-[var(--text-soft)]', HOVER_LABEL_CLASS)}>{label}</span>
      ) : null}
      <span
        className={cn(
          'tabular-nums',
          alarming ? 'font-semibold text-[var(--danger-text)]' : 'text-[var(--text)]',
        )}
      >
        {value}
      </span>
    </span>
  );
}

function formatRatio(usedKb: number | null, totalKb: number | null): string {
  if (usedKb === null || !totalKb) {
    return '—';
  }
  return `${formatKibibytes(usedKb)} / ${formatKibibytes(totalKb)}`;
}

/** 지연 이력 구독. 값이 올 때만(10초마다) 이 컴포넌트가 다시 그려진다. */
function useRttSummary(key: string | null | undefined): RttSummary | null {
  const subscribe = useCallback(
    (onChange: () => void) => (key ? subscribeToRttHistory(key, onChange) : () => undefined),
    [key],
  );
  // 스냅샷은 버전 숫자다 — 배열을 돌려주면 매번 새 참조가 되어 무한 루프가 된다.
  const version = useSyncExternalStore(
    subscribe,
    () => (key ? getRttHistoryVersion(key) : 0),
    () => 0,
  );
  const [summary, setSummary] = useState<RttSummary | null>(null);
  useEffect(() => {
    setSummary(key ? summarizeRtt(getRttSamples(key)) : null);
  }, [key, version]);
  return summary;
}

/**
 * 스스로 폭을 재서 접힘 단계를 고른다. 못 재는 환경에서는 접지 않는다(넘쳐도 잘리기만 한다).
 *
 * 방어 장치 셋:
 * - 관측자를 **콜백 ref** 로 붙인다. `useEffect` + `useRef` 로 붙이면 노드가 바뀌어도(조건부
 *   렌더로 다시 그려질 때) effect 가 다시 돌지 않아, 낡은 노드를 붙잡은 관측자가 남고 새
 *   노드에는 아무도 붙지 않는다.
 * - 폭을 **정수로 반올림**하고 이전 값과 같으면 setState 를 건너뛴다. 소수점 값을 그대로
 *   넣으면 0.x px 흔들림이 관측 → 렌더 → 레이아웃 → 관측 으로 되돌아온다.
 * - 폭 0 은 무시한다(접혀 있는 동안) — 마지막으로 잰 값을 지켜 펼칠 때 다시 재지 않게 한다.
 */
function useMeasuredWidth(override: number | undefined): {
  width: number | null;
  attach: (node: HTMLDivElement | null) => void;
} {
  const [width, setWidth] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (override !== undefined || !node || typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver((entries) => {
        const next = entries[0]?.contentRect.width;
        if (typeof next !== 'number' || next <= 0) {
          return;
        }
        const rounded = Math.round(next);
        setWidth((current) => (current === rounded ? current : rounded));
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [override],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { width: override ?? width, attach };
}

export function TerminalSessionStatusBar({
  sessionId,
  status,
  metrics,
  onRetry,
  rttMs,
  kindChip,
  hopRows,
  tmuxLabel,
  historyKey,
  width,
}: TerminalSessionStatusBarProps) {
  const { t: translate } = useTranslation();
  const selectSection = useAppStore((state) => state.selectSessionPanelSection);
  const { width: measured, attach } = useMeasuredWidth(width);
  const [hopsOpen, setHopsOpen] = useState(false);
  const [rttOpen, setRttOpen] = useState(false);
  const rttSummary = useRttSummary(historyKey);
  // 점이 모자라면 빈 배열이 온다(rtt-history 가 정한다) — 그때는 차트 자리만 비어 있다.
  const sparkline = rttSummary
    ? buildSparklineSegments(rttSummary.samples, SPARKLINE_WIDTH, SPARKLINE_HEIGHT)
    : [];

  // 재려면 한 번은 그려야 한다 — 첫 프레임은 접지 않고 그린 뒤 실측으로 좁힌다.
  const fold = resolveStatusBarFold(measured ?? 9999);
  const alarming = metrics
    ? isHostMetricAlarming(metrics)
    : { cpu: false, memory: false, disk: false };
  const stale = status === 'paused';
  // 지표를 못 읽는 연결(어플라이언스·제한된 셸)에서도 지연과 칩은 남는다.
  const metricsHidden = status === 'off' || status === 'unsupported';
  const showRtt = fold.showRtt && rttMs !== null;
  // 담을 것이 하나도 없으면 그리지 않는다 — 로컬 터미널은 지표·지연·tmux 가 모두 없어서,
  // 빈 줄이 26px 을 먹고 앉아 있으면 고장으로 보인다.
  if (metricsHidden && !showRtt && !kindChip && !tmuxLabel) {
    return null;
  }
  const KindIcon = kindChip ? KIND_ICON[kindChip.kind] : null;
  const kindLabel = kindChip
    ? kindChip.kind === 'jump'
      ? kindChip.hopCount <= 1 && kindChip.hopName
        ? translate('sessionStatusBar.kind.jumpVia', { name: kindChip.hopName })
        : translate('sessionStatusBar.kind.jumpHops', { count: kindChip.hopCount })
      : translate(`sessionStatusBar.kind.${kindChip.kind}`)
    : null;

  return (
    <div ref={attach} className={cn('relative', statusBarSpacing)}>
      <div
        className={cn(statusBarChrome, 'gap-[0.9rem]', stale && 'opacity-60')}
        role="status"
        aria-live="off"
      >
        {kindChip && KindIcon && kindLabel ? (
          // 점프는 홉 목록이라 한 줄 툴팁에 안 들어간다 — 아래 hover 패널로 뿌린다.
          kindChip.kind === 'jump' && hopRows.length > 0 ? (
            <span
              className="flex items-center gap-1.5"
              onMouseEnter={() => setHopsOpen(true)}
              onMouseLeave={() => setHopsOpen(false)}
              aria-label={kindLabel}
            >
              <StatusBarIcon>
                <KindIcon className={statusBarIconSize} />
              </StatusBarIcon>
              {fold.chipsIconOnly ? null : (
                <span className="text-[var(--text)]">{kindLabel}</span>
              )}
            </span>
          ) : (
            <Tooltip label={kindLabel}>
              <span className="flex items-center gap-1.5" aria-label={kindLabel}>
                <StatusBarIcon>
                  <KindIcon className={statusBarIconSize} />
                </StatusBarIcon>
                {fold.chipsIconOnly ? null : (
                  <span className="text-[var(--text)]">{kindLabel}</span>
                )}
              </span>
            </Tooltip>
          )
        ) : null}

        {showRtt ? (
          <span
            className="inline-flex items-center gap-1 whitespace-nowrap"
            title={translate('paneHeader.latency', { ms: rttMs })}
            // 최근 10분 이력은 한 줄 툴팁에 안 들어간다 — 아래 hover 패널에 스파크라인으로 뿌린다.
            onMouseEnter={() => setRttOpen(true)}
            onMouseLeave={() => setRttOpen(false)}
          >
            <span
              className="h-[6px] w-[6px] rounded-full"
              style={{ backgroundColor: rttColor(rttMs) }}
              aria-hidden
            />
            <span className="tabular-nums" style={{ color: rttColor(rttMs) }}>
              {translate('sessionStatusBar.latencyValue', { ms: rttMs })}
            </span>
          </span>
        ) : null}

        {metricsHidden ? null : (
          <>
            {/* 지연과 지표 사이는 성격이 갈린다 — 하나는 연결, 하나는 원격 머신이다. */}
            {kindChip || showRtt ? (
              <span className={statusBarDivider} aria-hidden />
            ) : null}
            <button
              type="button"
              className={ZONE_CLASS}
              // 자세한 값은 패널이 갖고 있다 — 누르면 그 섹션으로 간다(닫혀 있으면 열린다).
              onClick={() => selectSection(sessionId, 'resources')}
              title={translate('sessionStatusBar.openResources')}
            >
              {status === 'loading' || !metrics ? (
                <span className={cn('text-[var(--text-soft)]', HOVER_LABEL_CLASS)}>
                  {translate('hostStatus.loading')}
                </span>
              ) : (
                <>
                  <Metric
                    label={fold.hideLabels ? null : 'CPU'}
                    value={formatPercent(metrics.cpuPercent)}
                    alarming={alarming.cpu}
                  />
                  {fold.showRam ? (
                    <Metric
                      label={fold.hideLabels ? null : 'RAM'}
                      value={
                        fold.shortUnits
                          ? shortenRatio(formatRatio(metrics.memUsedKb, metrics.memTotalKb))
                          : formatRatio(metrics.memUsedKb, metrics.memTotalKb)
                      }
                      alarming={alarming.memory}
                    />
                  ) : null}
                  {/* 네트워크와 디스크 모두 "초당 얼마"라 화살표만 두면 어느 쪽인지 알 수 없다.
                      그룹마다 라벨을 붙이고, 디스크는 읽기/쓰기라 R·W 로 구분한다. */}
                  {fold.showNet ? (
                    <>
                      <Metric label="NET ↓" value={formatBytesPerSecond(metrics.rxBytesPerSec)} />
                      <Metric label="↑" value={formatBytesPerSecond(metrics.txBytesPerSec)} />
                    </>
                  ) : null}
                  {fold.showDisk ? (
                    <>
                      <Metric
                        label="DISK R"
                        value={formatBytesPerSecond(metrics.diskReadBytesPerSec)}
                      />
                      <Metric label="W" value={formatBytesPerSecond(metrics.diskWriteBytesPerSec)} />
                    </>
                  ) : null}
                </>
              )}
            </button>
          </>
        )}

        {stale ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[0.68rem] text-[var(--text-soft)] transition-colors duration-140 hover:text-[var(--accent-strong)]"
            onClick={onRetry}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            {translate('hostStatus.unstable')}
          </button>
        ) : null}

        {tmuxLabel ? (
          <Tooltip className="ml-auto" label={translate('sessionStatusBar.openTmux')}>
            <button
              type="button"
              className={cn(PRESSABLE_CLASS, 'px-[0.4rem]')}
              onClick={() => selectSection(sessionId, 'tmux')}
              aria-label={translate('sessionStatusBar.openTmux')}
            >
              <span className={HOVER_ICON_CLASS}>
                <StatusBarIcon color="currentColor">
                  <Columns2 className={statusBarIconSize} />
                </StatusBarIcon>
              </span>
              {fold.chipsIconOnly ? null : (
                <span className="font-medium text-[var(--text)]">{tmuxLabel}</span>
              )}
            </button>
          </Tooltip>
        ) : null}
      </div>

      {rttOpen && rttSummary ? (
        <div
          className="absolute bottom-[calc(100%+0.3rem)] left-0 z-[8] rounded-[8px] border border-[var(--border)] bg-[var(--surface-strong)] px-[0.6rem] py-[0.5rem] shadow-[var(--shadow)]"
          role="tooltip"
        >
          {/* 차트 자리는 늘 같은 크기로 둔다. x 는 10분 창에 고정이라, 갓 붙은 세션은 오른쪽
              끝에만 선이 있고 왼쪽은 빈칸으로 남는다 — 점이 쌓이는 만큼 왼쪽으로 자란다. */}
          <svg
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
            viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
            className="mb-[0.35rem] block"
            aria-hidden
          >
            {/* 구간마다 색이 다르다 — 튄 자리는 그 구간만 주황·빨강으로 남는다. */}
            {sparkline.map((segment, index) => (
              <polyline
                key={index}
                points={segment.points}
                fill="none"
                stroke={rttBandColor(segment.band)}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </svg>
          <div className="flex items-baseline gap-[0.7rem] text-[0.72rem] text-[var(--text-soft)]">
            <span>
              {translate('sessionStatusBar.rttMin')}{' '}
              <span className="tabular-nums" style={{ color: rttColor(rttSummary.min) }}>
                {translate('sessionStatusBar.latencyValue', { ms: rttSummary.min })}
              </span>
            </span>
            <span>
              {translate('sessionStatusBar.rttAvg')}{' '}
              <span className="tabular-nums" style={{ color: rttColor(rttSummary.avg) }}>
                {translate('sessionStatusBar.latencyValue', { ms: rttSummary.avg })}
              </span>
            </span>
            <span>
              {translate('sessionStatusBar.rttMax')}{' '}
              <span
                className="tabular-nums"
                style={{ color: rttColor(rttSummary.max) }}
              >
                {translate('sessionStatusBar.latencyValue', { ms: rttSummary.max })}
              </span>
            </span>
          </div>
        </div>
      ) : null}

      {hopsOpen && hopRows.length > 0 ? (
        <div
          className="absolute bottom-[calc(100%+0.3rem)] left-0 z-[8] min-w-[14rem] rounded-[8px] border border-[var(--border)] bg-[var(--surface-strong)] px-[0.7rem] py-[0.55rem] text-[0.72rem] shadow-[var(--shadow)]"
          role="tooltip"
        >
          <div className="grid gap-[0.3rem]">
            {hopRows.map((row) => (
              <div key={`${row.index}-${row.label}`} className="flex items-baseline gap-2">
                <span className="tabular-nums text-[var(--text-soft)]">{row.index + 1}</span>
                <span className="min-w-0 flex-1">
                  {row.name ? (
                    <span className="text-[var(--text)]">{row.name} </span>
                  ) : null}
                  <span
                    className={cn(
                      'font-mono text-[0.7rem]',
                      row.failed ? 'text-[var(--danger-text)]' : 'text-[var(--text-soft)]',
                    )}
                  >
                    {row.label}
                  </span>
                </span>
                {row.destination ? (
                  <span className="shrink-0 text-[var(--text-soft)]">
                    {translate('sessionStatusBar.destination')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
