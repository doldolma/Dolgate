import { describe, expect, it } from 'vitest';
import {
  convertHangulToQwerty,
  convertQwertyToDubeolsikHangul,
  getKeyboardLayoutSearchQueries,
  matchesKeyboardLayoutQuery,
} from './keyboard-layout-search';

describe('keyboard-layout-search', () => {
  it('converts Korean jamo typed with the wrong IME back to qwerty', () => {
    expect(convertHangulToQwerty('ㅣㅑㅡㄷ')).toBe('lime');
    expect(getKeyboardLayoutSearchQueries('ㅣㅑㅡㄷ')).toContain('lime');
  });

  it('converts qwerty typed with the wrong IME into composed Hangul', () => {
    expect(convertQwertyToDubeolsikHangul('dktks')).toBe('아산');
    expect(getKeyboardLayoutSearchQueries('dktks')).toContain('아산');
  });

  it('adds qwerty variants for composed Hangul queries', () => {
    expect(getKeyboardLayoutSearchQueries('아산')).toContain('dktks');
  });

  it('preserves digits and path punctuation while converting letters', () => {
    expect(getKeyboardLayoutSearchQueries('dktks-01')).toContain('아산-01');
    expect(getKeyboardLayoutSearchQueries('ㅣㅑㅡㄷ-01/api')).toContain('lime-01/api');
  });

  it('treats blank queries as no query variants', () => {
    expect(getKeyboardLayoutSearchQueries('')).toEqual([]);
    expect(getKeyboardLayoutSearchQueries('   ')).toEqual([]);
  });

  it('matches text with keyboard-layout query variants', () => {
    expect(matchesKeyboardLayoutQuery('Lime prod host', 'ㅣㅑㅡㄷ')).toBe(true);
    expect(matchesKeyboardLayoutQuery('아산 bastion', 'dktks')).toBe(true);
  });
});
