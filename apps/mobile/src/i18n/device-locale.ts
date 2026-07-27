import { NativeModules, Platform } from 'react-native';

// 기기 언어를 읽는다. react-native-localize 같은 네이티브 의존을 추가하지 않으려고
// Hermes 의 Intl 을 먼저 쓰고, 없으면 RN 이 이미 노출하는 네이티브 설정으로 떨어진다.
//
// 여기서 반환하는 값은 'ko-KR' 처럼 BCP 47 태그이고, 지원 언어 판정은 shared-core 의
// resolveAppLocale 이 담당한다(데스크톱과 같은 규칙).
export function getDeviceLocale(): string | null {
  const fromIntl = readIntlLocale();
  if (fromIntl) {
    return fromIntl;
  }
  return readNativeLocale();
}

function readIntlLocale(): string | null {
  try {
    const resolved = Intl?.DateTimeFormat?.().resolvedOptions?.().locale;
    return typeof resolved === 'string' && resolved.trim() ? resolved : null;
  } catch {
    return null;
  }
}

function readNativeLocale(): string | null {
  try {
    if (Platform.OS === 'ios') {
      const settings = NativeModules.SettingsManager?.settings;
      const value = settings?.AppleLocale ?? settings?.AppleLanguages?.[0];
      return typeof value === 'string' && value.trim() ? value : null;
    }
    if (Platform.OS === 'android') {
      const value = NativeModules.I18nManager?.localeIdentifier;
      return typeof value === 'string' && value.trim() ? value : null;
    }
  } catch {
    return null;
  }
  return null;
}
