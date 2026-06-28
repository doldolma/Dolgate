import { useMemo, useState } from 'react';
import type { SnippetDraft, SnippetRecord } from '@shared';
import { parseSnippetVariables } from '../lib/snippet';
import { Badge, Button, EmptyState, FieldGroup, Input, Textarea } from '../ui';

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
      setError('이름과 명령을 모두 입력해 주세요.');
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
      setError(caught instanceof Error ? caught.message : '저장에 실패했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-[1.1rem] overflow-auto px-[1.6rem] py-[1.3rem]">
      <header className="flex flex-wrap items-center justify-between gap-[0.9rem]">
        <div className="grid gap-[0.25rem]">
          <h2 className="text-[1.35rem] font-semibold text-[var(--text)]">Snippets</h2>
          <p className="text-[0.9rem] text-[var(--text-soft)]">
            자주 쓰는 명령을 저장해 두고 터미널 자동완성에서 꺼내 씁니다. {'{{변수}}'}로 값을 받을 수 있어요.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          New Snippet
        </Button>
      </header>

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
            <FieldGroup label="Keyword (선택)">
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
              <span>변수:</span>
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
              취소
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={isSubmitting}>
              {editingId ? '저장' : '추가'}
            </Button>
          </div>
        </div>
      ) : null}

      {snippets.length === 0 && !isFormOpen ? (
        <EmptyState
          title="아직 저장된 snippet이 없습니다."
          description="자주 쓰는 명령을 추가하면 터미널 자동완성에서 바로 꺼내 쓸 수 있습니다."
        />
      ) : (
        <div className="grid gap-[0.7rem]">
          {snippets.length > 0 ? (
            <Input
              aria-label="Snippet search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="이름, 키워드, 명령 검색"
              className="max-w-[360px]"
            />
          ) : null}
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
                        {variables.length}개 변수
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-[0.4rem]">
                    {onInsert ? (
                      <Button variant="secondary" onClick={() => onInsert(snippet)}>
                        삽입
                      </Button>
                    ) : null}
                    <Button variant="secondary" onClick={() => openEdit(snippet)}>
                      편집
                    </Button>
                    <Button variant="ghost" onClick={() => void onRemove(snippet.id)}>
                      삭제
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
            <p className="text-[0.9rem] text-[var(--text-soft)]">검색 결과가 없습니다.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
