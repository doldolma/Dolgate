import {
  applyTrackpadMove,
  directTouchToRemote,
  remoteToViewport,
  applyPinchZoom,
  calculateEdgePan,
  clampPan,
  classifyTap,
  calculateFitScale,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP,
  isRepeatTap,
  getInitialZoomState,
  LONG_PRESS_MS,
  panToRevealCursor,
  TAP_SLOP,
  TAP_TIMEOUT_MS,
  type GestureState,
  type ZoomState,
} from '../src/lib/remote-desktop-gestures';

describe('remote-desktop-gestures', () => {
  const defaultState: GestureState = {
    cursorX: 500,
    cursorY: 400,
    zoomScale: 1.0,
    panX: 0,
    panY: 0,
    remoteWidth: 1920,
    remoteHeight: 1080,
    viewportWidth: 390,
    viewportHeight: 844,
  };

  describe('applyTrackpadMove', () => {
    it('moves cursor by scaled delta', () => {
      const result = applyTrackpadMove(defaultState, 10, 5);
      expect(result.cursorX).toBeGreaterThan(defaultState.cursorX);
      expect(result.cursorY).toBeGreaterThan(defaultState.cursorY);
    });

    it('clamps cursor to remote framebuffer bounds', () => {
      const result = applyTrackpadMove(defaultState, -10000, -10000);
      expect(result.cursorX).toBe(0);
      expect(result.cursorY).toBe(0);
    });

    it('clamps cursor to max bounds', () => {
      const result = applyTrackpadMove(defaultState, 10000, 10000);
      expect(result.cursorX).toBe(1920);
      expect(result.cursorY).toBe(1080);
    });

    it('respects sensitivity parameter', () => {
      const normal = applyTrackpadMove(defaultState, 10, 0, 1.5);
      const high = applyTrackpadMove(defaultState, 10, 0, 3.0);
      expect(high.cursorX - defaultState.cursorX).toBeGreaterThan(
        normal.cursorX - defaultState.cursorX,
      );
    });
  });

  describe('directTouchToRemote', () => {
    it('converts viewport center to remote center (no zoom)', () => {
      const zoom: ZoomState = { scale: 1.0, mode: 'fit', panX: 0, panY: 0 };
      // At fit scale with 390x844 viewport and 1920x1080 remote,
      // the fit scale is min(390/1920, 844/1080) ≈ 0.2031
      const fitScale = Math.min(390 / 1920, 844 / 1080);
      const offsetX = (390 - 1920 * fitScale) / 2;
      const offsetY = (844 - 1080 * fitScale) / 2;
      const centerX = offsetX + (1920 * fitScale) / 2;
      const centerY = offsetY + (1080 * fitScale) / 2;

      const result = directTouchToRemote(
        centerX, centerY, zoom, 390, 844, 1920, 1080,
      );
      expect(Math.round(result.x)).toBeCloseTo(960, -1);
      expect(Math.round(result.y)).toBeCloseTo(540, -1);
    });

    it('clamps to remote bounds', () => {
      const zoom: ZoomState = { scale: 1.0, mode: 'fit', panX: 0, panY: 0 };
      const result = directTouchToRemote(0, 0, zoom, 390, 844, 1920, 1080);
      expect(result.x).toBeGreaterThanOrEqual(0);
      expect(result.y).toBeGreaterThanOrEqual(0);
    });
  });

  describe('applyPinchZoom', () => {
    it('zooms in from scale 1.0', () => {
      const initial: ZoomState = { scale: 1.0, mode: 'fit', panX: 0, panY: 0 };
      const result = applyPinchZoom(initial, 195, 422, 1.5);
      expect(result.scale).toBe(1.5);
      expect(result.mode).toBe('custom');
    });

    it('clamps to minimum scale', () => {
      const initial: ZoomState = { scale: 1.5, mode: 'custom', panX: 0, panY: 0 };
      const result = applyPinchZoom(initial, 195, 422, 0.1, 1.0, 5.0);
      expect(result.scale).toBe(1.0);
      expect(result.mode).toBe('fit');
    });

    it('clamps to maximum scale', () => {
      const initial: ZoomState = { scale: 4.0, mode: 'custom', panX: 0, panY: 0 };
      const result = applyPinchZoom(initial, 195, 422, 2.0, 1.0, 5.0);
      expect(result.scale).toBe(5.0);
    });
  });

  describe('calculateEdgePan', () => {
    it('returns null when not zoomed', () => {
      const zoom: ZoomState = { scale: 1.0, mode: 'fit', panX: 0, panY: 0 };
      const result = calculateEdgePan(20, 400, 390, 844, zoom);
      expect(result).toBeNull();
    });

    it('pans right when cursor near left edge while zoomed', () => {
      const zoom: ZoomState = { scale: 2.0, mode: 'custom', panX: 0, panY: 0 };
      const result = calculateEdgePan(10, 400, 390, 844, zoom);
      expect(result).not.toBeNull();
      expect(result!.panDeltaX).toBeGreaterThan(0);
    });

    it('pans left when cursor near right edge while zoomed', () => {
      const zoom: ZoomState = { scale: 2.0, mode: 'custom', panX: 0, panY: 0 };
      const result = calculateEdgePan(380, 400, 390, 844, zoom);
      expect(result).not.toBeNull();
      expect(result!.panDeltaX).toBeLessThan(0);
    });

    it('returns null when cursor in center', () => {
      const zoom: ZoomState = { scale: 2.0, mode: 'custom', panX: 0, panY: 0 };
      const result = calculateEdgePan(195, 422, 390, 844, zoom);
      expect(result).toBeNull();
    });
  });

  describe('clampPan', () => {
    it('resets pan when scale is 1', () => {
      const zoom: ZoomState = { scale: 1.0, mode: 'fit', panX: 100, panY: 50 };
      const result = clampPan(zoom, 390, 844);
      expect(result.panX).toBe(0);
      expect(result.panY).toBe(0);
    });

    it('clamps pan within bounds when zoomed', () => {
      const zoom: ZoomState = { scale: 2.0, mode: 'custom', panX: 9999, panY: 9999 };
      const result = clampPan(zoom, 390, 844);
      expect(result.panX).toBeLessThanOrEqual((2 - 1) * 390 * 0.5);
      expect(result.panY).toBeLessThanOrEqual((2 - 1) * 844 * 0.5);
    });
  });

  describe('classifyTap', () => {
    it('classifies single-finger short tap as left-click', () => {
      const result = classifyTap(1, 100, 5);
      expect(result.type).toBe('left-click');
    });

    it('classifies two-finger short tap as right-click', () => {
      const result = classifyTap(2, 100, 5);
      expect(result.type).toBe('right-click');
    });

    it('rejects tap with too much movement', () => {
      const result = classifyTap(1, 100, TAP_SLOP + 1);
      expect(result.type).toBe('none');
    });

    // 300~500ms 사이는 판정하지 않는다. 느린 탭을 우클릭으로, 조금 일찍 뗀 길게 누르기를
    // 좌클릭으로 오인하는 것 둘 다 의도한 적 없는 결과다.
    it('rejects a tap in the gap between a tap and a long press', () => {
      const result = classifyTap(1, TAP_TIMEOUT_MS + 1, 5);
      expect(result.type).toBe('none');
    });

    it('rejects three-finger tap', () => {
      const result = classifyTap(3, 100, 5);
      expect(result.type).toBe('none');
    });

    // 폰에서 컨텍스트 메뉴는 길게 누르기다. Microsoft 원격 데스크톱도 tap-and-hold 를 쓴다.
    it('classifies a stationary long press as right-click', () => {
      expect(classifyTap(1, LONG_PRESS_MS, 0).type).toBe('right-click');
      expect(classifyTap(1, LONG_PRESS_MS + 900, 5).type).toBe('right-click');
    });

    /**
     * **드래그와 길게 누르기를 가르는 것은 시간이 아니라 움직임이다.**
     *
     * 손가락이 슬롭을 넘어 움직였으면 얼마나 오래 눌렀든 클릭이 아니다 — 터치 모드에서는 그
     * 시점에 이미 좌버튼이 눌려 끌리고 있다. 그래서 "누른 채 기다렸다가 끌기" 도 드래그로 남고,
     * 타이머 없이 이 한 줄로 갈린다.
     */
    it('never turns a drag into a click, however long it was held', () => {
      expect(classifyTap(1, LONG_PRESS_MS + 2000, TAP_SLOP + 1).type).toBe(
        'none',
      );
      expect(classifyTap(1, 50, TAP_SLOP + 1).type).toBe('none');
    });

    // 두 손가락은 트랙패드 관습으로 남긴다 — 오래 눌렀을 때는 판정하지 않는다(핀치 잔여).
    it('keeps the two-finger tap but only when it is short', () => {
      expect(classifyTap(2, 100, 5).type).toBe('right-click');
      expect(classifyTap(2, LONG_PRESS_MS + 100, 5).type).toBe('none');
    });
  });

  describe('calculateFitScale', () => {
    it('returns correct fit scale', () => {
      const scale = calculateFitScale(390, 844, 1920, 1080);
      expect(scale).toBeCloseTo(Math.min(390 / 1920, 844 / 1080));
    });

    it('returns 1.0 for zero remote dimensions', () => {
      expect(calculateFitScale(390, 844, 0, 0)).toBe(1.0);
    });
  });

  describe('getInitialZoomState', () => {
    it('returns scale 1 with fit mode', () => {
      const state = getInitialZoomState('fit');
      expect(state.scale).toBe(1.0);
      expect(state.mode).toBe('fit');
      expect(state.panX).toBe(0);
      expect(state.panY).toBe(0);
    });
  });
});

