import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptXshellPassword } from './xshell-password-decryptor';

function applyRc4(key: Buffer, payload: Buffer): Buffer {
  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) {
    state[index] = index;
  }

  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 0xff;
    const current = state[index];
    state[index] = state[j];
    state[j] = current;
  }

  let i = 0;
  j = 0;
  const output = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    const current = state[i];
    state[i] = state[j];
    state[j] = current;
    output[index] = payload[index] ^ state[(state[i] + state[j]) & 0xff];
  }

  return output;
}

function encryptWithXshell8UserKey(password: string, username: string, sid: string): string {
  const reversedSid = sid.split('').reverse().join('');
  const key = createHash('sha256')
    .update(`${reversedSid}${username}`, 'ascii')
    .digest();
  const plaintext = Buffer.from(password, 'utf8');
  const checksum = createHash('sha256').update(plaintext).digest();
  const ciphertext = applyRc4(key, plaintext);
  return Buffer.concat([ciphertext, checksum]).toString('base64');
}

describe('Xshell password decryptor', () => {
  it('decrypts version > 5.2 passwords with the reversed-SID user key scheme', () => {
    const result = decryptXshellPassword({
      encryptedPassword: encryptWithXshell8UserKey(
        'correct-horse',
        'Administrator',
        'S-1-5-21-917267712-1342860078-1792151419-512'
      ),
      sessionFileVersion: '8.1',
      masterPasswordEnabled: false,
      securityContext: {
        username: 'Administrator',
        sid: 'S-1-5-21-917267712-1342860078-1792151419-512'
      }
    });

    expect(result).toEqual({
      ok: true,
      password: 'correct-horse'
    });
  });

  it('does not attempt automatic decryption when master password is enabled', () => {
    const result = decryptXshellPassword({
      encryptedPassword: encryptWithXshell8UserKey(
        'correct-horse',
        'Administrator',
        'S-1-5-21-917267712-1342860078-1792151419-512'
      ),
      sessionFileVersion: '8.1',
      masterPasswordEnabled: true,
      securityContext: {
        username: 'Administrator',
        sid: 'S-1-5-21-917267712-1342860078-1792151419-512'
      }
    });

    expect(result).toEqual({
      ok: false,
      reason: 'master-password-enabled'
    });
  });

  it('fails with a checksum mismatch when the Windows account context does not match', () => {
    const result = decryptXshellPassword({
      encryptedPassword: encryptWithXshell8UserKey(
        'correct-horse',
        'Administrator',
        'S-1-5-21-917267712-1342860078-1792151419-512'
      ),
      sessionFileVersion: '8.1',
      masterPasswordEnabled: false,
      securityContext: {
        username: 'OtherUser',
        sid: 'S-1-5-21-917267712-1342860078-1792151419-999'
      }
    });

    expect(result).toEqual({
      ok: false,
      reason: 'checksum-mismatch'
    });
  });
});

