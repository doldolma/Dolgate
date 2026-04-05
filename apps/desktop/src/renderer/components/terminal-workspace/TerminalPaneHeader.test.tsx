import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalPaneHeader } from './TerminalPaneHeader';

describe('TerminalPaneHeader', () => {
  it('focuses and closes through header actions', () => {
    const onFocus = vi.fn();
    const onClose = vi.fn();

    render(
      <TerminalPaneHeader
        sessionId="session-1"
        title="Prod Shell"
        active
        draggingDisabled={false}
        closingDisabled={false}
        onFocus={onFocus}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Prod Shell' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prod Shell 세션 종료' }));

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('writes the session id into the drag payload when dragging starts', () => {
    const setData = vi.fn();
    const onStartDrag = vi.fn();

    render(
      <TerminalPaneHeader
        sessionId="session-1"
        title="Prod Shell"
        active={false}
        draggingDisabled={false}
        closingDisabled={false}
        onStartDrag={onStartDrag}
      />,
    );

    fireEvent.dragStart(screen.getByText('Prod Shell').closest('div')!, {
      dataTransfer: {
        effectAllowed: 'none',
        setData,
      },
    });

    expect(setData).toHaveBeenCalledWith(
      'application/x-dolssh-session-id',
      'session-1',
    );
    expect(onStartDrag).toHaveBeenCalledTimes(1);
  });
});
