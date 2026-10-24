// React 19.2 개발 빌드는 컴포넌트를 다시 그릴 때마다 바뀐 props 를 담아 performance.measure 를 남긴다(DevTools
// 성능 트랙용). 이 항목은 clearMeasures 전까지 페이지에 쌓이고, 담긴 내용은 렌더러의 네이티브 메모리로 복제된다 —
// 호스트 169개를 하나씩 지우는 동안 수 GB 가 쌓여 렌더러가 메모리 부족으로 죽었고 창이 까맣게 남았다.
//
// 성능 패널은 기록하는 동안 따로 받아 가므로 버퍼만 비워도 된다. React 가 다시 읽는 것은 resource 항목뿐이고, 앱은
// measure 를 쓰지 않는다. 배포 빌드의 React 는 이 항목을 남기지 않는다.

export const DEV_MEASURE_TRIM_INTERVAL_MS = 2_000;

/** 쌓인 measure 를 주기적으로 비운다. 멈추는 함수를 돌려준다. */
export function startDevMeasureTrim(intervalMs = DEV_MEASURE_TRIM_INTERVAL_MS): () => void {
  const timer = setInterval(() => performance.clearMeasures(), intervalMs);
  return () => clearInterval(timer);
}
