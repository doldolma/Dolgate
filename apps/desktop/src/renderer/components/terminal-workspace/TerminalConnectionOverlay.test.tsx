import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';

describe('TerminalConnectionOverlay', () => {
  it('renders blocking copy without action buttons', () => {
    const { container } = render(
      <TerminalConnectionOverlay
        error={false}
        title="Connecting"
        message="세션을 연결하는 중입니다..."
      />,
    );

    expect(screen.getByText('Connecting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(
      container.querySelector('.terminal-connection-overlay'),
    ).toBeTruthy();
    expect(
      container.querySelector('.terminal-connection-overlay__card'),
    ).toBeTruthy();
    expect(
      container.querySelector('.terminal-connection-overlay__copy'),
    ).toBeTruthy();
    expect(
      container.querySelector('.terminal-connection-overlay__message'),
    ).toBeTruthy();
    expect(
      container.querySelector('.terminal-connection-overlay__card')?.tagName,
    ).toBe('DIV');
    expect(
      container.querySelector('.terminal-connection-overlay__message')?.tagName,
    ).toBe('P');
  });

  it('renders retry and close actions for errors', () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();

    render(
      <TerminalConnectionOverlay
        error
        title="Connection Failed"
        message="세션 연결에 실패했습니다."
        onRetry={onRetry}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
