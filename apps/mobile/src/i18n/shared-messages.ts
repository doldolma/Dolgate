import i18next from 'i18next';
import {
  ACCOUNT_PASSWORD_MAX_BYTES,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  VAULT_PASSPHRASE_MIN_LENGTH,
  getAccountPasswordIssue,
  getAwsEc2SftpDisabledReason,
  getNewVaultPassphraseIssue,
  getServerUrlIssue,
  type HostSubtitleLabels,
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
