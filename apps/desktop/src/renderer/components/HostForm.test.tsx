import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwsEc2HostRecord, SecretMetadataRecord, SshHostRecord } from '@shared';
import { HostForm } from './HostForm';
import { listAwsProfiles } from '../services/desktop/imports';
import { useHostFormController } from '../controllers/useHostFormController';

vi.mock('../services/desktop/imports', () => ({
  listAwsProfiles: vi.fn().mockResolvedValue([
    { id: 'profile-default', name: 'default' },
    { id: 'profile-prod', name: 'prod-admin' },
  ]),
}));

vi.mock('../controllers/useHostFormController', () => ({
  useHostFormController: vi.fn(() => ({
    pickPrivateKey: vi.fn(),
    pickSshCertificate: vi.fn(),
  })),
}));

const groupOptions = [{ value: null, label: 'Ungrouped' }];
const keychainEntries: SecretMetadataRecord[] = [];
const reusableKeychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret-password',
    label: 'Shared Password',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    source: 'local_keychain',
    linkedHostCount: 2,
    updatedAt: '2026-03-25T00:00:00.000Z',
  },
  {
    secretRef: 'secret-private-key',
    label: 'Shared Key',
    hasPassword: false,
    hasPassphrase: true,
    hasManagedPrivateKey: true,
    hasCertificate: false,
    source: 'local_keychain',
    linkedHostCount: 1,
    updatedAt: '2026-03-25T00:00:00.000Z',
  },
  {
    secretRef: 'secret-certificate',
    label: 'Shared Certificate',
    hasPassword: false,
    hasPassphrase: true,
    hasManagedPrivateKey: true,
    hasCertificate: true,
    source: 'local_keychain',
    linkedHostCount: 1,
    updatedAt: '2026-03-25T00:00:00.000Z',
  },
];

const pickPrivateKeyMock = vi.fn();
const pickSshCertificateMock = vi.fn();

vi.mocked(useHostFormController).mockImplementation(() => ({
  pickPrivateKey: pickPrivateKeyMock,
  pickSshCertificate: pickSshCertificateMock,
}));

function createHost(overrides: Partial<SshHostRecord> = {}): SshHostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'Prod',
    hostname: 'prod.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    certificatePath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
    updatedAt: '2026-03-25T00:00:00.000Z',
    ...overrides
  };
}

function createAwsHost(
  overrides: Partial<AwsEc2HostRecord> = {},
): AwsEc2HostRecord {
  return {
    id: 'aws-host-1',
    kind: 'aws-ec2',
    label: 'AWS Prod',
    awsProfileId: 'profile-default',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-abc',
    awsAvailabilityZone: 'ap-northeast-2a',
    awsInstanceName: 'web-1',
    awsPlatform: 'Linux/UNIX',
    awsPrivateIp: '10.0.0.10',
    awsState: 'running',
    awsSshUsername: 'ubuntu',
    awsSshPort: 22,
    awsSshMetadataStatus: 'ready',
    awsSshMetadataError: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
    updatedAt: '2026-03-25T00:00:00.000Z',
    ...overrides
  };
}

async function wait(duration: number) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, duration));
  });
}

