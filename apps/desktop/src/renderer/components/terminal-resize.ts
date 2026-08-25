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
 * 그래서 **연속 변화 중에는 아예 맞추지 않고 멈춘 뒤 한 번**만 맞춘다.
 *
 * 처음 한 번도 맞추던 때가 있었는데 두 가지로 손해였다. 드래그의 첫 fit 은 한 프레임 뒤의 낡은
 * 크기로 캔버스만 비우고, 드래그 중 손이 멈칫할 때마다 "정착 fit + 다시 움직여 앞머리 fit" 이
 * 쌍으로 붙어 깜빡임이 반복됐다. 한 번짜리 변화(탭 전환·pane 마운트)는 다음 프레임에 요청이
 * 이어지지 않는 것으로 알아보고 그때는 바로 맞춘다(scheduleFlush 주석).
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
  // 요청 카운터. "다음 프레임에도 요청이 오는가" 로 연속 변화를 알아본다(아래 scheduleFlush).
  let requestSeq = 0;

  const flush = () => {
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
    // **한 프레임 더 보고 판단한다.** 한 번의 레이아웃 변경은 같은 프레임 안에서 여러 번
    // 발화하고 끝나지만, 드래그는 다음 프레임에도 계속 온다. 다음 프레임에도 요청이 있으면
    // 연속 변화이므로 이 맞추기는 버리고 정착 때 한 번만 맞춘다 — 드래그 중의 fit 은 어차피
    // 낡은 크기라 캔버스만 비우고(=빈 프레임 하나) 값을 내지 못한다.
    pendingFrame = requestFrame(() => {
      // 카운터는 **첫 프레임이 끝날 때** 적는다. 한 번의 레이아웃 변경이 같은 프레임 안에서
      // 여러 번 발화하는 것은 여기까지 다 포함되므로 연속 변화로 오해하지 않는다.
      const seqAfterFirstFrame = requestSeq;
      pendingFrame = requestFrame(() => {
        pendingFrame = null;
        if (requestSeq !== seqAfterFirstFrame) {
          return;
        }
        flush();
      });
    });
  };

  const armSettle = () => {
    if (settleTimer !== null) {
      clearTimer(settleTimer);
    }
    settleTimer = setTimer(() => {
      settleTimer = null;
      bursting = false;
      // **여기서도 hold 를 본다.** `request()` 에서만 보면, 끌기가 멈춘 직후에 전환이
      // 시작된 경우(분할선을 놓자마자 세션 패널을 여는 등) 이미 걸려 있던 이 타이머가
      // 전환 도중에 발화해 fit 과 리사이즈를 내보낸다 — hold 가 막으려던 바로 그것이다.
      // 전환이 끝나면 부르는 쪽이 다시 요청한다(layout-transition 구독).
      if (options.isHeld?.()) {
        return;
      }
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
      requestSeq += 1;
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
      requestSeq = 0;
      lastSentSize = null;
    }
  };
}
