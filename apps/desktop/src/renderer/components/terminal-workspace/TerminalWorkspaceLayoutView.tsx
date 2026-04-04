import type { DragEventHandler, RefObject } from 'react';
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
  onStartResizeHandle: (handle: SplitHandlePlacement) => void;
  dropPreview: DropPreview | null;
}

export function TerminalWorkspaceLayoutView({
  workspaceRef,
  className,
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
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {shouldShowBroadcastControl ? (
        <div className="terminal-workspace__broadcast-control">
          <Button
            variant="secondary"
            size="sm"
            className={`terminal-workspace__broadcast-toggle min-h-10 rounded-full px-3.5 ${
              isWorkspaceBroadcastEnabled
                ? 'border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] bg-[color-mix(in_srgb,var(--accent-strong)_14%,var(--surface))] text-[var(--accent-strong)]'
                : ''
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
              className="terminal-workspace__broadcast-toggle-icon"
              aria-hidden="true"
            >
              <svg viewBox="0 0 16 16" focusable="false">
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
              className="terminal-workspace__broadcast-tooltip"
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
            className={`workspace-split-handle ${
              handle.axis === 'horizontal' ? 'vertical' : 'horizontal'
            }`}
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
          className="workspace-drop-preview"
          style={toPercentRectStyle(dropPreview.rect)}
        />
      ) : null}
    </div>
  );
}
