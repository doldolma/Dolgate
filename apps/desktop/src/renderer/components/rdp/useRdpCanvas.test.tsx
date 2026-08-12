import { render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpFramePayload } from "@shared";

const frameListeners = new Map<string, (frame: RdpFramePayload) => void>();
const eventListeners = new Set<(event: unknown) => void>();

function emitEvent(event: unknown) {
  for (const listener of [...eventListeners]) {
    listener(event);
  }
}

const requestRdpRefresh = vi.fn();

vi.mock("../../services/desktop/rdp", () => ({
  requestRdpRefresh: (sessionId: string) => requestRdpRefresh(sessionId),
  subscribeRdpFrames: (
    sessionId: string,
    listener: (frame: RdpFramePayload) => void,
  ) => {
    frameListeners.set(sessionId, listener);
    return () => frameListeners.delete(sessionId);
  },
  subscribeRdpEvents: (listener: (event: unknown) => void) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
  connectRdp: vi.fn(),
  disconnectRdp: vi.fn(),
}));

const { useRdpCanvas } = await import("./useRdpCanvas");
type RdpCanvasRegion = import("./canvas-region").RdpCanvasRegion;

// 실제 Canvas2D 는 jsdom 에 없으므로, 관심 있는 호출만 기록하는 대역을 심는다.
interface DrawCall {
  kind: "putImageData" | "drawImage";
  x: number;
  y: number;
}

let drawCalls: DrawCall[] = [];
let clearCount = 0;

function installCanvasStub() {
  drawCalls = [];
  clearCount = 0;

  const makeContext = () => ({
    putImageData: (_image: unknown, x: number, y: number) => {
      drawCalls.push({ kind: "putImageData", x, y });
    },
    // 첫 인자는 항상 원본 캔버스다. drawImage(buffer, 0, 0) 은 전체 되칠이고,
    // drawImage(buffer, sx, sy, sw, sh, dx, dy, dw, dh) 는 사각형 부분 전송이다.
    drawImage: (_source: unknown, ...args: number[]) => {
      const [x, y] = args.length >= 8 ? [args[4], args[5]] : [args[0] ?? 0, args[1] ?? 0];
      drawCalls.push({ kind: "drawImage", x, y });
    },
  });

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => makeContext(),
  });

  // width/height 대입은 실제 캔버스에서 내용을 지운다. 그 횟수를 세어야 회귀를 잡을 수 있다.
  for (const dimension of ["width", "height"] as const) {
    let stored = 0;
    Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
      configurable: true,
      get() {
        return stored;
      },
      set(value: number) {
        if (stored !== value) {
          clearCount += 1;
        }
        stored = value;
      },
    });
  }

  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: unknown,
        public width: number,
        public height: number,
      ) {}
    },
  );
}

function Harness({
  sessionId,
  width,
  height,
  visible,
  region,
  onRender,
}: {
  sessionId: string;
  width: number | null;
  height: number | null;
  visible: boolean;
  region?: RdpCanvasRegion | null;
  onRender?: () => void;
}) {
  const { canvasRef } = useRdpCanvas(sessionId, width, height, visible, region);
  useEffect(() => {
    onRender?.();
  });
  return <canvas ref={canvasRef} />;
}

function emitFrame(sessionId: string, x: number, y: number, width: number, height: number) {
  frameListeners.get(sessionId)?.({
    sessionId,
    x,
    y,
    width,
    height,
    pixels: new Uint8Array(width * height * 4),
  });
}

