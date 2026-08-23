import {
  getConnectionBodyPaddingBottom,
  getKeyboardDockInset,
} from "../src/lib/keyboard-layout";

describe("getKeyboardDockInset", () => {
  it("returns zero when the keyboard is hidden", () => {
    expect(
      getKeyboardDockInset({
        keyboardVisible: false,
        keyboardInset: 280,
        currentViewportHeight: 640,
        keyboardClosedViewportHeight: 920,
      }),
    ).toBe(0);
  });

  it("returns the full inset when the viewport has not shrunk", () => {
    expect(
      getKeyboardDockInset({
        keyboardVisible: true,
        keyboardInset: 280,
        currentViewportHeight: 920,
        keyboardClosedViewportHeight: 920,
      }),
    ).toBe(280);
  });

  it("subtracts the resized viewport shrink from the keyboard inset", () => {
    expect(
      getKeyboardDockInset({
        keyboardVisible: true,
        keyboardInset: 280,
        currentViewportHeight: 640,
        keyboardClosedViewportHeight: 920,
      }),
    ).toBe(0);
  });

  it("keeps only the unmatched remainder when shrink is smaller than the inset", () => {
    expect(
      getKeyboardDockInset({
        keyboardVisible: true,
        keyboardInset: 320,
        currentViewportHeight: 700,
        keyboardClosedViewportHeight: 920,
      }),
    ).toBe(100);
  });

  it("honors the minimum visible inset when Android keyboard chrome is taller than the raw delta", () => {
    expect(
      getKeyboardDockInset({
        keyboardVisible: true,
        keyboardInset: 304,
        currentViewportHeight: 920,
        keyboardClosedViewportHeight: 920,
        minimumVisibleInset: 36,
      }),
    ).toBe(304);

    expect(
      getKeyboardDockInset({
        keyboardVisible: true,
        keyboardInset: 304,
        currentViewportHeight: 616,
        keyboardClosedViewportHeight: 920,
        minimumVisibleInset: 36,
      }),
    ).toBe(36);
  });
});

// 바닥에 붙는 것이 키보드에 덮이지 않아야 한다. 원격 데스크톱은 이 계산이 없어서, 안드로이드가
// 창을 줄여 주는 기기에서만 우연히 멀쩡했다 — iOS 와 edge-to-edge 안드로이드에서는 컨트롤바가
// 키보드 밑에 깔렸다.
describe("getConnectionBodyPaddingBottom", () => {
  const safeAreaPaddingBottom = 24;
  const toolbarHeight = 56;

  it("터미널은 툴바와 키보드를 모두 비운다", () => {
    expect(
      getConnectionBodyPaddingBottom({
        tabKind: "terminal",
        toolbarHeight,
        keyboardDockInset: 280,
        safeAreaPaddingBottom,
      }),
    ).toBe(336);
  });

  it("원격 데스크톱도 키보드만큼 비운다", () => {
    // iOS·edge-to-edge 안드로이드처럼 OS 가 창을 안 줄이는 경우.
    expect(
      getConnectionBodyPaddingBottom({
        tabKind: "rdp",
        toolbarHeight,
        keyboardDockInset: 280,
        safeAreaPaddingBottom,
      }),
    ).toBe(280);
    expect(
      getConnectionBodyPaddingBottom({
        tabKind: "vnc",
        toolbarHeight,
        keyboardDockInset: 280,
        safeAreaPaddingBottom,
      }),
    ).toBe(280);
  });

  it("OS 가 이미 창을 줄였으면 두 번 올리지 않는다", () => {
    // adjustResize 가 도는 기기에서는 인셋이 거의 0 이라 예전과 같은 여백이 된다.
    expect(
      getConnectionBodyPaddingBottom({
        tabKind: "rdp",
        toolbarHeight,
        keyboardDockInset: 0,
        safeAreaPaddingBottom,
      }),
    ).toBe(safeAreaPaddingBottom);
  });

  it("안전영역과 키보드를 더하지 않는다", () => {
    // 더하면 키보드 위에 안전영역만큼 빈 띠가 생겨 바가 붕 뜬다.
    expect(
      getConnectionBodyPaddingBottom({
        tabKind: "rdp",
        toolbarHeight,
        keyboardDockInset: 30,
        safeAreaPaddingBottom,
      }),
    ).toBe(30);
  });

  it("SFTP 는 예전 그대로 안전영역만 쓴다", () => {
    expect(
      getConnectionBodyPaddingBottom({
        tabKind: "sftp",
        toolbarHeight,
        keyboardDockInset: 280,
        safeAreaPaddingBottom,
      }),
    ).toBe(safeAreaPaddingBottom);
  });
});
