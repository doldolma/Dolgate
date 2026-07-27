import { utf8ToBytes } from '@noble/ciphers/utils.js';

export type AccountPasswordState = 'unset' | 'set' | 'unavailable';

// 문구가 아니라 코드를 돌려준다(server-url.ts 와 같은 이유) — 앱마다 자기 카탈로그로
// 문구를 만든다.
export type AccountPasswordIssue = 'too-short' | 'too-long';

export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_BYTES = 72;

export function getAccountPasswordIssue(password: string): AccountPasswordIssue | null {
  if (Array.from(password).length < ACCOUNT_PASSWORD_MIN_LENGTH) {
    return 'too-short';
  }
  if (utf8ToBytes(password).length > ACCOUNT_PASSWORD_MAX_BYTES) {
    return 'too-long';
  }
  return null;
}
