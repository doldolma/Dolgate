import { describe, expect, it } from 'vitest';
import type { SecretMetadataRecord } from '@shared';
import { describeSecretType, getSecretKindLabel } from './secret-display';

// SSH·RDP·VNC 는 같은 자격증명 저장소를 쓴다. 비밀번호만 든 항목은 세 종류가 모두 'Password' 로
// 보여서 목록에서 구분할 방법이 없었다 — 종류는 따로 말해야 한다.

function entry(overrides: Partial<SecretMetadataRecord> = {}): SecretMetadataRecord {
  return {
    secretRef: 'secret:1',
    label: 'cred',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as SecretMetadataRecord;
}

describe('getSecretKindLabel', () => {
  it('종류를 그대로 돌려준다', () => {
    expect(getSecretKindLabel(entry({ kind: 'rdp' }))).toBe('RDP');
    expect(getSecretKindLabel(entry({ kind: 'vnc' }))).toBe('VNC');
    expect(getSecretKindLabel(entry({ kind: 'ssh' }))).toBe('SSH');
  });

  // 이 필드가 생기기 전에 만든 항목은 모두 SSH 용이다. 빈 배지를 그리면 안 된다.
  it('종류가 없으면 SSH 로 본다', () => {
    expect(getSecretKindLabel(entry({ kind: null }))).toBe('SSH');
    expect(getSecretKindLabel(entry())).toBe('SSH');
  });
});

describe('describeSecretType', () => {
  // 배지가 종류를 말하므로 이쪽은 계속 "안에 뭐가 들었나" 만 말한다. 둘을 한 문장에 합치면
  // 개인키·인증서까지 종류와 뒤섞인다.
  it('종류와 무관하게 담긴 자격증명을 설명한다', () => {
    expect(describeSecretType(entry({ kind: 'vnc' }))).toBe('Password');
    expect(describeSecretType(entry({ kind: 'rdp' }))).toBe('Password');
    expect(
      describeSecretType(
        entry({ hasPassword: false, hasManagedPrivateKey: true, keyAlgorithm: 'ed25519' }),
      ),
    ).toBe('Private key (ed25519)');
  });
});
