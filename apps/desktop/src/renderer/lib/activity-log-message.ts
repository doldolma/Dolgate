import type { ActivityLogRecord } from '@shared';

type Translate = (key: string, params?: Record<string, unknown>) => string;

// 활동 로그는 영구 저장되므로, 기록된 문구를 그대로 그리면 기록 당시 언어로 굳는다(언어를
// 바꾼 뒤에도 예전 항목만 옛 언어로 남는다). 키가 있으면 현재 언어로 다시 번역하고,
// 키가 없는 예전 기록은 저장된 문구를 그대로 보여준다.
export function resolveLogMessage(log: ActivityLogRecord, translate: Translate): string {
  if (!log.messageKey) {
    return log.message;
  }
  const translated = translate(log.messageKey, log.messageParams ?? undefined);
  // 카탈로그에서 키가 사라지면 i18next 는 키 문자열을 그대로 돌려준다 — 그때는 저장된
  // 문구가 더 쓸 만하다.
  return translated === log.messageKey ? log.message : translated;
}
