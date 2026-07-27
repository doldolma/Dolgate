import i18next from 'i18next';
import type { AppLanguage } from '@shared';

import {
  DEFAULT_APP_LOCALE,
  resolveEffectiveAppLocale,
  type AppLocale
} from '../common/i18n/locale';
import { I18N_FALLBACK_LOCALE, i18nResources } from '../common/i18n/resources';

// 시스템 언어는 초기화 때 한 번 받아 둔다 — 이 모듈이 electron 에 의존하지 않게 해
// 메인 프로세스 테스트에서도 electron 목 없이 번역을 초기화할 수 있다.
let cachedSystemLocale: string | null = null;

// 언어가 바뀌면 다시 만들어야 하는 것들(애플리케이션 메뉴)이 구독한다 — 메뉴는 문자열을
// 빌드 시점에 구워 넣으므로 changeLanguage 만으로는 갱신되지 않는다.
const localeChangeListeners = new Set<(locale: AppLocale) => void>();

// 메인 프로세스는 React 없이 코어 i18next 만 쓴다(렌더러는 react-i18next). 카탈로그는
// 렌더러와 동일한 파일을 공유하므로 메뉴·알림·에러 문구가 같은 번역을 따른다.
export function initMainI18n(
  language?: AppLanguage | null,
  systemLocale?: string | null
): AppLocale {
  cachedSystemLocale = systemLocale ?? cachedSystemLocale;
  const locale = resolveEffectiveAppLocale(language, cachedSystemLocale);
  if (!i18next.isInitialized) {
    void i18next.init({
      lng: locale,
      fallbackLng: I18N_FALLBACK_LOCALE,
      resources: i18nResources,
      interpolation: { escapeValue: false }
    });
  } else if (i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
  return locale;
}

export function onMainLocaleChanged(listener: (locale: AppLocale) => void): void {
  localeChangeListeners.add(listener);
}

// 렌더러 창을 열 때 URL 에 실어 보낼 현재 로케일. 렌더러가 navigator.language 로 따로
// 판정하면 시스템 언어 판정이 두 군데로 갈라지므로, 메인의 결과를 그대로 넘긴다.
export function getMainLocale(): AppLocale {
  return i18next.language === 'ko' ? 'ko' : DEFAULT_APP_LOCALE;
}

// 설정에서 언어를 바꿨을 때 호출한다. 실제로 바뀌었으면 true.
export function applyMainLanguage(language: AppLanguage | null | undefined): boolean {
  const locale = resolveEffectiveAppLocale(language, cachedSystemLocale);
  if (i18next.language === locale) {
    return false;
  }
  void i18next.changeLanguage(locale);
  for (const listener of localeChangeListeners) {
    listener(locale);
  }
  return true;
}

export const t = i18next.t.bind(i18next);
