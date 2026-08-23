import { t } from '../../i18n';

/** 블록 UI(툴바 칩·스티키 헤더)가 공유하는 소요시간 표기. */
export function formatBlockDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** "몇 분 전" 표기. 명령 팔레트와 세션 패널 히스토리가 같은 문구를 쓴다. */
export function formatBlockRelativeTime(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 5) {
    return t('cmdPalette.ago.justNow');
  }
  if (seconds < 60) {
    return t('cmdPalette.ago.seconds', { count: seconds });
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t('cmdPalette.ago.minutes', { count: minutes });
  }
  return t('cmdPalette.ago.hours', { count: Math.floor(minutes / 60) });
}
