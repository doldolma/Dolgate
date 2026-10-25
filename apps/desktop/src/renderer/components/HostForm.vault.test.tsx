import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AwsEc2HostRecord, SecretMetadataRecord, SshHostRecord } from '@shared';
import { HostForm, type HostFormHandle } from './HostForm';
import { listAwsProfiles, listTeamAwsProfiles } from '../services/desktop/imports';

// 팀 호스트의 AWS 프로필 고르기에는 그 팀의 프로필만 — 개인 프로필은 팀원에게 없다. 개인 호스트는 지금 그대로.

vi.mock('../services/desktop/imports', () => ({
  listAwsProfiles: vi.fn().mockResolvedValue([{ id: 'my-profile', name: 'my-admin' }]),
  listTeamAwsProfiles: vi.fn().mockResolvedValue([{ id: 'team-profile', name: 'team-admin' }]),
}));

// 컨트롤러는 렌더마다 같은 함수를 돌려줘야 한다 — 새로 만들면 폼의 효과가 매번 다시 돌아 끝없이 렌더한다.
const controller = {
  listSerialPorts: vi.fn().mockResolvedValue([]),
  pickPrivateKey: vi.fn(),
  pickSshCertificate: vi.fn(),
  probeSshAgent: vi.fn().mockResolvedValue({ status: 'unknown' }),
};
vi.mock('../controllers/useHostFormController', () => ({
  useHostFormController: () => controller,
}));

function awsHost(profile: { id: string; name: string }): AwsEc2HostRecord {
  return {
    id: 'aws-host-1',
    kind: 'aws-ec2',
    label: 'AWS Prod',
    awsProfileId: profile.id,
    awsProfileName: profile.name,
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
  } as AwsEc2HostRecord;
}

describe('HostForm AWS profiles by vault', () => {
  it("lists the team's profiles for a team host", async () => {
    render(
      <HostForm
        host={awsHost({ id: 'team-profile', name: 'team-admin' })}
        keychainEntries={[]}
        groupOptions={[{ value: null, label: 'Ungrouped' }]}
        vaultId="team-1"
        onSubmit={vi.fn()}
      />,
    );

    expect(await screen.findByRole('option', { name: 'team-admin' })).toBeInTheDocument();
    expect(listTeamAwsProfiles).toHaveBeenCalledWith('team-1');
    // AWS 호스트의 agent forwarding 도 나에게만 적용된다.
    fireEvent.mouseEnter(screen.getByRole('switch', { name: 'SSH 에이전트 포워딩' }).parentElement as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toBe('나에게만 적용됩니다 — 팀원의 설정은 그대로입니다.');
    expect(listAwsProfiles).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'my-admin' })).toBeNull();
  });

  it('lists personal profiles as before for a personal host', async () => {
    vi.mocked(listTeamAwsProfiles).mockClear();
    render(
      <HostForm host={awsHost({ id: 'my-profile', name: 'my-admin' })} keychainEntries={[]} groupOptions={[{ value: null, label: 'Ungrouped' }]} onSubmit={vi.fn()} />,
    );

    expect(await screen.findByRole('option', { name: 'my-admin' })).toBeInTheDocument();
    await waitFor(() => expect(listAwsProfiles).toHaveBeenCalledWith());
    expect(listTeamAwsProfiles).not.toHaveBeenCalled();
  });
});

function sshHost(): SshHostRecord {
  return {
    id: 'ssh-1',
    kind: 'ssh',
    label: 'web',
    hostname: 'web.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-03-25T00:00:00.000Z',
    updatedAt: '2026-03-25T00:00:00.000Z',
  } as SshHostRecord;
}

