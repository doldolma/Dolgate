// 리플레이 오른쪽 명령 목록. 녹화를 로드할 때 사전 스캔으로 뽑은 명령들을 시간순으로 보여주고,
// 클릭하면 그 명령이 실행된 시점으로 재생 위치를 옮긴다.

import { memo } from 'react';
import type { ReplayCommandBlock } from '../lib/replay-command-scan';
import { cn } from '../lib/cn';
import { useTranslation } from "react-i18next";

interface SessionReplayCommandPanelProps {
  blocks: readonly ReplayCommandBlock[];
  scanning: boolean;
  shellIntegrationDetected: boolean;
  /**
   * 지금 재생 중인 명령의 id. positionMs 를 그대로 받으면 재생 중 매 프레임 리렌더되어
   * 명령 수백 개의 행이 초당 60번 다시 만들어진다. 경계를 넘을 때만 바뀌는 값으로 받는다.
   */
  activeBlockId: number | null;
  onSeek: (atMs: number) => void;
  className?: string;
}

function formatOffset(atMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(atMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** 재생 위치가 어느 블록 구간에 있는지 — 마지막으로 시작한 블록이 현재 블록이다. */
export function findActiveBlockId(
  blocks: readonly ReplayCommandBlock[],
  positionMs: number,
): number | null {
  let activeId: number | null = null;
  for (const block of blocks) {
    if (block.atMs <= positionMs) {
      activeId = block.id;
    } else {
      break;
    }
  }
  return activeId;
}

function SessionReplayCommandPanelImpl({
  blocks,
  scanning,
  shellIntegrationDetected,
  activeBlockId,
  onSeek,
  className,
}: SessionReplayCommandPanelProps) {
  const { t: translate } = useTranslation();
  const activeId = activeBlockId;

  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_94%,transparent_6%)]',
        className,
      )}
      aria-label={translate('replayCommands.aria')}
    >
      <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="text-[0.72rem] font-bold uppercase tracking-[0.12em] text-[var(--text-soft)]">
          Commands
        </span>
        {blocks.length > 0 ? (
          <span className="text-[0.72rem] tabular-nums text-[var(--text-soft)]">
            {blocks.length}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {scanning ? (
          <p className="m-0 px-3 py-4 text-[0.8rem] text-[var(--text-soft)]">
            {translate('replayCommands.analyzing')}
          </p>
        ) : blocks.length === 0 ? (
          <p className="m-0 px-3 py-4 text-[0.8rem] leading-[1.5] text-[var(--text-soft)]">
            {shellIntegrationDetected
              ? translate('replayCommands.noCommands')
              : translate('replayCommands.noShellIntegration')}
          </p>
        ) : (
          blocks.map((block) => {
            const active = block.id === activeId;
            const duration = formatDuration(block.durationMs);
            return (
              <button
                key={block.id}
                type="button"
                onClick={() => onSeek(block.atMs)}
                className={cn(
                  'flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left transition-colors duration-150',
                  active
                    ? 'border-l-[var(--accent-strong)] bg-[var(--selection-tint)]'
                    : 'border-l-transparent hover:bg-[color-mix(in_srgb,var(--surface-muted)_70%,transparent_30%)]',
                )}
                title={block.command ?? undefined}
              >
                <span className="shrink-0 font-mono text-[0.72rem] tabular-nums text-[var(--text-soft)]">
                  {formatOffset(block.atMs)}
                </span>
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    block.state === 'failed'
                      ? 'bg-[var(--danger-text)]'
                      : block.state === 'running'
                        ? 'bg-[var(--accent-strong)]'
                        : 'bg-[color-mix(in_srgb,var(--success-text)_70%,transparent_30%)]',
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] text-[var(--text)]">
                  {block.command ?? translate('replayCommands.unreadable')}
                </span>
                {block.state === 'failed' && block.exitCode !== null ? (
                  <span className="shrink-0 text-[0.68rem] font-semibold text-[var(--danger-text)]">
                    {block.exitCode}
                  </span>
                ) : null}
                {duration ? (
                  <span className="shrink-0 text-[0.68rem] tabular-nums text-[var(--text-soft)]">
                    {duration}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

// 재생 중에는 activeBlockId 외의 props 가 그대로라 memo 로 리렌더를 끊는다.
export const SessionReplayCommandPanel = memo(SessionReplayCommandPanelImpl);
