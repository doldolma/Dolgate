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
  probeSshAgent: vi.fn().mockResolvedValue({ status: 'unknown' }),
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

    // 폼 본문은 loading 이 내려간 뒤에야 그려진다(setLoading(true) 가 await 앞에 있다).
    // 호출만 기다리면 아직 "불러오는 중"인 화면에서 필드를 찾게 된다 — findBy* 로 UI 를 기다린다.
    expect(await screen.findByLabelText('Auth Type')).toHaveValue('certificate');
    expect(loadSavedCredential).toHaveBeenCalledWith('secret-1');
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

    const authTypeSelect = await screen.findByRole('combobox', { name: 'Auth Type' });
    expect(loadSavedCredential).toHaveBeenCalledWith('secret-1');

    fireEvent.change(authTypeSelect, { target: { value: 'privateKey' } });
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

    expect(await screen.findByLabelText('Auth Type')).toHaveValue('password');
    expect(loadSavedCredential).toHaveBeenCalledWith('secret-1');
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

    // 제목은 로딩 중에도 그려지므로 게이트가 되지 못한다 — 로드 결과로만 채워지는 값을 기다린다.
    expect(await screen.findByDisplayValue('PRIVATE KEY')).toBeInTheDocument();
    expect(screen.getByText('저장된 인증 정보 편집')).toBeInTheDocument();
    expect(loadSavedCredential).toHaveBeenCalledWith('secret-1');
  });

  // RDP·VNC 자격증명은 비밀번호 하나 + 계정뿐이다. SSH 의 인증 방식·키·인증서 칸을 보여주면 쓸 수
  // 없는 칸이 늘고, 무엇보다 **저장할 때 kind·계정을 되돌려 보내지 않으면 종류가 SSH 로 강등되고
  // 계정이 지워진다**(그러면 RDP 폼 목록에서 사라지고 접속도 계정 없이 시도한다).
  it('RDP 자격증명은 계정·도메인·비밀번호만 보여주고 종류를 지키며 저장한다', async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-rdp',
      label: 'Win admin',
      kind: 'rdp',
      username: 'Administrator',
      domain: 'CORP',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    } as never);
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <SecretEditDialog
        request={{
          source: 'keychain',
          secretRef: 'secret-rdp',
          label: 'Win admin',
          linkedHosts: [],
          initialMode: 'update-shared',
          initialHostId: null,
        }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(await screen.findByLabelText('계정')).toHaveValue('Administrator');
    expect(screen.getByLabelText('도메인')).toHaveValue('CORP');
    // SSH 전용 칸은 아예 없다.
    expect(screen.queryByLabelText('Auth Type')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('계정'), { target: { value: 'operator' } });
    fireEvent.click(screen.getByRole('button', { name: '공유 인증 정보 저장' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].secrets).toMatchObject({
      kind: 'rdp',
      username: 'operator',
      domain: 'CORP',
      password: 'pw',
    });
  });

  it('VNC 자격증명에는 도메인 칸이 없다', async () => {
    // VNC 에는 도메인 개념이 없다. 칸을 두면 채워도 쓰이지 않는 값이 저장된다.
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-vnc',
      label: 'Lab',
      kind: 'vnc',
      username: 'operator',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    } as never);

    render(
      <SecretEditDialog
        request={{
          source: 'keychain',
          secretRef: 'secret-vnc',
          label: 'Lab',
          linkedHosts: [],
          initialMode: 'update-shared',
          initialHostId: null,
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByLabelText('계정')).toHaveValue('operator');
    expect(screen.queryByLabelText('도메인')).not.toBeInTheDocument();
  });
});
