import { useEffect, useRef, useState } from 'react';
import type { SnippetVariable } from '../../lib/snippet';
import { DialogBackdrop } from '../DialogBackdrop';
import { Button, Input, ModalBody, ModalFooter, ModalHeader, ModalShell } from '../../ui';

export interface PendingSnippetInsertion {
  command: string;
  variables: SnippetVariable[];
}

interface SnippetVariablesDialogProps {
  pending: PendingSnippetInsertion | null;
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
  title?: string;
  confirmLabel?: string;
}

export function SnippetVariablesDialog({
  pending,
  onConfirm,
  onCancel,
  title = 'Snippet 변수 입력',
  confirmLabel = '삽입',
}: SnippetVariablesDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (pending) {
      setValues(
        Object.fromEntries(pending.variables.map((variable) => [variable.name, variable.defaultValue])),
      );
      // Focus the first field on open.
      const frame = window.requestAnimationFrame(() => {
        firstInputRef.current?.focus();
        firstInputRef.current?.select();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [pending]);

  if (!pending) {
    return null;
  }

  const submit = () => onConfirm(values);

  return (
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell>
        <ModalHeader>
          <h3 className="text-[1.05rem] font-semibold text-[var(--text)]">{title}</h3>
        </ModalHeader>
        <ModalBody>
          <pre className="mb-[0.9rem] overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--app-bg)_60%,transparent_40%)] px-[0.8rem] py-[0.6rem] font-mono text-[0.82rem] text-[var(--text-soft)]">
            {pending.command}
          </pre>
          <form
            className="grid gap-[0.7rem]"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {pending.variables.map((variable, index) => (
              <label key={variable.name} className="grid gap-[0.35rem]">
                <span className="text-[0.82rem] font-semibold text-[var(--text-soft)]">
                  {variable.name}
                </span>
                <Input
                  ref={index === 0 ? firstInputRef : undefined}
                  aria-label={`Value for ${variable.name}`}
                  value={values[variable.name] ?? ''}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [variable.name]: event.target.value }))
                  }
                  placeholder={variable.defaultValue || variable.name}
                />
              </label>
            ))}
            <button type="submit" className="hidden" aria-hidden="true" />
          </form>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
          <Button variant="primary" onClick={submit}>
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
