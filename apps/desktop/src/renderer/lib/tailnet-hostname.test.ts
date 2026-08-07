import { describe, expect, it } from 'vitest';
import { isTailnetHostnameExact, normalizeTailnetHostname } from './tailnet-hostname';

// 입력한 것과 기기 목록에 보이는 것이 다르면 그 자체로 버그처럼 보인다. 컨트롤 플레인이
// 어차피 다듬으므로, 같은 규칙을 먼저 적용해 무엇으로 등록될지 미리 보여 준다.
describe('normalizeTailnetHostname', () => {
  it('leaves an already valid name alone', () => {
    expect(normalizeTailnetHostname('dolgate-macbook')).toBe('dolgate-macbook');
    expect(normalizeTailnetHostname('  work-laptop  ')).toBe('work-laptop');
    expect(normalizeTailnetHostname('mac1')).toBe('mac1');
  });

  it('turns separators into single hyphens', () => {
    expect(normalizeTailnetHostname('my laptop')).toBe('my-laptop');
    expect(normalizeTailnetHostname('MacBook-Pro.local')).toBe('MacBook-Pro-local');
    expect(normalizeTailnetHostname('a__b')).toBe('a-b');
    expect(normalizeTailnetHostname('a   b')).toBe('a-b');
  });

  it('trims to alphanumeric boundaries', () => {
    expect(normalizeTailnetHostname('-lead')).toBe('lead');
    expect(normalizeTailnetHostname('trail-')).toBe('trail');
    expect(normalizeTailnetHostname('...mid...')).toBe('mid');
  });

  // 한글로 이름을 지으면 남는 글자가 없다. 그때는 빈 문자열이고, 호출부가 기본값으로 되돌린다.
  it('drops characters that are not allowed', () => {
    expect(normalizeTailnetHostname('내-노트북')).toBe('');
    expect(normalizeTailnetHostname('mac북')).toBe('mac');
    expect(normalizeTailnetHostname('!!!')).toBe('');
    expect(normalizeTailnetHostname('')).toBe('');
  });

  it('never exceeds a DNS label', () => {
    expect(normalizeTailnetHostname('a'.repeat(80))).toHaveLength(63);
  });

  // 잘라낸 자리에 하이픈이 남으면 라벨 규칙을 어긴다.
  it('does not leave a trailing hyphen after dropping characters', () => {
    expect(normalizeTailnetHostname('mac-한')).toBe('mac');
    expect(normalizeTailnetHostname(`${'a'.repeat(62)}-b`)).toBe('a'.repeat(62));
  });
});

describe('isTailnetHostnameExact', () => {
  it('is true only when the input registers unchanged', () => {
    expect(isTailnetHostnameExact('work-laptop')).toBe(true);
    expect(isTailnetHostnameExact('my laptop')).toBe(false);
    expect(isTailnetHostnameExact('')).toBe(false);
    expect(isTailnetHostnameExact('   ')).toBe(false);
  });
});
