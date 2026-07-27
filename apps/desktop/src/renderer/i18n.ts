import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { AppLanguage } from '@shared';

import {
  INTL_LOCALE_TAGS,
  parseAppLocaleParam,
  resolveEffectiveAppLocale,
  type AppLocale
} from '../common/i18n/locale';
import { I18N_FALLBACK_LOCALE, i18nResources } from '../common/i18n/resources';

// 언어 선택은 메인의 설정 파일에 저장되지만 그 값은 IPC 로 첫 렌더 뒤에 도착한다. 마지막
// 선택을 localStorage 에도 남겨 다음 실행의 첫 프레임부터 올바른 언어로 그린다.
const STORED_LANGUAGE_KEY = 'dolgate.language';

// 첫 렌더 전에 동기적으로 언어를 정한다 — 우선순위는
//   ① 사용자가 고른 언어(localStorage 에 미러링된 설정값)
//   ② 메인이 URL 로 넘긴 로케일 — 시스템 언어 판정의 단일 출처는 메인의 app.getLocale()
//   ③ navigator.language — 쿼리가 없는 경우(테스트·직접 로드)의 마지막 폴백
// 판정 로직 자체는 메인과 공유한다(resolveEffectiveAppLocale).
export function initRendererI18n(systemLocale?: string | null): AppLocale {
  const localeFromMain = parseAppLocaleParam(globalThis.location?.search);
  const locale = resolveEffectiveAppLocale(
    readStoredLanguage(),
    systemLocale ?? localeFromMain ?? globalThis.navigator?.language
  );
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      lng: locale,
      fallbackLng: I18N_FALLBACK_LOCALE,
      resources: i18nResources,
      interpolation: { escapeValue: false },
      react: { useSuspense: false }
    });
  } else if (i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
  return locale;
}

// 설정에서 고른 언어를 반영한다. useTranslation 을 쓰는 컴포넌트는 자동으로 다시 그려진다.
export function applyRendererLanguage(language: AppLanguage | null | undefined): AppLocale {
  const locale = resolveEffectiveAppLocale(language, globalThis.navigator?.language);
  rememberLanguage(language);
  if (i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
  return locale;
}

function readStoredLanguage(): AppLanguage | null {
  try {
    const stored = globalThis.localStorage?.getItem(STORED_LANGUAGE_KEY);
    return stored === 'ko' || stored === 'en' || stored === 'system' ? stored : null;
  } catch {
    return null;
  }
}

function rememberLanguage(language: AppLanguage | null | undefined): void {
  try {
    globalThis.localStorage?.setItem(STORED_LANGUAGE_KEY, language ?? 'system');
  } catch {
    // 저장 실패는 무시한다 — 다음 실행의 첫 프레임만 시스템 언어로 시작할 뿐이다.
  }
}

// 날짜·숫자 포매터(Intl, toLocaleString)에 넘길 로케일. 렌더 시점에 읽어야 언어를 바꿨을
// 때 같이 바뀐다 — 모듈 최상위에서 포매터를 만들어 두면 안 된다.
export function getFormatLocale(): string {
  return INTL_LOCALE_TAGS[i18next.language === 'ko' ? 'ko' : 'en'];
}

// 컴포넌트 밖(순수 함수·유틸)에서 쓰는 번역 함수. 컴포넌트에서는 useTranslation() 을 쓴다.
export const t = i18next.t.bind(i18next);
