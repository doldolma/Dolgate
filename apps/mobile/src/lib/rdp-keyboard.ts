export type RdpModifierKey = 'ctrl' | 'shift' | 'alt' | 'meta';

/** PS/2 set-1 scancodes. Extended keys use the core's 0xE000 convention. */
export const RDP_MODIFIER_SCANCODES: Readonly<Record<RdpModifierKey, number>> =
  {
    ctrl: 0x1d,
    shift: 0x2a,
    alt: 0x38,
    meta: 0xe05b,
  };

const RDP_SPECIAL_SCANCODES: Readonly<Record<string, number>> = {
  Escape: 0x01,
  Backspace: 0x0e,
  Tab: 0x0f,
  Enter: 0x1c,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  F11: 0x57,
  F12: 0x58,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
};

const RDP_PRINTABLE_SCANCODES: Readonly<Record<string, number>> = {
  '1': 0x02,
  '2': 0x03,
  '3': 0x04,
  '4': 0x05,
  '5': 0x06,
  '6': 0x07,
  '7': 0x08,
  '8': 0x09,
  '9': 0x0a,
  '0': 0x0b,
  '-': 0x0c,
  '=': 0x0d,
  q: 0x10,
  w: 0x11,
  e: 0x12,
  r: 0x13,
  t: 0x14,
  y: 0x15,
  u: 0x16,
  i: 0x17,
  o: 0x18,
  p: 0x19,
  '[': 0x1a,
  ']': 0x1b,
  a: 0x1e,
  s: 0x1f,
  d: 0x20,
  f: 0x21,
  g: 0x22,
  h: 0x23,
  j: 0x24,
  k: 0x25,
  l: 0x26,
  ';': 0x27,
  "'": 0x28,
  '`': 0x29,
  '\\': 0x2b,
  z: 0x2c,
  x: 0x2d,
  c: 0x2e,
  v: 0x2f,
  b: 0x30,
  n: 0x31,
  m: 0x32,
  ',': 0x33,
  '.': 0x34,
  '/': 0x35,
  ' ': 0x39,
};

export function keyToRdpScancode(key: string): number | null {
  const special = RDP_SPECIAL_SCANCODES[key];
  if (special !== undefined) return special;
  if (key.length !== 1) return null;
  return RDP_PRINTABLE_SCANCODES[key.toLocaleLowerCase('en-US')] ?? null;
}

/**
 * US 배열에서 Shift 를 눌러야 나오는 문자 → Shift 없이 눌렀을 때의 문자.
 *
 * 스캔코드는 **키의 물리 위치**라서 문자 자체를 담지 못한다. `!` 를 보내려면 `1` 의 스캔코드를
 * Shift 와 함께 눌러야 한다.
 */
const RDP_SHIFTED_CHARACTERS: Readonly<Record<string, string>> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
};

export interface RdpKeystroke {
  scancode: number;
  /** Shift 를 눌러야 그 문자가 나오는지. */
  shift: boolean;
}

/**
 * 한 문자를 보낼 스캔코드와 Shift 여부로 바꾼다. 매핑이 없으면 `null`.
 *
 * **왜 유니코드보다 스캔코드를 먼저 쓰는가:** 둘 다 동작한다(유니코드로 한글이 들어가는 것을
 * 확인했다). 다만 스캔코드는 modifier 와 자연히 맞물린다 — Ctrl+C 나 Alt+Tab 처럼 조합이
 * 필요한 순간에 같은 경로로 보낼 수 있고, 유니코드 이벤트에는 modifier 개념이 없다. 그래서
 * 매핑이 있는 문자는 스캔코드로, 없는 문자(한글 등)는 유니코드로 보낸다.
 */
export function characterToRdpKeystroke(character: string): RdpKeystroke | null {
  if (character.length !== 1) return null;

  const shifted = RDP_SHIFTED_CHARACTERS[character];
  if (shifted !== undefined) {
    const scancode = keyToRdpScancode(shifted);
    return scancode === null ? null : { scancode, shift: true };
  }

  const scancode = keyToRdpScancode(character);
  if (scancode === null) return null;
  // 대문자는 같은 키를 Shift 와 함께 누른 것이다.
  const shift = character !== character.toLocaleLowerCase('en-US');
  return { scancode, shift };
}

/**
 * 네이티브 입력 뷰의 special-key 이름 → PS/2 set-1 스캔코드.
 *
 * 그 뷰는 터미널용으로 만들어졌지만 주는 것이 **키 이벤트**라 원격 데스크톱에도 그대로 맞는다.
 * `c`·`d`·`l` 등은 Ctrl 조합 단축키 자리이므로 문자 키의 스캔코드로 보낸다(Ctrl 은 호출부가
 * modifier 로 감싼다).
 */
export const RDP_SPECIAL_KEY_SCANCODES: Readonly<Record<string, number>> = {
  // 한 번 눌러 떼는 Win 키. 윈도우는 **놓을 때** 시작 메뉴를 열기 때문에, 누른 상태를 유지하는
  // 수정키 토글로는 두 번 눌러야 열렸다.
  meta: 0xe05b,
  escape: 0x01,
  tab: 0x0f,
  enter: 0x1c,
  backspace: 0x0e,
  delete: 0xe053,
  arrowUp: 0xe048,
  arrowDown: 0xe050,
  arrowLeft: 0xe04b,
  arrowRight: 0xe04d,
  home: 0xe047,
  end: 0xe04f,
  pageUp: 0xe049,
  pageDown: 0xe051,
  c: 0x2e,
  d: 0x20,
  l: 0x26,
};

/** Iterates Unicode scalar values rather than UTF-16 code units. */
export function textToUnicodeCodepoints(text: string): number[] {
  const codepoints: number[] = [];
  for (const character of text) {
    const codepoint = character.codePointAt(0);
    if (codepoint !== undefined) codepoints.push(codepoint);
  }
  return codepoints;
}
