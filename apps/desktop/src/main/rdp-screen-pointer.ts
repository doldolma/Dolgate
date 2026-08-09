import type { RdpMonitorPlacement } from "@shared";

/** 대조에 필요한 만큼만 추린 로컬 디스플레이. Electron 의 `Display` 가 이 모양을 만족한다. */
export interface PointerDisplay {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * 세션마다 "물리 화면 ↔ 원격 모니터"를 잇는 정보.
 *
 * `displayIds[i]` 가 `placements[i]` 에 대응한다 — 접속할 때 선언한 순서가 그대로 유지된다
 * (rdp-core 의 build_monitor_layout 이 입력 순서를 보존한다).
 */
export interface ScreenPointerMapping {
  displayIds: readonly number[];
  placements: readonly RdpMonitorPlacement[];
}

/**
 * OS 화면 좌표를 원격 데스크톱 좌표로 옮긴다.
 *
 * 왜 창이 직접 계산하지 않는가: 버튼을 누른 채로 드래그하면 OS 가 이후 마우스 이벤트를 **처음
 * 누른 창에만** 보낸다. 포인터가 옆 화면으로 넘어가도 그 창이 계속 받는다. 그래서 각 창이
 * 자기 캔버스 기준으로 환산하면 자기 모니터 밖을 표현할 수 없고, 창을 끌어 옆 모니터로 옮기는
 * 동작이 경계에서 멈춘다.
 *
 * 화면 좌표는 어느 창이 받았든 같은 값이므로, 여기서 한 번에 옮기면 그 문제가 사라진다.
 *
 * 포인터가 어느 디스플레이에도 없거나(화면 사이 빈 공간) 그 디스플레이가 이 세션에 빌려주지
 * 않은 것이면 null 이다 — 원격에 보낼 위치가 없다는 뜻이다.
 */
export function mapScreenPointToDesktop(
  point: { screenX: number; screenY: number },
  displays: readonly PointerDisplay[],
  mapping: ScreenPointerMapping,
): { x: number; y: number } | null {
  const display = displays.find(
    (candidate) =>
      point.screenX >= candidate.bounds.x &&
      point.screenX < candidate.bounds.x + candidate.bounds.width &&
      point.screenY >= candidate.bounds.y &&
      point.screenY < candidate.bounds.y + candidate.bounds.height,
  );
  if (!display) {
    return null;
  }

  const index = mapping.displayIds.indexOf(display.id);
  const placement = index < 0 ? undefined : mapping.placements[index];
  if (!placement) {
    return null;
  }

  // 화면과 원격 모니터의 해상도가 다를 수 있다(HiDPI, 배율 낮춤). 비율로 옮긴다.
  const scaleX = placement.width / display.bounds.width;
  const scaleY = placement.height / display.bounds.height;

  const x = placement.left + (point.screenX - display.bounds.x) * scaleX;
  const y = placement.top + (point.screenY - display.bounds.y) * scaleY;

  // 마지막 픽셀을 넘지 않게 잡아 둔다. 반올림이 경계를 한 칸 넘기면 원격이 그 갱신을 버린다.
  return {
    x: Math.round(Math.min(x, placement.left + placement.width - 1)),
    y: Math.round(Math.min(y, placement.top + placement.height - 1)),
  };
}
