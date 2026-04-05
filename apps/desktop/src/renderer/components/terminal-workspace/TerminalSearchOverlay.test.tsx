import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';

describe('TerminalSearchOverlay', () => {
  it('forwards search input and control actions', () => {
    const onBlur = vi.fn();
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    const onFindPrevious = vi.fn();
    const onFindNext = vi.fn();
    const onClose = vi.fn();

    render(
      <TerminalSearchOverlay
        inputRef={{ current: null }}
        searchQuery="hello"
        onBlur={onBlur}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onFindPrevious={onFindPrevious}
        onFindNext={onFindNext}
        onClose={onClose}
      />,
    );

    const input = screen.getByLabelText('Search terminal output');
    fireEvent.change(input, { target: { value: 'world' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onChange).toHaveBeenCalledWith('world');
    expect(onKeyDown).toHaveBeenCalled();
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(onFindPrevious).toHaveBeenCalledTimes(1);
    expect(onFindNext).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
