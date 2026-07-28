import type { TmuxSessionInfo } from '../../store/types';
import { TerminalTmuxBar } from './TerminalTmuxBar';
import { useTranslation } from 'react-i18next';

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
//
// 생김새는 TerminalTmuxBar 가 소유한다 — 이 파일은 tmux 안의 값(현재 세션명·detach)을
// 그 바에 맞춰 넘기는 어댑터다. 버전은 넘기지 않는다(이미 붙어서 들어온 상태).
export function TmuxSessionFooter({
  sessionName,
  sessions,
  onDetach,
  onCreateSession,
  onSelectSession,
  onKillSession,
  onRefresh,
}: TmuxSessionFooterProps) {
  const { t: translate } = useTranslation();

  return (
    <TerminalTmuxBar
      sessions={sessions}
      menuLabel={sessionName}
      activeName={sessionName}
      onCreateSession={onCreateSession}
      onSelectSession={onSelectSession}
      onKillSession={onKillSession}
      onRefresh={onRefresh}
      actionLabel={translate('tmuxStatus.detach')}
      actionTitle={translate('misc.detachTitle')}
      onAction={onDetach}
    />
  );
}
