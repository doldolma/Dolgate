/** 프레임버퍼 안에서 한 모니터가 차지하는 사각형. rdp-core 가 접속 때 알려준다. */
export interface RdpCanvasRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 누적 버퍼에서 잘라 보이는 캔버스로 옮길 한 번의 blit. */
export interface RegionBlit {
  /** 누적 버퍼에서 읽을 위치(전체 데스크톱 좌표). */
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
  /** 보이는 캔버스에 쓸 위치(모니터 좌표, 0 기준). */
  destX: number;
  destY: number;
}

/**
 * 갱신된 사각형에서 이 모니터에 걸친 부분만 남긴다.
 *
 * 모니터 하나를 한 창에 띄우면 다른 모니터의 갱신도 같은 세션으로 계속 들어온다. 걸러내지 않고
 * 그리면 옆 화면 내용이 이 창에 겹쳐 나온다.
 *
 * 겹치는 부분이 없으면 null — 그릴 것이 없다는 뜻이다.
 */
export function clipToRegion(
  frame: { x: number; y: number; width: number; height: number },
  region: RdpCanvasRegion | null | undefined,
): RegionBlit | null {
  if (!region) {
    // 영역이 없으면 전체 데스크톱을 그대로 그린다.
    return {
      sourceX: frame.x,
      sourceY: frame.y,
      width: frame.width,
      height: frame.height,
      destX: frame.x,
      destY: frame.y,
    };
  }

  const left = Math.max(frame.x, region.left);
  const top = Math.max(frame.y, region.top);
  const right = Math.min(frame.x + frame.width, region.left + region.width);
  const bottom = Math.min(frame.y + frame.height, region.top + region.height);

  if (right <= left || bottom <= top) {
    return null;
  }

  return {
    sourceX: left,
    sourceY: top,
    width: right - left,
    height: bottom - top,
    destX: left - region.left,
    destY: top - region.top,
  };
}

/** 이 창이 보여줄 크기. 영역이 있으면 그 모니터 크기, 없으면 데스크톱 전체 크기. */
export function visibleSize(
  desktopWidth: number,
  desktopHeight: number,
  region: RdpCanvasRegion | null | undefined,
): { width: number; height: number } {
  return region
    ? { width: region.width, height: region.height }
    : { width: desktopWidth, height: desktopHeight };
}
