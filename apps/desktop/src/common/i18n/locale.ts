import type { AppLocale } from '@shared';

// 언어 판정 규칙은 모바일과 공유한다(packages/shared-core/src/locale.ts) — 같은 시스템
// 언어에서 두 앱이 다른 결론을 내면 안 된다. 여기에는 데스크톱 전용 배선만 둔다.
export {
  APP_LANGUAGE_OPTIONS,
  APP_LOCALES,
  DEFAULT_APP_LOCALE,
  INTL_LOCALE_TAGS,
  normalizeAppLanguage,
  resolveAppLocale,
  resolveEffectiveAppLocale,
  type AppLocale
} from '@shared';

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
