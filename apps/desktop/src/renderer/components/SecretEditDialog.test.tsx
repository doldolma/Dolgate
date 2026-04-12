import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretEditDialog } from './SecretEditDialog';
import { useHostFormController } from '../controllers/useHostFormController';
import { loadSavedCredential } from '../services/desktop/settings';

vi.mock('../controllers/useHostFormController', () => ({
  useHostFormController: vi.fn(() => ({
    listSerialPorts: vi.fn().mockResolvedValue([]),
    pickPrivateKey: vi.fn(),
    pickSshCertificate: vi.fn(),
  })),
}));

vi.mock('../services/desktop/settings', () => ({
  loadSavedCredential: vi.fn(),
}));

const pickPrivateKeyMock = vi.fn();
const pickSshCertificateMock = vi.fn();

vi.mocked(useHostFormController).mockImplementation(() => ({
  listSerialPorts: vi.fn().mockResolvedValue([]),
  pickPrivateKey: pickPrivateKeyMock,
  pickSshCertificate: pickSshCertificateMock,
}));

describe('SecretEditDialog', () => {
  beforeEach(() => {
    pickPrivateKeyMock.mockReset();
    pickSshCertificateMock.mockReset();
    vi.mocked(loadSavedCredential).mockReset();
  });

  it('loads the full saved credential payload for editing', async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Prod cert',
      password: 'pw',
      passphrase: 'pp',
      privateKeyPem: 'PRIVATE KEY',
      certificateText: 'CERTIFICATE',
      updatedAt: '2026-04-12T00:00:00.000Z',
      certificateInfo: {
        status: 'expired',
        validBefore: '2026-04-11T00:00:00.000Z',
        principals: ['test-user'],
      },
    });

    render(
      <SecretEditDialog
        request={{
          source: 'keychain',
          secretRef: 'secret-1',
          label: 'Prod cert',
          linkedHosts: [],
          initialMode: 'update-shared',
          initialHostId: null,
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(loadSavedCredential).toHaveBeenCalledWith('secret-1'));
    expect(screen.getByLabelText('Auth Type')).toHaveValue('certificate');
    expect(screen.getByDisplayValue('pp')).toBeInTheDocument();
    expect(screen.getByDisplayValue('PRIVATE KEY')).toBeInTheDocument();
    expect(screen.getByDisplayValue('CERTIFICATE')).toBeInTheDocument();
    expect(screen.getByText(/Expired on/)).toBeInTheDocument();
  });

  it('submits a full replacement secret and supports importing key material', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Prod key',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    pickPrivateKeyMock.mockResolvedValue({
      path: '/Users/tester/.ssh/id_ed25519',
      name: 'id_ed25519',
      content: 'PRIVATE KEY CONTENT',
    });
    pickSshCertificateMock.mockResolvedValue({
      path: '/Users/tester/.ssh/id_ed25519-cert.pub',
      name: 'id_ed25519-cert.pub',
      content: 'CERTIFICATE CONTENT',
    });

    render(
      <SecretEditDialog
        request={{
          source: 'host',
          secretRef: 'secret-1',
          label: 'Prod key',
          linkedHosts: [
            {
              id: 'host-1',
              label: 'Prod',
              hostname: 'prod.example.com',
              username: 'ubuntu',
            },
          ],
          initialMode: 'clone-for-host',
          initialHostId: 'host-1',
        }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() => expect(loadSavedCredential).toHaveBeenCalledWith('secret-1'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Auth Type' }), {
      target: { value: 'privateKey' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByDisplayValue('PRIVATE KEY CONTENT')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('combobox', { name: 'Auth Type' }), {
      target: { value: 'certificate' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Import' })[1]);
    await waitFor(() => expect(screen.getByDisplayValue('CERTIFICATE CONTENT')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '호스트 전용 인증 정보 생성' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'clone-for-host',
        secretRef: 'secret-1',
        hostId: 'host-1',
        secrets: {
          password: undefined,
          passphrase: undefined,
          privateKeyPem: 'PRIVATE KEY CONTENT',
          certificateText: 'CERTIFICATE CONTENT',
        },
      }),
    );
  });

  it('shows fields that match the selected auth type', async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Prod password',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });

    render(
      <SecretEditDialog
        request={{
          source: 'keychain',
          secretRef: 'secret-1',
          label: 'Prod password',
          linkedHosts: [],
          initialMode: 'update-shared',
          initialHostId: null,
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(loadSavedCredential).toHaveBeenCalledWith('secret-1'));
    expect(screen.getByLabelText('Auth Type')).toHaveValue('password');
    expect(screen.getByPlaceholderText('비밀번호를 입력하세요')).toBeInTheDocument();
    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Auth Type' }), {
      target: { value: 'certificate' },
    });

    expect(screen.queryByPlaceholderText('비밀번호를 입력하세요')).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('-----BEGIN OPENSSH PRIVATE KEY-----'),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('ssh-ed25519-cert-v01@openssh.com ...'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('패스프레이즈를 입력하세요')).toBeInTheDocument();
  });

  it('can open from a closed state without breaking hook order', async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Prod cert',
      password: 'pw',
      privateKeyPem: 'PRIVATE KEY',
      certificateText: 'CERTIFICATE',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });

    const { rerender } = render(
      <SecretEditDialog
        request={null}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    rerender(
      <SecretEditDialog
        request={{
          source: 'keychain',
          secretRef: 'secret-1',
          label: 'Prod cert',
          linkedHosts: [],
          initialMode: 'update-shared',
          initialHostId: null,
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(loadSavedCredential).toHaveBeenCalledWith('secret-1'));
    expect(screen.getByText('저장된 인증 정보 편집')).toBeInTheDocument();
    expect(screen.getByDisplayValue('PRIVATE KEY')).toBeInTheDocument();
  });
});
