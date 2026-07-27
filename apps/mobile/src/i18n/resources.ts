import en from './locales/en.json';
import ko from './locales/ko.json';

// 모바일은 자체 카탈로그를 갖는다 — 데스크톱 카탈로그(2,300키)와 겹치는 문구가 거의 없어
// 공유하면 번들만 커진다. shared-core 가 코드로 돌려주는 문구는 양쪽이 각자 매핑한다.
export const i18nResources = {
  ko: { translation: ko },
  en: { translation: en }
} as const;

// 한국어가 원문이다 — 영어 번역이 빠진 키는 빈칸이 아니라 한국어가 보인다.
export const I18N_FALLBACK_LOCALE = 'ko';
