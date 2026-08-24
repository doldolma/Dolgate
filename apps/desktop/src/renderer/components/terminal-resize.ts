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

/**
 * 크기가 멈춘 뒤 한 번 더 맞추기까지 기다리는 시간(ms).
 *
 * 창을 끌면 프레임마다 컨테이너가 바뀌는데, 그때마다 fit 하면 xterm 이 캔버스 백킹스토어를 다시
 * 잡는다 — 캔버스는 크기를 바꾸는 순간 지워지므로 다시 그려지기 전 한 프레임이 빈 화면이다.
 * 실측(1440→1100, 21단계): 캔버스 재지정 31회, 페인트 프레임 22개 중 11개가 거의 빈 화면.
 * 그래서 **처음 한 번 + 멈춘 뒤 한 번**만 맞추고 중간값은 버린다.
 *
 * RDP·VNC 는 같은 이유로 이미 정착 방식이다(useRdpAutoResize: 400ms). 거기는 해상도 재협상이
 * 비싸서 넉넉히 기다리지만, 터미널은 격자 계산이라 그만큼 기다리면 답답하다.
 */
export const RESIZE_SETTLE_MS = 100;

interface TerminalResizeSchedulerOptions {
  fit: () => void;
  /**
   * 지금은 재지 말아야 하는가(레이아웃이 애니메이션 중).
   *
   * 세션 패널 폭이 움직이는 동안 프레임마다 fit 하면 PTY·tmux 로 리사이즈가 쏟아진다. 전환이
   * 끝나면 부르는 쪽이 `request()` 를 한 번 더 호출한다(layout-transition 구독).
   */
  isHeld?: () => boolean;
  readSize: () => TerminalSize;
  sendResize: (size: TerminalSize) => void | Promise<void>;
  afterResize?: (size: TerminalSize) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  /** 정착 대기(ms). 기본 RESIZE_SETTLE_MS. */
  settleMs?: number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
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
  const setTimer = options.setTimer ?? window.setTimeout.bind(window);
  const clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
  const settleMs = options.settleMs ?? RESIZE_SETTLE_MS;
  let pendingFrame: number | null = null;
  let lastSentSize: TerminalSize | null = null;
  // 지금 연속 변화(창 드래그·분할 드래그) 안에 있는가. 그 안에서는 중간값을 버린다.
  let bursting = false;
  let settleTimer: number | null = null;

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

  const scheduleFlush = () => {
    // ResizeObserver는 한 번의 레이아웃 변경에도 여러 차례 발화할 수 있어 프레임당 1회로 묶는다.
    if (pendingFrame !== null) {
      return;
    }
    pendingFrame = requestFrame(() => {
      flush();
    });
  };

  const armSettle = () => {
    if (settleTimer !== null) {
      clearTimer(settleTimer);
    }
    settleTimer = setTimer(() => {
      settleTimer = null;
      bursting = false;
      // 멈춘 뒤 한 번. 크기가 그대로면 fit 이 스스로 아무 것도 하지 않는다(캔버스 유지).
      scheduleFlush();
    }, settleMs);
  };

  return {
    request: () => {
      // 우리가 돌리는 전환(세션 패널 여닫기) 중에는 아예 미룬다 — 끝나면 부르는 쪽이 다시
      // 요청한다.
      if (options.isHeld?.()) {
        return;
      }
      armSettle();
      // 연속 변화 중이면 중간값은 버린다. 처음 한 번은 바로 맞춰야 한 번짜리 변화(탭 전환·
      // pane 마운트)가 정착 시간만큼 늦어지지 않는다.
      if (bursting) {
        return;
      }
      bursting = true;
      scheduleFlush();
    },
    reset: () => {
      if (pendingFrame !== null) {
        cancelFrame(pendingFrame);
        pendingFrame = null;
      }
      if (settleTimer !== null) {
        clearTimer(settleTimer);
        settleTimer = null;
      }
      bursting = false;
      lastSentSize = null;
    }
  };
}
