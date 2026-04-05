import type { KeyboardEvent, MutableRefObject } from 'react';
import { Card, Button, Input } from '../../ui';

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
    <Card
      as="div"
      className="absolute right-4 top-4 z-[6] flex w-[min(26rem,calc(100%-2rem))] flex-wrap items-center justify-start gap-2 rounded-[20px] p-3 max-[760px]:left-3 max-[760px]:right-3"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Input
        ref={inputRef}
        aria-label="Search terminal output"
        type="text"
        className="min-w-[13.75rem] flex-[1_0_13.75rem]"
        value={searchQuery}
        placeholder="Search terminal output"
        onBlur={onBlur}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <Button type="button" variant="secondary" size="sm" onClick={onFindPrevious}>
        Prev
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={onFindNext}>
        Next
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={onClose}>
        Close
      </Button>
    </Card>
  );
}
