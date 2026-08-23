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

/**
 * 세션 화면 본문의 아래 여백.
 *
 * 바닥에 붙는 것(터미널 툴바, 원격 데스크톱 키 스트립)이 키보드에 덮이지 않게 그만큼 비운다.
 * 예전에는 터미널만 비웠고, 원격 데스크톱은 안드로이드 `adjustResize` 가 창을 줄여 주는 것에
 * 기대고 있었다 — iOS 는 창을 줄이지 않고, targetSdk 35+ 안드로이드는 edge-to-edge 강제로
 * 그 동작이 사라져 기기에 따라 키보드가 컨트롤바를 덮었다.
 */
export function getConnectionBodyPaddingBottom(params: {
  tabKind: 'terminal' | 'sftp' | 'rdp' | 'vnc';
  toolbarHeight: number;
  keyboardDockInset: number;
  safeAreaPaddingBottom: number;
}): number {
  const { tabKind, toolbarHeight, keyboardDockInset, safeAreaPaddingBottom } =
    params;

  if (tabKind === 'terminal') {
    return toolbarHeight + keyboardDockInset;
  }

  if (tabKind === 'rdp' || tabKind === 'vnc') {
    // 둘을 더하지 않는다 — 키보드가 떠 있으면 안전영역은 그 밑에 가려 의미가 없고,
    // 더하면 바가 그만큼 붕 뜬다. 안드로이드에서는 인셋 계산이 안전영역을 이미 품는다.
    return Math.max(safeAreaPaddingBottom, keyboardDockInset);
  }

  return safeAreaPaddingBottom;
}
