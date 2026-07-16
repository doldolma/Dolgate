import { describe, expect, it } from 'vitest';
import { isOfflineSessionCache } from './offline-auth';

function cacheWith(vaultBootstrap: Record<string, unknown>): unknown {
  return {
    serverUrl: 'https://ssh.example.com/',
    user: { id: 'user-1', email: 'user@example.com' },
    vaultBootstrap,
    offlineLease: {
      token: 'token',
      issuedAt: '2026-07-15T00:00:00.000Z',
      expiresAt: '2026-07-16T00:00:00.000Z',
      verificationPublicKeyPem: 'public-key',
    },
    lastOnlineAt: '2026-07-15T00:00:00.000Z',
  };
}

describe('isOfflineSessionCache vault descriptors', () => {
  it('accepts legacy, setup-required, and complete E2EE descriptors', () => {
    expect(isOfflineSessionCache(cacheWith({ keyBase64: 'legacy-key' }))).toBe(true);
    expect(isOfflineSessionCache(cacheWith({ version: 0, epoch: 2 }))).toBe(true);
    expect(
      isOfflineSessionCache(
        cacheWith({
          version: 2,
          wrappedDekBase64: 'wrapped-dek',
          epoch: 3,
          kdf: {
            algorithm: 'argon2id',
            saltBase64: 'salt',
            memoryKib: 64 * 1024,
            timeCost: 3,
            parallelism: 1,
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects incomplete or unknown descriptors', () => {
    expect(isOfflineSessionCache(cacheWith({ version: 1 }))).toBe(false);
    expect(isOfflineSessionCache(cacheWith({ version: 2 }))).toBe(false);
    expect(isOfflineSessionCache(cacheWith({ version: 99 }))).toBe(false);
  });
});
