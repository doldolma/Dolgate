// 재생바 위에 명령 위치를 눈금으로 표시한다. 어디쯤에서 무슨 일이 있었는지, 특히 실패가
// 어디에 몰려 있는지 스크럽 전에 한눈에 보이게 하는 용도다.
//
// 눈금은 pointer-events:none 이다 — 클릭 가능하게 만들면 그 지점에서 스크럽 드래그가 막힌다.
// 대신 스크럽바 전체에서 마우스 위치를 읽어 "그 시점의 명령"을 툴팁으로 보여준다. 드래그를
// 전혀 방해하지 않으면서 스크럽 중에도 어느 명령 구간인지 따라온다. 이동은 오른쪽 목록 담당.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ReplayCommandBlock } from '../lib/replay-command-scan';
import { useTranslation } from 'react-i18next';

interface SessionReplayScrubberMarkersProps {
  blocks: readonly ReplayCommandBlock[];
  durationMs: number;
  /** 마우스 위치를 읽을 스크럽바 래퍼. 눈금 자체가 아니라 여기서 hover 를 감지한다. */
  hoverTargetRef: RefObject<HTMLElement | null>;
}

/** 이 픽셀 간격보다 촘촘하면 하나로 묶는다(명령이 수백 개여도 눈금이 뭉개지지 않도록). */
const MIN_GAP_PX = 7;
/** tailwind.css 의 --session-replay-thumb-size 와 맞춰야 한다. thumb 중심 이동 범위 보정용. */
const THUMB_SIZE_REM = 0.78;

export interface MarkerCluster {
  key: number;
  ratio: number;
  count: number;
  state: ReplayCommandBlock['state'];
}

function rootFontSizePx(): number {
  if (typeof window === 'undefined') {
    return 16;
  }
  const parsed = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

/**
 * 실패 > 실행 중 > 성공 순으로 클러스터 색을 정한다 — 묶였을 때 실패가 묻히면 안 된다.
 */
function mergeState(
  current: ReplayCommandBlock['state'],
  next: ReplayCommandBlock['state'],
): ReplayCommandBlock['state'] {
  if (current === 'failed' || next === 'failed') {
    return 'failed';
  }
  if (current === 'running' || next === 'running') {
    return 'running';
  }
  return 'ok';
}

export function buildScrubberMarkerClusters(
  blocks: readonly ReplayCommandBlock[],
  durationMs: number,
  trackWidthPx: number,
): MarkerCluster[] {
  if (durationMs <= 0 || trackWidthPx <= 0) {
    return [];
  }
  const clusters: MarkerCluster[] = [];
  let lastPx = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    const ratio = Math.min(1, Math.max(0, block.atMs / durationMs));
    const px = ratio * trackWidthPx;
    const previous = clusters[clusters.length - 1];
    if (previous && px - lastPx < MIN_GAP_PX) {
      previous.count += 1;
      previous.state = mergeState(previous.state, block.state);
      continue;
    }
    clusters.push({ key: block.id, ratio, count: 1, state: block.state });
    lastPx = px;
  }
  return clusters;
}

interface HoverState {
  ratio: number;
  block: ReplayCommandBlock;
}

/** 그 시각에 실행 중이던 명령 = 그 시각 이전에 시작한 마지막 명령. */
export function findBlockAt(
  blocks: readonly ReplayCommandBlock[],
  atMs: number,
): ReplayCommandBlock | null {
  let found: ReplayCommandBlock | null = null;
  for (const block of blocks) {
    if (block.atMs > atMs) {
      break;
    }
    found = block;
  }
  return found;
}

