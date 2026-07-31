import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef, type RefObject } from 'react';
import type { AwsEc2HostRecord, SecretMetadataRecord, SnippetRecord, SshHostRecord } from '@shared';
import { HostForm, getJumpHostCandidates, type HostFormHandle } from './HostForm';

// 편집 폼은 자동저장하지 않으므로, 명시적 저장(submit)을 ref로 트리거한다.
async function saveEdit(ref: RefObject<HostFormHandle | null>) {
  await act(async () => {
    await ref.current?.submit();
  });
}
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
    listSerialPorts: vi.fn().mockResolvedValue([]),
    pickPrivateKey: vi.fn(),
    pickSshCertificate: vi.fn(),
  })),
}));

const groupOptions = [{ value: null, label: 'Ungrouped' }];
const keychainEntries: SecretMetadataRecord[] = [];
const snippets: SnippetRecord[] = [
  {
    id: 'snippet-1',
    label: 'Open app',
    keyword: 'app',
    command: 'cd /srv/app',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
  },
];
const reusableKeychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret-password',
    label: 'Shared Password',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
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
    linkedHostCount: 1,
    updatedAt: '2026-03-25T00:00:00.000Z',
  },
];

const pickPrivateKeyMock = vi.fn();
const pickSshCertificateMock = vi.fn();
const listSerialPortsMock = vi.fn();

