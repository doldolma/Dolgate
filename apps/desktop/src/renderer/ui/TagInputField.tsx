import { forwardRef, useImperativeHandle, useRef, type InputHTMLAttributes, type MouseEvent } from 'react';
import { cn } from '../lib/cn';

interface TagInputFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  tags: string[];
  onRemoveTag: (tag: string) => void;
  shellClassName?: string;
  inputClassName?: string;
}

export const TagInputField = forwardRef<HTMLInputElement, TagInputFieldProps>(
  function TagInputField(
    {
      tags,
      onRemoveTag,
      shellClassName,
      inputClassName,
      disabled = false,
      ...inputProps
    },
    ref,
  ) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

    function focusInput() {
      if (disabled) {
        return;
      }
      inputRef.current?.focus();
    }

    function handleShellMouseDown(event: MouseEvent<HTMLDivElement>) {
      const target = event.target as HTMLElement;
      if (target.closest('button') || target === inputRef.current) {
        return;
      }
      event.preventDefault();
      focusInput();
    }

    return (
      <div
        data-tag-input-shell="true"
        data-testid="tag-input-shell"
        className={cn(
          'flex min-h-11 w-full flex-wrap items-center gap-[0.5rem] rounded-[16px] border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-[0.9rem] text-[var(--text)] shadow-none transition-[border-color,box-shadow,background-color] duration-150 focus-within:border-[var(--selection-border)] focus-within:outline-none focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--accent-strong)_10%,transparent)]',
          disabled && 'cursor-default opacity-70',
          !disabled && 'cursor-text',
          shellClassName,
        )}
        onMouseDown={handleShellMouseDown}
        onClick={() => focusInput()}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex min-h-[1.8rem] items-center gap-[0.35rem] rounded-full border border-[color-mix(in_srgb,var(--accent-strong)_24%,var(--border)_76%)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface-strong))] px-[0.62rem] py-[0.24rem] text-[0.88rem] leading-[1.2] text-[var(--text)]"
          >
            <span>{tag}</span>
            <button
              type="button"
              className="inline-grid h-[1.15rem] w-[1.15rem] place-items-center rounded-full text-[var(--text-soft)] transition-colors duration-150 hover:text-[var(--text)] focus-visible:outline-none"
              aria-label={`${tag} 태그 제거`}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                onRemoveTag(tag);
                focusInput();
              }}
              disabled={disabled}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className={cn(
            'block min-h-[1.35rem] min-w-[8rem] flex-[1_1_8rem] p-0 text-[0.95rem] leading-[1.35] text-[var(--text)] placeholder:text-[var(--text-soft)] focus:outline-none',
            inputClassName,
          )}
          style={{
            all: 'unset',
            display: 'block',
            flex: '1 1 8rem',
            minWidth: '8rem',
            minHeight: '1.35rem',
            lineHeight: '1.35',
            color: 'var(--text)',
            caretColor: 'var(--accent-strong)',
          }}
          disabled={disabled}
          {...inputProps}
        />
      </div>
    );
  },
);
