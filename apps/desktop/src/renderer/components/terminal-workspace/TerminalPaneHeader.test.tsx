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

  it('지연은 그리지 않는다 — 세션 하단바로 옮겼다', () => {
    // 예전에는 여기에 점 + 숫자가 있었다. 하단바로 내린 뒤 같은 값이 두 곳에 뜨지 않게
    // prop 째 없앴으므로, 헤더에는 ms 표기가 남아 있어서는 안 된다.
    const { container } = render(
      <TerminalPaneHeader
        sessionId="session-1"
        title="Prod Shell"
        subtitle="ubuntu@prod:22"
        active
        draggingDisabled={false}
        closingDisabled={false}
      />,
    );

    expect(container.textContent).not.toMatch(/\d+\s*ms/);
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
