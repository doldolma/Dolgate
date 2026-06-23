import { useEffect, useRef, useState } from 'react';
import type { TmuxSessionInfo } from '../../store/types';
import { cn } from '../../lib/cn';

interface TmuxSessionMenuProps {
  /** 원격 tmux 세션 목록. */
  sessions: TmuxSessionInfo[];
  /** 현재 attach 중인 세션 이름(목록에서 강조 + 클릭 시 no-op). */
  activeName?: string;
  /** 트리거 버튼 라벨(감지바="세션 N개", 푸터=현재 세션명). */
  triggerLabel: string;
  /** 이름 지정 새 세션 생성(new-session -s <name>). */
  onCreateSession: (name: string) => void;
  /** 세션 선택 = attach/전환. 현재 세션 클릭은 호출되지 않는다. */
  onSelectSession: (name: string) => void;
  /** 있으면 항목 hover 시 × 로 kill-session. 감지바(SSH)는 미전달. */
  onKillSession?: (name: string) => void;
  /** 드롭다운을 열 때 세션 목록을 재조회한다(있을 때만). */
  onRefresh?: () => void;
}

// tmux 세션 메뉴(목록 + 새 세션 생성 + 선택/전환 + 선택적 kill). 감지 하단바와 tmux
// 세션 푸터가 동일하게 쓴다. 양쪽 다 하단바라 드롭다운은 위로 펼친다.
export function TmuxSessionMenu({
  sessions,
  activeName,
  triggerLabel,
  onCreateSession,
  onSelectSession,
  onKillSession,
  onRefresh,
}: TmuxSessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 바깥 클릭 / ESC 로 닫는다.
  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const submitNewSession = () => {
    const name = newSessionName.trim();
    if (!name) {
      return;
    }
    onCreateSession(name);
    setNewSessionName('');
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() =>
          setOpen((value) => {
            const next = !value;
            if (next) {
              onRefresh?.(); // 열 때 세션 목록 재pull(다른 연결의 새 세션 반영).
            }
            return next;
          })
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-[4px] px-[0.3rem] py-[0.05rem] text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--surface)_80%,var(--text)_20%)]"
      >
        <span className="max-w-[16rem] truncate">{triggerLabel}</span>
        <span aria-hidden className="text-[0.6rem]">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+0.3rem)] left-0 z-20 min-w-[16rem] max-w-[24rem] overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--surface)] shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
        >
          {/* 새 세션 만들기 — 이름 입력 후 Enter (new-session -s <name>). */}
          <div className="border-b border-[var(--border)] px-[0.7rem] py-[0.4rem]">
            <input
              autoFocus
              value={newSessionName}
              onChange={(event) => setNewSessionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitNewSession();
                } else if (event.key === 'Escape') {
                  setNewSessionName('');
                  setOpen(false);
                }
              }}
              placeholder="새 세션 이름 입력 후 Enter"
              aria-label="새 tmux 세션 이름"
              className="w-full rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-[0.45rem] py-[0.2rem] text-[0.7rem] text-[var(--text)] outline-none focus:border-[var(--accent,#6aa84f)]"
            />
          </div>
          <div className="border-b border-[var(--border)] px-[0.7rem] py-[0.3rem] text-[0.62rem] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            원격 tmux 세션
          </div>
          {sessions.length === 0 ? (
            <div className="px-[0.7rem] py-[0.45rem] text-[0.66rem] text-[var(--text-muted)]">
              감지된 세션이 없습니다
            </div>
          ) : (
            <ul className="max-h-[14rem] overflow-y-auto py-[0.2rem]">
              {sessions.map((session) => {
                const isActive = session.name === activeName;
                return (
                  <li
                    key={session.name}
                    className="group/sess flex items-center"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        if (!isActive) {
                          onSelectSession(session.name);
                        }
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 px-[0.7rem] py-[0.32rem] text-left text-[0.7rem] text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--surface)_82%,var(--text)_18%)]"
                    >
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate',
                          isActive
                            ? 'font-semibold text-[var(--accent)]'
                            : 'font-medium',
                        )}
                      >
                        {session.name}
                      </span>
                      <span className="shrink-0 text-[0.64rem] text-[var(--text-muted)]">
                        창 {session.windows}
                      </span>
                      {isActive ? (
                        <span className="shrink-0 text-[0.58rem] font-medium text-[var(--accent)]">
                          현재
                        </span>
                      ) : session.attached ? (
                        <span
                          className="shrink-0 rounded-[3px] border border-[var(--border)] px-[0.28rem] py-[0.02rem] text-[0.58rem] text-[var(--text-muted)]"
                          title="다른 클라이언트가 attach 중"
                        >
                          attached
                        </span>
                      ) : null}
                    </button>
                    {onKillSession ? (
                      <button
                        type="button"
                        title="세션 종료 (kill-session)"
                        aria-label={`${session.name} 세션 종료`}
                        onClick={() => onKillSession(session.name)}
                        className="mr-[0.35rem] shrink-0 rounded-[3px] px-[0.32rem] py-[0.02rem] text-[0.78rem] leading-none text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--danger,#d9534f)] group-hover/sess:opacity-100"
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