function formatOffset(atMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(atMs / 1000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(
    totalSeconds % 60,
  ).padStart(2, '0')}`;
}

function SessionReplayScrubberMarkersImpl({
  blocks,
  durationMs,
  hoverTargetRef,
}: SessionReplayScrubberMarkersProps) {
  const { t: translate } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  // 렌더 중 getComputedStyle 을 부르면 프레임마다 스타일 재계산을 강제한다 → 측정 시점에 한 번만.
  const [rootFontPx, setRootFontPx] = useState(16);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const element = trackRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setTrackWidthPx(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    setTrackWidthPx(element.getBoundingClientRect().width);
    setRootFontPx(rootFontSizePx());
    return () => observer.disconnect();
  }, []);

  const clusters = useMemo(
    () => buildScrubberMarkerClusters(blocks, durationMs, trackWidthPx),
    [blocks, durationMs, trackWidthPx],
  );
  // thumb 중심은 양 끝에서 thumb 절반만큼 안쪽까지만 이동한다. 눈금도 같은 범위에 놓아야
  // 재생 위치와 어긋나 보이지 않는다.
  const inset = (THUMB_SIZE_REM * rootFontPx) / 2;

  // hover 는 눈금이 아니라 스크럽바 래퍼에서 읽는다 — 눈금에 pointer-events 를 주면
  // 그 지점에서 드래그가 걸린다.
  useEffect(() => {
    const target = hoverTargetRef.current;
    if (!target || durationMs <= 0 || blocks.length === 0) {
      setHover(null);
      return;
    }
    const handleMove = (event: MouseEvent) => {
      const rect = target.getBoundingClientRect();
      const trackWidth = rect.width - inset * 2;
      if (trackWidth <= 0) {
        return;
      }
      const ratio = Math.min(
        1,
        Math.max(0, (event.clientX - rect.left - inset) / trackWidth),
      );
      const block = findBlockAt(blocks, ratio * durationMs);
      setHover(block ? { ratio, block } : null);
    };
    const handleLeave = () => setHover(null);
    target.addEventListener('mousemove', handleMove);
    target.addEventListener('mouseleave', handleLeave);
    return () => {
      target.removeEventListener('mousemove', handleMove);
      target.removeEventListener('mouseleave', handleLeave);
    };
  }, [blocks, durationMs, hoverTargetRef, inset]);

  return (
    <div
      ref={trackRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
    >
      <div
        className="absolute top-1/2 -translate-y-1/2"
        style={{ left: inset, right: inset }}
      >
        {clusters.map((cluster) => (
          <span
            key={cluster.key}
            className="absolute block -translate-x-1/2 rounded-[1px]"
            style={{
              left: `${cluster.ratio * 100}%`,
              // 여러 명령이 묶인 눈금은 조금 굵게 — 하나짜리와 구분된다.
              width: cluster.count > 1 ? 4 : 2,
              height: cluster.state === 'failed' ? 12 : 8,
              top: cluster.state === 'failed' ? -6 : -4,
              backgroundColor:
                cluster.state === 'failed'
                  ? 'var(--danger-text)'
                  : cluster.state === 'running'
                    ? 'var(--accent-strong)'
                    : 'color-mix(in srgb, var(--text-soft) 55%, transparent 45%)',
            }}
          />
        ))}
        {hover ? (
          <div
            className="absolute bottom-[14px] max-w-[18rem] -translate-x-1/2 truncate rounded-[6px] border border-[var(--border)] bg-[var(--surface-strong)] px-2 py-1 text-[0.7rem] text-[var(--text)] shadow-[var(--shadow-soft)]"
            style={{ left: `${hover.ratio * 100}%` }}
          >
            <span className="tabular-nums text-[var(--text-soft)]">
              {formatOffset(hover.block.atMs)}
            </span>{' '}
            <span className="font-mono">
              {hover.block.command ?? translate('misc.commandUnreadable')}
            </span>
            {hover.block.state === 'failed' && hover.block.exitCode !== null ? (
              <span className="ml-1 font-semibold text-[var(--danger-text)]">
                exit {hover.block.exitCode}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// props(blocks·durationMs·ref)가 재생 중 바뀌지 않으므로 memo 로 프레임마다의 리렌더를 끊는다.
export const SessionReplayScrubberMarkers = memo(SessionReplayScrubberMarkersImpl);
