import { getHostSecretRef } from '@shared';
import type { HostRecord, SecretMetadataRecord } from '@shared';

export function getUnusedLocalSecretsAfterHostDeletion(
  hosts: HostRecord[],
  keychainEntries: SecretMetadataRecord[],
  hostIds: string[],
): string[] {
  if (hostIds.length === 0) {
    return [];
  }

  const removedHostIds = new Set(hostIds);
  const localKeychainSecretRefs = new Set(
    keychainEntries
      .filter((entry) => entry.source === 'local_keychain')
      .map((entry) => entry.secretRef),
  );

  const candidateSecretRefs = new Set<string>();
  const remainingUsageCounts = new Map<string, number>();

  for (const host of hosts) {
    const secretRef = getHostSecretRef(host);
    if (!secretRef || !localKeychainSecretRefs.has(secretRef)) {
      continue;
    }

    if (removedHostIds.has(host.id)) {
      candidateSecretRefs.add(secretRef);
      continue;
    }

    remainingUsageCounts.set(secretRef, (remainingUsageCounts.get(secretRef) ?? 0) + 1);
  }

  return [...candidateSecretRefs].filter(
    (secretRef) => (remainingUsageCounts.get(secretRef) ?? 0) === 0,
  );
}
