import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AwsEc2HostRecord, SshHostRecord } from '@shared';
import { HostForm } from './HostForm';
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
