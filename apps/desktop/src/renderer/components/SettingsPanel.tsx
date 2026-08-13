import type {
  AppLanguage,
  AppSettings,
  AppTheme,
  AccountPasswordState,
  AuthVaultStatus,
  GlobalTerminalThemeId,
  HostRecord,
  KnownHostRecord,
  PasskeyCredential,
  SecretMetadataRecord,
  SessionReplayStorageUsage,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
  SshKeyMaterialResult,
  SftpConflictPolicy,
  TerminalFontFamilyId,
} from '@shared';
import {
} from '@shared';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { APP_LANGUAGE_OPTIONS } from '../../common/i18n/locale';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsSection } from '../store/createAppStore';
import { terminalFontOptions, terminalThemePresets } from '../lib/terminal-presets';
import { tmuxPrefixKeyOptions } from '../lib/tmux-prefix';
import { DialogBackdrop } from './DialogBackdrop';
import { KeychainPanel } from './KeychainPanel';
import { KnownHostsPanel } from './KnownHostsPanel';
import { TailnetSettingsPanel } from './TailnetSettingsPanel';
import { AwsProfilesPanel } from './AwsProfilesPanel';
import { AiSettingsPanel } from './AiSettingsPanel';
import {
  Button,
  FieldGroup,
  FontSelectField,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  OptionCard,
  InfoHint,
  InfoHintPoints,
  SectionLabel,
  SelectField,
  TabButton,
  Tabs,
  ToggleSwitch,
} from '../ui';
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts';
import { getAccountPasswordValidationMessage, getNewVaultPassphraseMessage } from '../../common/shared-messages';

// shared-core의 clampCommandNotificationThresholdSeconds 범위와 동일하게 유지.
// @shared value를 직접 import하면 vite dev에서 export* 누락 이슈가 있어 인라인.
const COMMAND_NOTIFICATION_THRESHOLD_MIN_SECONDS = 1;
const COMMAND_NOTIFICATION_THRESHOLD_MAX_SECONDS = 86400;

interface SettingsPanelProps {
  activeSection: SettingsSection;
  settings: AppSettings;
  hosts: HostRecord[];
  knownHosts: KnownHostRecord[];
  keychainEntries: SecretMetadataRecord[];
  savedCredentialsSearchQuery: string;
  currentUserEmail?: string | null;
  passwordState?: AccountPasswordState | null;
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  onSelectSection: (section: SettingsSection) => void;
  onSavedCredentialsSearchQueryChange: (query: string) => void;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
  onRemoveKnownHost: (id: string) => Promise<void>;
  /** RDP 서버 인증서 신뢰 해제. 신뢰 목록이 SSH 키만 다루던 것을 메꾼다. */
  onRevokeRdpCertificate: (hostId: string) => Promise<void>;
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onEditSecret: (secretRef: string) => void;
  onGenerateSshKey: (input: SshKeyGenerateInput) => Promise<SshKeyMaterialResult>;
  onCopySshPublicKey: (secretRef: string) => Promise<void>;
  onInstallSshPublicKey: (input: SshKeyInstallInput) => Promise<SshKeyInstallResult>;
  onLoadSessionReplayStorageUsage?: () => Promise<SessionReplayStorageUsage>;
  onLogout: () => Promise<void>;
  // 회원 탈퇴 — 서버의 모든 사용자 데이터를 즉시 영구 삭제한다(로컬 데이터는 유지).
  onDeleteAccount?: () => Promise<void>;
  onChangeAccountPassword?: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  // 패스키(WebAuthn) — 서버가 지원(webauthnSupported)할 때만 섹션을 노출한다. 추가는 실제
  // 등록(Touch ID 등)을 위해 시스템 브라우저로 서버의 등록 페이지를 연다.
  webauthnSupported?: boolean;
  onAddPasskey?: () => Promise<void>;
  onListPasskeys?: () => Promise<PasskeyCredential[]>;
  onDeletePasskey?: (credentialId: string) => Promise<void>;
  // E2EE 볼트(v2) 사용자의 동기화 암호 변경. v1(레거시) 사용자에게는 섹션이 숨겨진다.
  vaultStatus?: AuthVaultStatus | null;
  onChangeVaultPassphrase?: (
    currentPassphrase: string,
    nextPassphrase: string,
  ) => Promise<void>;
  // 동기화 볼트 초기화(암호 분실 시 최후 수단). 서버 동기화 데이터를 지우고 새 암호 설정
  // 게이트로 이동한다. 설정 진입 = 볼트가 unlocked 이므로 이 기기의 로컬 데이터는 유지되어
  // 새 암호로 다시 업로드된다(자연 복구). v1(레거시)에는 숨김.
  onResetVault?: () => Promise<void>;
}

// 모듈 최상위 상수는 i18n 초기화보다 먼저 평가되므로 문구가 아니라 키를 담고,
// 렌더 시점에 번역한다.
const themeOptions: Array<{ value: AppTheme; title: string; descriptionKey: string }> = [
  {
    value: 'system',
    title: 'System',
    descriptionKey: 'settings.theme.system.description'
  },
  {
    value: 'light',
    title: 'Light',
    descriptionKey: 'settings.theme.light.description'
  },
  {
    value: 'dark',
    title: 'Dark',
    descriptionKey: 'settings.theme.dark.description'
  }
];

const fontSizeOptions = Array.from({ length: 8 }, (_, index) => index + 11);

// 언어 이름은 그 언어로 적는다(자기 언어를 못 읽는 사용자가 없게).
const LANGUAGE_LABELS: Record<Exclude<AppLanguage, 'system'>, string> = {
  ko: '한국어',
  en: 'English'
};

function formatStorageBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled >= 100 || unitIndex === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unitIndex]}`;
}
const macOnlyTerminalFonts = new Set<TerminalFontFamilyId>(['sf-mono', 'menlo', 'monaco']);

const settingsSections: Array<{ id: SettingsSection; title: string }> = [
  { id: 'general', title: 'General' },
  { id: 'sftp', title: 'SFTP' },
  { id: 'security', title: 'Security' },
  { id: 'secrets', title: 'Saved Credentials' },
  { id: 'aws-profiles', title: 'AWS Profiles' },
  { id: 'tailnet', title: 'Tailscale' },
  { id: 'ai', title: 'AI' },
  { id: 'account', title: 'Account' }
];

function renderTerminalThemePreview(
  preview: ReactNode,
  background?: string,
  color?: string,
) {
  return (
    <div
      className="flex min-h-[86px] w-full flex-col justify-between rounded-[12px] border border-[color-mix(in_srgb,currentColor_12%,transparent_88%)] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      style={background || color ? { background, color } : undefined}
    >
      {preview}
    </div>
  );
}

/**
 * 등록만 되고 한 번도 로그인에 쓰이지 않은 패스키인지.
 *
 * 서버는 등록할 때 `lastUsedAt` 을 `createdAt` 으로 채우고(gorm_store 의 SaveWebAuthnCredential),
 * 로그인 성공 때만 갱신한다. 그래서 두 값이 같으면 아직 안 쓰인 것이다.
 *
 * **이 표시가 필요한 이유:** 등록한 브라우저와 로그인하는 브라우저가 다르면 — 크롬은 패스키를
 * 프로필별로 저장한다 — 서버에는 자격증명이 남고 로그인 화면에서는 찾지 못한다. 이름과 등록일만
 * 보여주면 쓰이는 것과 못 쓰는 것이 똑같아 보여서, 로그인이 안 될 때 무엇을 지워야 할지 알 수 없다.
 */
function isPasskeyUnused(passkey: PasskeyCredential): boolean {
  const created = Date.parse(passkey.createdAt);
  const lastUsed = Date.parse(passkey.lastUsedAt);
  if (Number.isNaN(created) || Number.isNaN(lastUsed)) {
    return false;
  }
  return lastUsed <= created;
}

function renderTerminalThemePreviewChrome(accent?: string) {
  return (
    <>
      <span className="inline-flex gap-[0.25rem]">
        <i className="h-[0.46rem] w-[0.46rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.46rem] w-[0.46rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.46rem] w-[0.46rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
      </span>
      <span className="grid gap-[0.4rem]">
        <span className="block h-[0.42rem] w-[54%] rounded-full" style={accent ? { background: accent } : undefined} />
        <span className="block h-[0.42rem] w-[82%] rounded-full bg-[color-mix(in_srgb,currentColor_24%,transparent_76%)]" />
        <span className="block h-[0.42rem] w-[68%] rounded-full bg-[color-mix(in_srgb,currentColor_24%,transparent_76%)]" />
        <span className="block h-[0.42rem] w-[40%] rounded-full" style={accent ? { background: accent } : undefined} />
      </span>
    </>
  );
}

function renderAppearanceThemeMiniWindow(
  background: string,
  color: string,
  accent: string,
) {
  return (
    <div
      className="grid min-h-[66px] gap-[0.55rem] rounded-[10px] border border-[color-mix(in_srgb,currentColor_12%,transparent_88%)] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
      style={{ background, color }}
    >
      <span className="inline-flex gap-[0.25rem]">
        <i className="h-[0.42rem] w-[0.42rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.42rem] w-[0.42rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
        <i className="h-[0.42rem] w-[0.42rem] rounded-full bg-[color-mix(in_srgb,currentColor_72%,transparent_28%)]" />
      </span>
      <span className="grid gap-[0.4rem]">
        <span className="block h-[0.4rem] w-[58%] rounded-full" style={{ background: accent }} />
        <span className="block h-[0.4rem] w-[82%] rounded-full bg-[color-mix(in_srgb,currentColor_20%,transparent_80%)]" />
        <span className="block h-[0.4rem] w-[64%] rounded-full bg-[color-mix(in_srgb,currentColor_20%,transparent_80%)]" />
      </span>
    </div>
  );
}

function renderAppearanceThemePreview(theme: AppTheme) {
  if (theme === 'system') {
    return (
      <div className="grid w-full grid-cols-2 gap-2" aria-hidden="true">
        {renderAppearanceThemeMiniWindow('#f5f7fb', '#243041', '#2468ff')}
        {renderAppearanceThemeMiniWindow('#0b1220', '#dce6ff', '#7aa2ff')}
      </div>
    );
  }

  if (theme === 'light') {
    return (
      <div className="w-full" aria-hidden="true">
        {renderAppearanceThemeMiniWindow('#f5f7fb', '#243041', '#2468ff')}
      </div>
    );
  }

  return (
    <div className="w-full" aria-hidden="true">
      {renderAppearanceThemeMiniWindow('#0b1220', '#dce6ff', '#7aa2ff')}
    </div>
  );
}

export function SettingsPanel({
  activeSection,
  settings,
  hosts,
  knownHosts,
  keychainEntries,
  savedCredentialsSearchQuery,
  currentUserEmail = null,
  passwordState = null,
  vaultStatus = null,
  onChangeVaultPassphrase,
  onResetVault,
  desktopPlatform,
  onSelectSection,
  onSavedCredentialsSearchQueryChange,
  onUpdateSettings,
  onRemoveKnownHost,
  onRevokeRdpCertificate,
  onRemoveSecret,
  onEditSecret,
  onGenerateSshKey,
  onCopySshPublicKey,
  onInstallSshPublicKey,
  onLoadSessionReplayStorageUsage,
  onLogout,
  onDeleteAccount,
  onChangeAccountPassword,
  webauthnSupported = false,
  onAddPasskey,
  onListPasskeys,
  onDeletePasskey
}: SettingsPanelProps) {
  const { t: translate } = useTranslation();
  // 회원 탈퇴 확인 다이얼로그 상태.
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);
  const [accountPasswordOpen, setAccountPasswordOpen] = useState(false);
  const [currentAccountPassword, setCurrentAccountPassword] = useState('');
  const [nextAccountPassword, setNextAccountPassword] = useState('');
  const [confirmAccountPassword, setConfirmAccountPassword] = useState('');
  const [accountPasswordBusy, setAccountPasswordBusy] = useState(false);
  const [accountPasswordError, setAccountPasswordError] = useState<string | null>(null);
  const [accountPasswordNotice, setAccountPasswordNotice] = useState<string | null>(null);
  // 패스키(WebAuthn) 상태.
  const [passkeys, setPasskeys] = useState<PasskeyCredential[]>([]);
  const [passkeysLoading, setPasskeysLoading] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const loadPasskeys = useCallback(async () => {
    if (!onListPasskeys) {
      return;
    }
    setPasskeysLoading(true);
    setPasskeyError(null);
    try {
      setPasskeys(await onListPasskeys());
    } catch (error) {
      setPasskeyError(
        error instanceof Error ? error.message : translate('settings.passkey.loadFailed'),
      );
    } finally {
      setPasskeysLoading(false);
    }
  }, [onListPasskeys]);

  // 서버가 패스키를 지원하면 목록을 불러오고, 창이 다시 포커스될 때(브라우저 등록을 마치고
  // 돌아왔을 때) 자동으로 새로고침한다 — 등록은 외부 브라우저에서 일어나기 때문.
  useEffect(() => {
    if (!webauthnSupported || !onListPasskeys) {
      return;
    }
    void loadPasskeys();
    const handleFocus = () => {
      void loadPasskeys();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [webauthnSupported, onListPasskeys, loadPasskeys]);

  async function handleAddPasskey() {
    if (!onAddPasskey) {
      return;
    }
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await onAddPasskey();
    } catch (error) {
      setPasskeyError(
        error instanceof Error ? error.message : translate('settings.passkey.addFailed'),
      );
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function handleDeletePasskey(credentialId: string) {
    if (!onDeletePasskey) {
      return;
    }
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await onDeletePasskey(credentialId);
      await loadPasskeys();
    } catch (error) {
      setPasskeyError(
        error instanceof Error ? error.message : translate('settings.passkey.deleteFailed'),
      );
    } finally {
      setPasskeyBusy(false);
    }
  }
  const accountPasswordValidationMessage = nextAccountPassword
    ? getAccountPasswordValidationMessage(nextAccountPassword)
    : null;
  // 동기화 암호 변경 다이얼로그 상태.
  const [vaultPassphraseOpen, setVaultPassphraseOpen] = useState(false);
  const [currentVaultPassphrase, setCurrentVaultPassphrase] = useState('');
  const [nextVaultPassphrase, setNextVaultPassphrase] = useState('');
  const [confirmVaultPassphrase, setConfirmVaultPassphrase] = useState('');
  const [vaultPassphraseBusy, setVaultPassphraseBusy] = useState(false);
  const [vaultPassphraseError, setVaultPassphraseError] = useState<string | null>(null);
  const [vaultPassphraseNotice, setVaultPassphraseNotice] = useState<string | null>(null);
  const newVaultPassphraseValidationMessage = nextVaultPassphrase
    ? getNewVaultPassphraseMessage(nextVaultPassphrase)
    : null;
  // 동기화 볼트 초기화(암호 분실) 확인 다이얼로그 상태.
  const [vaultResetOpen, setVaultResetOpen] = useState(false);
  const [vaultResetBusy, setVaultResetBusy] = useState(false);
  const [vaultResetError, setVaultResetError] = useState<string | null>(null);
  // 리플레이 보관 설정 옆에 실제 디스크 사용량을 보여준다. 보관 개수를 줄이면 프루닝으로
  // 용량이 줄 수 있으므로 retention 값이 바뀔 때마다 다시 조회한다.
  const [replayStorageUsage, setReplayStorageUsage] =
    useState<SessionReplayStorageUsage | null>(null);
  useEffect(() => {
    if (!onLoadSessionReplayStorageUsage || activeSection !== 'general') {
      return;
    }
    let cancelled = false;
    onLoadSessionReplayStorageUsage()
      .then((usage) => {
        if (!cancelled) {
          setReplayStorageUsage(usage);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReplayStorageUsage(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    onLoadSessionReplayStorageUsage,
    activeSection,
    settings.sessionReplayRetentionCount,
  ]);
  useEffect(() => {
    if (passwordState === 'set' || passwordState === 'unset') {
      return;
    }
    setAccountPasswordOpen(false);
    setCurrentAccountPassword('');
    setNextAccountPassword('');
    setConfirmAccountPassword('');
    setAccountPasswordError(null);
  }, [passwordState]);
  useEffect(() => {
    if (vaultStatus === 'unlocked') {
      return;
    }
    setVaultPassphraseOpen(false);
    setCurrentVaultPassphrase('');
    setNextVaultPassphrase('');
    setConfirmVaultPassphrase('');
    setVaultPassphraseError(null);
    setVaultResetOpen(false);
    setVaultResetError(null);
  }, [vaultStatus]);

  const visibleTerminalFontOptions =
    desktopPlatform === 'darwin'
      ? terminalFontOptions
      : terminalFontOptions.filter((option) => !macOnlyTerminalFonts.has(option.id));

  async function handleChangeTerminalTheme(globalTerminalThemeId: GlobalTerminalThemeId) {
    await onUpdateSettings({ globalTerminalThemeId });
  }

  async function handleChangeTerminalFontFamily(terminalFontFamily: TerminalFontFamilyId) {
    await onUpdateSettings({ terminalFontFamily });
  }

  async function handleChangeTerminalFontSize(terminalFontSize: number) {
    await onUpdateSettings({ terminalFontSize });
  }

  async function handleChangeTerminalWebglEnabled(terminalWebglEnabled: boolean) {
    await onUpdateSettings({ terminalWebglEnabled });
  }

  async function handleChangeTerminalAutocompleteEnabled(
    terminalAutocompleteEnabled: boolean,
  ) {
    await onUpdateSettings({ terminalAutocompleteEnabled });
  }

  async function handleChangeTerminalScrollbackLines(terminalScrollbackLines: number) {
    await onUpdateSettings({ terminalScrollbackLines });
  }

  async function handleChangeTerminalLineHeight(terminalLineHeight: number) {
    await onUpdateSettings({ terminalLineHeight });
  }

  async function handleChangeTerminalLetterSpacing(terminalLetterSpacing: number) {
    await onUpdateSettings({ terminalLetterSpacing });
  }

  async function handleChangeTerminalMinimumContrastRatio(terminalMinimumContrastRatio: number) {
    await onUpdateSettings({ terminalMinimumContrastRatio });
  }

  async function handleChangeTerminalAltIsMeta(terminalAltIsMeta: boolean) {
    await onUpdateSettings({ terminalAltIsMeta });
  }

  async function handleChangeTmuxPrefixKey(tmuxPrefixKey: string) {
    await onUpdateSettings({ tmuxPrefixKey });
  }

  // 세션 replay 보관 개수 입력은 로컬 상태로 타이핑을 받고, blur(포커스 아웃) 때에만 저장한다.
  // 매 키 입력마다 저장하면 "5000"을 치는 중 "5"가 곧바로 저장되고, 그 순간 replay가 그
  // 작은 개수까지 prune(삭제)되어 데이터가 날아가던 버그를 막는다. clamp는 하지 않고 입력한
  // 값을 그대로 저장한다(빈 값/이상치만 이전 값으로 되돌림).
  const [replayRetentionInput, setReplayRetentionInput] = useState(
    String(settings.sessionReplayRetentionCount),
  );
  useEffect(() => {
    setReplayRetentionInput(String(settings.sessionReplayRetentionCount));
  }, [settings.sessionReplayRetentionCount]);

  /** 입력값을 저장 가능한 개수로. 빈 값·이상치는 null(= 이전 값 유지). */
  function parsedReplayRetentionInput(): number | null {
    const parsed = Math.round(Number(replayRetentionInput));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function commitSessionReplayRetentionCount() {
    const parsed = parsedReplayRetentionInput();
    if (parsed === null) {
      setReplayRetentionInput(String(settings.sessionReplayRetentionCount));
      return;
    }
    setReplayRetentionInput(String(parsed));
    if (parsed !== settings.sessionReplayRetentionCount) {
      void handleChangeSessionReplayRetentionCount(parsed);
    }
  }

  // 저장은 blur/Enter 에서만 한다. 타이핑 중 패널이 닫히면 입력값이 사라지지만, 언마운트
  // 때 대신 저장해 주면 "5000" 을 치다 만 "5" 가 그대로 저장돼 replay 가 그 개수까지
  // 삭제된다(prune 은 되돌릴 수 없다). 값이 날아가는 쪽이 낫다.
  async function handleChangeSessionReplayRetentionCount(
    sessionReplayRetentionCount: number,
  ) {
    await onUpdateSettings({ sessionReplayRetentionCount });
  }

  async function handleChangeSftpConflictPolicy(
    sftpConflictPolicy: SftpConflictPolicy,
  ) {
    await onUpdateSettings({ sftpConflictPolicy });
  }

  function resetAccountPasswordForm() {
    setCurrentAccountPassword('');
    setNextAccountPassword('');
    setConfirmAccountPassword('');
    setAccountPasswordError(null);
  }

  function openAccountPasswordDialog() {
    resetAccountPasswordForm();
    setAccountPasswordNotice(null);
    setAccountPasswordOpen(true);
  }

  function closeAccountPasswordDialog() {
    if (accountPasswordBusy) {
      return;
    }
    resetAccountPasswordForm();
    setAccountPasswordOpen(false);
  }

  async function handleChangeAccountPassword() {
    if (
      !onChangeAccountPassword ||
      (passwordState !== 'unset' && passwordState !== 'set')
    ) {
      return;
    }
    setAccountPasswordBusy(true);
    setAccountPasswordError(null);
    try {
      await onChangeAccountPassword(
        passwordState === 'set' ? currentAccountPassword : '',
        nextAccountPassword,
      );
      resetAccountPasswordForm();
      setAccountPasswordOpen(false);
      setAccountPasswordNotice(
        passwordState === 'set'
          ? translate('settings.accountPassword.changed')
          : translate('settings.accountPassword.set'),
      );
    } catch (error) {
      const fallback = translate('settings.accountPassword.saveFailed');
      setAccountPasswordError(
        normalizeErrorMessage(error, fallback) || fallback,
      );
    } finally {
      setAccountPasswordBusy(false);
    }
  }

  function resetVaultPassphraseForm() {
    setCurrentVaultPassphrase('');
    setNextVaultPassphrase('');
    setConfirmVaultPassphrase('');
    setVaultPassphraseError(null);
  }

  function openVaultPassphraseDialog() {
    resetVaultPassphraseForm();
    setVaultPassphraseNotice(null);
    setVaultPassphraseOpen(true);
  }

  function closeVaultPassphraseDialog() {
    if (vaultPassphraseBusy) {
      return;
    }
    resetVaultPassphraseForm();
    setVaultPassphraseOpen(false);
  }

  async function handleChangeVaultPassphrase() {
    if (!onChangeVaultPassphrase) {
      return;
    }
    setVaultPassphraseBusy(true);
    setVaultPassphraseError(null);
    try {
      await onChangeVaultPassphrase(
        currentVaultPassphrase,
        nextVaultPassphrase,
      );
      resetVaultPassphraseForm();
      setVaultPassphraseOpen(false);
      setVaultPassphraseNotice(translate('settings.vault.passphraseChanged'));
    } catch (error) {
      const fallback = translate('settings.vault.passphraseChangeFailed');
      setVaultPassphraseError(
        normalizeErrorMessage(error, fallback) || fallback,
      );
    } finally {
      setVaultPassphraseBusy(false);
    }
  }

  async function handleResetVault() {
    if (!onResetVault) {
      return;
    }
    setVaultResetBusy(true);
    setVaultResetError(null);
    try {
      await onResetVault();
      // 성공하면 볼트가 setup-required 로 바뀌어 앱 전체가 동기화 암호 설정 게이트로
      // 전환된다(이 패널은 언마운트). 다이얼로그 닫기는 위 vaultStatus effect 가 겸한다.
      setVaultResetOpen(false);
    } catch (error) {
      const fallback = translate('settings.vault.resetFailed');
      setVaultResetError(normalizeErrorMessage(error, fallback) || fallback);
    } finally {
      setVaultResetBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-1 flex-col gap-5">
      {/* 상단 브레드크럼(← Hosts · Settings)에 이미 제목이 있어 Preferences/Settings 헤더는 생략,
          섹션 탭을 맨 위로 올린다. */}
      <Tabs role="tablist" aria-label="Settings sections">
        {settingsSections.map((section) => (
          <TabButton
            key={section.id}
            role="tab"
            aria-selected={activeSection === section.id}
            active={activeSection === section.id}
            onClick={() => onSelectSection(section.id)}
          >
            {section.title}
          </TabButton>
        ))}
      </Tabs>

      {activeSection === 'general' ? (
        <>
          <section className="rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
            <div className="mb-4">
              <div>
                <SectionLabel>Terminal</SectionLabel>
                <h3>Preferences</h3>
              </div>
            </div>

            <div className="mb-[1.1rem] grid items-start grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[1320px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[760px]:grid-cols-1">
              <FieldGroup label="Font">
                <FontSelectField
                  ariaLabel="Font"
                  value={settings.terminalFontFamily}
                  options={visibleTerminalFontOptions}
                  onChange={(id) =>
                    handleChangeTerminalFontFamily(id as TerminalFontFamilyId)
                  }
                />
              </FieldGroup>

              <FieldGroup label="Font Size">
                <SelectField
                  value={settings.terminalFontSize}
                  onChange={async (event) =>
                    handleChangeTerminalFontSize(Number(event.target.value))
                  }
                >
                  {fontSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size}px
                    </option>
                  ))}
                </SelectField>
              </FieldGroup>

              <FieldGroup label="Scrollback">
                <Input
                  aria-label="Scrollback"
                  type="number"
                  min={1000}
                  max={25000}
                  step={100}
                  value={settings.terminalScrollbackLines}
                  onChange={async (event) =>
                    handleChangeTerminalScrollbackLines(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                  {translate('settings.preferences.scrollbackHint')}
                </p>
              </FieldGroup>

              <FieldGroup label="Line Height">
                <Input
                  aria-label="Line Height"
                  type="number"
                  min={1}
                  max={2}
                  step={0.05}
                  value={settings.terminalLineHeight}
                  onChange={async (event) =>
                    handleChangeTerminalLineHeight(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                  {translate('settings.preferences.lineHeightHint')}
                </p>
              </FieldGroup>

              <FieldGroup label="Letter Spacing">
                <Input
                  aria-label="Letter Spacing"
                  type="number"
                  min={0}
                  max={2}
                  step={1}
                  value={settings.terminalLetterSpacing}
                  onChange={async (event) =>
                    handleChangeTerminalLetterSpacing(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                  {translate('settings.preferences.letterSpacingHint')}
                </p>
              </FieldGroup>

              <FieldGroup label="Minimum Contrast">
                <Input
                  aria-label="Minimum Contrast"
                  type="number"
                  min={1}
                  max={21}
                  step={0.5}
                  value={settings.terminalMinimumContrastRatio}
                  onChange={async (event) =>
                    handleChangeTerminalMinimumContrastRatio(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                  {translate('settings.preferences.contrastHint')}
                </p>
              </FieldGroup>

              <FieldGroup label="Session Replay Retention">
                <Input
                  aria-label="Session Replay Retention"
                  type="number"
                  inputMode="numeric"
                  value={replayRetentionInput}
                  onChange={(event) => setReplayRetentionInput(event.target.value)}
                  onBlur={commitSessionReplayRetentionCount}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                  }}
                />
                <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                  {translate('settings.preferences.replayRetentionHint')}
                  {replayStorageUsage
                    ? translate('settings.preferences.replayUsage', {
                        count: replayStorageUsage.recordingCount,
                        size: formatStorageBytes(replayStorageUsage.totalBytes)
                      })
                    : ''}
                </p>
              </FieldGroup>

            </div>

            {/* 터미널 동작 토글 — 토글끼리 묶어 input과 높이가 섞이지 않게 한다 */}
            <div className="mb-[1.1rem] grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1">
              <ToggleSwitch
                checked={settings.terminalWebglEnabled}
                label="WebGL Renderer"
                description={translate('settings.preferences.webglDescription')}
                onClick={() => {
                  void handleChangeTerminalWebglEnabled(!settings.terminalWebglEnabled);
                }}
              />

              <ToggleSwitch
                checked={settings.terminalAutocompleteEnabled}
                label="Command autocomplete"
                description={translate('settings.preferences.completionDescription')}
                onClick={() => {
                  void handleChangeTerminalAutocompleteEnabled(
                    !settings.terminalAutocompleteEnabled,
                  );
                }}
              />

              {desktopPlatform === 'darwin' ? (
                <ToggleSwitch
                  checked={settings.terminalAltIsMeta}
                  label="Use Option/Alt as Meta"
                  description={translate('settings.preferences.optionAsMetaDescription')}
                  onClick={() => {
                    void handleChangeTerminalAltIsMeta(!settings.terminalAltIsMeta);
                  }}
                />
              ) : null}

              <FieldGroup label={translate('settings.preferences.tmuxPrefixLabel')}>
                <SelectField
                  value={settings.tmuxPrefixKey ?? 'C-b'}
                  onChange={async (event) =>
                    handleChangeTmuxPrefixKey(event.target.value)
                  }
                >
                  {tmuxPrefixKeyOptions().map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
                <p className="mt-1.5 text-[0.76rem] leading-relaxed text-[var(--text-muted)]">
                  {translate('settings.preferences.tmuxPrefixHint')}
                </p>
              </FieldGroup>
              <ToggleSwitch
                checked={settings.subshellReinjectEnabled !== false}
                label={translate('settings.preferences.shellIntegrationRecoveryLabel')}
                description={translate('settings.preferences.shellIntegrationRecoveryDescription')}
                onClick={() =>
                  void onUpdateSettings({
                    subshellReinjectEnabled:
                      settings.subshellReinjectEnabled === false,
                  })
                }
              />
              <ToggleSwitch
                checked={settings.hostMetricsEnabled}
                label={translate('settings.preferences.hostMetricsLabel')}
                description={translate('settings.preferences.hostMetricsDescription')}
                onClick={() => {
                  void onUpdateSettings({
                    hostMetricsEnabled: !settings.hostMetricsEnabled,
                  });
                }}
              />
            </div>

            {/* 명령 완료 알림 — 관련 설정을 한 그룹 카드로 묶는다 */}
            <div className="mb-[1.1rem] grid gap-[0.7rem] rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_55%,transparent_45%)] p-[1.1rem]">
              <SectionLabel>Notifications</SectionLabel>
              <ToggleSwitch
                checked={settings.commandNotificationsEnabled}
                label={translate('settings.preferences.commandNotifyLabel')}
                description={translate('settings.preferences.commandNotifyDescription')}
                onClick={() => {
                  const next = !settings.commandNotificationsEnabled;
                  // 알림을 켤 때 OS 권한이 미결정이면 권한 요청 프롬프트를 유도한다.
                  if (
                    next &&
                    typeof window !== 'undefined' &&
                    'Notification' in window &&
                    typeof window.Notification?.requestPermission === 'function' &&
                    window.Notification.permission === 'default'
                  ) {
                    void window.Notification.requestPermission();
                  }
                  void onUpdateSettings({ commandNotificationsEnabled: next });
                }}
              />

              {settings.commandNotificationsEnabled ? (
                <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-[0.9rem] border-t border-[color-mix(in_srgb,var(--border)_60%,transparent_40%)] pt-[0.9rem] max-[760px]:grid-cols-1">
                  <FieldGroup label={translate('settings.preferences.notifyThresholdLabel')}>
                    <Input
                      aria-label={translate('settings.preferences.notifyThresholdLabel')}
                      type="number"
                      min={COMMAND_NOTIFICATION_THRESHOLD_MIN_SECONDS}
                      max={COMMAND_NOTIFICATION_THRESHOLD_MAX_SECONDS}
                      step={5}
                      value={settings.commandNotificationThresholdSeconds}
                      onChange={async (event) =>
                        onUpdateSettings({
                          commandNotificationThresholdSeconds: Number(
                            event.target.value,
                          ),
                        })
                      }
                    />
                    <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                      {translate('settings.preferences.notifyThresholdHint')}
                    </p>
                  </FieldGroup>

                  <ToggleSwitch
                    checked={settings.commandNotificationOnlyWhenUnfocused}
                    label={translate('settings.preferences.notifyOnlyInactiveLabel')}
                    description={translate('settings.preferences.notifyOnlyInactiveDescription')}
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationOnlyWhenUnfocused:
                          !settings.commandNotificationOnlyWhenUnfocused,
                      });
                    }}
                  />

                  <ToggleSwitch
                    checked={settings.commandNotificationOnFailure}
                    label={translate('settings.preferences.notifyFailuresLabel')}
                    description={translate('settings.preferences.notifyFailuresDescription')}
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationOnFailure:
                          !settings.commandNotificationOnFailure,
                      });
                    }}
                  />

                  <ToggleSwitch
                    checked={settings.commandNotificationSound}
                    label={translate('settings.preferences.notifySoundLabel')}
                    description={translate('settings.preferences.notifySoundDescription')}
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationSound:
                          !settings.commandNotificationSound,
                      });
                    }}
                  />
                </div>
              ) : null}
            </div>


            {/* 자동 재연결 — 끊김 시 백오프 재연결 동작 제어 */}
            <div className="mb-[1.1rem] grid gap-[0.7rem] rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_55%,transparent_45%)] p-[1.1rem]">
              <SectionLabel>Auto-Reconnect</SectionLabel>
              <ToggleSwitch
                checked={settings.autoReconnectEnabled}
                label={translate('settings.preferences.autoReconnectLabel')}
                description={translate('settings.preferences.autoReconnectDescription')}
                onClick={() => {
                  void onUpdateSettings({
                    autoReconnectEnabled: !settings.autoReconnectEnabled,
                  });
                }}
              />

              {settings.autoReconnectEnabled ? (
                <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-[0.9rem] border-t border-[color-mix(in_srgb,var(--border)_60%,transparent_40%)] pt-[0.9rem] max-[760px]:grid-cols-1">
                  <FieldGroup label={translate('settings.preferences.maxRetriesLabel')}>
                    <Input
                      aria-label={translate('settings.preferences.maxRetriesLabel')}
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={settings.autoReconnectMaxAttempts}
                      onChange={async (event) =>
                        onUpdateSettings({
                          autoReconnectMaxAttempts: Number(event.target.value),
                        })
                      }
                    />
                    <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                      {translate('settings.preferences.maxRetriesHint')}
                    </p>
                  </FieldGroup>

                  <FieldGroup label={translate('settings.preferences.maxRetryDelayLabel')}>
                    <Input
                      aria-label={translate('settings.preferences.maxRetryDelayLabel')}
                      type="number"
                      min={1}
                      max={300}
                      step={1}
                      value={Math.round(settings.autoReconnectMaxDelayMs / 1000)}
                      onChange={async (event) =>
                        onUpdateSettings({
                          autoReconnectMaxDelayMs:
                            Number(event.target.value) * 1000,
                        })
                      }
                    />
                    <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                      {translate('settings.preferences.maxRetryDelayHint')}
                    </p>
                  </FieldGroup>
                </div>
              ) : null}
            </div>

            <div className="mb-4">
              <div>
                <SectionLabel>General</SectionLabel>
                <h3>{translate('settings.language.title')}</h3>
              </div>
            </div>
            <div className="grid items-start grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1">
              <FieldGroup label={translate('settings.language.title')}>
                <SelectField
                  aria-label={translate('settings.language.title')}
                  value={settings.language ?? 'system'}
                  onChange={async (event) =>
                    onUpdateSettings({
                      language: event.target.value as AppLanguage,
                    })
                  }
                >
                  {APP_LANGUAGE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === 'system'
                        ? translate('settings.language.system')
                        : LANGUAGE_LABELS[option]}
                    </option>
                  ))}
                </SelectField>
                {(settings.language ?? 'system') === 'system' ? null : (
                  <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                    {translate('settings.language.reopenNote')}
                  </p>
                )}
              </FieldGroup>
            </div>

            <div className="mb-4 mt-6">
              <div>
                <SectionLabel>Appearance</SectionLabel>
                <h3>Theme</h3>
              </div>
            </div>
            <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-[0.9rem] max-[1320px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[760px]:grid-cols-1">
              {themeOptions.map((option) => (
                <OptionCard
                  key={option.value}
                  active={settings.theme === option.value}
                  title={option.title}
                  description={translate(option.descriptionKey)}
                  preview={renderAppearanceThemePreview(option.value)}
                  onClick={async () => onUpdateSettings({ theme: option.value })}
                />
              ))}
            </div>
          </section>

          <section className="rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
            <div className="mb-4 mt-1">
              <div>
                <SectionLabel>Terminal</SectionLabel>
                <h3>Terminal Theme</h3>
              </div>
            </div>
            <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-[0.9rem] max-[1320px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[760px]:grid-cols-1">
              <OptionCard
                aria-label="Terminal Theme: System"
                active={settings.globalTerminalThemeId === 'system'}
                title="System"
                onClick={async () => handleChangeTerminalTheme('system')}
                preview={renderTerminalThemePreview(
                  renderTerminalThemePreviewChrome('#2468ff'),
                  'linear-gradient(135deg, #f5f7fb 0%, #f5f7fb 50%, #0b1220 50%, #0b1220 100%)',
                  '#243041',
                )}
              />
              {terminalThemePresets.map((option) => (
                <OptionCard
                  key={option.id}
                  active={settings.globalTerminalThemeId === option.id}
                  title={option.title}
                  onClick={async () => handleChangeTerminalTheme(option.id)}
                  preview={renderTerminalThemePreview(
                    renderTerminalThemePreviewChrome(option.preview.accent),
                    option.preview.background,
                    option.preview.foreground,
                  )}
                />
              ))}
            </div>
          </section>
        </>
      ) : null}

      {activeSection === 'account' ? (
        <>
          <section className="rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
            <div className="mb-4">
              <div>
                <h3>Account</h3>
              </div>
            </div>
            <dl className="mb-4 grid gap-[0.9rem]">
              <div className="grid gap-1 rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-4 py-[0.9rem]">
                <dt className="text-[0.82rem] text-[var(--text-soft)]">Email</dt>
                <dd className="m-0 break-all text-[var(--text)]">{currentUserEmail ?? '—'}</dd>
              </div>
              <div className="grid gap-1 rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-4 py-[0.9rem]">
                <dt className="text-[0.82rem] text-[var(--text-soft)]">Server</dt>
                <dd className="m-0 break-all text-[var(--text)]">{settings.serverUrl || '—'}</dd>
              </div>
            </dl>
            {accountPasswordNotice ? (
              <p className="m-0 mb-3 text-sm text-[var(--text-soft)]">
                {accountPasswordNotice}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {onChangeAccountPassword &&
              (passwordState === 'unset' || passwordState === 'set') ? (
                <Button variant="secondary" onClick={openAccountPasswordDialog}>
                  {translate(passwordState === 'set' ? 'settings.account.changePassword' : 'settings.account.setPassword')}
                </Button>
              ) : null}
              <Button variant="danger" onClick={async () => onLogout()}>
                {translate('settings.account.logout')}
              </Button>
              {onDeleteAccount ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDeleteAccountError(null);
                    setDeleteAccountOpen(true);
                  }}
                >
                  {translate('settings.account.deleteAccount')}
                </Button>
              ) : null}
            </div>
          </section>

          {webauthnSupported && onAddPasskey ? (
            <section className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
              <div className="mb-4">
                <h3>{translate('settings.passkey.title')}</h3>
              </div>
              <p className="m-0 mb-4 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                {translate('settings.passkey.intro')}
              </p>
              {passkeyError ? (
                <p role="alert" className="m-0 mb-3 text-sm text-[var(--danger-text)]">
                  {passkeyError}
                </p>
              ) : null}
              {passkeys.length > 0 ? (
                <ul className="m-0 mb-4 grid list-none gap-[0.6rem] p-0">
                  {passkeys.map((passkey) => (
                    <li
                      key={passkey.id}
                      className="flex items-center justify-between gap-3 rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-4 py-[0.7rem]"
                    >
                      <div className="grid gap-[0.15rem]">
                        <span className="break-all text-[var(--text)]">
                          {passkey.name || translate('settings.passkey.unnamed')}
                        </span>
                        <span className="text-[0.78rem] text-[var(--text-soft)]">
                          {translate('settings.passkey.registeredAt', { date: passkey.createdAt.slice(0, 10) })}
                        </span>
                        {/* 마지막 사용 시각. 등록만 되고 한 번도 안 쓰인 패스키를 드러내는 유일한
                            단서다 — 등록한 브라우저 프로필과 로그인하는 프로필이 다르면(크롬은
                            패스키를 프로필별로 저장한다) 서버에는 남고 로그인에서는 안 보인다.
                            이름·등록일만 있으면 쓰이는 것과 못 쓰는 것이 똑같아 보인다. */}
                        <span className="text-[0.78rem] text-[var(--text-soft)]">
                          {isPasskeyUnused(passkey)
                            ? translate('settings.passkey.neverUsed')
                            : translate('settings.passkey.lastUsedAt', {
                                date: passkey.lastUsedAt.slice(0, 10),
                              })}
                        </span>
                      </div>
                      <Button
                        variant="danger"
                        disabled={passkeyBusy}
                        onClick={() => handleDeletePasskey(passkey.id)}
                      >
                        {translate('settings.passkey.delete')}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 mb-4 text-[0.88rem] text-[var(--text-soft)]">
                  {translate(passkeysLoading ? 'settings.passkey.loading' : 'settings.passkey.empty')}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" disabled={passkeyBusy} onClick={handleAddPasskey}>
                  {translate('settings.passkey.add')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={passkeysLoading}
                  onClick={() => void loadPasskeys()}
                >
                  {translate('settings.passkey.refresh')}
                </Button>
              </div>
            </section>
          ) : null}

          {vaultStatus === 'unlocked' && onChangeVaultPassphrase ? (
            <section className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
              <div className="mb-4">
                <h3 className="flex items-center gap-2">
                  {translate('settings.vault.title')}
                  {/* "서버가 내 데이터를 볼 수 있나"에 답하는 자리. 잊었을 때의 절차는 아래
                      초기화 흐름이 이미 안내하므로 여기서는 원리만 말한다. */}
                  <InfoHint label={translate('settings.vault.aboutToggle')}>
                    <InfoHintPoints items={[translate('settings.vault.aboutE2ee')]} />
                  </InfoHint>
                </h3>
              </div>
              <p className="m-0 mb-4 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                {translate('settings.vault.isSet')}
              </p>
              {vaultPassphraseNotice ? (
                <p className="m-0 mb-3 text-sm text-[var(--text-soft)]">
                  {vaultPassphraseNotice}
                </p>
              ) : null}
              <Button variant="secondary" onClick={openVaultPassphraseDialog}>
                {translate('settings.vault.changePassphrase')}
              </Button>
              {onResetVault ? (
                <div className="mt-4 border-t border-[var(--border)] pt-3">
                  <button
                    type="button"
                    className="cursor-pointer border-none bg-transparent p-0 text-[0.82rem] font-semibold text-[var(--danger-text)]"
                    onClick={() => {
                      setVaultResetError(null);
                      setVaultResetOpen(true);
                    }}
                  >
                    {translate('settings.vault.forgot')}
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {vaultStatus === 'unlocked' &&
          vaultPassphraseOpen &&
          onChangeVaultPassphrase ? (
            <DialogBackdrop
              dismissDisabled={vaultPassphraseBusy}
              onDismiss={closeVaultPassphraseDialog}
            >
              <ModalShell
                size="sm"
                role="dialog"
                aria-modal="true"
                aria-labelledby="change-vault-passphrase-title"
              >
                <ModalHeader className="block">
                  <SectionLabel>Security</SectionLabel>
                  <h3 id="change-vault-passphrase-title">{translate('settings.vault.changeDialog.title')}</h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                    {translate('settings.vault.changeDialog.description')}
                  </p>
                  <Input
                    type="password"
                    value={currentVaultPassphrase}
                    placeholder={translate('settings.vault.changeDialog.current')}
                    aria-label={translate('settings.vault.changeDialog.current')}
                    onChange={(event) => setCurrentVaultPassphrase(event.target.value)}
                  />
                  <Input
                    type="password"
                    value={nextVaultPassphrase}
                    placeholder={translate('settings.vault.changeDialog.new')}
                    aria-label={translate('settings.vault.changeDialog.new')}
                    onChange={(event) => setNextVaultPassphrase(event.target.value)}
                  />
                  <Input
                    type="password"
                    value={confirmVaultPassphrase}
                    placeholder={translate('settings.vault.changeDialog.confirm')}
                    aria-label={translate('settings.vault.changeDialog.confirm')}
                    onChange={(event) => setConfirmVaultPassphrase(event.target.value)}
                  />
                  {newVaultPassphraseValidationMessage ? (
                    <p className="m-0 text-sm text-[var(--warning-text,var(--text-soft))]">
                      {newVaultPassphraseValidationMessage}
                    </p>
                  ) : null}
                  {vaultPassphraseError ? (
                    <p role="alert" className="m-0 text-sm text-[var(--danger-text)]">
                      {vaultPassphraseError}
                    </p>
                  ) : null}
                </ModalBody>
                <ModalFooter>
                  <Button
                    variant="secondary"
                    disabled={vaultPassphraseBusy}
                    onClick={closeVaultPassphraseDialog}
                  >
                    {translate('common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      vaultPassphraseBusy ||
                      !currentVaultPassphrase ||
                      getNewVaultPassphraseMessage(nextVaultPassphrase) !== null ||
                      nextVaultPassphrase !== confirmVaultPassphrase
                    }
                    onClick={() => void handleChangeVaultPassphrase()}
                  >
                    {translate(vaultPassphraseBusy ? 'settings.vault.changeDialog.submitting' : 'settings.vault.changeDialog.submit')}
                  </Button>
                </ModalFooter>
              </ModalShell>
            </DialogBackdrop>
          ) : null}

          {accountPasswordOpen &&
          onChangeAccountPassword &&
          (passwordState === 'unset' || passwordState === 'set') ? (
            <DialogBackdrop
              dismissDisabled={accountPasswordBusy}
              onDismiss={closeAccountPasswordDialog}
            >
              <ModalShell
                size="sm"
                role="dialog"
                aria-modal="true"
                aria-labelledby="change-account-password-title"
              >
                <ModalHeader className="block">
                  <SectionLabel>Account</SectionLabel>
                  <h3 id="change-account-password-title">
                    {passwordState === 'set'
                      ? translate('settings.accountPassword.changeTitle')
                      : translate('settings.accountPassword.setTitle')}
                  </h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                    {passwordState === 'set'
                      ? translate('settings.accountPassword.changeDescription')
                      : translate('settings.accountPassword.setDescription')}{' '}
                    {translate('settings.accountPassword.separateNote')}
                  </p>
                  {passwordState === 'set' ? (
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={currentAccountPassword}
                      placeholder={translate('settings.accountPassword.current')}
                      aria-label={translate('settings.accountPassword.currentAria')}
                      onChange={(event) => setCurrentAccountPassword(event.target.value)}
                    />
                  ) : null}
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={nextAccountPassword}
                    placeholder={translate('settings.accountPassword.new')}
                    aria-label={translate('settings.accountPassword.newAria')}
                    onChange={(event) => setNextAccountPassword(event.target.value)}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={confirmAccountPassword}
                    placeholder={translate('settings.accountPassword.confirm')}
                    aria-label={translate('settings.accountPassword.confirmAria')}
                    onChange={(event) => setConfirmAccountPassword(event.target.value)}
                  />
                  {accountPasswordValidationMessage ? (
                    <p className="m-0 text-sm text-[var(--warning-text,var(--text-soft))]">
                      {accountPasswordValidationMessage}
                    </p>
                  ) : null}
                  {accountPasswordError ? (
                    <p role="alert" className="m-0 text-sm text-[var(--danger-text)]">
                      {accountPasswordError}
                    </p>
                  ) : null}
                </ModalBody>
                <ModalFooter>
                  <Button
                    variant="secondary"
                    disabled={accountPasswordBusy}
                    onClick={closeAccountPasswordDialog}
                  >
                    {translate('common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      accountPasswordBusy ||
                      (passwordState === 'set' && !currentAccountPassword) ||
                      getAccountPasswordValidationMessage(nextAccountPassword) !== null ||
                      nextAccountPassword !== confirmAccountPassword
                    }
                    onClick={() => void handleChangeAccountPassword()}
                  >
                    {accountPasswordBusy
                      ? translate('settings.accountPassword.saving')
                      : passwordState === 'set'
                        ? translate('settings.accountPassword.change')
                        : translate('settings.accountPassword.set')}
                  </Button>
                </ModalFooter>
              </ModalShell>
            </DialogBackdrop>
          ) : null}

          {vaultStatus === 'unlocked' && vaultResetOpen && onResetVault ? (
            <DialogBackdrop
              dismissDisabled={vaultResetBusy}
              onDismiss={() => {
                if (!vaultResetBusy) {
                  setVaultResetOpen(false);
                }
              }}
            >
              <ModalShell
                size="sm"
                role="dialog"
                aria-modal="true"
                aria-labelledby="reset-vault-title"
              >
                <ModalHeader className="block">
                  <SectionLabel>Security</SectionLabel>
                  <h3 id="reset-vault-title">{translate('settings.vault.resetDialog.title')}</h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text)]">
                    <Trans i18nKey="settings.vault.resetDialog.warning" components={{ strong: <strong /> }} />
                  </p>
                  <p className="m-0 text-[0.82rem] leading-[1.55] text-[var(--text-soft)]">
                    {translate('settings.vault.resetDialog.localNote')}
                  </p>
                  {vaultResetError ? (
                    <p role="alert" className="m-0 text-sm text-[var(--danger-text)]">
                      {vaultResetError}
                    </p>
                  ) : null}
                </ModalBody>
                <ModalFooter>
                  <Button
                    variant="secondary"
                    disabled={vaultResetBusy}
                    onClick={() => setVaultResetOpen(false)}
                  >
                    {translate('common.cancel')}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={vaultResetBusy}
                    onClick={() => void handleResetVault()}
                  >
                    {translate(vaultResetBusy ? 'settings.vault.resetDialog.submitting' : 'settings.vault.resetDialog.submit')}
                  </Button>
                </ModalFooter>
              </ModalShell>
            </DialogBackdrop>
          ) : null}

          {deleteAccountOpen && onDeleteAccount ? (
            <DialogBackdrop
              onDismiss={() => {
                if (!deleteAccountBusy) {
                  setDeleteAccountOpen(false);
                }
              }}
            >
              <ModalShell role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
                <ModalHeader className="block">
                  <SectionLabel>Account</SectionLabel>
                  <h3 id="delete-account-title">{translate('settings.deleteAccount.title')}</h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text)]">
                    <Trans i18nKey="settings.deleteAccount.warning" components={{ strong: <strong /> }} />
                  </p>
                  <p className="m-0 text-[0.82rem] leading-[1.55] text-[var(--text-soft)]">
                    {translate('settings.deleteAccount.localNote')}
                  </p>
                  {deleteAccountError ? (
                    <p role="alert" className="m-0 text-sm text-[var(--danger-text)]">
                      {deleteAccountError}
                    </p>
                  ) : null}
                </ModalBody>
                <ModalFooter>
                  <Button
                    variant="secondary"
                    disabled={deleteAccountBusy}
                    onClick={() => setDeleteAccountOpen(false)}
                  >
                    {translate('common.cancel')}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={deleteAccountBusy}
                    onClick={async () => {
                      setDeleteAccountBusy(true);
                      setDeleteAccountError(null);
                      try {
                        await onDeleteAccount();
                        // 성공하면 세션이 정리되며 로그인 화면으로 전환된다(auth 이벤트).
                        setDeleteAccountOpen(false);
                      } catch (error) {
                        const fallback = translate('settings.deleteAccount.failed');
                        setDeleteAccountError(
                          normalizeErrorMessage(error, fallback) || fallback,
                        );
                      } finally {
                        setDeleteAccountBusy(false);
                      }
                    }}
                  >
                    {translate(deleteAccountBusy ? 'settings.deleteAccount.submitting' : 'settings.deleteAccount.submit')}
                  </Button>
                </ModalFooter>
              </ModalShell>
            </DialogBackdrop>
          ) : null}
        </>
      ) : null}

      {activeSection === 'sftp' ? (
        <section className="rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
          <div className="mb-4">
            <div>
              <SectionLabel>SFTP</SectionLabel>
              <h3>Transfer Defaults</h3>
            </div>
          </div>
          <div className="grid items-start grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1">
            <FieldGroup label="Conflict Policy">
              <SelectField
                value={settings.sftpConflictPolicy ?? 'ask'}
                onChange={async (event) =>
                  handleChangeSftpConflictPolicy(
                    event.target.value as SftpConflictPolicy,
                  )
                }
              >
                <option value="ask">Ask every time</option>
                <option value="overwrite">Overwrite</option>
                <option value="skip">Skip</option>
                <option value="keepBoth">Keep both</option>
              </SelectField>
            </FieldGroup>

            <FieldGroup label="Editor Max File Size (MB)">
              <Input
                aria-label="Editor max file size"
                type="number"
                min={1}
                max={50}
                step={1}
                value={settings.editorMaxFileSizeMB ?? 5}
                onChange={async (event) => {
                  const next = Number(event.target.value);
                  await onUpdateSettings({
                    editorMaxFileSizeMB: Number.isFinite(next)
                      ? Math.min(50, Math.max(1, Math.round(next)))
                      : 5,
                  });
                }}
              />
              <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                {translate('settings.transfer.editorMaxSizeHint')}
              </p>
            </FieldGroup>

            <ToggleSwitch
              checked={settings.sftpPreserveMtime ?? true}
              aria-label="Preserve modified time"
              label="Preserve modified time"
              description={translate('settings.transfer.preserveMtimeDescription')}
              onClick={() => {
                void onUpdateSettings({
                  sftpPreserveMtime: !(settings.sftpPreserveMtime ?? true),
                });
              }}
            />

            <ToggleSwitch
              checked={settings.sftpPreservePermissions ?? false}
              aria-label="Preserve permissions"
              label="Preserve permissions"
              description={translate('settings.transfer.preserveModeDescription')}
              onClick={() => {
                void onUpdateSettings({
                  sftpPreservePermissions: !(settings.sftpPreservePermissions ?? false),
                });
              }}
            />
          </div>
        </section>
      ) : null}

      {activeSection === 'security' ? (
        <KnownHostsPanel
          records={knownHosts}
          onRemove={onRemoveKnownHost}
          hosts={hosts}
          onRevokeRdpCertificate={onRevokeRdpCertificate}
        />
      ) : null}

      {activeSection === 'secrets' ? (
        <KeychainPanel
          entries={keychainEntries}
          hosts={hosts}
          searchQuery={savedCredentialsSearchQuery}
          onSearchQueryChange={onSavedCredentialsSearchQueryChange}
          onRemoveSecret={onRemoveSecret}
          onEditSecret={onEditSecret}
          onGenerateSshKey={onGenerateSshKey}
          onCopySshPublicKey={onCopySshPublicKey}
          onInstallSshPublicKey={onInstallSshPublicKey}
        />
      ) : null}

      {activeSection === 'aws-profiles' ? <AwsProfilesPanel hosts={hosts} /> : null}
      {activeSection === 'tailnet' ? <TailnetSettingsPanel /> : null}

      {activeSection === 'ai' ? (
        <AiSettingsPanel settings={settings.ai} onUpdateSettings={onUpdateSettings} />
      ) : null}
    </div>
  );
}
