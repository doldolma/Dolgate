// 스니펫 섹션. **이 세션으로 보내기**와 목록 관리(추가·편집·삭제)를 함께 한다.
//
// 예전에는 관리를 홈의 스니펫 화면에만 두었다("두 곳에서 관리하면 어느 쪽이 최신인지 알 수
// 없다"). 소스가 하나인 지금은 근거가 없는 걱정이다 — 목록도 저장도 스토어 하나(state.snippets /
// saveSnippet / removeSnippet)를 지나므로 두 화면이 같은 것을 본다.
//
// 여기서 만들 수 있어야 하는 실질적 이유: 스니펫이 없을 때 예전 빈 화면은 "관리" 버튼으로
// 홈 화면으로 보내 버렸다. 작업 중인 세션에서 화면이 튀는 대가로 스니펫 하나를 만들었다.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SnippetRecord } from '@shared';
import { useAppStore } from '../../../store/appStore';
import { filterByQuery, resolveSnippetActions } from '../../../lib/session-panel';
import {
  countHostsUsingSnippet,
  hasSnippetVariables,
  parseSnippetVariables,
  resolveSnippetCommand,
} from '../../../lib/snippet';
import { Button, Tooltip } from '../../../ui';
import { Plus } from '../../../ui/icons';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelRow } from './SessionPanelRow';
import { SessionPanelSearch } from './SessionPanelSearch';
import {
  SnippetVariablesDialog,
  type PendingSnippetInsertion,
} from '../SnippetVariablesDialog';
import { SnippetEditDialog } from '../../SnippetEditDialog';
import { useSessionScopedState } from '../../../lib/session-scoped-state';
import type { SessionPanelSender } from './useSessionPanelTarget';

interface SessionPanelSnippetsProps {
  /** 검색어를 세션마다 따로 기억하는 데 쓴다(스니펫 목록 자체는 전역이다). */
  sessionId: string;
  sender: SessionPanelSender;
}

/** 변수를 채운 뒤 무엇을 할지 기억해 둔다 — 대화상자는 값만 받는다. */
interface PendingSnippetAction extends PendingSnippetInsertion {
  mode: 'insert' | 'run';
}

/** 편집 대화상자의 상태. `snippet: null` 은 새로 만들기다(닫힘은 editing === null). */
interface EditingState {
  snippet: SnippetRecord | null;
}

export function SessionPanelSnippets({ sessionId, sender }: SessionPanelSnippetsProps) {
  const { t: translate } = useTranslation();
  const snippets = useAppStore((state) => state.snippets);
  const hosts = useAppStore((state) => state.hosts);
  const saveSnippet = useAppStore((state) => state.saveSnippet);
  const removeSnippet = useAppStore((state) => state.removeSnippet);
  // 목록은 전역이지만 검색어는 세션마다 따로 둔다 — 다른 서버로 옮기면 비고, 돌아오면 남는다.
  const [query, setQuery] = useSessionScopedState(sessionId, 'snippets.query', '');
  const [pending, setPending] = useState<PendingSnippetAction | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);

  const items = useMemo(
    () =>
      filterByQuery(
        snippets,
        query,
        (snippet) => `${snippet.label} ${snippet.command} ${snippet.keyword ?? ''}`,
      ),
    [query, snippets],
  );

  function perform(command: string, mode: 'insert' | 'run'): void {
    if (mode === 'insert') {
      sender.insert(command);
      return;
    }
    sender.run(command);
  }

  // 변수가 있으면 값을 받고 나서 보낸다. 채우지 않은 채 보내면 "{{host}}" 가 그대로 셸에 간다.
  function start(command: string, mode: 'insert' | 'run'): void {
    if (!hasSnippetVariables(command)) {
      perform(command, mode);
      return;
    }
    setPending({ command, variables: parseSnippetVariables(command), mode });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionPanelSearch
        value={query}
        onChange={setQuery}
        placeholder={translate('sessionPanel.snippets.search')}
        // 검색줄의 오른쪽 자리(히스토리의 "실패만 보기" 와 같은 자리). 목록 위에 버튼 줄을 따로
        // 두면 좁은 패널에서 목록이 그만큼 짧아진다.
        trailing={
          <Tooltip label={translate('sessionPanel.snippets.add')}>
            <button
              type="button"
              aria-label={translate('sessionPanel.snippets.add')}
              onClick={() => setEditing({ snippet: null })}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </Tooltip>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {items.length === 0 ? (
          <SessionPanelEmpty
            title={
              query.trim()
                ? translate('sessionPanel.snippets.noMatchesTitle')
                : translate('sessionPanel.snippets.emptyTitle')
            }
            description={
              query.trim()
                ? translate('sessionPanel.snippets.noMatches')
                : translate('sessionPanel.snippets.empty')
            }
          >
            {query.trim() ? null : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditing({ snippet: null })}
              >
                {translate('sessionPanel.snippets.createFirst')}
              </Button>
            )}
          </SessionPanelEmpty>
        ) : (
          items.map((snippet) => {
            const actions = resolveSnippetActions(snippet.command, sender.context);
            return (
              <SessionPanelRow
                key={snippet.id}
                text={snippet.command}
                meta={[snippet.label, snippet.keyword].filter(Boolean).join(' · ')}
                actions={actions}
                blockedHint={
                  actions.blockedReason
                    ? translate(`sessionPanel.blocked.${actions.blockedReason}`)
                    : null
                }
                onCopy={() => sender.copy(snippet.command)}
                onInsert={() => start(snippet.command, 'insert')}
                onRun={() => start(snippet.command, 'run')}
                onEdit={() => setEditing({ snippet })}
              />
            );
          })
        )}
      </div>
      <SnippetVariablesDialog
        pending={pending}
        onConfirm={(values) => {
          const current = pending;
          setPending(null);
          if (current) {
            perform(resolveSnippetCommand(current.command, values), current.mode);
          }
        }}
        onCancel={() => setPending(null)}
      />
      <SnippetEditDialog
        open={editing !== null}
        snippet={editing?.snippet ?? null}
        onSave={saveSnippet}
        onRemove={removeSnippet}
        hostUsageCount={
          editing?.snippet ? countHostsUsingSnippet(hosts, editing.snippet.id) : 0
        }
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
