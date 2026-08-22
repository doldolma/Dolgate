import {
  keyToKeysym,
  isModifierKey,
  buildKeySequence,
  MODIFIER_KEYSYMS,
} from '../src/lib/vnc-keysym';

describe('vnc-keysym', () => {
  describe('keyToKeysym', () => {
    it('maps ASCII printable characters to their code points', () => {
      expect(keyToKeysym('a')).toBe(0x61);
      expect(keyToKeysym('A')).toBe(0x41);
      expect(keyToKeysym('z')).toBe(0x7a);
      expect(keyToKeysym('0')).toBe(0x30);
      expect(keyToKeysym('!')).toBe(0x21);
      expect(keyToKeysym('~')).toBe(0x7e);
    });

    it('maps space correctly', () => {
      expect(keyToKeysym(' ')).toBe(0x0020);
      expect(keyToKeysym('Space')).toBe(0x0020);
    });

    it('maps special keys to X11 keysyms', () => {
      expect(keyToKeysym('Escape')).toBe(0xff1b);
      expect(keyToKeysym('Tab')).toBe(0xff09);
      expect(keyToKeysym('Enter')).toBe(0xff0d);
      expect(keyToKeysym('Return')).toBe(0xff0d);
      expect(keyToKeysym('Backspace')).toBe(0xff08);
      expect(keyToKeysym('Delete')).toBe(0xffff);
    });

    it('maps arrow keys', () => {
      expect(keyToKeysym('ArrowLeft')).toBe(0xff51);
      expect(keyToKeysym('ArrowUp')).toBe(0xff52);
      expect(keyToKeysym('ArrowRight')).toBe(0xff53);
      expect(keyToKeysym('ArrowDown')).toBe(0xff54);
    });

    it('maps navigation keys', () => {
      expect(keyToKeysym('Home')).toBe(0xff50);
      expect(keyToKeysym('End')).toBe(0xff57);
      expect(keyToKeysym('PageUp')).toBe(0xff55);
      expect(keyToKeysym('PageDown')).toBe(0xff56);
      expect(keyToKeysym('Insert')).toBe(0xff63);
    });

    it('maps function keys', () => {
      expect(keyToKeysym('F1')).toBe(0xffbe);
      expect(keyToKeysym('F12')).toBe(0xffc9);
    });

    it('maps modifier keys', () => {
      expect(keyToKeysym('Shift')).toBe(0xffe1);
      expect(keyToKeysym('Control')).toBe(0xffe3);
      expect(keyToKeysym('Alt')).toBe(0xffe9);
      // 이름 표는 keysym 이름 그대로다 — Meta 는 Meta_L, Super 는 Super_L.
      expect(keyToKeysym('Meta')).toBe(0xffe7);
      expect(keyToKeysym('Super')).toBe(0xffeb);
    });

    /**
     * UI 의 "메타" 는 윈도우 키(맥은 Command)를 뜻하고, 그 물리 키는 Super_L 을 낸다. Meta_L 로
     * 보내면 리눅스 데스크톱의 Super 단축키가 하나도 안 먹는다.
     */
    it('메타 수정키는 Super_L 로 나간다', () => {
      expect(MODIFIER_KEYSYMS.meta).toBe(0xffeb);
    });

    it('maps non-Latin-1 Unicode with 0x01000000 prefix', () => {
      // Korean character '가' = U+AC00
      expect(keyToKeysym('가')).toBe(0x01000000 + 0xac00);
    });

    it('returns null for unmappable multi-char strings', () => {
      expect(keyToKeysym('Unidentified')).toBeNull();
      expect(keyToKeysym('')).toBeNull();
    });
  });

  describe('isModifierKey', () => {
    it('returns true for modifier keys', () => {
      expect(isModifierKey('Shift')).toBe(true);
      expect(isModifierKey('Control')).toBe(true);
      expect(isModifierKey('Alt')).toBe(true);
      expect(isModifierKey('Meta')).toBe(true);
      expect(isModifierKey('CapsLock')).toBe(true);
    });

    it('returns false for regular keys', () => {
      expect(isModifierKey('a')).toBe(false);
      expect(isModifierKey('Enter')).toBe(false);
      expect(isModifierKey('Escape')).toBe(false);
    });
  });

  describe('buildKeySequence', () => {
    it('builds simple key press/release', () => {
      const seq = buildKeySequence('a', {});
      expect(seq).toEqual([
        [0x61, true],
        [0x61, false],
      ]);
    });

    it('wraps with Ctrl modifier', () => {
      const seq = buildKeySequence('c', { ctrl: true });
      expect(seq).toEqual([
        [MODIFIER_KEYSYMS.ctrl, true],
        [0x63, true],
        [0x63, false],
        [MODIFIER_KEYSYMS.ctrl, false],
      ]);
    });

    it('wraps with multiple modifiers in correct order', () => {
      const seq = buildKeySequence('a', { ctrl: true, shift: true, alt: true });
      // Down: ctrl, alt, shift. Up: shift, alt, ctrl
      expect(seq[0]).toEqual([MODIFIER_KEYSYMS.ctrl, true]);
      expect(seq[1]).toEqual([MODIFIER_KEYSYMS.alt, true]);
      expect(seq[2]).toEqual([MODIFIER_KEYSYMS.shift, true]);
      expect(seq[3]).toEqual([0x61, true]);
      expect(seq[4]).toEqual([0x61, false]);
      expect(seq[5]).toEqual([MODIFIER_KEYSYMS.shift, false]);
      expect(seq[6]).toEqual([MODIFIER_KEYSYMS.alt, false]);
      expect(seq[7]).toEqual([MODIFIER_KEYSYMS.ctrl, false]);
    });

    it('returns empty for unmappable key', () => {
      const seq = buildKeySequence('Unidentified', {});
      expect(seq).toEqual([]);
    });
  });
});
