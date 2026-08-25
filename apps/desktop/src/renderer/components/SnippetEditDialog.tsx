// 스니펫 추가·편집 대화상자.
//
// **한 벌만 둔다.** 예전에는 이 폼이 스니펫 화면 안에 인라인 JSX 로 박혀 있었고, 세션 패널에서
// 편집을 열려면 그것을 복제해야 했다. 두 벌이 되면 필드가 갈린다(변수 배지, 검증 문구,
// placeholder…). 그래서 폼을 여기로 빼고 양쪽이 이것을 쓴다.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SnippetDraft, SnippetRecord } from '@shared';
import { useTranslation } from 'react-i18next';
import { parseSnippetVariables } from '../lib/snippet';
import { DialogBackdrop } from './DialogBackdrop';
import { SnippetDeleteConfirmDialog } from './SnippetDeleteConfirmDialog';
import {
  Badge,
  Button,
  FieldGroup,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SectionLabel,
  Textarea,
} from '../ui';

interface SnippetEditDialogProps {
  /** 편집 대상. null 이면 새로 만들기. 닫혀 있으면 open=false 로 둔다. */
  open: boolean;
  snippet: SnippetRecord | null;
  onSave: (id: string | null, draft: SnippetDraft) => Promise<SnippetRecord>;
  /**
   * 삭제. 주면 편집할 때 폼 안에 삭제 버튼이 생긴다.
   *
   * **삭제가 목록 줄이 아니라 여기 있는 이유.** 줄의 hover 버튼으로 두었을 때 삭제가 줄의 가장
   * 바깥이었다 — 마우스가 오른쪽에서 들어오거나 목록을 훑을 때 제일 먼저 닿는 자리다. 확인
   * 대화상자를 붙여도 매번 뜨는 확인은 습관적으로 넘기게 된다. 편집을 한 번 열게 하면 그
   * 오클릭이 구조적으로 불가능해지고, 좁은 패널의 줄에서 버튼 하나 몫의 폭도 돌아온다.
   */
  onRemove?: (id: string) => Promise<void>;
  /** 삭제 확인에 보여 줄, 이 스니펫을 시작 명령으로 쓰는 호스트 수. */
  hostUsageCount?: number;
  onClose: () => void;
}

export function SnippetEditDialog({
  open,
  snippet,
  onSave,
  onRemove,
  hostUsageCount = 0,
  onClose,
}: SnippetEditDialogProps) {
  const { t: translate } = useTranslation();
  const [label, setLabel] = useState('');
  const [keyword, setKeyword] = useState('');
  const [command, setCommand] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  // 열릴 때마다 대상에서 값을 새로 채운다. 닫고 다시 열었을 때 앞서 편집하던 값이 남아 있으면
  // 다른 스니펫에 그 값을 저장하게 된다.
  useEffect(() => {
    if (!open) {
      return;
    }
    setLabel(snippet?.label ?? '');
    setKeyword(snippet?.keyword ?? '');
    setCommand(snippet?.command ?? '');
    setError(null);
    setIsSubmitting(false);
    setConfirmingDelete(false);
    setIsDeleting(false);
    setDeleteError(null);
    const frame = window.requestAnimationFrame(() => {
      firstInputRef.current?.focus();
      firstInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, snippet]);

  const variables = useMemo(() => parseSnippetVariables(command), [command]);

  const submit = async () => {
    if (!label.trim() || !command.trim()) {
      setError(translate('snippets.validationRequired'));
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await onSave(snippet?.id ?? null, {
        label: label.trim(),
        command,
        keyword: keyword.trim() || null,
      });
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : translate('snippets.saveFailed'),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const remove = async () => {
    if (!snippet || !onRemove) {
      return;
    }
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await onRemove(snippet.id);
      // 지운 스니펫의 편집 폼을 열어 둘 이유가 없다 — 확인과 폼을 함께 닫는다.
      setConfirmingDelete(false);
      onClose();
    } catch (caught) {
      setDeleteError(
        caught instanceof Error ? caught.message : translate('snippets.saveFailed'),
      );
      setIsDeleting(false);
    }
  };

  if (!open) {
    return null;
  }

  const canDelete = Boolean(snippet && onRemove);
  const isBusy = isSubmitting || isDeleting;

  return (
    <>
    <DialogBackdrop dismissDisabled={isBusy} onDismiss={onClose}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="snippet-edit-title">
        <ModalHeader className="block">
          <SectionLabel>{translate('sessionPanel.snippets.title')}</SectionLabel>
          <h3 id="snippet-edit-title">
            {translate(snippet ? 'snippets.editTitle' : 'snippets.addTitle')}
          </h3>
        </ModalHeader>
        <ModalBody>
          <form
            className="grid gap-[0.9rem]"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-[0.7rem] md:grid-cols-[minmax(0,1fr)_minmax(0,200px)]">
              <FieldGroup label="Label">
                <Input
                  ref={firstInputRef}
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
            <FieldGroup label="Command">
              <Textarea
                aria-label="Snippet command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                rows={3}
                placeholder="kubectl rollout restart deploy/{{service}} -n {{ns=default}}"
                className="font-mono text-[0.9rem]"
              />
            </FieldGroup>
            {variables.length > 0 ? (
              <div className="flex flex-wrap items-center gap-[0.4rem] text-[0.82rem] text-[var(--text-soft)]">
                <span>{translate('snippets.variablesLabel')}</span>
                {variables.map((variable) => (
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
            {/* 엔터로 저장되게 하되 버튼은 푸터에 둔다(다른 대화상자와 같은 자리). */}
            <button type="submit" className="hidden" aria-hidden="true" />
          </form>
        </ModalBody>
        <ModalFooter>
          {/* 삭제는 왼쪽 끝. 저장·취소와 붙여 놓으면 저장을 누르려다 닿는다. */}
          {canDelete ? (
            <Button
              variant="ghost"
              className="mr-auto text-[var(--danger-text)]"
              disabled={isBusy}
              onClick={() => setConfirmingDelete(true)}
            >
              {translate('common.delete')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" disabled={isBusy} onClick={() => void submit()}>
            {translate(snippet ? 'snippets.save' : 'snippets.add')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
    {/* 형제로 둔다 — 같은 z 층에서 뒤에 오는 것이 위에 그려진다. */}
    <SnippetDeleteConfirmDialog
      open={confirmingDelete}
      label={snippet?.label ?? ''}
      hostUsageCount={hostUsageCount}
      isDeleting={isDeleting}
      errorMessage={deleteError}
      onClose={() => {
        setConfirmingDelete(false);
        setDeleteError(null);
      }}
      onConfirm={() => void remove()}
    />
    </>
  );
}
