import { createPublicKey, createVerify } from 'node:crypto';
import type { OfflineLease, SessionUser, VaultBootstrap } from '@shared';

export interface OfflineSessionCache {
  serverUrl: string;
  user: SessionUser;
  vaultBootstrap: VaultBootstrap;
  offlineLease: OfflineLease;
  lastOnlineAt: string;
}

interface OfflineLeasePayload {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
}

type OfflineLeaseVerificationResult =
  | {
      ok: true;
      expiresAt: string;
      issuedAt: string;
    }
  | {
      ok: false;
      reason: string;
    };

export function isOfflineSessionCache(value: unknown): value is OfflineSessionCache {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const user = candidate.user as Record<string, unknown> | undefined;
  const vaultBootstrap = candidate.vaultBootstrap as Record<string, unknown> | undefined;
  const offlineLease = candidate.offlineLease as Record<string, unknown> | undefined;

  return (
    typeof candidate.serverUrl === 'string' &&
    typeof candidate.lastOnlineAt === 'string' &&
    user != null &&
    typeof user.id === 'string' &&
    typeof user.email === 'string' &&
    vaultBootstrap != null &&
    typeof vaultBootstrap.keyBase64 === 'string' &&
    offlineLease != null &&
    typeof offlineLease.token === 'string' &&
    typeof offlineLease.issuedAt === 'string' &&
    typeof offlineLease.expiresAt === 'string' &&
    typeof offlineLease.verificationPublicKeyPem === 'string'
  );
}

export function normalizeServerUrl(serverUrl: string): string {
  return new URL(serverUrl).toString();
}

export function normalizeServerOrigin(serverUrl: string): string {
  return new URL(serverUrl).origin;
}

export function verifyOfflineLease(
  cache: OfflineSessionCache,
  currentServerUrl: string,
  now: Date = new Date()
): OfflineLeaseVerificationResult {
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = cache.offlineLease.token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      return {
        ok: false,
        reason: 'offline lease 형식이 올바르지 않습니다.'
      };
    }

    const header = JSON.parse(base64urlToBuffer(encodedHeader).toString('utf8')) as Record<string, unknown>;
    if (header.alg !== 'RS256') {
      return {
        ok: false,
        reason: 'offline lease 서명 알고리즘을 확인할 수 없습니다.'
      };
    }

    const publicKey = createPublicKey(cache.offlineLease.verificationPublicKeyPem);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    if (!verifier.verify(publicKey, base64urlToBuffer(encodedSignature))) {
      return {
        ok: false,
        reason: 'offline lease 서명 검증에 실패했습니다.'
      };
    }

    const payload = JSON.parse(base64urlToBuffer(encodedPayload).toString('utf8')) as OfflineLeasePayload;
    const issuer = typeof payload.iss === 'string' ? payload.iss : null;
    const subject = typeof payload.sub === 'string' ? payload.sub : null;
    const audience = normalizeAudience(payload.aud);
    const issuedAtSeconds = typeof payload.iat === 'number' ? payload.iat : null;
    const expiresAtSeconds = typeof payload.exp === 'number' ? payload.exp : null;

    if (!issuer || issuer !== normalizeServerOrigin(currentServerUrl)) {
      return {
        ok: false,
        reason: 'offline lease 발급 서버가 현재 로그인 서버와 다릅니다.'
      };
    }
    if (!subject || subject !== cache.user.id) {
      return {
        ok: false,
        reason: 'offline lease 사용자 정보가 현재 세션과 다릅니다.'
      };
    }
    if (!audience.includes('dolgate-desktop')) {
      return {
        ok: false,
        reason: 'offline lease 대상이 이 데스크톱 앱이 아닙니다.'
      };
    }
    if (!expiresAtSeconds || now.getTime() >= expiresAtSeconds * 1000) {
      return {
        ok: false,
        reason: 'offline lease 유효기간이 지났습니다.'
      };
    }

    return {
      ok: true,
      issuedAt: issuedAtSeconds ? new Date(issuedAtSeconds * 1000).toISOString() : cache.offlineLease.issuedAt,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString()
    };
  } catch {
    return {
      ok: false,
      reason: 'offline lease를 검증하지 못했습니다.'
    };
  }
}

function normalizeAudience(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function base64urlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(paddingLength);
  return Buffer.from(padded, 'base64');
}
