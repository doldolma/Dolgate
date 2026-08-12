import type { SecretMetadataRecord } from '@shared';
import { t } from '../i18n';

/**
 * 이 자격증명이 어느 프로토콜용인지 한 단어로.
 *
 * `describeSecretType` 은 **안에 뭐가 들었나**(Password·Private key…)를 말한다. 그것만으로는
 * SSH·RDP·VNC 비밀번호가 모두 'Password' 로 똑같이 보여서, 목록에서 고를 때 구분할 방법이 없다 —
 * 종류는 따로 말해야 한다.
 *
 * `kind` 가 없으면 SSH 다. 이 필드가 생기기 전에 만든 것은 모두 SSH 용이고, 종류를 잃은 항목은
 * 메인이 연결된 호스트에서 되짚어 채운다(database 의 `withLinkedHostCount`).
 */
export function getSecretKindLabel(entry: SecretMetadataRecord): 'SSH' | 'RDP' | 'VNC' {
  if (entry.kind === 'rdp') {
    return 'RDP';
  }
  if (entry.kind === 'vnc') {
    return 'VNC';
  }
  return 'SSH';
}

export function describeSecretType(entry: SecretMetadataRecord): string {
  const labels: string[] = [];

  if (entry.hasManagedPrivateKey && entry.hasCertificate) {
    labels.push('SSH certificate');
  } else if (entry.hasManagedPrivateKey) {
    const keyDetails = [
      entry.keyAlgorithm,
      entry.keyCurve,
      entry.keyBits ? `${entry.keyBits}` : null,
    ].filter(Boolean);
    labels.push(
      keyDetails.length > 0
        ? `Private key (${keyDetails.join(' ')})`
        : 'Private key',
    );
  }

  if (entry.hasPassword) {
    labels.push('Password');
  }

  if (entry.hasPassphrase) {
    labels.push('Passphrase');
  } else if (entry.privateKeyEncrypted) {
    labels.push('Encrypted key');
  }

  if (labels.length === 0) {
    return 'Saved credentials';
  }

  return labels.join(' + ');
}

/**
 * RDP 자격증명 한 줄. 계정을 앞세운다 — RDP 는 계정이 자격증명에 딸리므로, 어느 계정으로 붙는지가
 * 고를 때 가장 중요한 정보다.
 *
 * 계정이 없는 항목(SSH 용으로 만든 비밀번호 등)은 라벨만 보여준다.
 */
export function formatRdpCredentialOptionLabel(
  entry: SecretMetadataRecord,
): string {
  const account = entry.domain?.trim()
    ? `${entry.domain}\\${entry.username ?? ''}`
    : (entry.username?.trim() ?? '');
  return account ? `${account} — ${entry.label}` : entry.label;
}

export function formatSavedSecretOptionLabel(
  entry: SecretMetadataRecord,
): string {
  return t('misc.secretSummary', {
    label: entry.label,
    type: describeSecretType(entry),
    count: entry.linkedHostCount,
  });
}
