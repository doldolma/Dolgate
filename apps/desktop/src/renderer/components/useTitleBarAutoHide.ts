import { useEffect, useState } from "react";

/**
 * 상단 몇 px 안에 포인터가 들어오면 타이틀바를 부른다.
 *
 * 좁으면 부르기 어렵고 넓으면 원격 화면 상단(작업표시줄·창 제목)을 조작할 때마다 튀어나온다.
 * "가장자리를 노린 동작"만 걸려야 한다.
 *
 * 4px 에서 12px 로 올렸다. 타이틀바의 전체화면 버튼이 생겨서 F11 을 모르는 사용자도 전체화면에
 * 들어오는데, 그 상태에서 나오는 경로가 이 띠뿐이다 — 4px 은 화면 테두리에 정확히 붙여야 하는
 * 폭이라, 위쪽에 다른 모니터가 있으면 커서가 그 화면으로 넘어가 버려 부를 수 없었다.
 */
const REVEAL_EDGE_PX = 12;

/**
 * 포인터가 타이틀바를 벗어난 뒤 접기까지 기다리는 시간(ms).
 *
 * 즉시 접으면 탭을 누르려고 내려오는 도중에 사라진다. 탭 하나 거리를 지나갈 여유를 준다.
 */
const HIDE_DELAY_MS = 400;

export type TitleBarMode =
  /** 항상 보인다. */
  | "visible"
  /** 감춰뒀다가 상단 가장자리에 포인터가 오면 내려온다. */
  | "reveal-on-hover"
  /** 감춘 채로 둔다. 부르는 방법이 없다. */
  | "hidden";

/**
 * 이 플랫폼·상태에서 타이틀바를 어떻게 다룰지.
 *
 * macOS 전체화면에서 감췄다 부르는 건 안 된다. 상단 가장자리를 OS 가 가지고 있어서, 포인터를
 * 위에 대면 메뉴바와 창 타이틀바가 내려온다. 그걸 내렸다 올리는 주체가 OS 라 우리 바와 타이밍이
 * 맞지 않는다 — 탭을 누르려고 우리 바로 내려오는 순간 포인터가 상단을 벗어나 OS 바만 먼저
 * 접히고, 그 자리에 원격 화면이 드러나며 우리 바만 공중에 뜬다. 위치를 인셋으로 맞춰도
 * 마찬가지다. Chrome·Safari 는 툴바를 네이티브 타이틀바 액세서리로 붙여 OS 가 메뉴바와 함께
 * 움직이게 하지만, Electron 은 그걸 노출하지 않는다.
 *
 * 그래서 macOS 전체화면에서는 부르지 않고 그냥 감춘다. 부르지 않으면 경쟁도 없다. 전체화면은
 * 한 세션에 집중하는 모드이므로 탭 목록이 없어도 된다 — 탭 전환은 단축키(Cmd+1~9,
 * Cmd+Alt+←/→), 전체화면 종료는 macOS 오버레이의 신호등으로 한다.
 *
 * Windows·Linux 는 frame:false 라 상단에 경쟁자가 없어 불러올 수 있다.
 */
export function titleBarMode(
  isFullScreen: boolean,
  desktopPlatform: string,
): TitleBarMode {
  if (!isFullScreen) {
    // 창 모드에서 감추면 창을 옮길 방법이 사라진다 — 드래그 영역이 타이틀바에 있다.
    return "visible";
  }
  return desktopPlatform === "darwin" ? "hidden" : "reveal-on-hover";
}

/**
 * 전체화면에서 타이틀바를 감추고, 부를 수 있는 모드면 상단 가장자리에서 다시 부른다.
 */
export function useTitleBarAutoHide(mode: TitleBarMode): {
  visible: boolean;
  /** 타이틀바 위에 포인터가 있는 동안은 접지 않는다. */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
} {
  const [revealed, setRevealed] = useState(false);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    if (mode !== "reveal-on-hover") {
      // 모드가 바뀌면 상태를 되돌린다. 남겨두면 다음에 부를 수 있게 됐을 때 이유 없이 펼쳐져 있다.
      setRevealed(false);
      setHovering(false);
      return;
    }

    const onMove = (event: PointerEvent) => {
      if (event.clientY <= REVEAL_EDGE_PX) {
        setRevealed(true);
      }
    };

    // 창 밖으로 나가면(다른 화면으로 이동 등) 부른 상태를 유지할 이유가 없다.
    const onLeave = () => setRevealed(false);

    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== "reveal-on-hover" || !revealed || hovering) {
      return;
    }
    const timer = window.setTimeout(() => setRevealed(false), HIDE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [mode, revealed, hovering]);

  return {
    visible: mode === "visible" || (mode === "reveal-on-hover" && revealed),
    onPointerEnter: () => setHovering(true),
    onPointerLeave: () => setHovering(false),
  };
}
