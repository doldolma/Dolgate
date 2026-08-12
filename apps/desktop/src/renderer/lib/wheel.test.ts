import { describe, expect, it } from "vitest";

import {
  createWheelAccumulator,
  takeWheelNotches,
  wheelDeltaToNotches,
} from "./wheel";

describe("wheelDeltaToNotches", () => {
  it("픽셀·줄·페이지 단위를 노치로 옮긴다", () => {
    expect(wheelDeltaToNotches(100, 0)).toBe(1);
    expect(wheelDeltaToNotches(3, 1)).toBe(1);
    expect(wheelDeltaToNotches(1, 2)).toBe(3);
  });
});

describe("takeWheelNotches", () => {
  it("정수만 꺼내고 소수는 남긴다", () => {
    // 트랙패드는 한 번 쓸 때 이런 값을 수십 개 준다. 반올림해서 버리면 스크롤이 아예 안 된다.
    const accumulator = createWheelAccumulator();

    expect(takeWheelNotches(accumulator, { deltaX: 0, deltaY: 60, deltaMode: 0 })).toEqual({
      vertical: 0,
      horizontal: 0,
    });
    expect(takeWheelNotches(accumulator, { deltaX: 0, deltaY: 60, deltaMode: 0 })).toEqual({
      vertical: 1,
      horizontal: 0,
    });
    // 남은 0.2 노치는 다음 이벤트에 더해진다.
    expect(takeWheelNotches(accumulator, { deltaX: 0, deltaY: 80, deltaMode: 0 })).toEqual({
      vertical: 1,
      horizontal: 0,
    });
  });

  it("소수점 스크롤을 정수로 돌려준다", () => {
    // 이 값이 그대로 코어로 가면 i16 이 아니라며 **묶음 전체가 버려졌다** — 스크롤이 하나도
    // 전달되지 않는 증상의 원인이다.
    const accumulator = createWheelAccumulator();
    const taken = takeWheelNotches(accumulator, {
      deltaX: 0,
      deltaY: -161.8218994140625,
      deltaMode: 0,
    });

    expect(Number.isInteger(taken.vertical)).toBe(true);
    expect(taken.vertical).toBe(-1);
  });

  it("관성 스크롤의 큰 값을 상한으로 자른다", () => {
    // 노치 하나가 버튼 누름/뗌 두 메시지다. 한 묶음에 수백 개가 실리면 원격이 한참 스크롤한다.
    const accumulator = createWheelAccumulator();
    const taken = takeWheelNotches(accumulator, {
      deltaX: 0,
      deltaY: 100000,
      deltaMode: 0,
    });

    expect(taken.vertical).toBe(6);
    // 자른 만큼은 버리지 않고 남겨 다음 이벤트에 마저 보낸다.
    expect(
      takeWheelNotches(accumulator, { deltaX: 0, deltaY: 0, deltaMode: 0 }).vertical,
    ).toBe(6);
  });

  it("가로와 세로를 따로 센다", () => {
    const accumulator = createWheelAccumulator();

    expect(
      takeWheelNotches(accumulator, { deltaX: 200, deltaY: -300, deltaMode: 0 }),
    ).toEqual({ vertical: -3, horizontal: 2 });
  });
});
