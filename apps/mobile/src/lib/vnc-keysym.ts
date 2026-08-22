/**
 * VNC Keysym Mapping
 *
 * Maps JavaScript key names (from KeyboardEvent.key / React Native key events)
 * to X11 keysym values used by the RFB/VNC protocol.
 *
 * This is a standalone module — it does NOT reuse the terminal escape-sequence
 * mapper (terminal-input.ts) which maps to ANSI escape codes.
 */

// ---------------------------------------------------------------------------
// Special Key Keysyms (X11/XKB definitions)
// ---------------------------------------------------------------------------

const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  ArrowLeft: 0xff51,
  Up: 0xff52,
  ArrowUp: 0xff52,
  Right: 0xff53,
  ArrowRight: 0xff53,
  Down: 0xff54,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
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
  // Modifier keys
  Shift: 0xffe1,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  Control: 0xffe3,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  Meta: 0xffe7,
  MetaLeft: 0xffe7,
  MetaRight: 0xffe8,
  // 물리 "윈도우 키" 는 X11 에서 Meta 가 아니라 Super 를 낸다 — GNOME·KDE 의 단축키도 Super 에
  // 걸려 있다. Meta_L 로 보내면 조용히 아무 일도 일어나지 않는다.
  Super: 0xffeb,
  SuperLeft: 0xffeb,
  SuperRight: 0xffec,
  Alt: 0xffe9,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  // Common aliases
  ' ': 0x0020,
  Space: 0x0020,
};

// ---------------------------------------------------------------------------
// Modifier Keysyms
// ---------------------------------------------------------------------------

export const MODIFIER_KEYSYMS = {
  ctrl: 0xffe3,
  shift: 0xffe1,
  alt: 0xffe9,
  /**
   * "메타" 는 UI 에서 **윈도우 키(맥은 Command)** 를 가리킨다. 그 물리 키가 내는 keysym 은
   * `Meta_L`(0xffe7) 이 아니라 `Super_L`(0xffeb) 이다 — 리눅스 데스크톱의 단축키도, 맥·윈도우
   * VNC 서버의 매핑도 Super 에 걸려 있다. Meta_L 로 보내면 조합키가 조용히 아무 일도 하지
   * 않는다(역사적으로 Meta 는 Alt 자리에 매핑됐다).
   *
   * 이름→keysym 표(KEYSYMS)의 `Meta` 항목은 그대로 둔다 — 그건 keysym 이름 그 자체다.
   */
  meta: 0xffeb,
} as const;

export type ModifierKey = keyof typeof MODIFIER_KEYSYMS;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a JavaScript key string to a VNC keysym.
 *
 * For single printable characters, returns the Unicode code point (which
 * matches X11 keysym for Latin-1, and uses the 0x01000000 + codepoint
 * convention for non-Latin-1 Unicode).
 *
 * For special/modifier keys, returns the appropriate X11 keysym constant.
 *
 * Returns null if the key cannot be mapped.
 */
export function keyToKeysym(key: string): number | null {
  // Check special keys first
  const special = SPECIAL_KEYSYMS[key];
  if (special !== undefined) {
    return special;
  }

  // Single character — use Unicode code point
  if (key.length === 1) {
    const code = key.charCodeAt(0);
    // ASCII/Latin-1 range maps directly
    if (code >= 0x0020 && code <= 0x007e) {
      return code;
    }
    if (code >= 0x00a0 && code <= 0x00ff) {
      return code;
    }
    // Non-Latin-1 Unicode: X11 convention is 0x01000000 + codepoint
    if (code > 0x00ff) {
      return 0x01000000 + code;
    }
    return code;
  }

  return null;
}

/**
 * Check if a key string represents a modifier key.
 */
export function isModifierKey(key: string): boolean {
  return (
    key === 'Shift' ||
    key === 'ShiftLeft' ||
    key === 'ShiftRight' ||
    key === 'Control' ||
    key === 'ControlLeft' ||
    key === 'ControlRight' ||
    key === 'Alt' ||
    key === 'AltLeft' ||
    key === 'AltRight' ||
    key === 'Meta' ||
    key === 'MetaLeft' ||
    key === 'MetaRight' ||
    key === 'CapsLock' ||
    key === 'NumLock' ||
    key === 'ScrollLock'
  );
}

/**
 * Get all keysyms needed for a key press with modifiers.
 * Returns an ordered array of [keysym, pressed] pairs representing
 * the full sequence: modifiers down, key down, key up, modifiers up.
 */
export function buildKeySequence(
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
): Array<[keysym: number, pressed: boolean]> {
  const keysym = keyToKeysym(key);
  if (keysym === null) {
    return [];
  }

  const sequence: Array<[number, boolean]> = [];

  // Modifiers down
  if (modifiers.ctrl) sequence.push([MODIFIER_KEYSYMS.ctrl, true]);
  if (modifiers.alt) sequence.push([MODIFIER_KEYSYMS.alt, true]);
  if (modifiers.shift) sequence.push([MODIFIER_KEYSYMS.shift, true]);
  if (modifiers.meta) sequence.push([MODIFIER_KEYSYMS.meta, true]);

  // Key down + up
  sequence.push([keysym, true]);
  sequence.push([keysym, false]);

  // Modifiers up (reverse order)
  if (modifiers.meta) sequence.push([MODIFIER_KEYSYMS.meta, false]);
  if (modifiers.shift) sequence.push([MODIFIER_KEYSYMS.shift, false]);
  if (modifiers.alt) sequence.push([MODIFIER_KEYSYMS.alt, false]);
  if (modifiers.ctrl) sequence.push([MODIFIER_KEYSYMS.ctrl, false]);

  return sequence;
}
