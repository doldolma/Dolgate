import type { KeyboardEvent, MutableRefObject } from 'react';

interface TerminalSearchOverlayProps {
  inputRef: MutableRefObject<HTMLInputElement | null>;
  searchQuery: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onFindPrevious: () => void;
  onFindNext: () => void;
  onClose: () => void;
}

export function TerminalSearchOverlay({
  inputRef,
  searchQuery,
  onBlur,
  onChange,
  onKeyDown,
  onFindPrevious,
  onFindNext,
  onClose,
}: TerminalSearchOverlayProps) {
  return (
    <div
      className="terminal-search-overlay"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        aria-label="Search terminal output"
        type="text"
        value={searchQuery}
        placeholder="Search terminal output"
        onBlur={onBlur}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="terminal-search-overlay__button"
        onClick={onFindPrevious}
      >
        Prev
      </button>
      <button
        type="button"
        className="terminal-search-overlay__button"
        onClick={onFindNext}
      >
        Next
      </button>
      <button
        type="button"
        className="terminal-search-overlay__button"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}
