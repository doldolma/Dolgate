import { useMemo, useState } from 'react';
import type { SnippetDraft, SnippetRecord } from '@shared';
import { parseSnippetVariables } from '../lib/snippet';
import { Badge, Button, EmptyState, FieldGroup, Input, Textarea } from '../ui';
import { useTranslation } from 'react-i18next';

interface SnippetsPanelProps {
  snippets: SnippetRecord[];
  onSave: (id: string | null, draft: SnippetDraft) => Promise<SnippetRecord>;
  onRemove: (id: string) => Promise<void>;
  /** 활성 터미널에 삽입. 활성 세션이 없으면 전달하지 않는다(버튼 숨김). */
  onInsert?: (snippet: SnippetRecord) => void;
}

const fieldLabelClassName =
  'text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]';

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

export function SnippetsPanel({ snippets, onSave, onRemove, onInsert }: SnippetsPanelProps) {
  const { t: translate } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [keyword, setKeyword] = useState('');
  const [command, setCommand] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleSnippets = useMemo(
    () => snippets.filter((snippet) => matchesQuery(snippet, searchQuery)),
    [snippets, searchQuery],
  );
  const formVariables = useMemo(() => parseSnippetVariables(command), [command]);

  const openCreate = () => {
    setEditingId(null);
    setLabel('');
    setKeyword('');
    setCommand('');
    setError(null);
    setIsFormOpen(true);
  };

  const openEdit = (snippet: SnippetRecord) => {
    setEditingId(snippet.id);
    setLabel(snippet.label);
    setKeyword(snippet.keyword ?? '');
    setCommand(snippet.command);
    setError(null);
    setIsFormOpen(true);
  };

  const submit = async () => {
    if (!label.trim() || !command.trim()) {
      setError(translate('snippets.validationRequired'));
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await onSave(editingId, {
        label: label.trim(),
        command,
        keyword: keyword.trim() || null,
      });
      setIsFormOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : translate('snippets.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

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
          <Button variant="primary" className="ml-auto shrink-0" onClick={openCreate}>
            New Snippet
          </Button>
        </div>
      ) : null}

      {isFormOpen ? (
        <div className="grid gap-[0.9rem] rounded-[12px] border border-[var(--border)] bg-[var(--dialog-surface-muted)] p-[1.1rem]">
          <div className="grid gap-[0.7rem] md:grid-cols-[minmax(0,260px)_minmax(0,220px)]">
            <FieldGroup label="Label">
              <Input
                aria-label="Snippet label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Restart web"
              />
            </FieldGroup>
            <FieldGroup label={translate('snippets.keywordLabel')}>
              <Input
                aria-label="Snippet keyword"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="rweb"
              />
            </FieldGroup>
          </div>
          <label className="grid gap-[0.4rem]">
            <span className={fieldLabelClassName}>Command</span>
            <Textarea
              aria-label="Snippet command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              rows={3}
              placeholder="kubectl rollout restart deploy/{{service}} -n {{ns=default}}"
              className="font-mono text-[0.9rem]"
            />
          </label>
          {formVariables.length > 0 ? (
            <div className="flex flex-wrap items-center gap-[0.4rem] text-[0.82rem] text-[var(--text-soft)]">
              <span>{translate('snippets.variablesLabel')}</span>
              {formVariables.map((variable) => (
                <Badge key={variable.name}>
                  {variable.name}
                  {variable.defaultValue ? `=${variable.defaultValue}` : ''}
                </Badge>
              ))}
            </div>
          ) : null}
          {error ? (
            <p className="text-[0.82rem] text-[var(--danger-text)]">{error}</p>
          ) : null}
          <div className="flex justify-end gap-[0.55rem]">
            <Button variant="secondary" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>
              {translate('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={isSubmitting}>
              {translate(editingId ? 'snippets.save' : 'snippets.add')}
            </Button>
          </div>
        </div>
      ) : null}

      {snippets.length === 0 && !isFormOpen ? (
        <EmptyState
          title={translate('snippets.emptyTitle')}
          description={translate('snippets.emptyDescription')}
        >
          <Button variant="primary" onClick={openCreate}>
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
                    <Button variant="secondary" onClick={() => openEdit(snippet)}>
                      {translate('snippets.edit')}
                    </Button>
                    <Button variant="ghost" onClick={() => void onRemove(snippet.id)}>
                      {translate('common.delete')}
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
    </section>
  );
}
