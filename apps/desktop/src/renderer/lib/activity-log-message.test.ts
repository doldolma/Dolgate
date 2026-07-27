import { describe, expect, it } from 'vitest';
import type { ActivityLogRecord } from '@shared';

import { resolveLogMessage } from './activity-log-message';

function record(overrides: Partial<ActivityLogRecord>): ActivityLogRecord {
  return {
    id: 'log-1',
    level: 'info',
    category: 'audit',
    message: '로그인',
    metadata: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    ...overrides
  };
}

// 활동 로그는 영구 저장된다. 저장된 문구만 그리면 기록 당시 언어로 굳어, 언어를 바꾼 뒤에도
// 예전 항목만 한국어로 남는다(사용자가 실제로 겪은 문제).
describe('resolveLogMessage', () => {
  const translate = (key: string, params?: Record<string, unknown>) =>
    key === 'auth.signedIn'
      ? 'Signed in.'
      : key === 'core.sessionLog'
        ? `${params?.kind} session`
        : key;

  it('키가 있으면 현재 언어로 다시 번역한다', () => {
    expect(resolveLogMessage(record({ messageKey: 'auth.signedIn' }), translate)).toBe(
      'Signed in.'
    );
  });

  it('보간 값도 함께 넘긴다', () => {
    const log = record({
      message: 'SSH 세션',
      messageKey: 'core.sessionLog',
      messageParams: { kind: 'SSH' }
    });
    expect(resolveLogMessage(log, translate)).toBe('SSH session');
  });

  it('키가 없는 예전 기록은 저장된 문구를 그대로 쓴다', () => {
    expect(resolveLogMessage(record({}), translate)).toBe('로그인');
  });

  // 카탈로그에서 키를 지웠을 때 화면에 'auth.signedIn' 같은 키가 노출되면 안 된다.
  it('키가 카탈로그에서 사라지면 저장된 문구로 폴백한다', () => {
    const log = record({ message: '로그인', messageKey: 'auth.removedKey' });
    expect(resolveLogMessage(log, translate)).toBe('로그인');
  });
});
