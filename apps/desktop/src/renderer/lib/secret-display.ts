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

export function formatSavedSecretOptionLabel(
  entry: SecretMetadataRecord,
): string {
  return t('misc.secretSummary', {
    label: entry.label,
    type: describeSecretType(entry),
    count: entry.linkedHostCount,
  });
}
