/**
 * 펼쳐 둔 창들을 실제로 잰 값으로 원격 모니터 배치를 다시 만든다.
 *
 * 왜 재는가: 접속할 때는 디스플레이 크기(`display.bounds`)로 선언하는데, 창이 그 화면을 전부
 * 쓰지 못하는 경우가 있다. 노치 있는 맥북은 전체화면이어도 위 33px 을 못 받아서 1512x982 짜리
 * 화면에 1512x949 만 그린다. 그 차이만큼 원격 화면이 축소되어(좌우 검은 띠) 그려지고, 축소된
 * 캔버스 안에 원격 커서가 찍혀 실제 포인터와 어긋난다.
 *
 * 잰 값으로 다시 선언하면 원격 데스크톱이 창이 그릴 수 있는 크기로 만들어져 두 증상이 같이
 * 사라진다. 잘라내는 것과 다르다 — 잘라내면 원격 화면의 일부가 안 보인다.
 */

/** 창 하나를 잰 결과. 화면 좌표(DIP)다 — `BrowserWindow.getContentBounds()` 가 이 모양이다. */
export interface MeasuredMonitorWindow {
  /** 접속 때 선언한 배치의 인덱스. 원격 모니터 번호다. */
  index: number;
  /** 전체화면 전환이 끝났는지. 전환 도중 값은 화면 크기와 다르다. */
  fullScreen: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** rdp-core 의 `rdpSetLayout` payload 항목. 접속 payload 의 모니터와 같은 모양이다. */
export interface MonitorLayoutRequest {
  width: number;
  height: number;
  left: number;
  top: number;
  primary: boolean;
}

/**
 * 잰 창들로 배치 요청을 만든다. 보낼 수 없는 상태면 `null`.
 *
 * 보내지 않는 경우:
 * - 창이 하나라도 전체화면이 아니다 → 전환 애니메이션 중 값이 섞이면 지금보다 더 어긋난다
 * - 인덱스가 빠져 있다 → 그 모니터를 선언에서 빼면 원격이 화면을 재배치해 전부 어긋난다
 * - 두 개 미만이다 → 나누지 않는 상태다. 단일 화면은 창 크기 경로가 이미 맞춘다
 *
 * 위치도 잰 값을 쓴다. 포인터 환산이 같은 사각형을 쓰므로 한 곳에서 나온 값이어야 한다 —
 * `display.bounds` 와 섞으면 노치 33px 만큼 또 어긋난다.
 */
export function buildLayoutRequest(
  measured: readonly MeasuredMonitorWindow[],
  monitorCount: number,
  primaryIndex: number,
): MonitorLayoutRequest[] | null {
  if (monitorCount < 2 || measured.length !== monitorCount) {
    return null;
  }
  if (measured.some((entry) => !entry.fullScreen)) {
    return null;
  }

  const byIndex = new Map(measured.map((entry) => [entry.index, entry]));
  const request: MonitorLayoutRequest[] = [];
  for (let index = 0; index < monitorCount; index += 1) {
    const entry = byIndex.get(index);
    if (!entry || entry.bounds.width <= 0 || entry.bounds.height <= 0) {
      return null;
    }
    request.push({
      width: Math.round(entry.bounds.width),
      height: Math.round(entry.bounds.height),
      left: Math.round(entry.bounds.x),
      top: Math.round(entry.bounds.y),
      primary: index === primaryIndex,
    });
  }

  // 주로 표시된 것이 하나도 없으면 원격이 임의로 정하고, 시작 메뉴와 작업표시줄이 엉뚱한 화면에
  // 붙는다. 첫 모니터를 주로 둔다 — rdp-core 도 같은 규칙이다.
  if (!request.some((monitor) => monitor.primary)) {
    request[0].primary = true;
  }

  return request;
}

/** 같은 배치인지. 창 이벤트는 여러 번 오는데, 같은 값을 다시 보내면 원격이 화면을 또 멈춘다. */
export function sameLayoutRequest(
  a: readonly MonitorLayoutRequest[] | null,
  b: readonly MonitorLayoutRequest[] | null,
): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((monitor, index) => {
    const other = b[index];
    return (
      monitor.width === other.width &&
      monitor.height === other.height &&
      monitor.left === other.left &&
      monitor.top === other.top &&
      monitor.primary === other.primary
    );
  });
}
