/**
 * 원격 화면이 들어갈 자리의 크기.
 *
 * 접속할 때 이 크기로 붙어야 화면이 뜨는 순간부터 창에 맞는다. 캔버스가 붙은 뒤에 크기를
 * 요청하면 그때까지 어긋난 화면이 보이고, 캔버스가 늦게 뜨면 그만큼 오래 어긋나 있다.
 *
 * 표식은 탭 아래 내용 영역(AppShell)에 붙어 있다 — 홈에서 원격을 열 때도 이미 있으므로
 * 접속 시점에 잴 수 있다.
 *
 * 잴 수 없으면 undefined — 메인이 창 크기로 대신한다.
 */
export function rdpViewportSize(): { width: number; height: number } | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  const area = document.querySelector("[data-rdp-viewport]");
  if (!area) {
    return undefined;
  }

  const rect = area.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return undefined;
  }

  return { width: Math.round(rect.width), height: Math.round(rect.height) };
}
