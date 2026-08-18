import type { TmuxSessionInfo } from '../../store/types';
import { supportsTmuxControlMode } from '../../lib/tmux-version';
import { TerminalTmuxBar } from './TerminalTmuxBar';
import { useTranslation } from 'react-i18next';

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
//
// 생김새는 TerminalTmuxBar 가 소유한다 — 이 파일은 감지 상황의 값(버전·세션 수·열기)을
// 그 바에 맞춰 넘기는 어댑터다.
export function TerminalTmuxStatusBar({
  version,
  sessions,
  onOpen,
  onAttachSession,
  onCreateSession,
  onKillSession,
}: TerminalTmuxStatusBarProps) {
  const { t: translate } = useTranslation();
  const summary =
    sessions.length > 0
      ? translate('tmuxStatus.sessionCount', { count: sessions.length })
      : translate('tmuxStatus.noSessions');
  // control mode(2.6+) 를 쓸 수 있으면 세션 메뉴만으로 attach·생성이 다 되므로 버튼을
  // 두지 않는다. 미만 버전은 메뉴 경로가 전부 `tmux -CC` 라 쓸 수 없고, onOpen 만
  // passthrough 폴백을 갖고 있어 유일한 진입점이다 — 그때만 남긴다.
  const legacyOpenOnly = !supportsTmuxControlMode(version);

  return (
    <TerminalTmuxBar
      detail={version}
      sessions={sessions}
      menuLabel={summary}
      onCreateSession={onCreateSession}
      onSelectSession={onAttachSession}
      onKillSession={onKillSession}
      actionLabel={legacyOpenOnly ? translate('tmuxStatus.open') : undefined}
      onAction={legacyOpenOnly ? onOpen : undefined}
    />
  );
}
