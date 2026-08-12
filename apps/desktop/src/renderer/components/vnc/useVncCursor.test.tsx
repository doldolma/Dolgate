import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VncCursorPayload } from "@shared";

let listener: ((cursor: VncCursorPayload) => void) | null = null;
let unsubscribed = false;

vi.mock("../../services/desktop/vnc", () => ({
  subscribeVncCursor: (
    _sessionId: string,
    next: (cursor: VncCursorPayload) => void,
  ) => {
    listener = next;
    return () => {
      unsubscribed = true;
    };
  },
}));

const { toCursorStyle, useVncCursor } = await import("./useVncCursor");

function cursor(overrides: Partial<VncCursorPayload> = {}): VncCursorPayload {
  return {
    sessionId: "vnc-1",
    hotspotX: 1,
    hotspotY: 0,
    width: 2,
    height: 1,
    pixels: new Uint8Array([9, 8, 7, 255, 6, 5, 4, 0]),
    ...overrides,
  };
}

// jsdom 에는 ImageData 도 2D 컨텍스트도 없다. 실제로 그리는 것이 아니라 "무엇을 어떻게 넘기는지"
// 만 보면 되므로 최소 대역이면 된다(rdp/frame-surface.test.ts 와 같은 방식).
class StubImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {
    // 실제 ImageData 는 길이가 안 맞으면 던진다. 그 성질까지 흉내내야 "픽셀 수 검사" 테스트가
    // 검사를 지웠을 때 실패한다.
    if (data.length !== width * height * 4) {
      throw new Error("ImageData: 길이가 크기와 맞지 않습니다");
    }
  }
}
globalThis.ImageData ??= StubImageData as never;
let drawn: ImageData | null = null;

function installCanvas2d() {
  drawn = null;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "2d"
        ? ({
            putImageData: (image: ImageData) => {
              drawn = image;
            },
          } as unknown as CanvasRenderingContext2D)
        : null) as typeof HTMLCanvasElement.prototype.getContext,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,AAA",
  );
}

function Harness({ enabled = true }: { enabled?: boolean }) {
  const surfaceRef = useRef<HTMLCanvasElement | null>(null);
  useVncCursor("vnc-1", surfaceRef, enabled);
  return <canvas ref={surfaceRef} data-testid="surface" />;
}

beforeEach(() => {
  listener = null;
  unsubscribed = false;
  installCanvas2d();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toCursorStyle", () => {
  it("모양과 핫스팟을 CSS 커서로 만든다", () => {
    expect(toCursorStyle(cursor())).toBe(
      "url(data:image/png;base64,AAA) 1 0, default",
    );
    // 투명한 픽셀의 알파가 그대로 넘어가야 한다 — 안 그러면 커서 바깥이 검게 남는다.
    expect(Array.from(drawn!.data)).toEqual([9, 8, 7, 255, 6, 5, 4, 0]);
  });

  it("크기가 0 이면 로컬 포인터까지 감춘다", () => {
    // 서버가 커서를 감췄다는 뜻이다. 여기서 기본 커서를 두면 원격에는 없는 화살표가 보인다.
    expect(toCursorStyle(cursor({ width: 0, height: 0, pixels: new Uint8Array() }))).toBe(
      "none",
    );
  });

  it("브라우저 한도를 넘으면 기본 커서로 되돌린다", () => {
    // 서버가 커서를 화면에 그려 주지 않으므로, 아무 값도 주지 않으면 포인터가 사라진다.
    const big = cursor({
      width: 256,
      height: 256,
      pixels: new Uint8Array(256 * 256 * 4),
    });
    expect(toCursorStyle(big)).toBe("default");
  });

  it("픽셀 수가 크기와 맞지 않으면 기본 커서로 되돌린다", () => {
    // 잘린 페이로드로 ImageData 를 만들면 예외가 나고, 그 예외는 프레임 루프를 타고 올라간다.
    expect(toCursorStyle(cursor({ pixels: new Uint8Array([1, 2, 3]) }))).toBe('default');
  });

  it("핫스팟이 이미지 밖이면 안쪽으로 물린다", () => {
    // 밖을 가리키면 브라우저가 url(...) 전체를 버려서 커서가 사라진다.
    expect(toCursorStyle(cursor({ hotspotX: 99, hotspotY: 99 }))).toBe(
      "url(data:image/png;base64,AAA) 1 0, default",
    );
  });

  it("2D 컨텍스트가 없으면 기본 커서로 되돌린다", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(toCursorStyle(cursor())).toBe("default");
  });
});

describe("useVncCursor", () => {
  it("들어온 모양을 요소에 붙인다", () => {
    const { getByTestId } = render(<Harness />);

    listener!(cursor());

    expect(getByTestId("surface").style.cursor).toBe(
      "url(data:image/png;base64,AAA) 1 0, default",
    );
  });

  it("사라지면 구독을 끊고 커서를 되돌린다", () => {
    // 안 되돌리면 세션이 끝난 자리에서도 원격 커서 모양이 남는다.
    const { getByTestId, unmount } = render(<Harness />);
    const surface = getByTestId("surface");
    listener!(cursor());
    unmount();

    expect(unsubscribed).toBe(true);
    expect(surface.style.cursor).toBe("");
  });

  it("꺼져 있으면 구독하지 않는다", () => {
    render(<Harness enabled={false} />);

    expect(listener).toBeNull();
  });
});
