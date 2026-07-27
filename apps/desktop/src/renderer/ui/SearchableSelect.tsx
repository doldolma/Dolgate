import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { Badge } from './Badge';
import { ChevronDown } from './icons';
import { Input } from './Input';
import { useTranslation } from 'react-i18next';

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Optional secondary line. Shown under the label and matched while searching. */
  description?: string;
  /** Optional badge shown on the right (e.g. host kind). */
  badge?: string;
  /** Explicit search haystack. Falls back to label + description + value. */
  searchText?: string;
}

interface SearchableSelectProps {
  /** Accessible name for the trigger button and the options listbox. */
  ariaLabel: string;
  /** Accessible name for the search input (defaults to `${ariaLabel} 검색`). */
  searchAriaLabel?: string;
  /** Trigger text shown when nothing is selected. */
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

function optionHaystack(option: SearchableSelectOption): string {
  if (option.searchText !== undefined) {
    return option.searchText.toLowerCase();
  }
  return [option.label, option.description, option.value]
    .filter((field): field is string => Boolean(field))
    .join(' ')
    .toLowerCase();
}

/**
 * A button-triggered dropdown with an inline search box — the searchable host
 * picker pattern shared by the port-forwarding host selector and the host form's
 * jump-host field. Selection is controlled (value/onChange); the search query
 * and open state are managed internally.
 */
export function SearchableSelect({
  ariaLabel,
  searchAriaLabel,
  placeholder,
  searchPlaceholder,
  emptyText,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: SearchableSelectProps) {
  const { t: translate } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const selected = options.find((option) => option.value === value);

  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return options;
    }
    return options.filter((option) => optionHaystack(option).includes(needle));
  }, [options, query]);

  // Close on outside click while open.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Focus the search box on open; reset the query on close.
  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    } else {
      setQuery('');
    }
  }, [isOpen]);

  const choose = (next: string) => {
    onChange(next);
    setIsOpen(false);
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            setIsOpen((current) => !current);
          }
        }}
        className={cn(
          'flex w-full items-center justify-between gap-[0.9rem] rounded-[10px] border border-[var(--border)] bg-[var(--dialog-surface-muted)] px-[0.9rem] py-[0.7rem] text-left text-[var(--text)] transition-[border-color,box-shadow] duration-150',
          isOpen
            ? 'border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_20%,transparent_80%)]'
            : 'hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border))]',
          disabled && 'cursor-not-allowed opacity-70',
        )}
      >
        {selected ? (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-[0.7rem]">
            <div className="grid min-w-0 gap-[0.25rem]">
              <span className="truncate text-[0.9rem] text-[var(--text)]">{selected.label}</span>
              {selected.description ? (
                <span className="truncate text-[0.82rem] text-[var(--text-soft)]">
                  {selected.description}
                </span>
              ) : null}
            </div>
            {selected.badge ? <Badge className="shrink-0">{selected.badge}</Badge> : null}
          </div>
        ) : (
          <span className="truncate text-[0.9rem] text-[var(--text-soft)]">{placeholder}</span>
        )}
        <ChevronDown
          className="h-[0.9rem] w-[0.9rem] shrink-0 text-[var(--text-soft)]"
          aria-hidden="true"
        />
      </button>
      {isOpen ? (
        <div
          role="listbox"
          aria-label={`${ariaLabel} options`}
          className="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-[5] grid max-h-[280px] gap-[0.4rem] overflow-y-auto rounded-[10px] border border-[var(--border)] bg-[var(--dialog-surface)] p-[0.55rem] shadow-[0_18px_42px_rgba(16,26,40,0.18)]"
        >
          <Input
            ref={searchInputRef}
            aria-label={searchAriaLabel ?? translate('select.searchAria', { label: ariaLabel })}
            placeholder={searchPlaceholder ?? translate('select.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-9 rounded-[10px] px-[0.7rem] py-[0.55rem] text-[0.9rem]"
          />
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option) => (
              <button
                key={option.value || '__none__'}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onPointerDown={(event) => {
                  event.preventDefault();
                  choose(option.value);
                }}
                onClick={() => choose(option.value)}
                className={cn(
                  'flex w-full items-center justify-between gap-[0.9rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--dialog-surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.55rem] text-left transition-[border-color,background] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border))] hover:bg-[color-mix(in_srgb,var(--dialog-surface)_84%,var(--accent-strong)_16%)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--accent-strong)_45%,white_55%)] focus-visible:outline-offset-2',
                  option.value === value &&
                    'border-[color-mix(in_srgb,var(--accent-strong)_38%,var(--border))] bg-[color-mix(in_srgb,var(--dialog-surface)_76%,var(--accent-strong)_24%)]',
                )}
              >
                <div className="grid min-w-0 gap-[0.25rem]">
                  <span className="truncate text-[0.9rem] text-[var(--text)]">{option.label}</span>
                  {option.description ? (
                    <span className="truncate text-[0.82rem] text-[var(--text-soft)]">
                      {option.description}
                    </span>
                  ) : null}
                </div>
                {option.badge ? <Badge className="shrink-0">{option.badge}</Badge> : null}
              </button>
            ))
          ) : (
            <div
              role="status"
              className="rounded-[10px] border border-dashed border-[var(--border)] px-[0.9rem] py-[0.55rem] text-[0.9rem] text-[var(--text-soft)]"
            >
              {emptyText ?? translate('select.noResults')}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
