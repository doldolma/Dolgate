import type { SecretMetadataRecord } from '@shared';

export function describeSecretType(entry: SecretMetadataRecord): string {
  const labels: string[] = [];

  if (entry.hasManagedPrivateKey && entry.hasCertificate) {
    labels.push('Certificate');
  } else if (entry.hasManagedPrivateKey) {
    labels.push('Private key');
  }

  if (entry.hasPassword) {
    labels.push('Password');
  }

  if (entry.hasPassphrase) {
    labels.push('Passphrase');
  }

  if (labels.length === 0) {
    return 'Saved secret';
  }

  return labels.join(' + ');
}

export function formatSavedSecretOptionLabel(
  entry: SecretMetadataRecord,
): string {
  return `${entry.label} · ${describeSecretType(entry)} (${entry.linkedHostCount}개 호스트)`;
}