describe('remoteToViewport', () => {
  const zoom: ZoomState = { scale: 1, mode: 'fit', panX: 0, panY: 0 };

  // 두 변환이 어긋나면 커서가 손가락과 다른 곳에 그려져 조준이 불가능해진다.
  // 왕복해서 같은 점으로 돌아오는지가 그 계약이다.
  //
  // **그려진 이미지 안의 점만** 왕복한다. 874x398 뷰포트에 1280x720 을 넣으면 가로로 83~790
  // 구간만 그림이고 양옆은 레터박스다 — 그 밖은 directTouchToRemote 가 의도적으로 가장자리로
  // 클램프하므로 되돌아올 수 없다(아래 별도 테스트).
  it('is the inverse of directTouchToRemote inside the drawn image', () => {
    for (const point of [
      { x: 200, y: 120 },
      { x: 500, y: 300 },
      { x: 780, y: 20 },
    ]) {
      const remote = directTouchToRemote(
        point.x,
        point.y,
        zoom,
        874,
        398,
        1280,
        720,
      );
      const back = remoteToViewport(
        remote.x,
        remote.y,
        zoom,
        874,
        398,
        1280,
        720,
      );
      expect(back.x).toBeCloseTo(point.x, 4);
      expect(back.y).toBeCloseTo(point.y, 4);
    }
  });

  it('keeps the letterbox offset and zoom in the round trip', () => {
    const zoomed: ZoomState = { scale: 1.7, mode: 'fit', panX: -40, panY: 15 };
    const remote = directTouchToRemote(300, 200, zoomed, 874, 398, 1280, 720);
    const back = remoteToViewport(remote.x, remote.y, zoomed, 874, 398, 1280, 720);
    expect(back.x).toBeCloseTo(300, 4);
    expect(back.y).toBeCloseTo(200, 4);
  });

  // 레터박스를 누르면 가장자리로 클램프된다 — 커서도 그 가장자리에 그려져야 하고,
  // 손가락 위치로 돌아가서는 안 된다(원격에는 그 좌표가 없다).
  it('draws the clamped edge for a touch in the letterbox', () => {
    const remote = directTouchToRemote(860, 20, zoom, 874, 398, 1280, 720);
    expect(remote.x).toBe(1280);
    const back = remoteToViewport(remote.x, remote.y, zoom, 874, 398, 1280, 720);
    expect(back.x).toBeLessThan(860);
    expect(back.x).toBeCloseTo(790.75, 1);
  });

  // 원격 화면 중앙은 그려진 이미지의 중앙에 와야 한다(레터박스 포함).
  it('maps the remote centre to the drawn centre', () => {
    const centre = remoteToViewport(640, 360, zoom, 874, 398, 1280, 720);
    expect(centre.x).toBeCloseTo(437, 0);
    expect(centre.y).toBeCloseTo(199, 0);
  });
});

