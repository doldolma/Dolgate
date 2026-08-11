/**
 * 브라우저 키 이벤트 → X11 keysym.
 *
 * **RDP 와 근본적으로 다른 지점이다.** RDP 는 스캔코드(물리 키 위치)를 보내고 원격이 자기 레이아웃
 * 으로 해석한다. RFB 는 **keysym**(그 키가 만들어 낸 글자·기능)을 보내므로, 우리가 "무엇이
 * 입력되었는가" 를 정해서 보내야 한다.
 *
 * 그래서 판정의 1순위는 `KeyboardEvent.key`(실제로 만들어진 글자)이고, `code`(물리 위치)는 글자가
 * 없는 키에만 쓴다. noVNC 도 같은 방식이다. 이렇게 하면 원격 레이아웃이 무엇이든 사용자가 자기
 * 키보드에서 본 글자가 그대로 들어간다.
 *
 * **한글·IME 는 이 경로로 보내지 않는다.** 조합 중(`isComposing`)에는 키를 보내면 안 되고, 완성된
 * 글자는 조합이 끝난 뒤 문자 단위로 보내야 한다 — 조합 중 키를 흘리면 원격에 자모가 그대로 찍힌다.
 * 호출부가 그 판정을 하도록 `isComposing` 을 확인하는 도우미를 함께 둔다.
 */

/** 유니코드 문자를 keysym 으로. X11 규약이다. */
export function keysymFromCharacter(character: string): number | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return null;
  }
  // Latin-1 은 코드포인트가 곧 keysym 이다.
  if (codePoint >= 0x20 && codePoint <= 0xff) {
    return codePoint;
  }
  // 그 밖의 유니코드는 0x01000000 + 코드포인트. 한글·기호가 이 규약으로 들어간다.
  return 0x0100_0000 + codePoint;
}

/**
 * 글자를 만들지 않는 키의 keysym.
 *
 * 값은 X11 `keysymdef.h` 다. 이름을 그대로 두는 이유: 숫자만 있으면 나중에 누가 "왜 이 값인가" 를
 * 확인할 방법이 없다.
 */
const FUNCTIONAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  NumpadEnter: 0xff8d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  // 조합 키. 좌우를 구분해야 원격의 좌우 구분 단축키가 맞는다.
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  // macOS 의 Option(오른쪽)은 AltGr 자리로 간다 — 리눅스 원격에서 그렇게 해석되는 것이 자연스럽다.
  AltRight: 0xfe03,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  PrintScreen: 0xff61,
  Pause: 0xff13,
  ContextMenu: 0xff67,
};

export interface KeyLike {
  /** 실제로 만들어진 글자, 또는 "Enter" 같은 이름. */
  key: string;
  /** 물리 키 위치. 좌우 구분과 숫자패드 판정에 쓴다. */
  code?: string;
  /** IME 조합 중인가. 조합 중에는 키를 보내지 않는다. */
  isComposing?: boolean;
}

/**
 * 이 키 이벤트를 원격으로 보낼 keysym. 보내지 않아야 하면 null.
 *
 * 조합 중이면 null 이다 — 그때 키를 보내면 원격에 자모가 찍히고, 완성된 글자는 나중에 또 들어간다.
 */
export function keysymFromEvent(event: KeyLike): number | null {
  if (event.isComposing) {
    return null;
  }

  // 좌우가 구분되는 키는 위치(code)를 먼저 본다. key 는 양쪽 모두 "Shift" 라 구분이 없다.
  if (event.code && event.code in FUNCTIONAL_KEYSYMS) {
    return FUNCTIONAL_KEYSYMS[event.code];
  }
  if (event.key in FUNCTIONAL_KEYSYMS) {
    return FUNCTIONAL_KEYSYMS[event.key];
  }

  // 여기부터는 글자를 만드는 키다. `key` 가 곧 그 글자다(Shift·AltGr 이 이미 반영돼 있다).
  if (event.key.length === 0) {
    return null;
  }
  // "Unidentified" 처럼 이름이 여러 글자면 우리가 모르는 기능 키다. 글자로 오해해 보내면 원격에
  // 엉뚱한 문자가 찍힌다.
  if ([...event.key].length > 1) {
    return null;
  }
  return keysymFromCharacter(event.key);
}

/**
 * 조합이 끝난 글자열을 keysym 목록으로.
 *
 * 한글은 `compositionend` 로 완성 글자가 온다 — 그것을 글자 단위로 눌렀다 떼면 원격에 그대로
 * 들어간다. 코드포인트 단위로 자르는 이유는 이모지처럼 서로게이트 쌍인 글자를 반으로 쪼개지 않기
 * 위한 것이다.
 */
export function keysymsFromComposedText(text: string): number[] {
  const keysyms: number[] = [];
  for (const character of text) {
    const keysym = keysymFromCharacter(character);
    if (keysym !== null) {
      keysyms.push(keysym);
    }
  }
  return keysyms;
}
