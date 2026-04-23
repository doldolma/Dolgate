import {
  estimateTerminalGridSize,
  estimateTerminalGridSizeFromWindow,
} from "../src/lib/terminal-size";

describe("estimateTerminalGridSize", () => {
  it("uses the tuned mobile cell metrics for a measured viewport", () => {
    expect(estimateTerminalGridSize(360, 320)).toEqual({
      cols: 50,
      rows: 19,
    });
  });

  it("keeps the minimum terminal size for smaller cards", () => {
    expect(estimateTerminalGridSize(180, 120)).toEqual({
      cols: 32,
      rows: 18,
    });
  });
});

describe("estimateTerminalGridSizeFromWindow", () => {
  it("applies the reserved mobile chrome height before estimating rows", () => {
    expect(estimateTerminalGridSizeFromWindow(393, 852)).toEqual({
      cols: 54,
      rows: 41,
    });
  });
});
