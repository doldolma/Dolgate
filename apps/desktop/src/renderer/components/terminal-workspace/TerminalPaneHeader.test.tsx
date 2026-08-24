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

  it('지연을 오른쪽 아이콘 묶음 앞에 그린다', () => {
    // 분할에는 하단바가 없다(pane 마다 바가 붙으면 아래가 줄로 가득 찬다) — 그래서 지연은
    // 여기로 돌아왔다. 값이 없으면 칩 자체가 없다.
    const { container } = render(
      <TerminalPaneHeader
        sessionId="session-1"
        title="Prod Shell"
        subtitle="ubuntu@prod:22"
        active
        draggingDisabled={false}
        closingDisabled={false}
        rttMs={42}
        rttHistoryKey="stable-1"
      />,
    );

    expect(container.textContent).toMatch(/42ms/);
  });

  it('지연 값이 없으면 칩을 두지 않는다', () => {
    const { container } = render(
      <TerminalPaneHeader
        sessionId="session-1"
        title="Prod Shell"
        active
        draggingDisabled={false}
        closingDisabled={false}
        rttMs={null}
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
