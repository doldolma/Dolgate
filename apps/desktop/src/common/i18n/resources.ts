import en from './locales/en.json';
import ko from './locales/ko.json';

import type { AppLocale } from './locale';

// 카탈로그는 번들에 포함되므로 런타임 파일 로딩이 필요 없다(메인·렌더러 양쪽 Vite 번들).
// 한국어가 원문이고 영어는 번역본이라, 영어에 없는 키는 한국어로 폴백한다.
export const i18nResources: Record<AppLocale, { translation: Record<string, unknown> }> = {
  ko: { translation: ko },
  en: { translation: en }
};

export const I18N_FALLBACK_LOCALE: AppLocale = 'ko';
