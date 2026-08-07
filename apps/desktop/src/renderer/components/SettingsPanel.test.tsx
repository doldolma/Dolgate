import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } from '@shared';
import type { AppSettings, HostRecord, SecretMetadataRecord } from '@shared';
import { SettingsPanel } from './SettingsPanel';

const settingsServiceMocks = vi.hoisted(() => ({
  copySavedCredentialPassword: vi.fn(),
}));

vi.mock('../services/desktop/settings', () => ({
  copySavedCredentialPassword: settingsServiceMocks.copySavedCredentialPassword,
}));

const settings: AppSettings = {
  theme: 'system',
  tailnetHostname: null,
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: 'sf-mono',
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  terminalAutocompleteEnabled: false,
  sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
  sessionReplayRetentionCount: 100,
  commandNotificationsEnabled: true,
  commandNotificationThresholdSeconds: 30,
  commandNotificationOnlyWhenUnfocused: true,
  commandNotificationOnFailure: true,
  commandNotificationSound: false,
  hostMetricsEnabled: false,
  autoReconnectEnabled: true,
  autoReconnectMaxAttempts: 10,
  autoReconnectBaseDelayMs: 1000,
  autoReconnectMaxDelayMs: 30000,
  serverUrl: 'https://ssh.doldolma.com',
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: '2026-03-24T00:00:00.000Z'
};

const knownHosts = [
  {
    id: 'known-host-1',
    host: 'nas.example.com',
    hostLabel: 'nas',
    port: 22,
    algorithm: 'ssh-ed25519',
    publicKeyBase64: 'AAAAB3NzaC1lZDI1NTE5AAAAI',
    fingerprintSha256: 'SHA256:abcdef',
    lastSeenAt: '2026-03-24T12:00:00.000Z',
    createdAt: '2026-03-24T10:00:00.000Z',
    updatedAt: '2026-03-24T12:00:00.000Z'
  }
];

const keychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret-1',
    label: 'Prod password',
    linkedHostCount: 2,
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    updatedAt: '2026-03-24T12:00:00.000Z'
  }
];

const searchableKeychainEntries: SecretMetadataRecord[] = [
  ...keychainEntries,
  {
    secretRef: 'secret-backup',
    label: 'Backup private key',
    linkedHostCount: 0,
    hasPassword: false,
    hasPassphrase: false,
    hasManagedPrivateKey: true,
    hasCertificate: false,
    updatedAt: '2026-03-24T12:00:00.000Z',
  },
  {
    secretRef: 'secret-cert',
    label: 'Prod cert',
    linkedHostCount: 1,
    hasPassword: false,
    hasPassphrase: true,
    hasManagedPrivateKey: true,
    hasCertificate: true,
    updatedAt: '2026-03-24T12:00:00.000Z',
  },
  {
    secretRef: 'secret-lime',
    label: 'Shared credentials',
    linkedHostCount: 1,
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    updatedAt: '2026-03-24T12:00:00.000Z',
  },
  {
    secretRef: 'secret-asan',
    label: '아산 password',
    linkedHostCount: 0,
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    updatedAt: '2026-03-24T12:00:00.000Z',
  },
];

const hosts: HostRecord[] = [
  {
    id: 'aws-host-1',
    kind: 'aws-ec2',
    label: 'aws-bastion',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-1234567890',
    awsAvailabilityZone: 'ap-northeast-2a',
    awsInstanceName: 'bastion',
    awsPlatform: 'Linux/UNIX',
    awsPrivateIp: '10.0.0.10',
    awsState: 'running',
    awsSshUsername: 'ubuntu',
    awsSshPort: 22,
    awsSshMetadataStatus: 'ready',
    awsSshMetadataError: null,
    groupName: 'Servers',
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-03-24T10:00:00.000Z',
    updatedAt: '2026-03-24T12:00:00.000Z'
  },
  {
    id: 'ssh-lime',
    kind: 'ssh',
    label: 'Lime prod',
    hostname: 'lime.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    privateKeyPath: null,
    certificatePath: null,
    secretRef: 'secret-lime',
    groupName: 'Servers/Prod',
    tags: ['lime'],
    terminalThemeId: null,
    createdAt: '2026-03-24T10:00:00.000Z',
    updatedAt: '2026-03-24T12:00:00.000Z'
  }
];

