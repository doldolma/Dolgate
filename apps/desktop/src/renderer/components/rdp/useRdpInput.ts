import { useCallback, useEffect, useRef } from "react";
import type { RdpInputEvent } from "@shared";
import { sendRdpInput } from "../../services/desktop/rdp";
import { scancodeFor } from "./scancodes";

/**
 * 마우스 이동을 한 프레임에 한 번으로 묶는 간격(ms).
 *
 * 포인터는 초당 수백 번 움직이는데 원격 화면은 그보다 훨씬 느리게 갱신된다. 중간 좌표를 다
 * 보내는 것은 대역폭 낭비이고, 마지막 위치만 정확하면 커서는 같은 곳에 놓인다.
 */
const MOUSE_MOVE_INTERVAL_MS = 8;


/**
 * macOS 에서 Command 를 원격의 Control 로 바꿔 보낸다.
 *
 * 그대로 두면 Cmd 가 Windows 키로 가서 Cmd+V 가 붙여넣기 대신 클립보드 기록 창을 연다.
 * 복사·붙여넣기·전체선택·실행취소가 전부 어긋나므로 macOS 에서는 옮기는 편이 맞다
 * (Microsoft Remote Desktop for Mac 도 같은 기본값이다).
 *
 * 대가로 진짜 Windows 키는 보낼 수 없다. Win+E 같은 조합보다 복사·붙여넣기가 압도적으로 잦아
 * 이쪽을 택했다.
 */
const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform || navigator.userAgent);

const META_TO_CONTROL: Readonly<Record<string, string>> = {
  MetaLeft: "ControlLeft",
  MetaRight: "ControlRight",
};

/** 브라우저 키 코드를 원격으로 보낼 코드로 옮긴다. macOS 에서만 Command 를 Control 로 바꾼다. */
export function resolveRemoteKeyCode(code: string, isMac: boolean): string {
  return isMac ? (META_TO_CONTROL[code] ?? code) : code;
}

/** 브라우저의 한 "줄" 스크롤을 RDP 휠 단위로 옮긴 값(윈도우 기본 노치 = 120). */
const WHEEL_UNITS_PER_NOTCH = 120;

/**
 * 노치 하나에 해당하는 픽셀 수(deltaMode = pixel 일 때).
 *
 * 휠 한 칸을 굴리면 브라우저가 대략 100px 를 준다. 트랙패드는 같은 단위로 훨씬 작은 값을 훨씬
 * 자주 준다 — 그래서 이벤트마다 노치 하나씩 보내면 짧게 쓸어도 수백 줄이 넘어간다.
 */
const WHEEL_PIXELS_PER_NOTCH = 100;

/**
 * 누른 뒤 이만큼(로컬 CSS 픽셀) 움직이기 전까지는 이동을 보내지 않는다 — 드래그 임계값이다.
 *
 * 캔버스는 축소되어 그려진다. 원격 1920 폭을 960 폭 창에 넣으면 로컬 1픽셀이 원격 2픽셀이라,
 * 클릭할 때 손이 흔들리는 1~2픽셀이 원격에서는 드래그로 전달된다. 크롬에서 탭을 누르면 제자리
 * 클릭 대신 탭이 끌려 나가는 게 그 결과다.
 *
 * 네이티브 툴킷들이 쓰는 것과 같은 처리다. 화면을 축소해 보여주는 이상 없앨 수 없다.
 */
const CLICK_SLOP_PX = 3;

/** deltaMode = line 일 때 노치 하나에 해당하는 줄 수. 윈도우 기본값과 같다. */
const WHEEL_LINES_PER_NOTCH = 3;

/** 브라우저가 준 스크롤량을 노치 수로 옮긴다. */
/**
 * 한 번에 실어 보낼 회전량.
 *
 * [MS-RDPBCGR] 2.2.8.1.1.3.1.1.1 의 회전량은 부호 있는 9비트다. 그보다 큰 값은 잘려서 방향이
 * 뒤집히므로, 넘치는 만큼은 남겨 두고 다음 번에 마저 보낸다.
 */
const WHEEL_UNITS_MAX = 255;

export function clampWheelUnits(units: number): number {
  const whole = Math.trunc(units);
  if (whole > WHEEL_UNITS_MAX) {
    return WHEEL_UNITS_MAX;
  }
  if (whole < -WHEEL_UNITS_MAX) {
    return -WHEEL_UNITS_MAX;
  }
  return whole;
}

export function wheelDeltaToNotches(delta: number, deltaMode: number): number {
  if (deltaMode === 1) {
    return delta / WHEEL_LINES_PER_NOTCH;
  }
  if (deltaMode === 2) {
    // 페이지 단위. 한 페이지를 한 노치로 보면 너무 굼떠서 화면 한 장을 여러 노치로 나눈다.
    return delta * WHEEL_LINES_PER_NOTCH;
  }
  return delta / WHEEL_PIXELS_PER_NOTCH;
}

