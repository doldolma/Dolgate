import type { CSSProperties, DragEventHandler, RefObject } from 'react';
import { cn } from '../../lib/cn';
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
  paneSlots: TerminalWorkspacePaneSlot[];
  handles: SplitHandlePlacement[];
  /** tmux 워크스페이스: 핸들 히트영역(12px)은 유지하되 보이는 바를 얇은 가운데 선으로.
   *  좁은 tmux pane 거터에서 꽉 찬 액센트 바가 경계 글자와 겹쳐 보이는 것을 막는다. */
  tmuxThinHandles?: boolean;
  /** 지금 끌고 있는 split id. 드래그 중에는 포인터가 핸들을 벗어나도 선을 유지한다. */
  resizingSplitId?: string | null;
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
  paneSlots,
  handles,
  tmuxThinHandles = false,
  resizingSplitId = null,
  onStartResizeHandle,
  dropPreview,
}: TerminalWorkspaceLayoutProps) {
  return (
    <div
      ref={workspaceRef}
      className={className}
      style={style}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
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
              'absolute z-[5] before:absolute before:content-[""] before:transition-colors',
              // 어느 쪽이든 가운데 2px 선이고, 평소에는 투명하다.
              //
              // 예전에는 tmux 가 아닌 워크스페이스에서 핸들 영역(12px)을 꽉 채운 둥근 바를
              // 그렸다. pane 여백이 넉넉하다는 전제였는데, 여백을 줄이자 그 바가 pane 경계에
              // 붙어 "사이에 뭔가 끼어 있다"로 보였다. 빈 곳은 배경이 그대로 보이는 편이
              // 깔끔하고, 끌 수 있다는 것은 커서 모양(col/row-resize)이 이미 알려 준다.
              handle.axis === 'horizontal'
                ? 'before:left-1/2 before:top-0 before:bottom-0 before:w-[2px] before:-translate-x-1/2'
                : 'before:top-1/2 before:left-0 before:right-0 before:h-[2px] before:-translate-y-1/2',
              // 올리거나 끄는 동안에만 선을 보여준다. 끄는 중에는 포인터가 핸들을 벗어나므로
              // hover 로는 유지되지 않아 드래그 중인 id 를 따로 받는다.
              resizingSplitId === handle.splitId
                ? 'before:bg-[color-mix(in_srgb,var(--accent-strong)_55%,transparent_45%)]'
                : cn(
                    'before:bg-transparent',
                    tmuxThinHandles &&
                      'before:bg-[color-mix(in_srgb,var(--accent-strong)_45%,transparent_55%)]',
                    'hover:before:bg-[color-mix(in_srgb,var(--accent-strong)_45%,transparent_55%)]',
                  ),
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
