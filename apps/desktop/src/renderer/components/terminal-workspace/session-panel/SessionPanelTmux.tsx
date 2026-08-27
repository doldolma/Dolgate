// tmux 섹션. 예전에는 하단바 두 개(감지 바 · 세션 푸터)와 그 안의 드롭다운이 하던 일이다.
//
// 하단바에서 뺀 이유: 세션을 고르고 만들고 죽이는 것은 **목록을 놓고 하는 일**인데, 한 줄 바에
// 담으려니 드롭다운을 띄워야 했고 같은 메뉴가 두 자리(감지 바 · 푸터)에 각각 붙어 있었다.
// 하단에는 지금 상태를 말하는 칩 하나만 남기고, 목록은 여기서 편다.
//
// 창(window) 전환은 여기 없다 — 그것은 상단 창 탭(TmuxWindowBar)의 몫이다. 탭 한 번이면 되는
// 일을 패널로 옮기면 두 단계가 된다.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../store/appStore';
import { supportsTmuxControlMode } from '../../../lib/tmux-version';
import { refreshTmuxSessions } from '../../../services/desktop/terminal';
import { cn } from '../../../lib/cn';
import { Button, Input, Tooltip } from '../../../ui';
import { LogOut, RefreshCw, X } from '../../../ui/icons';
import { listWorkspaceSessionIds } from '../terminalWorkspaceLayout';
import { BOOTSTRAP_TERMINAL_SIZE } from '../../terminal-resize';
import { SessionPanelEmpty } from './SessionPanelEmpty';

interface SessionPanelTmuxProps {
  /** 패널이 보고 있는 세션. */
  sessionId: string;
}

const ACTION_CLASS =
  'grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)]';

/**
 * control mode floor(2.6) 미만 tmux 를 일반 SSH 세션으로 띄울 때 접속 직후 셸에 자동 입력하는
 * 호환 attach-or-create 명령. 모든 tmux 버전에서 동작한다(attach 실패 시 new 로 폴백).
 * 1.8+ 면 `tmux new -A` 한 줄로도 되지만, floor 미만 환경의 폭넓은 호환을 위해 가장 보수적인
 * 형태를 쓴다.
 */
const PASSTHROUGH_TMUX_COMMAND = 'tmux attach 2>/dev/null || tmux new';

/** tmux 세션 이름을 셸에 넘길 때 감싼다 — 이름에 따옴표가 들어와도 인젝션이 되지 않게. */
function quote(name: string): string {
  return `'${name.replace(/'/g, "'\\''")}'`;
}

