import { describe, expect, it } from 'vitest';

import {
  keysymFromCharacter,
  keysymFromEvent,
  keysymsFromComposedText,
} from './keysym';

describe('keysymFromCharacter', () => {
  it('Latin-1 은 코드포인트가 곧 keysym 이다', () => {
    expect(keysymFromCharacter('a')).toBe(0x61);
    expect(keysymFromCharacter('A')).toBe(0x41);
    expect(keysymFromCharacter(' ')).toBe(0x20);
    expect(keysymFromCharacter('~')).toBe(0x7e);
    // 0xff 경계까지가 Latin-1 이다.
    expect(keysymFromCharacter('ÿ')).toBe(0xff);
  });

  it('그 밖의 유니코드는 0x01000000 을 더한다', () => {
    // 한글이 이 규약으로 들어간다. 이걸 틀리면 원격에 엉뚱한 글자가 찍힌다.
    expect(keysymFromCharacter('한')).toBe(0x0100_0000 + 0xd55c);
    expect(keysymFromCharacter('€')).toBe(0x0100_0000 + 0x20ac);
  });
});

describe('keysymFromEvent', () => {
  it('글자 키는 만들어진 글자를 그대로 쓴다', () => {
    // RFB 는 스캔코드가 아니라 keysym 을 받으므로 "무엇이 입력되었는가" 가 기준이다.
    expect(keysymFromEvent({ key: 'a', code: 'KeyA' })).toBe(0x61);
    // Shift 가 이미 반영된 글자가 온다 — 우리가 다시 대문자로 만들 필요가 없다.
    expect(keysymFromEvent({ key: 'A', code: 'KeyA' })).toBe(0x41);
    // 같은 물리 키라도 레이아웃에 따라 다른 글자다. code 를 보면 이걸 틀린다.
    expect(keysymFromEvent({ key: '@', code: 'Digit2' })).toBe(0x40);
  });

  it('기능 키는 X11 keysym 으로 옮긴다', () => {
    expect(keysymFromEvent({ key: 'Enter', code: 'Enter' })).toBe(0xff0d);
    expect(keysymFromEvent({ key: 'Backspace', code: 'Backspace' })).toBe(0xff08);
    expect(keysymFromEvent({ key: 'Escape', code: 'Escape' })).toBe(0xff1b);
    expect(keysymFromEvent({ key: 'ArrowUp', code: 'ArrowUp' })).toBe(0xff52);
    expect(keysymFromEvent({ key: 'F5', code: 'F5' })).toBe(0xffc2);
  });

  // 좌우를 구분해야 원격의 좌우 구분 단축키가 맞는다. key 는 양쪽 모두 "Shift" 다.
  it('조합 키는 좌우를 구분한다', () => {
    expect(keysymFromEvent({ key: 'Shift', code: 'ShiftLeft' })).toBe(0xffe1);
    expect(keysymFromEvent({ key: 'Shift', code: 'ShiftRight' })).toBe(0xffe2);
    expect(keysymFromEvent({ key: 'Control', code: 'ControlLeft' })).toBe(0xffe3);
    expect(keysymFromEvent({ key: 'Control', code: 'ControlRight' })).toBe(0xffe4);
    // macOS 의 오른쪽 Option 은 AltGr 자리로 보낸다.
    expect(keysymFromEvent({ key: 'Alt', code: 'AltRight' })).toBe(0xfe03);
    expect(keysymFromEvent({ key: 'Alt', code: 'AltLeft' })).toBe(0xffe9);
  });

  it('숫자패드 Enter 는 따로 보낸다', () => {
    // 원격 프로그램이 두 Enter 를 구분하는 경우가 있다(계산기·터미널 편집기).
    expect(keysymFromEvent({ key: 'Enter', code: 'NumpadEnter' })).toBe(0xff8d);
  });

  // **조합 중에 키를 보내면 원격에 자모가 그대로 찍힌다.** 완성 글자는 compositionend 로 따로 온다.
  it('IME 조합 중에는 아무것도 보내지 않는다', () => {
    expect(keysymFromEvent({ key: 'ㅎ', code: 'KeyG', isComposing: true })).toBeNull();
    expect(keysymFromEvent({ key: 'Process', code: 'KeyG', isComposing: true })).toBeNull();
  });

  // 우리가 모르는 기능 키를 글자로 오해해 보내면 원격에 엉뚱한 문자가 찍힌다.
  it('이름이 여러 글자인 미지의 키는 보내지 않는다', () => {
    expect(keysymFromEvent({ key: 'Unidentified', code: 'KeyQ' })).toBeNull();
    expect(keysymFromEvent({ key: 'AudioVolumeUp', code: 'AudioVolumeUp' })).toBeNull();
    expect(keysymFromEvent({ key: '' })).toBeNull();
  });

  it('한 글자짜리 비ASCII 는 유니코드 keysym 으로 보낸다', () => {
    expect(keysymFromEvent({ key: '한', code: 'KeyG' })).toBe(0x0100_0000 + 0xd55c);
  });
});

describe('keysymsFromComposedText', () => {
  it('완성된 글자를 글자 단위로 나눈다', () => {
    expect(keysymsFromComposedText('한글')).toEqual([
      0x0100_0000 + 0xd55c,
      0x0100_0000 + 0xae00,
    ]);
  });

  // 서로게이트 쌍을 반으로 쪼개면 원격에 깨진 글자가 간다.
  it('서로게이트 쌍을 쪼개지 않는다', () => {
    const keysyms = keysymsFromComposedText('😀');
    expect(keysyms).toEqual([0x0100_0000 + 0x1f600]);
  });

  it('빈 문자열은 아무것도 만들지 않는다', () => {
    expect(keysymsFromComposedText('')).toEqual([]);
  });
});
