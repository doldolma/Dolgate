import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } from '@shared';
import type { AppSettings, HostRecord } from '@shared';
import { SettingsPanel } from './SettingsPanel';

const settings: AppSettings = {
  theme: 'system',
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: 'sf-mono',
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
  sessionReplayRetentionCount: 100,
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

const keychainEntries = [
  {
    secretRef: 'secret-1',
    label: 'Prod password',
    source: 'local_keychain' as const,
    linkedHostCount: 2,
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    updatedAt: '2026-03-24T12:00:00.000Z'
  }
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
  }
];

function renderSettingsPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const onUpdateSettings = vi.fn().mockResolvedValue(undefined);
  const onSelectSection = vi.fn();
  const onRemoveKnownHost = vi.fn().mockResolvedValue(undefined);
  const onRemoveSecret = vi.fn().mockResolvedValue(undefined);
  const onEditSecret = vi.fn();
  const onLogout = vi.fn();

  render(
    <SettingsPanel
      activeSection="general"
      settings={settings}
      hosts={hosts}
      knownHosts={knownHosts}
      keychainEntries={keychainEntries}
      currentUserEmail="user@example.com"
      desktopPlatform="darwin"
      onSelectSection={onSelectSection}
      onUpdateSettings={onUpdateSettings}
      onRemoveKnownHost={onRemoveKnownHost}
      onRemoveSecret={onRemoveSecret}
      onEditSecret={onEditSecret}
      onLogout={onLogout}
      {...overrides}
    />
  );

  return {
    onUpdateSettings,
    onSelectSection,
    onRemoveKnownHost,
    onRemoveSecret,
    onEditSecret,
    onLogout
  };
}

describe('SettingsPanel', () => {
  it('renders appearance theme cards with descriptions', () => {
    renderSettingsPanel();

    expect(screen.getByText('기기 라이트/다크 설정을 따라갑니다.')).toBeInTheDocument();
    expect(screen.getByText('밝은 배경과 또렷한 대비를 사용합니다.')).toBeInTheDocument();
    expect(screen.getByText('어두운 배경으로 눈부심을 줄입니다.')).toBeInTheDocument();
  });

  it('shows Appearance before Terminal Theme in the general settings flow', () => {
    renderSettingsPanel();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

    expect(headings.indexOf('Theme')).toBeGreaterThan(-1);
    expect(headings.indexOf('Terminal Theme')).toBeGreaterThan(-1);
    expect(headings.indexOf('Theme')).toBeLessThan(headings.indexOf('Terminal Theme'));
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

  it('renders extended terminal controls and updates numeric settings', () => {
    const { onUpdateSettings } = renderSettingsPanel();

    fireEvent.change(screen.getByLabelText('Scrollback'), { target: { value: '6400' } });
    fireEvent.change(screen.getByLabelText('Line Height'), { target: { value: '1.2' } });
    fireEvent.change(screen.getByLabelText('Letter Spacing'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Minimum Contrast'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Session Replay Retention'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Use Option/Alt as Meta' }));

    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalScrollbackLines: 6400 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalLineHeight: 1.2 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalLetterSpacing: 1 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalMinimumContrastRatio: 3 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ sessionReplayRetentionCount: 250 });
    expect(onUpdateSettings).toHaveBeenCalledWith({ terminalAltIsMeta: true });
  });

  it('hides mac-only terminal fonts on Windows', () => {
    renderSettingsPanel({
      settings: { ...settings, terminalFontFamily: 'consolas' },
      desktopPlatform: 'win32'
    });

    expect(screen.queryByRole('option', { name: 'SF Mono' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Menlo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Monaco' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Consolas' })).toBeInTheDocument();
  });

  it('switches settings subsections from the tab bar', () => {
    const { onSelectSection } = renderSettingsPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Security' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Secrets' }));
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

  it('renders keychain entries inside the secrets section', () => {
    const { onEditSecret, onRemoveSecret } = renderSettingsPanel({ activeSection: 'secrets' });

    expect(screen.getByRole('heading', { name: 'Secrets' })).toBeInTheDocument();
    expect(screen.queryByText('local_keychain')).not.toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete secret' }));

    expect(onEditSecret).toHaveBeenCalledWith('secret-1', 'password');
    expect(onRemoveSecret).toHaveBeenCalledWith('secret-1');
  });

  it('shows certificate secrets without edit actions', () => {
    const { onEditSecret, onRemoveSecret } = renderSettingsPanel({
      activeSection: 'secrets',
      keychainEntries: [
        {
          secretRef: 'secret-cert',
          label: 'Prod cert',
          source: 'local_keychain' as const,
          linkedHostCount: 1,
          hasPassword: false,
          hasPassphrase: true,
          hasManagedPrivateKey: true,
          hasCertificate: true,
          updatedAt: '2026-03-24T12:00:00.000Z',
        },
      ],
    });

    expect(screen.getByText('Certificate + Passphrase')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit passphrase' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete secret' }));

    expect(onEditSecret).not.toHaveBeenCalled();
    expect(onRemoveSecret).toHaveBeenCalledWith('secret-cert');
  });

  it('shows the signed-in email and current server in the account section', () => {
    renderSettingsPanel();

    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText('https://ssh.doldolma.com')).toBeInTheDocument();
  });
});
