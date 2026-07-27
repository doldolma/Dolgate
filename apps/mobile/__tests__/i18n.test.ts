import i18next from 'i18next';

import { applyMobileLanguage, getFormatLocale, t } from '../src/i18n';
import { formatRelativeTime } from '../src/lib/mobile';
import en from '../src/i18n/locales/en.json';
import ko from '../src/i18n/locales/ko.json';

// 테스트 전체는 jest.setup.js 에서 한국어로 고정된다. 여기서만 영어로 바꿔
// 두 카탈로그가 실제로 연결됐는지 확인하고 되돌린다.
afterEach(() => {
  applyMobileLanguage('ko');
});

describe('모바일 i18n', () => {
  it('기본은 한국어 원문을 그대로 돌려준다', () => {
    expect(i18next.language).toBe('ko');
    expect(t('common.cancel')).toBe('취소');
  });

  it('설정에서 고른 언어를 적용한다', () => {
    expect(applyMobileLanguage('en')).toBe('en');
    expect(i18next.language).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
  });

  it('날짜·숫자 로케일이 UI 언어를 따라간다', () => {
    applyMobileLanguage('ko');
    expect(getFormatLocale()).toBe('ko-KR');
    applyMobileLanguage('en');
    expect(getFormatLocale()).toBe('en-US');
  });

  it('영어 번역이 없는 키는 한국어로 폴백한다', () => {
    expect(i18next.options.fallbackLng).toContain('ko');
  });

  // 문구를 모듈 최상위 상수에 담으면 i18n 초기화 전에 굳어 언어를 바꿔도 그대로 남는다.
  // 상대 시간처럼 유틸이 만드는 문구도 호출 시점에 번역되는지 확인한다.
  it('유틸이 만드는 문구도 바꾼 언어를 따라간다', () => {
    const anHourAgo = new Date(Date.now() - 90 * 60_000).toISOString();

    applyMobileLanguage('ko');
    expect(formatRelativeTime(anHourAgo)).toBe('1시간 전');
    applyMobileLanguage('en');
    expect(formatRelativeTime(anHourAgo)).toBe('1h ago');
  });
});

// 데스크톱과 같은 규칙으로 카탈로그를 지킨다 — 한쪽에만 키가 추가되거나 번역을 잊는
// 실수는 런타임에 빈칸으로만 드러나서 테스트로 막는 편이 낫다.
describe('번역 카탈로그', () => {
  const flatten = (value: unknown, prefix = ''): string[] => {
    if (typeof value !== 'object' || value === null) {
      return [prefix];
    }
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key),
    );
  };

  const resolve = (catalog: unknown, key: string): string =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown>)?.[part],
        catalog,
      ) as string;

  it('한국어와 영어 키가 일치한다', () => {
    expect(flatten(en).sort()).toEqual(flatten(ko).sort());
  });

  it('빈 문자열인 번역이 없다', () => {
    const empties = Object.entries({ ko, en }).flatMap(([locale, catalog]) =>
      flatten(catalog)
        .filter((key) => {
          const resolved = resolve(catalog, key);
          return typeof resolved !== 'string' || resolved.trim().length === 0;
        })
        .map((key) => `${locale}:${key}`),
    );
    expect(empties).toEqual([]);
  });

  it('영어 카탈로그에 한글이 남아 있지 않다', () => {
    // 언어 이름("한국어")은 카탈로그가 아니라 SettingsScreen 의 LANGUAGE_LABELS 에 있다 —
    // 그 언어로 적어야 하므로 번역 대상이 아니다.
    const leaked = flatten(en).filter((key) => /[가-힣]/.test(resolve(en, key)));
    expect(leaked).toEqual([]);
  });

  it('보간 변수가 두 언어에서 같다', () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const mismatched = flatten(ko).filter(
      (key) =>
        placeholders(resolve(ko, key)).join(',') !==
        placeholders(resolve(en, key)).join(','),
    );
    expect(mismatched).toEqual([]);
  });
});
