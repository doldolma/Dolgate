import { describe, expect, it } from "vitest";
import type { RdpLocalMonitor } from "@shared";
import {
  describeSelectionProblem,
  diagramRects,
  hasGaps,
  selectionBounds,
} from "./monitor-diagram";

function monitor(
  id: number,
  left: number,
  top: number,
  width: number,
  height: number,
): RdpLocalMonitor {
  return { id, label: `M${id}`, left, top, width, height, primary: id === 1 };
}

describe("selectionBounds", () => {
  it("spans monitors placed to the left of the primary", () => {
    // 주 디스플레이가 원점이라 왼쪽 화면은 음수 좌표를 갖는다.
    const box = selectionBounds([
      monitor(1, 0, 0, 1000, 1000),
      monitor(2, -2000, 0, 2000, 1000),
    ]);

    expect(box).toEqual({ left: -2000, top: 0, width: 3000, height: 1000 });
  });

  it("is empty for an empty selection", () => {
    expect(selectionBounds([])).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("diagramRects", () => {
  it("fills the long side and centres the short one", () => {
    const rects = diagramRects([
      monitor(1, 0, 0, 2000, 1000),
      monitor(2, 2000, 0, 2000, 1000),
    ]);

    // 4000x1000 → 가로가 100%, 세로는 25% 를 쓰고 위아래로 37.5% 씩 남는다.
    expect(rects[0]).toEqual({
      id: 1,
      left: 0,
      top: 37.5,
      width: 50,
      height: 25,
    });
    expect(rects[1].left).toBe(50);
  });

  it("keeps a portrait monitor portrait", () => {
    // 늘려서 채우면 세로 화면이 가로로 보인다.
    const [rect] = diagramRects([monitor(1, 0, 0, 1000, 2000)]);

    expect(rect.height).toBeGreaterThan(rect.width);
  });

  it("shifts everything into positive space", () => {
    const rects = diagramRects([
      monitor(1, 0, 0, 1000, 1000),
      monitor(2, -1000, 0, 1000, 1000),
    ]);

    for (const rect of rects) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
    }
  });

  it("draws nothing for an empty list", () => {
    expect(diagramRects([])).toEqual([]);
  });
});

describe("describeSelectionProblem", () => {
  it("requires at least one monitor", () => {
    expect(describeSelectionProblem([])).not.toBeNull();
  });

  it("accepts an ordinary layout", () => {
    expect(
      describeSelectionProblem([
        monitor(1, 0, 0, 3024, 1964),
        monitor(2, 3024, 0, 3840, 2160),
      ]),
    ).toBeNull();
  });

  it("rejects a span past the protocol limit", () => {
    // 붙고 나서 검은 화면이나 주 화면 폴백으로 드러나는 것보다 여기서 막는 편이 낫다.
    const problem = describeSelectionProblem([
      monitor(1, 0, 0, 1000, 1000),
      monitor(2, 9000, 0, 1000, 1000),
    ]);

    expect(problem).toContain("8192");
  });
});

describe("hasGaps", () => {
  it("is quiet for a single monitor", () => {
    expect(hasGaps([monitor(1, 0, 0, 1000, 1000)])).toBe(false);
  });

  it("is quiet when monitors tile the bounding box", () => {
    expect(
      hasGaps([monitor(1, 0, 0, 1000, 1000), monitor(2, 1000, 0, 1000, 1000)]),
    ).toBe(false);
  });

  it("flags a gap between separated monitors", () => {
    expect(
      hasGaps([monitor(1, 0, 0, 1000, 1000), monitor(2, 2000, 0, 1000, 1000)]),
    ).toBe(true);
  });

  it("flags the gap left by monitors of different heights", () => {
    expect(
      hasGaps([monitor(1, 0, 0, 1000, 1000), monitor(2, 1000, 0, 1000, 2000)]),
    ).toBe(true);
  });
});
