// 이 세션에서 실행한 명령 목록(⌘/Ctrl+Shift+P). 셸의 Ctrl+R 히스토리와 달리 "무엇을 쳤는지"
// 뿐 아니라 성공/실패·소요시간·작업 디렉터리까지 함께 보여 주고, 그 명령의 출력 위치로 바로
// 이동하거나 재실행할 수 있다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import type { TerminalCommandBlockState } from '../../lib/terminal-command-blocks';
import { formatBlockDuration } from './blockFormat';

export interface TerminalCommandPaletteItem {
  id: number;
  command: string | null;
  /** 화면에서 읽은 명령이 실제 입력과 다를 수 있음 — 재실행 대신 이동만 한다. */
  commandUnreliable: boolean;
  state: TerminalCommandBlockState;
  exitCode: number | null;
  durationMs: number | null;
  cwd: string | null;
  startedAt: number;
}

interface TerminalCommandPaletteProps {
  items: readonly TerminalCommandPaletteItem[];
  onClose: () => void;
  onJump: (id: number) => void;
  onRerun: (id: number) => void;
}

function formatRelativeTime(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 5) {
    return '방금';
  }
  if (seconds < 60) {
    return `${seconds}초 전`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}분 전`;
  }
  return `${Math.floor(minutes / 60)}시간 전`;
}

/** 공백으로 나눈 모든 토큰이 순서 상관없이 들어 있으면 통과(간단한 부분 일치 검색). */
function matchesQuery(item: TerminalCommandPaletteItem, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  const haystack = `${item.command ?? ''} ${item.cwd ?? ''}`.toLowerCase();
  return trimmed.split(/\s+/).every((token) => haystack.includes(token));
}

export function TerminalCommandPalette({
  items,
  onClose,
  onJump,
  onRerun,
}: TerminalCommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 목록이 열려 있는 동안 "N분 전"이 계속 흐르지 않도록 연 시점으로 고정한다.
  const openedAt = useMemo(() => Date.now(), []);

  const visible = useMemo(() => {
    const filtered = items.filter(
      (item) =>
        (!failedOnly || item.state === 'failed') && matchesQuery(item, query),
    );
    // 최신 명령이 위로.
    return [...filtered].reverse();
  }, [failedOnly, items, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [failedOnly, query]);

  useEffect(() => {
    const row = listRef.current?.children[selectedIndex];
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, visible.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = visible[selectedIndex];
      if (!item) {
        return;
      }
      // 재실행할 수 없는 항목(잘림·여러 줄)은 이동으로 대신한다 — 아무 일도 안 하는
      // 것보다 낫고, 어차피 컨트롤러가 전송을 막는다.
      if ((event.metaKey || event.ctrlKey) && !item.commandUnreliable) {
        onRerun(item.id);
      } else {
        onJump(item.id);
      }
    }
  }

  return (
    <div
      className="absolute inset-0 z-[20] flex items-start justify-center bg-[rgba(0,0,0,0.45)] p-6"
      onMouseDown={(event) => {
        // 배경을 누르면 닫는다(목록 내부 클릭은 유지).
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="flex max-h-full w-full max-w-[36rem] flex-col overflow-hidden rounded-[12px] border border-[rgba(255,255,255,0.14)] bg-[rgba(22,33,51,0.98)] shadow-[var(--shadow)]"
        role="dialog"
        aria-modal="true"
        aria-label="명령 팔레트"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-[rgba(255,255,255,0.1)] px-3.5 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="명령 검색"
            aria-label="명령 검색"
            className="min-w-0 flex-1 border-none bg-transparent text-[0.9rem] text-[rgba(232,239,255,0.95)] outline-none placeholder:text-[rgba(226,234,255,0.4)]"
          />
          <button
            type="button"
            onClick={() => setFailedOnly((current) => !current)}
            aria-pressed={failedOnly}
            className={cn(
              'shrink-0 rounded-full border px-2.5 py-1 text-[0.72rem] font-semibold transition-colors duration-150',
              failedOnly
                ? 'border-[rgba(239,111,108,0.5)] bg-[rgba(239,111,108,0.2)] text-[#ffb1b1]'
                : 'border-[rgba(255,255,255,0.14)] text-[rgba(226,234,255,0.6)] hover:text-[rgba(232,239,255,0.9)]',
            )}
          >
            실패만
          </button>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1.5">
          {visible.length === 0 ? (
            <p className="m-0 px-3.5 py-6 text-center text-[0.82rem] text-[rgba(226,234,255,0.45)]">
              {items.length === 0
                ? '아직 기록된 명령이 없습니다. 셸 통합이 켜진 세션에서만 수집됩니다.'
                : '검색 결과가 없습니다.'}
            </p>
          ) : (
            visible.map((item, index) => {
              const selected = index === selectedIndex;
              const duration = formatBlockDuration(item.durationMs);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2.5 border-l-2 px-3.5 py-2 text-left',
                    selected
                      ? 'border-l-[#7aa2ff] bg-[rgba(122,162,255,0.14)]'
                      : 'border-l-transparent hover:bg-[rgba(255,255,255,0.04)]',
                  )}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={(event) => {
                    if ((event.metaKey || event.ctrlKey) && !item.commandUnreliable) {
                      onRerun(item.id);
                    } else {
                      onJump(item.id);
                    }
                  }}
                >
                  <span
                    className={cn(
                      'h-[7px] w-[7px] shrink-0 rounded-full',
                      item.state === 'failed'
                        ? 'bg-[#ef6f6c]'
                        : item.state === 'running'
                          ? 'bg-[#7aa2ff]'
                          : 'bg-[rgba(122,200,160,0.7)]',
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[0.8rem] text-[rgba(232,239,255,0.92)]">
                      {item.command ?? '(명령을 읽지 못했습니다)'}
                    </span>
                    <span className="mt-0.5 block truncate text-[0.7rem] text-[rgba(226,234,255,0.45)]">
                      {[
                        item.cwd,
                        item.state === 'running'
                          ? '실행 중'
                          : formatRelativeTime(item.startedAt, openedAt),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {item.commandUnreliable ? (
                    <span
                      className="shrink-0 rounded-full bg-[rgba(255,255,255,0.08)] px-1.5 py-0.5 text-[0.68rem] text-[rgba(226,234,255,0.55)]"
                      title="화면에서 읽은 명령이 실제 입력과 다를 수 있습니다(너무 길거나 여러 줄) — 재실행할 수 없습니다."
                    >
                      재실행 불가
                    </span>
                  ) : null}
                  {item.state === 'failed' && item.exitCode !== null ? (
                    <span className="shrink-0 rounded-full bg-[rgba(239,111,108,0.2)] px-1.5 py-0.5 text-[0.68rem] font-semibold text-[#ffb1b1]">
                      exit {item.exitCode}
                    </span>
                  ) : null}
                  {duration ? (
                    <span className="shrink-0 text-[0.7rem] tabular-nums text-[rgba(226,234,255,0.55)]">
                      {duration}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3.5 border-t border-[rgba(255,255,255,0.1)] px-3.5 py-2 text-[0.7rem] text-[rgba(226,234,255,0.45)]">
          <span>
            <strong className="font-semibold text-[rgba(226,234,255,0.75)]">↑↓</strong> 이동
          </span>
          <span>
            <strong className="font-semibold text-[rgba(226,234,255,0.75)]">⏎</strong> 그 위치로
          </span>
          <span>
            <strong className="font-semibold text-[rgba(226,234,255,0.75)]">⌘⏎</strong> 재실행
          </span>
          <span className="ml-auto">
            <strong className="font-semibold text-[rgba(226,234,255,0.75)]">esc</strong> 닫기
          </span>
        </div>
      </div>
    </div>
  );
}