describe('확대 상태의 화면 이동', () => {
  const zoomed: ZoomState = { scale: 2, mode: 'custom', panX: 0, panY: 0 };

  /**
   * 화면에도 `transformOrigin: 'top left'` 를 걸어 두므로 pan 은 **전부 음수**여야 한다.
   * 0 이 왼쪽·위 끝이고 음수로 갈수록 오른쪽·아래가 보인다. 예전 범위(±절반)는 중심 원점의
   * 것이어서, 오른쪽 절반에 닿을 수 없고 양수로 밀리면 화면이 통째로 빠져 검게 보였다.
   */
  it('pan 을 좌상단 원점 범위로 가둔다', () => {
    // 2배 확대에서 뷰포트 874 → 내용은 1748, 유효 pan 은 -874..0
    expect(clampPan({ ...zoomed, panX: 100 }, 874, 398).panX).toBe(0);
    expect(clampPan({ ...zoomed, panX: -400 }, 874, 398).panX).toBe(-400);
    expect(clampPan({ ...zoomed, panX: -2000 }, 874, 398).panX).toBe(-874);
    expect(clampPan({ ...zoomed, panY: -1000 }, 874, 398).panY).toBe(-398);
  });

  it('확대하지 않았으면 pan 이 없다', () => {
    const flat = clampPan({ scale: 1, mode: 'fit', panX: -50, panY: 20 }, 874, 398);
    expect(flat.panX).toBe(0);
    expect(flat.panY).toBe(0);
  });

  // 화면 이동의 방아쇠는 손가락이 아니라 커서다. 손가락 기준이면 트랙패드 모드에서
  // 커서만 끝까지 가고 화면은 끝내 안 움직인다.
  it('커서가 오른쪽 가장자리에 오면 화면이 따라온다', () => {
    const followed = panToRevealCursor(zoomed, 860, 200, 874, 398, 40);
    expect(followed.panX).toBeLessThan(0);
    // 커서를 여유 안쪽으로 들여놓을 만큼만 옮긴다.
    expect(followed.panX).toBeCloseTo(874 - 40 - 860, 5);
  });

  it('커서가 왼쪽 가장자리에 오면 반대로 따라온다', () => {
    const moved = panToRevealCursor(
      { ...zoomed, panX: -300 },
      10,
      200,
      874,
      398,
      40,
    );
    expect(moved.panX).toBeGreaterThan(-300);
  });

  it('가운데 있으면 움직이지 않는다', () => {
    const still = panToRevealCursor(zoomed, 437, 199, 874, 398, 40);
    expect(still.panX).toBe(0);
    expect(still.panY).toBe(0);
  });

  it('끝을 넘어서까지 밀지 않는다', () => {
    const atEdge = panToRevealCursor(
      { ...zoomed, panX: -874 },
      870,
      200,
      874,
      398,
      40,
    );
    expect(atEdge.panX).toBe(-874);
  });

  /**
   * 감도가 확대율을 반영해야 한다. 예전에는 `zoomScale` 을 쓰지 않아서, 확대할수록 커서가
   * 손가락보다 빨라져 원격 가장자리에 즉시 박혔다 — 화면은 따라오지 않으니 조준이 불가능했다.
   */
  it('확대해도 커서 속도가 화면에서 일정하다', () => {
    const base = {
      cursorX: 0,
      cursorY: 0,
      remoteWidth: 1280,
      remoteHeight: 720,
      viewportWidth: 874,
      viewportHeight: 398,
      panX: 0,
      panY: 0,
    };
    const atOne = applyTrackpadMove({ ...base, zoomScale: 1 }, 100, 0);
    const atTwo = applyTrackpadMove({ ...base, zoomScale: 2 }, 100, 0);
    // 원격 좌표로는 절반만 움직이지만, 화면은 2배로 확대돼 있으니 눈에 보이는 이동량은 같다.
    expect(atTwo.cursorX).toBeCloseTo(atOne.cursorX / 2, 5);
  });
});