interface RdpInputOptions {
  sessionId: string;
  /** 원격 데스크톱 크기. 캔버스 표시 크기와 다를 수 있어 좌표 환산에 필요하다. */
  width: number | null;
  height: number | null;
  enabled: boolean;
  /** 그리기와 입력이 같은 요소를 봐야 하므로 캔버스 ref 를 주입받는다. */
  surfaceRef: React.RefObject<HTMLCanvasElement | null>;
  /**
   * 이 캔버스가 맡은 영역의 데스크톱 좌표 원점.
   *
   * 모니터마다 창을 띄우면 캔버스는 그 모니터만 그리므로 환산 결과가 모니터 기준(0,0)이 된다.
   * 원격은 데스크톱 하나로 보고 있어서 원점을 더해 주지 않으면 두 번째 화면의 클릭이 전부
   * 첫 번째 화면으로 간다.
   */
  originX?: number;
  originY?: number;
  /**
   * 이동을 OS 화면 좌표로 보낼지.
   *
   * 모니터마다 창을 펼쳤을 때 켠다. 버튼을 누른 채 드래그하면 OS 가 이후 이벤트를 처음 누른
   * 창에만 보내서, 그 창이 자기 캔버스 기준으로 환산하면 자기 모니터 밖을 표현할 수 없다 —
   * 창을 옆 모니터로 끌 수 없게 된다. 화면 좌표는 메인 프로세스가 옮긴다.
   */
  useScreenCoordinates?: boolean;
}

