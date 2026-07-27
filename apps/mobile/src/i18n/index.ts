import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { AppLanguage } from '@dolssh/shared-core';
import {
  INTL_LOCALE_TAGS,
  resolveEffectiveAppLocale,
  type AppLocale,
} from '@dolssh/shared-core';

import { getDeviceLocale } from './device-locale';
import { I18N_FALLBACK_LOCALE, i18nResources } from './resources';

// 첫 렌더보다 먼저 동기적으로 언어를 정해 문구가 나중에 바뀌며 깜빡이지 않게 한다.
// 저장된 설정(persist)은 하이드레이트 후에 오므로, 그때 applyMobileLanguage 로 맞춘다.
export function initMobileI18n(language?: AppLanguage | null): AppLocale {
  const locale = resolveEffectiveAppLocale(language, getDeviceLocale());
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      lng: locale,
      fallbackLng: I18N_FALLBACK_LOCALE,
      resources: i18nResources,
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
      // RN 에는 Intl.PluralRules 가 없는 환경도 있어 복수형 규칙을 쓰지 않는다.
      compatibilityJSON: 'v4',
    });
  } else if (i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
  return locale;
}

// 설정에서 고른 언어를 반영한다. useTranslation 을 쓰는 화면은 자동으로 다시 그려진다.
export function applyMobileLanguage(language: AppLanguage | null | undefined): AppLocale {
  const locale = resolveEffectiveAppLocale(language, getDeviceLocale());
  if (i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
  return locale;
}

// 지금 적용된 UI 언어. 서버 로그인 페이지에 언어를 실어 보낼 때 쓴다.
export function getAppLocale(): AppLocale {
  return i18next.language === 'ko' ? 'ko' : 'en';
}

// 날짜·숫자 포매터에 넘길 로케일. 렌더 시점에 읽어야 언어를 바꿨을 때 같이 바뀐다.
export function getFormatLocale(): string {
  return INTL_LOCALE_TAGS[i18next.language === 'ko' ? 'ko' : 'en'];
}

// 컴포넌트 밖(스토어·유틸)에서 쓰는 번역 함수. 화면에서는 useTranslation() 을 쓴다.
export const t = i18next.t.bind(i18next);
