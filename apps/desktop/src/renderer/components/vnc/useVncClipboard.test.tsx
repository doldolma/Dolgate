import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const syncVncClipboard = vi.fn();

vi.mock("../../services/desktop/vnc", () => ({
  syncVncClipboard: (sessionId: string) => syncVncClipboard(sessionId),
}));

const { useVncClipboard } = await import("./useVncClipboard");

/** 캔버스 자리에 포커스를 받을 수 있는 요소를 둔다. 훅은 그 요소의 focus 만 본다. */
function Harness({ enabled = true }: { enabled?: boolean }) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useVncClipboard("vnc-1", surfaceRef, enabled);
  return <div ref={surfaceRef} tabIndex={0} data-testid="surface" />;
}

beforeEach(() => {
  syncVncClipboard.mockClear();
});

describe("useVncClipboard", () => {
  it("마운트되면 한 번 올린다", () => {
    // 탭을 다시 열었을 때 이미 포커스를 쥔 채로 마운트되는 경우가 있다 — 그때 focus 이벤트는
    // 오지 않으므로 여기서 올리지 않으면 첫 붙여넣기가 옛 값이 된다.
    render(<Harness />);

    expect(syncVncClipboard).toHaveBeenCalledWith("vnc-1");
  });

  it("원격 화면에 포커스가 갈 때 올린다", () => {
    const { getByTestId } = render(<Harness />);
    syncVncClipboard.mockClear();

    fireEvent.focus(getByTestId("surface"));

    expect(syncVncClipboard).toHaveBeenCalledWith("vnc-1");
  });

  it("앱 밖에서 복사하고 돌아오는 경우도 잡는다", () => {
    // 가장 흔한 흐름이다. 캔버스는 이미 포커스를 쥐고 있어서 그 focus 는 다시 오지 않는다.
    render(<Harness />);
    syncVncClipboard.mockClear();

    fireEvent.focus(window);

    expect(syncVncClipboard).toHaveBeenCalledWith("vnc-1");
  });

  it("꺼져 있으면 아무것도 올리지 않는다", () => {
    // 숨은 pane 이나 아직 붙지 않은 세션이다. 죽은 세션에 보내면 코어가 버리지만 왕복이 남는다.
    const { getByTestId } = render(<Harness enabled={false} />);

    fireEvent.focus(getByTestId("surface"));
    fireEvent.focus(window);

    expect(syncVncClipboard).not.toHaveBeenCalled();
  });

  it("사라지면 창 리스너를 뗀다", () => {
    // 안 떼면 탭을 닫은 뒤에도 창 포커스마다 죽은 세션으로 신호가 간다.
    const { unmount } = render(<Harness />);
    unmount();
    syncVncClipboard.mockClear();

    fireEvent.focus(window);

    expect(syncVncClipboard).not.toHaveBeenCalled();
  });
});
