import type { AppLanguage } from './models';

// UI 언어 판정 로직. 문구는 담지 않고 규칙만 두므로 데스크톱·모바일이 공유한다 —
// 두 앱이 같은 시스템 언어에서 다른 결론을 내면 안 된다.

// 앱이 지원하는 UI 언어. 한국어 외에는 모두 영어로 떨어뜨린다.
export const APP_LOCALES = ['ko', 'en'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

// 설정 화면에 노출하는 선택지. 'system' 은 OS 언어를 따른다.
export const APP_LANGUAGE_OPTIONS = ['system', 'ko', 'en'] as const;

export const DEFAULT_APP_LOCALE: AppLocale = 'en';

// Intl(날짜·숫자) 포매터에 넘길 BCP 47 태그. UI 언어를 따라야 하는 값이라 OS 로케일이나
// 하드코딩된 'ko-KR' 을 쓰면 안 된다 — 영어 UI 에서 "오전/오후" 가 나오는 원인이었다.
export const INTL_LOCALE_TAGS: Record<AppLocale, string> = {
  ko: 'ko-KR',
  en: 'en-US'
};

// 시스템 언어 태그(예: ko, ko-KR, en-US)를 지원 언어로 정규화한다. 데스크톱 메인은
// app.getLocale(), 렌더러는 메인이 넘긴 값, 모바일은 기기 로케일을 넘긴다.
export function resolveAppLocale(systemLocale: string | null | undefined): AppLocale {
  const normalized = (systemLocale ?? '').trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_APP_LOCALE;
  }
  // 지역 코드는 무시하고 언어만 본다(ko-KR·ko-Kore-KR 모두 한국어).
  const language = normalized.split(/[-_]/)[0];
  return language === 'ko' ? 'ko' : DEFAULT_APP_LOCALE;
}

// 저장된 언어 설정을 정규화한다. 값이 없거나 모르는 값이면 시스템 언어 따르기.
export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === 'ko' || value === 'en' ? value : 'system';
}

// 실제로 적용할 언어. 사용자가 명시적으로 고른 언어가 시스템 언어를 이긴다.
export function resolveEffectiveAppLocale(
  language: AppLanguage | null | undefined,
  systemLocale: string | null | undefined
): AppLocale {
  const preference = normalizeAppLanguage(language);
  return preference === 'system' ? resolveAppLocale(systemLocale) : preference;
}
