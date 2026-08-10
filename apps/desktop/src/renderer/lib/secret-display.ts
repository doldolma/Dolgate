import type { SecretMetadataRecord } from '@shared';
import { t } from '../i18n';

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
