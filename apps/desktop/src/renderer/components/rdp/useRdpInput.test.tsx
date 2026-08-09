import { render } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpInputEvent } from "@shared";

const sent: Array<{ sessionId: string; events: RdpInputEvent[] }> = [];

vi.mock("../../services/desktop/rdp", () => ({
  sendRdpInput: (sessionId: string, events: RdpInputEvent[]) => {
    sent.push({ sessionId, events });
  },
  subscribeRdpFrames: () => () => {},
  subscribeRdpEvents: () => () => {},
  connectRdp: vi.fn(),
  disconnectRdp: vi.fn(),
}));

const { useRdpInput, resolveRemoteKeyCode, wheelDeltaToNotches } = await import(
  "./useRdpInput"
);

const DESKTOP = { width: 1920, height: 1080 };

// 캔버스가 실제로 그려진 영역. jsdom 은 레이아웃을 하지 않으므로 직접 심는다.
function stubCanvasRect(canvas: HTMLCanvasElement, rect: Partial<DOMRect>) {
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 0, height: 0, ...rect }) as DOMRect;
}

let handlers: ReturnType<typeof useRdpInput>["handlers"];
let canvasEl: HTMLCanvasElement | null = null;

function Harness({
  enabled = true,
  width = DESKTOP.width,
  height = DESKTOP.height,
  originX = 0,
  originY = 0,
  useScreenCoordinates = false,
}: {
  enabled?: boolean;
  width?: number | null;
  height?: number | null;
  originX?: number;
  originY?: number;
  useScreenCoordinates?: boolean;
}) {
  const surfaceRef = useRef<HTMLCanvasElement | null>(null);
  const result = useRdpInput({
    sessionId: "s1",
    width,
    height,
    enabled,
    surfaceRef,
    originX,
    originY,
    useScreenCoordinates,
  });
  handlers = result.handlers;
  return (
    <canvas
      ref={(node) => {
        surfaceRef.current = node;
        canvasEl = node;
      }}
    />
  );
}

function lastEvents(): RdpInputEvent[] {
  return sent.at(-1)?.events ?? [];
}

describe("resolveRemoteKeyCode", () => {
  it("sends Command as Control on macOS so paste reaches the remote", () => {
    // 그대로 두면 Cmd 가 Windows 키로 가서 Cmd+V 가 붙여넣기 대신 클립보드 기록 창을 연다.
    expect(resolveRemoteKeyCode("MetaLeft", true)).toBe("ControlLeft");
    expect(resolveRemoteKeyCode("MetaRight", true)).toBe("ControlRight");
  });

  it("leaves Command alone off macOS where it is already the Windows key", () => {
    expect(resolveRemoteKeyCode("MetaLeft", false)).toBe("MetaLeft");
  });

  it("passes every other key through untouched", () => {
    expect(resolveRemoteKeyCode("KeyV", true)).toBe("KeyV");
    expect(resolveRemoteKeyCode("ControlLeft", true)).toBe("ControlLeft");
  });
});

describe("wheelDeltaToNotches", () => {
  it("treats a wheel click as one notch", () => {
    expect(wheelDeltaToNotches(100, 0)).toBe(1);
  });

  it("keeps a trackpad nudge far below a notch", () => {
    // 이벤트마다 한 노치를 보내던 시절엔 짧은 스와이프가 수백 줄을 넘겼다.
    expect(wheelDeltaToNotches(4, 0)).toBeCloseTo(0.04);
  });

  it("converts line and page modes", () => {
    expect(wheelDeltaToNotches(3, 1)).toBe(1);
    expect(wheelDeltaToNotches(1, 2)).toBe(3);
  });
});