/**
 * 직접 터치 모드의 더블클릭.
 *
 * 탭마다 그 좌표로 포인터를 옮기면 두 클릭이 몇 px 어긋나고, 원격은 더블클릭으로 세지 않는다
 * (윈도우 기본 판정 사각형은 4px). Fit 으로 축소해 보면 화면 1pt 가 원격 여러 px 이라 손가락
 * 흔들림만으로 임계를 넘는다 — 그래서 "같은 자리 다시 탭" 을 우리가 판정한다.
 */
describe('isRepeatTap', () => {
  it('직전 클릭이 없으면 아니다', () => {
    expect(isRepeatTap(null, 100, 100, 1_000)).toBe(false);
  });

  it('같은 자리를 시간 안에 다시 탭하면 맞다', () => {
    const previous = { x: 100, y: 100, at: 1_000 };
    expect(isRepeatTap(previous, 104, 97, 1_000 + DOUBLE_TAP_MS - 1)).toBe(true);
  });

  it('시간이 지나면 아니다 — 한참 뒤의 탭은 새 클릭이다', () => {
    const previous = { x: 100, y: 100, at: 1_000 };
    expect(isRepeatTap(previous, 100, 100, 1_000 + DOUBLE_TAP_MS + 1)).toBe(
      false,
    );
  });

  it('멀리 떨어진 탭은 아니다 — 다른 곳을 누른 것이다', () => {
    const previous = { x: 100, y: 100, at: 1_000 };
    expect(
      isRepeatTap(previous, 100 + DOUBLE_TAP_SLOP + 1, 100, 1_100),
    ).toBe(false);
  });

  // 손가락 흔들림은 한 번의 탭 안에서 허용하는 값보다 커야 걸러지지 않는다.
  it('한 번의 탭에서 허용하는 흔들림보다 넉넉하다', () => {
    expect(DOUBLE_TAP_SLOP).toBeGreaterThan(TAP_SLOP);
  });
});
