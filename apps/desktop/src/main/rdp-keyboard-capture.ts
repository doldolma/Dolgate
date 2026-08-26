/**
 * 원격 화면이 키보드를 잡고 있는 동안 우리 앱 단축키를 비켜 준다.
 *
 * 왜 메인이 하는가: 캔버스는 받은 키를 제대로 원격으로 보내는데, 그 키가 캔버스까지 오지 못한다.
 * 가로채는 층이 둘 다 메인에 있다 —
 *
 * - Win/Linux: `before-input-event` 가 **렌더러 도달 전에** Ctrl+Tab·Ctrl+W·Ctrl+1~9 를 가져간다
 * - macOS: 메뉴 accelerator 가 웹 페이지보다 먼저 매칭된다. macOS 는 Cmd 를 원격 Ctrl 로 옮기므로
 *   (`resolveRemoteKeyCode`) Cmd+W 는 원격 문서 닫기, Cmd+1~9 는 원격 앱 탭이 되어야 한다
 *
 * 그래서 렌더러가 "지금 원격이 키보드를 쥐었다"를 알려 주고, 여기서 그 두 층을 끈다. 대가로 그
 * 동안 Dolgate 자신의 탭은 키보드로 옮길 수 없다 — 마우스로 탭을 누르거나, 캔버스 밖을 한 번
 * 클릭해 포커스를 뺀 뒤 평소 단축키를 쓰면 된다(제품 결정).
 */

import { Menu } from 'electron';

/**
 * 캡처 중에 비활성화할 메뉴 항목.
 *
 * 비활성 항목의 key equivalent 는 매칭되지 않아 키가 웹 페이지로 내려온다. 메뉴를 다시 만들지
 * 않고 `enabled` 만 바꾼다 — 재생성은 macOS 메뉴바가 깜빡이고, 열려 있던 메뉴가 닫힌다.
 *
 * **창 닫기(Cmd+Shift+W)와 시스템 항목(종료·숨기기·최소화)은 넣지 않는다.** 원격에서 Ctrl+Shift+W
 * 를 쓸 일은 드물고, 혹시 캡처가 켜진 채로 남는 버그가 생기면 키보드로 창을 닫을 길이 하나는
 * 있어야 한다.
 */
export const RDP_CAPTURE_SENSITIVE_MENU_IDS: readonly string[] = [
  'tab-next',
  'tab-prev',
  'tab-reopen',
  'tab-close',
  'tab-last',
  'window-new',
  'tab-index-0',
  'tab-index-1',
  'tab-index-2',
  'tab-index-3',
  'tab-index-4',
  'tab-index-5',
  'tab-index-6',
  'tab-index-7',
  // 배율 단축키도 원격이 받아야 한다 — Cmd+/-/0 은 원격 앱에도 흔한 조합이다.
  'view-zoom-in',
  'view-zoom-in-equal',
  'view-zoom-out',
  'view-zoom-reset',
];

/**
 * 지금 키보드를 쥔 창들.
 *
 * 포커스는 한 창에만 있지만 집합으로 둔다 — 모니터별 창까지 같은 캔버스를 쓰고, 창을 옮길 때
 * 새 창의 focus 가 옛 창의 blur 보다 먼저 오는 순서가 있다. 하나라도 남아 있으면 캡처 상태다.
 */
const capturedWindowIds = new Set<number>();

/** 메뉴를 마지막으로 어떤 상태로 맞췄는지. 같은 값을 다시 쓰지 않기 위한 것이다. */
let menuDisabled = false;

function applyMenuState(): void {
  const shouldDisable = capturedWindowIds.size > 0;
  if (shouldDisable === menuDisabled) {
    return;
  }
  const menu = Menu.getApplicationMenu();
  if (!menu) {
    return;
  }
  for (const id of RDP_CAPTURE_SENSITIVE_MENU_IDS) {
    const item = menu.getMenuItemById(id);
    if (item) {
      item.enabled = !shouldDisable;
    }
  }
  menuDisabled = shouldDisable;
}

/** 렌더러가 알려 온 상태를 기록한다. */
export function setRdpKeyboardCapture(windowId: number, active: boolean): void {
  if (active) {
    capturedWindowIds.add(windowId);
  } else {
    capturedWindowIds.delete(windowId);
  }
  applyMenuState();
}

/**
 * 창이 사라졌다. 캡처를 쥔 채 닫히면(전체화면 세션 창을 그냥 닫는 경우) 그 창의 blur 가 오지
 * 않아, 지우지 않으면 앱 단축키가 영구히 죽는다.
 */
export function forgetRdpKeyboardCapture(windowId: number): void {
  setRdpKeyboardCapture(windowId, false);
}

/** 이 창이 키보드를 쥐고 있는가. `before-input-event` 가 이걸 보고 비켜 준다. */
export function isRdpKeyboardCaptureActive(windowId: number): boolean {
  return capturedWindowIds.has(windowId);
}

/** 테스트용. 모듈 상태를 비운다. */
export function resetRdpKeyboardCaptureForTests(): void {
  capturedWindowIds.clear();
  menuDisabled = false;
}
