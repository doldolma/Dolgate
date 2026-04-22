import { getKeyboardDockInset } from "../src/lib/keyboard-layout";

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
