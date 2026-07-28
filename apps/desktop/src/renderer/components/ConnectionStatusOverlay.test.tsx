import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStatusOverlay } from './ConnectionStatusOverlay';

// 이 오버레이는 연결이 진행 중일 때 화면을 덮는다. 사람이 브라우저에서 할 일이 있는 단계에서는
// 그 창을 다시 열거나 그만둘 수 있어야 한다 — 버튼이 없으면 갇힌 것과 같다.
describe('ConnectionStatusOverlay', () => {
  it('offers the browser action and cancel while waiting', () => {
    const onSecondaryAction = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConnectionStatusOverlay
        error={false}
        title="Connecting"
        message="브라우저에서 로그인을 마쳐 주세요."
        showCancel
        cancelLabel="취소"
        onCancel={onCancel}
        secondaryActionLabel="브라우저 다시 열기"
        onSecondaryAction={onSecondaryAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '브라우저 다시 열기' }));
    expect(onSecondaryAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // 버튼이 있는데 클릭이 통하지 않으면 소용이 없다. 진행 중 오버레이는 기본적으로 클릭을
  // 통과시키므로(pointer-events-none), 상호작용이 필요한 경우 그것이 풀려야 한다.
  it('accepts clicks when it has an action', () => {
    const { container } = render(
      <ConnectionStatusOverlay
        error={false}
        title="Connecting"
        message="대기 중"
        secondaryActionLabel="브라우저 다시 열기"
        onSecondaryAction={vi.fn()}
      />,
    );

    expect(container.firstElementChild?.className).toContain('pointer-events-auto');
  });

  // 아무 동작도 없는 단순 진행 표시는 터미널 클릭을 막지 않아야 한다.
  it('stays click-through when there is nothing to do', () => {
    const { container } = render(
      <ConnectionStatusOverlay error={false} title="Connecting" message="연결 중" />,
    );

    expect(container.firstElementChild?.className).toContain('pointer-events-none');
  });
});

// 실패 화면에도 사용자가 그 자리에서 할 수 있는 일이 있을 수 있다 — tailnet 재로그인처럼.
// 다른 화면으로 보내지 않고 여기서 끝내야 한다.
describe('ConnectionStatusOverlay on failure', () => {
  it('offers the recovery action next to retry and close', () => {
    const onSecondaryAction = vi.fn();
    const onRetry = vi.fn();

    render(
      <ConnectionStatusOverlay
        error
        title="Connection Failed"
        message="tailnet 을 통해 호스트에 닿지 못했습니다."
        onRetry={onRetry}
        onClose={vi.fn()}
        secondaryActionLabel="tailnet 다시 로그인"
        onSecondaryAction={onSecondaryAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'tailnet 다시 로그인' }));
    expect(onSecondaryAction).toHaveBeenCalledTimes(1);

    // 기존 동작은 그대로 남아야 한다.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('shows only retry and close when there is nothing to recover', () => {
    render(
      <ConnectionStatusOverlay
        error
        title="Connection Failed"
        message="연결 실패"
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
