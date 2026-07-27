import type { CommandNotificationSettings } from '@shared';
import { t } from '../i18n';

/** OSC 133 C→D 경계에서 관측한, 방금 끝난 명령의 정보. */
export interface CommandFinishedInfo {
  /** 실행된 명령 텍스트(추적 가능한 경우). 모르면 null. */
  command: string | null;
  /** OSC 133;D의 종료 코드. 파싱 못 하면 null. */
  exitCode: number | null;
  /** C→D 사이 소요 시간(ms). 시작 시각을 못 잡았으면 null. */
  durationMs: number | null;
}

export interface CommandNotificationDecisionInput extends CommandFinishedInfo {
  /**
   * 지금 사용자가 이 명령의 출력을 보고 있는지(앱 포커스 + 해당 세션이 활성 탭).
   * true면 굳이 알림을 띄울 필요가 없다.
   */
  visibleToUser: boolean;
}

function isFailure(exitCode: number | null): boolean {
  return exitCode !== null && exitCode !== 0;
}

/**
 * 방금 끝난 명령에 대해 알림을 띄울지 결정한다. "오래 걸렸거나 실패했고, 사용자가
 * 보고 있지 않을 때"가 기본 정책이다.
 */
export function shouldNotifyCommandFinished(
  settings: CommandNotificationSettings,
  input: CommandNotificationDecisionInput
): boolean {
  if (!settings.commandNotificationsEnabled) {
    return false;
  }
  // 사용자가 해당 출력을 지금 보고 있으면(앱 포커스 + 활성 탭) 알리지 않는다.
  if (settings.commandNotificationOnlyWhenUnfocused && input.visibleToUser) {
    return false;
  }
  // 실패는 시간과 무관하게 알린다(옵션이 켜진 경우).
  if (settings.commandNotificationOnFailure && isFailure(input.exitCode)) {
    return true;
  }
  // 임계 시간 이상 걸린 명령만 알린다.
  if (input.durationMs !== null) {
    const thresholdMs = settings.commandNotificationThresholdSeconds * 1000;
    if (input.durationMs >= thresholdMs) {
      return true;
    }
  }
  return false;
}

/** ms를 "30초" / "2분 31초" / "1시간 5분" 식의 한국어 문자열로 만든다. */
export function formatCommandDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return t('cmdNotify.seconds', { seconds: totalSeconds });
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0
      ? t('cmdNotify.minutesSeconds', { minutes, seconds })
      : t('cmdNotify.minutes', { minutes });
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? t('cmdNotify.hoursMinutes', { hours, minutes: remainingMinutes })
    : t('cmdNotify.hours', { hours });
}

export interface CommandNotificationContent {
  title: string;
  body: string;
}

export interface CommandNotificationFormatInput extends CommandFinishedInfo {
  /** 호스트 라벨(로컬 셸 등 없으면 빈 문자열). */
  hostLabel: string;
}

/**
 * 알림 제목/본문을 구성한다. 제목은 호스트, 본문은 "명령 · 상태 · 소요시간".
 */
export function formatCommandNotification(
  input: CommandNotificationFormatInput
): CommandNotificationContent {
  const failed = isFailure(input.exitCode);
  const statusText = failed
    ? t('cmdNotify.failed', { code: input.exitCode })
    : t('cmdNotify.completed');
  const durationPart = formatCommandDuration(input.durationMs);
  const commandText = input.command?.trim() ?? '';

  const headline = commandText || statusText;
  const detailSegments: string[] = [];
  if (commandText) {
    // 명령어가 headline이면 상태는 뒤에 붙인다.
    detailSegments.push(statusText);
  }
  if (durationPart) {
    detailSegments.push(durationPart);
  }
  const body = detailSegments.length
    ? `${headline} · ${detailSegments.join(' · ')}`
    : headline;

  const title = input.hostLabel.trim() || t('cmdNotify.fallbackTitle');
  return { title, body };
}