// 팀 호스트에서 사람마다 다른 칸은 자리는 그대로 두고 툴팁으로만 알린다.
describe('HostForm per-person fields of a team host', () => {
  it('says agent forwarding is only mine and the theme only on this device', () => {
    render(<HostForm host={sshHost()} keychainEntries={[]} groupOptions={[{ value: null, label: 'Ungrouped' }]} vaultId="team-1" onSubmit={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByRole('switch', { name: 'SSH 에이전트 포워딩' }).parentElement as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toBe('나에게만 적용됩니다 — 팀원의 설정은 그대로입니다.');
    expect(screen.getByText('이 기기에만 적용됩니다.')).toHaveClass('sr-only');
  });

  it('adds nothing for a personal host', () => {
    render(<HostForm host={sshHost()} keychainEntries={[]} groupOptions={[{ value: null, label: 'Ungrouped' }]} onSubmit={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByRole('switch', { name: 'SSH 에이전트 포워딩' }).parentElement as HTMLElement);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryByText('이 기기에만 적용됩니다.')).toBeNull();
  });
});

// 만드는 중에 볼트를 바꿀 수 있다(서랍 맨 위 Vault). 적어 둔 것은 그대로 두고, 앞 볼트 안의 것을 가리키던 고른 값만
// 비운다 — 그룹·저장된 인증 정보·점프 호스트·tailnet·스니펫은 볼트마다 따로라, 두면 새 볼트에 없는 것을 가리킨 채 저장된다.
describe('HostForm vault switch while creating', () => {
  const savedPassword = {
    secretRef: 'secret:mine',
    label: 'My Password',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2026-10-24T00:00:00.000Z',
  } as SecretMetadataRecord;
  // 개인 볼트의 고를 거리. 팀 볼트는 아무것도 없다.
  const personalLists = {
    keychainEntries: [savedPassword],
    groupOptions: [
      { value: null, label: 'Ungrouped' },
      { value: 'Prod', label: 'Prod' },
    ],
    jumpHostOptions: [{ value: 'bastion-1', label: 'bastion' }],
    tailnetOptions: [{ id: 'net-mine', label: 'my-net' }],
    snippets: [
      { id: 'snippet-mine', label: 'Open app', keyword: 'app', command: 'cd /srv/app', createdAt: '', updatedAt: '' },
    ],
  };
  const teamLists = {
    keychainEntries: [],
    groupOptions: [{ value: null, label: 'Ungrouped' }],
    jumpHostOptions: [],
    tailnetOptions: [],
    snippets: [],
  };

  function renderCreate(props: Partial<ComponentProps<typeof HostForm>> = {}) {
    const ref = createRef<HostFormHandle>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(<HostForm ref={ref} host={null} defaultGroupPath="Prod" {...personalLists} {...props} onSubmit={onSubmit} />);
    const moveTo = (next: Partial<ComponentProps<typeof HostForm>>) =>
      view.rerender(<HostForm ref={ref} host={null} defaultGroupPath="Prod" {...personalLists} {...next} onSubmit={onSubmit} />);
    const submit = async () => {
      await act(async () => {
        await ref.current?.submitCreate();
      });
      return onSubmit.mock.lastCall as [Record<string, unknown>, Record<string, unknown> | undefined];
    };
    return { ref, moveTo, submit };
  }

  function pick(ariaLabel: string, optionName: string) {
    fireEvent.click(screen.getByRole('button', { name: ariaLabel }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(optionName) }));
  }

  it('keeps what was typed', async () => {
    const { ref, moveTo, submit } = renderCreate();
    act(() => ref.current?.setLabel('DB'));
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'db.internal' } });
    fireEvent.change(screen.getByLabelText('사용자 이름'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'typed-secret' } });

    // 홈이 팀 볼트의 목록을 내려주고, 그룹은 그 볼트 맨 위에서 시작한다.
    moveTo({ vaultId: 'team-1', defaultGroupPath: null, ...teamLists });

    expect(screen.getByLabelText('호스트 이름')).toHaveValue('db.internal');
    const [draft, secrets] = await submit();
    expect(draft).toMatchObject({ label: 'DB', hostname: 'db.internal', username: 'admin', groupName: '' });
    // 새로 적은 비밀번호는 고른 것이 아니라 적은 것이다 — 새 볼트에 만들어진다.
    expect(secrets).toMatchObject({ password: 'typed-secret' });
  });

  it("drops the picks that point into the previous vault", async () => {
    const { moveTo, submit } = renderCreate();
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'db.internal' } });
    pick('저장된 인증 정보', 'My Password');
    pick('점프 호스트 추가', 'bastion');
    const tailnetSelect = screen.getByRole('option', { name: 'my-net' }).closest('select') as HTMLSelectElement;
    fireEvent.change(tailnetSelect, { target: { value: 'net-mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Snippet' }));
    pick('Startup snippet', 'Open app');

    moveTo({ vaultId: 'team-1', defaultGroupPath: null, ...teamLists });

    const [draft, secrets] = await submit();
    expect(draft).toMatchObject({
      hostname: 'db.internal',
      groupName: '',
      secretRef: null,
      jumpHostId: null,
      jumpHostIds: null,
      tailnetId: null,
      startupCommand: null,
    });
    expect(secrets).toBeUndefined();
  });

  it('keeps a typed startup command — only a snippet belongs to a vault', async () => {
    const { moveTo, submit } = renderCreate();
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'db.internal' } });
    fireEvent.click(screen.getByRole('button', { name: '명령' }));
    fireEvent.change(screen.getByLabelText('시작 명령'), { target: { value: 'htop' } });

    moveTo({ vaultId: 'team-1', defaultGroupPath: null, ...teamLists });

    const [draft] = await submit();
    expect(draft).toMatchObject({ startupCommand: { type: 'command', command: 'htop' } });
  });

  // 볼트 맨 위에서 열었으면 바꿔도 시작 그룹은 그대로 맨 위다 — 폼은 볼트가 바뀐 것만으로 알아채야 한다.
  it("drops a VNC host's SSH tunnel and saved password, opened at a vault's top", async () => {
    const vncPassword = { ...savedPassword, secretRef: 'secret:vnc', label: 'Lab VNC', kind: 'vnc' } as SecretMetadataRecord;
    const { moveTo, submit } = renderCreate({ createKind: 'vnc', defaultGroupPath: null, keychainEntries: [vncPassword] });
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: '10.0.0.6' } });
    pick('VNC 비밀번호', 'Lab VNC');
    pick('SSH 터널', 'bastion');

    moveTo({ createKind: 'vnc', vaultId: 'team-1', defaultGroupPath: null, ...teamLists });

    const [draft] = await submit();
    expect(draft).toMatchObject({ kind: 'vnc', hostname: '10.0.0.6', secretRef: null, sshTunnelHostId: null });
  });

  it("drops an RDP host's saved credential and tailnet", async () => {
    const rdpCredential = { ...savedPassword, secretRef: 'secret:rdp', label: 'Admin RDP', kind: 'rdp' } as SecretMetadataRecord;
    const { moveTo, submit } = renderCreate({ createKind: 'rdp', keychainEntries: [rdpCredential] });
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'win.internal' } });
    pick('인증 정보', 'Admin RDP');
    const tailnetSelect = screen.getByRole('option', { name: 'my-net' }).closest('select') as HTMLSelectElement;
    fireEvent.change(tailnetSelect, { target: { value: 'net-mine' } });

    moveTo({ createKind: 'rdp', vaultId: 'team-1', defaultGroupPath: null, ...teamLists });
    // 고른 자격 증명이 풀렸으니 새로 적는다(RDP 계정은 자격 증명에 든다).
    fireEvent.change(screen.getByLabelText('사용자 이름'), { target: { value: 'Administrator' } });

    const [draft] = await submit();
    expect(draft).toMatchObject({ kind: 'rdp', hostname: 'win.internal', groupName: '', secretRef: null, tailnetId: null });
  });

  // 고치던 호스트에서 만들기로 넘어가면(서랍이 그대로 남는다) 다른 볼트여도 새 폼이다 — 고치던 호스트의 값이 새 호스트로
  // 넘어가면 안 된다.
  it('starts over when it goes from editing to creating in another vault', () => {
    const { moveTo } = renderCreate();
    moveTo({ host: sshHost(), vaultId: 'team-1' } as never);
    expect(screen.getByLabelText('호스트 이름')).toHaveValue('web.example.com');

    moveTo({ host: null, vaultId: 'team-1', defaultGroupPath: null, ...teamLists } as never);

    expect(screen.getByLabelText('호스트 이름')).toHaveValue('');
  });

  // 볼트를 안 바꾼 다른 이유의 다시 열기는 지금처럼 새 폼이다.
  it('still starts over for another group in the same vault', () => {
    const { moveTo } = renderCreate();
    fireEvent.change(screen.getByLabelText('호스트 이름'), { target: { value: 'db.internal' } });

    moveTo({ defaultGroupPath: null });

    expect(screen.getByLabelText('호스트 이름')).toHaveValue('');
  });
});
