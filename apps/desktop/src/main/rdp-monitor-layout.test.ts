import { describe, expect, it } from "vitest";
import {
  buildLayoutRequest,
  sameLayoutRequest,
  type MeasuredMonitorWindow,
} from "./rdp-monitor-layout";

/**
 * 실제로 문제가 났던 배치. 노치 있는 맥북은 화면이 1512x982 인데 전체화면 창은 위 33px 을 못
 * 받아 1512x949 만 그린다. 외장은 화면 크기 그대로다.
 */
const EXTERNAL: MeasuredMonitorWindow = {
  index: 0,
  fullScreen: true,
  bounds: { x: -2560, y: -428, width: 2560, height: 1440 },
};
const NOTCHED: MeasuredMonitorWindow = {
  index: 1,
  fullScreen: true,
  bounds: { x: 0, y: 33, width: 1512, height: 949 },
};

describe("buildLayoutRequest", () => {
  it("declares what each window actually draws", () => {
    const request = buildLayoutRequest([EXTERNAL, NOTCHED], 2, 1);
    expect(request).toEqual([
      { width: 2560, height: 1440, left: -2560, top: -428, primary: false },
      // 982 가 아니라 949 다. 이 한 줄이 레터박스와 커서 어긋남의 원인이었다.
      { width: 1512, height: 949, left: 0, top: 33, primary: true },
    ]);
  });

  it("keeps the declaration order even when the windows come back shuffled", () => {
    // 창 이벤트 순서는 보장되지 않는다. 순서가 바뀌면 원격 모니터가 서로 뒤바뀐다.
    const request = buildLayoutRequest([NOTCHED, EXTERNAL], 2, 1);
    expect(request?.map((monitor) => monitor.width)).toEqual([2560, 1512]);
  });

  it("waits until every window finished going full screen", () => {
    // macOS 전환은 애니메이션이라 도중 값은 화면 크기와 다르다. 그걸 선언하면 지금보다 더
    // 어긋난다.
    expect(
      buildLayoutRequest([EXTERNAL, { ...NOTCHED, fullScreen: false }], 2, 1),
    ).toBeNull();
  });

  it("waits until every monitor was measured", () => {
    // 한 모니터를 선언에서 빼면 원격이 화면을 재배치해 전부 어긋난다.
    expect(buildLayoutRequest([EXTERNAL], 2, 1)).toBeNull();
  });

  it("does not touch the single screen path", () => {
    // 나누지 않는 상태다. 단일 화면은 창 크기 경로(useRdpAutoResize)가 이미 맞춘다.
    expect(buildLayoutRequest([{ ...NOTCHED, index: 0 }], 1, 0)).toBeNull();
  });

  it("always marks exactly one monitor as primary", () => {
    // 주로 표시된 것이 없으면 원격이 임의로 정하고, 시작 메뉴가 엉뚱한 화면에 붙는다.
    const request = buildLayoutRequest([EXTERNAL, NOTCHED], 2, 7);
    expect(request?.filter((monitor) => monitor.primary)).toHaveLength(1);
    expect(request?.[0].primary).toBe(true);
  });

  it("rejects an empty window", () => {
    // 최소화나 화면 분리 중에는 0 이 나온다. 200 미만은 서버가 요청 전체를 버린다.
    expect(
      buildLayoutRequest(
        [EXTERNAL, { ...NOTCHED, bounds: { x: 0, y: 0, width: 0, height: 0 } }],
        2,
        1,
      ),
    ).toBeNull();
  });
});

describe("sameLayoutRequest", () => {
  it("treats an identical measurement as unchanged", () => {
    // 창 이벤트는 여러 번 온다. 같은 값을 다시 보내면 원격이 화면을 또 멈춘다.
    const a = buildLayoutRequest([EXTERNAL, NOTCHED], 2, 1);
    const b = buildLayoutRequest([EXTERNAL, NOTCHED], 2, 1);
    expect(sameLayoutRequest(a, b)).toBe(true);
  });

  it("notices a size change", () => {
    const a = buildLayoutRequest([EXTERNAL, NOTCHED], 2, 1);
    const b = buildLayoutRequest(
      [EXTERNAL, { ...NOTCHED, bounds: { ...NOTCHED.bounds, height: 982 } }],
      2,
      1,
    );
    expect(sameLayoutRequest(a, b)).toBe(false);
  });

  it("never matches when one side is missing", () => {
    expect(sameLayoutRequest(null, null)).toBe(false);
  });
});
