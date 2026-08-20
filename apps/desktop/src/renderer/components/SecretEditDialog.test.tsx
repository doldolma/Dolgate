import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(await screen.findByLabelText('인증 방식')).toHaveValue('certificate');
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

    const authTypeSelect = await screen.findByRole('combobox', { name: '인증 방식' });
    expect(loadSavedCredential).toHaveBeenCalledWith('secret-1');

    fireEvent.change(authTypeSelect, { target: { value: 'privateKey' } });
    fireEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await waitFor(() => expect(screen.getByDisplayValue('PRIVATE KEY CONTENT')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('combobox', { name: '인증 방식' }), {
      target: { value: 'certificate' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: '가져오기' })[1]);
    await waitFor(() => expect(screen.getByDisplayValue('CERTIFICATE CONTENT')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '분리해서 저장' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'clone-for-host',
        label: 'Prod key',
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

    expect(await screen.findByLabelText('인증 방식')).toHaveValue('password');
    expect(loadSavedCredential).toHaveBeenCalledWith('secret-1');
    expect(screen.getByPlaceholderText('비밀번호를 입력하세요')).toBeInTheDocument();
    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: '인증 방식' }), {
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
    expect(screen.queryByLabelText('인증 방식')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('계정'), { target: { value: 'operator' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

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

  // 적용 범위는 라디오다. 버튼 두 개로 보이면 "누르면 실행" 으로 읽히고, 스크린리더에도
  // 선택 상태가 전달되지 않는다.
  it('offers the scope as a radio group and moves the selection', async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Shared pw',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });

    render(
      <SecretEditDialog
        request={{
          source: 'host',
          secretRef: 'secret-1',
          label: 'Shared pw',
          linkedHosts: [
            { id: 'host-1', label: 'Prod', hostname: 'prod.example.com', username: 'ubuntu' },
            { id: 'host-2', label: 'Stage', hostname: 'stage.example.com', username: 'ubuntu' },
          ],
          initialMode: 'update-shared',
          initialHostId: 'host-1',
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const scope = await screen.findByRole('radiogroup', { name: '적용 범위' });
    const options = within(scope).getAllByRole('radio');
    expect(options).toHaveLength(2);

    const detach = within(scope).getByRole('radio', { name: /이 호스트만 새 인증 정보로 분리/ });
    const shared = within(scope).getByRole('radio', { name: /연결된 호스트 전체 변경/ });
    expect(shared).toHaveAttribute('aria-checked', 'true');
    expect(detach).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(detach);
    expect(detach).toHaveAttribute('aria-checked', 'true');
    expect(shared).toHaveAttribute('aria-checked', 'false');
  });

  // 숫자만 말하면 무엇이 바뀌는지 확인할 방법이 없다. 이름을 보여 주고, 저장 버튼도 범위를 말한다.
  it('names the hosts that change together and says the scope on the save button', async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Shared pw',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });

    render(
      <SecretEditDialog
        request={{
          source: 'host',
          secretRef: 'secret-1',
          label: 'Shared pw',
          linkedHosts: [
            { id: 'host-1', label: 'Prod', hostname: 'prod.example.com', username: 'ubuntu' },
            { id: 'host-2', label: 'Stage', hostname: 'stage.example.com', username: 'ubuntu' },
            { id: 'host-3', label: 'Dev', hostname: 'dev.example.com', username: 'ubuntu' },
            { id: 'host-4', label: 'Lab', hostname: 'lab.example.com', username: 'ubuntu' },
          ],
          initialMode: 'update-shared',
          initialHostId: 'host-1',
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // 칩은 공유 카드 안에 있다 — 어느 선택지에 딸린 설명인지 눈으로 잇지 않아도 되게.
    const shared = await screen.findByRole('radio', { name: /연결된 호스트 전체 변경/ });
    expect(within(shared).getByText('Prod')).toBeInTheDocument();
    expect(within(shared).getByText('Stage')).toBeInTheDocument();
    expect(within(shared).getByText('Dev')).toBeInTheDocument();
    // 네 번째부터는 접는다 — 칩이 줄바꿈으로 카드를 밀어내지 않게.
    expect(within(shared).queryByText('Lab')).not.toBeInTheDocument();
    expect(within(shared).getByText('외 1개')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4개 호스트에 저장' })).toBeInTheDocument();
  });

  // 저장 버튼이 지금 고른 범위를 말해야 한다. 영향받는 호스트 목록은 공유 선택지 안에 남는다
  // (그 선택지의 설명이므로, 다른 것을 골랐다고 사라지면 비교할 수 없다).
  it('says the scope on the save button when the credential is being forked', async () => {
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Shared pw',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });

    render(
      <SecretEditDialog
        request={{
          source: 'host',
          secretRef: 'secret-1',
          label: 'Shared pw',
          linkedHosts: [
            { id: 'host-1', label: 'Prod', hostname: 'prod.example.com', username: 'ubuntu' },
            { id: 'host-2', label: 'Stage', hostname: 'stage.example.com', username: 'ubuntu' },
          ],
          initialMode: 'update-shared',
          initialHostId: 'host-1',
        }}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const scope = await screen.findByRole('radiogroup', { name: '적용 범위' });
    const shared = within(scope).getByRole('radio', { name: /연결된 호스트 전체 변경/ });
    expect(within(shared).getByText('Prod')).toBeInTheDocument();

    fireEvent.click(within(scope).getByRole('radio', { name: /이 호스트만 새 인증 정보로 분리/ }));

    expect(screen.getByRole('button', { name: '분리해서 저장' })).toBeInTheDocument();
  });

  // 가져오기가 붙인 이름("Termius • ubuntu")이 여러 개 겹쳐도 고칠 수 없었다. 이름은 자격증명을
  // 고를 때 유일한 식별 수단이라, 편집 화면에서 그 자리에서 바꿀 수 있어야 한다.
  it('renames the credential from the header without adding a form field', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Termius • ubuntu',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });

    render(
      <SecretEditDialog
        request={{
          source: 'keychain',
          secretRef: 'secret-1',
          label: 'Termius • ubuntu',
          linkedHosts: [],
          initialMode: 'update-shared',
          initialHostId: null,
        }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '이름 바꾸기' }));
    fireEvent.change(screen.getByRole('textbox', { name: '이름 바꾸기' }), {
      target: { value: '  운영 공용 계정  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ label: '운영 공용 계정' }),
      ),
    );
  });

  it('keeps the old name when the rename is cancelled or left blank', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(loadSavedCredential).mockResolvedValue({
      secretRef: 'secret-1',
      label: 'Termius • ubuntu',
      password: 'pw',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });

    render(
      <SecretEditDialog
        request={{
          source: 'keychain',
          secretRef: 'secret-1',
          label: 'Termius • ubuntu',
          linkedHosts: [],
          initialMode: 'update-shared',
          initialHostId: null,
        }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '이름 바꾸기' }));
    const input = screen.getByRole('textbox', { name: '이름 바꾸기' });
    fireEvent.change(input, { target: { value: '버리는 이름' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    // Escape 는 편집 전 이름으로 되돌린다 — 저장 전이라 아직 아무것도 바뀌지 않았다.
    expect(screen.getByText('Termius • ubuntu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '이름 바꾸기' }));
    fireEvent.change(screen.getByRole('textbox', { name: '이름 바꾸기' }), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    // 이름 없는 자격증명은 고를 수 없다 — 빈 값은 "그대로" 다.
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'Termius • ubuntu' }),
      ),
    );
  });
});
