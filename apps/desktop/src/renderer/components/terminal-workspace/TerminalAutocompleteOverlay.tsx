import { useEffect, useRef } from 'react';
import type { TerminalAutocompleteSuggestion } from '../../lib/terminal-autocomplete';

// The list can hold more candidates than fit; show ~5 rows and scroll the rest.
const VISIBLE_ROWS = 5;
const ROW_HEIGHT_PX = 36; // matches the h-9 button height

function sourceLabel(source: TerminalAutocompleteSuggestion['source']): string {
  switch (source) {
    case 'history':
      return 'History';
    case 'spec':
      return 'Spec';
    case 'path':
      return 'Path';
    case 'generator':
      return 'Value';
    case 'snippet':
      return 'Snippet';
    default:
      return 'Command';
  }
}

interface TerminalAutocompleteOverlayProps {
  suggestions: TerminalAutocompleteSuggestion[];
  command: string;
  anchor: { left: number; top: number; openAbove: boolean };
  selectedIndex: number;
  onAccept: (suggestion: TerminalAutocompleteSuggestion) => void;
}

export function TerminalAutocompleteOverlay({
  suggestions,
  command,
  anchor,
  selectedIndex,
  onAccept,
}: TerminalAutocompleteOverlayProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const activeIndex = Math.min(
    Math.max(selectedIndex, 0),
    Math.max(suggestions.length - 1, 0),
  );
  // Keep the highlighted row visible as arrow keys move past the 5-row window.
  useEffect(() => {
    const node = activeRef.current;
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div
      className="absolute z-30 min-w-[280px] max-w-[min(560px,calc(100%-1rem))] overflow-y-auto overflow-x-hidden overscroll-contain rounded-[6px] border border-[var(--border)] bg-[var(--surface-elevated)] py-1 shadow-[var(--shadow-soft)]"
      style={{
        left: Math.max(4, anchor.left),
        top: anchor.openAbove ? undefined : anchor.top,
        bottom: anchor.openAbove ? `calc(100% - ${anchor.top - 2}px)` : undefined,
        maxHeight: VISIBLE_ROWS * ROW_HEIGHT_PX + 8,
      }}
      role="listbox"
      aria-label="Command autocomplete suggestions"
    >
      {suggestions.map((suggestion, index) => {
        const isSnippet = suggestion.source === 'snippet';
        // Snippets are matched by keyword, not by a prefix of the inserted text,
        // so don't fake a typed-prefix highlight — show the whole command.
        const suffix = isSnippet
          ? suggestion.insertText
          : suggestion.insertText.slice(command.length);
        const isActive = index === activeIndex;
        return (
          <button
            key={`${suggestion.source}:${suggestion.insertText}`}
            ref={isActive ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={isActive}
            className={`flex h-9 w-full min-w-0 items-center gap-2 border-l-[3px] px-3 text-left font-mono text-[0.82rem] text-[var(--text)] ${
              isActive
                ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
                : 'border-transparent hover:bg-[var(--surface-hover)]'
            }`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAccept(suggestion)}
          >
            <span className="min-w-0 flex-none truncate">
              {isSnippet ? null : <span className="text-[var(--accent)]">{command}</span>}
              <span>{suffix}</span>
            </span>
            {suggestion.description ? (
              <span className="min-w-0 flex-1 truncate text-[0.7rem] text-[var(--text-soft)]">
                {suggestion.description}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <span className="shrink-0 text-[0.7rem] text-[var(--text-soft)]">
              {sourceLabel(suggestion.source)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
