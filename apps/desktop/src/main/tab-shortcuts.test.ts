import { describe, expect, it } from 'vitest';
import {
  matchCloseActiveTab,
  matchTabCommand,
  type TabShortcutInput
} from './tab-shortcuts';

function keyDown(overrides: Partial<TabShortcutInput>): TabShortcutInput {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    control: true,
    alt: false,
    meta: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides
  };
}

describe('matchTabCommand', () => {
  it('maps Ctrl+Tab and Ctrl+Shift+Tab to next/prev cycling', () => {
    expect(matchTabCommand(keyDown({ key: 'Tab', code: 'Tab' }))).toEqual({
      kind: 'next'
    });
    expect(
      matchTabCommand(keyDown({ key: 'Tab', code: 'Tab', shift: true }))
    ).toEqual({ kind: 'prev' });
  });

  it('keeps cycling while the chord is held (autorepeat)', () => {
    expect(
      matchTabCommand(keyDown({ key: 'Tab', code: 'Tab', isAutoRepeat: true }))
    ).toEqual({ kind: 'next' });
  });

  it('maps Ctrl+1..8 to index jumps and Ctrl+9 to the last tab', () => {
    expect(matchTabCommand(keyDown({ key: '1', code: 'Digit1' }))).toEqual({
      kind: 'index',
      index: 1
    });
    expect(matchTabCommand(keyDown({ key: '8', code: 'Digit8' }))).toEqual({
      kind: 'index',
      index: 8
    });
    expect(matchTabCommand(keyDown({ key: '9', code: 'Digit9' }))).toEqual({
      kind: 'last'
    });
  });

  it('matches digits by physical key on layouts where the top row is shifted (AZERTY)', () => {
    expect(matchTabCommand(keyDown({ key: '&', code: 'Digit1' }))).toEqual({
      kind: 'index',
      index: 1
    });
  });

  it('accepts numpad digits only when NumLock resolves them to digits', () => {
    expect(matchTabCommand(keyDown({ key: '4', code: 'Numpad4' }))).toEqual({
      kind: 'index',
      index: 4
    });
    // NumLock 꺼짐: Numpad1 은 End 로 풀리므로 페이지(터미널 스크롤 등) 몫.
    expect(matchTabCommand(keyDown({ key: 'End', code: 'Numpad1' }))).toBeNull();
  });

  it('maps Ctrl+Shift+T to reopen but ignores autorepeat', () => {
    expect(
      matchTabCommand(keyDown({ key: 'T', code: 'KeyT', shift: true }))
    ).toEqual({ kind: 'reopen' });
    expect(
      matchTabCommand(
        keyDown({ key: 'T', code: 'KeyT', shift: true, isAutoRepeat: true })
      )
    ).toBeNull();
  });

  it('leaves every other chord to the page', () => {
    // ctrl 없음 / alt(AltGr) / meta 조합, keyUp 은 전부 통과.
    expect(
      matchTabCommand(keyDown({ key: 'Tab', code: 'Tab', control: false }))
    ).toBeNull();
    expect(
      matchTabCommand(keyDown({ key: 'Tab', code: 'Tab', alt: true }))
    ).toBeNull();
    expect(
      matchTabCommand(keyDown({ key: 'Tab', code: 'Tab', meta: true }))
    ).toBeNull();
    expect(
      matchTabCommand(keyDown({ type: 'keyUp', key: 'Tab', code: 'Tab' }))
    ).toBeNull();
    // Ctrl+W 는 tabCommand 가 아니라 별도 closeActiveTab 채널 몫이다.
    expect(matchTabCommand(keyDown({ key: 'w', code: 'KeyW' }))).toBeNull();
    // shift 없는 Ctrl+T, shift 붙은 숫자(Ctrl+Shift+1)는 탭 명령이 아니다.
    expect(matchTabCommand(keyDown({ key: 't', code: 'KeyT' }))).toBeNull();
    expect(
      matchTabCommand(keyDown({ key: '!', code: 'Digit1', shift: true }))
    ).toBeNull();
    expect(matchTabCommand(keyDown({ key: '0', code: 'Digit0' }))).toBeNull();
  });
});

describe('matchCloseActiveTab', () => {
  it('maps Ctrl+W to closing the active tab (Chrome-style)', () => {
    expect(matchCloseActiveTab(keyDown({ key: 'w', code: 'KeyW' }))).toBe(true);
  });

  it('leaves Ctrl+Shift+W to the window-close accelerator', () => {
    expect(
      matchCloseActiveTab(keyDown({ key: 'W', code: 'KeyW', shift: true }))
    ).toBe(false);
  });

  it('ignores autorepeat so holding the chord cannot close a pile of sessions', () => {
    expect(
      matchCloseActiveTab(keyDown({ key: 'w', code: 'KeyW', isAutoRepeat: true }))
    ).toBe(false);
  });

  it('leaves other modifier combos and keyUp to the page', () => {
    expect(
      matchCloseActiveTab(keyDown({ key: 'w', code: 'KeyW', control: false }))
    ).toBe(false);
    expect(
      matchCloseActiveTab(keyDown({ key: 'w', code: 'KeyW', alt: true }))
    ).toBe(false);
    expect(
      matchCloseActiveTab(keyDown({ key: 'w', code: 'KeyW', meta: true }))
    ).toBe(false);
    expect(
      matchCloseActiveTab(keyDown({ type: 'keyUp', key: 'w', code: 'KeyW' }))
    ).toBe(false);
  });
});
