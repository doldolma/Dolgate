import { describe, expect, it } from "vitest";
import { shouldRequestSingleInstanceLock } from "./app-runtime-policy";

describe("app runtime policy", () => {
  it("keeps the single-instance lock for packaged apps", () => {
    expect(
      shouldRequestSingleInstanceLock({
        isPackaged: true,
      }),
    ).toBe(true);
  });

  it("does not request the single-instance lock for dev apps", () => {
    expect(
      shouldRequestSingleInstanceLock({
        isPackaged: false,
      }),
    ).toBe(false);
  });

  it("allows explicit multi-instance runs even when packaged", () => {
    expect(
      shouldRequestSingleInstanceLock({
        isPackaged: true,
        allowMultiInstanceEnv: "1",
      }),
    ).toBe(false);
  });
});
