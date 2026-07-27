import type { AppLanguage } from '@shared';

// 앱이 지원하는 UI 언어. 한국어 외에는 모두 영어로 떨어뜨린다.
export const APP_LOCALES = ['ko', 'en'] as const;

// 설정 화면에 노출하는 선택지. 'system' 은 OS 언어를 따른다.
export const APP_LANGUAGE_OPTIONS = ['system', 'ko', 'en'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = 'en';

// 메인이 창을 열 때 렌더러 URL 에 붙이는 로케일 쿼리. 시스템 언어 판정의 단일 출처는
// 메인의 app.getLocale() 이고, 렌더러는 그 결과를 첫 프레임부터 그대로 쓴다.
export const APP_LOCALE_QUERY_PARAM = 'locale';

// URL 쿼리에서 로케일을 읽는다. 값이 없거나 모르는 값이면 null(호출자가 폴백을 정한다).
export function parseAppLocaleParam(search: string | null | undefined): AppLocale | null {
  if (!search) {
    return null;
  }
  const value = new URLSearchParams(search).get(APP_LOCALE_QUERY_PARAM)?.trim();
  return value === 'ko' || value === 'en' ? value : null;
}

// 시스템 언어 태그(예: ko, ko-KR, en-US)를 지원 언어로 정규화한다. 메인 프로세스는
// app.getLocale(), 렌더러는 navigator.language 를 넘겨 같은 판정을 공유한다.
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
