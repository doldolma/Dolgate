import { utf8ToBytes } from '@noble/ciphers/utils.js';

export type AccountPasswordState = 'unset' | 'set' | 'unavailable';

export function validateAccountPassword(password: string): string | null {
  if (Array.from(password).length < 8) {
    return '비밀번호는 8자 이상이어야 합니다.';
  }
  if (utf8ToBytes(password).length > 72) {
    return '비밀번호는 UTF-8 기준 72바이트 이하여야 합니다.';
  }
  return null;
}
