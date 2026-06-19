import type { TerminalAutocompleteSuggestion } from '../../lib/terminal-autocomplete';

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
    default:
      return 'Command';
  }
}

interface TerminalAutocompleteOverlayProps {
  suggestions: TerminalAutocompleteSuggestion[];
  command: string;
  anchor: { left: number; top: number; openAbove: boolean };
  selectedIndex: number;
  onAccept: (insertText: string) => void;
}

export function TerminalAutocompleteOverlay({
  suggestions,
  command,
  anchor,
  selectedIndex,
  onAccept,
}: TerminalAutocompleteOverlayProps) {
  if (suggestions.length === 0) {
    return null;
  }
  const activeIndex = Math.min(Math.max(selectedIndex, 0), suggestions.length - 1);

  return (
    <div
      className="absolute z-30 min-w-[280px] max-w-[min(560px,calc(100%-1rem))] overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--surface-elevated)] py-1 shadow-[var(--shadow-soft)]"
      style={{
        left: Math.max(4, anchor.left),
        top: anchor.openAbove ? undefined : anchor.top,
        bottom: anchor.openAbove ? `calc(100% - ${anchor.top - 2}px)` : undefined,
      }}
      role="listbox"
      aria-label="Command autocomplete suggestions"
    >
      {suggestions.map((suggestion, index) => {
        const suffix = suggestion.insertText.slice(command.length);
        const isActive = index === activeIndex;
        return (
          <button
            key={`${suggestion.source}:${suggestion.insertText}`}
            type="button"
            role="option"
            aria-selected={isActive}
            className={`flex h-9 w-full min-w-0 items-center gap-2 border-l-[3px] px-3 text-left font-mono text-[0.82rem] text-[var(--text)] ${
              isActive
                ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
                : 'border-transparent hover:bg-[var(--surface-hover)]'
            }`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAccept(suggestion.insertText)}
          >
            <span className="min-w-0 flex-none truncate">
              <span className="text-[var(--accent)]">{command}</span>
              <span>{suffix}</span>
            </span>
            {suggestion.description ? (
              <span className="min-w-0 flex-1 truncate text-[0.72rem] text-[var(--text-soft)]">
                {suggestion.description}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <span className="shrink-0 text-[0.68rem] text-[var(--text-soft)]">
              {sourceLabel(suggestion.source)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
