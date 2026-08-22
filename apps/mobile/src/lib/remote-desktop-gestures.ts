/**
 * Remote Desktop Touch/Trackpad Gesture Calculations
 *
 * Pure calculation logic for interpreting touch gestures as remote desktop
 * pointer/scroll/zoom actions. No native dependencies — suitable for unit testing.
 *
 * Phone-primary trackpad UX:
 *  - One finger drag → pointer move (relative)
 *  - Single tap → left click
 *  - Two-finger tap → right click
 *  - Two-finger scroll → scroll event
 *  - Pinch → local zoom (no remote effect)
 *  - Edge pan (while zoomed) → auto-pan the viewport
 *  - Direct Touch toggle → fingers map 1:1 to remote coordinates
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GestureInputMode = 'trackpad' | 'touch';

export interface Point {
  x: number;
  y: number;
}

export interface GestureState {
  /** Current remote cursor position (normalized 0..1 or absolute remote px). */
  cursorX: number;
  cursorY: number;
  /** Local zoom level (1.0 = fit). */
  zoomScale: number;
  /** Pan offset within the zoomed viewport (px). */
  panX: number;
  panY: number;
  /** Remote framebuffer dimensions. */
  remoteWidth: number;
  remoteHeight: number;
  /** Local viewport dimensions. */
  viewportWidth: number;
  viewportHeight: number;
}

export type ScaleMode = 'fit' | 'actual' | 'custom';

