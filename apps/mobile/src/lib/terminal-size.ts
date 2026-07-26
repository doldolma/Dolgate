import { Dimensions } from "react-native";

export interface TerminalGridSize {
  cols: number;
  rows: number;
}

const MOBILE_TERMINAL_RESERVED_HEIGHT = 176;
// Tuned against the mobile xterm render metrics so the terminal fills the card
// more closely on real Android devices without clipping under the keyboard.
const TERMINAL_CELL_WIDTH = 7.2;
const TERMINAL_CELL_HEIGHT = 16.4;

export function estimateTerminalGridSize(
  width: number,
  height: number,
): TerminalGridSize {
  return {
    cols: Math.max(32, Math.floor(width / TERMINAL_CELL_WIDTH)),
    rows: Math.max(18, Math.floor(height / TERMINAL_CELL_HEIGHT)),
  };
}

export function estimateTerminalGridSizeFromWindow(
  windowWidth: number,
  windowHeight: number,
): TerminalGridSize {
  return estimateTerminalGridSize(
    windowWidth,
    windowHeight - MOBILE_TERMINAL_RESERVED_HEIGHT,
  );
}

export function getCurrentWindowTerminalGridSize(): TerminalGridSize {
  const { width, height } = Dimensions.get("window");
  return estimateTerminalGridSizeFromWindow(width, height);
}

export function toRusshTerminalSize(size: TerminalGridSize): {
  colWidth: number;
  rowHeight: number;
} {
  return {
    colWidth: size.cols,
    rowHeight: size.rows,
  };
}

// 위 추정값은 창 크기 ÷ 고정 셀 메트릭이라, WebView 안 xterm 이 FitAddon 으로 실제
// 잡는 그리드와 어긋난다. 원격 PTY 에 실제와 다른 cols 를 알려주면 셸(readline)이
// 줄바꿈 위치를 잘못 계산해 프롬프트 입력이 다음 줄이 아니라 같은 줄 처음에 겹쳐
// 그려진다. 그래서 xterm 이 실제로 fit 한 그리드를 보고받아 PTY 크기로 쓴다.
const REPORTED_GRID_MARKER = "__dolgate_grid__";

// 보고 채널로 debug 메시지를 쓰는 이유: webViewOptions 는 WebView 에 마지막으로
// 스프레드되므로 onMessage 를 넘기면 패키지 자체 핸들러(initialized/input)가 사라져
// 터미널 입출력이 끊긴다. 반면 debug 메시지는 패키지가 logger 로 그대로 흘려준다.
export const TERMINAL_GRID_REPORT_SCRIPT = `(function () {
  if (window.__dolgateGridReporter) { return; }
  window.__dolgateGridReporter = true;
  var post = function () {
    try {
      var term = window.terminal;
      if (!term || !window.ReactNativeWebView) { return; }
      window.ReactNativeWebView.postMessage(
        JSON.stringify({
          type: 'debug',
          message: '${REPORTED_GRID_MARKER} ' + term.cols + 'x' + term.rows
        })
      );
    } catch (error) {}
  };
  var attempts = 0;
  var timer = setInterval(function () {
    attempts += 1;
    if (window.terminal) {
      clearInterval(timer);
      try { window.terminal.onResize(post); } catch (error) {}
      post();
      return;
    }
    if (attempts > 200) { clearInterval(timer); }
  }, 50);
})();
true;`;

// 패키지 logger.log 인자에서 그리드 보고를 골라낸다(그 외 로그는 그대로 흘린다).
export function parseReportedTerminalGrid(
  args: readonly unknown[],
): TerminalGridSize | null {
  for (const arg of args) {
    if (typeof arg !== "string" || !arg.startsWith(REPORTED_GRID_MARKER)) {
      continue;
    }
    const matched = /(\d+)x(\d+)/.exec(arg);
    if (!matched) {
      return null;
    }
    const cols = Number.parseInt(matched[1], 10);
    const rows = Number.parseInt(matched[2], 10);
    if (cols <= 0 || rows <= 0) {
      return null;
    }
    return { cols, rows };
  }
  return null;
}

// 마지막으로 보고된 실제 그리드. 세션마다 카드 크기가 같으므로 다음 접속의 PTY
// 크기로 재사용한다(첫 접속 등 보고 이전에는 추정값으로 폴백).
let reportedGrid: TerminalGridSize | null = null;
const gridWaiters = new Set<(size: TerminalGridSize) => void>();

export function setReportedTerminalGrid(size: TerminalGridSize): void {
  reportedGrid = size;
  if (gridWaiters.size === 0) {
    return;
  }
  const waiters = [...gridWaiters];
  gridWaiters.clear();
  for (const waiter of waiters) {
    waiter(size);
  }
}

export function getReportedTerminalGrid(): TerminalGridSize | null {
  return reportedGrid;
}

export function resetReportedTerminalGridForTests(): void {
  reportedGrid = null;
  gridWaiters.clear();
}

// 접속 직전에 실제 그리드 보고를 짧게 기다린다. 터미널 WebView 는 SSH 핸드셰이크와
// 병행해 뜨므로, 기다리지 않으면 startShell 이 먼저 끝나 그 세션만 추정값으로 붙는다
// (셸이 아는 폭과 화면 폭이 어긋나 프롬프트 입력이 같은 줄에 겹쳐 그려진다).
export const PTY_GRID_REPORT_WAIT_MS = 1500;

export function resolvePtyTerminalGridSize(
  timeoutMs: number = PTY_GRID_REPORT_WAIT_MS,
): Promise<TerminalGridSize> {
  if (reportedGrid) {
    return Promise.resolve(reportedGrid);
  }
  if (timeoutMs <= 0) {
    return Promise.resolve(getCurrentWindowTerminalGridSize());
  }

  return new Promise<TerminalGridSize>(resolve => {
    let settled = false;
    const waiter = (size: TerminalGridSize) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(size);
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      gridWaiters.delete(waiter);
      // 보고가 늦으면 추정값으로 진행한다 — 접속을 무한히 막지는 않는다.
      resolve(getCurrentWindowTerminalGridSize());
    }, timeoutMs);
    gridWaiters.add(waiter);
  });
}

// 원격 PTY 에 알려줄 크기 — 실제 보고값이 있으면 그것을, 없으면 추정값을 쓴다.
export function getPtyTerminalGridSize(): TerminalGridSize {
  return reportedGrid ?? getCurrentWindowTerminalGridSize();
}
