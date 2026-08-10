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

  it("maps against what the window actually draws, not the whole display", () => {
    // 노치 있는 맥북: 화면은 1512x982 인데 전체화면 창은 위 33px 을 못 받아 1512x949 만 그린다.
    // 그 크기로 선언했으니 환산도 그 사각형 기준이어야 한다 — display.bounds 로 나누면 커서가
    // 0.966 배로 밀린다.
    const display: PointerDisplay = {
      id: 1,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
    };
    const mapping: ScreenPointerMapping = {
      displayIds: [1],
      placements: [{ index: 0, left: 0, top: 0, width: 1512, height: 949 }],
      drawnRects: new Map([[0, { x: 0, y: 33, width: 1512, height: 949 }]]),
    };

    // 그리는 영역의 왼쪽 위 = 원격의 (0,0).
    expect(
      mapScreenPointToDesktop({ screenX: 0, screenY: 33 }, [display], mapping),
    ).toEqual({ x: 0, y: 0 });
    // 그리는 영역의 한가운데는 원격의 한가운데다.
    expect(
      mapScreenPointToDesktop(
        { screenX: 756, screenY: 33 + 474 },
        [display],
        mapping,
      ),
    ).toEqual({ x: 756, y: 474 });
  });

  it("falls back to the display bounds when nothing was measured", () => {
    // 창모드에서는 잰 값이 없다. 예전 동작이 그대로 남아야 한다.
    expect(
      mapScreenPointToDesktop({ screenX: 100, screenY: 50 }, DISPLAYS, MAPPING),
    ).toEqual({ x: 200, y: 100 });
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
