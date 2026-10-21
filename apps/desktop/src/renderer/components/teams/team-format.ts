import type { TeamMember } from '@shared';
import { getFormatLocale } from '../../i18n';

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * 팀 표시에 쓰는 머리글자 — 앞 두 낱말의 첫 글자. 서버의 링크 페이지(`teamMarkOf`)와 같은 규칙이라
 * 브라우저에서 본 표시와 앱의 표시가 같다.
 */
export function teamMarkOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const mark = words.map((word) => Array.from(word)[0] ?? '').join('');
  return mark.toLocaleUpperCase() || '?';
}

/**
 * 지금에서 얼마나 떨어졌는지 — "어제", "2시간 전", "7일 후". 일주일이 넘으면 날짜("10월 19일")로 쓴다.
 * 정확한 때는 툴팁(`formatExactTime`)으로 본다.
 */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return iso;
  }
  const locale = getFormatLocale();
  const seconds = Math.round((timestamp - now) / 1000);
  const distance = Math.abs(seconds);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (distance < MINUTE_SECONDS) {
    return relative.format(0, 'second');
  }
  // 반올림한 값으로 단위를 고른다 — 그렇지 않으면 막 만든 1일짜리 링크가 "24시간 후"가 된다.
  const minutes = Math.round(seconds / MINUTE_SECONDS);
  if (Math.abs(minutes) < 60) {
    return relative.format(minutes, 'minute');
  }
  const hours = Math.round(seconds / HOUR_SECONDS);
  if (Math.abs(hours) < 24) {
    return relative.format(hours, 'hour');
  }
  const days = Math.round(seconds / DAY_SECONDS);
  // 7일까지는 상대로 — 기본 기한(7일)으로 막 만든 링크가 "7일 후 만료"로 읽히게.
  if (Math.abs(days) <= 7) {
    return relative.format(days, 'day');
  }
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(timestamp);
}

export function formatExactTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return iso;
  }
  return new Intl.DateTimeFormat(getFormatLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

/** 표 안에서 사람을 짧게 부르는 이름 — 이메일의 @ 앞. */
export function shortNameOf(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/** 멤버 줄의 머리글자 네모. */
export function memberMarkOf(email: string): string {
  return (Array.from(email.trim())[0] ?? '?').toLocaleUpperCase();
}

/** 나는 누구인가 — 계정 id 로 찾고, 없으면 이메일로 찾는다. */
export function isCurrentMember(
  member: TeamMember,
  currentUserId: string | null,
  currentUserEmail: string | null,
): boolean {
  if (currentUserId) {
    return member.userId === currentUserId;
  }
  return Boolean(currentUserEmail) && member.email.toLowerCase() === currentUserEmail!.toLowerCase();
}
