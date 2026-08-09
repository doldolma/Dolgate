import { describe, expect, it } from "vitest";
import {
  mapScreenPointToDesktop,
  type PointerDisplay,
  type ScreenPointerMapping,
} from "./rdp-screen-pointer";

// 맥북(왼쪽)과 외장(오른쪽, 아래로 내려 붙음). 실제로 문제가 났던 배치와 같은 모양이다.
const BUILTIN: PointerDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1504, height: 846 },
};
const EXTERNAL: PointerDisplay = {
  id: 2,
  bounds: { x: 1504, y: 306, width: 1920, height: 1080 },
};
const DISPLAYS = [BUILTIN, EXTERNAL];

// 원격은 화면 하나로 본다. 맥북이 왼쪽 위, 외장이 그 오른쪽 306px 아래.
const MAPPING: ScreenPointerMapping = {
  displayIds: [1, 2],
  placements: [
    { index: 0, left: 0, top: 0, width: 3008, height: 1692 },
    { index: 1, left: 3008, top: 612, width: 1920, height: 1080 },
  ],
};

describe("mapScreenPointToDesktop", () => {
  it("maps a point on the built-in display", () => {
    // 배율 2배 화면이라 화면 좌표의 두 배가 된다.
    expect(
      mapScreenPointToDesktop({ screenX: 100, screenY: 50 }, DISPLAYS, MAPPING),
    ).toEqual({ x: 200, y: 100 });
  });

  it("maps a point on the external display into its own monitor", () => {
    // 이게 창을 끌어 옆 모니터로 옮길 때 필요한 값이다. 첫 창이 이벤트를 받더라도 같은 결과여야
    // 한다 — 화면 좌표는 어느 창이 받았든 같기 때문이다.
    expect(
      mapScreenPointToDesktop(
        { screenX: 1504 + 10, screenY: 306 + 20 },
        DISPLAYS,
        MAPPING,
      ),
    ).toEqual({ x: 3018, y: 632 });
  });

  it("keeps the point inside the monitor at its far edge", () => {
    // 반올림이 경계를 한 칸 넘기면 원격이 그 갱신을 버린다.
    const mapped = mapScreenPointToDesktop(
      { screenX: 1504 + 1919, screenY: 306 + 1079 },
      DISPLAYS,
      MAPPING,
    );

    expect(mapped).toEqual({ x: 3008 + 1919, y: 612 + 1079 });
  });

  it("gives nothing for a point on no display", () => {
    // 화면 사이 빈 공간. 보낼 위치가 없다.
    expect(
      mapScreenPointToDesktop(
        { screenX: 1504 + 10, screenY: 10 },
        DISPLAYS,
        MAPPING,
      ),
    ).toBeNull();
  });

  it("gives nothing for a display this session did not borrow", () => {
    const third: PointerDisplay = {
      id: 3,
      bounds: { x: -1000, y: 0, width: 1000, height: 800 },
    };

    expect(
      mapScreenPointToDesktop(
        { screenX: -500, screenY: 100 },
        [...DISPLAYS, third],
        MAPPING,
      ),
    ).toBeNull();
  });

  it("handles a single-monitor session", () => {
    expect(
      mapScreenPointToDesktop({ screenX: 752, screenY: 423 }, [BUILTIN], {
        displayIds: [1],
        placements: [{ index: 0, left: 0, top: 0, width: 1504, height: 846 }],
      }),
    ).toEqual({ x: 752, y: 423 });
  });
});
