import { describe, expect, it } from "vitest";
import { clipToRegion, visibleSize } from "./canvas-region";

// 1920x1080 두 대를 가로로 붙인 데스크톱. 오른쪽 모니터를 창 하나가 맡는다.
const RIGHT = { left: 1920, top: 0, width: 1920, height: 1080 };

describe("clipToRegion", () => {
  it("passes the frame straight through when there is no region", () => {
    const blit = clipToRegion({ x: 10, y: 20, width: 30, height: 40 }, null);

    expect(blit).toEqual({
      sourceX: 10,
      sourceY: 20,
      width: 30,
      height: 40,
      destX: 10,
      destY: 20,
    });
  });

  it("drops an update that belongs to another monitor", () => {
    // 걸러내지 않으면 왼쪽 화면 내용이 오른쪽 창에 겹쳐 나온다.
    expect(
      clipToRegion({ x: 0, y: 0, width: 100, height: 100 }, RIGHT),
    ).toBeNull();
  });

  it("rebases a fully contained update onto the monitor origin", () => {
    const blit = clipToRegion(
      { x: 2000, y: 100, width: 50, height: 60 },
      RIGHT,
    );

    expect(blit).toEqual({
      sourceX: 2000,
      sourceY: 100,
      width: 50,
      height: 60,
      destX: 80,
      destY: 100,
    });
  });

  it("keeps only the overlapping slice of a straddling update", () => {
    // 창을 걸쳐 끄는 것처럼 한 갱신이 두 모니터에 걸칠 수 있다.
    const blit = clipToRegion(
      { x: 1900, y: 0, width: 100, height: 10 },
      RIGHT,
    );

    expect(blit).toEqual({
      sourceX: 1920,
      sourceY: 0,
      width: 80,
      height: 10,
      destX: 0,
      destY: 0,
    });
  });

  it("clips an update that runs past the far edge", () => {
    const blit = clipToRegion(
      { x: 3800, y: 1000, width: 200, height: 200 },
      RIGHT,
    );

    expect(blit).toEqual({
      sourceX: 3800,
      sourceY: 1000,
      width: 40,
      height: 80,
      destX: 1880,
      destY: 1000,
    });
  });

  it("treats an edge-touching update as no overlap", () => {
    // 오른쪽 모니터는 1920 부터다. 1920 에서 끝나는 갱신은 왼쪽 것이다.
    expect(
      clipToRegion({ x: 1820, y: 0, width: 100, height: 10 }, RIGHT),
    ).toBeNull();
  });
});

describe("visibleSize", () => {
  it("uses the whole desktop without a region", () => {
    expect(visibleSize(3840, 1080, null)).toEqual({
      width: 3840,
      height: 1080,
    });
  });

  it("uses the monitor size with a region", () => {
    expect(visibleSize(3840, 1080, RIGHT)).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});
