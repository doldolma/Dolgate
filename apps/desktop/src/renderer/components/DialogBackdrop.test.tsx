import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DialogBackdrop } from './DialogBackdrop';

function renderBackdrop(onDismiss = vi.fn()) {
  const view = render(
    <DialogBackdrop onDismiss={onDismiss}>
      <button type="button">Inside action</button>
    </DialogBackdrop>
  );

  return {
    ...view,
    backdrop: view.container.firstElementChild as HTMLDivElement,
    onDismiss,
  };
}

describe('DialogBackdrop', () => {
  it('dismisses only when the pointer starts on the backdrop', () => {
    const { backdrop, onDismiss } = renderBackdrop();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss when dragging from inside content to the backdrop', () => {
    const { backdrop, onDismiss } = renderBackdrop();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside action' }));
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
