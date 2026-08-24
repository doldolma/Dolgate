// 지연시간 칩 — 점 + 숫자, 올리면 최근 10분 스파크라인과 min/avg/max.
//
// 두 자리에서 같은 것을 쓴다: 단독 화면의 하단바, 분할 화면의 pane 헤더. 분할에는 하단바가
// 없으므로(pane 마다 바가 하나씩 붙으면 아래가 줄로 가득 찬다) 지연은 헤더가 든다. 같은 값을
// 두 컴포넌트가 각자 그리면 색 기준·창 길이가 갈리므로 여기 하나로 둔다.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { rttBandColor, rttColor } from '../../lib/rtt';
import {
  buildSparklineSegments,
  getRttHistoryVersion,
  getRttSamples,
  subscribeToRttHistory,
  summarizeRtt,
  type RttSummary,
} from '../../lib/rtt-history';

const SPARKLINE_WIDTH = 132;
const SPARKLINE_HEIGHT = 34;

interface TerminalRttChipProps {
  /** 방금 잰 왕복 시간(ms). null 이면 아무 것도 그리지 않는다. */
  rttMs: number | null;
  /**
   * 이력 키 — 재연결을 건너 이어져야 하므로 `stableId` 다(sessionId 는 재연결마다 새로 난다).
   * 없으면 칩만 그리고 hover 차트는 뜨지 않는다.
   */
  historyKey: string | null;
  /** 차트가 열릴 방향. 하단바는 위로, pane 헤더는 아래로 편다. */
  placement?: 'up' | 'down';
  /** 차트의 가로 정렬. 칩이 오른쪽 끝에 있으면 `right` 여야 화면 밖으로 나가지 않는다. */
  align?: 'left' | 'right';
  className?: string;
}

/** 이 키의 지연 이력 요약. 값이 바뀔 때만 다시 계산한다. */
function useRttSummary(key: string | null): RttSummary | null {
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

export function TerminalRttChip({
  rttMs,
  historyKey,
  placement = 'up',
  align = 'left',
  className,
}: TerminalRttChipProps) {
  const { t: translate } = useTranslation();
  const [open, setOpen] = useState(false);
  const summary = useRttSummary(historyKey);
  // 점이 모자라면 빈 배열이 온다(rtt-history 가 정한다) — 그때는 차트 자리만 비어 있다.
  const sparkline = summary
    ? buildSparklineSegments(summary.samples, SPARKLINE_WIDTH, SPARKLINE_HEIGHT)
    : [];

  if (rttMs === null) {
    return null;
  }

  return (
    <span className={cn('relative inline-flex', className)}>
      {/* 점을 두지 않는다 — 앱에서 **점은 세션 상태**(탭의 연결·명령 결과)의 어휘다. 지연에
          점을 붙이면 같은 초록이 자리마다 "명령 성공"과 "지연 양호"로 갈린다. 지연은 숫자가
          이미 구간색을 입고 있으니 점 없이도 읽힌다. */}
      <span
        className="inline-flex items-center whitespace-nowrap tabular-nums"
        style={{ color: rttColor(rttMs) }}
        title={translate('paneHeader.latency', { ms: rttMs })}
        // 최근 10분 이력은 한 줄 툴팁에 안 들어간다 — hover 패널에 스파크라인으로 뿌린다.
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {translate('sessionStatusBar.latencyValue', { ms: rttMs })}
      </span>

      {open && summary ? (
        <div
          className={cn(
            'absolute z-[8] rounded-[8px] border border-[var(--border)] bg-[var(--surface-strong)] px-[0.6rem] py-[0.5rem] font-normal shadow-[var(--shadow)]',
            placement === 'up'
              ? 'bottom-[calc(100%+0.3rem)]'
              : 'top-[calc(100%+0.3rem)]',
            align === 'left' ? 'left-0' : 'right-0',
          )}
          role="tooltip"
        >
          {/* 차트 자리는 늘 같은 크기로 둔다. x 축은 쌓인 구간에 맞춰 늘어나므로(최대 10분)
              갓 붙은 세션은 왼쪽부터 채워지고 오른쪽이 비어 있다. */}
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
            {(
              [
                ['sessionStatusBar.rttMin', summary.min],
                ['sessionStatusBar.rttAvg', summary.avg],
                ['sessionStatusBar.rttMax', summary.max],
              ] as const
            ).map(([labelKey, value]) => (
              <span key={labelKey}>
                {translate(labelKey)}{' '}
                <span className="tabular-nums" style={{ color: rttColor(value) }}>
                  {translate('sessionStatusBar.latencyValue', { ms: value })}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}
