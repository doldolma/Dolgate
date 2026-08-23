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
import { Button, Input, Tooltip } from '../../../ui';
import { LogOut, Play, RefreshCw, X } from '../../../ui/icons';
import { listWorkspaceSessionIds } from '../terminalWorkspaceLayout';
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
   * 세션에 붙는다. 붙어 있을 때는 **새 그룹 탭**으로 열고(현재 tmux 를 살린다), 감지 상태에서는
   * 이 세션의 탭 자리를 재사용한다(같은 화면에서 tmux 가 열리는 것으로 보이게).
   */
  function attach(name: string): void {
    if (!hostId) {
      return;
    }
    void connectHost(
      hostId,
      120,
      32,
      undefined,
      true,
      `tmux -CC attach -t ${quote(name)}`,
      group ? undefined : tab?.sessionId,
      undefined,
      version ?? undefined,
    );
  }

  function create(): void {
    const name = newName.trim();
    if (!hostId || !name) {
      return;
    }
    // strict new — 이름이 겹치면 tmux 가 에러를 내고 연결 실패로 보인다(조용히 붙지 않는다).
    void connectHost(
      hostId,
      120,
      32,
      undefined,
      true,
      `tmux -CC new-session -s ${quote(name)}`,
      group ? undefined : tab?.sessionId,
      undefined,
      version ?? undefined,
    );
    setNewName('');
  }

  /**
   * control mode 를 못 쓰는 tmux(2.6 미만)의 유일한 진입점. 일반 SSH 세션으로 열고 접속 직후
   * 호환 attach-or-create 명령을 자동 입력한다(passthrough).
   */
  function openLegacy(): void {
    if (!hostId || !tab) {
      return;
    }
    void connectHost(
      hostId,
      120,
      32,
      undefined,
      false,
      undefined,
      tab.sessionId,
      undefined,
      undefined,
      PASSTHROUGH_TMUX_COMMAND,
    );
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
      <div className="flex items-center gap-2 px-2.5 pb-1 pt-2">
        <span className="min-w-0 flex-1 truncate text-[0.72rem] text-[var(--text-soft)]">
          {attachedName
            ? translate('sessionPanel.tmux.attachedTo', { name: attachedName })
            : translate('sessionPanel.tmux.detectedVersion', {
                version: version ?? '—',
              })}
        </span>
        <Tooltip label={translate('sessionPanel.tmux.refresh')}>
          <button
            type="button"
            aria-label={translate('sessionPanel.tmux.refresh')}
            className={ACTION_CLASS}
            onClick={() => void refreshTmuxSessions(sessionId)}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
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

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {sessions.length === 0 ? (
          <p className="px-2.5 py-2 text-[0.75rem] leading-[1.5] text-[var(--text-soft)]">
            {translate('sessionPanel.tmux.noSessions')}
          </p>
        ) : (
          sessions.map((session) => {
            const active = session.name === attachedName;
            return (
              <div key={session.name} className="group rounded-[9px] px-2.5 py-1.5">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cnLabel(active)}
                    title={session.name}
                  >
                    {session.name}
                  </span>
                  <span className="shrink-0 text-[0.7rem] text-[var(--text-soft)]">
                    {translate('sessionPanel.tmux.windows', { count: session.windows })}
                  </span>
                  {/* 붙어 있는 세션에는 attach 를 두지 않는다 — 눌러도 같은 곳이다. */}
                  {active ? null : (
                    <Tooltip label={translate('sessionPanel.tmux.attach')}>
                      <button
                        type="button"
                        aria-label={translate('sessionPanel.tmux.attach')}
                        className={ACTION_CLASS}
                        onClick={() => attach(session.name)}
                      >
                        <Play className="h-3 w-3" aria-hidden />
                      </button>
                    </Tooltip>
                  )}
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
                {session.attached && !active ? (
                  <p className="text-[0.7rem] text-[var(--text-soft)]">
                    {translate('sessionPanel.tmux.attachedElsewhere')}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={translate('sessionPanel.tmux.namePlaceholder')}
          className="min-w-0 flex-1"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              create();
            }
          }}
        />
        <Button variant="secondary" size="sm" disabled={!newName.trim()} onClick={create}>
          {translate('sessionPanel.tmux.create')}
        </Button>
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

function cnLabel(active: boolean): string {
  return active
    ? 'min-w-0 flex-1 truncate text-[0.78rem] font-semibold text-[var(--accent-strong)]'
    : 'min-w-0 flex-1 truncate text-[0.78rem] text-[var(--text)]';
}
