import {
  estimateTerminalGridSize,
  estimateTerminalGridSizeFromWindow,
  getPtyTerminalGridSize,
  parseReportedTerminalGrid,
  resolvePtyTerminalGridSize,
  resetReportedTerminalGridForTests,
  setReportedTerminalGrid,
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

describe("reported terminal grid", () => {
  beforeEach(() => {
    resetReportedTerminalGridForTests();
  });

  it("parses the grid report that the webview sends over the debug channel", () => {
    expect(
      parseReportedTerminalGrid([
        "received debug msg from webview: ",
        "__dolgate_grid__ 53x24",
      ]),
    ).toEqual({ cols: 53, rows: 24 });
  });

  it("ignores unrelated debug logs", () => {
    expect(
      parseReportedTerminalGrid(["bridge already installed"]),
    ).toBeNull();
    expect(parseReportedTerminalGrid([{ cols: 1 }, 42])).toBeNull();
  });

  // PTY 크기가 화면 그리드와 어긋나면 셸이 줄바꿈을 잘못 계산해 프롬프트 입력이
  // 같은 줄에 겹쳐 그려진다 — 보고값이 있으면 반드시 그 값을 써야 한다.
  it("prefers the reported grid over the window estimate for the pty size", () => {
    const estimated = getPtyTerminalGridSize();
    setReportedTerminalGrid({ cols: 53, rows: 24 });

    expect(getPtyTerminalGridSize()).toEqual({ cols: 53, rows: 24 });
    expect(getPtyTerminalGridSize()).not.toEqual(estimated);
  });

  it("falls back to the window estimate before any report arrives", () => {
    expect(getPtyTerminalGridSize()).toEqual(
      estimateTerminalGridSizeFromWindow(750, 1334),
    );
  });
});

// 접속(startShell)이 보고보다 먼저 끝나면 그 세션만 추정값으로 붙어 프롬프트 입력이
// 겹친다 — 실측 42x55(추정) vs 46x57(실제)로 실제 재현된 버그.
describe("resolvePtyTerminalGridSize", () => {
  beforeEach(() => {
    resetReportedTerminalGridForTests();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves immediately when a grid was already reported", async () => {
    setReportedTerminalGrid({ cols: 57, rows: 46 });

    await expect(resolvePtyTerminalGridSize(1500)).resolves.toEqual({
      cols: 57,
      rows: 46,
    });
  });

  it("waits for a late report instead of using the estimate", async () => {
    const pending = resolvePtyTerminalGridSize(1500);
    setReportedTerminalGrid({ cols: 57, rows: 46 });

    await expect(pending).resolves.toEqual({ cols: 57, rows: 46 });
  });

  it("falls back to the estimate when no report arrives in time", async () => {
    jest.useFakeTimers();
    const pending = resolvePtyTerminalGridSize(1500);

    await jest.advanceTimersByTimeAsync(1500);

    await expect(pending).resolves.toEqual(
      estimateTerminalGridSizeFromWindow(750, 1334),
    );
  });

  it("does not block the connect when waiting is disabled", async () => {
    await expect(resolvePtyTerminalGridSize(0)).resolves.toEqual(
      estimateTerminalGridSizeFromWindow(750, 1334),
    );
  });
});
