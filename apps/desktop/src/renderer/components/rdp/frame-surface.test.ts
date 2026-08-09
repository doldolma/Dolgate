import { describe, expect, it, vi } from "vitest";
import { createFrameSurface } from "./frame-surface";

// jsdom 에는 ImageData 가 없다. Canvas2D 경로가 무엇을 넘기는지만 보면 되므로 최소 대역이면 된다.
class StubImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
globalThis.ImageData ??= StubImageData as never;

/**
 * getContext 가 무엇을 물어도 같은 2D 대역을 돌려주는 캔버스.
 *
 * 테스트 대역이나 일부 임베디드 환경이 이렇게 동작한다. 이름만 보고 WebGL 로 단정하면 거기서
 * 터지므로, 능력을 확인해 Canvas2D 로 떨어져야 한다.
 */
function canvasReturningOnly2d() {
  const putImageData = vi.fn();
  const drawImage = vi.fn();
  const context = { putImageData, drawImage };
  // 누적본으로 쓰는 오프스크린 캔버스도 같은 대역을 받아야 한다 — 프로토타입째 심는다.
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => context,
  ) as unknown as HTMLCanvasElement["getContext"];
  const canvas = document.createElement("canvas");
  return { canvas, putImageData, drawImage };
}

describe("createFrameSurface", () => {
  it("uses the Canvas2D path", () => {
    const { canvas, putImageData } = canvasReturningOnly2d();

    const surface = createFrameSurface(canvas);
    expect(surface).not.toBeNull();

    surface!.resize(8, 4);
    surface!.store(0, 0, 1, 1, new Uint8Array([1, 2, 3, 4]));

    // Canvas2D 경로로 갔다는 증거.
    expect(putImageData).toHaveBeenCalled();
  });

  it("draws nothing before a size is known", () => {
    const { canvas, putImageData, drawImage } = canvasReturningOnly2d();

    const surface = createFrameSurface(canvas)!;
    // resize 전에 프레임이 도착할 수 있다. 누적본이 없으면 조용히 넘어가야 한다.
    surface.store(0, 0, 1, 1, new Uint8Array([1, 2, 3, 4]));
    surface.present({
      sourceX: 0,
      sourceY: 0,
      width: 1,
      height: 1,
      destX: 0,
      destY: 0,
    });

    expect(putImageData).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("returns null when the canvas gives no context at all", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null,
    ) as unknown as HTMLCanvasElement["getContext"];

    expect(createFrameSurface(document.createElement("canvas"))).toBeNull();
  });
});
