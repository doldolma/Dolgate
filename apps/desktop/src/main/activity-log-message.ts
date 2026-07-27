import { t } from './i18n';

// 활동 로그는 영구 저장된다. 완성된 문구만 넣으면 기록 당시 언어로 굳어 버려서, 나중에 UI
// 언어를 바꿔도 목록이 그대로 남고(심하면 한 목록에 두 언어가 섞인다) 되돌릴 방법이 없다.
// 그래서 번역 키와 보간 값을 함께 저장하고, 화면은 렌더 시점에 다시 번역한다.
//
// message 도 같이 저장한다 — messageKey 가 없는 예전 기록과, 키가 카탈로그에서 사라진
// 경우의 폴백이다.
export interface ActivityLogMessage {
  message: string;
  messageKey: string;
  messageParams?: Record<string, unknown> | null;
}

export function logMessage(
  key: string,
  params?: Record<string, unknown>
): ActivityLogMessage {
  return {
    message: t(key, params ?? undefined),
    messageKey: key,
    messageParams: params ?? null
  };
}