describe("useRdpInput", () => {
  beforeEach(() => {
    sent.length = 0;
    canvasEl = null;
    vi.useRealTimers();
  });

  it("maps a click through the letterboxed scale to remote pixels", () => {
    render(<Harness />);
    // 1920x1080 을 960 폭 안에 넣으면 배율 0.5, 세로는 정확히 맞아 여백이 없다.
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onPointerDown({
      clientX: 480,
      clientY: 270,
      button: 0,
    } as never);

    expect(lastEvents()).toEqual([
      { kind: "mouseMove", x: 960, y: 540 },
      { kind: "mouseButton", button: 0, pressed: true },
    ]);
  });

  it("drops movement that falls outside this canvas", () => {
    // 모니터별로 창을 펼치면 이 캔버스는 자기 모니터만 담당한다. 밖으로 나간 포인터를 가장자리로
    // 붙이면 커서가 그 화면을 못 벗어나고, 창을 끌어 옆 모니터로 넘길 수 없게 된다.
    vi.useFakeTimers();
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onPointerMove({ clientX: 5000, clientY: 270 } as never);
    vi.advanceTimersByTime(20);

    expect(sent).toHaveLength(0);
  });

  it("reports screen coordinates while monitors are spread", () => {
    // 캔버스 밖이어도 보내야 한다. 버튼을 누른 채 드래그하면 OS 가 이후 이벤트를 처음 누른
    // 창에만 보내므로, 여기서 버리면 창을 옆 모니터로 끌 수 없다.
    vi.useFakeTimers();
    render(<Harness useScreenCoordinates />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onPointerMove({
      clientX: 5000,
      clientY: 270,
      screenX: 2400,
      screenY: 800,
    } as never);
    vi.advanceTimersByTime(20);

    expect(lastEvents()).toEqual([
      { kind: "mouseMoveScreen", screenX: 2400, screenY: 800 },
    ]);
  });

  it("presses at a screen coordinate while spread", () => {
    render(<Harness useScreenCoordinates />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onPointerDown({
      clientX: 480,
      clientY: 270,
      screenX: 1200,
      screenY: 400,
      button: 0,
    } as never);

    expect(lastEvents()).toEqual([
      { kind: "mouseMoveScreen", screenX: 1200, screenY: 400 },
      { kind: "mouseButton", button: 0, pressed: true },
    ]);
  });

  it("holds the pointer and reports where the button was released", () => {
    // 잡아두지 않으면 포인터가 캔버스를 벗어나는 순간 버튼 뗌이 우리에게 오지 않는다. 원격은
    // 버튼이 눌린 채로 남고, 창이 목적지 모니터에서 스냅에 붙잡힌다.
    const captured: number[] = [];
    const released: number[] = [];
    render(<Harness useScreenCoordinates />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onPointerDown({
      clientX: 480,
      clientY: 270,
      screenX: 100,
      screenY: 100,
      button: 0,
      pointerId: 7,
      currentTarget: { setPointerCapture: (id: number) => captured.push(id) },
    } as never);

    handlers.onPointerUp({
      screenX: 2400,
      screenY: 800,
      button: 0,
      pointerId: 7,
      currentTarget: { releasePointerCapture: (id: number) => released.push(id) },
    } as never);

    expect(captured).toEqual([7]);
    expect(released).toEqual([7]);
    expect(lastEvents()).toEqual([
      { kind: "mouseMoveScreen", screenX: 2400, screenY: 800 },
      { kind: "mouseButton", button: 0, pressed: false },
    ]);
  });

  it("does not hold the pointer in the ordinary single-window mode", () => {
    // 캔버스 밖 좌표를 표현할 방법이 없어 어차피 버려진다. 잡아 두면 그 창에 갇히기만 한다.
    const captured: number[] = [];
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onPointerDown({
      clientX: 480,
      clientY: 270,
      button: 0,
      pointerId: 7,
      currentTarget: { setPointerCapture: (id: number) => captured.push(id) },
    } as never);

    expect(captured).toEqual([]);
  });

  it("scrolls by less than a notch when the trackpad sends less than a notch", () => {
    // 트랙패드 한 틱은 노치의 4% 수준이다. 노치 단위로만 보내면 쌓이는 동안 아무것도 안 나가다가
    // 한 번에 120 이 나가서, 부드럽게 밀어도 화면이 계단처럼 뛴다. RDP 회전량은 노치보다 작은
    // 값도 실을 수 있다.
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onWheel({ deltaY: 4, deltaX: 0, deltaMode: 0 } as never);

    // 4px = 노치의 4% = 4.8 단위.
    expect(lastEvents()).toEqual([{ kind: "wheel", vertical: true, delta: -4 }]);
  });

  it("never sends a rotation the wire cannot carry", () => {
    // 회전량은 부호 있는 9비트다. 그보다 큰 값을 실으면 잘려서 방향이 뒤집힌다.
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onWheel({ deltaY: 10000, deltaX: 0, deltaMode: 0 } as never);

    expect(lastEvents()).toEqual([{ kind: "wheel", vertical: true, delta: -255 }]);
  });

  it("sends one notch for one wheel click", () => {
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onWheel({ deltaY: 100, deltaX: 0, deltaMode: 0 } as never);

    expect(lastEvents()).toEqual([
      { kind: "wheel", vertical: true, delta: -120 },
    ]);
  });

  it("does not lose the remainder between events", () => {
    // 잔량을 버리면 아주 천천히 굴릴 때 화면이 영영 안 움직인다.
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    // 0.6px 은 0.72 단위라 실어 보낼 정수가 없다. 버리지 않고 쌓아 둔다.
    handlers.onWheel({ deltaY: 0.6, deltaX: 0, deltaMode: 0 } as never);
    expect(sent).toHaveLength(0);

    handlers.onWheel({ deltaY: 0.6, deltaX: 0, deltaMode: 0 } as never);
    expect(lastEvents()).toEqual([{ kind: "wheel", vertical: true, delta: -1 }]);
  });

  it("shifts coordinates by the monitor origin", () => {
    // 두 번째 모니터를 맡은 창. 원점을 안 더하면 이 창의 클릭이 전부 첫 화면으로 간다.
    render(<Harness originX={1920} originY={0} />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 960, height: 540 });

    handlers.onPointerDown({
      clientX: 480,
      clientY: 270,
      button: 0,
    } as never);

    expect(lastEvents()).toEqual([
      { kind: "mouseMove", x: 1920 + 960, y: 540 },
      { kind: "mouseButton", button: 0, pressed: true },
    ]);
  });

  it("accounts for the centered offset when the pane is wider than the aspect ratio", () => {
    render(<Harness />);
    // 1200x540 안에서 배율은 세로가 결정한다(0.5). 가로로 (1200-960)/2 = 120 여백이 생긴다.
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 1200, height: 540 });

    handlers.onPointerDown({
      clientX: 120,
      clientY: 0,
      button: 0,
    } as never);

    // 여백 바로 오른쪽이 원격의 원점이어야 한다. 여백을 무시하면 240px 어긋난다.
    expect(lastEvents()[0]).toEqual({ kind: "mouseMove", x: 0, y: 0 });
  });

  it("ignores clicks that land on the letterbox instead of clamping them to the edge", () => {
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 1200, height: 540 });

    // 왼쪽 여백 한가운데 — 원격 화면 밖이다.
    handlers.onPointerDown({ clientX: 40, clientY: 200, button: 0 } as never);

    expect(sent).toHaveLength(0);
  });

  it("coalesces pointer moves and sends only the last position", () => {
    vi.useFakeTimers();
    render(<Harness />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 1920, height: 1080 });

    handlers.onPointerMove({ clientX: 10, clientY: 10 } as never);
    handlers.onPointerMove({ clientX: 20, clientY: 20 } as never);
    handlers.onPointerMove({ clientX: 30, clientY: 30 } as never);

    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(20);

    expect(sent).toHaveLength(1);
    expect(lastEvents()).toEqual([{ kind: "mouseMove", x: 30, y: 30 }]);
  });

  it("inverts the wheel direction the browser reports", () => {
    render(<Harness />);

    // 브라우저는 아래로 굴릴 때 양수, RDP 는 음수를 쓴다.
    handlers.onWheel({ deltaY: 100, deltaX: 0, deltaMode: 0 } as never);

    expect(lastEvents()).toEqual([{ kind: "wheel", vertical: true, delta: -120 }]);
  });

  it("translates a key to its Windows scancode and stops the local default", () => {
    render(<Harness />);
    const preventDefault = vi.fn();

    handlers.onKeyDown({ code: "KeyA", preventDefault } as never);

    expect(lastEvents()).toEqual([{ kind: "key", scancode: 0x001e, pressed: true }]);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("marks an extended key with the 0xE000 bit", () => {
    render(<Harness />);

    handlers.onKeyDown({ code: "ControlRight", preventDefault: vi.fn() } as never);

    expect(lastEvents()).toEqual([{ kind: "key", scancode: 0xe01d, pressed: true }]);
  });

  it("leaves an unmapped key alone so the app keeps its own shortcut", () => {
    render(<Harness />);
    const preventDefault = vi.fn();

    handlers.onKeyDown({ code: "SomethingUnknown", preventDefault } as never);

    expect(sent).toHaveLength(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("releases held modifiers on blur so none stay stuck on the remote", () => {
    render(<Harness />);

    handlers.onBlur();

    const events = lastEvents();
    expect(events.every((event) => event.kind === "key" && !event.pressed)).toBe(true);
    // 좌우 Ctrl/Alt/Shift 와 Meta 를 모두 떼어야 한다.
    expect(events).toHaveLength(7);
  });

  it("sends nothing while the pane is disabled", () => {
    render(<Harness enabled={false} />);
    stubCanvasRect(canvasEl!, { left: 0, top: 0, width: 1920, height: 1080 });

    handlers.onPointerDown({ clientX: 10, clientY: 10, button: 0 } as never);
    handlers.onKeyDown({ code: "KeyA", preventDefault: vi.fn() } as never);

    expect(sent).toHaveLength(0);
  });
});