describe("useRdpCanvas", () => {
  beforeEach(() => {
    installCanvasStub();
    frameListeners.clear();
    eventListeners.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not clear the canvas when re-rendering with an unchanged size", () => {
    const { rerender } = render(
      <Harness sessionId="s1" width={1920} height={1080} visible />,
    );

    const clearsAfterMount = clearCount;

    // 같은 크기로 다시 렌더한다. 크기를 재대입하면 화면이 날아가므로 늘어나면 안 된다.
    rerender(<Harness sessionId="s1" width={1920} height={1080} visible />);
    rerender(<Harness sessionId="s1" width={1920} height={1080} visible />);

    expect(clearCount).toBe(clearsAfterMount);
  });

  it("keeps painting the backing buffer while the pane is hidden", () => {
    const { rerender } = render(
      <Harness sessionId="s1" width={1920} height={1080} visible />,
    );

    rerender(<Harness sessionId="s1" width={1920} height={1080} visible={false} />);
    drawCalls = [];

    emitFrame("s1", 10, 20, 4, 4);

    // 숨은 동안에도 누적본은 갱신해야 한다 — 아니면 돌아왔을 때 그 사이 변경분이 빈다.
    expect(drawCalls.filter((call) => call.kind === "putImageData")).toHaveLength(1);
    // 보이지 않는 캔버스에는 칠하지 않는다.
    expect(drawCalls.filter((call) => call.kind === "drawImage")).toHaveLength(0);
  });

  it("repaints the whole buffer when the pane becomes visible again", () => {
    const { rerender } = render(
      <Harness sessionId="s1" width={1920} height={1080} visible />,
    );

    rerender(<Harness sessionId="s1" width={1920} height={1080} visible={false} />);
    emitFrame("s1", 0, 0, 8, 8);
    drawCalls = [];

    rerender(<Harness sessionId="s1" width={1920} height={1080} visible />);

    // 원점부터의 전체 되칠 — dirty rect 만 오는 프로토콜에서 검은 화면을 막는 유일한 방법.
    expect(drawCalls).toEqual(
      expect.arrayContaining([{ kind: "drawImage", x: 0, y: 0 }]),
    );
  });

  it("moves only the changed rectangle to the visible canvas", () => {
    // 프레임 경계까지 모았다가 한 번에 올리는 쪽이 이론적으로는 맞지만, 이 서버는 경계를 아예
    // 보내지 않는다(실측 frames/s = 0). 기다리면 표시만 늦어진다.
    render(<Harness sessionId="s1" width={1920} height={1080} visible />);
    drawCalls = [];

    emitFrame("s1", 64, 128, 16, 16);

    expect(drawCalls).toEqual([
      { kind: "putImageData", x: 64, y: 128 },
      { kind: "drawImage", x: 64, y: 128 },
    ]);
  });

  it("drops a truncated frame instead of painting a corrupt rectangle", () => {
    render(<Harness sessionId="s1" width={1920} height={1080} visible />);
    drawCalls = [];

    frameListeners.get("s1")?.({
      sessionId: "s1",
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      // 16*16*4 = 1024 바이트가 필요한데 절반만 왔다.
      pixels: new Uint8Array(512),
    });

    expect(drawCalls).toHaveLength(0);
  });

  // 누적본을 버리는 순간 그 전에 도착한 프레임이 사라진다. 서버는 바뀌지 않은 영역을 다시 보내지
  // 않으므로 그 자리가 검게 남는다 — VNC 에서 화면 위쪽 띠로 실제로 나타난 증상이고, RDP 도 같은
  // 표면·같은 순서를 쓴다(보조 모니터 창이 열릴 때 쓰는 것과 같은 요청이다).
  it("크기가 바뀌면 화면 전체를 다시 요청한다", () => {
    requestRdpRefresh.mockClear();
    const { rerender } = render(
      <Harness sessionId="s1" width={1920} height={1080} visible />,
    );
    expect(requestRdpRefresh.mock.calls).toEqual([["s1"]]);

    requestRdpRefresh.mockClear();
    rerender(<Harness sessionId="s1" width={1440} height={900} visible />);

    expect(requestRdpRefresh.mock.calls).toEqual([["s1"]]);
  });

  it("크기를 아직 모르면 요청하지 않는다", () => {
    requestRdpRefresh.mockClear();
    render(<Harness sessionId="s1" width={null} height={null} visible />);

    expect(requestRdpRefresh).not.toHaveBeenCalled();
  });
});
