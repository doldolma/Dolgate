import { render } from "@testing-library/react";
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpSessionEvent } from "@shared";

const eventListeners = new Set<(event: RdpSessionEvent) => void>();

vi.mock("../../services/desktop/rdp", () => ({
  subscribeRdpEvents: (listener: (event: RdpSessionEvent) => void) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
  subscribeRdpFrames: () => () => {},
  requestRdpRefresh: vi.fn(),
  trustRdpCertificate: vi.fn(),
  resizeRdp: vi.fn(),
  sendRdpInput: vi.fn(),
  setRdpClipboardText: vi.fn(),
  syncRdpClipboard: vi.fn(),
  setRdpKeyboardCapture: vi.fn(),
  subscribeRdpAudio: () => () => {},
}));

const { sendRdpInput, setRdpKeyboardCapture } = await import(
  "../../services/desktop/rdp"
);

// jsdom 에는 ResizeObserver 가 없다. 무엇을 관찰하기 시작했는지만 기록한다 — 크기 계산은
// useRdpAutoResize 쪽 테스트가 따로 본다.
const observedTargets: Element[] = [];

class RecordingResizeObserver {
  observe(target: Element) {
    observedTargets.push(target);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RecordingResizeObserver as never;

beforeEach(() => {
  observedTargets.length = 0;
});

const { RdpSessionCanvas } = await import("./RdpSessionCanvas");

function emit(event: RdpSessionEvent) {
  act(() => {
    for (const listener of [...eventListeners]) {
      listener(event);
    }
  });
}

const CONNECTED = {
  sessionId: "s1",
  desktopWidth: 1920,
  desktopHeight: 1080,
  monitors: [{ index: 0, left: 0, top: 0, width: 1920, height: 1080 }],
} as never;

const CONNECTED_MULTI = {
  sessionId: "s1",
  desktopWidth: 3840,
  desktopHeight: 1080,
  monitors: [
    { index: 0, left: 0, top: 0, width: 1920, height: 1080 },
    { index: 1, left: 1920, top: 0, width: 1920, height: 1080 },
  ],
} as never;

describe("RdpSessionCanvas auto-resize", () => {
  it("follows the pane on a single-monitor session", () => {
    render(<RdpSessionCanvas sessionId="s1" visible connected={CONNECTED} />);

    expect(observedTargets.length).toBe(1);
  });

  it("leaves a multi-monitor session alone", () => {
    // 크기 요청은 DISP 로 모니터 하나짜리 레이아웃을 보낸다 — 따라가게 두면 3화면으로 붙어도
    // 첫 요청 한 번에 pane 크기의 1화면으로 접힌다.
    render(
      <RdpSessionCanvas sessionId="s1" visible connected={CONNECTED_MULTI} />,
    );

    expect(observedTargets.length).toBe(0);
  });
});

// Ctrl+Tab 같은 키는 캔버스에 닿기도 전에 메인이 가져간다(Win/Linux 는 before-input-event,
// macOS 는 메뉴 accelerator). 포커스가 여기 있는 동안 그걸 비켜 달라고 알려야 원격이 받는다.
describe("RdpSessionCanvas 키보드 캡처", () => {
  beforeEach(() => {
    vi.mocked(setRdpKeyboardCapture).mockClear();
    vi.mocked(sendRdpInput).mockClear();
  });

  function renderCanvas() {
    const rendered = render(
      <RdpSessionCanvas sessionId="s1" visible connected={CONNECTED} />,
    );
    const canvas = rendered.container.querySelector(
      "[data-rdp-keyboard-capture]",
    ) as HTMLCanvasElement;
    return { ...rendered, canvas };
  }

  it("포커스가 오면 켠다", () => {
    const { canvas } = renderCanvas();

    act(() => canvas.focus());

    expect(setRdpKeyboardCapture).toHaveBeenCalledWith(true);
  });

  it("포커스를 잃으면 끈다", () => {
    const { canvas } = renderCanvas();
    act(() => canvas.focus());
    vi.mocked(setRdpKeyboardCapture).mockClear();

    act(() => canvas.blur());

    expect(setRdpKeyboardCapture).toHaveBeenCalledWith(false);
  });

  it("포커스를 잃을 때 누르고 있던 키도 여전히 떼어 준다", () => {
    // blur 처리를 두 개(원래의 키 떼기 + 캡처 끄기) 합쳐 붙였다. 하나를 덮어쓰면 원격이 Ctrl 을
    // 계속 눌린 것으로 안다.
    const { canvas } = renderCanvas();
    act(() => canvas.focus());

    act(() => canvas.blur());

    expect(sendRdpInput).toHaveBeenCalledWith(
      "s1",
      expect.arrayContaining([
        expect.objectContaining({ kind: "key", pressed: false }),
      ]),
    );
  });

  it("포커스를 쥔 채 사라져도 끈다", () => {
    // 탭 닫기·원격 로그오프·재연결 교체에서는 blur 가 오지 않는다. 여기서 안 끄면 앱 단축키가
    // 영구히 죽는다.
    const { canvas, unmount } = renderCanvas();
    act(() => canvas.focus());
    vi.mocked(setRdpKeyboardCapture).mockClear();

    unmount();

    expect(setRdpKeyboardCapture).toHaveBeenCalledWith(false);
  });
});

describe("RdpSessionCanvas visibility", () => {
  it("takes itself out of the layout while hidden", () => {
    // absolute inset-0 인 채로 display 가 살아 있으면 다른 탭 위를 덮는다 — 탭을 눌러도
    // 화면이 안 바뀐 것처럼 보이던 버그.
    const { container, rerender } = render(
      <RdpSessionCanvas sessionId="s1" visible={false} connected={CONNECTED} />,
    );

    // overflow-hidden 도 "hidden" 을 품고 있어 부분 문자열로 보면 안 된다.
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("absolute")).toBe(true);
    expect(root.classList.contains("hidden")).toBe(true);
    expect(root.classList.contains("flex")).toBe(false);

    rerender(<RdpSessionCanvas sessionId="s1" visible connected={CONNECTED} />);
    expect(root.classList.contains("flex")).toBe(true);
    expect(root.classList.contains("hidden")).toBe(false);
  });

  it("keeps the canvas mounted while hidden so the session survives a tab switch", () => {
    const { container } = render(
      <RdpSessionCanvas sessionId="s1" visible={false} connected={CONNECTED} />,
    );

    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("hides behind the certificate prompt without unmounting the canvas", () => {
    const { container } = render(<RdpSessionCanvas sessionId="s1" visible />);

    emit({
      type: "certificatePrompt",
      sessionId: "s1",
      prompt: {
        sessionId: "s1",
        hostId: "h1",
        hostLabel: "dolma-RDP",
        status: "unknown",
        certificate: {
          fingerprint: "AA:BB",
          subject: "CN=win",
          issuer: "CN=win",
          notAfter: "2027-01-01",
        },
      },
    } as never);

    const canvas = container.querySelector("canvas");
    // 언마운트하면 ref 가 끊겨 수락 직후 첫 프레임을 그릴 곳이 사라진다.
    expect(canvas).not.toBeNull();
    expect(canvas?.classList.contains("hidden")).toBe(true);
  });

  it("shows the error inside the same root instead of a second absolute layer", () => {
    // 보조 모니터 창의 배치다(showError). 레이어를 하나 더 얹으면 그 창에서 프레임 위에 겹친다.
    const { container } = render(
      <RdpSessionCanvas sessionId="s1" visible showError />,
    );

    emit({ type: "error", sessionId: "s1", message: "연결 실패" } as never);

    const root = container.firstElementChild as HTMLElement;
    expect(container.childElementCount).toBe(1);
    expect(root.textContent).toContain("연결 실패");
    expect(root.classList.contains("absolute")).toBe(true);
  });

  // 메인 창에는 RdpConnectionOverlay 가 같은 pane 을 덮으면서 같은 내용을 제목·본문·재시도
  // 버튼으로 보여준다. 캔버스가 또 그리면 그 dialog 뒤에 깔려 가려진 채 양옆으로만 삐져나온다.
  it("기본값에서는 오류 문구를 그리지 않는다", () => {
    const { container } = render(<RdpSessionCanvas sessionId="s1" visible />);

    emit({ type: "error", sessionId: "s1", message: "연결 실패" } as never);

    const root = container.firstElementChild as HTMLElement;
    expect(root.textContent).not.toContain("연결 실패");
    // 캔버스를 감추는 것은 그대로다 — 실패한 세션의 마지막 화면을 남겨 두지 않는다.
    expect(container.querySelector("canvas")?.classList.contains("hidden")).toBe(true);
  });

  it("stays hidden when an error arrives on a background tab", () => {
    const { container } = render(
      <RdpSessionCanvas sessionId="s1" visible={false} />,
    );

    emit({ type: "error", sessionId: "s1", message: "연결 실패" } as never);

    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("hidden")).toBe(true);
  });

  it("ignores events addressed to another session", () => {
    const { container } = render(<RdpSessionCanvas sessionId="s1" visible />);

    emit({ type: "error", sessionId: "other", message: "남의 오류" } as never);

    const root = container.firstElementChild as HTMLElement;
    expect(root.textContent).not.toContain("남의 오류");
  });
});
