import type { SshCertificateInfo } from '@shared';

export interface CertificateInfoSummary {
  tone: 'neutral' | 'warning' | 'danger';
  title: string;
  detail: string | null;
}

function formatCertificateTimestamp(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const hours = String(parsed.getUTCHours()).padStart(2, '0');
  const minutes = String(parsed.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

export function describeCertificateInfo(
  info: SshCertificateInfo | null | undefined,
): CertificateInfoSummary | null {
  if (!info) {
    return null;
  }

  const validAfter = formatCertificateTimestamp(info.validAfter);
  const validBefore = formatCertificateTimestamp(info.validBefore);
  const principalText =
    info.principals && info.principals.length > 0
      ? `Principals: ${info.principals.join(', ')}`
      : null;

  if (info.status === 'expired') {
    return {
      tone: 'danger',
      title: validBefore ? `Expired on ${validBefore}` : 'Certificate expired',
      detail: principalText,
    };
  }

  if (info.status === 'not_yet_valid') {
    return {
      tone: 'warning',
      title: validAfter ? `Not valid before ${validAfter}` : 'Certificate not yet valid',
      detail: principalText,
    };
  }

  if (info.status === 'invalid') {
    return {
      tone: 'danger',
      title: 'Certificate could not be parsed',
      detail: principalText,
    };
  }

  return {
    tone: 'neutral',
    title: validBefore ? `Valid until ${validBefore}` : 'Certificate is valid',
    detail: principalText,
  };
}
