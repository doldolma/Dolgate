import { useEffect } from 'react';
import type { AppLanguage } from '@shared';

import { applyRendererLanguage } from '../i18n';

interface LanguageBridgeProps {
  language: AppLanguage | undefined;
}

// 설정의 언어 선택을 i18next 에 반영한다. 설정은 IPC 로 첫 렌더 뒤에 도착하고, 사용자가
// 설정 화면에서 바꿀 때도 여기로 다시 흘러온다.
export function LanguageBridge({ language }: LanguageBridgeProps) {
  useEffect(() => {
    const locale = applyRendererLanguage(language);
    document.documentElement.lang = locale;
  }, [language]);

  return null;
}
