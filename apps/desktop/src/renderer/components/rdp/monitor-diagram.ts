import type { RdpLocalMonitor } from "@shared";

/** [MS-RDPEDISP] 2.2.2.2.1 이 허용하는 한 변의 최대 픽셀. 메인 프로세스의 상한과 같다. */
const MAX_DESKTOP_SIDE = 8192;

export interface DiagramRect {
  id: number;
  /** 그리는 영역 안에서의 위치·크기(%). */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 선택한 모니터들을 감싸는 사각형. 원격 데스크톱이 이 크기로 만들어진다. */
export function selectionBounds(
  monitors: readonly RdpLocalMonitor[],
): { left: number; top: number; width: number; height: number } {
  if (monitors.length === 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const left = Math.min(...monitors.map((m) => m.left));
  const top = Math.min(...monitors.map((m) => m.top));
  const right = Math.max(...monitors.map((m) => m.left + m.width));
  const bottom = Math.max(...monitors.map((m) => m.top + m.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * 모니터들을 그릴 영역 안의 비율 좌표로 옮긴다.
 *
 * 항상 **전체** 모니터를 기준으로 잡는다. 선택한 것만으로 잡으면 체크를 켜고 끌 때마다 그림이
 * 통째로 움직여, 어디를 눌렀는지 따라가기 어렵다.
 *
 * 가로세로 비율은 유지하고 남는 쪽은 가운데로 몬다 — 늘려서 채우면 세로 모니터가 가로로 보인다.
 */
export function diagramRects(
  monitors: readonly RdpLocalMonitor[],
): DiagramRect[] {
  const box = selectionBounds(monitors);
  if (box.width === 0 || box.height === 0) {
    return [];
  }

  // 긴 변을 100% 에 맞추고, 짧은 변은 그 비율만큼만 쓴다.
  const span = Math.max(box.width, box.height);
  const scale = 100 / span;
  const usedWidth = box.width * scale;
  const usedHeight = box.height * scale;
  const offsetX = (100 - usedWidth) / 2;
  const offsetY = (100 - usedHeight) / 2;

  return monitors.map((monitor) => ({
    id: monitor.id,
    left: offsetX + (monitor.left - box.left) * scale,
    top: offsetY + (monitor.top - box.top) * scale,
    width: monitor.width * scale,
    height: monitor.height * scale,
  }));
}

/**
 * 이 선택으로 접속할 수 있는지, 안 되면 왜인지.
 *
 * 여기서 걸러 주지 않으면 붙고 나서야 검은 화면이나 주 화면 폴백으로 드러난다.
 */
export function describeSelectionProblem(
  monitors: readonly RdpLocalMonitor[],
): string | null {
  if (monitors.length === 0) {
    return "모니터를 하나 이상 골라야 합니다.";
  }

  const box = selectionBounds(monitors);
  if (box.width > MAX_DESKTOP_SIDE || box.height > MAX_DESKTOP_SIDE) {
    return `고른 화면을 감싸는 크기가 ${box.width}×${box.height}로 한계(${MAX_DESKTOP_SIDE})를 넘습니다. 멀리 떨어진 화면을 함께 고르면 사이의 빈 공간까지 포함됩니다.`;
  }

  return null;
}

/**
 * 고른 화면들 사이에 빈 공간이 남는지.
 *
 * 원격 데스크톱은 사각형 하나라서, 화면이 떨어져 있거나 크기가 다르면 그 틈이 검은 영역으로
 * 남는다. 막을 이유는 없지만 미리 알려 줄 만하다.
 */
export function hasGaps(monitors: readonly RdpLocalMonitor[]): boolean {
  if (monitors.length < 2) {
    return false;
  }
  const box = selectionBounds(monitors);
  const covered = monitors.reduce(
    (sum, monitor) => sum + monitor.width * monitor.height,
    0,
  );
  return covered < box.width * box.height;
}
