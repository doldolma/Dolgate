export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * pane 이 아직 마운트되지 않아 실제 격자를 알 수 없는 시점에 쓰는 씨앗 크기.
 *
 * 셸은 이 값으로 시작하므로 **정정되지 않으면 그대로 믿는다**. 실제로 그렇게 깨졌다: 로컬
 * 터미널이 이 크기로 열린 뒤 아무도 정정하지 않아, PowerShell 이 120 칸 기준으로 줄바꿈과
 * 커서를 계산하는 동안 화면은 200 칸이라 새 출력이 옛 내용을 덮어썼다.
 *
 * 정정 경로는 둘이다. pane 이 마운트되며 pending 크기를 갱신하면 연결이 그 값을 쓰고,
 * 그보다 늦으면 세션이 붙은 뒤 컨트롤러가 한 번 더 보고한다.
 */
export const BOOTSTRAP_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 32 };

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
