/**
 * 원격 화면이 지금 키보드를 쥐고 있는지 — 렌더러 안에서 쓰는 판정.
 *
 * 메인 쪽은 렌더러가 보내는 신호로 안다(`rdp:keyboard-capture`). 렌더러 안에서는 신호를 따로 들지
 * 않고 활성 요소를 본다 — 포커스가 곧 사실이라 상태처럼 어긋날 수 없다.
 *
 * 쓰이는 곳: 탭 순환 단축키처럼 **capture 단계**에서 window 에 붙는 리스너. 그것들은 캔버스보다
 * 먼저 도착하므로 캔버스가 `stopPropagation` 으로 막을 수 없고, 스스로 비켜 줘야 한다.
 */

/** 캔버스에 붙이는 표시. 여기 한 곳에서만 정한다 — 이름이 갈리면 조용히 안 먹는다. */
export const RDP_KEYBOARD_CAPTURE_ATTRIBUTE = "data-rdp-keyboard-capture";

const SELECTOR = `[${RDP_KEYBOARD_CAPTURE_ATTRIBUTE}]`;

/** 캔버스에 붙일 속성. JSX 에 그대로 펼쳐 쓴다. */
export const rdpKeyboardCaptureAttributes: Readonly<Record<string, string>> = {
  [RDP_KEYBOARD_CAPTURE_ATTRIBUTE]: "",
};

export function isRdpKeyboardCaptureFocused(): boolean {
  const active = document.activeElement;
  // closest 는 자기 자신도 본다. 캔버스가 곧 활성 요소인 평소 경우가 여기서 걸린다.
  return Boolean(active?.closest?.(SELECTOR));
}
