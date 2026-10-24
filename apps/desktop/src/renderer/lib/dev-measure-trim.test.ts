import { afterEach, describe, expect, it, vi } from "vitest";
import { startDevMeasureTrim } from "./dev-measure-trim";

afterEach(() => {
  vi.useRealTimers();
  performance.clearMeasures();
});

describe("startDevMeasureTrim", () => {
  it("empties the measures React keeps leaving, until it is stopped", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stop = startDevMeasureTrim(1_000);
    performance.measure("​HostCard", { start: 0, end: 1, detail: { devtools: { properties: [["host", "…"]] } } });
    expect(performance.getEntriesByType("measure")).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(performance.getEntriesByType("measure")).toHaveLength(0);

    stop();
    performance.measure("​HostCard", { start: 0, end: 1 });
    vi.advanceTimersByTime(5_000);
    expect(performance.getEntriesByType("measure")).toHaveLength(1);
  });
});