export interface ZoomState {
  scale: number;
  mode: ScaleMode;
  panX: number;
  panY: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Edge zone width for auto-pan (px from viewport edge). */
const EDGE_PAN_ZONE = 40;
/** Auto-pan speed (px per frame equivalent). */
const EDGE_PAN_SPEED = 8;
/** Minimum pinch distance change to register as zoom (px). */
const PINCH_THRESHOLD = 5;
/** Tap maximum movement to still count as tap (px). */
const TAP_SLOP = 10;
/** Maximum time for a tap gesture (ms). */
const TAP_TIMEOUT_MS = 300;
/** Two-finger tap: max time between both fingers touching (ms). */
const TWO_FINGER_TAP_WINDOW_MS = 100;

export {
  EDGE_PAN_ZONE,
  EDGE_PAN_SPEED,
  PINCH_THRESHOLD,
  TAP_SLOP,
  TAP_TIMEOUT_MS,
  TWO_FINGER_TAP_WINDOW_MS,
};

// ---------------------------------------------------------------------------
// Trackpad Mode Calculations
// ---------------------------------------------------------------------------

/**
 * Calculate new cursor position from a relative drag delta.
 * Sensitivity scales with zoom level so dragging feels consistent regardless.
 */
export function applyTrackpadMove(
  state: GestureState,
  deltaX: number,
  deltaY: number,
  sensitivity: number = 1.5,
): Pick<GestureState, 'cursorX' | 'cursorY'> {
  // **확대율로 나눈다.** 주석은 원래 "확대에 따라 감도가 조절된다"고 적혀 있었지만 실제로는
  // `zoomScale` 을 쓰지 않았다. 그래서 100% 로 확대하면 커서가 손가락보다 배 이상 빨리 달려
  // 원격 가장자리에 즉시 박히고, 정작 화면은 따라오지 않았다. 나눠 두면 **화면에서 보이는**
  // 커서 속도가 확대율과 무관하게 일정해진다.
  const zoomScale = state.zoomScale > 0 ? state.zoomScale : 1;
  const scaleX =
    ((state.remoteWidth / state.viewportWidth) * sensitivity) / zoomScale;
  const scaleY =
    ((state.remoteHeight / state.viewportHeight) * sensitivity) / zoomScale;

  const nextX = Math.max(
    0,
    Math.min(state.remoteWidth, state.cursorX + deltaX * scaleX),
  );
  const nextY = Math.max(
    0,
    Math.min(state.remoteHeight, state.cursorY + deltaY * scaleY),
  );

  return { cursorX: nextX, cursorY: nextY };
}

/**
 * Calculate remote coordinates from a direct touch position (touch mode).
 */
export function directTouchToRemote(
  touchX: number,
  touchY: number,
  zoom: ZoomState,
  viewportWidth: number,
  viewportHeight: number,
  remoteWidth: number,
  remoteHeight: number,
): Point {
  // Account for zoom and pan
  const effectiveX = (touchX - zoom.panX) / zoom.scale;
  const effectiveY = (touchY - zoom.panY) / zoom.scale;

  // Convert viewport coordinates to remote coordinates
  const fitScaleX = viewportWidth / remoteWidth;
  const fitScaleY = viewportHeight / remoteHeight;
  const fitScale = Math.min(fitScaleX, fitScaleY);

  const offsetX = (viewportWidth - remoteWidth * fitScale) / 2;
  const offsetY = (viewportHeight - remoteHeight * fitScale) / 2;

  const remoteX = Math.max(
    0,
    Math.min(remoteWidth, (effectiveX - offsetX) / fitScale),
  );
  const remoteY = Math.max(
    0,
    Math.min(remoteHeight, (effectiveY - offsetY) / fitScale),
  );

  return { x: remoteX, y: remoteY };
}

/**
 * 원격 좌표를 화면(뷰포트) 좌표로 되돌린다. [`directTouchToRemote`] 의 역변환이다.
 *
 * 트랙패드 커서를 그리는 데 쓴다. 두 함수가 같은 항(fit 배율·레터박스 offset·zoom·pan)을 쓰지
 * 않으면 **손가락이 가리키는 곳과 커서가 어긋나** 조준이 불가능해진다 — 그래서 나란히 둔다.
 */
export function remoteToViewport(
  remoteX: number,
  remoteY: number,
  zoom: ZoomState,
  viewportWidth: number,
  viewportHeight: number,
  remoteWidth: number,
  remoteHeight: number,
): Point {
  const fitScaleX = viewportWidth / remoteWidth;
  const fitScaleY = viewportHeight / remoteHeight;
  const fitScale = Math.min(fitScaleX, fitScaleY);

  const offsetX = (viewportWidth - remoteWidth * fitScale) / 2;
  const offsetY = (viewportHeight - remoteHeight * fitScale) / 2;

  return {
    x: (remoteX * fitScale + offsetX) * zoom.scale + zoom.panX,
    y: (remoteY * fitScale + offsetY) * zoom.scale + zoom.panY,
  };
}

// ---------------------------------------------------------------------------
// Pinch Zoom Calculations
// ---------------------------------------------------------------------------

/**
 * Calculate new zoom state from a pinch gesture.
 * Only affects local viewport — no remote pixel data moves through JS.
 */
export function applyPinchZoom(
  currentZoom: ZoomState,
  focalX: number,
  focalY: number,
  scaleDelta: number,
  minScale: number = 1.0,
  maxScale: number = 5.0,
): ZoomState {
  const nextScale = Math.max(
    minScale,
    Math.min(maxScale, currentZoom.scale * scaleDelta),
  );

  // Adjust pan to keep focal point stationary
  const panX =
    focalX - (focalX - currentZoom.panX) * (nextScale / currentZoom.scale);
  const panY =
    focalY - (focalY - currentZoom.panY) * (nextScale / currentZoom.scale);

  const mode: ScaleMode = nextScale === 1.0 ? 'fit' : 'custom';
  return { scale: nextScale, mode, panX, panY };
}

/**
 * Calculate auto-pan offset when the cursor is near a viewport edge.
 * Only applies when zoomed in (scale > 1).
 */
export function calculateEdgePan(
  cursorViewportX: number,
  cursorViewportY: number,
  viewportWidth: number,
  viewportHeight: number,
  currentZoom: ZoomState,
): { panDeltaX: number; panDeltaY: number } | null {
  if (currentZoom.scale <= 1.0) {
    return null;
  }

  let panDeltaX = 0;
  let panDeltaY = 0;

  if (cursorViewportX < EDGE_PAN_ZONE) {
    panDeltaX = EDGE_PAN_SPEED;
  } else if (cursorViewportX > viewportWidth - EDGE_PAN_ZONE) {
    panDeltaX = -EDGE_PAN_SPEED;
  }

  if (cursorViewportY < EDGE_PAN_ZONE) {
    panDeltaY = EDGE_PAN_SPEED;
  } else if (cursorViewportY > viewportHeight - EDGE_PAN_ZONE) {
    panDeltaY = -EDGE_PAN_SPEED;
  }

  if (panDeltaX === 0 && panDeltaY === 0) {
    return null;
  }

  return { panDeltaX, panDeltaY };
}

/**
 * Clamp pan values so the viewport doesn't pan past the content boundaries.
 */
/**
 * 확대된 화면이 뷰포트를 벗어나 빈 자리가 보이지 않게 pan 을 가둔다.
 *
 * **좌상단 원점 기준이다**(화면에도 `transformOrigin: 'top left'` 를 걸어 맞춘다). 그 규칙에서
 * 확대된 내용은 `[0, scale*viewport]` 를 차지하므로, 유효한 pan 은 `[viewport - scale*viewport, 0]`
 * — **전부 음수**다. 0 이 왼쪽·위 끝이고, 음수로 갈수록 오른쪽·아래가 보인다.
 *
 * 예전에는 `±(scale-1)*viewport*0.5` 였다. 그것은 중심 원점의 범위이고, 좌상단 원점에서는
 * 필요한 음수 범위의 절반을 잘라내고 대신 아무것도 없는 양수 쪽을 허용했다 — 확대하면 오른쪽
 * 절반에 닿을 수 없고, 양수로 밀리면 화면이 통째로 빠져 검게 보였다.
 */
export function clampPan(
  zoom: ZoomState,
  viewportWidth: number,
  viewportHeight: number,
): ZoomState {
  if (zoom.scale <= 1.0) {
    return { ...zoom, panX: 0, panY: 0 };
  }

  const minPanX = viewportWidth - zoom.scale * viewportWidth;
  const minPanY = viewportHeight - zoom.scale * viewportHeight;

  return {
    ...zoom,
    panX: Math.max(minPanX, Math.min(0, zoom.panX)),
    panY: Math.max(minPanY, Math.min(0, zoom.panY)),
  };
}

/**
 * 커서가 화면 안에 남도록 pan 을 옮긴다.
 *
 * **화면 이동의 방아쇠는 손가락이 아니라 커서여야 한다.** 트랙패드 모드에서 손가락은 화면
 * 아무 데나 있어도 되므로, 손가락이 화면 가장자리에 닿는 것을 조건으로 두면(예전 edge-pan)
 * 확대 상태에서 커서만 원격 끝까지 가고 화면은 끝내 안 움직인다.
 *
 * `margin` 만큼 여유를 둬서 커서가 가장자리에 붙기 전에 화면이 따라오기 시작한다.
 */
export function panToRevealCursor(
  zoom: ZoomState,
  cursorScreenX: number,
  cursorScreenY: number,
  viewportWidth: number,
  viewportHeight: number,
  margin: number = EDGE_PAN_ZONE,
): ZoomState {
  if (zoom.scale <= 1.0) {
    return zoom;
  }
  // 여유가 뷰포트의 절반을 넘으면 좌우 조건이 서로를 밀어낸다.
  const safeMargin = Math.min(
    margin,
    Math.max(0, Math.min(viewportWidth, viewportHeight) / 2 - 1),
  );

  const shift = (position: number, size: number): number => {
    if (position < safeMargin) return safeMargin - position;
    if (position > size - safeMargin) return size - safeMargin - position;
    return 0;
  };

  return clampPan(
    {
      ...zoom,
      panX: zoom.panX + shift(cursorScreenX, viewportWidth),
      panY: zoom.panY + shift(cursorScreenY, viewportHeight),
    },
    viewportWidth,
    viewportHeight,
  );
}

// ---------------------------------------------------------------------------
// Tap Detection (pure)
// ---------------------------------------------------------------------------

export interface TapResult {
  type: 'left-click' | 'right-click' | 'none';
}

/**
 * Determine tap type from touch event metadata.
 */
/**
 * 길게 누르기를 우클릭으로 판정하는 시간(ms).
 *
 * 폰에서 컨텍스트 메뉴는 OS 전역으로 길게 누르기다(안드로이드 기본 500ms, iOS 0.5s). Microsoft
 * 원격 데스크톱도 tap-and-hold 를 우클릭으로 쓴다. 두 손가락 탭은 트랙패드 관습이라 폰에서는
 * 아무도 찾지 못하고 핀치 줌과도 경쟁한다 — 그래서 길게 누르기를 주 경로로 둔다.
 */
export const LONG_PRESS_MS = 500;

/**
 * 앞 클릭과 "같은 자리를 다시 눌렀다" 로 볼 시간 창(ms).
 *
 * 원격 OS 의 더블클릭 시간(윈도우 기본 500ms)보다 짧게 둔다 — 원격이 더블클릭으로 세지 않을
 * 만큼 느린 두 번째 탭까지 같은 자리로 맞춰 줄 이유가 없다.
 */
export const DOUBLE_TAP_MS = 400;

/**
 * 같은 자리로 볼 화면 거리(pt).
 *
 * 두 번 탭할 때 손가락은 반드시 조금 어긋난다. TAP_SLOP(한 번의 탭 안에서 허용하는 흔들림)
 * 보다 넉넉해야 한다 — 여기서 걸러지면 더블클릭이 아니라 단일 클릭 두 번이 된다.
 */
export const DOUBLE_TAP_SLOP = 24;

/** 직전 클릭이 일어난 화면 좌표와 시각. */
export interface TapMark {
  x: number;
  y: number;
  at: number;
}

/**
 * 직전 클릭과 같은 자리를 다시 탭한 것인지.
 *
 * **왜 필요한가:** 직접 터치 모드는 탭마다 그 좌표로 포인터를 옮긴다. 그런데 원격 OS 는 두
 * 클릭이 아주 가까울 때만 더블클릭으로 센다(윈도우 기본 4px). Fit 으로 축소해 보면 화면 1pt 가
 * 원격 여러 px 이라, 손가락이 1~2pt 흔들린 것만으로 임계를 넘어 더블클릭이 사라진다. 같은
 * 자리로 판정되면 호출부가 포인터를 **옮기지 않아** 두 클릭 좌표가 정확히 같아진다.
 */
export function isRepeatTap(
  previous: TapMark | null,
  x: number,
  y: number,
  at: number,
): boolean {
  if (!previous) return false;
  const elapsed = at - previous.at;
  if (elapsed < 0 || elapsed > DOUBLE_TAP_MS) return false;
  return Math.hypot(x - previous.x, y - previous.y) <= DOUBLE_TAP_SLOP;
}

export function classifyTap(
  touchCount: number,
  duration: number,
  totalMovement: number,
): TapResult {
  // **드래그와 길게 누르기는 움직임으로 갈린다.**
  //
  // 손가락이 TAP_SLOP 을 넘어 움직였으면 그 손짓은 드래그다 — 얼마나 오래 눌렀든 클릭이
  // 아니다(터치 모드에서는 그 시점에 이미 좌버튼이 눌려 끌리고 있다). 그래서 이 검사가 먼저다.
  // 덕분에 타이머가 필요 없다: "누른 채 기다렸다가 끌기" 도 움직인 순간 드래그로 남는다.
  if (totalMovement > TAP_SLOP) {
    return { type: 'none' };
  }
  if (touchCount === 1) {
    // 제자리에서 길게 눌렀다 떼면 우클릭. 폰에서 컨텍스트 메뉴가 그 손짓이다.
    if (duration >= LONG_PRESS_MS) {
      return { type: 'right-click' };
    }
    if (duration <= TAP_TIMEOUT_MS) {
      return { type: 'left-click' };
    }
    // 300~500ms 사이는 판정하지 않는다. 느린 탭을 우클릭으로 오인하거나, 길게 누르려다
    // 조금 일찍 뗀 것을 좌클릭으로 오인하는 것 둘 다 사용자가 의도한 적 없는 결과다.
    return { type: 'none' };
  }
  // 두 손가락 탭도 우클릭으로 남긴다(트랙패드·Chrome 원격 데스크톱 관습). 다만 발견 경로는
  // 길게 누르기와 툴바 버튼이다.
  if (touchCount === 2 && duration <= TAP_TIMEOUT_MS) {
    return { type: 'right-click' };
  }
  return { type: 'none' };
}

// ---------------------------------------------------------------------------
// Scale Mode
// ---------------------------------------------------------------------------

/**
 * Calculate the scale factor for 'fit' mode.
 */
export function calculateFitScale(
  viewportWidth: number,
  viewportHeight: number,
  remoteWidth: number,
  remoteHeight: number,
): number {
  if (remoteWidth === 0 || remoteHeight === 0) {
    return 1.0;
  }
  return Math.min(viewportWidth / remoteWidth, viewportHeight / remoteHeight);
}

/**
 * Get the initial zoom state for a given scale mode.
 */
export function getInitialZoomState(mode: ScaleMode): ZoomState {
  switch (mode) {
    case 'fit':
      return { scale: 1.0, mode: 'fit', panX: 0, panY: 0 };
    case 'actual':
      return { scale: 1.0, mode: 'actual', panX: 0, panY: 0 };
    case 'custom':
      return { scale: 1.0, mode: 'custom', panX: 0, panY: 0 };
  }
}
