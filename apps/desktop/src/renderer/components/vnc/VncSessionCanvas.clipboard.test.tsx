import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VncSessionEvent } from "@shared";

let emit: ((event: VncSessionEvent) => void) | null = null;

vi.mock("../../services/desktop/vnc", () => ({
  subscribeVncEvents: (listener: (event: VncSessionEvent) => void) => {
    emit = listener;
    return () => {};
  },
  sendVncInput: () => {},
  syncVncClipboard: () => {},
  requestVncDesktopSize: () => {},
  subscribeVncCursor: () => () => {},
  subscribeVncFrames: () => () => {},
}));

vi.mock("./useVncCanvas", () => ({
  useVncCanvas: () => ({ canvasRef: { current: null } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === "vnc.clipboardLossy"
        ? `이 서버는 ASCII 클립보드만 지원합니다 — 담을 수 없는 글자 ${options?.count}개가 ? 로 바뀌었습니다`
        : key,
  }),
}));

const { VncSessionCanvas } = await import("./VncSessionCanvas");

describe("VncSessionCanvas 클립보드 알림", () => {
  it("담을 수 없는 글자 수를 알린다", () => {
    // 이 알림이 없으면 한글 복사가 조용히 망가진다 — 원격에 `?` 가 붙는 것만 보인다.
    render(<VncSessionCanvas sessionId="vnc-1" />);

    act(() => {
      emit!({ type: "clipboardLossy", sessionId: "vnc-1", replaced: 2 });
    });

    expect(screen.getByTestId("vnc-clipboard-notice").textContent).toContain("2개");
  });

  it("다른 세션의 알림은 무시한다", () => {
    render(<VncSessionCanvas sessionId="vnc-1" />);

    act(() => {
      emit!({ type: "clipboardLossy", sessionId: "vnc-2", replaced: 5 });
    });

    expect(screen.queryByTestId("vnc-clipboard-notice")).toBeNull();
  });

  it("잠시 뒤 스스로 사라진다", () => {
    // 남겨 두면 화면 위에 계속 떠 있고, 이 알림은 사용자가 할 수 있는 일이 없다(서버 한계다).
    vi.useFakeTimers();
    try {
      render(<VncSessionCanvas sessionId="vnc-1" />);
      act(() => {
        emit!({ type: "clipboardLossy", sessionId: "vnc-1", replaced: 1 });
      });
      expect(screen.getByTestId("vnc-clipboard-notice")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(6500);
      });
      expect(screen.queryByTestId("vnc-clipboard-notice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
