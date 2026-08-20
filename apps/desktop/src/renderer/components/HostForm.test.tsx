import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef, type RefObject } from 'react';
import type { AwsEc2HostRecord, HostRecord, SecretMetadataRecord, SnippetRecord, SshHostRecord } from '@shared';
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

/**
 * 검색 가능한 목록에서 하나 고른다.
 *
 * 평범한 select 가 아니라 버튼 + listbox 라 `change` 이벤트가 없다 — 열고 골라야 한다(점프 호스트
 * 목록과 같은 컴포넌트다).
 */
/** 검색 가능한 목록의 현재 선택. native select 의 value 가 아니라 트리거 버튼의 글자다. */
function selectedOptionText(ariaLabel: string): string {
  return screen.getByRole('button', { name: ariaLabel }).textContent ?? '';
}

function pickFromSearchableSelect(ariaLabel: string, optionName: string) {
  fireEvent.click(screen.getByRole('button', { name: ariaLabel }));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(optionName) }));
}

function createVncHost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vnc-1',
    kind: 'vnc',
    label: 'Lab',
    hostname: '10.0.0.6',
    port: 5900,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
    updatedAt: '2026-03-25T00:00:00.000Z',
    ...overrides,
  } as unknown as HostRecord;
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
        saveStatusText: '저장됨',
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

    const manageButtons = screen.getAllByRole('button', { name: '관리' });
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

    fireEvent.click(screen.getByRole('button', { name: '명령' }));
    fireEvent.change(screen.getByLabelText('시작 명령'), {
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

    fireEvent.click(screen.getByRole('switch', { name: 'SSH 에이전트 포워딩' }));

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
      name: 'SSH 에이전트 포워딩',
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

    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'prod.example.com' } });

    // 라벨 입력은 드로어 헤더로 옮겨졌으므로, 파생된 이름은 onLabelChange 로 관찰한다.
    expect(onLabelChange).toHaveBeenLastCalledWith('prod.example.com');
  });

  it('keeps a manually edited label when hostname changes afterwards', () => {
    const onLabelChange = vi.fn();
    const ref = createRef<HostFormHandle>();
    render(<HostForm ref={ref} host={null} keychainEntries={keychainEntries} groupOptions={groupOptions} onSubmit={vi.fn().mockResolvedValue(undefined)} onLabelChange={onLabelChange} />);

    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'prod.example.com' } });
    act(() => ref.current?.setLabel('Production API'));
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'api.example.com' } });

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
      />,
    );

    expect(screen.getByText('저장된 인증 정보')).toBeInTheDocument();
    expect(screen.getByLabelText('저장된 인증 정보')).toBeInTheDocument();
    // 설정으로 보내는 '관리' 링크는 없다 — 편집은 아래 '편집' 버튼이 담당한다.
    expect(screen.queryByRole('button', { name: '관리' })).not.toBeInTheDocument();
  });

  it('shows certificate-specific fields and filters saved secrets for certificate auth', () => {
    render(
      <HostForm
        host={null}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.change(screen.getByLabelText('인증 방식'), {
      target: { value: 'certificate' },
    });

    expect(screen.getByLabelText('개인키 파일')).toBeInTheDocument();
    expect(screen.getByLabelText('SSH 인증서 파일')).toBeInTheDocument();
    expect(screen.getByLabelText('패스프레이즈')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '저장된 인증 정보' }));
    expect(screen.queryByRole('option', { name: '사용 안 함' })).not.toBeInTheDocument();
    // 이름은 첫 줄, 종류·연결 수는 둘째 줄이다 — 접근성 이름에는 둘이 이어서 들어온다.
    expect(
      screen.getByRole('option', { name: /Shared Certificate.*SSH certificate \+ Passphrase/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Shared Key/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Shared Password/ })).not.toBeInTheDocument();
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

    expect(await screen.findByLabelText('전송 방식')).toBeInTheDocument();
    expect(await screen.findByLabelText('감지된 시리얼 포트')).toBeInTheDocument();
    expect(screen.getByLabelText('장치 경로')).toBeInTheDocument();
    expect(screen.getByLabelText('전송 줄바꿈')).toBeInTheDocument();
    expect(screen.queryByLabelText('인증 방식')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('저장된 인증 정보')).not.toBeInTheDocument();
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

    fireEvent.change(await screen.findByLabelText('전송 방식'), {
      target: { value: 'raw-tcp' },
    });

    expect(screen.getByLabelText('원격 호스트')).toBeInTheDocument();
    expect(screen.getByLabelText('포트')).toBeInTheDocument();
    expect(screen.getByLabelText('전송 줄바꿈')).toBeInTheDocument();
    expect(screen.queryByLabelText('통신 속도(baud)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('데이터 비트')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('흐름 제어')).not.toBeInTheDocument();
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
      />,
    );

    await waitFor(() =>
      expect(selectedOptionText('저장된 인증 정보')).toContain('Shared Password'),
    );
    expect(screen.queryByRole('button', { name: '관리' })).not.toBeInTheDocument();
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
      expect(selectedOptionText('저장된 인증 정보')).toContain('Shared Certificate'),
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
      />,
    );

    await waitFor(() =>
      expect(selectedOptionText('저장된 인증 정보')).toContain('Shared Password'),
    );

    rerender(
      <HostForm
        host={createHost({ secretRef: 'secret-password', authType: 'password' })}
        keychainEntries={reusableKeychainEntries.filter((entry) => entry.secretRef !== 'secret-password')}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(selectedOptionText('저장된 인증 정보')).toContain('새 인증 정보 저장'),
    );
  });

  it('falls back to no saved secret when the selected certificate secret disappears', async () => {
    const { rerender } = render(
      <HostForm
        host={createHost({ secretRef: 'secret-certificate', authType: 'certificate' })}
        keychainEntries={reusableKeychainEntries}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(selectedOptionText('저장된 인증 정보')).toContain('Shared Certificate'),
    );

    rerender(
      <HostForm
        host={createHost({ secretRef: 'secret-certificate', authType: 'certificate' })}
        keychainEntries={reusableKeychainEntries.filter((entry) => entry.secretRef !== 'secret-certificate')}
        groupOptions={groupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(selectedOptionText('저장된 인증 정보')).toContain('새 인증 정보 저장'),
    );
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

    fireEvent.change(screen.getByLabelText('인증 방식'), {
      target: { value: 'privateKey' },
    });
    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: 'prod.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await waitFor(() => expect(screen.getByLabelText('개인키 파일')).toHaveValue('id_ed25519'));

    const form = screen.getByLabelText('호스트 이름').closest('form');
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

    const hostnameInput = screen.getByLabelText('호스트 이름');
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
    expect(within(connectionSection).getByLabelText('호스트 이름')).toBeInTheDocument();
    expect(within(connectionSection).getByText('인증 방식')).toBeInTheDocument();
    expect(within(connectionSection).getByLabelText('비밀번호')).toBeInTheDocument();
    expect(within(connectionSection).getByText('저장된 인증 정보')).toBeInTheDocument();

    expect(within(detailsSection).getByText('Details')).toBeInTheDocument();
    // Label(이름)은 드로어 헤더의 편집 타이틀로 이동 — Details 에는 Group·Tags 만 남는다.
    expect(within(detailsSection).queryByLabelText('Label')).not.toBeInTheDocument();
    expect(within(detailsSection).getByLabelText('그룹')).toBeInTheDocument();
    expect(within(detailsSection).getByLabelText('태그')).toBeInTheDocument();

    expect(within(preferencesSection).getByText('Preferences')).toBeInTheDocument();
    expect(within(preferencesSection).getByText('터미널 테마')).toBeInTheDocument();

    expect(connectionSection.compareDocumentPosition(detailsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detailsSection.compareDocumentPosition(preferencesSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // 그룹·태그는 Details 카드 안에만 있어야 한다. 폼 맨 위에도 그려지면(카드 밖) 같은 입력이 두 벌
  // 보이고, 위쪽 것을 고쳐도 아래쪽이 그대로여서 어느 쪽이 저장되는지 알 수 없다. RDP·VNC 를 추가할
  // 때 각각 한 번씩 이렇게 새어 나왔다.
  it.each(['ssh', 'serial', 'rdp', 'vnc'] as const)(
    '%s 폼은 그룹·태그를 Details 안에 한 번만 그린다',
    (kind) => {
      render(
        <HostForm
          host={null}
          createKind={kind}
          keychainEntries={reusableKeychainEntries}
          groupOptions={groupOptions}
          onSubmit={vi.fn().mockResolvedValue(undefined)}
        />,
      );

      expect(screen.getAllByLabelText('그룹')).toHaveLength(1);
      expect(screen.getAllByLabelText('태그')).toHaveLength(1);

      const detailsSection = screen.getByTestId('hostform-section-details');
      expect(within(detailsSection).getByLabelText('그룹')).toBeInTheDocument();
      expect(within(detailsSection).getByLabelText('태그')).toBeInTheDocument();
    },
  );

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
    const authTypeField = within(connectionSection).getByText('인증 방식').closest('label');
    const passwordField = within(connectionSection).getByLabelText('비밀번호').closest('label');
    const savedSecretHeading = within(connectionSection).getByText('저장된 인증 정보');
    const terminalThemeField = within(preferencesSection).getByText('터미널 테마').closest('label');

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

    expect((screen.getByLabelText('가용 영역') as HTMLInputElement).value).toBe('ap-northeast-2a');
    expect(screen.getByText('SSH 설정 자동 확인됨')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('SSH 사용자 이름'), {
      target: { value: 'ec2-user' }
    });
    fireEvent.change(screen.getByLabelText('SSH 포트'), {
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
      const profileSelect = screen.getByLabelText('AWS 프로필') as HTMLSelectElement;

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

    fireEvent.change(screen.getByLabelText('AWS 프로필'), {
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

// 저장한 자격증명이 화면에서 사라지던 회귀. 원인은 두 가지였다:
//  (1) 고른 ref 가 필터된 목록에 없으면 선택을 지우는 효과 → 저장 직후 "새 자격증명"으로 되돌아감
//  (2) 자격증명이 없으면 저장을 막는 조건 → 그 상태에서 저장 버튼이 아무 반응 없이 무시됨
// 저장 자체는 정상이었는데(활동 로그에 secret 갱신이 남았다) 폼만 그렇게 보였다.
describe('HostForm RDP credential selection', () => {
  function createRdpHost(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rdp-1',
      kind: 'rdp' as const,
      label: 'Win Box',
      tags: [],
      hostname: '10.0.2.181',
      port: 3389,
      secretRef: 'secret:rdp',
      groupName: null,
      terminalThemeId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('keeps showing the stored credential even when it is not in the reusable list', () => {
    // kind 가 없는 옛 항목이거나 목록 갱신이 늦은 경우다. 빼 버리면 저장한 것이 풀린 것처럼 보인다.
    render(
      <HostForm
        host={createRdpHost() as never}
        keychainEntries={[
          {
            secretRef: 'secret:rdp',
            label: 'Win admin',
            hasPassword: true,
            hasPassphrase: false,
            hasManagedPrivateKey: false,
            hasCertificate: false,
            linkedHostCount: 1,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        groupOptions={groupOptions}
        onSubmit={vi.fn()}
      />,
    );

    expect(selectedOptionText('인증 정보')).toContain('Win admin');
  });

  // RDP 와 같은 증상이 VNC 에서도 났다. 같은 헬퍼를 쓰는지 여기서 본다 — 한쪽만 고치면 반복된다.
  it('VNC 도 목록에 없는 저장된 자격증명을 그대로 보여준다', () => {
    render(
      <HostForm
        host={
          {
            ...createRdpHost(),
            id: 'vnc-1',
            kind: 'vnc',
            port: 5900,
            secretRef: 'secret:vnc',
          } as never
        }
        keychainEntries={[
          {
            // kind 가 'vnc' 가 아니라 vncReusableEntries 필터에서 빠진다.
            secretRef: 'secret:vnc',
            label: 'VNC 화면',
            hasPassword: true,
            hasPassphrase: false,
            hasManagedPrivateKey: false,
            hasCertificate: false,
            linkedHostCount: 1,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        groupOptions={groupOptions}
        onSubmit={vi.fn()}
      />,
    );

    expect(selectedOptionText('VNC 비밀번호')).toContain('VNC 화면');
  });

  it('saves a newly entered account and password', async () => {
    // 자격증명이 없다고 저장을 막아 두면 버튼을 눌러도 아무 일이 없는데 이유를 알 수 없다.
    // 계정은 호스트 레코드가 아니라 자격증명(secrets)으로 나가야 한다.
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={createRdpHost({ secretRef: null }) as never}
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('사용자 이름'), {
      target: { value: 'Administrator' },
    });
    fireEvent.change(screen.getByLabelText('도메인'), { target: { value: 'CORP' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });

    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rdp' }),
      expect.objectContaining({
        kind: 'rdp',
        username: 'Administrator',
        domain: 'CORP',
        password: 'pw',
      }),
    );
  });

  // 생성 경로가 SSH 만 자격증명을 다루던 탓에 RDP 도 같이 새고 있었다. 종류별로 갈리지 않는지
  // 여기서 함께 본다.
  it('RDP 생성에서 입력한 비밀번호가 자격증명으로 나간다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={null}
        createKind="rdp"
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: '10.0.2.181' },
    });
    fireEvent.change(screen.getByLabelText('사용자 이름'), {
      target: { value: 'Administrator' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });

    await act(async () => {
      await ref.current?.submitCreate();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rdp' }),
      expect.objectContaining({
        kind: 'rdp',
        username: 'Administrator',
        password: 'pw',
      }),
    );
  });

  // 편집 저장은 진작 되고 있었지만 생성은 아니었다. 두 경로를 따로 본다.
  it('VNC 생성에서 입력한 비밀번호가 자격증명으로 나간다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={null}
        createKind="vnc"
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: '192.168.0.10' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'secret12' } });

    await act(async () => {
      await ref.current?.submitCreate();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'vnc' }),
      expect.objectContaining({ kind: 'vnc', password: 'secret12' }),
    );
  });

  // 입력 순서가 결과를 바꾸면 안 된다. useCallback 의존성이 빠져 있으면 마지막으로 콜백이 다시
  // 만들어진 시점의 값으로 굳는데, 그 증상이 정확히 "나중에 적은 칸만 저장되지 않는다" 다.
  it('RDP 편집에서 계정을 비밀번호보다 나중에 적어도 저장된다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={createRdpHost({ secretRef: null }) as never}
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('사용자 이름'), {
      target: { value: 'Administrator' },
    });

    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rdp' }),
      expect.objectContaining({ username: 'Administrator', password: 'pw' }),
    );
  });

  // 화질은 기본이 무손실이어야 한다. 켜는 것은 사용자가 고를 일이고, 저장 경로가 값을 흘리면
  // 느린 회선에서 그 설정이 아무 효과가 없다.
  it('VNC 화질을 고르면 draft 에 실리고 무손실은 저장하지 않는다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={null}
        createKind="vnc"
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: '192.168.0.10' },
    });
    // 기본값은 무손실이다.
    expect((screen.getByLabelText('화질') as HTMLSelectElement).value).toBe('lossless');

    fireEvent.change(screen.getByLabelText('화질'), { target: { value: 'balanced' } });
    await act(async () => {
      await ref.current?.submitCreate();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'vnc', imageQuality: 'balanced' }),
      undefined,
    );

    // 무손실로 되돌리면 null 로 나간다 — 기본값을 저장하지 않는 규칙이다.
    onSubmit.mockClear();
    fireEvent.change(screen.getByLabelText('화질'), { target: { value: 'lossless' } });
    await act(async () => {
      await ref.current?.submitCreate();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ imageQuality: null }),
      undefined,
    );
  });

  // QEMU·libvirt 콘솔은 5900 을 localhost 에만 바인딩하는 것이 관행이라, 터널을 고를 수 없으면
  // 그 서버에는 아예 닿지 못한다. 필드가 없어서 DB 를 직접 만지지 않으면 켤 수 없던 기능이다.
  it('VNC SSH 터널을 고르면 draft 에 실리고 대상 주소가 채워진다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={null}
        createKind="vnc"
        keychainEntries={[]}
        groupOptions={groupOptions}
        jumpHostOptions={[
          { value: 'ssh-1', label: 'bastion', description: 'ops@bastion.example:22' },
        ]}
        onSubmit={onSubmit}
      />,
    );

    pickFromSearchableSelect('SSH 터널', 'bastion');

    // 터널 뒤의 VNC 서버는 대개 경유 서버 자신이다. 비워 두면 required 에 걸려 저장이 막힌다.
    expect((screen.getByLabelText('대상 주소(경유 서버에서 본)') as HTMLInputElement).value).toBe(
      '127.0.0.1',
    );

    await act(async () => {
      await ref.current?.submitCreate();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'vnc',
        sshTunnelHostId: 'ssh-1',
        hostname: '127.0.0.1',
      }),
      undefined,
    );
  });

  // 이미 적어 둔 주소는 경유 서버 뒤의 다른 기기를 가리킬 수 있다. 덮어쓰면 그 구성을 못 쓴다.
  it('VNC 터널을 켤 때 적어 둔 대상 주소는 덮지 않는다', () => {
    render(
      <HostForm
        host={null}
        createKind="vnc"
        keychainEntries={[]}
        groupOptions={groupOptions}
        jumpHostOptions={[{ value: 'ssh-1', label: 'bastion' }]}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: '10.0.0.9' },
    });
    pickFromSearchableSelect('SSH 터널', 'bastion');

    expect((screen.getByLabelText('대상 주소(경유 서버에서 본)') as HTMLInputElement).value).toBe(
      '10.0.0.9',
    );
  });

  // 접속 경로(ipc/vnc.ts 의 openForward)가 tailnetId 를 먼저 보고 끝내므로, 둘 다 정하면 터널이
  // 조용히 무시된다. 배타로 두어도 잃는 것이 없다 — 터널은 그 SSH 호스트의 tailnet 설정을 탄다.
  it('VNC 터널과 tailnet 은 서로를 잠근다', () => {
    render(
      <HostForm
        host={null}
        createKind="vnc"
        keychainEntries={[]}
        groupOptions={groupOptions}
        jumpHostOptions={[{ value: 'ssh-1', label: 'bastion' }]}
        tailnetOptions={[{ id: 'net-corp', label: 'corp' }]}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const tunnelTrigger = () =>
      screen.getByRole('button', { name: 'SSH 터널' }) as HTMLButtonElement;
    // tailnet 은 평범한 select 다(등록된 tailnet 은 몇 개뿐이라 검색이 필요 없다).
    const tailnet = screen
      .getByRole('option', { name: 'corp' })
      .closest('select') as HTMLSelectElement;

    // 처음에는 둘 다 고를 수 있다.
    expect(tunnelTrigger().disabled).toBe(false);
    expect(tailnet.disabled).toBe(false);

    pickFromSearchableSelect('SSH 터널', 'bastion');
    expect(tailnet.disabled).toBe(true);
    expect(screen.getByText('터널이 그 SSH 호스트의 tailnet 설정을 그대로 탑니다.')).toBeTruthy();

    // 터널을 끄면 tailnet 이 다시 열리고, tailnet 을 고르면 이번엔 터널이 잠긴다.
    pickFromSearchableSelect('SSH 터널', '쓰지 않음');
    expect(tailnet.disabled).toBe(false);
    fireEvent.change(tailnet, { target: { value: 'net-corp' } });
    expect(tunnelTrigger().disabled).toBe(true);
  });

  // 가리키던 SSH 호스트를 지웠을 수 있다. 목록에서 빼면 "안 쓰는 것" 으로 보여 조용히 직접 접속으로
  // 바뀐다 — 그대로 남겨 두고 경고해야 사용자가 고칠 수 있다.
  it('지워진 터널 호스트를 그대로 보여주고 경고한다', () => {
    render(
      <HostForm
        host={createVncHost({ sshTunnelHostId: 'ssh-gone' })}
        keychainEntries={[]}
        groupOptions={groupOptions}
        jumpHostOptions={[{ value: 'ssh-1', label: 'bastion' }]}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // 트리거에 그 항목이 그대로 보인다(값이 살아 있다는 증거다).
    expect(screen.getByRole('button', { name: 'SSH 터널' }).textContent).toContain(
      '삭제된 SSH 호스트',
    );
    expect(
      screen.getByText('여기 저장된 SSH 호스트가 없습니다. 다시 고르거나 터널을 끄세요.'),
    ).toBeTruthy();
  });

  // 계정만 넣으면 자격증명이 만들어지지 않는다. 그것을 말해 주지 않으면 입력한 계정이 조용히
  // 사라지고 저장은 성공한 것처럼 보인다(실제로 그렇게 겪었다).
  it('계정만 넣고 저장하면 이유를 보여주고 막는다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={null}
        createKind="vnc"
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: '192.168.0.10' },
    });
    fireEvent.change(screen.getByLabelText('계정 (선택)'), {
      target: { value: 'operator' },
    });

    expect(screen.getByText('계정을 쓰려면 비밀번호도 함께 입력해야 합니다.')).toBeTruthy();
    expect((screen.getByLabelText('비밀번호') as HTMLInputElement).required).toBe(true);

    await act(async () => {
      await ref.current?.submitCreate();
    });
    expect(onSubmit).not.toHaveBeenCalled();

    // 비밀번호를 넣으면 막지 않는다.
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
    await act(async () => {
      await ref.current?.submitCreate();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'vnc' }),
      expect.objectContaining({ username: 'operator', password: 'pw' }),
    );
  });

  // 계정은 VeNCrypt Plain 계열에서만 쓰인다. 폼이 값을 흘리면 8자 넘는 비밀번호를 쓰는 서버에
  // 붙을 방법이 없어진다.
  it('VNC 계정을 자격증명에 함께 싣는다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={null}
        createKind="vnc"
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: '192.168.0.10' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: '여덟자넘는비밀번호' },
    });
    fireEvent.change(screen.getByLabelText('계정 (선택)'), {
      target: { value: 'operator' },
    });

    await act(async () => {
      await ref.current?.submitCreate();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'vnc' }),
      expect.objectContaining({
        kind: 'vnc',
        username: 'operator',
        password: '여덟자넘는비밀번호',
      }),
    );
  });

  // 기존 자격증명을 고르면 그 ref 가 draft 에 실려야 한다. 예전에는 셀렉트 상태만 바뀌고 draft 는
  // 그대로여서, 저장한 뒤 편집 화면에 들어가면 아무것도 선택돼 있지 않았다.
  it('VNC 생성에서 고른 기존 자격증명이 draft 에 실린다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={null}
        createKind="vnc"
        keychainEntries={[
          {
            secretRef: 'secret:vnc-1',
            label: 'Lab VNC',
            kind: 'vnc',
            hasPassword: true,
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as never,
        ]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: '192.168.0.10' },
    });
    pickFromSearchableSelect('VNC 비밀번호', 'Lab VNC');

    await act(async () => {
      await ref.current?.submitCreate();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'vnc', secretRef: 'secret:vnc-1' }),
      // 기존 것을 골랐으므로 새 자격증명을 만들지 않는다.
      undefined,
    );
  });

  // VNC 도 같은 경로를 타야 한다. 이 분기가 RDP 만 보고 있어서 VNC 비밀번호는 폼을 벗어나지
  // 못했다 — 호스트는 저장되고 자격증명만 조용히 사라졌다.
  it('VNC 비밀번호를 자격증명으로 넘긴다', async () => {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HostForm
        ref={ref}
        host={
          {
            id: 'vnc-1',
            kind: 'vnc' as const,
            label: 'Lab VNC',
            tags: [],
            hostname: '192.168.0.10',
            port: 5900,
            secretRef: null,
            groupName: null,
            terminalThemeId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as never
        }
        keychainEntries={[]}
        groupOptions={groupOptions}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'secret12' } });

    await saveEdit(ref);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'vnc' }),
      // 종류가 'rdp' 로 굳어 있으면 VNC 자격증명이 RDP 목록에 섞인다.
      expect.objectContaining({ kind: 'vnc', password: 'secret12' }),
    );
  });

});