function renderSettingsPanel(
  overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {},
  options: { interactiveSection?: boolean } = {},
) {
  const onUpdateSettings = vi.fn().mockResolvedValue(undefined);
  const onSelectSection = vi.fn();
  const onSavedCredentialsSearchQueryChange = vi.fn();
  const onRemoveKnownHost = vi.fn().mockResolvedValue(undefined);
  const onRemoveSecret = vi.fn().mockResolvedValue(undefined);
  const onEditSecret = vi.fn();
  const onGenerateSshKey = vi.fn().mockResolvedValue({
    secretRef: 'secret-generated',
    label: 'Generated SSH Key',
    algorithm: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAATEST generated',
    fingerprintSha256: 'SHA256:test',
  });
  const onCopySshPublicKey = vi.fn().mockResolvedValue(undefined);
  const onInstallSshPublicKey = vi.fn().mockResolvedValue({
    secretRef: 'secret-generated',
    mode: 'installOnly',
    results: [],
  });
  const onLogout = vi.fn();
  const {
    activeSection: initialActiveSection = 'general',
    savedCredentialsSearchQuery: initialSavedCredentialsSearchQuery = '',
    onSelectSection: overrideOnSelectSection,
    onSavedCredentialsSearchQueryChange:
      overrideOnSavedCredentialsSearchQueryChange,
    ...restOverrides
  } = overrides;
  const handleSelectSection = overrideOnSelectSection ?? onSelectSection;
  const handleSavedCredentialsSearchQueryChange =
    overrideOnSavedCredentialsSearchQueryChange ??
    onSavedCredentialsSearchQueryChange;

  function SettingsPanelHarness() {
    const [activeSection, setActiveSection] = useState(initialActiveSection);
    const [savedCredentialsSearchQuery, setSavedCredentialsSearchQuery] =
      useState(initialSavedCredentialsSearchQuery);

    return (
      <SettingsPanel
        activeSection={options.interactiveSection ? activeSection : initialActiveSection}
        settings={settings}
        hosts={hosts}
        knownHosts={knownHosts}
        keychainEntries={keychainEntries}
        savedCredentialsSearchQuery={savedCredentialsSearchQuery}
        currentUserEmail="user@example.com"
        desktopPlatform="darwin"
        onSelectSection={(section) => {
          handleSelectSection(section);
          if (options.interactiveSection) {
            setActiveSection(section);
          }
        }}
        onSavedCredentialsSearchQueryChange={(query) => {
          handleSavedCredentialsSearchQueryChange(query);
          setSavedCredentialsSearchQuery(query);
        }}
        onUpdateSettings={onUpdateSettings}
        onRemoveKnownHost={onRemoveKnownHost}
        onRemoveSecret={onRemoveSecret}
        onEditSecret={onEditSecret}
        onGenerateSshKey={onGenerateSshKey}
        onCopySshPublicKey={onCopySshPublicKey}
        onInstallSshPublicKey={onInstallSshPublicKey}
        onLogout={onLogout}
        {...restOverrides}
      />
    );
  }

  render(<SettingsPanelHarness />);

  return {
    onUpdateSettings,
    onSelectSection: handleSelectSection,
    onSavedCredentialsSearchQueryChange:
      handleSavedCredentialsSearchQueryChange,
    onRemoveKnownHost,
    onRemoveSecret,
    onEditSecret,
    onGenerateSshKey,
    onCopySshPublicKey,
    onInstallSshPublicKey,
    onLogout
  };
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    settingsServiceMocks.copySavedCredentialPassword.mockReset();
    settingsServiceMocks.copySavedCredentialPassword.mockResolvedValue(undefined);
  });

  it('renders appearance theme cards with descriptions', () => {
    renderSettingsPanel();

    expect(screen.getByText('기기 라이트/다크 설정을 따라갑니다.')).toBeInTheDocument();
    expect(screen.getByText('밝은 배경과 또렷한 대비를 사용합니다.')).toBeInTheDocument();
    expect(screen.getByText('어두운 배경으로 눈부심을 줄입니다.')).toBeInTheDocument();
  });

  it('언어를 고르면 설정에 저장한다', () => {
    const { onUpdateSettings } = renderSettingsPanel();

    const select = screen.getByRole('combobox', { name: '언어' });
    // 기본값은 시스템 언어 따르기.
    expect(select).toHaveValue('system');

    fireEvent.change(select, { target: { value: 'en' } });

    expect(onUpdateSettings).toHaveBeenCalledWith({ language: 'en' });
  });

  // 시스템 따르기는 설명이 필요 없다. 명시 선택했을 때만 이미 열린 창을 다시 열어야 한다는
  // 안내가 뜬다.
  it('언어를 직접 고른 경우에만 창 재오픈 안내를 보여 준다', () => {
    const note = '이미 열려 있는 리플레이·공유 창은 다시 열어야 새 언어로 표시됩니다.';

    renderSettingsPanel();
    expect(screen.queryByText(note)).not.toBeInTheDocument();

    cleanup();
    renderSettingsPanel({ settings: { ...settings, language: 'en' } });
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('언어 이름은 그 언어로 보여 준다', () => {
    renderSettingsPanel({ settings: { ...settings, language: 'en' } });

    const select = screen.getByRole('combobox', { name: '언어' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['시스템 설정', '한국어', 'English']);
  });

  it('shows Appearance before Terminal Theme in the general settings flow', () => {
    renderSettingsPanel();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

    // 언어 → 테마 → 터미널 테마. 테마 두 블록이 붙어 있어야 하고, 언어가 그 사이를 갈라
    // 놓으면 안 된다.
    const language = headings.indexOf('언어');
    const theme = headings.indexOf('Theme');
    const terminalTheme = headings.indexOf('Terminal Theme');

    expect(language).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(-1);
    expect(terminalTheme).toBeGreaterThan(-1);
    expect(language).toBeLessThan(theme);
    expect(theme).toBeLessThan(terminalTheme);
  });

  it('offers a System terminal theme option that updates the global theme mode', () => {
    const { onUpdateSettings } = renderSettingsPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Terminal Theme: System' }));

    expect(onUpdateSettings).toHaveBeenCalledWith({ globalTerminalThemeId: 'system' });
  });

  it('renders and updates the WebGL renderer toggle', () => {
    const { onUpdateSettings } = renderSettingsPanel();

    const toggle = screen.getByRole('switch', { name: 'WebGL Renderer' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('지원되지 않는 환경에서는 자동으로 기본 렌더러로 전환합니다.')).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalWebglEnabled: false });
  });

  it('keeps command autocomplete opt-in', () => {
    const { onUpdateSettings } = renderSettingsPanel();

    const toggle = screen.getByRole('switch', { name: 'Command autocomplete' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(onUpdateSettings).toHaveBeenCalledWith({
      terminalAutocompleteEnabled: true,
    });
  });

  it('renders extended terminal controls and updates numeric settings', () => {
    const { onUpdateSettings } = renderSettingsPanel();

    fireEvent.change(screen.getByLabelText('Scrollback'), { target: { value: '6400' } });
    fireEvent.change(screen.getByLabelText('Line Height'), { target: { value: '1.2' } });
    fireEvent.change(screen.getByLabelText('Letter Spacing'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Minimum Contrast'), { target: { value: '3' } });
    // 보관 개수는 blur(포커스 아웃) 시에만 커밋된다(타이핑 도중 저장/prune 방지).
    const replayInput = screen.getByLabelText('Session Replay Retention');
    fireEvent.change(replayInput, { target: { value: '250' } });
    fireEvent.blur(replayInput);
    fireEvent.click(screen.getByRole('switch', { name: 'Use Option/Alt as Meta' }));

    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalScrollbackLines: 6400 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalLineHeight: 1.2 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalLetterSpacing: 1 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalMinimumContrastRatio: 3 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ sessionReplayRetentionCount: 250 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalAltIsMeta: true });
  });

  it('does not persist session replay retention mid-typing, only the final value on blur', () => {
    const { onUpdateSettings } = renderSettingsPanel();
    const replayInput = screen.getByLabelText('Session Replay Retention');

    // 타이핑 중간값("5")은 저장되면 안 된다. 저장되면 그 순간 replay가 5개로 prune되어
    // 나머지가 삭제되는 데이터 손실이 발생하기 때문.
    fireEvent.change(replayInput, { target: { value: '5' } });
    expect(onUpdateSettings).not.toHaveBeenCalled();

    // 계속 입력해 최종값에 도달한 뒤 blur → 최종값만 저장된다(중간 저장 없음).
    fireEvent.change(replayInput, { target: { value: '5000' } });
    expect(onUpdateSettings).not.toHaveBeenCalled();

    fireEvent.blur(replayInput);
    expect(onUpdateSettings).toHaveBeenCalledTimes(1);
    expect(onUpdateSettings).toHaveBeenCalledWith({ sessionReplayRetentionCount: 5000 });
  });

  it('hides mac-only terminal fonts on Windows', () => {
    renderSettingsPanel({
      settings: { ...settings, terminalFontFamily: 'consolas' },
      desktopPlatform: 'win32'
    });

    // The font picker is a custom listbox — options only exist once opened.
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }));

    expect(screen.queryByRole('option', { name: 'SF Mono' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Menlo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Monaco' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Consolas' })).toBeInTheDocument();
  });

  it('switches settings subsections from the tab bar', () => {
    const { onSelectSection } = renderSettingsPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Security' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Saved Credentials' }));
    fireEvent.click(screen.getByRole('tab', { name: 'AWS Profiles' }));

    expect(onSelectSection).toHaveBeenCalledWith('security');
    expect(onSelectSection).toHaveBeenCalledWith('secrets');
    expect(onSelectSection).toHaveBeenCalledWith('aws-profiles');
  });

  it('renders known hosts inside the security section', () => {
    const { onRemoveKnownHost } = renderSettingsPanel({ activeSection: 'security' });

    expect(screen.getByRole('heading', { name: 'Known Hosts' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onRemoveKnownHost).toHaveBeenCalledWith('known-host-1');
  });

  it('renders keychain entries inside the secrets section', async () => {
    const { onEditSecret, onRemoveSecret } = renderSettingsPanel({ activeSection: 'secrets' });

    expect(screen.getByText(/호스트가 사용하는 비밀번호/)).toBeInTheDocument();
    expect(screen.queryByText('local_keychain')).not.toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 복사' }));
    fireEvent.click(screen.getByRole('button', { name: '편집' }));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => {
      expect(settingsServiceMocks.copySavedCredentialPassword).toHaveBeenCalledWith('secret-1');
      expect(screen.getByText('비밀번호를 클립보드에 복사했습니다.')).toBeInTheDocument();
    });
    expect(onEditSecret).toHaveBeenCalledWith('secret-1');
    expect(onRemoveSecret).toHaveBeenCalledWith('secret-1');
  });

  it('shows an error when saved password copy fails', async () => {
    settingsServiceMocks.copySavedCredentialPassword.mockRejectedValueOnce(
      new Error('이 인증 정보에는 저장된 비밀번호가 없습니다.'),
    );

    renderSettingsPanel({ activeSection: 'secrets' });

    fireEvent.click(screen.getByRole('button', { name: '비밀번호 복사' }));

    expect(
      await screen.findByText('이 인증 정보에는 저장된 비밀번호가 없습니다.'),
    ).toBeInTheDocument();
  });

  it('generates SSH keys with selected algorithm, cipher, rounds, and passphrase policy', async () => {
    const { onGenerateSshKey } = renderSettingsPanel({ activeSection: 'secrets' });

    fireEvent.click(screen.getByRole('button', { name: 'Generate SSH Key' }));

    expect(screen.getByRole('button', { name: 'ED25519' })).toHaveClass(
      'text-[var(--accent-strong)]',
    );
    fireEvent.change(screen.getByLabelText('Label'), {
      target: { value: 'NAS key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ECDSA' }));
    expect(screen.getByText('Elliptic curve size (bits)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '384' }));
    fireEvent.change(screen.getByLabelText('Passphrase'), {
      target: { value: 'secret-passphrase' },
    });
    expect(screen.getByText('Cipher')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'AES-256 CBC' }));
    fireEvent.change(screen.getByLabelText('Rounds'), {
      target: { value: '128' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Save passphrase' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() =>
      expect(onGenerateSshKey).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'NAS key',
          algorithm: 'ecdsa',
          curve: 'nistp384',
          privateKeyCipher: 'aes256-cbc',
          kdfRounds: 128,
          passphrase: 'secret-passphrase',
          savePassphrase: true,
        }),
      ),
    );
  });

  it('passes a transient passphrase when installing an encrypted key without a saved passphrase', async () => {
    const { onInstallSshPublicKey } = renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: [
        {
          secretRef: 'secret-encrypted',
          label: 'Encrypted SSH key',
          linkedHostCount: 0,
          hasPassword: false,
          hasPassphrase: false,
          hasManagedPrivateKey: true,
          hasCertificate: false,
          privateKeyEncrypted: true,
          keyAlgorithm: 'ssh-ed25519',
          passphraseSaved: false,
          updatedAt: '2026-03-24T12:00:00.000Z',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '호스트에 설치' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Lime prod/ }));
    fireEvent.change(screen.getByLabelText('Key passphrase'), {
      target: { value: 'runtime-only' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() =>
      expect(onInstallSshPublicKey).toHaveBeenCalledWith({
        secretRef: 'secret-encrypted',
        hostIds: ['ssh-lime'],
        mode: 'installOnly',
        passphraseOverride: 'runtime-only',
      }),
    );
  });

  it('installs a managed key to an EC2 host from the keychain', async () => {
    const { onInstallSshPublicKey } = renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: [
        {
          secretRef: 'secret-managed',
          label: 'Managed SSH key',
          linkedHostCount: 0,
          hasPassword: false,
          hasPassphrase: false,
          hasManagedPrivateKey: true,
          hasCertificate: false,
          privateKeyEncrypted: false,
          keyAlgorithm: 'ssh-ed25519',
          passphraseSaved: false,
          updatedAt: '2026-03-24T12:00:00.000Z',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '호스트에 설치' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /aws-bastion/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() =>
      expect(onInstallSshPublicKey).toHaveBeenCalledWith({
        secretRef: 'secret-managed',
        hostIds: ['aws-host-1'],
        mode: 'installOnly',
        passphraseOverride: undefined,
      }),
    );
  });

  it('deletes the account only after the confirm dialog is accepted', async () => {
    const onDeleteAccount = vi.fn().mockResolvedValue(undefined);
    renderSettingsPanel({ onDeleteAccount, activeSection: 'account' });

    fireEvent.click(screen.getByRole('button', { name: '회원 탈퇴' }));
    expect(onDeleteAccount).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '탈퇴' }));
    await waitFor(() => expect(onDeleteAccount).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('keeps the delete-account dialog open with the error when deletion fails', async () => {
    const onDeleteAccount = vi.fn().mockRejectedValue(new Error('서버 오류가 발생했습니다.'));
    renderSettingsPanel({ onDeleteAccount, activeSection: 'account' });

    fireEvent.click(screen.getByRole('button', { name: '회원 탈퇴' }));
    fireEvent.click(screen.getByRole('button', { name: '탈퇴' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('서버 오류가 발생했습니다.'),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('changes an existing account password after confirming the current password', async () => {
    const onChangeAccountPassword = vi.fn().mockResolvedValue(undefined);
    renderSettingsPanel({ passwordState: 'set', onChangeAccountPassword, activeSection: 'account' });

    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }));
    const dialog = screen.getByRole('dialog', { name: '계정 비밀번호 변경' });
    fireEvent.change(within(dialog).getByLabelText('현재 계정 비밀번호'), {
      target: { value: 'old-password' },
    });
    fireEvent.change(within(dialog).getByLabelText('새 계정 비밀번호'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(within(dialog).getByLabelText('새 계정 비밀번호 확인'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '비밀번호 변경' }));

    await waitFor(() =>
      expect(onChangeAccountPassword).toHaveBeenCalledWith(
        'old-password',
        'new-password',
      ),
    );
    expect(await screen.findByText('로그인 비밀번호를 변경했습니다.')).toBeInTheDocument();
  });

  it('sets an OIDC-only account password without asking for a current password', async () => {
    const onChangeAccountPassword = vi.fn().mockResolvedValue(undefined);
    renderSettingsPanel({ passwordState: 'unset', onChangeAccountPassword, activeSection: 'account' });

    fireEvent.click(screen.getByRole('button', { name: '비밀번호 설정' }));
    const dialog = screen.getByRole('dialog', { name: '계정 비밀번호 설정' });
    expect(
      within(dialog).queryByLabelText('현재 계정 비밀번호'),
    ).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('새 계정 비밀번호'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(within(dialog).getByLabelText('새 계정 비밀번호 확인'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '비밀번호 설정' }));

    await waitFor(() =>
      expect(onChangeAccountPassword).toHaveBeenCalledWith('', 'new-password'),
    );
  });

  it('resets the sync vault only after the confirm dialog is accepted', async () => {
    const onResetVault = vi.fn().mockResolvedValue(undefined);
    renderSettingsPanel({
      activeSection: 'account',
      vaultStatus: 'unlocked',
      onChangeVaultPassphrase: vi.fn().mockResolvedValue(undefined),
      onResetVault,
    });

    fireEvent.click(
      screen.getByRole('button', { name: '동기화 암호를 잊으셨나요? 초기화' }),
    );
    expect(onResetVault).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '동기화 초기화' })).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: '서버 데이터 삭제하고 새로 시작' }),
    );
    await waitFor(() => expect(onResetVault).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('keeps the vault reset dialog open with the error when reset fails', async () => {
    const onResetVault = vi.fn().mockRejectedValue(new Error('서버에 연결할 수 없습니다.'));
    renderSettingsPanel({
      activeSection: 'account',
      vaultStatus: 'unlocked',
      onChangeVaultPassphrase: vi.fn().mockResolvedValue(undefined),
      onResetVault,
    });

    fireEvent.click(
      screen.getByRole('button', { name: '동기화 암호를 잊으셨나요? 초기화' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '서버 데이터 삭제하고 새로 시작' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('서버에 연결할 수 없습니다.'),
    );
    expect(screen.getByRole('dialog', { name: '동기화 초기화' })).toBeInTheDocument();
  });

  it('hides the vault reset entry without onResetVault (legacy/v1 vaults)', () => {
    renderSettingsPanel({
      activeSection: 'account',
      vaultStatus: 'unlocked',
      onChangeVaultPassphrase: vi.fn().mockResolvedValue(undefined),
    });
    expect(
      screen.queryByRole('button', { name: '동기화 암호를 잊으셨나요? 초기화' }),
    ).not.toBeInTheDocument();
  });

  it('opens sync passphrase changes explicitly and clears drafts when cancelled', async () => {
    const onChangeVaultPassphrase = vi.fn().mockResolvedValue(undefined);
    renderSettingsPanel({
      activeSection: 'account',
      vaultStatus: 'unlocked',
      onChangeVaultPassphrase,
    });

    expect(screen.queryByLabelText('현재 동기화 암호')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '암호 변경' }));

    let dialog = screen.getByRole('dialog', { name: '동기화 암호 변경' });
    fireEvent.change(within(dialog).getByLabelText('현재 동기화 암호'), {
      target: { value: 'current-passphrase' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));

    expect(screen.queryByRole('dialog', { name: '동기화 암호 변경' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '암호 변경' }));
    dialog = screen.getByRole('dialog', { name: '동기화 암호 변경' });
    expect(within(dialog).getByLabelText('현재 동기화 암호')).toHaveValue('');

    fireEvent.change(within(dialog).getByLabelText('현재 동기화 암호'), {
      target: { value: 'current-passphrase' },
    });
    fireEvent.change(within(dialog).getByLabelText('새 동기화 암호'), {
      target: { value: 'next-passphrase' },
    });
    fireEvent.change(within(dialog).getByLabelText('새 동기화 암호 확인'), {
      target: { value: 'next-passphrase' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '암호 변경' }));

    await waitFor(() =>
      expect(onChangeVaultPassphrase).toHaveBeenCalledWith(
        'current-passphrase',
        'next-passphrase',
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '동기화 암호 변경' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('동기화 암호를 변경했습니다.')).toBeInTheDocument();
  });

  it('filters saved credentials by label and preserves actions', async () => {
    const {
      onEditSecret,
      onRemoveSecret,
      onSavedCredentialsSearchQueryChange,
    } = renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: searchableKeychainEntries,
    });

    fireEvent.change(screen.getByLabelText('Search saved credentials'), {
      target: { value: 'backup' },
    });

    expect(screen.getByText('Backup private key')).toBeInTheDocument();
    expect(screen.queryByText('Prod password')).not.toBeInTheDocument();
    expect(onSavedCredentialsSearchQueryChange).toHaveBeenCalledWith('backup');

    fireEvent.click(screen.getByRole('button', { name: '편집' }));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    expect(onEditSecret).toHaveBeenCalledWith('secret-backup');
    expect(onRemoveSecret).toHaveBeenCalledWith('secret-backup');
  });

  it('preserves saved credential search across settings section changes', () => {
    renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: searchableKeychainEntries,
    }, { interactiveSection: true });

    fireEvent.change(screen.getByLabelText('Search saved credentials'), {
      target: { value: 'backup' },
    });

    expect(screen.getByText('Backup private key')).toBeInTheDocument();
    expect(screen.queryByText('Prod password')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(screen.queryByLabelText('Search saved credentials')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Saved Credentials' }));
    const searchInput = screen.getByLabelText('Search saved credentials') as HTMLInputElement;
    expect(searchInput.value).toBe('backup');
    expect(screen.getByText('Backup private key')).toBeInTheDocument();
    expect(screen.queryByText('Prod password')).not.toBeInTheDocument();
  });

  it('filters saved credentials by secret type', () => {
    renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: searchableKeychainEntries,
    });

    fireEvent.change(screen.getByLabelText('Search saved credentials'), {
      target: { value: 'certificate' },
    });

    expect(screen.getByText('Prod cert')).toBeInTheDocument();
    expect(screen.getByText('SSH certificate + Passphrase')).toBeInTheDocument();
    expect(screen.queryByText('Prod password')).not.toBeInTheDocument();
  });

  it('filters saved credentials by linked host search text', () => {
    renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: searchableKeychainEntries,
    });

    fireEvent.change(screen.getByLabelText('Search saved credentials'), {
      target: { value: 'lime.example.com' },
    });

    expect(screen.getByText('Shared credentials')).toBeInTheDocument();
    expect(screen.queryByText('Backup private key')).not.toBeInTheDocument();
  });

  it('matches saved credential search when the query uses the wrong Korean keyboard layout', () => {
    renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: searchableKeychainEntries,
    });

    const searchInput = screen.getByLabelText('Search saved credentials');
    fireEvent.change(searchInput, { target: { value: 'ㅣㅑㅡㄷ' } });
    expect(screen.getByText('Shared credentials')).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'dktks' } });
    expect(screen.getByText('아산 password')).toBeInTheDocument();
  });

  it('shows an empty state when saved credential search has no results', () => {
    renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: searchableKeychainEntries,
    });

    fireEvent.change(screen.getByLabelText('Search saved credentials'), {
      target: { value: 'no-such-credential' },
    });

    expect(screen.getByText('검색 결과가 없습니다.')).toBeInTheDocument();
    expect(screen.queryByText('Prod password')).not.toBeInTheDocument();
  });

  it('shows a shared edit action for certificate secrets too', () => {
    const { onEditSecret, onRemoveSecret } = renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: [
        {
          secretRef: 'secret-cert',
          label: 'Prod cert',
          linkedHostCount: 1,
          hasPassword: false,
          hasPassphrase: true,
          hasManagedPrivateKey: true,
          hasCertificate: true,
          updatedAt: '2026-03-24T12:00:00.000Z',
        },
      ],
    });

    expect(screen.getByText('SSH certificate + Passphrase')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '비밀번호 복사' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '편집' }));

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    expect(onEditSecret).toHaveBeenCalledWith('secret-cert');
    expect(onRemoveSecret).toHaveBeenCalledWith('secret-cert');
  });

  it('shows the signed-in email and current server in the account section', () => {
    renderSettingsPanel({ activeSection: 'account' });

    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText('https://ssh.doldolma.com')).toBeInTheDocument();
  });
});