export function SessionPanelTmux({ sessionId }: SessionPanelTmuxProps) {
  const { t: translate } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const tabs = useAppStore((state) => state.tabs);
  const tmuxGroups = useAppStore((state) => state.tmuxGroups);
  const workspaces = useAppStore((state) => state.workspaces);
  const connectHost = useAppStore((state) => state.connectHost);
  const killTmuxSession = useAppStore((state) => state.killTmuxSession);
  const detachTmuxWorkspace = useAppStore((state) => state.detachTmuxWorkspace);
  const [newName, setNewName] = useState('');

  const tab = useMemo(
    () => tabs.find((entry) => entry.sessionId === sessionId) ?? null,
    [sessionId, tabs],
  );
  // 붙어 있는 상태인가 — 이 세션이 control mode pane 이면 그 그룹이 현재 tmux 세션이다.
  const workspace = useMemo(
    () =>
      workspaces.find((entry) =>
        listWorkspaceSessionIds(entry.layout).includes(sessionId),
      ) ?? null,
    [sessionId, workspaces],
  );
  const group = useMemo(() => {
    const controlSessionId = workspace?.tmux?.controlSessionId;
    if (!controlSessionId) {
      return null;
    }
    return (
      tmuxGroups.find((entry) => entry.controlSessionId === controlSessionId) ?? null
    );
  }, [tmuxGroups, workspace?.tmux?.controlSessionId]);

  const detected = tab?.tmuxAvailable ?? null;
  const version = group?.tmuxVersion ?? detected?.version ?? null;
  const sessions = group?.sessions ?? detected?.sessions ?? [];
  const hostId = group?.hostId ?? tab?.hostId ?? null;
  const attachedName = group?.sessionName ?? null;

  /**
   * connectHost 를 이 섹션에서 부르는 **단 한 곳**.
   *
   * connectHost 는 위치 인자가 열 개고 그중 여럿이 tmux 전용이라, 호출부마다 `undefined` 를
   * 세어 채우면 한 칸만 밀려도 뜻이 조용히 바뀐다(예: replaceSessionId 자리에 값이 들어가면
   * 지금 보고 있는 탭을 닫아 버린다). 이름 있는 필드로 받아 여기서 한 번만 자리를 맞춘다.
   */
  function openTmuxTab(options: {
    /** control mode 로 붙을 때 실행할 tmux 명령. passthrough 경로는 넘기지 않는다. */
    controlModeCommand?: string;
    /** 이 세션이 있던 탭 자리를 물려받는다(그 탭은 사라진다). */
    replaceSessionId?: string;
    /** control mode 를 못 쓰는 버전에서 접속 직후 셸에 타이핑할 명령. */
    startupCommandOverride?: string;
  }): void {
    if (!hostId) {
      return;
    }
    const controlMode = options.controlModeCommand !== undefined;
    void connectHost(
      hostId,
      BOOTSTRAP_TERMINAL_SIZE.cols,
      BOOTSTRAP_TERMINAL_SIZE.rows,
      undefined,
      controlMode,
      options.controlModeCommand,
      options.replaceSessionId,
      undefined,
      controlMode ? (version ?? undefined) : undefined,
      options.startupCommandOverride,
    );
  }

  /**
   * 세션에 붙는다. **늘 새 탭**으로 연다 — 지금 보고 있는 세션(SSH 든 다른 tmux 든)을 닫지
   * 않는다. 탭 자리를 재사용하면 tmux 를 열어 보려다 원래 셸을 잃는다.
   */
  function attach(name: string): void {
    openTmuxTab({ controlModeCommand: `tmux -CC attach -t ${quote(name)}` });
  }

  function create(): void {
    const name = newName.trim();
    if (!hostId || !name) {
      return;
    }
    // strict new — 이름이 겹치면 tmux 가 에러를 내고 연결 실패로 보인다(조용히 붙지 않는다).
    // attach 와 같이 새 탭으로 연다.
    openTmuxTab({ controlModeCommand: `tmux -CC new-session -s ${quote(name)}` });
    setNewName('');
  }

  /**
   * control mode 를 못 쓰는 tmux(2.6 미만)의 유일한 진입점. 일반 SSH 세션으로 열고 접속 직후
   * 호환 attach-or-create 명령을 자동 입력한다(passthrough). 원래 탭 자리를 물려받아 "이 화면에서
   * 계속" 이 된다.
   */
  function openLegacy(): void {
    if (!tab) {
      return;
    }
    openTmuxTab({
      replaceSessionId: tab.sessionId,
      startupCommandOverride: PASSTHROUGH_TMUX_COMMAND,
    });
  }

  if (!tab || !hostId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.tmux.emptyTitle')}
          description={translate('sessionPanel.tmux.noHost')}
        />
      </div>
    );
  }

  if (!group && !detected) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.tmux.emptyTitle')}
          description={translate('sessionPanel.tmux.notDetected')}
        />
      </div>
    );
  }

  const legacyOnly = !supportsTmuxControlMode(version ?? undefined);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 버전은 회색 문장 한 줄을 차지하지 않고 목록 머리에 붙인다 — 이 섹션에서 자주 할 일은
          세션을 고르는 것이고, 버전은 한 번 보면 되는 값이다. */}
      <div className="flex items-center gap-1 px-2.5 pb-1 pt-1.5">
        <span className="min-w-0 flex-1 truncate text-[0.68rem] text-[var(--text-soft)]">
          {version ? `tmux ${version}` : null}
        </span>
        <Tooltip label={translate('sessionPanel.tmux.refresh')}>
          <button
            type="button"
            aria-label={translate('sessionPanel.tmux.refresh')}
            className={ACTION_CLASS}
            disabled={refreshing}
            onClick={() => {
              // 목록은 이벤트로 돌아오므로 "언제 끝났는지" 를 알 수 없다. 잠깐 도는 표시만
              // 준다 — 눌렀는지조차 알 수 없던 것이 이 버튼의 문제였다.
              setRefreshing(true);
              void Promise.resolve(refreshTmuxSessions(sessionId)).finally(() => {
                window.setTimeout(() => setRefreshing(false), 600);
              });
            }}
          >
            <RefreshCw
              className={cn('h-3 w-3', refreshing && 'animate-spin')}
              aria-hidden
            />
          </button>
        </Tooltip>
        {group && workspace ? (
          <Tooltip label={translate('misc.detachTitle')}>
            <button
              type="button"
              aria-label={translate('tmuxStatus.detach')}
              className={ACTION_CLASS}
              onClick={() => void detachTmuxWorkspace(workspace.id)}
            >
              <LogOut className="h-3 w-3" aria-hidden />
            </button>
          </Tooltip>
        ) : null}
      </div>

      {/* 새 세션 입력은 목록 위, 헤더 바로 아래다 — 목록이 짧을 때 아래에 두면 빈 공간
          건너 멀리 떨어져 보인다. 입력은 늘 열려 있다(버튼을 눌러 여는 단계를 두면 가장
          단순한 동작에 뎁스가 하나 생긴다).
          크기는 **이 패널의 검색창과 같은 값**을 쓴다(SessionPanelSearch: min-h-9 · rounded-9 ·
          text-0.78rem). 기본 Input 은 폼용 44px 이라 좁은 패널에서 혼자 커 보이고, 손으로 다른
          값을 고르면 같은 패널 안에서 입력마다 크기가 달라진다. */}
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 py-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={translate('sessionPanel.tmux.namePlaceholder')}
          aria-label={translate('sessionPanel.tmux.namePlaceholder')}
          className="min-h-9 min-w-0 flex-1 rounded-[9px] px-2.5 py-1.5 text-[0.78rem]"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              create();
            }
          }}
        />
        {/* Button sm 도 같은 높이(min-h-9)라 그대로 쓰면 입력과 나란히 맞는다. */}
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0 rounded-[9px] px-3 text-[0.78rem]"
          disabled={!newName.trim()}
          onClick={create}
        >
          {translate('sessionPanel.tmux.create')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {sessions.length === 0 ? (
          <p className="px-2.5 py-2 text-[0.75rem] leading-[1.5] text-[var(--text-soft)]">
            {translate('sessionPanel.tmux.noSessions')}
          </p>
        ) : (
          sessions.map((session) => {
            const active = session.name === attachedName;
            const label = active
              ? translate('sessionPanel.tmux.currentScreen')
              : translate('sessionPanel.tmux.attachTo', { name: session.name });
            return (
              // 행 전체가 "이 세션으로" 다 — 이 섹션에서 하는 일이 거의 그것뿐이라 버튼을 따로
              // 두지 않는다. 종료(×)만 안쪽 버튼으로 남고, 그 클릭은 행까지 번지지 않는다.
              // 행 전체가 하나의 버튼이 아니라, **누르는 영역이 버튼**이고 종료(×)는 그 옆에
              // 나란히 둔다. 예전에는 행에 role="button" 을 주고 그 안에 종료 버튼을 품었는데,
              // 버튼 안의 버튼은 보조기술에서 어느 것을 누르는지 알려 줄 방법이 없다.
              <div
                key={session.name}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'relative flex items-center gap-2 rounded-[9px] py-2 pl-3 pr-1.5',
                  active
                    ? 'bg-[var(--selection-tint)]'
                    : 'cursor-pointer hover:bg-[var(--surface-muted)]',
                )}
              >
                {/* 지금 보고 있는 화면이라는 표시 — 왼쪽 액센트 바 + 글자색 + 딱지. */}
                {active ? (
                  <span
                    className="absolute left-0 top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-r bg-[var(--accent-strong)]"
                    aria-hidden
                  />
                ) : null}
                <button
                  type="button"
                  aria-label={label}
                  disabled={active}
                  onClick={() => attach(session.name)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                >
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate font-mono text-[0.82rem]',
                      active ? 'text-[var(--accent-strong)]' : 'text-[var(--text)]',
                    )}
                    title={session.name}
                  >
                    {session.name}
                  </span>
                  {active ? (
                    <span className="shrink-0 rounded-[5px] bg-[var(--surface)] px-[0.35rem] text-[0.66rem] font-medium text-[var(--accent-strong)]">
                      {translate('sessionPanel.tmux.currentScreen')}
                    </span>
                  ) : session.attached ? (
                    <span className="shrink-0 text-[0.66rem] text-[var(--text-soft)]">
                      {translate('sessionPanel.tmux.attachedElsewhere')}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[0.7rem] text-[var(--text-soft)]">
                    {translate('sessionPanel.tmux.windows', { count: session.windows })}
                  </span>
                </button>
                <Tooltip label={translate('sessionPanel.tmux.kill')}>
                  <button
                    type="button"
                    aria-label={translate('sessionPanel.tmux.kill')}
                    className={ACTION_CLASS}
                    onClick={() => killTmuxSession(sessionId, session.name)}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </Tooltip>
              </div>
            );
          })
        )}
      </div>

      {/* control mode 를 못 쓰는 버전에서만 남기는 진입점. 그 외에는 위 목록·생성으로 전부 된다. */}
      {legacyOnly && !group ? (
        <div className="px-2.5 pb-2">
          <Button variant="secondary" size="sm" className="w-full" onClick={openLegacy}>
            {translate('tmuxStatus.open')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
