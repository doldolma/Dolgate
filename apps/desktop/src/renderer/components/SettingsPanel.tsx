import type {
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
  MAX_SESSION_REPLAY_RETENTION_COUNT,
  MIN_SESSION_REPLAY_RETENTION_COUNT,
  validateAccountPassword,
  validateNewVaultPassphrase,
} from '@shared';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { SettingsSection } from '../store/createAppStore';
import { terminalFontOptions, terminalThemePresets } from '../lib/terminal-presets';
import { TMUX_PREFIX_KEY_OPTIONS } from '../lib/tmux-prefix';
import { DialogBackdrop } from './DialogBackdrop';
import { KeychainPanel } from './KeychainPanel';
import { KnownHostsPanel } from './KnownHostsPanel';
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
  SectionLabel,
  SelectField,
  TabButton,
  Tabs,
  ToggleSwitch,
} from '../ui';
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts';

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

const themeOptions: Array<{ value: AppTheme; title: string; description: string }> = [
  {
    value: 'system',
    title: 'System',
    description: '기기 라이트/다크 설정을 따라갑니다.'
  },
  {
    value: 'light',
    title: 'Light',
    description: '밝은 배경과 또렷한 대비를 사용합니다.'
  },
  {
    value: 'dark',
    title: 'Dark',
    description: '어두운 배경으로 눈부심을 줄입니다.'
  }
];

