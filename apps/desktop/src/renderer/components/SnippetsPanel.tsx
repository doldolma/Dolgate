// 홈의 스니펫 화면. 목록·검색만 여기서 하고, 추가·편집 폼은 SnippetEditDialog 가 쥔다.
//
// 폼을 여기서 인라인으로 그리던 것을 대화상자로 옮겼다. 세션 패널에서도 같은 폼을 열어야 하는데,
// 인라인으로 두면 그쪽에 복제본이 생기고 두 벌은 곧 갈린다(변수 배지·검증 문구·placeholder).

import { useMemo, useState } from 'react';
import type { HostRecord, SnippetDraft, SnippetRecord } from '@shared';
import { countHostsUsingSnippet, parseSnippetVariables } from '../lib/snippet';
import { Badge, Button, EmptyState, Input } from '../ui';
import { useTranslation } from 'react-i18next';
import { SnippetEditDialog } from './SnippetEditDialog';

interface SnippetsPanelProps {
  snippets: SnippetRecord[];
  /** 삭제할 때 "시작 명령이 풀리는 호스트 수" 를 세는 데만 쓴다. */
  hosts: HostRecord[];
  onSave: (id: string | null, draft: SnippetDraft) => Promise<SnippetRecord>;
  onRemove: (id: string) => Promise<void>;
  /** 활성 터미널에 삽입. 활성 세션이 없으면 전달하지 않는다(버튼 숨김). */
  onInsert?: (snippet: SnippetRecord) => void;
}

/** 편집 대화상자 상태. `snippet: null` 은 새로 만들기(닫힘은 editing === null). */
interface EditingState {
  snippet: SnippetRecord | null;
}

function matchesQuery(snippet: SnippetRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [snippet.label, snippet.keyword ?? '', snippet.command]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function SnippetsPanel({
  snippets,
  hosts,
  onSave,
  onRemove,
  onInsert,
}: SnippetsPanelProps) {
  const { t: translate } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState<EditingState | null>(null);

  const visibleSnippets = useMemo(
    () => snippets.filter((snippet) => matchesQuery(snippet, searchQuery)),
    [snippets, searchQuery],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-[1.1rem] overflow-auto px-[1.6rem] py-[1.3rem]">
      {/* 상단 브레드크럼(← Hosts · Snippets)에 이미 제목이 있어 Snippets 헤더는 생략.
          저장된 스니펫이 있을 때만 검색 + New Snippet 행을 상단에 둔다. 비어있을 땐
          아래 중앙 정렬 빈 상태 카드에 CTA를 둬 상단에 버튼만 덩그러니 뜨지 않게 한다. */}
      {snippets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-[0.9rem]">
          <Input
            aria-label="Snippet search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={translate('snippets.searchPlaceholder')}
            className="w-full max-w-[360px]"
          />
          <Button
            variant="primary"
            className="ml-auto shrink-0"
            onClick={() => setEditing({ snippet: null })}
          >
            New Snippet
          </Button>
        </div>
      ) : null}

      {snippets.length === 0 ? (
        <EmptyState
          title={translate('snippets.emptyTitle')}
          description={translate('snippets.emptyDescription')}
        >
          <Button variant="primary" onClick={() => setEditing({ snippet: null })}>
            New Snippet
          </Button>
        </EmptyState>
      ) : (
        <div className="grid gap-[0.7rem]">
          {visibleSnippets.map((snippet) => {
            const variables = parseSnippetVariables(snippet.command);
            return (
              <article
                key={snippet.id}
                className="grid gap-[0.55rem] rounded-[12px] border border-[var(--border)] bg-[var(--surface-elevated)] p-[0.9rem]"
              >
                <div className="flex flex-wrap items-center justify-between gap-[0.55rem]">
                  <div className="flex min-w-0 flex-wrap items-center gap-[0.55rem]">
                    <strong className="text-[1rem] text-[var(--text)]">{snippet.label}</strong>
                    {snippet.keyword ? <Badge>{snippet.keyword}</Badge> : null}
                    {variables.length > 0 ? (
                      <span className="text-[0.76rem] text-[var(--text-soft)]">
                        {translate('snippets.variableCount', { count: variables.length })}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-[0.4rem]">
                    {onInsert ? (
                      <Button variant="secondary" onClick={() => onInsert(snippet)}>
                        {translate('snippets.insert')}
                      </Button>
                    ) : null}
                    {/* 삭제는 편집 폼 안에 있다 — 이유는 SnippetEditDialog 의 onRemove 주석. */}
                    <Button variant="secondary" onClick={() => setEditing({ snippet })}>
                      {translate('snippets.edit')}
                    </Button>
                  </div>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--app-bg)_60%,transparent_40%)] px-[0.9rem] py-[0.55rem] font-mono text-[0.82rem] text-[var(--text)]">
                  {snippet.command}
                </pre>
              </article>
            );
          })}
          {snippets.length > 0 && visibleSnippets.length === 0 ? (
            <p className="text-[0.9rem] text-[var(--text-soft)]">{translate('snippets.noResults')}</p>
          ) : null}
        </div>
      )}

      <SnippetEditDialog
        open={editing !== null}
        snippet={editing?.snippet ?? null}
        onSave={onSave}
        onRemove={onRemove}
        hostUsageCount={
          editing?.snippet ? countHostsUsingSnippet(hosts, editing.snippet.id) : 0
        }
        onClose={() => setEditing(null)}
      />
    </section>
  );
}
