import { describe, expect, it } from 'vitest';

import en from './locales/en.json';
import ko from './locales/ko.json';
import {
  DEFAULT_APP_LOCALE,
  normalizeAppLanguage,
  parseAppLocaleParam,
  resolveAppLocale,
  resolveEffectiveAppLocale
} from './locale';

describe('resolveAppLocale', () => {
  it('시스템 언어가 한국어면 한국어를 쓴다', () => {
    for (const systemLocale of ['ko', 'ko-KR', 'KO-kr', 'ko_KR', 'ko-Kore-KR']) {
      expect(resolveAppLocale(systemLocale)).toBe('ko');
    }
  });

  it('그 외 언어는 영어로 떨어뜨린다', () => {
    for (const systemLocale of ['en', 'en-US', 'ja-JP', 'zh-CN', 'de']) {
      expect(resolveAppLocale(systemLocale)).toBe('en');
    }
  });

  it('값이 없으면 기본 언어를 쓴다', () => {
    expect(resolveAppLocale(undefined)).toBe(DEFAULT_APP_LOCALE);
    expect(resolveAppLocale(null)).toBe(DEFAULT_APP_LOCALE);
    expect(resolveAppLocale('   ')).toBe(DEFAULT_APP_LOCALE);
  });
});

describe('normalizeAppLanguage', () => {
  it('아는 언어만 그대로 두고 나머지는 시스템 따르기로 본다', () => {
    expect(normalizeAppLanguage('ko')).toBe('ko');
    expect(normalizeAppLanguage('en')).toBe('en');
    for (const value of ['system', 'ja', '', null, undefined, 42, {}]) {
      expect(normalizeAppLanguage(value)).toBe('system');
    }
  });
});

describe('resolveEffectiveAppLocale', () => {
  it('사용자가 고른 언어가 시스템 언어를 이긴다', () => {
    expect(resolveEffectiveAppLocale('en', 'ko-KR')).toBe('en');
    expect(resolveEffectiveAppLocale('ko', 'en-US')).toBe('ko');
  });

  it("'system' 이거나 값이 없으면 시스템 언어를 따른다", () => {
    expect(resolveEffectiveAppLocale('system', 'ko-KR')).toBe('ko');
    expect(resolveEffectiveAppLocale('system', 'ja-JP')).toBe('en');
    expect(resolveEffectiveAppLocale(undefined, 'ko')).toBe('ko');
    expect(resolveEffectiveAppLocale(null, 'de')).toBe('en');
  });
});

// 시스템 언어 판정의 단일 출처는 메인이고, 렌더러는 URL 쿼리로 그 결과를 받는다.
describe('parseAppLocaleParam', () => {
  it('메인이 넘긴 로케일을 읽는다', () => {
    expect(parseAppLocaleParam('?locale=ko')).toBe('ko');
    expect(parseAppLocaleParam('?window=session-replay&locale=en')).toBe('en');
  });

  it('없거나 모르는 값이면 null 을 돌려준다(호출자가 폴백을 정한다)', () => {
    for (const search of ['', null, undefined, '?locale=', '?locale=ja', '?window=main']) {
      expect(parseAppLocaleParam(search)).toBeNull();
    }
  });
});

// 이관이 진행되는 동안 한쪽 카탈로그에만 키가 추가되는 실수를 막는다.
describe('번역 카탈로그', () => {
  const flatten = (value: unknown, prefix = ''): string[] => {
    if (typeof value !== 'object' || value === null) {
      return [prefix];
    }
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key)
    );
  };

  it('한국어와 영어 키가 일치한다', () => {
    expect(flatten(en).sort()).toEqual(flatten(ko).sort());
  });

  it('빈 문자열인 번역이 없다', () => {
    const empties = Object.entries({ ko, en }).flatMap(([locale, catalog]) =>
      flatten(catalog).filter((key) => {
        const resolved = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog);
        return typeof resolved !== 'string' || resolved.trim().length === 0;
      }).map((key) => `${locale}:${key}`)
    );
    expect(empties).toEqual([]);
  });

  const resolve = (catalog: unknown, key: string): string =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog) as string;

  // 한국어 원문을 복사해 두고 번역을 잊는 실수를 막는다.
  it('영어 카탈로그에 한글이 남아 있지 않다', () => {
    const leaked = flatten(en).filter((key) => /[가-힣]/.test(resolve(en, key)));
    expect(leaked).toEqual([]);
  });

  // 한쪽에만 {{변수}} 가 있으면 그 자리가 런타임에 빈칸으로 나온다.
  it('보간 변수가 두 언어에서 같다', () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const mismatched = flatten(ko).filter(
      (key) =>
        placeholders(resolve(ko, key)).join(',') !== placeholders(resolve(en, key)).join(',')
    );
    expect(mismatched).toEqual([]);
  });
});