describe('HostForm', () => {
  beforeEach(() => {
    pickPrivateKeyMock.mockReset();
    pickSshCertificateMock.mockReset();
  });

  it('auto-saves edit-mode changes after the debounce window', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onActionStateChange = vi.fn();

    render(
      <HostForm
        host={createHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
        onActionStateChange={onActionStateChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Prod API' } });

    await wait(250);
    expect(onSubmit).not.toHaveBeenCalled();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1), { timeout: 1200 });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Prod API'
      }),
      undefined
    );
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Prod API');
    await waitFor(() =>
      expect(onActionStateChange).toHaveBeenLastCalledWith({
        saveInFlight: false,
        saveStatusText: 'Saved',
      }),
    );
  });

  it('keeps create mode manual without auto-saving', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<HostForm host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'New host' } });
    await wait(900);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('auto-fills the label from hostname for a new SSH host', () => {
    render(<HostForm host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'prod.example.com' } });

    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('prod.example.com');
  });

  it('keeps a manually edited label when hostname changes afterwards', () => {
    render(<HostForm host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'prod.example.com' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Production API' } });
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'api.example.com' } });

    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Production API');
  });

  it('shows saved secret controls inline for a new SSH host', () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    expect(screen.getByText('Saved Secret')).toBeInTheDocument();
    expect(screen.getByLabelText('Saved Secret')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Secrets 열기' })).toBeInTheDocument();
  });

  it('shows certificate-specific fields and filters saved secrets for certificate auth', () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Auth Type'), {
      target: { value: 'certificate' },
    });

    expect(screen.getByLabelText('Private key file')).toBeInTheDocument();
    expect(screen.getByLabelText('SSH certificate file')).toBeInTheDocument();
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument();

    const select = screen.getByLabelText('Saved Secret');
    expect(within(select).queryByRole('option', { name: '사용 안 함' })).not.toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Shared Certificate · Certificate \+ Passphrase/ })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Shared Key/ })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Shared Password/ })).not.toBeInTheDocument();
  });

  it('preselects the existing saved secret when editing a host with an attached secret', async () => {
    render(
      <HostForm
        host={createHost({ secretRef: 'secret-password' })}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    const savedSecretSelect = screen.getByLabelText('Saved Secret') as HTMLSelectElement;
    await waitFor(() => expect(savedSecretSelect.value).toBe('existing:secret-password'));
    expect(screen.getByRole('button', { name: 'Secrets 열기' })).toBeInTheDocument();
  });

  it('falls back to creating a new password secret when the selected saved secret disappears', async () => {
    const { rerender } = render(
      <HostForm
        host={createHost({ secretRef: 'secret-password', authType: 'password' })}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    const savedSecretSelect = screen.getByLabelText('Saved Secret') as HTMLSelectElement;
    await waitFor(() => expect(savedSecretSelect.value).toBe('existing:secret-password'));

    rerender(
      <HostForm
        host={createHost({ secretRef: 'secret-password', authType: 'password' })}
        keychainEntries={reusableKeychainEntries.filter((entry) => entry.secretRef !== 'secret-password')}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    await waitFor(() => expect(savedSecretSelect.value).toBe('new'));
  });

  it('falls back to no saved secret when the selected certificate secret disappears', async () => {
    const { rerender } = render(
      <HostForm
        host={createHost({ secretRef: 'secret-certificate', authType: 'certificate' })}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    const savedSecretSelect = screen.getByLabelText('Saved Secret') as HTMLSelectElement;
    await waitFor(() => expect(savedSecretSelect.value).toBe('existing:secret-certificate'));

    rerender(
      <HostForm
        host={createHost({ secretRef: 'secret-certificate', authType: 'certificate' })}
        keychainEntries={reusableKeychainEntries.filter((entry) => entry.secretRef !== 'secret-certificate')}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    await waitFor(() => expect(savedSecretSelect.value).toBe('new'));
  });

  it('stores imported private key material in the submission instead of persisting the path', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    pickPrivateKeyMock.mockResolvedValue({
      path: '/Users/tester/.ssh/id_ed25519',
      name: 'id_ed25519',
      content: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    });

    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('Auth Type'), {
      target: { value: 'privateKey' },
    });
    fireEvent.change(screen.getByLabelText('Hostname'), {
      target: { value: 'prod.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByLabelText('Private key file')).toHaveValue('/Users/tester/.ssh/id_ed25519'));

    const form = screen.getByLabelText('Hostname').closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKeyPath: '/Users/tester/.ssh/id_ed25519',
        secretRef: null,
      }),
      expect.objectContaining({
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      }),
    );
  });

  it('does not render extra saved secret helper copy', () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenSecrets={vi.fn()}
      />,
    );

    expect(screen.queryByText('현재 선택된 secret을 재사용합니다.')).not.toBeInTheDocument();
    expect(screen.queryByText('선택한 secret을 이 호스트와 공유합니다. 이 호스트를 삭제해도 secret 항목은 유지됩니다.')).not.toBeInTheDocument();
  });


  it('does not overwrite local edits when the same host id rehydrates while dirty', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    const labelInput = screen.getByLabelText('Label') as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: 'Dirty local label' } });

    rerender(
      <HostForm
        host={createHost({
          label: 'Server-side label',
          updatedAt: '2026-03-25T00:01:00.000Z'
        })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />
    );

    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Dirty local label');
  });

  it('rehydrates the form when the same host id receives a newer revision while clean', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    rerender(
      <HostForm
        host={createHost({
          label: 'Server-side label',
          updatedAt: '2026-03-25T00:01:00.000Z'
        })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />
    );

    await waitFor(() => expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Server-side label'));
  });

  it('does not append a duplicate tag when enter is followed by blur', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    const tagInput = screen.getByPlaceholderText('Type a tag and press Enter');
    fireEvent.change(tagInput, { target: { value: '개발' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    fireEvent.blur(tagInput);

    expect(screen.getAllByText('개발')).toHaveLength(1);
  });

  it('aligns tags and hostname fields to the same shared input contract', () => {
    render(
      <HostForm
        host={null}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const hostnameInput = screen.getByLabelText('Hostname');
    const tagShell = screen.getByTestId('tag-input-shell');

    expect(hostnameInput.className).toContain('min-h-11');
    expect(hostnameInput.className).toContain('rounded-[16px]');
    expect(hostnameInput.className).toContain('border-[var(--border)]');
    expect(hostnameInput.className).toContain('focus:border-[var(--selection-border)]');
    expect(hostnameInput.className).toContain('focus:ring-4');

    expect(tagShell.className).toContain('min-h-11');
    expect(tagShell.className).toContain('rounded-[16px]');
    expect(tagShell.className).toContain('border-[var(--border)]');
    expect(tagShell.className).toContain('focus-within:border-[var(--selection-border)]');
    expect(tagShell.className).toContain('focus-within:ring-4');
  });

  it('groups the SSH form into connection, details, and preferences sections', () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const connectionSection = screen.getByTestId('hostform-section-connection');
    const detailsSection = screen.getByTestId('hostform-section-details');
    const preferencesSection = screen.getByTestId('hostform-section-preferences');

    expect(within(connectionSection).getByText('Connection')).toBeInTheDocument();
    expect(within(connectionSection).getByLabelText('Hostname')).toBeInTheDocument();
    expect(within(connectionSection).getByText('Auth Type')).toBeInTheDocument();
    expect(within(connectionSection).getByLabelText('Password')).toBeInTheDocument();
    expect(within(connectionSection).getByText('Saved Secret')).toBeInTheDocument();

    expect(within(detailsSection).getByText('Details')).toBeInTheDocument();
    expect(within(detailsSection).getByLabelText('Label')).toBeInTheDocument();
    expect(within(detailsSection).getByLabelText('Group')).toBeInTheDocument();
    expect(within(detailsSection).getByLabelText('Tags')).toBeInTheDocument();

    expect(within(preferencesSection).getByText('Preferences')).toBeInTheDocument();
    expect(within(preferencesSection).getByText('Terminal Theme')).toBeInTheDocument();

    expect(connectionSection.compareDocumentPosition(detailsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detailsSection.compareDocumentPosition(preferencesSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('places auth credentials before saved secret and terminal theme in the SSH form', () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const connectionSection = screen.getByTestId('hostform-section-connection');
    const preferencesSection = screen.getByTestId('hostform-section-preferences');
    const authTypeField = within(connectionSection).getByText('Auth Type').closest('label');
    const passwordField = within(connectionSection).getByLabelText('Password').closest('label');
    const savedSecretHeading = within(connectionSection).getByText('Saved Secret');
    const terminalThemeField = within(preferencesSection).getByText('Terminal Theme').closest('label');

    expect(authTypeField).not.toBeNull();
    expect(passwordField).not.toBeNull();
    expect(terminalThemeField).not.toBeNull();
    expect(authTypeField!.compareDocumentPosition(passwordField!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(passwordField!.compareDocumentPosition(savedSecretHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(connectionSection.compareDocumentPosition(preferencesSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders AWS SSH metadata fields and auto-saves edited username and port', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <HostForm
        host={createAwsHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />
    );

    expect((screen.getByLabelText('Availability Zone') as HTMLInputElement).value).toBe('ap-northeast-2a');
    expect(screen.getByText('SSH 설정 자동 확인됨')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('SSH Username'), {
      target: { value: 'ec2-user' }
    });
    fireEvent.change(screen.getByLabelText('SSH Port'), {
      target: { value: '2222' }
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1), {
      timeout: 1200
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'aws-ec2',
        awsSshUsername: 'ec2-user',
        awsSshPort: 2222
      }),
      undefined
    );
  });

  it('allows changing the AWS profile for an existing AWS host', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <HostForm
        host={createAwsHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />
    );

    await waitFor(() => expect(listAwsProfiles).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('AWS Profile'), {
      target: { value: 'profile-prod' },
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1), {
      timeout: 1200,
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'aws-ec2',
        awsProfileId: 'profile-prod',
        awsProfileName: 'prod-admin',
      }),
      undefined,
    );
  });
});