const fontSizeOptions = Array.from({ length: 8 }, (_, index) => index + 11);

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
  { id: 'ai', title: 'AI' }
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
        error instanceof Error ? error.message : '패스키 목록을 불러오지 못했습니다.',
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
        error instanceof Error ? error.message : '패스키 추가를 시작하지 못했습니다.',
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
        error instanceof Error ? error.message : '패스키 삭제에 실패했습니다.',
      );
    } finally {
      setPasskeyBusy(false);
    }
  }
  const accountPasswordValidationMessage = nextAccountPassword
    ? validateAccountPassword(nextAccountPassword)
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
    ? validateNewVaultPassphrase(nextVaultPassphrase)
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
          ? '로그인 비밀번호를 변경했습니다.'
          : '로그인 비밀번호를 설정했습니다.',
      );
    } catch (error) {
      const fallback = '로그인 비밀번호를 저장하지 못했습니다.';
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
      setVaultPassphraseNotice('동기화 암호를 변경했습니다.');
    } catch (error) {
      const fallback = '동기화 암호 변경에 실패했습니다.';
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
      const fallback = '동기화 볼트 초기화에 실패했습니다.';
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
                  보관할 터미널 히스토리 줄 수입니다.
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
                  문자 줄 간격을 조절합니다.
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
                  문자 사이 간격을 조금 더 넓힐 수 있습니다.
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
                  가독성이 낮은 색 조합을 자동으로 보정합니다.
                </p>
              </FieldGroup>

              <FieldGroup label="Session Replay Retention">
                <Input
                  aria-label="Session Replay Retention"
                  type="number"
                  min={MIN_SESSION_REPLAY_RETENTION_COUNT}
                  max={MAX_SESSION_REPLAY_RETENTION_COUNT}
                  step={10}
                  value={settings.sessionReplayRetentionCount}
                  onChange={async (event) =>
                    handleChangeSessionReplayRetentionCount(Number(event.target.value))
                  }
                />
                <p className="m-0 text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
                  로컬에 보관할 종료된 세션 replay 개수입니다.
                  {replayStorageUsage
                    ? ` 현재 ${replayStorageUsage.recordingCount}개 · ${formatStorageBytes(replayStorageUsage.totalBytes)} 사용 중.`
                    : ''}
                </p>
              </FieldGroup>

            </div>

            {/* 터미널 동작 토글 — 토글끼리 묶어 input과 높이가 섞이지 않게 한다 */}
            <div className="mb-[1.1rem] grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1">
              <ToggleSwitch
                checked={settings.terminalWebglEnabled}
                label="WebGL Renderer"
                description="지원되지 않는 환경에서는 자동으로 기본 렌더러로 전환합니다."
                onClick={() => {
                  void handleChangeTerminalWebglEnabled(!settings.terminalWebglEnabled);
                }}
              />

              <ToggleSwitch
                checked={settings.terminalAutocompleteEnabled}
                label="Command autocomplete"
                description="PATH·history에 더해 Fig 스펙·generator로 자동완성합니다. (SSM 에서는 일부 기능 제한)"
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
                  description="macOS에서 Option 키를 터미널 메타 키로 사용합니다."
                  onClick={() => {
                    void handleChangeTerminalAltIsMeta(!settings.terminalAltIsMeta);
                  }}
                />
              ) : null}

              <FieldGroup label="Tmux Prefix 키">
                <SelectField
                  value={settings.tmuxPrefixKey ?? 'C-b'}
                  onChange={async (event) =>
                    handleChangeTmuxPrefixKey(event.target.value)
                  }
                >
                  {TMUX_PREFIX_KEY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
                <p className="mt-1.5 text-[0.76rem] leading-relaxed text-[var(--text-muted)]">
                  tmux 제어 모드에서 prefix 다음 키를 네이티브 tmux 동작으로 매핑합니다.
                </p>
              </FieldGroup>
              <ToggleSwitch
                checked={settings.subshellReinjectEnabled !== false}
                label="서브셸 셸 통합 자동 복구"
                description="중첩 ssh·sudo su·docker exec 등 서브셸에 들어가면 셸 통합(명령 상태·현재 경로)을 자동으로 다시 설정합니다."
                onClick={() =>
                  void onUpdateSettings({
                    subshellReinjectEnabled:
                      settings.subshellReinjectEnabled === false,
                  })
                }
              />
            </div>

            {/* 명령 완료 알림 — 관련 설정을 한 그룹 카드로 묶는다 */}
            <div className="mb-[1.1rem] grid gap-[0.7rem] rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_55%,transparent_45%)] p-[1.1rem]">
              <SectionLabel>Notifications</SectionLabel>
              <ToggleSwitch
                checked={settings.commandNotificationsEnabled}
                label="명령 완료 알림"
                description="오래 걸리거나 실패한 명령이 끝나면 OS 알림으로 알려줍니다."
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
                  <FieldGroup label="알림 기준 시간(초)">
                    <Input
                      aria-label="알림 기준 시간(초)"
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
                      이 시간 이상 걸린 명령이 끝나면 알립니다.
                    </p>
                  </FieldGroup>

                  <ToggleSwitch
                    checked={settings.commandNotificationOnlyWhenUnfocused}
                    label="비활성 상태일 때만 알림"
                    description="앱을 보고 있고 해당 탭이 활성일 때는 알리지 않습니다."
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationOnlyWhenUnfocused:
                          !settings.commandNotificationOnlyWhenUnfocused,
                      });
                    }}
                  />

                  <ToggleSwitch
                    checked={settings.commandNotificationOnFailure}
                    label="실패한 명령은 항상 알림"
                    description="0이 아닌 종료 코드는 시간과 무관하게 알립니다."
                    onClick={() => {
                      void onUpdateSettings({
                        commandNotificationOnFailure:
                          !settings.commandNotificationOnFailure,
                      });
                    }}
                  />

                  <ToggleSwitch
                    checked={settings.commandNotificationSound}
                    label="알림 소리"
                    description="알림이 표시될 때 소리를 함께 재생합니다."
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
                label="자동 재연결"
                description="연결이 예기치 않게 끊기면 자동으로 다시 연결합니다 (SSH/Warpgate 터미널, SFTP, 포트포워딩)."
                onClick={() => {
                  void onUpdateSettings({
                    autoReconnectEnabled: !settings.autoReconnectEnabled,
                  });
                }}
              />

              {settings.autoReconnectEnabled ? (
                <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-[0.9rem] border-t border-[color-mix(in_srgb,var(--border)_60%,transparent_40%)] pt-[0.9rem] max-[760px]:grid-cols-1">
                  <FieldGroup label="최대 재시도 횟수">
                    <Input
                      aria-label="최대 재시도 횟수"
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
                      이 횟수만큼 실패하면 수동 재연결로 전환합니다.
                    </p>
                  </FieldGroup>

                  <FieldGroup label="최대 재시도 간격(초)">
                    <Input
                      aria-label="최대 재시도 간격(초)"
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
                      지수 백오프가 늘어날 수 있는 최대 간격입니다.
                    </p>
                  </FieldGroup>
                </div>
              ) : null}
            </div>

            <div className="mb-4">
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
                  description={option.description}
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

          <section className="rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
            <div className="mb-4">
              <div>
                <SectionLabel>Session</SectionLabel>
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
                  {passwordState === 'set' ? '비밀번호 변경' : '비밀번호 설정'}
                </Button>
              ) : null}
              <Button variant="danger" onClick={async () => onLogout()}>
                로그아웃
              </Button>
              {onDeleteAccount ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDeleteAccountError(null);
                    setDeleteAccountOpen(true);
                  }}
                >
                  회원 탈퇴
                </Button>
              ) : null}
            </div>
          </section>

          {webauthnSupported && onAddPasskey ? (
            <section className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
              <div className="mb-4">
                <SectionLabel>Session</SectionLabel>
                <h3>패스키</h3>
              </div>
              <p className="m-0 mb-4 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                생체 인증이나 보안 키로 비밀번호 없이 로그인합니다. “패스키 추가”를 누르면 브라우저에서
                등록을 마친 뒤 이 목록에 표시됩니다.
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
                          {passkey.name || '패스키'}
                        </span>
                        <span className="text-[0.78rem] text-[var(--text-soft)]">
                          등록 {passkey.createdAt.slice(0, 10)}
                        </span>
                      </div>
                      <Button
                        variant="danger"
                        disabled={passkeyBusy}
                        onClick={() => handleDeletePasskey(passkey.id)}
                      >
                        삭제
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 mb-4 text-[0.88rem] text-[var(--text-soft)]">
                  {passkeysLoading ? '불러오는 중…' : '등록된 패스키가 없습니다.'}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" disabled={passkeyBusy} onClick={handleAddPasskey}>
                  패스키 추가
                </Button>
                <Button
                  variant="ghost"
                  disabled={passkeysLoading}
                  onClick={() => void loadPasskeys()}
                >
                  새로고침
                </Button>
              </div>
            </section>
          ) : null}

          {vaultStatus === 'unlocked' && onChangeVaultPassphrase ? (
            <section className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
              <div className="mb-4">
                <SectionLabel>Session</SectionLabel>
                <h3>동기화 암호</h3>
              </div>
              <p className="m-0 mb-4 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                동기화 암호가 설정되어 있습니다. 잊지 않도록 안전하게 보관해 주세요.
              </p>
              {vaultPassphraseNotice ? (
                <p className="m-0 mb-3 text-sm text-[var(--text-soft)]">
                  {vaultPassphraseNotice}
                </p>
              ) : null}
              <Button variant="secondary" onClick={openVaultPassphraseDialog}>
                암호 변경
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
                    동기화 암호를 잊으셨나요? 초기화
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
                  <h3 id="change-vault-passphrase-title">동기화 암호 변경</h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                    현재 암호를 확인한 후 새 암호로 변경합니다.
                  </p>
                  <Input
                    type="password"
                    value={currentVaultPassphrase}
                    placeholder="현재 동기화 암호"
                    aria-label="현재 동기화 암호"
                    onChange={(event) => setCurrentVaultPassphrase(event.target.value)}
                  />
                  <Input
                    type="password"
                    value={nextVaultPassphrase}
                    placeholder="새 동기화 암호"
                    aria-label="새 동기화 암호"
                    onChange={(event) => setNextVaultPassphrase(event.target.value)}
                  />
                  <Input
                    type="password"
                    value={confirmVaultPassphrase}
                    placeholder="새 동기화 암호 확인"
                    aria-label="새 동기화 암호 확인"
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
                    취소
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      vaultPassphraseBusy ||
                      !currentVaultPassphrase ||
                      validateNewVaultPassphrase(nextVaultPassphrase) !== null ||
                      nextVaultPassphrase !== confirmVaultPassphrase
                    }
                    onClick={() => void handleChangeVaultPassphrase()}
                  >
                    {vaultPassphraseBusy ? '변경 중...' : '암호 변경'}
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
                      ? '계정 비밀번호 변경'
                      : '계정 비밀번호 설정'}
                  </h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text-soft)]">
                    {passwordState === 'set'
                      ? '현재 비밀번호를 확인한 후 새 비밀번호로 변경합니다.'
                      : '설정하면 현재 이메일로 비밀번호 로그인을 사용할 수 있습니다.'}{' '}
                    동기화 암호와는 별개입니다.
                  </p>
                  {passwordState === 'set' ? (
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={currentAccountPassword}
                      placeholder="현재 비밀번호"
                      aria-label="현재 계정 비밀번호"
                      onChange={(event) => setCurrentAccountPassword(event.target.value)}
                    />
                  ) : null}
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={nextAccountPassword}
                    placeholder="새 비밀번호"
                    aria-label="새 계정 비밀번호"
                    onChange={(event) => setNextAccountPassword(event.target.value)}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={confirmAccountPassword}
                    placeholder="새 비밀번호 확인"
                    aria-label="새 계정 비밀번호 확인"
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
                    취소
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      accountPasswordBusy ||
                      (passwordState === 'set' && !currentAccountPassword) ||
                      validateAccountPassword(nextAccountPassword) !== null ||
                      nextAccountPassword !== confirmAccountPassword
                    }
                    onClick={() => void handleChangeAccountPassword()}
                  >
                    {accountPasswordBusy
                      ? '저장 중...'
                      : passwordState === 'set'
                        ? '비밀번호 변경'
                        : '비밀번호 설정'}
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
                  <h3 id="reset-vault-title">동기화 초기화</h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text)]">
                    서버의 동기화 데이터가 <strong>모두 삭제</strong>되고, 새 동기화 암호
                    설정 화면으로 이동합니다. 이 작업은 되돌릴 수 없습니다.
                  </p>
                  <p className="m-0 text-[0.82rem] leading-[1.55] text-[var(--text-soft)]">
                    이 기기의 로컬 데이터(호스트·시크릿·스니펫)는 유지되며, 새 암호를
                    설정하면 다시 암호화되어 업로드됩니다. 다른 기기는 다음 동기화 때 새
                    암호 입력이 필요하고, 서버에만 있던 데이터는 복구할 수 없습니다.
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
                    취소
                  </Button>
                  <Button
                    variant="danger"
                    disabled={vaultResetBusy}
                    onClick={() => void handleResetVault()}
                  >
                    {vaultResetBusy ? '초기화 중...' : '서버 데이터 삭제하고 새로 시작'}
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
                  <h3 id="delete-account-title">회원 탈퇴</h3>
                </ModalHeader>
                <ModalBody className="grid gap-3">
                  <p className="m-0 text-[0.88rem] leading-[1.6] text-[var(--text)]">
                    서버에 저장된 모든 데이터(동기화된 호스트·시크릿·스니펫·계정 정보)가{' '}
                    <strong>즉시 영구 삭제</strong>됩니다. 복구할 수 없으며, 로그인된 다른
                    기기도 곧 로그아웃됩니다.
                  </p>
                  <p className="m-0 text-[0.82rem] leading-[1.55] text-[var(--text-soft)]">
                    이 기기의 로컬 데이터(호스트·시크릿·세션 리플레이·활동 로그·AI 키)도 함께
                    삭제됩니다.
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
                    취소
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
                        const fallback = '회원 탈퇴에 실패했습니다.';
                        setDeleteAccountError(
                          normalizeErrorMessage(error, fallback) || fallback,
                        );
                      } finally {
                        setDeleteAccountBusy(false);
                      }
                    }}
                  >
                    {deleteAccountBusy ? '탈퇴 중...' : '탈퇴'}
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
                이 크기 이하의 텍스트 파일만 내장 편집기로 열 수 있습니다.
              </p>
            </FieldGroup>

            <ToggleSwitch
              checked={settings.sftpPreserveMtime ?? true}
              aria-label="Preserve modified time"
              label="Preserve modified time"
              description="전송 완료 후 원본 수정 시간을 대상 파일에 적용합니다."
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
              description="가능한 경우 원본 권한 비트를 대상 파일에 적용합니다."
              onClick={() => {
                void onUpdateSettings({
                  sftpPreservePermissions: !(settings.sftpPreservePermissions ?? false),
                });
              }}
            />
          </div>
        </section>
      ) : null}

      {activeSection === 'security' ? <KnownHostsPanel records={knownHosts} onRemove={onRemoveKnownHost} /> : null}

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

      {activeSection === 'ai' ? (
        <AiSettingsPanel settings={settings.ai} onUpdateSettings={onUpdateSettings} />
      ) : null}
    </div>
  );
}
