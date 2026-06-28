import type { TmuxSessionInfo } from '../../store/types';
import { TmuxSessionMenu } from './TmuxSessionMenu';

interface TerminalTmuxStatusBarProps {
  version: string;
  sessions: TmuxSessionInfo[];
  /** control mode 새 세션(기본 dolgate) 진입. */
  onOpen: () => void;
  /** 감지된 특정 세션 이름으로 control mode attach. */
  onAttachSession: (name: string) => void;
  /** 이름 지정 신규 tmux 세션 생성(new-session -s <name>). */
  onCreateSession: (name: string) => void;
  /** 감지된 원격 tmux 세션을 attach 없이 종료(kill-session, 보조 exec 채널). */
  onKillSession?: (name: string) => void;
}

// SSH 접속 후 보조채널로 감지한 원격 tmux 를 알리는 하단 1줄 바. tmux 의 status line
// 을 GUI 로 옮긴 진입점 — "열기"로 기본 control 세션을, 세션 메뉴에서 감지된 세션
// attach / 이름 지정 새 세션 생성. (tmux 안에서는 같은 메뉴를 세션 푸터가 제공한다.)
export function TerminalTmuxStatusBar({
  version,
  sessions,
  onOpen,
  onAttachSession,
  onCreateSession,
  onKillSession,
}: TerminalTmuxStatusBarProps) {
  const summary = sessions.length > 0 ? `세션 ${sessions.length}개` : '세션 없음';

  return (
    <div
      className="mx-[0.55rem] mb-[0.55rem] flex items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-[0.7rem] py-[0.25rem] text-[0.7rem] text-[var(--text-muted)]"
      role="status"
    >
      <span
        className="leading-none"
        style={{ color: 'var(--accent, #6aa84f)' }}
        aria-hidden
      >
        ▤
      </span>
      <span className="font-medium text-[var(--text)]">tmux</span>
      <span aria-hidden>·</span>
      <span>{version}</span>
      <span aria-hidden>·</span>
      <TmuxSessionMenu
        sessions={sessions}
        triggerLabel={summary}
        onCreateSession={onCreateSession}
        onSelectSession={onAttachSession}
        onKillSession={onKillSession}
      />
      <button
        type="button"
        onClick={onOpen}
        className="ml-auto rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-[0.55rem] py-[0.25rem] text-[0.7rem] font-medium text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--surface)_80%,var(--text)_20%)]"
      >
        열기
      </button>
    </div>
  );
}
