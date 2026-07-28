import i18next from 'i18next';
import type { AwsSftpDiagnosticReasonCode, AwsSshMetadataStatus } from '@shared';

// AWS SFTP 진단 문구. shared-core 는 원인 코드(AwsSftpDiagnosticReasonCode)만 만들고,
// 사람이 읽는 문구는 이 앱이 자기 카탈로그로 만든다 — 그래서 모바일이 쓰지 않는 이 문구들이
// 공용 패키지에 남아 있지 않다.
//
// 메인·렌더러 양쪽에서 쓰므로 프로세스별 i18n 모듈 대신 i18next 싱글턴을 직접 쓴다.
// (어느 프로세스에서 초기화됐든 그 인스턴스를 따른다.)

const REASON_CODE_KEYS: Record<AwsSftpDiagnosticReasonCode, string> = {
  'missing-username': 'missingUsername',
  'missing-availability-zone': 'missingAvailabilityZone',
  'host-key-missing': 'hostKeyMissing',
  'not-managed-instance': 'notManagedInstance',
  'eic-access-denied': 'eicAccessDenied',
  'eic-invalid-os-user': 'eicInvalidOsUser',
  'eic-az-mismatch': 'eicAzMismatch',
  'tunnel-open-failed': 'tunnelOpenFailed',
  'ssh-auth-failed': 'sshAuthFailed',
  'sftp-subsystem-failed': 'sftpSubsystemFailed',
  unknown: 'unknown'
};

function resolveReasonKey(
  group: 'title' | 'message' | 'action',
  reasonCode?: AwsSftpDiagnosticReasonCode | null
): string {
  const suffix = (reasonCode && REASON_CODE_KEYS[reasonCode]) || REASON_CODE_KEYS.unknown;
  return `awsDiagnostic.${group}.${suffix}`;
}

export function getAwsSftpDiagnosticTitle(
  reasonCode?: AwsSftpDiagnosticReasonCode | null
): string {
  return i18next.t(resolveReasonKey('title', reasonCode));
}

export function getAwsSftpDiagnosticMessage(
  reasonCode?: AwsSftpDiagnosticReasonCode | null
): string {
  return i18next.t(resolveReasonKey('message', reasonCode));
}

export function getAwsSftpDiagnosticAction(
  reasonCode?: AwsSftpDiagnosticReasonCode | null
): string {
  return i18next.t(resolveReasonKey('action', reasonCode));
}

// 값이 없으면 null — 호출처가 자기 폴백 문구를 쓴다.
export function getAwsEc2HostSshMetadataStatusLabel(
  status?: AwsSshMetadataStatus | null
): string | null {
  switch (status) {
    case 'loading':
      return i18next.t('awsDiagnostic.sshMetadata.loading');
    case 'ready':
      return i18next.t('awsDiagnostic.sshMetadata.ready');
    case 'error':
      return i18next.t('awsDiagnostic.sshMetadata.error');
    default:
      return null;
  }
}
