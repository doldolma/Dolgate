/**
 * 브라우저 휠 이벤트를 원격 프로토콜이 쓰는 단위로 옮긴다.
 *
 * RDP·VNC 가 같은 표를 쓴다. 한 곳에 두는 이유는 `deltaMode` 환산이 눈으로 검증할 수 없는 종류의
 * 값이기 때문이다 — 두 벌로 두면 한쪽만 고쳐도 아무 테스트가 깨지지 않는다.
 */

/**
 * 노치 하나에 해당하는 픽셀 수(deltaMode = pixel 일 때).
 *
 * 휠 한 칸을 굴리면 브라우저가 대략 100px 를 준다. 트랙패드는 같은 단위로 훨씬 작은 값을 훨씬
 * 자주 준다 — 그래서 이벤트마다 노치 하나씩 보내면 짧게 쓸어도 수백 줄이 넘어간다.
 */
const WHEEL_PIXELS_PER_NOTCH = 100;

/** deltaMode = line 일 때 노치 하나에 해당하는 줄 수. 윈도우 기본값과 같다. */
const WHEEL_LINES_PER_NOTCH = 3;

/** 브라우저가 준 스크롤량을 노치 수로 옮긴다. */
export function wheelDeltaToNotches(delta: number, deltaMode: number): number {
  if (deltaMode === 1) {
    return delta / WHEEL_LINES_PER_NOTCH;
  }
  if (deltaMode === 2) {
    // 페이지 단위. 한 페이지를 한 노치로 보면 너무 굼떠서 화면 한 장을 여러 노치로 나눈다.
    return delta * WHEEL_LINES_PER_NOTCH;
  }
  return delta / WHEEL_PIXELS_PER_NOTCH;
}

/**
 * 한 번에 보낼 노치 수의 상한.
 *
 * VNC 는 노치 하나를 버튼 누름/뗌 두 메시지로 보낸다. 관성 스크롤이 큰 값을 한 번에 주면 그만큼의
 * 메시지가 한 묶음에 실려 원격이 한참 스크롤한다.
 */
const MAX_NOTCHES_AT_ONCE = 6;

/** 소수 노치를 모아 두는 자리. 호출부가 ref 로 들고 있는다. */
export interface WheelAccumulator {
  vertical: number;
  horizontal: number;
}

export function createWheelAccumulator(): WheelAccumulator {
  return { vertical: 0, horizontal: 0 };
}

/**
 * 이번 이벤트로 보낼 **정수** 노치 수를 꺼낸다. 소수는 누적기에 남아 다음 번에 마저 쓰인다.
 *
 * 트랙패드는 한 번 쓸 때 0.5 노치짜리 이벤트를 수십 개 준다. 반올림해서 버리면 스크롤이 아예
 * 안 되고(0 이 되어 버린다), 이벤트마다 한 노치를 보내면 너무 빠르다.
 */
export function takeWheelNotches(
  accumulator: WheelAccumulator,
  event: { deltaX: number; deltaY: number; deltaMode: number },
): { vertical: number; horizontal: number } {
  accumulator.vertical += wheelDeltaToNotches(event.deltaY, event.deltaMode);
  accumulator.horizontal += wheelDeltaToNotches(event.deltaX, event.deltaMode);

  const vertical = clampNotches(accumulator.vertical);
  const horizontal = clampNotches(accumulator.horizontal);
  accumulator.vertical -= vertical;
  accumulator.horizontal -= horizontal;
  return { vertical, horizontal };
}

function clampNotches(value: number): number {
  const whole = Math.trunc(value);
  if (whole > MAX_NOTCHES_AT_ONCE) {
    return MAX_NOTCHES_AT_ONCE;
  }
  if (whole < -MAX_NOTCHES_AT_ONCE) {
    return -MAX_NOTCHES_AT_ONCE;
  }
  return whole;
}
