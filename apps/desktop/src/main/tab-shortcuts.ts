import type { TabCommandPayload } from '@shared';

// before-input-event 가 주는 Electron.Input 중 매칭에 쓰는 필드만 구조적으로 받는다
// (테스트에서 electron 모듈 없이 값을 만들 수 있게).
export interface TabShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly control: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly isAutoRepeat: boolean;
}

// Win/Linux 탭 단축키 매칭. 메뉴 accelerator 는 웹 페이지가 소비하지 않은 키에만
// 발동하는데(macOS 와 반대 순서), 이 앱은 포커스가 거의 항상 xterm 이고 xterm 은
// Ctrl+Tab 을 ctrl 여부와 무관하게 리터럴 탭으로 삼킨다 → 터미널 안에서 탭 단축키가
// 전부 죽는다. 그래서 렌더러 도달 전 단계(before-input-event)에서 이 함수로 매칭해
// 가로챈다. macOS 는 메뉴 key equivalent 가 페이지보다 먼저 매칭되므로 불필요.
export function matchTabCommand(
  input: TabShortcutInput,
): TabCommandPayload | null {
  if (!isPlainCtrlKeyDown(input)) {
    return null;
  }
  if (input.key === 'Tab') {
    // 꾹 눌러 연속 순환할 수 있게 autorepeat 도 통과시킨다.
    return { kind: input.shift ? 'prev' : 'next' };
  }
  if (input.shift) {
    // Ctrl+Shift+T: 닫은 탭 다시 열기. 꾹 누름에 과거 탭이 한꺼번에 쏟아지지
    // 않도록 autorepeat 는 무시한다.
    if (input.code === 'KeyT' && !input.isAutoRepeat) {
      return { kind: 'reopen' };
    }
    return null;
  }
  const digit = matchDigit(input);
  if (digit !== null) {
    // 메뉴(Chrome식)와 동일: 1~8 은 번호 점프, 9 는 마지막 탭.
    return digit === 9 ? { kind: 'last' } : { kind: 'index', index: digit };
  }
  return null;
}

// Ctrl+W: 탭 닫기(Chrome식). 메뉴 accelerator(CmdOrCtrl+W)와 같은 의도지만 터미널
// 포커스 중엔 xterm 이 ^W 로 삼켜 accelerator 가 못 받으므로 여기서 가로챈다.
// 대가로 Win/Linux 셸의 kill-word(^W)는 포기하기로 결정. Ctrl+Shift+W(창 닫기)는
// 건드리지 않고, 브라우저 탭과 달리 닫기 = 세션 종료라 실수 비용이 커서 꾹 누름
// (autorepeat)으로 연달아 닫히는 것은 막는다.
export function matchCloseActiveTab(input: TabShortcutInput): boolean {
  return (
    isPlainCtrlKeyDown(input) &&
    !input.shift &&
    input.code === 'KeyW' &&
    !input.isAutoRepeat
  );
}

// AltGr(=Ctrl+Alt) 문자 입력이나 다른 조합키를 건드리지 않기 위한 공통 전제.
function isPlainCtrlKeyDown(input: TabShortcutInput): boolean {
  return (
    input.type === 'keyDown' && input.control && !input.alt && !input.meta
  );
}

// 숫자 판정은 물리 키(code) 우선 — AZERTY 처럼 윗줄 숫자의 key 가 문자('&' 등)인
// 레이아웃에서도 Ctrl+1~9 가 동작해야 한다. 넘패드는 NumLock 꺼짐이면 key 가
// End/Home 등으로 바뀌므로, key 가 실제 숫자로 풀릴 때만 인정한다.
function matchDigit(input: TabShortcutInput): number | null {
  if (input.code.startsWith('Digit')) {
    const digit = Number(input.code.slice('Digit'.length));
    return digit >= 1 && digit <= 9 ? digit : null;
  }
  if (input.code.startsWith('Numpad') && /^[1-9]$/.test(input.key)) {
    return Number(input.key);
  }
  return null;
}
