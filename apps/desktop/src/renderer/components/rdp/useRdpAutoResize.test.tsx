import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resizeRequests: Array<{ sessionId: string; width: number; height: number }> = [];

vi.mock("../../services/desktop/rdp", () => ({
  requestRdpResize: (sessionId: string, width: number, height: number) => {
    resizeRequests.push({ sessionId, width, height });
  },
  subscribeRdpFrames: () => () => {},
  subscribeRdpEvents: () => () => {},
  sendRdpInput: vi.fn(),
  connectRdp: vi.fn(),
  disconnectRdp: vi.fn(),
  trustRdpCertificate: vi.fn(),
}));

const { useRdpAutoResize } = await import("./useRdpAutoResize");

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
  useRdpAutoResize("s1", containerRef, enabled);
  return <div ref={containerRef} />;
}

describe("useRdpAutoResize", () => {
  beforeEach(() => {
    resizeRequests.length = 0;
    installResizeObserver();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for the drag to settle and sends only the final size", () => {
    render(<Harness />);

    emitResize!(1000, 700);
    emitResize!(1200, 800);
    emitResize!(1400, 900);

    // 중간값마다 보내면 드래그가 끝난 뒤로도 원격이 계속 재협상한다.
    expect(resizeRequests).toHaveLength(0);

    vi.advanceTimersByTime(500);

    expect(resizeRequests).toEqual([{ sessionId: "s1", width: 1400, height: 900 }]);
  });

  it("rounds an odd width down because RDP rejects one", () => {
    render(<Harness />);

    emitResize!(1401, 900);
    vi.advanceTimersByTime(500);

    expect(resizeRequests[0]).toMatchObject({ width: 1400 });
  });

  it("clamps sizes into the range the protocol allows", () => {
    render(<Harness />);

    emitResize!(10, 10);
    vi.advanceTimersByTime(500);
    expect(resizeRequests[0]).toMatchObject({ width: 200, height: 200 });

    emitResize!(99999, 99999);
    vi.advanceTimersByTime(500);
    expect(resizeRequests[1]).toMatchObject({ width: 8192, height: 8192 });
  });

  it("does not repeat a size the server already has", () => {
    render(<Harness />);

    emitResize!(1400, 900);
    vi.advanceTimersByTime(500);
    emitResize!(1400, 900);
    vi.advanceTimersByTime(500);

    // 같은 값을 다시 보내면 서버가 불필요한 재활성화를 한 번 더 한다.
    expect(resizeRequests).toHaveLength(1);
  });

  it("stops observing when the pane is disabled", () => {
    const { rerender } = render(<Harness enabled />);
    rerender(<Harness enabled={false} />);

    expect(disconnected).toBe(true);
  });

  it("drops a pending request when the pane unmounts mid-drag", () => {
    const { unmount } = render(<Harness />);

    emitResize!(1400, 900);
    unmount();
    vi.advanceTimersByTime(500);

    expect(resizeRequests).toHaveLength(0);
  });
});
