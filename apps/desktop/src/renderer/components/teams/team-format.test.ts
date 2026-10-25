import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './team-format';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('rounds before picking the unit, so a fresh one-day link reads as tomorrow', () => {
    expect(formatRelativeTime(at(DAY - 5), NOW)).toBe('내일');
    expect(formatRelativeTime(at(HOUR - 5), NOW)).toBe('1시간 후');
    expect(formatRelativeTime(at(-30), NOW)).toBe('지금');
  });

  it('keeps a seven-day link relative and turns older ones into dates', () => {
    expect(formatRelativeTime(at(7 * DAY - 5), NOW)).toBe('7일 후');
    expect(formatRelativeTime(at(-2 * DAY), NOW)).toBe('그저께');
    expect(formatRelativeTime(at(-9 * DAY), NOW)).toBe('10월 11일');
  });
});
