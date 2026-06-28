import type { CSSProperties, DragEventHandler, RefObject } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../../ui';
import type {
  DropPreview,
  SplitHandlePlacement,
  TerminalWorkspacePaneSlot,
} from './types';
import { toPercentRectStyle } from './terminalWorkspaceLayout';

interface TerminalWorkspaceLayoutProps {
  workspaceRef: RefObject<HTMLDivElement | null>;
  className: string;
  style?: CSSProperties;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  shouldShowBroadcastControl: boolean;
  isWorkspaceBroadcastEnabled: boolean;
  isBroadcastToggleDisabled: boolean;
  broadcastButtonLabel: string;
  broadcastTooltipText: string;
  broadcastTooltipId?: string;
  isBroadcastTooltipVisible: boolean;
  onBroadcastTooltipVisibleChange: (visible: boolean) => void;
  onToggleBroadcast: () => void;
  paneSlots: TerminalWorkspacePaneSlot[];
  handles: SplitHandlePlacement[];
  /** tmux 워크스페이스: 핸들 히트영역(12px)은 유지하되 보이는 바를 얇은 가운데 선으로.
   *  좁은 tmux pane 거터에서 꽉 찬 액센트 바가 경계 글자와 겹쳐 보이는 것을 막는다. */
  tmuxThinHandles?: boolean;
  onStartResizeHandle: (handle: SplitHandlePlacement) => void;
  dropPreview: DropPreview | null;
}

export function TerminalWorkspaceLayoutView({
  workspaceRef,
  className,
  style,
  onDragLeave,
  onDragOver,
  onDrop,
  shouldShowBroadcastControl,
  isWorkspaceBroadcastEnabled,
  isBroadcastToggleDisabled,
  broadcastButtonLabel,
  broadcastTooltipText,
  broadcastTooltipId,
  isBroadcastTooltipVisible,
  onBroadcastTooltipVisibleChange,
  onToggleBroadcast,
  paneSlots,
  handles,
  tmuxThinHandles = false,
  onStartResizeHandle,
  dropPreview,
}: TerminalWorkspaceLayoutProps) {
  const showBroadcastTooltip = (visible: boolean) => {
    onBroadcastTooltipVisibleChange(visible);
  };

  return (
    <div
      ref={workspaceRef}
      className={className}
      style={style}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {shouldShowBroadcastControl ? (
        <div className="absolute right-[6.1rem] top-3 z-[5] flex flex-col items-end gap-[0.4rem]">
          <Button
            variant="secondary"
            size="sm"
            className={`h-[2.35rem] w-[2.35rem] min-h-0 rounded-full border px-0 shadow-[0_10px_22px_rgba(0,0,0,0.16)] ${
              isWorkspaceBroadcastEnabled
                ? 'border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] bg-[color-mix(in_srgb,var(--accent-strong)_14%,var(--surface))] text-[var(--accent-strong)]'
                : 'bg-[color-mix(in_srgb,var(--surface)_90%,transparent_10%)]'
            }`}
            aria-label={broadcastButtonLabel}
            aria-pressed={isWorkspaceBroadcastEnabled}
            aria-disabled={isBroadcastToggleDisabled}
            aria-describedby={
              isBroadcastTooltipVisible && broadcastTooltipId
                ? broadcastTooltipId
                : undefined
            }
            onMouseEnter={() => {
              showBroadcastTooltip(true);
            }}
            onMouseLeave={() => {
              showBroadcastTooltip(false);
            }}
            onFocus={() => {
              showBroadcastTooltip(true);
            }}
            onBlur={() => {
              showBroadcastTooltip(false);
            }}
            onClick={() => {
              if (isBroadcastToggleDisabled) {
                return;
              }
              onToggleBroadcast();
            }}
          >
            <span
              className="inline-grid h-4 w-4 place-items-center"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 16 16"
                focusable="false"
                className="h-4 w-4 stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.4]"
              >
                <circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none" />
                <path d="M4.85 5.35a3.75 3.75 0 0 1 0 5.3" />
                <path d="M11.15 5.35a3.75 3.75 0 0 0 0 5.3" />
                <path d="M2.7 3.3a6.75 6.75 0 0 1 0 9.4" />
                <path d="M13.3 3.3a6.75 6.75 0 0 0 0 9.4" />
              </svg>
            </span>
          </Button>
          {isBroadcastTooltipVisible && broadcastTooltipId ? (
            <div
              id={broadcastTooltipId}
              role="tooltip"
              className="pointer-events-none max-w-[min(15rem,calc(100vw-2rem))] rounded-[10px] border border-[color-mix(in_srgb,var(--border)_88%,transparent_12%)] bg-[color-mix(in_srgb,var(--surface)_94%,transparent_6%)] px-[0.7rem] py-[0.4rem] text-[0.76rem] leading-[1.35] whitespace-nowrap text-[var(--text)] shadow-[0_14px_28px_rgba(0,0,0,0.16)]"
            >
              {broadcastTooltipText}
            </div>
          ) : null}
        </div>
      ) : null}

      {paneSlots.map((slot) => (
        <div
          key={slot.key}
          className={slot.className}
          data-terminal-pane-slot={slot.style ? 'true' : undefined}
          style={slot.style}
          onDragOver={slot.onDragOver}
          onDrop={slot.onDrop}
        >
          {slot.content}
        </div>
      ))}

      {handles.map((handle) => {
        const style =
          handle.axis === 'horizontal'
            ? {
                left: `${(handle.rect.x + handle.rect.width * handle.ratio) * 100}%`,
                top: `${handle.rect.y * 100}%`,
                height: `${handle.rect.height * 100}%`,
              }
            : {
                top: `${(handle.rect.y + handle.rect.height * handle.ratio) * 100}%`,
                left: `${handle.rect.x * 100}%`,
                width: `${handle.rect.width * 100}%`,
              };

        return (
          <div
            key={handle.splitId}
            className={cn(
              'absolute z-[5] before:absolute before:content-[""]',
              // tmux: 가운데 2px 선(거터 안에 들어가 글자와 안 겹침). 그 외: 핸들 영역을
              // 꽉 채운 둥근 바(넉넉한 pane 여백이 있어 겹치지 않음).
              tmuxThinHandles
                ? cn(
                    'before:bg-[color-mix(in_srgb,var(--accent-strong)_45%,transparent_55%)]',
                    handle.axis === 'horizontal'
                      ? 'before:left-1/2 before:top-0 before:bottom-0 before:w-[2px] before:-translate-x-1/2'
                      : 'before:top-1/2 before:left-0 before:right-0 before:h-[2px] before:-translate-y-1/2',
                  )
                : 'before:inset-0 before:rounded-full before:bg-[color-mix(in_srgb,var(--accent-strong)_22%,transparent_78%)]',
              handle.axis === 'horizontal'
                ? 'w-[12px] -ml-[6px] cursor-col-resize'
                : 'h-[12px] -mt-[6px] cursor-row-resize',
            )}
            data-workspace-split-handle="true"
            data-axis={handle.axis}
            style={style}
            onMouseDown={(event) => {
              event.preventDefault();
              onStartResizeHandle(handle);
            }}
          />
        );
      })}

      {dropPreview ? (
        <div
          className="pointer-events-none absolute z-[4] rounded-[12px] border border-[color-mix(in_srgb,var(--accent-strong)_46%,transparent_54%)] bg-[color-mix(in_srgb,var(--accent-strong)_18%,transparent_82%)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_14%,transparent_86%)]"
          data-workspace-drop-preview="true"
          style={toPercentRectStyle(dropPreview.rect)}
        />
      ) : null}
    </div>
  );
}
