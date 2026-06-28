import { cn } from '../../lib/cn';
import { Columns2 } from '../../ui/icons';
import type { TmuxSessionInfo } from '../../store/types';
import { TmuxSessionMenu } from './TmuxSessionMenu';

interface TmuxSessionFooterProps {
  sessionName: string;
  /** 원격 tmux 세션 목록(라이브). 세션 메뉴에 표시. */
  sessions: TmuxSessionInfo[];
  onDetach: () => void;
  /** 이름 지정 새 세션 생성(새 그룹 탭으로 연다). */
  onCreateSession: (name: string) => void;
  /** 다른 세션 선택 = 전환(새 그룹 탭으로 attach). */
  onSelectSession: (name: string) => void;
  /** 세션 종료(kill-session). */
  onKillSession: (name: string) => void;
  /** 메뉴 열 때 세션 목록 재조회. */
  onRefresh?: () => void;
}

// tmux 세션 그룹 하단 1줄 바: 세션 메뉴(목록/생성/전환/kill) + detach. 감지 하단바와
// 동일한 메뉴를 tmux 안에서도 제공한다. detach 는 서버 세션을 살린 채 control 채널만
// 분리(재attach 로 복원). 세션 kill 은 메뉴 항목 hover 시 ×.
export function TmuxSessionFooter({
  sessionName,
  sessions,
  onDetach,
  onCreateSession,
  onSelectSession,
  onKillSession,
  onRefresh,
}: TmuxSessionFooterProps) {
  return (
    <div className="mx-[0.55rem] mb-[0.55rem] mt-1 flex items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-[0.7rem] py-[0.25rem] text-[0.7rem] text-[var(--text-muted)]">
      <span className="leading-none text-[var(--accent)]" aria-hidden>
        <Columns2 className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-[var(--text)]">tmux</span>
      <span aria-hidden>·</span>
      <TmuxSessionMenu
        sessions={sessions}
        activeName={sessionName}
        triggerLabel={sessionName}
        onCreateSession={onCreateSession}
        onSelectSession={onSelectSession}
        onKillSession={onKillSession}
        onRefresh={onRefresh}
      />
      <button
        type="button"
        className={cn(
          'ml-auto rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-[0.55rem] py-[0.25rem] text-[var(--text)] transition-colors',
          'hover:border-[var(--accent)] hover:text-[var(--accent)]',
        )}
        title="detach — 세션은 유지하고 분리(Ctrl-b d). 재접속으로 복원."
        onClick={onDetach}
      >
        detach
      </button>
    </div>
  );
}