export function useRdpInput({
  sessionId,
  width,
  height,
  enabled,
  surfaceRef,
  originX = 0,
  originY = 0,
  useScreenCoordinates = false,
}: RdpInputOptions) {
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const pendingScreenMoveRef = useRef<{
    screenX: number;
    screenY: number;
  } | null>(null);
  // 원격에 "눌렸다"고 알린 마우스 버튼들.
  //
  // 포인터를 잃었을 때 이걸 놓아주지 않으면 원격은 버튼이 계속 눌린 줄 안다. macOS 전체화면에서
  // 화면 맨 위 모서리를 누르면 OS 오버레이(메뉴바·신호등)가 포인터를 가져가 버튼 뗌이 우리에게
  // 오지 않는데, 그러면 이후 모든 이동이 드래그가 되어 창이나 탭이 커서를 따라다닌다.
  const pressedButtonsRef = useRef(new Set<number>());
  // 아직 노치 하나를 못 채운 스크롤 잔량. 다음 이벤트로 넘어간다.
  const wheelNotchRef = useRef({ x: 0, y: 0 });
  // 버튼을 누른 지점. 여기서 CLICK_SLOP_PX 를 벗어나면 진짜 드래그로 보고 null 이 된다.
  const pressAnchorRef = useRef<{ x: number; y: number } | null>(null);

  /** 누른 자리를 아직 못 벗어났는지. 한 번 벗어나면 그 뒤로는 계속 통과시킨다. */
  const withinClickSlop = (clientX: number, clientY: number): boolean => {
    const anchor = pressAnchorRef.current;
    if (!anchor) {
      return false;
    }
    if (
      Math.abs(clientX - anchor.x) <= CLICK_SLOP_PX &&
      Math.abs(clientY - anchor.y) <= CLICK_SLOP_PX
    ) {
      return true;
    }
    pressAnchorRef.current = null;
    return false;
  };

  const moveTimerRef = useRef<number | null>(null);

  const send = useCallback(
    (events: RdpInputEvent[]) => {
      if (enabled && events.length > 0) {
        sendRdpInput(sessionId, events);
      }
    },
    [enabled, sessionId],
  );

  // 캔버스는 종횡비를 유지한 채 축소되어 그려지므로(object-contain), 표시 좌표를 그대로 보내면
  // 원격 커서가 어긋난다. 실제로 그려진 영역의 크기와 여백을 계산해 환산한다.
  const toRemote = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const canvas = surfaceRef.current;
      if (!canvas || !width || !height) {
        return null;
      }

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return null;
      }

      // object-contain 은 두 축 중 더 빡빡한 배율을 쓰고 남는 쪽을 가운데 정렬한다.
      const scale = Math.min(rect.width / width, rect.height / height);
      const drawnWidth = width * scale;
      const drawnHeight = height * scale;
      const offsetX = (rect.width - drawnWidth) / 2;
      const offsetY = (rect.height - drawnHeight) / 2;

      const x = (event.clientX - rect.left - offsetX) / scale;
      const y = (event.clientY - rect.top - offsetY) / scale;

      // 여백(레터박스)에서 발생한 이벤트는 화면 밖이다. 잘라내면 가장자리에 달라붙어 버리므로
      // 아예 보내지 않는다.
      //
      // 드래그 중이라고 가장자리로 붙이면 안 된다. 모니터별로 창을 펼치면 이 캔버스는 자기
      // 모니터만 담당하는데, 그 범위로 붙이는 순간 커서가 그 화면을 벗어날 수 없게 된다.
      // 화면 밖으로 나간 포인터는 옆 창의 캔버스가 이어받아야 한다.
      if (x < 0 || y < 0 || x >= width || y >= height) {
        return null;
      }

      return { x: Math.round(x) + originX, y: Math.round(y) + originY };
    },
    [width, height, originX, originY],
  );

  const flushMove = useCallback(() => {
    moveTimerRef.current = null;

    const screen = pendingScreenMoveRef.current;
    if (screen) {
      pendingScreenMoveRef.current = null;
      send([
        {
          kind: "mouseMoveScreen",
          screenX: screen.screenX,
          screenY: screen.screenY,
        },
      ]);
      return;
    }

    const pending = pendingMoveRef.current;
    if (!pending) {
      return;
    }
    pendingMoveRef.current = null;
    send([{ kind: "mouseMove", x: pending.x, y: pending.y }]);
  }, [send]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (withinClickSlop(event.clientX, event.clientY)) {
        return;
      }

      if (useScreenCoordinates) {
        // 캔버스 밖이어도 보낸다 — 옆 모니터로 끌고 가는 중일 수 있다. 어디인지는 메인
        // 프로세스가 판단한다.
        pendingScreenMoveRef.current = {
          screenX: event.screenX,
          screenY: event.screenY,
        };
        if (moveTimerRef.current === null) {
          moveTimerRef.current = window.setTimeout(flushMove, MOUSE_MOVE_INTERVAL_MS);
        }
        return;
      }

      const position = toRemote(event);
      if (!position) {
        return;
      }
      pendingMoveRef.current = position;
      if (moveTimerRef.current === null) {
        moveTimerRef.current = window.setTimeout(flushMove, MOUSE_MOVE_INTERVAL_MS);
      }
    },
    [toRemote, flushMove, useScreenCoordinates],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const position = toRemote(event);
      if (!position) {
        return;
      }
      // 키 입력을 받으려면 캔버스가 포커스를 가져야 한다.
      surfaceRef.current?.focus();

      // 화면 좌표 모드에서만 포인터를 잡는다.
      //
      // 안 잡으면 포인터가 캔버스를 벗어나는 순간 이동도 버튼 뗌도 우리에게 오지 않는다. OS 는
      // 창에 계속 보내지만 우리 핸들러는 캔버스 요소에만 걸려 있기 때문이다. 그러면 원격은
      // 버튼이 눌린 채 멈추고, 사용자가 손을 떼도 그 사실을 모른다.
      //
      // 캔버스 기준 좌표를 쓰는 평소 모드에서는 잡으면 안 된다. 캔버스 밖 좌표는 표현할 방법이
      // 없어 어차피 버려지고, 잡아 두면 그 창에 갇히기만 한다.
      if (useScreenCoordinates) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // 캡처를 못 잡아도 클릭 자체는 보내야 한다.
        }
      }
      // 눌린 위치를 먼저 확정한다. 이동이 아직 큐에 남아 있으면 엉뚱한 곳에서 눌린다.
      pendingMoveRef.current = null;
      pendingScreenMoveRef.current = null;
      pressedButtonsRef.current.add(event.button);
      pressAnchorRef.current = { x: event.clientX, y: event.clientY };
      send([
        useScreenCoordinates
          ? {
              kind: "mouseMoveScreen" as const,
              screenX: event.screenX,
              screenY: event.screenY,
            }
          : { kind: "mouseMove" as const, x: position.x, y: position.y },
        { kind: "mouseButton", button: event.button, pressed: true },
      ]);
    },
    [toRemote, send, useScreenCoordinates],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      pressedButtonsRef.current.delete(event.button);
      pressAnchorRef.current = null;
      if (useScreenCoordinates) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // 이미 풀렸으면 그만이다.
        }
        // 뗀 위치를 먼저 확정한다. 큐에 남은 이동이 뒤늦게 나가면 엉뚱한 곳에서 놓은 것이 된다.
        pendingScreenMoveRef.current = null;
        send([
          {
            kind: "mouseMoveScreen",
            screenX: event.screenX,
            screenY: event.screenY,
          },
          { kind: "mouseButton", button: event.button, pressed: false },
        ]);
        return;
      }

      send([{ kind: "mouseButton", button: event.button, pressed: false }]);
    },
    [send, useScreenCoordinates],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      // 실제 이동량을 누적했다가 노치가 찰 때만 내보낸다. 남는 소수점은 다음 이벤트로 넘겨서
      // 천천히 굴려도 결국 움직이게 한다.
      //
      // 모아서 늦게 보내지 않는다. 서버가 다시 그리는 횟수를 줄이려고 60ms 간격으로 묶어 봤더니
      // 스크롤이 계단처럼 끊기고 반응까지 늦어졌다 — 얻는 것보다 잃는 것이 컸다.
      // 노치가 아니라 그 아래 단위까지 쌓는다.
      //
      // 트랙패드는 한 번에 노치의 몇 십분의 일씩 보낸다. 노치 단위로 잘라 보내면 쌓이는 동안은
      // 아무것도 안 나가다가 1이 되는 순간 120 이 한 번에 나가서, 부드럽게 밀어도 화면이 계단식
      // 으로 뛴다. RDP 의 회전량은 노치보다 작은 값도 실을 수 있다.
      wheelNotchRef.current.y +=
        wheelDeltaToNotches(event.deltaY, event.deltaMode) * WHEEL_UNITS_PER_NOTCH;
      wheelNotchRef.current.x +=
        wheelDeltaToNotches(event.deltaX, event.deltaMode) * WHEEL_UNITS_PER_NOTCH;

    const verticalUnits = clampWheelUnits(wheelNotchRef.current.y);
    const horizontalUnits = clampWheelUnits(wheelNotchRef.current.x);
    wheelNotchRef.current.y -= verticalUnits;
    wheelNotchRef.current.x -= horizontalUnits;

    const events: RdpInputEvent[] = [];
    // 브라우저는 아래로 스크롤할 때 양수, RDP 는 음수를 쓴다.
    if (verticalUnits !== 0) {
      events.push({ kind: "wheel", vertical: true, delta: -verticalUnits });
    }
    if (horizontalUnits !== 0) {
      events.push({ kind: "wheel", vertical: false, delta: horizontalUnits });
    }
      send(events);
    },
    [send],
  );

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>, pressed: boolean) => {
      const code = resolveRemoteKeyCode(event.code, IS_MAC);
      const scancode = scancodeFor(code);
      if (scancode === null) {
        return;
      }
      // 원격으로 보낸 키가 로컬에서도 동작하면(탭 이동, 브라우저 단축키) 이중으로 먹는다.
      event.preventDefault();
      send([{ kind: "key", scancode, pressed }]);
    },
    [send],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => onKey(event, true),
    [onKey],
  );

  const onKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => onKey(event, false),
    [onKey],
  );

  // 포커스나 포인터를 잃으면 누르고 있던 키와 버튼을 원격이 계속 눌린 것으로 안다. Cmd+Tab 으로
  // 나갔다 오면 Alt 가 붙잡힌 채인 상태, macOS 전체화면에서 맨 위 모서리를 눌렀다가 마우스가
  // 눌린 채로 남는 상태가 대표적이다. 나갈 때 전부 떼어 준다.
  const releaseHeldKeys = useCallback(() => {
    pendingMoveRef.current = null;
    pendingScreenMoveRef.current = null;
    pressAnchorRef.current = null;

    const buttons = [...pressedButtonsRef.current];
    pressedButtonsRef.current.clear();

    send([
      ...buttons.map((button) => ({
        kind: "mouseButton" as const,
        button,
        pressed: false,
      })),
      { kind: "key", scancode: 0x001d, pressed: false }, // ControlLeft
      { kind: "key", scancode: 0x0038, pressed: false }, // AltLeft
      { kind: "key", scancode: 0x002a, pressed: false }, // ShiftLeft
      { kind: "key", scancode: 0x0036, pressed: false }, // ShiftRight
      { kind: "key", scancode: 0xe01d, pressed: false }, // ControlRight
      { kind: "key", scancode: 0xe038, pressed: false }, // AltRight
      { kind: "key", scancode: 0xe05b, pressed: false }, // MetaLeft
    ]);
  }, [send]);

  useEffect(() => {
    return () => {
      if (moveTimerRef.current !== null) {
        window.clearTimeout(moveTimerRef.current);
      }
    };
  }, []);

  return {
    handlers: {
      onPointerMove,
      onPointerDown,
      onPointerUp,
      // 포인터를 잃는 모든 경로에서 눌러둔 것을 놓는다. OS 오버레이가 포인터를 가져가면
      // pointercancel 로 오고, pointerup 은 영영 오지 않는다.
      onPointerLeave: releaseHeldKeys,
      onPointerCancel: releaseHeldKeys,
      onWheel,
      onKeyDown,
      onKeyUp,
      onBlur: releaseHeldKeys,
      onContextMenu: (event: React.MouseEvent) => {
        // 오른쪽 클릭은 원격으로 보낸다. 로컬 컨텍스트 메뉴가 뜨면 화면을 덮는다.
        event.preventDefault();
      },
    },
  };
}
