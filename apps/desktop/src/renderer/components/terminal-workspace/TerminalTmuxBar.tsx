import { Columns2 } from '../../ui/icons';
import type { TmuxSessionInfo } from '../../store/types';
import {
  StatusBarIcon,
  statusBarActionButton,
  statusBarChrome,
  statusBarIconSize,
  statusBarSpacing,
} from './terminalStatusBarChrome';
import { TmuxSessionMenu } from './TmuxSessionMenu';

interface TerminalTmuxBarProps {
  /**
   * "tmux" 뒤에 끼우는 부가 정보(감지 바의 tmux 버전). 없으면 구분점째 생략한다 —
   * tmux 안에서는 이미 붙어서 들어온 것이라 버전을 반복해 보여줄 이유가 없다.
   */
  detail?: string;
  sessions: TmuxSessionInfo[];
  /** 세션 메뉴 트리거 라벨(감지 바는 "세션 N개", 푸터는 현재 세션명). */
  menuLabel: string;
  /** tmux 안일 때 지금 붙어 있는 세션 — 메뉴에서 강조된다. */
  activeName?: string;
  onCreateSession: (name: string) => void;
  onSelectSession: (name: string) => void;
  onKillSession?: (name: string) => void;
  onRefresh?: () => void;
  /** 우측 액션 — 라벨과 동작만 다르고 생김새는 공유한다(열기 / detach). */
  actionLabel: string;
  actionTitle?: string;
  onAction: () => void;
}

// tmux 하단 1줄 바의 단일 표현 컴포넌트.
//
// 같은 바가 두 자리에 뜬다 — ssh 접속 후 원격 tmux 를 감지했을 때(진입점: 열기)와,
// tmux 에 붙어 있을 때(세션 푸터: detach). 둘은 라벨과 동작만 다른데 예전에는 컴포넌트가
// 따로여서 아이콘·여백·버튼 hover·role 이 전부 갈라졌고, 사용자에게는 "연결 방식마다
// UI 가 다르게 생겼다"로 보였다. 생김새는 여기서만 정하고 호출부는 내용만 넘긴다.
export function TerminalTmuxBar({
  detail,
  sessions,
  menuLabel,
  activeName,
  onCreateSession,
  onSelectSession,
  onKillSession,
  onRefresh,
  actionLabel,
  actionTitle,
  onAction,
}: TerminalTmuxBarProps) {
  return (
    <div className={`${statusBarSpacing} ${statusBarChrome}`} role="status">
      <StatusBarIcon>
        <Columns2 className={statusBarIconSize} />
      </StatusBarIcon>
      <span className="font-medium text-[var(--text)]">tmux</span>
      <span aria-hidden>·</span>
      {detail ? (
        <>
          <span>{detail}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <TmuxSessionMenu
        sessions={sessions}
        activeName={activeName}
        triggerLabel={menuLabel}
        onCreateSession={onCreateSession}
        onSelectSession={onSelectSession}
        onKillSession={onKillSession}
        onRefresh={onRefresh}
      />
      <button
        type="button"
        className={statusBarActionButton}
        title={actionTitle}
        onClick={onAction}
      >
        {actionLabel}
      </button>
    </div>
  );
}
