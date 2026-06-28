import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn';
import { Check, ChevronDown } from './icons';

export interface FontSelectOption {
  id: string;
  title: string;
  /** CSS font-family stack — used to render the trigger and this option in its own font. */
  stack: string;
}

interface FontSelectFieldProps {
  /** Accessible name for the trigger and the options listbox. */
  ariaLabel: string;
  value: string;
  options: ReadonlyArray<FontSelectOption>;
  onChange: (id: string) => void;
  className?: string;
}

// Distinguishing glyphs (one/ell/eye, zero/oh) plus an arrow that ligature-aware
// fonts (Fira Code, JetBrains Mono) render specially — so the preview shows real
// character shapes, not just the font's name.
const PREVIEW_SAMPLE = 'Il1 O0 () =>';

/**
 * A font picker that previews each choice in its own typeface. Native `<select>`
 * can't style its `<option>`s per-font (the OS draws the menu), so this is a
 * button-triggered listbox (same conventions as {@link SearchableSelect}) with
 * arrow-key navigation and type-ahead.
 */
export function FontSelectField({
  ariaLabel,
  value,
  options,
  onChange,
  className,
}: FontSelectFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const selected = options[selectedIndex];

  // Close on outside click while open (matches SearchableSelect).
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isOpen]);

  // On open: highlight the current selection and move keyboard focus to the list.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setActiveIndex(selectedIndex);
    listRef.current?.focus();
  }, [isOpen, selectedIndex]);

  // Keep the highlighted option visible while arrowing.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, activeIndex]);

  const commit = (index: number) => {
    const option = options[index];
    if (option) {
      onChange(option.id);
    }
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => Math.min(options.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
        break;
      case 'Tab':
        setIsOpen(false);
        break;
      default:
        // Type-ahead: jump to the next option whose title starts with the key.
        if (event.key.length === 1 && event.key.trim()) {
          const needle = event.key.toLowerCase();
          const total = options.length;
          for (let step = 1; step <= total; step++) {
            const index = (activeIndex + step) % total;
            if (options[index].title.toLowerCase().startsWith(needle)) {
              setActiveIndex(index);
              break;
            }
          }
        }
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={onTriggerKeyDown}
        className="flex w-full min-h-11 items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-[0.9rem] text-left text-[var(--text)] transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--selection-border)] focus:outline-none focus:ring-4 focus:ring-[color-mix(in_srgb,var(--accent-strong)_10%,transparent)]"
      >
        <span className="min-w-0 flex-1 truncate" style={{ fontFamily: selected?.stack }}>
          {selected?.title ?? ''}
        </span>
        <ChevronDown
          className="h-[0.9rem] w-[0.9rem] shrink-0 text-[var(--text-soft)]"
          aria-hidden="true"
        />
      </button>

      {isOpen ? (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${listboxId}-${activeIndex}`}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          className="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-30 max-h-[16rem] overflow-y-auto overscroll-contain rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] py-1 shadow-[var(--shadow-soft)] focus:outline-none"
        >
          {options.map((option, index) => {
            const isActive = index === activeIndex;
            const isSelected = index === selectedIndex;
            return (
              <button
                key={option.id}
                id={`${listboxId}-${index}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onMouseEnter={() => setActiveIndex(index)}
                onPointerDown={(event) => {
                  // Commit on pointer-down (not click) so the list closes before a
                  // surrounding <label> (FieldGroup) forwards the click to the
                  // trigger and re-toggles it open. Mirrors SearchableSelect.
                  event.preventDefault();
                  commit(index);
                }}
                onClick={() => commit(index)}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[0.9rem] text-[var(--text)]',
                  isActive
                    ? 'bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]'
                    : 'hover:bg-[var(--surface-hover)]',
                )}
              >
                <span
                  className="flex w-3.5 shrink-0 justify-center text-[var(--accent)]"
                  aria-hidden="true"
                >
                  {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ fontFamily: option.stack }}>
                  {option.title}
                </span>
                <span
                  className="shrink-0 text-[0.76rem] text-[var(--text-soft)]"
                  style={{ fontFamily: option.stack }}
                  aria-hidden="true"
                >
                  {PREVIEW_SAMPLE}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
