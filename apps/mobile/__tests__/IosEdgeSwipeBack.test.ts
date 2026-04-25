import { shouldHandleIosEdgeSwipeBack } from "../src/components/IosEdgeSwipeBack";

describe("shouldHandleIosEdgeSwipeBack", () => {
  it("accepts a deliberate rightward edge swipe", () => {
    expect(
      shouldHandleIosEdgeSwipeBack({
        translationX: 72,
        translationY: 8,
        velocityX: 120,
      }),
    ).toBe(true);
  });

  it("accepts a fast rightward edge swipe", () => {
    expect(
      shouldHandleIosEdgeSwipeBack({
        translationX: 32,
        translationY: 6,
        velocityX: 480,
      }),
    ).toBe(true);
  });

  it("ignores mostly vertical swipes", () => {
    expect(
      shouldHandleIosEdgeSwipeBack({
        translationX: 92,
        translationY: 52,
        velocityX: 520,
      }),
    ).toBe(false);
  });

  it("ignores short and slow swipes", () => {
    expect(
      shouldHandleIosEdgeSwipeBack({
        translationX: 42,
        translationY: 4,
        velocityX: 220,
      }),
    ).toBe(false);
  });
});
