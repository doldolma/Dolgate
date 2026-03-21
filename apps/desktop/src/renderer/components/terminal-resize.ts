export interface TerminalSize {
  cols: number;
  rows: number;
}

interface TerminalResizeSchedulerOptions {
  fit: () => void;
  readSize: () => TerminalSize;
  sendResize: (size: TerminalSize) => void | Promise<void>;
  afterResize?: (size: TerminalSize) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

function isValidTerminalSize(size: TerminalSize): boolean {
  return size.cols > 0 && size.rows > 0;
}

function isSameTerminalSize(left: TerminalSize | null, right: TerminalSize): boolean {
  return left?.cols === right.cols && left?.rows === right.rows;
}

export function createTerminalResizeScheduler(options: TerminalResizeSchedulerOptions) {
  const requestFrame = options.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = options.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  let pendingFrame: number | null = null;
  let lastSentSize: TerminalSize | null = null;

  const flush = () => {
    pendingFrame = null;

    // 실제 측정은 브라우저가 레이아웃을 한 번 정리한 뒤에 수행해야 cols/rows가 안정적이다.
    options.fit();
    const nextSize = options.readSize();

    // 숨겨진 탭이나 초기 레이아웃 단계에서 0x0이 나오면 PTY에 잘못된 크기를 보내지 않는다.
    if (!isValidTerminalSize(nextSize) || isSameTerminalSize(lastSentSize, nextSize)) {
      return;
    }

    lastSentSize = nextSize;
    options.afterResize?.(nextSize);
    void options.sendResize(nextSize);
  };

  return {
    request: () => {
      // ResizeObserver는 한 번의 레이아웃 변경에도 여러 차례 발화할 수 있어 프레임당 1회로 묶는다.
      if (pendingFrame !== null) {
        return;
      }
      pendingFrame = requestFrame(() => {
        flush();
      });
    },
    reset: () => {
      if (pendingFrame !== null) {
        cancelFrame(pendingFrame);
        pendingFrame = null;
      }
      lastSentSize = null;
    }
  };
}
