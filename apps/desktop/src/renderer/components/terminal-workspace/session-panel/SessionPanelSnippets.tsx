// 스니펫 섹션. 목록 관리(추가·편집)는 홈의 스니펫 화면에 남기고, 여기서는 **이 세션으로
// 보내기**만 한다 — 두 곳에서 같은 것을 관리하면 어느 쪽이 최신인지 알 수 없게 된다.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../store/appStore';
import { filterByQuery, resolveSnippetActions } from '../../../lib/session-panel';
import {
  hasSnippetVariables,
  parseSnippetVariables,
  resolveSnippetCommand,
} from '../../../lib/snippet';
import { Button } from '../../../ui';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelRow } from './SessionPanelRow';
import { SessionPanelSearch } from './SessionPanelSearch';
import {
  SnippetVariablesDialog,
  type PendingSnippetInsertion,
} from '../SnippetVariablesDialog';
import type { SessionPanelSender } from './useSessionPanelTarget';

interface SessionPanelSnippetsProps {
  sender: SessionPanelSender;
}

/** 변수를 채운 뒤 무엇을 할지 기억해 둔다 — 대화상자는 값만 받는다. */
interface PendingSnippetAction extends PendingSnippetInsertion {
  mode: 'insert' | 'run';
}

export function SessionPanelSnippets({ sender }: SessionPanelSnippetsProps) {
  const { t: translate } = useTranslation();
  const snippets = useAppStore((state) => state.snippets);
  const openHomeSection = useAppStore((state) => state.openHomeSection);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<PendingSnippetAction | null>(null);

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
                onClick={() => openHomeSection('snippets')}
              >
                {translate('sessionPanel.snippets.manage')}
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
    </div>
  );
}
