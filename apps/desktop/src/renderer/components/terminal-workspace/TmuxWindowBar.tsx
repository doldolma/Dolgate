import { useEffect, useRef, useState } from 'react';
import type { WorkspaceTab } from '../../store/types';
import { cn } from '../../lib/cn';
import { Columns2, Plus, Rows2, X } from '../../ui/icons';
import { useTranslation } from 'react-i18next';

interface TmuxWindowBarProps {
  /** 같은 tmux 세션(control)의 window WorkspaceTab 들. index 순 정렬되어 들어온다. */
  windows: WorkspaceTab[];
  activeWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onNewWindow: () => void;
  onClose: (workspaceId: string) => void;
  onRename: (workspaceId: string, name: string) => void;
  /** 활성 pane 좌우 분할(Ctrl-b %). */
  onSplitHorizontal: () => void;
  /** 활성 pane 상하 분할(Ctrl-b "). */
  onSplitVertical: () => void;
}

// tmux 세션 그룹의 윈도우 목록 sub-strip(상단 세션 탭 아래). 칩 = 윈도우(index:name),
// 활성 강조, × 닫기(kill-window), 더블클릭 rename, + 새 윈도우(new-window),
// 오른쪽에 활성 pane 분할 버튼.
export function TmuxWindowBar({
  windows,
  activeWorkspaceId,
  onSelect,
  onNewWindow,
  onClose,
  onRename,
  onSplitHorizontal,
  onSplitVertical,
}: TmuxWindowBarProps) {
  const { t: translate } = useTranslation();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renamingId]);

  const startRename = (workspace: WorkspaceTab) => {
    setRenamingId(workspace.id);
    setDraft(workspace.tmux?.name ?? '');
  };

  const commitRename = () => {
    if (renamingId && draft.trim()) {
      onRename(renamingId, draft.trim());
    }
    setRenamingId(null);
  };

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-2 py-1"
      role="tablist"
      aria-label={translate('tmuxBar.aria')}
    >
      {windows.map((workspace) => {
        const active = workspace.id === activeWorkspaceId;
        const label =
          workspace.tmux?.name && workspace.tmux.name.length > 0
            ? `${workspace.tmux.index ?? 0}:${workspace.tmux.name}`
            : `${workspace.tmux?.index ?? 0}`;
        if (renamingId === workspace.id) {
          return (
            <input
              key={workspace.id}
              ref={inputRef}
              className="w-28 rounded-[4px] border border-[var(--accent)] bg-[var(--surface)] px-1.5 py-0.5 text-[0.7rem] text-[var(--text)] outline-none"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setRenamingId(null);
                }
              }}
            />
          );
        }
        return (
          <div
            key={workspace.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={cn(
              'group flex shrink-0 items-center gap-1 rounded-[4px] border px-2 py-0.5 text-[0.7rem] transition-colors',
              active
                ? 'border-[var(--accent)] bg-[var(--surface)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-muted)] hover:border-[var(--border)] hover:text-[var(--text)]',
            )}
            onClick={() => onSelect(workspace.id)}
            onDoubleClick={() => startRename(workspace)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(workspace.id);
              }
            }}
            title={translate('tmuxBar.windowTitle', { label })}
          >
            <span className="max-w-[12rem] truncate">{label}</span>
            <button
              type="button"
              className="rounded px-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--danger-text)] group-hover:opacity-100"
              title={translate('tmuxBar.closeWindow')}
              onClick={(event) => {
                event.stopPropagation();
                onClose(workspace.id);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[0.82rem] leading-none text-[var(--text-muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)]"
        title={translate('tmuxBar.newWindow')}
        onClick={onNewWindow}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {/* 활성 pane 분할 — 오른쪽에 라벨이 있는 명확한 버튼으로(기존 헷갈리던 │ 대체). */}
      <span className="mx-1 h-3.5 w-px shrink-0 bg-[var(--border)]" aria-hidden />
      <button
        type="button"
        className="shrink-0 rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[0.7rem] text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        title={translate('tmuxBar.splitHorizontalTitle')}
        onClick={onSplitHorizontal}
      >
        <span className="inline-flex items-center gap-1">
          <Columns2 className="h-3.5 w-3.5" />
          {translate('tmuxBar.splitHorizontal')}
        </span>
      </button>
      <button
        type="button"
        className="shrink-0 rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[0.7rem] text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        title={translate('tmuxBar.splitVerticalTitle')}
        onClick={onSplitVertical}
      >
        <span className="inline-flex items-center gap-1">
          <Rows2 className="h-3.5 w-3.5" />
          {translate('tmuxBar.splitVertical')}
        </span>
      </button>
    </div>
  );
}
