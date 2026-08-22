import {
  characterToRdpKeystroke,
  keyToRdpScancode,
  RDP_MODIFIER_SCANCODES,
  textToUnicodeCodepoints,
} from '../src/lib/rdp-keyboard';

describe('RDP keyboard mapping', () => {
  it('uses PS/2 set-1 scancodes and the 0xE000 extended convention', () => {
    expect(keyToRdpScancode('Escape')).toBe(0x01);
    expect(keyToRdpScancode('Enter')).toBe(0x1c);
    expect(keyToRdpScancode('F12')).toBe(0x58);
    expect(keyToRdpScancode('ArrowUp')).toBe(0xe048);
    expect(keyToRdpScancode('Delete')).toBe(0xe053);
    expect(RDP_MODIFIER_SCANCODES).toEqual({
      ctrl: 0x1d,
      shift: 0x2a,
      alt: 0x38,
      meta: 0xe05b,
    });
  });

  it('maps printable shortcut keys independently of letter case', () => {
    expect(keyToRdpScancode('c')).toBe(0x2e);
    expect(keyToRdpScancode('C')).toBe(0x2e);
    expect(keyToRdpScancode('1')).toBe(0x02);
    expect(keyToRdpScancode('한')).toBeNull();
  });

  it('iterates Unicode scalar values rather than UTF-16 surrogate halves', () => {
    expect(textToUnicodeCodepoints('A한😀')).toEqual([0x41, 0xd55c, 0x1f600]);
  });
});

describe('characterToRdpKeystroke', () => {
  /**
   * 유니코드 입력이 규격상 더 깔끔하지만 실측에서 이 서버가 반응하지 않았다 — 같은 세션에서
   * 스캔코드로 보낸 Tab 은 즉시 동작했다. 그래서 매핑이 있는 문자는 스캔코드로 보낸다.
   */
  it('소문자는 shift 없이 그 키의 스캔코드다', () => {
    expect(characterToRdpKeystroke('a')).toEqual({ scancode: 0x1e, shift: false });
    expect(characterToRdpKeystroke('1')).toEqual({ scancode: 0x02, shift: false });
    expect(characterToRdpKeystroke(' ')).toEqual({ scancode: 0x39, shift: false });
  });

  // 스캔코드는 문자가 아니라 **키의 물리 위치**다. 대문자는 같은 키 + Shift 다.
  it('대문자는 같은 키에 shift 를 붙인다', () => {
    expect(characterToRdpKeystroke('A')).toEqual({ scancode: 0x1e, shift: true });
    expect(characterToRdpKeystroke('Z')).toEqual(
      characterToRdpKeystroke('z') && { scancode: 0x2c, shift: true },
    );
  });

  it('shift 로만 나오는 기호는 원래 키 + shift 로 바꾼다', () => {
    expect(characterToRdpKeystroke('!')).toEqual({ scancode: 0x02, shift: true });
    expect(characterToRdpKeystroke('?')).toEqual({ scancode: 0x35, shift: true });
    expect(characterToRdpKeystroke(':')).toEqual({ scancode: 0x27, shift: true });
  });

  // 매핑이 없으면 호출부가 유니코드로 넘긴다. null 이 그 신호다.
  it('매핑이 없는 문자는 null 이다', () => {
    expect(characterToRdpKeystroke('한')).toBeNull();
    expect(characterToRdpKeystroke('€')).toBeNull();
    expect(characterToRdpKeystroke('ab')).toBeNull();
  });
});
