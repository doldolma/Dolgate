import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requests: Array<{ sessionId: string; width: number; height: number }> = [];

vi.mock("../../services/desktop/vnc", () => ({
  requestVncDesktopSize: (sessionId: string, width: number, height: number) => {
    requests.push({ sessionId, width, height });
  },
}));

const { useVncAutoResize } = await import("./useVncAutoResize");

// jsdom 에는 ResizeObserver 가 없다. 관찰 대상에 크기를 흘려 넣을 수 있는 대역을 심는다.
let emitResize: ((width: number, height: number) => void) | null = null;
let disconnected = false;

function installResizeObserver() {
  emitResize = null;
  disconnected = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        emitResize = (width: number, height: number) => {
          this.callback(
            [{ contentRect: { width, height } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        };
      }
      disconnect() {
        disconnected = true;
      }
      unobserve() {}
    },
  );
}

function Harness({ enabled = true }: { enabled?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useVncAutoResize("vnc-1", containerRef, enabled);
  return <div ref={containerRef} />;
}

describe("useVncAutoResize", () => {
  beforeEach(() => {
    requests.length = 0;
    installResizeObserver();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("드래그가 멈춘 뒤 마지막 크기만 보낸다", () => {
    // 중간값마다 보내면 서버가 그때마다 화면 전체를 다시 보낸다(크기가 바뀌면 증분이 무효다).
    render(<Harness />);

    emitResize!(1000, 700);
    emitResize!(1200, 800);
    emitResize!(1280, 820);
    vi.advanceTimersByTime(400);

    expect(requests).toEqual([{ sessionId: "vnc-1", width: 1280, height: 820 }]);
  });

  it("같은 크기를 다시 보내지 않는다", () => {
    render(<Harness />);

    emitResize!(1280, 800);
    vi.advanceTimersByTime(400);
    emitResize!(1280, 800);
    vi.advanceTimersByTime(400);

    expect(requests).toHaveLength(1);
  });

  it("화면 크기를 RFB 범위 안으로 맞춘다", () => {
    // RFB 의 크기는 16비트다. 넘겨 보내면 잘려서 엉뚱한 크기가 요청된다.
    render(<Harness />);

    emitResize!(70000, 4);
    vi.advanceTimersByTime(400);

    expect(requests).toEqual([{ sessionId: "vnc-1", width: 65535, height: 64 }]);
  });

  it("소수점 크기를 정수로 만든다", () => {
    // contentRect 는 소수를 준다. 그대로 보내면 코어에서 u16 변환이 실패한다.
    render(<Harness />);

    emitResize!(1280.6, 800.4);
    vi.advanceTimersByTime(400);

    expect(requests).toEqual([{ sessionId: "vnc-1", width: 1281, height: 800 }]);
  });

  it("꺼져 있으면 관찰하지 않는다", () => {
    render(<Harness enabled={false} />);

    expect(emitResize).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("사라지면 관찰을 멈추고 예약된 요청을 버린다", () => {
    // 안 버리면 탭을 닫은 뒤에 죽은 세션으로 크기 요청이 간다.
    const { unmount } = render(<Harness />);
    emitResize!(1280, 800);
    unmount();
    vi.advanceTimersByTime(400);

    expect(disconnected).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
