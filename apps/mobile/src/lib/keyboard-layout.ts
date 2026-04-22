export function getKeyboardDockInset(params: {
  keyboardVisible: boolean;
  keyboardInset: number;
  currentViewportHeight: number;
  keyboardClosedViewportHeight: number;
  minimumVisibleInset?: number;
}): number {
  const {
    keyboardVisible,
    keyboardInset,
    currentViewportHeight,
    keyboardClosedViewportHeight,
    minimumVisibleInset = 0,
  } = params;

  if (!keyboardVisible || keyboardInset <= 0) {
    return 0;
  }

  const viewportShrink = Math.max(
    0,
    keyboardClosedViewportHeight - currentViewportHeight,
  );

  return Math.max(minimumVisibleInset, keyboardInset - viewportShrink);
}
