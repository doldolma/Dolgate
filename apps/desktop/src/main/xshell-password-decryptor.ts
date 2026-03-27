import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const XSHELL_LEGACY_KEY = '!X@s#h$e%l^l&';
const PASSWORD_CHECKSUM_LENGTH = 32;

export type XshellPasswordDecryptFailureReason =
  | 'invalid-ciphertext'
  | 'invalid-version'
  | 'master-password-enabled'
  | 'missing-security-context'
  | 'checksum-mismatch';

export interface XshellPasswordSecurityContext {
  sid: string;
  username: string;
}

export interface XshellPasswordDecryptInput {
  encryptedPassword: string;
  sessionFileVersion: string | null;
  masterPasswordEnabled: boolean;
  securityContext: XshellPasswordSecurityContext | null;
}

export type XshellPasswordDecryptResult =
  | {
      ok: true;
      password: string;
    }
  | {
      ok: false;
      reason: XshellPasswordDecryptFailureReason;
    };

let cachedSecurityContextPromise: Promise<XshellPasswordSecurityContext | null> | null = null;

function parseSessionFileVersion(version: string | null): number | null {
  if (!version) {
    return null;
  }

  const parsed = Number.parseFloat(version);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

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
    const keyByte = state[(state[i] + state[j]) & 0xff];
    output[index] = payload[index] ^ keyByte;
  }

  return output;
}

function buildRc4Key(
  sessionFileVersion: number,
  securityContext: XshellPasswordSecurityContext | null
): Buffer | null {
  if (sessionFileVersion < 5.1) {
    return createHash('md5').update(XSHELL_LEGACY_KEY, 'ascii').digest();
  }

  if (!securityContext) {
    return null;
  }

  if (sessionFileVersion <= 5.2) {
    return createHash('sha256').update(securityContext.sid, 'utf8').digest();
  }

  const reversedSid = securityContext.sid.split('').reverse().join('');
  return createHash('sha256')
    .update(`${reversedSid}${securityContext.username}`, 'ascii')
    .digest();
}

function decodeBase64(value: string): Buffer | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    return null;
  }

  try {
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length === 0) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  }
}

export function decryptXshellPassword(input: XshellPasswordDecryptInput): XshellPasswordDecryptResult {
  if (input.masterPasswordEnabled) {
    return {
      ok: false,
      reason: 'master-password-enabled'
    };
  }

  const sessionFileVersion = parseSessionFileVersion(input.sessionFileVersion);
  if (!sessionFileVersion) {
    return {
      ok: false,
      reason: 'invalid-version'
    };
  }

  const encryptedBytes = decodeBase64(input.encryptedPassword);
  if (!encryptedBytes) {
    return {
      ok: false,
      reason: 'invalid-ciphertext'
    };
  }

  const rc4Key = buildRc4Key(sessionFileVersion, input.securityContext);
  if (!rc4Key) {
    return {
      ok: false,
      reason: 'missing-security-context'
    };
  }

  if (sessionFileVersion < 5.1) {
    return {
      ok: true,
      password: applyRc4(rc4Key, encryptedBytes).toString('utf8')
    };
  }

  if (encryptedBytes.length <= PASSWORD_CHECKSUM_LENGTH) {
    return {
      ok: false,
      reason: 'invalid-ciphertext'
    };
  }

  const ciphertext = encryptedBytes.subarray(0, encryptedBytes.length - PASSWORD_CHECKSUM_LENGTH);
  const checksum = encryptedBytes.subarray(encryptedBytes.length - PASSWORD_CHECKSUM_LENGTH);
  const plaintext = applyRc4(rc4Key, ciphertext);
  const expectedChecksum = createHash('sha256').update(plaintext).digest();

  if (!checksum.equals(expectedChecksum)) {
    return {
      ok: false,
      reason: 'checksum-mismatch'
    };
  }

  return {
    ok: true,
    password: plaintext.toString('utf8')
  };
}

async function resolveCurrentWindowsSid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
    ]);
    const sid = stdout.trim();
    return sid || null;
  } catch {
    try {
      const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
      const match = stdout.match(/"[^"]+","([^"]+)"/);
      return match?.[1]?.trim() || null;
    } catch {
      return null;
    }
  }
}

export async function resolveCurrentXshellPasswordSecurityContext(): Promise<XshellPasswordSecurityContext | null> {
  if (process.platform !== 'win32') {
    return null;
  }

  if (!cachedSecurityContextPromise) {
    cachedSecurityContextPromise = (async () => {
      const sid = await resolveCurrentWindowsSid();
      const username = os.userInfo().username?.trim();
      if (!sid || !username) {
        return null;
      }
      return {
        sid,
        username
      };
    })();
  }

  return cachedSecurityContextPromise;
}
