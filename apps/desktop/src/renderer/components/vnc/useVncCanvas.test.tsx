import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshVncScreen = vi.fn();

vi.mock("../../services/desktop/vnc", () => ({
  refreshVncScreen: (sessionId: string) => refreshVncScreen(sessionId),
  subscribeVncFrames: () => () => {},
}));

// 표면은 이 테스트의 관심이 아니다(WebGL 도 2D 도 jsdom 에 없다). 크기 변경 뒤에 무엇을
// 요청하는지만 본다.
const resize = vi.fn();
vi.mock("../rdp/frame-surface", () => ({
  createFrameSurface: () => ({
    resize,
    store: vi.fn(),
    present: vi.fn(),
    repaint: vi.fn(),
    dispose: vi.fn(),
  }),
}));

const { useVncCanvas } = await import("./useVncCanvas");

function Harness({ width, height }: { width: number | null; height: number | null }) {
  const { canvasRef } = useVncCanvas("vnc-1", width, height, true);
  return <canvas ref={canvasRef} />;
}

beforeEach(() => {
  refreshVncScreen.mockClear();
  resize.mockClear();
});

describe("useVncCanvas", () => {
  it("크기가 바뀌면 화면 전체를 다시 요청한다", () => {
    // 이 요청이 없으면 리사이즈 직전에 도착한 프레임이 버려진 자리가 검게 남는다 — 서버는 정적인
    // 영역을 다시 보내지 않으므로 클릭 같은 것으로 더러워질 때까지 그대로다.
    const { rerender } = render(<Harness width={1280} height={800} />);
    expect(refreshVncScreen).toHaveBeenCalledWith("vnc-1");

    refreshVncScreen.mockClear();
    resize.mockClear();
    rerender(<Harness width={1550} height={855} />);

    expect(resize).toHaveBeenCalledWith(1550, 855);
    expect(refreshVncScreen).toHaveBeenCalledWith("vnc-1");
  });

  it("크기를 아직 모르면 요청하지 않는다", () => {
    // 붙기 전이다. 죽은 세션에 요청을 보내는 왕복을 만들지 않는다.
    render(<Harness width={null} height={null} />);
    expect(refreshVncScreen).not.toHaveBeenCalled();
  });
});
