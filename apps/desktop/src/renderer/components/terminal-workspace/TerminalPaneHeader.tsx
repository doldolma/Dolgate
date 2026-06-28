import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { IconButton } from '../../ui';

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
  /**
   * 좌우 분할(│). tmux pane 일 때만 전달된다 — 받으면 헤더 우측(× 옆)에 분할 버튼을
   * 노출한다. 일반 pane 은 undefined 라 버튼이 뜨지 않는다.
   */
  onSplitHorizontal?: () => void;
  /** 상하 분할(─). 위와 동일하게 tmux pane 일 때만 전달. */
  onSplitVertical?: () => void;
  actions?: ReactNode;
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
  onSplitHorizontal,
  onSplitVertical,
  actions,
}: TerminalPaneHeaderProps) {
  return (
    <div
      className={cn(
        'flex cursor-grab select-none items-center justify-between gap-2 rounded-t-[6px] border border-b-0 border-[color-mix(in_srgb,var(--border)_88%,transparent_12%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.55rem] pb-[0.4rem] pt-[0.4rem]',
        active &&
          'bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface-muted)_88%)]',
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
      <button
        type="button"
        className="min-w-0 flex-1 truncate bg-transparent text-left text-[0.9rem] font-semibold text-[var(--text)]"
        onClick={onFocus}
      >
        {title}
      </button>
      <div className="flex items-center gap-1.5">
        {actions}
        {onSplitHorizontal && onSplitVertical ? (
          <TerminalSplitButtons
            onSplitHorizontal={onSplitHorizontal}
            onSplitVertical={onSplitVertical}
          />
        ) : null}
        <IconButton
          aria-label={`${title} 세션 종료`}
          tone="ghost"
          size="sm"
          className="h-[1.55rem] w-[1.55rem] rounded-[6px] text-[0.9rem] text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)]"
          onClick={onClose}
          disabled={closingDisabled}
        >
          ×
        </IconButton>
      </div>
    </div>
  );
}

interface TerminalSplitButtonsProps {
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
}

// tmux pane 분할을 "발견 가능한 일급 동작"으로 노출하는 좌우(│)·상하(─) 버튼 쌍.
// 헤더 우측(× 옆)과, 헤더가 없는 단일 pane 의 floating 어포던스에서 공용으로 쓴다.
// tmux 용어(horizontal/vertical)는 노출하지 않고 방향을 아이콘으로만 표현한다.
// 클릭 시 onMouseDown 으로 drag 시작·pane 포커스 이동을 막아(stopPropagation)
// 분할 버튼이 헤더 drag 나 포커스 전환을 트리거하지 않게 한다.
export function TerminalSplitButtons({
  onSplitHorizontal,
  onSplitVertical,
}: TerminalSplitButtonsProps) {
  const stop = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };
  return (
    <>
      <IconButton
        aria-label="좌우로 분할"
        title="좌우 분할 (Ctrl-b %)"
        tone="ghost"
        size="sm"
        className="h-[1.55rem] w-[1.55rem] rounded-[6px] text-[0.9rem] leading-none text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)]"
        draggable={false}
        onMouseDown={stop}
        onClick={(event) => {
          event.stopPropagation();
          onSplitHorizontal();
        }}
      >
        <span aria-hidden>│</span>
      </IconButton>
      <IconButton
        aria-label="상하로 분할"
        title='상하 분할 (Ctrl-b ")'
        tone="ghost"
        size="sm"
        className="h-[1.55rem] w-[1.55rem] rounded-[6px] text-[0.9rem] leading-none text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)]"
        draggable={false}
        onMouseDown={stop}
        onClick={(event) => {
          event.stopPropagation();
          onSplitVertical();
        }}
      >
        <span aria-hidden>─</span>
      </IconButton>
    </>
  );
}