vi.mocked(useHostFormController).mockImplementation(() => ({
  listSerialPorts: listSerialPortsMock,
  pickPrivateKey: pickPrivateKeyMock,
  pickSshCertificate: pickSshCertificateMock,
  probeSshAgent: vi.fn().mockResolvedValue({ status: 'unknown' }),
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
    listSerialPortsMock.mockReset();
    listSerialPortsMock.mockResolvedValue([]);
    pickPrivateKeyMock.mockReset();
    pickSshCertificateMock.mockReset();
  });

  it('saves edit-mode changes only on explicit save', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onActionStateChange = vi.fn();
    const onLabelChange = vi.fn();
    const ref = createRef<HostFormHandle>();

    render(
      <HostForm
        ref={ref}
        host={createHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
        onActionStateChange={onActionStateChange}
        onLabelChange={onLabelChange}
      />,
    );

    // 이름 편집은 이제 드로어 헤더의 편집 타이틀(HostFormHandle.setLabel)로 이뤄진다.
    act(() => ref.current?.setLabel('Prod API'));

    // 자동저장 없음 — 명시적 저장 전에는 호출되지 않는다.
    await wait(250);
    expect(onSubmit).not.toHaveBeenCalled();

    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Prod API'
      }),
      undefined
    );
    expect(onLabelChange).toHaveBeenLastCalledWith('Prod API');
    await waitFor(() =>
      expect(onActionStateChange).toHaveBeenLastCalledWith({
        saveInFlight: false,
        saveStatusText: 'Saved',
      }),
    );
  });

  // 저장은 되는데 폼이 되읽지 못하면 "저장이 안 된다"로 보인다. 그리고 그 상태에서 한 번 더
  // 저장하면 draft 의 null 이 레코드를 덮어써서 실제로 사라진다 — 그쪽이 더 나쁘다.
  it('seeds the tailnet selection from the host record and keeps it across an unrelated save', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();

    render(
      <HostForm
        ref={ref}
        host={createHost({ tailnetId: 'net-corp' })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        tailnetOptions={[{ id: 'net-corp', label: 'corp' }]}
        onSubmit={onSubmit}
      />,
    );

    // 이 폼의 필드 라벨은 htmlFor 로 묶인 <label> 이 아니라 <span> 이라(전체 관례) 옵션으로 찾는다.
    const select = screen.getByRole('option', { name: 'corp' }).closest('select');
    expect(select).not.toBeNull();
    expect((select as HTMLSelectElement).value).toBe('net-corp');

    // tailnet 을 건드리지 않은 저장이 그 값을 지우지 않아야 한다.
    act(() => ref.current?.setLabel('Prod API'));
    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetId: 'net-corp' }),
      undefined,
    );
  });

  it('shows and allows clearing a tailnet reference whose setting is missing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();

    render(
      <HostForm
        ref={ref}
        host={createHost({ tailnetId: 'net-deleted' })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        tailnetOptions={[]}
        onSubmit={onSubmit}
      />,
    );

    const missingOption = screen.getByRole('option', { name: '설정에 없는 Tailnet' });
    const select = missingOption.closest('select') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('net-deleted');

    fireEvent.change(select, { target: { value: '' } });
    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetId: null }),
      undefined,
    );
  });

  // 자격증명 옆 Manage 와 같은 자리다. 등록된 tailnet 이 없을 때가 오히려 여기로 갈 이유가
  // 가장 큰 순간이므로, 목록이 비어도 보여야 한다.
  it('offers a tailnet manage link even when nothing is registered', () => {
    const onOpenTailnets = vi.fn();

    const { unmount } = render(
      <HostForm
        host={createHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        tailnetOptions={[]}
        onOpenTailnets={onOpenTailnets}
        onSubmit={vi.fn()}
      />,
    );

    const manageButtons = screen.getAllByRole('button', { name: 'Manage' });
    fireEvent.click(manageButtons[manageButtons.length - 1] as HTMLElement);
    expect(onOpenTailnets).toHaveBeenCalledTimes(1);
    unmount();
  });

  // 고를 것이 있으면 설명을 붙이지 않는다. 비어 있을 때만 안내가 필요하다.
  it('explains the empty tailnet list but stays quiet once one exists', () => {
    const { unmount } = render(
      <HostForm
        host={createHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        tailnetOptions={[]}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByText(/등록된 Tailnet 이 없습니다|No tailnets/i)).not.toBeNull();
    unmount();

    render(
      <HostForm
        host={createHost({ tailnetId: 'net-corp' })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        tailnetOptions={[{ id: 'net-corp', label: 'corp' }]}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByText(/등록된 Tailnet 이 없습니다|No tailnets/i)).toBeNull();
    // 신뢰 범위 설명도 더 이상 붙지 않는다.
    expect(screen.queryByText(/이 tailnet 을 경유해|connect through this tailnet/i)).toBeNull();
  });

  it('configures a direct startup command for an SSH host', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();
    render(
      <HostForm
        ref={ref}
        host={createHost()}
        snippets={snippets}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Command' }));
    fireEvent.change(screen.getByLabelText('Startup command'), {
      target: { value: 'cd /srv/app && clear' },
    });

    await saveEdit(ref);
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startupCommand: {
          type: 'command',
          command: 'cd /srv/app && clear',
        },
      }),
      undefined,
    );
  });

  it('saves the SSH agent forwarding toggle on explicit save', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();
    render(
      <HostForm
        ref={ref}
        host={createHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'SSH Agent Forwarding' }));

    await saveEdit(ref);
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentForwarding: true,
      }),
      undefined,
    );
  });

  it('disables SSH agent forwarding while mosh is enabled', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        host={createHost({ useMosh: true, agentForwarding: true })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    const agentForwardingToggle = screen.getByRole('switch', {
      name: 'SSH Agent Forwarding',
    });
    expect(agentForwardingToggle).toBeDisabled();
    expect(agentForwardingToggle).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps create mode manual without auto-saving', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();

    render(<HostForm ref={ref} host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} />);

    act(() => ref.current?.setLabel('New host'));
    await wait(900);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('auto-fills the label from hostname for a new SSH host', () => {
    const onLabelChange = vi.fn();
    render(<HostForm host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={vi.fn().mockResolvedValue(undefined)} onLabelChange={onLabelChange} />);

    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'prod.example.com' } });

    // 라벨 입력은 드로어 헤더로 옮겨졌으므로, 파생된 이름은 onLabelChange 로 관찰한다.
    expect(onLabelChange).toHaveBeenLastCalledWith('prod.example.com');
  });

  it('keeps a manually edited label when hostname changes afterwards', () => {
    const onLabelChange = vi.fn();
    const ref = createRef<HostFormHandle>();
    render(<HostForm ref={ref} host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={vi.fn().mockResolvedValue(undefined)} onLabelChange={onLabelChange} />);

    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'prod.example.com' } });
    act(() => ref.current?.setLabel('Production API'));
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'api.example.com' } });

    // 수동 편집한 이름은 hostname 이 바뀌어도 유지된다(마지막 보고값이 그대로).
    expect(onLabelChange).toHaveBeenLastCalledWith('Production API');
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

    expect(screen.getByText('Saved Credentials')).toBeInTheDocument();
    expect(screen.getByLabelText('Saved Credentials')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
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

    const select = screen.getByLabelText('Saved Credentials');
    expect(within(select).queryByRole('option', { name: '사용 안 함' })).not.toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Shared Certificate · SSH certificate \+ Passphrase/ })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Shared Key/ })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Shared Password/ })).not.toBeInTheDocument();
  });

  it('renders serial connection fields and hides auth controls when Serial is selected', async () => {
    listSerialPortsMock.mockResolvedValue([
      {
        path: '/dev/tty.usbserial-0001',
        displayName: '/dev/tty.usbserial-0001',
        manufacturer: null,
      },
    ]);

    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        createKind="serial"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByLabelText('Transport')).toBeInTheDocument();
    expect(await screen.findByLabelText('Detected Serial Port')).toBeInTheDocument();
    expect(screen.getByLabelText('Device Path')).toBeInTheDocument();
    expect(screen.getByLabelText('Line Ending')).toBeInTheDocument();
    expect(screen.queryByLabelText('Auth Type')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved Credentials')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Connection Type')).not.toBeInTheDocument();
    expect(listSerialPortsMock).toHaveBeenCalled();
  });

  it('shows raw TCP serial fields without framing controls', async () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        createKind="serial"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Transport'), {
      target: { value: 'raw-tcp' },
    });

    expect(screen.getByLabelText('Remote Host')).toBeInTheDocument();
    expect(screen.getByLabelText('Port')).toBeInTheDocument();
    expect(screen.getByLabelText('Line Ending')).toBeInTheDocument();
    expect(screen.queryByLabelText('Baud Rate')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Data Bits')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Flow Control')).not.toBeInTheDocument();
  });

  it('uses a Windows-friendly serial device placeholder on win32', async () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        createKind="serial"
        desktopPlatform="win32"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByPlaceholderText('COM3')).toBeInTheDocument();
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

    const savedSecretSelect = screen.getByLabelText('Saved Credentials') as HTMLSelectElement;
    await waitFor(() => expect(savedSecretSelect.value).toBe('existing:secret-password'));
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
  });

  it('allows opening the full editor for an attached certificate secret', async () => {
    const onEditExistingSecret = vi.fn();

    render(
      <HostForm
        host={createHost({ secretRef: 'secret-certificate', authType: 'certificate' })}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onEditExistingSecret={onEditExistingSecret}
      />,
    );

    await waitFor(() =>
      expect((screen.getByLabelText('Saved Credentials') as HTMLSelectElement).value).toBe(
        'existing:secret-certificate',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: '편집' }));

    expect(onEditExistingSecret).toHaveBeenCalledWith('secret-certificate');
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

    const savedSecretSelect = screen.getByLabelText('Saved Credentials') as HTMLSelectElement;
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

    const savedSecretSelect = screen.getByLabelText('Saved Credentials') as HTMLSelectElement;
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
    await waitFor(() => expect(screen.getByLabelText('Private key file')).toHaveValue('id_ed25519'));

    const form = screen.getByLabelText('Hostname').closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKeyPath: null,
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
    const onLabelChange = vi.fn();
    const ref = createRef<HostFormHandle>();
    const { rerender } = render(<HostForm ref={ref} host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} onLabelChange={onLabelChange} />);

    // 이름 편집은 드로어 헤더(setLabel)로 이뤄진다.
    act(() => ref.current?.setLabel('Dirty local label'));

    rerender(
      <HostForm
        ref={ref}
        host={createHost({
          label: 'Server-side label',
          updatedAt: '2026-03-25T00:01:00.000Z'
        })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
        onLabelChange={onLabelChange}
      />
    );

    // dirty 로컬 편집은 재하이드레이션에 덮이지 않는다(마지막 보고값 유지).
    expect(onLabelChange).toHaveBeenLastCalledWith('Dirty local label');
  });

  it('rehydrates the form when the same host id receives a newer revision while clean', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onLabelChange = vi.fn();
    const { rerender } = render(<HostForm host={createHost()} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={onSubmit} onLabelChange={onLabelChange} />);

    rerender(
      <HostForm
        host={createHost({
          label: 'Server-side label',
          updatedAt: '2026-03-25T00:01:00.000Z'
        })}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
        onLabelChange={onLabelChange}
      />
    );

    await waitFor(() => expect(onLabelChange).toHaveBeenLastCalledWith('Server-side label'));
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
    expect(hostnameInput.className).toContain('rounded-[10px]');
    expect(hostnameInput.className).toContain('border-[var(--border)]');
    expect(hostnameInput.className).toContain('focus:border-[var(--selection-border)]');
    expect(hostnameInput.className).toContain('focus:ring-4');

    expect(tagShell.className).toContain('min-h-11');
    expect(tagShell.className).toContain('rounded-[10px]');
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
    expect(within(connectionSection).getByText('Saved Credentials')).toBeInTheDocument();

    expect(within(detailsSection).getByText('Details')).toBeInTheDocument();
    // Label(이름)은 드로어 헤더의 편집 타이틀로 이동 — Details 에는 Group·Tags 만 남는다.
    expect(within(detailsSection).queryByLabelText('Label')).not.toBeInTheDocument();
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
    const savedSecretHeading = within(connectionSection).getByText('Saved Credentials');
    const terminalThemeField = within(preferencesSection).getByText('Terminal Theme').closest('label');

    expect(authTypeField).not.toBeNull();
    expect(passwordField).not.toBeNull();
    expect(terminalThemeField).not.toBeNull();
    expect(authTypeField!.compareDocumentPosition(passwordField!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(passwordField!.compareDocumentPosition(savedSecretHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(connectionSection.compareDocumentPosition(preferencesSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders AWS SSH metadata fields and saves edited username and port', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();

    render(
      <HostForm
        ref={ref}
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

    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'aws-ec2',
        awsSshUsername: 'ec2-user',
        awsSshPort: 2222
      }),
      undefined
    );
  });

  it.each([
    { profileId: 'profile-deleted', selectedValue: 'profile-deleted' },
    { profileId: null, selectedValue: 'missing:prod-admin' },
  ])(
    'does not match an AWS profile by name when the stored profile ID is $profileId',
    async ({ profileId, selectedValue }) => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);

      render(
        <HostForm
          host={createAwsHost({
            awsProfileId: profileId,
            awsProfileName: 'prod-admin',
          })}
          keychainEntries={keychainEntries}
          groupOptions={groupOptions}
          onSubmit={onSubmit}
        />,
      );

      const missingOption = await screen.findByRole('option', {
        name: 'prod-admin (앱 프로필 없음)',
      });
      const profileSelect = screen.getByLabelText('AWS Profile') as HTMLSelectElement;

      expect(profileSelect.value).toBe(selectedValue);
      expect((missingOption as HTMLOptionElement).selected).toBe(true);
      expect((missingOption as HTMLOptionElement).disabled).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it('allows changing the AWS profile for an existing AWS host', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();

    render(
      <HostForm
        ref={ref}
        host={createAwsHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />
    );

    await waitFor(() => expect(listAwsProfiles).toHaveBeenCalled());
    // listAwsProfiles 호출만으론 부족하다: 비동기로 로드된 프로필 옵션이 실제로 렌더되어야
    // select가 활성화되고 값 변경이 반영된다. 옵션이 뜰 때까지 기다려 CI 타이밍 레이스를 없앤다.
    await screen.findByRole('option', { name: 'prod-admin' });

    fireEvent.change(screen.getByLabelText('AWS Profile'), {
      target: { value: 'profile-prod' },
    });

    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'aws-ec2',
        awsProfileId: 'profile-prod',
        awsProfileName: 'prod-admin',
      }),
      undefined,
    );
  });

  it('saves the AWS SSM server proxy toggle on explicit save', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const ref = createRef<HostFormHandle>();

    render(
      <HostForm
        ref={ref}
        host={createAwsHost()}
        keychainEntries={keychainEntries}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('switch', { name: /서버 프록시 사용/ }));

    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'aws-ec2',
        awsSsmServerProxyEnabled: true,
      }),
      undefined,
    );
  });
});

describe('getJumpHostCandidates', () => {
  it('returns other SSH hosts, excluding self and non-SSH kinds', () => {
    const self = createHost({ id: 'self', label: 'Target' });
    const bastion = createHost({ id: 'bastion', label: 'Bastion' });
    const aws = createAwsHost({ id: 'aws-1' });

    const options = getJumpHostCandidates([self, bastion, aws], 'self');

    expect(options).toEqual([
      {
        value: 'bastion',
        label: 'Bastion',
        description: 'ubuntu@prod.example.com:22',
      },
    ]);
  });

  it('includes every SSH host when there is no self id (new host)', () => {
    const a = createHost({ id: 'a', label: 'A' });
    const b = createHost({ id: 'b', label: 'B' });

    const options = getJumpHostCandidates([a, b], null);

    expect(options.map((option) => option.value)).toEqual(['a', 'b']);
  });

  it('falls back to hostname when the label is blank', () => {
    const host = createHost({ id: 'h', label: '   ', hostname: 'edge.example.com' });

    const options = getJumpHostCandidates([host], null);

    expect(options).toEqual([
      {
        value: 'h',
        label: 'edge.example.com',
        description: 'ubuntu@edge.example.com:22',
      },
    ]);
  });
});
