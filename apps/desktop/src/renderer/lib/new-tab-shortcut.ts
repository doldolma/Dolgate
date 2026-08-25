import { isRdpKeyboardCaptureFocused } from './rdp-keyboard-focus';

/**
 * 새 탭 단축키(⌘T / Ctrl+T).
 *
 * **capture 단계에서 잡아야 한다.** 버블 단계로 붙였을 때 윈도우에서는 아예 동작하지 않았다.
 * 터미널에 포커스가 있으면 xterm 이 먼저 가져가기 때문이다: Ctrl+letter 는 xterm 에게 정당한
 * 터미널 입력이라(Ctrl+T = 0x14, DC4) `evaluateKeyboardEvent` 가 키를 만들고, `Terminal` 이
 * 마지막에 `cancel(event, true)` — 즉 `preventDefault()` + `stopPropagation()` — 으로 이벤트를
 * 끝낸다. window 까지 올라오지 못하니 리스너가 실행조차 되지 않는다.
 *
 * 맥이 멀쩡했던 것은 플랫폼 차이가 아니라 **조합 차이**다. ⌘T 는 metaKey 라 xterm 의
 * `ev.ctrlKey && !ev.metaKey` 분기에 걸리지 않고, Meta 조합 중 xterm 이 처리하는 것은 ⌘A(전체
 * 선택)뿐이다. 그래서 키가 만들어지지 않고 `if (!result.key) return true` 로 그냥 지나간다.
 * 맥에서 단축키를 Ctrl+T 로 바꾸면 똑같이 죽는다.
 *
 * 같은 병을 탭 순환 단축키가 먼저 겪었다(main.ts 의 before-input-event 주석, NetworkBridge 의
 * capture 리스너).
 */

/** 이 조합이 새 탭 단축키인지. Shift·Alt 가 붙으면 다른 단축키이므로 우리 것이 아니다. */
export function matchNewTabShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
    return false;
  }
  return event.key === 't' || event.key === 'T';
}

/**
 * 새 탭 단축키를 window 에 건다. 해제 함수를 돌려준다.
 *
 * 잡았으면 `stopPropagation` 까지 한다 — 안 하면 capture 단계를 지난 이벤트가 계속 내려가
 * 셸에 0x14 가 흘러간다(readline 의 transpose-chars 로 입력 줄 글자가 뒤바뀐다).
 */
export function installNewTabShortcut(onTrigger: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    // 원격 화면이 키보드를 쥐고 있으면 Ctrl+T 는 원격 것이다. capture 단계라 캔버스보다 먼저
    // 도착하므로 캔버스가 막을 수 없고, 우리가 비켜 줘야 한다.
    if (isRdpKeyboardCaptureFocused()) {
      return;
    }
    if (!matchNewTabShortcut(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onTrigger();
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
