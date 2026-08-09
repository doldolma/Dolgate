import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  titleBarMode,
  useTitleBarAutoHide,
  type TitleBarMode,
} from "./useTitleBarAutoHide";

describe("titleBarMode", () => {
  it("hides outright on macOS in fullscreen", () => {
    // 부를 수 있게 두면 OS 오버레이와 타이밍이 어긋나 우리 바만 공중에 뜬다. 부르지 않으면
    // 경쟁도 없다 — 탭 전환은 단축키, 전체화면 종료는 macOS 신호등.
    expect(titleBarMode(true, "darwin")).toBe("hidden");
  });

  it("can be summoned on frameless platforms", () => {
    // frame:false 라 상단에 경쟁자가 없다.
    expect(titleBarMode(true, "win32")).toBe("reveal-on-hover");
    expect(titleBarMode(true, "linux")).toBe("reveal-on-hover");
  });

  it("always shows outside fullscreen", () => {
    // 창 모드에서 감추면 창을 옮길 방법이 사라진다 — 드래그 영역이 타이틀바에 있다.
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(titleBarMode(false, platform)).toBe("visible");
    }
  });
});

let latest: ReturnType<typeof useTitleBarAutoHide>;

function Harness({ mode }: { mode: TitleBarMode }) {
  latest = useTitleBarAutoHide(mode);
  return null;
}

function movePointerTo(clientY: number) {
  act(() => {
    // jsdom 에는 PointerEvent 가 없다. 훅이 읽는 건 type 과 clientY 뿐이라 MouseEvent 로 충분하다.
    window.dispatchEvent(new MouseEvent("pointermove", { clientY }));
  });
}

describe("useTitleBarAutoHide", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the title bar visible in the visible mode", () => {
    render(<Harness mode="visible" />);

    expect(latest.visible).toBe(true);

    // 창 모드에서 감추면 창을 옮길 방법이 사라진다 — 드래그 영역이 타이틀바에 있다.
    movePointerTo(400);
    expect(latest.visible).toBe(true);
  });

  it("hides until the pointer reaches the top edge", () => {
    render(<Harness mode="reveal-on-hover" />);

    expect(latest.visible).toBe(false);

    movePointerTo(2);
    expect(latest.visible).toBe(true);
  });

  it("ignores pointer movement below the edge band", () => {
    render(<Harness mode="reveal-on-hover" />);

    // 띠가 넓으면 원격 화면 상단을 조작할 때마다 튀어나온다.
    movePointerTo(40);
    expect(latest.visible).toBe(false);
  });

  it("folds away again once the pointer leaves", () => {
    render(<Harness mode="reveal-on-hover" />);

    movePointerTo(1);
    expect(latest.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(latest.visible).toBe(false);
  });

  it("stays open while the pointer rests on the title bar", () => {
    render(<Harness mode="reveal-on-hover" />);

    movePointerTo(1);
    act(() => {
      latest.onPointerEnter();
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // 탭을 누르려고 내려오는 중에 사라지면 안 된다.
    expect(latest.visible).toBe(true);

    act(() => {
      latest.onPointerLeave();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(latest.visible).toBe(false);
  });

  it("stays hidden in the hidden mode no matter where the pointer goes", () => {
    render(<Harness mode="hidden" />);

    expect(latest.visible).toBe(false);
    // 부를 방법이 없어야 macOS 오버레이와 경쟁하지 않는다.
    movePointerTo(0);
    expect(latest.visible).toBe(false);
  });

  it("resets when the mode changes", () => {
    const { rerender } = render(<Harness mode="reveal-on-hover" />);

    movePointerTo(1);
    expect(latest.visible).toBe(true);

    rerender(<Harness mode="visible" />);
    expect(latest.visible).toBe(true);

    // 다시 부를 수 있게 되면 접힌 상태에서 시작해야 한다.
    rerender(<Harness mode="reveal-on-hover" />);
    expect(latest.visible).toBe(false);
  });
});
