import i18next from 'i18next';
import {
  ACCOUNT_PASSWORD_MAX_BYTES,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  VAULT_PASSPHRASE_MIN_LENGTH,
  getAccountPasswordIssue,
  getAwsEc2SftpDisabledReason,
  getNewVaultPassphraseIssue,
  getServerUrlIssue,
  type AuthStatus,
  type HostSubtitleLabels,
  type SyncBootstrapStatus,
} from '@dolssh/shared-core';

// shared-core 는 검증 결과를 코드로만 돌려준다(데스크톱과 공유하는 패키지라 UI 언어를
// 결정할 수 없다). 코드를 이 앱의 문구로 바꾸는 매핑을 한곳에 모아 둔다.

export function getServerUrlValidationMessage(value: string): string | null {
  const issue = getServerUrlIssue(value);
  if (!issue) {
    return null;
  }
  const keys = {
    empty: 'shared.serverUrl.empty',
    'not-absolute': 'shared.serverUrl.notAbsolute',
    'bad-scheme': 'shared.serverUrl.badScheme',
    'has-path': 'shared.serverUrl.hasPath',
    'has-query': 'shared.serverUrl.hasQuery',
  } as const;
  return i18next.t(keys[issue]);
}

export function getAccountPasswordValidationMessage(password: string): string | null {
  const issue = getAccountPasswordIssue(password);
  if (!issue) {
    return null;
  }
  return issue === 'too-short'
    ? i18next.t('shared.accountPassword.tooShort', { min: ACCOUNT_PASSWORD_MIN_LENGTH })
    : i18next.t('shared.accountPassword.tooLong', { max: ACCOUNT_PASSWORD_MAX_BYTES });
}

export function getNewVaultPassphraseMessage(passphrase: string): string | null {
  const issue = getNewVaultPassphraseIssue(passphrase);
  if (!issue) {
    return null;
  }
  return issue === 'blank'
    ? i18next.t('shared.vaultPassphrase.blank')
    : i18next.t('shared.vaultPassphrase.tooShort', { min: VAULT_PASSPHRASE_MIN_LENGTH });
}

export function getAwsEc2SftpDisabledMessage(input: {
  awsPlatform?: string | null;
  awsSshUsername?: string | null;
}): string | null {
  return getAwsEc2SftpDisabledReason(input)
    ? i18next.t('shared.awsSftpDisabled.windowsUnsupported')
    : null;
}

// getHostSubtitle 에 넘길 폴백 라벨.
export function hostSubtitleLabels(): HostSubtitleLabels {
  return {
    devicePathUnset: i18next.t('shared.hostSubtitle.devicePathUnset'),
    remoteAddressUnset: i18next.t('shared.hostSubtitle.remoteAddressUnset'),
    usernameUnset: i18next.t('shared.hostSubtitle.usernameUnset'),
  };
}

// 상태값(authenticated·ready …)은 사용자에게 그대로 보여줄 문자열이 아니다. 템플릿 문자열로
// 키를 만들면(`settings.account.status.${status}`) union 에 멤버가 늘어도 컴파일이 통과하고,
// 대신 화면에 키가 그대로 찍힌다. union 으로 인덱싱하는 맵을 쓰면 빠진 멤버에서 컴파일이 깨진다.
const AUTH_STATUS_KEYS = {
  loading: 'settings.account.status.loading',
  unauthenticated: 'settings.account.status.unauthenticated',
  authenticating: 'settings.account.status.authenticating',
  authenticated: 'settings.account.status.authenticated',
  'offline-authenticated': 'settings.account.status.offline-authenticated',
  error: 'settings.account.status.error',
} as const satisfies Record<AuthStatus, string>;

const SYNC_STATUS_KEYS = {
  idle: 'settings.account.sync.idle',
  syncing: 'settings.account.sync.syncing',
  ready: 'settings.account.sync.ready',
  paused: 'settings.account.sync.paused',
  error: 'settings.account.sync.error',
} as const satisfies Record<SyncBootstrapStatus, string>;

// 맵이 완전해도 키 오타는 잡지 못한다 — 카탈로그에 문구가 실제로 있는지는 테스트가 본다.
export const STATUS_LABEL_KEYS: readonly string[] = [
  ...Object.values(AUTH_STATUS_KEYS),
  ...Object.values(SYNC_STATUS_KEYS),
];

export function getAuthStatusLabel(status: AuthStatus): string {
  return i18next.t(AUTH_STATUS_KEYS[status]);
}

export function getSyncStatusLabel(status: SyncBootstrapStatus): string {
  return i18next.t(SYNC_STATUS_KEYS[status]);
}
