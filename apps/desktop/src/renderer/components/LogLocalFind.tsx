import type { KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "../lib/cn";
import { Button, Input } from "../ui";

interface LocalFindShortcutInput {
  active: boolean;
  visible: boolean;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

interface LocalFindTextRange {
  start: number;
  end: number;
}

export interface LocalFindHighlightOptions {
  activeMatchIndex: number;
  matchIndexOffset: number;
  registerMatchRef?: (matchIndex: number) => (node: HTMLElement | null) => void;
  keyPrefix?: string;
}

export interface LocalFindRenderResult {
  nodes: ReactNode;
  matchCount: number;
}

interface LogLocalFindBarProps {
  inputRef: Ref<HTMLInputElement>;
  query: string;
  matchCount: number;
  activeMatchIndex: number;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  className?: string;
}

export function shouldOpenLogLocalFind(input: LocalFindShortcutInput): boolean {
  return (
    input.active &&
    input.visible &&
    !input.defaultPrevented &&
    !input.altKey &&
    (input.ctrlKey || input.metaKey) &&
    input.key.toLowerCase() === "f"
  );
}

export function getLocalFindMatchRanges(
  value: string,
  query: string,
): LocalFindTextRange[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const normalizedValue = value.toLowerCase();
  const ranges: LocalFindTextRange[] = [];
  let searchIndex = 0;
  while (searchIndex < normalizedValue.length) {
    const matchIndex = normalizedValue.indexOf(normalizedQuery, searchIndex);
    if (matchIndex < 0) {
      break;
    }
    ranges.push({
      start: matchIndex,
      end: matchIndex + normalizedQuery.length,
    });
    searchIndex = matchIndex + normalizedQuery.length;
  }
  return ranges;
}

export function countLocalFindMatches(value: string, query: string): number {
  return getLocalFindMatchRanges(value, query).length;
}

export function renderLocalFindHighlightedText(
  value: string,
  query: string,
  options: LocalFindHighlightOptions,
): LocalFindRenderResult {
  const ranges = getLocalFindMatchRanges(value, query);
  if (ranges.length === 0) {
    return {
      nodes: value,
      matchCount: 0,
    };
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      nodes.push(value.slice(cursor, range.start));
    }
    const matchIndex = options.matchIndexOffset + index;
    const active = matchIndex === options.activeMatchIndex;
    nodes.push(
      <mark
        key={`${options.keyPrefix ?? "match"}:${matchIndex}:${range.start}`}
        ref={options.registerMatchRef?.(matchIndex)}
        className={cn(
          "rounded-[4px] bg-[color-mix(in_srgb,#facc15_72%,transparent_28%)] px-[0.12em] text-[rgba(7,13,24,0.98)]",
          active
            ? "bg-[color-mix(in_srgb,#fb923c_88%,white_12%)] outline outline-2 outline-offset-1 outline-[var(--accent-strong)]"
            : "",
        )}
        data-local-find-match="true"
        data-local-find-active={active ? "true" : undefined}
      >
        {value.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }

  return {
    nodes,
    matchCount: ranges.length,
  };
}

export function LogLocalFindBar({
  inputRef,
  query,
  matchCount,
  activeMatchIndex,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
  className,
}: LogLocalFindBarProps) {
  const hasQuery = query.trim().length > 0;
  const matchLabel =
    hasQuery && matchCount > 0 ? `${activeMatchIndex + 1}/${matchCount}` : "0/0";

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevious();
        return;
      }
      onNext();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-[16px] border border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--surface-strong)_84%,var(--surface)_16%)] px-3 py-2 shadow-none",
        className,
      )}
      data-testid="log-local-find-bar"
    >
      <span className="text-[0.78rem] font-semibold uppercase tracking-[0.02em] text-[var(--text-soft)]">
        Find
      </span>
      <Input
        ref={inputRef}
        type="search"
        aria-label="현재 로그에서 찾기"
        className="min-h-9 min-w-[12rem] flex-1 rounded-[12px] px-3 py-2 text-[0.9rem]"
        value={query}
        placeholder="현재 로그에서 찾기"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span
        className="min-w-[3.5rem] text-center text-[0.84rem] font-semibold text-[var(--text-soft)]"
        aria-live="polite"
      >
        {matchLabel}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onPrevious}
        disabled={!hasQuery || matchCount === 0}
        aria-label="이전 로그 찾기 결과"
      >
        이전
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onNext}
        disabled={!hasQuery || matchCount === 0}
        aria-label="다음 로그 찾기 결과"
      >
        다음
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClose}
        aria-label="로그 찾기 닫기"
      >
        닫기
      </Button>
    </div>
  );
}
