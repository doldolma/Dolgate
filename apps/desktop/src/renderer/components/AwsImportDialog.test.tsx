import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwsProfileStatus, DesktopApi } from '@shared';
import {
  AwsImportDialog,
  shouldDisableAwsProfileSelect,
  shouldDisableAwsRegionSelect,
  shouldShowAwsProfileAuthError,
} from './AwsImportDialog';

function createStatus(overrides: Partial<AwsProfileStatus> = {}): AwsProfileStatus {
  return {
    id: null,
    profileName: 'default',
    available: true,
    isSsoProfile: false,
    isAuthenticated: false,
    configuredRegion: null,
    accountId: null,
    arn: null,
    errorMessage: null,
    ...overrides,
  };
}

function installMockApi(overrides?: {
  inspectHostSshMetadata?: ReturnType<typeof vi.fn>;
  awsProfilesServerSupport?: 'unknown' | 'supported' | 'unsupported';
}) {
  const api = {
    sync: {
      status: vi.fn().mockResolvedValue({
        status: 'ready',
        lastSuccessfulSyncAt: '2026-04-07T00:00:00.000Z',
        pendingPush: false,
        errorMessage: null,
        awsProfilesServerSupport: overrides?.awsProfilesServerSupport ?? 'supported',
      }),
    },
    aws: {
      listProfiles: vi.fn().mockResolvedValue([{ id: 'profile-default', name: 'default' }]),
      createProfile: vi.fn().mockResolvedValue(undefined),
      prepareSsoProfile: vi.fn().mockResolvedValue({
        preparationToken: 'prep-token',
        profileName: 'corp-sso',
        ssoSessionName: 'corp-sso',
        ssoStartUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'ap-northeast-2',
        region: 'ap-northeast-2',
        accounts: [
          {
            accountId: '123456789012',
            accountName: 'corp',
            emailAddress: 'admin@example.com',
          },
        ],
        rolesByAccountId: {
          '123456789012': [
            {
              accountId: '123456789012',
              roleName: 'AdministratorAccess',
            },
          ],
        },
        defaultAccountId: '123456789012',
        defaultRoleName: 'AdministratorAccess',
      }),
      getProfileStatus: vi.fn().mockResolvedValue(
        createStatus({
          isAuthenticated: true,
          configuredRegion: 'ap-northeast-2',
        }),
      ),
      login: vi.fn().mockResolvedValue(undefined),
      listRegions: vi.fn().mockResolvedValue(['ap-northeast-2']),
      listEc2Instances: vi.fn().mockResolvedValue([
        {
          instanceId: 'i-aws',
          name: 'web-1',
          availabilityZone: 'ap-northeast-2a',
          platform: 'Linux/UNIX',
          privateIp: '10.0.0.10',
          state: 'running',
          ssmAvailability: 'ready',
          ssmAvailabilityReason: null,
        },
      ]),
      listEcsClusters: vi.fn().mockResolvedValue([
        {
          clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
          clusterName: 'prod',
          status: 'ACTIVE',
          activeServicesCount: 4,
          runningTasksCount: 6,
          pendingTasksCount: 1,
        },
      ]),
      inspectHostSshMetadata:
        overrides?.inspectHostSshMetadata ??
        vi.fn().mockResolvedValue({
          sshPort: 22,
          recommendedUsername: 'ubuntu',
          usernameCandidates: ['ubuntu', 'deploy'],
          status: 'ready',
          errorMessage: null,
        }),
      loadHostSshMetadata: vi.fn().mockResolvedValue(undefined),
      getWindowsPassword: vi.fn().mockResolvedValue({
        password: 'Init!alPass',
        reason: null,
      }),
    },
    shell: {
      pickPrivateKey: vi.fn().mockResolvedValue(null),
    },
  };

  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    value: api as unknown as DesktopApi,
  });

  return api;
}

describe('shouldShowAwsProfileAuthError', () => {
  it('hides the auth error while the profile status is still loading', () => {
    expect(shouldShowAwsProfileAuthError(createStatus(), true)).toBe(false);
  });

  it('shows the auth error only after loading completes with an unauthenticated profile', () => {
    expect(shouldShowAwsProfileAuthError(createStatus(), false)).toBe(true);
    expect(shouldShowAwsProfileAuthError(createStatus({ isAuthenticated: true }), false)).toBe(false);
    expect(shouldShowAwsProfileAuthError(null, false)).toBe(false);
  });
});

describe('AWS import select disabled state', () => {
  it('disables the profile select while any dependent AWS data is loading', () => {
    expect(
      shouldDisableAwsProfileSelect({
        isLoadingProfiles: false,
        isLoadingStatus: true,
        isLoadingRegions: false,
        isLoadingInstances: false,
        isLoggingIn: false,
        profileCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldDisableAwsProfileSelect({
        isLoadingProfiles: false,
        isLoadingStatus: false,
        isLoadingRegions: false,
        isLoadingInstances: false,
        isLoggingIn: false,
        profileCount: 1,
      }),
    ).toBe(false);
  });

  it('disables the region select while region or instance data is loading', () => {
    expect(
      shouldDisableAwsRegionSelect({
        isLoadingStatus: false,
        isLoadingRegions: true,
        isLoadingInstances: false,
        isLoggingIn: false,
        regionCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldDisableAwsRegionSelect({
        isLoadingStatus: false,
        isLoadingRegions: false,
        isLoadingInstances: true,
        isLoggingIn: false,
        regionCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldDisableAwsRegionSelect({
        isLoadingStatus: false,
        isLoadingRegions: false,
        isLoadingInstances: false,
        isLoggingIn: false,
        regionCount: 1,
      }),
    ).toBe(false);
  });
});

describe('AwsImportDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Windows 인스턴스는 RDP 로도 붙을 수 있다. Linux 의 "SSH 정보 확인" 과 같은 자리에서 초기 관리자
  // 암호를 가져와 자격증명으로 저장한다 — 암호 없이 만든 호스트는 붙을 수 없으므로 등록을 막는다.
  it('RDP 로 추가하면 암호를 가져와 자격증명과 함께 등록한다', async () => {
    const api = installMockApi();
    api.aws.getProfileStatus.mockResolvedValue(
      createStatus({ isAuthenticated: true, configuredRegion: 'ap-northeast-2' }),
    );
    api.aws.listRegions.mockResolvedValue(['ap-northeast-2']);
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-win',
        name: 'test',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Windows',
        privateIp: '10.0.2.181',
        keyName: 'gw-prod-keypair',
        state: 'running',
        ssmAvailability: 'ready',
        ssmAvailabilityReason: null,
      },
    ]);
    const onImport = vi.fn().mockResolvedValue(undefined);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    // 목록 컨테이너는 카드보다 먼저 뜬다. 버튼 자체를 기다려야 인스턴스가 그려진 뒤다.
    fireEvent.click(await screen.findByRole('button', { name: 'RDP 로 추가' }));

    // 어느 .pem 이 필요한지 보여 줘야 사용자가 파일을 찾을 수 있다.
    expect(screen.getByTestId('aws-import-rdp')).toHaveTextContent('gw-prod-keypair');

    // 암호가 없으면 등록할 수 없다.
    expect(screen.getByRole('button', { name: 'Host 등록' })).toBeDisabled();

    // 파일 대신 붙여넣기로 넣는다. 키가 다 들어오면 조회는 저절로 시작한다.
    fireEvent.click(screen.getByRole('button', { name: '키 내용 직접 붙여넣기' }));
    fireEvent.change(screen.getByLabelText('프라이빗 키'), {
      target: { value: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----' },
    });

    await waitFor(() =>
      expect(api.aws.getWindowsPassword).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'i-win', region: 'ap-northeast-2' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Host 등록' })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'rdp',
          hostname: '10.0.2.181',
          port: 3389,
          awsSsm: {
            // **id 를 함께 싣는다.** 이름은 사용자가 바꿀 수 있어서, 이름만 저장하면 접속 시
            // 프로파일을 찾는 경로(SSO 만료 확인)가 조용히 끊긴다. aws-ec2 임포트도 같은 값을
            // 싣는다.
            profileId: 'profile-default',
            profileName: 'default',
            region: 'ap-northeast-2',
            instanceId: 'i-win',
          },
        }),
        // 계정과 암호는 호스트 레코드가 아니라 자격증명으로 간다.
        { kind: 'rdp', username: 'Administrator', password: 'Init!alPass' },
        // 볼트 후보가 없으면 개인 — 요청에 볼트를 싣지 않는다.
        {},
      ),
    );
  });

  it('키가 다 들어오기 전에는 조회하지 않는다', async () => {
    // 붙여넣는 중간 상태로 부르면 매번 실패하고 경고가 번쩍인다. 끝 표시가 있을 때만 시작한다.
    const api = installMockApi();
    api.aws.getProfileStatus.mockResolvedValue(
      createStatus({ isAuthenticated: true, configuredRegion: 'ap-northeast-2' }),
    );
    api.aws.listRegions.mockResolvedValue(['ap-northeast-2']);
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-win',
        name: 'test',
        platform: 'Windows',
        privateIp: '10.0.2.181',
        keyName: 'gw-prod-keypair',
        state: 'running',
        ssmAvailability: 'ready',
        ssmAvailabilityReason: null,
      },
    ]);

    render(
      <AwsImportDialog
        open
        currentGroupPath={null}
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'RDP 로 추가' }));
    fireEvent.click(screen.getByRole('button', { name: '키 내용 직접 붙여넣기' }));
    fireEvent.change(screen.getByLabelText('프라이빗 키'), {
      target: { value: '-----BEGIN RSA PRIVATE KEY-----\nhalf' },
    });

    await waitFor(() => expect(screen.getByLabelText('프라이빗 키')).toHaveValue(
      '-----BEGIN RSA PRIVATE KEY-----\nhalf',
    ));
    expect(api.aws.getWindowsPassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('프라이빗 키'), {
      target: { value: '-----BEGIN RSA PRIVATE KEY-----\nhalf\n-----END RSA PRIVATE KEY-----' },
    });

    await waitFor(() => expect(api.aws.getWindowsPassword).toHaveBeenCalledTimes(1));
  });

  it('암호를 못 가져오면 이유를 보여주고 직접 입력을 받는다', async () => {
    const api = installMockApi();
    api.aws.getProfileStatus.mockResolvedValue(
      createStatus({ isAuthenticated: true, configuredRegion: 'ap-northeast-2' }),
    );
    api.aws.listRegions.mockResolvedValue(['ap-northeast-2']);
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-win',
        name: 'test',
        platform: 'Windows',
        privateIp: '10.0.2.181',
        keyName: 'gw-prod-keypair',
        state: 'running',
        ssmAvailability: 'ready',
        ssmAvailabilityReason: null,
      },
    ]);
    // 암호를 바꿨거나 도메인 조인된 인스턴스는 AWS 가 빈 값을 준다 — 흔한 경우다.
    api.aws.getWindowsPassword.mockResolvedValue({
      password: null,
      reason: 'not-available',
    });
    const onImport = vi.fn().mockResolvedValue(undefined);

    render(
      <AwsImportDialog open currentGroupPath={null} onClose={vi.fn()} onImport={onImport} />,
    );

    // 목록 컨테이너는 카드보다 먼저 뜬다. 버튼 자체를 기다려야 인스턴스가 그려진 뒤다.
    fireEvent.click(await screen.findByRole('button', { name: 'RDP 로 추가' }));
    fireEvent.click(screen.getByRole('button', { name: '키 내용 직접 붙여넣기' }));
    fireEvent.change(screen.getByLabelText('프라이빗 키'), {
      target: { value: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----' },
    });

    // role 로 찾으면 다른 알림이 하나라도 같이 떠 있을 때 던진다. 이 패널 안만 본다.
    await waitFor(() =>
      expect(screen.getByTestId('aws-import-rdp')).toHaveTextContent('직접 입력'),
    );
    expect(screen.getByRole('button', { name: 'Host 등록' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('관리자 암호'), {
      target: { value: 'TypedByHand1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rdp' }),
        { kind: 'rdp', username: 'Administrator', password: 'TypedByHand1' },
        {},
      ),
    );
  });

  it('opens the create profile form, saves a valid profile, and auto-selects it', async () => {
    const api = installMockApi();
    api.aws.listProfiles = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'default' }])
      .mockResolvedValueOnce([{ name: 'default' }, { name: 'dolssh-prod' }]);
    api.aws.getProfileStatus.mockImplementation(async (profileName: string) =>
      createStatus({
        profileName,
        isAuthenticated: true,
        configuredRegion: profileName === 'dolssh-prod' ? 'us-east-1' : 'ap-northeast-2',
      }),
    );
    api.aws.listRegions.mockResolvedValue(['ap-northeast-2', 'us-east-1']);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('default'));

    fireEvent.click(screen.getByRole('button', { name: '프로필 생성' }));
    expect(screen.getByTestId('aws-create-profile-form')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('새 프로필명'), {
      target: { value: 'dolssh-prod' },
    });
    fireEvent.change(screen.getByLabelText('Access Key'), {
      target: { value: 'AKIATEST123' },
    });
    fireEvent.change(screen.getByLabelText('Secret'), {
      target: { value: 'secret-value' },
    });
    fireEvent.change(screen.getByLabelText('기본 Region'), {
      target: { value: 'us-east-1' },
    });

    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }));

    await waitFor(() =>
      expect(api.aws.createProfile).toHaveBeenCalledWith({
        kind: 'static',
        profileName: 'dolssh-prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: 'us-east-1',
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('dolssh-prod'));
    await waitFor(() => expect(api.aws.getProfileStatus).toHaveBeenCalledWith('dolssh-prod'));
    expect(screen.queryByTestId('aws-create-profile-form')).not.toBeInTheDocument();
  });

  it('does not show per-tab titles or helper descriptions in the create profile form', async () => {
    installMockApi();

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('default'));

    fireEvent.click(screen.getByRole('button', { name: '프로필 생성' }));

    expect(screen.queryByText('Static AWS 프로필 생성')).not.toBeInTheDocument();
    expect(
      screen.queryByText('유효성 검사를 통과한 경우에만 생성합니다.'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'SSO' }));

    expect(screen.queryByText('AWS SSO 프로필 생성')).not.toBeInTheDocument();
    expect(
      screen.queryByText('SSO 로그인과 account/role 조회가 모두 성공한 경우에만 저장합니다.'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Assume role' }));

    expect(screen.queryByText('Role profile 생성')).not.toBeInTheDocument();
    expect(
      screen.queryByText('source profile로 AssumeRole 검증이 성공한 경우에만 저장합니다.'),
    ).not.toBeInTheDocument();
  });

  it('shows a server update warning when aws profile sync is unsupported', async () => {
    installMockApi({
      awsProfilesServerSupport: 'unsupported',
    });

    render(
      <AwsImportDialog
        open
        currentGroupPath={null}
        onClose={() => undefined}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(
      await screen.findByText(
        '현재 서버는 AWS 프로필 동기화를 아직 지원하지 않습니다. 서버를 업데이트하기 전까지 이 기기에서만 저장됩니다.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the create profile form open and shows inline errors when creation fails', async () => {
    const api = installMockApi();
    api.aws.createProfile.mockRejectedValue(
      new Error(
        "Error invoking remote method 'aws:create-profile': Error: 입력한 AWS 자격 증명이 유효하지 않습니다.",
      ),
    );

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('default'));

    fireEvent.click(screen.getByRole('button', { name: '프로필 생성' }));
    fireEvent.change(screen.getByLabelText('새 프로필명'), {
      target: { value: 'dolssh-prod' },
    });
    fireEvent.change(screen.getByLabelText('Access Key'), {
      target: { value: 'AKIATEST123' },
    });
    fireEvent.change(screen.getByLabelText('Secret'), {
      target: { value: 'secret-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }));

    expect(
      await screen.findByText('입력한 AWS 자격 증명이 유효하지 않습니다.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Error invoking remote method 'aws:create-profile'/),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('aws-create-profile-form')).toBeInTheDocument();
  });

  it('shows a friendly validation error for invalid role arn input before submitting', async () => {
    const api = installMockApi();

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('default'));

    fireEvent.click(screen.getByRole('button', { name: '프로필 생성' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assume role' }));

    fireEvent.change(screen.getByLabelText('Role 프로필명'), {
      target: { value: 'prod-admin' },
    });
    fireEvent.change(screen.getByLabelText('source profile'), {
      target: { value: 'default' },
    });
    fireEvent.change(screen.getByLabelText('Role ARN'), {
      target: { value: 'asdasd' },
    });
    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }));

    expect(
      await screen.findByText('입력한 Role ARN이 올바르지 않습니다. Role ARN 형식을 다시 확인해 주세요.'),
    ).toBeInTheDocument();
    expect(api.aws.createProfile).not.toHaveBeenCalled();
  });

  it('inspects SSH info before importing and only creates the host on final confirmation', async () => {
    const api = installMockApi();
    const onImport = vi.fn().mockResolvedValue(undefined);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'SSH 정보 확인' }));

    await waitFor(() =>
      expect(api.aws.inspectHostSshMetadata).toHaveBeenCalledWith({
        profileName: 'default',
        region: 'ap-northeast-2',
        instanceId: 'i-aws',
        availabilityZone: 'ap-northeast-2a',
      }),
    );
    expect(onImport).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.getByDisplayValue('ubuntu')).toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue('22')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'aws-ec2',
          label: 'web-1',
          groupName: 'Servers',
          awsSshUsername: 'ubuntu',
          awsSshPort: 22,
          awsSshMetadataStatus: 'ready',
          awsSshMetadataError: null,
        }),
        undefined,
        {},
      ),
    );
  });

  // Windows 인스턴스는 SSM 셸(PowerShell)로 붙는다. SSH 검사(AWS-RunShellScript)는 Linux 전용이고
  // 그 검사가 찾는 사용자명은 SSM 셸 경로에 필요 없으므로, 검사를 건너뛰고 바로 등록한다.
  it('registers a Windows instance without running the SSH inspection', async () => {
    const api = installMockApi();
    const onImport = vi.fn().mockResolvedValue(undefined);
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-win',
        name: 'winbox',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Windows',
        privateIp: '10.0.0.20',
        state: 'running',
        ssmAvailability: 'ready',
        ssmAvailabilityReason: null,
      },
    ]);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    await waitFor(() => expect(screen.getByText('winbox')).toBeInTheDocument());

    // "Windows 미지원"으로 막던 자리다 — 이제 등록으로 들어가는 입구여야 한다.
    expect(screen.queryByRole('button', { name: 'Windows 미지원' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'SSM 셸로 추가' }));

    await waitFor(() =>
      expect(screen.getByText('Windows 인스턴스는 SSM 셸(PowerShell)로 연결합니다.')).toBeInTheDocument(),
    );
    expect(api.aws.inspectHostSshMetadata).not.toHaveBeenCalled();
    // SSH 사용자명·포트는 이 호스트에 쓰이지 않으므로 입력란도 없어야 한다.
    expect(screen.queryByText('SSH Username')).toBeNull();
    expect(screen.queryByText('SSH Port')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'aws-ec2',
          label: 'winbox',
          awsInstanceId: 'i-win',
          awsPlatform: 'Windows',
          awsSshUsername: null,
          awsSshMetadataStatus: 'idle',
        }),
        undefined,
        {},
      ),
    );
  });

  it('still runs the SSH inspection for Linux instances', async () => {
    const api = installMockApi();

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'SSM 셸로 추가' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'SSH 정보 확인' }));

    await waitFor(() => expect(api.aws.inspectHostSshMetadata).toHaveBeenCalled());
    expect(await screen.findByText('SSH Username')).toBeInTheDocument();
  });

  it('renders the AWS SSM specific title and EC2 tab label', async () => {
    installMockApi();

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText('Import via AWS SSM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EC2 (SSM)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ECS' })).toBeInTheDocument();
  });

  it('auto-selects the configured region and loads instances immediately', async () => {
    const api = installMockApi();
    api.aws.getProfileStatus.mockResolvedValue(
      createStatus({
        isAuthenticated: true,
        configuredRegion: 'ap-northeast-2',
      }),
    );

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // 호출이 아니라 그 결과가 목록에 그려졌는지로 기다린다.
    expect(await screen.findByText('web-1')).toBeInTheDocument();
    expect(api.aws.listEc2Instances).toHaveBeenCalledWith('default', 'ap-northeast-2');
  });

  it('loads only regions when no configured region exists and waits for manual selection', async () => {
    const api = installMockApi();
    api.aws.getProfileStatus.mockResolvedValue(
      createStatus({
        isAuthenticated: true,
        configuredRegion: null,
      }),
    );

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(api.aws.listRegions).toHaveBeenCalledWith('default'));
    await waitFor(() => expect(screen.getByTestId('aws-import-region-hint')).toBeInTheDocument());
    expect(api.aws.listEc2Instances).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Region'), {
      target: { value: 'ap-northeast-2' },
    });

    await waitFor(() => expect(api.aws.listEc2Instances).toHaveBeenCalledWith('default', 'ap-northeast-2'));
  });

  it('switches to ECS mode, lists clusters, and imports the selected cluster as an aws-ecs host', async () => {
    const api = installMockApi();
    const onImport = vi.fn().mockResolvedValue(undefined);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    await waitFor(() => expect(api.aws.listEc2Instances).toHaveBeenCalledWith('default', 'ap-northeast-2'));

    fireEvent.click(screen.getByRole('button', { name: 'ECS' }));

    expect(await screen.findByText('prod')).toBeInTheDocument();
    expect(api.aws.listEcsClusters).toHaveBeenCalledWith('default', 'ap-northeast-2');

    fireEvent.click(screen.getByRole('button', { name: '클러스터 추가' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'aws-ecs',
          label: 'prod',
          groupName: 'Servers',
          awsProfileName: 'default',
          awsRegion: 'ap-northeast-2',
          awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
          awsEcsClusterName: 'prod',
        }),
        undefined,
        {},
      ),
    );
  });

  it('shows SSM Unavailable on EC2 cards and blocks inspection for unmanaged instances', async () => {
    const api = installMockApi();
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-aws',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unavailable',
        ssmAvailabilityReason:
          '이 인스턴스는 Systems Manager managed instance 목록에 나타나지 않습니다. SSM Agent 설치와 인스턴스 프로파일(AmazonSSMManagedInstanceCore)을 확인해 주세요.',
      },
    ]);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText('SSM Unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('이 인스턴스는 Systems Manager managed instance 목록에 나타나지 않습니다. SSM Agent 설치와 인스턴스 프로파일(AmazonSSMManagedInstanceCore)을 확인해 주세요.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SSM 사용 불가' })).toBeDisabled();
    expect(api.aws.inspectHostSshMetadata).not.toHaveBeenCalled();
  });

  it('shows a blocking notice when SSM availability is unknown and disables inspection', async () => {
    const api = installMockApi();
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-aws',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unknown',
        ssmAvailabilityReason:
          'SSM 상태를 조회할 권한이 없어 가져오기를 차단했습니다. 사용자/역할에 `ssm:DescribeInstanceInformation` 권한이 포함되어 있는지 확인해 주세요.',
      },
    ]);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByText(
          'SSM 상태를 조회할 권한이 없어 가져오기를 차단했습니다. 사용자/역할에 `ssm:DescribeInstanceInformation` 권한이 포함되어 있는지 확인해 주세요.',
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText('SSM Unknown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '가져오기 차단됨' })).toBeDisabled();
    expect(api.aws.inspectHostSshMetadata).not.toHaveBeenCalled();
  });

  it('shows an SSM lookup timeout notice and disables inspection', async () => {
    const api = installMockApi();
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-aws',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unknown',
        ssmAvailabilityReason:
          'SSM 상태 조회가 제한 시간을 초과했습니다. SSM 연결 상태와 권한을 확인한 뒤 다시 시도해 주세요.',
      },
    ]);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByText(
          'SSM 상태 조회가 제한 시간을 초과했습니다. SSM 연결 상태와 권한을 확인한 뒤 다시 시도해 주세요.',
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText('SSM Unknown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '가져오기 차단됨' })).toBeDisabled();
    expect(api.aws.inspectHostSshMetadata).not.toHaveBeenCalled();
  });

  it('shows an inactive-agent reason for managed instances that are not currently reachable over SSM', async () => {
    const api = installMockApi();
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-aws',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unavailable',
        ssmAvailabilityReason:
          '이 인스턴스는 SSM managed instance로 등록되어 있지만 현재 연결이 비활성 상태입니다. SSM Agent, 인스턴스 프로파일, 네트워크 연결을 확인해 주세요.',
      },
    ]);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(
      await screen.findByText(
        '이 인스턴스는 SSM managed instance로 등록되어 있지만 현재 연결이 비활성 상태입니다. SSM Agent, 인스턴스 프로파일, 네트워크 연결을 확인해 주세요.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SSM 사용 불가' })).toBeDisabled();
  });

  it('blocks inspection for ConnectionLost managed instances', async () => {
    const api = installMockApi();
    api.aws.listEc2Instances.mockResolvedValue([
      {
        instanceId: 'i-aws',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unavailable',
        ssmAvailabilityReason:
          '이 인스턴스는 SSM managed instance로 등록되어 있지만 Session Manager 연결 상태가 오프라인(ConnectionLost)입니다. SSM Agent, 인스턴스 프로파일, 네트워크 연결을 확인해 주세요.',
      },
    ]);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(
      await screen.findByText(
        '이 인스턴스는 SSM managed instance로 등록되어 있지만 Session Manager 연결 상태가 오프라인(ConnectionLost)입니다. SSM Agent, 인스턴스 프로파일, 네트워크 연결을 확인해 주세요.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SSM 사용 불가' })).toBeDisabled();
    expect(api.aws.inspectHostSshMetadata).not.toHaveBeenCalled();
  });

  it('does not auto-select a configured region when it is missing from the loaded region list', async () => {
    const api = installMockApi();
    api.aws.getProfileStatus.mockResolvedValue(
      createStatus({
        isAuthenticated: true,
        configuredRegion: 'us-east-1',
      }),
    );
    api.aws.listRegions.mockResolvedValue(['ap-northeast-2']);
    api.aws.listEc2Instances.mockClear();

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('aws-import-region-hint')).toBeInTheDocument());
    expect(screen.getByLabelText('Region')).toHaveValue('ap-northeast-2');
    expect(api.aws.listEc2Instances).not.toHaveBeenCalled();
  });

  it('allows registering an AWS host even when inspection fails and fields stay blank', async () => {
    const api = installMockApi({
      inspectHostSshMetadata: vi.fn().mockResolvedValue({
        sshPort: 22,
        recommendedUsername: null,
        usernameCandidates: [],
        status: 'error',
        errorMessage: '[SSH 설정 조회] 접근이 거부되었습니다.',
      }),
    });
    const onImport = vi.fn().mockResolvedValue(undefined);

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'SSH 정보 확인' }));

    expect(
      await screen.findByText('[SSH 설정 조회] 접근이 거부되었습니다.'),
    ).toBeInTheDocument();

    const usernameInput = screen.getByLabelText('SSH Username');
    const portInput = screen.getByLabelText('SSH Port');
    fireEvent.change(usernameInput, { target: { value: '' } });
    fireEvent.change(portInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'aws-ec2',
          awsSshUsername: null,
          awsSshPort: null,
          awsSshMetadataStatus: 'idle',
          awsSshMetadataError: null,
        }),
        undefined,
        {},
      ),
    );
    expect(api.aws.inspectHostSshMetadata).toHaveBeenCalledTimes(1);
  });

  it('preserves user edits when inspection is retried', async () => {
    const inspectHostSshMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        sshPort: 22,
        recommendedUsername: 'ubuntu',
        usernameCandidates: ['ubuntu', 'deploy'],
        status: 'ready',
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        sshPort: 2022,
        recommendedUsername: 'admin',
        usernameCandidates: ['admin', 'ubuntu'],
        status: 'ready',
        errorMessage: null,
      });
    installMockApi({ inspectHostSshMetadata });

    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        onClose={vi.fn()}
        onImport={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'SSH 정보 확인' }));
    await waitFor(() =>
      expect(screen.getByDisplayValue('ubuntu')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText('SSH Username'), {
      target: { value: 'custom-user' },
    });
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));

    await waitFor(() => expect(inspectHostSshMetadata).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText('SSH Port')).toHaveValue('2022'),
    );
    expect(screen.getByLabelText('SSH Username')).toHaveValue('custom-user');
  });
});

// 팀으로 가져오기 — 팀 호스트는 다른 볼트의 AWS 프로필을 가리킬 수 없으니, 고른 팀의 프로필로 찾고 그 팀에 저장한다.
describe('AwsImportDialog — 어느 볼트로', () => {
  const TEAM = 'team-1';
  const choices = [
    { id: 'personal', team: null },
    { id: TEAM, team: { id: TEAM, name: 'Acme Infra' } },
  ];
  const windowsInstance = {
    instanceId: 'i-win',
    name: 'winbox',
    availabilityZone: 'ap-northeast-2a',
    platform: 'Windows',
    privateIp: '10.0.2.181',
    keyName: 'gw-prod-keypair',
    state: 'running',
    ssmAvailability: 'ready',
    ssmAvailabilityReason: null,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** 팀 id 를 주면 그 팀의 프로필, 아니면 개인 프로필을 주는 목 API. */
  function installTeamApi() {
    const api = installMockApi();
    api.aws.listProfiles.mockImplementation(async (vaultId?: string) =>
      vaultId === TEAM
        ? [{ id: 'team-profile', name: 'team-prod' }]
        : [{ id: 'profile-default', name: 'default' }],
    );
    return api;
  }

  function renderDialog(props: Partial<Parameters<typeof AwsImportDialog>[0]> = {}) {
    const onImport = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <AwsImportDialog
        open
        currentGroupPath="Servers"
        vaultChoices={choices}
        defaultVaultId={TEAM}
        onClose={onClose}
        onImport={onImport}
        {...props}
      />,
    );
    return { onImport, onClose };
  }

  const vaultPicker = () => screen.getByRole('button', { name: 'Vault' });
  const pickVault = (name: string) => {
    fireEvent.click(vaultPicker());
    fireEvent.click(within(screen.getByRole('listbox', { name: /Vault/ })).getByRole('option', { name }));
  };
  const shareSwitch = () => screen.queryByRole('switch');
  const cliImportButton = () => screen.queryByRole('button', { name: '로컬 AWS CLI에서 가져오기' });

  it('finds with the team profile of the vault it was opened from and saves an EC2 host there, in the group there', async () => {
    const api = installTeamApi();
    const { onImport } = renderDialog();

    expect(vaultPicker()).toHaveTextContent('Acme Infra');
    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    expect(api.aws.listProfiles).toHaveBeenCalledWith(TEAM);
    expect(screen.getByLabelText('Profile')).toHaveValue('team-prod');
    expect(api.aws.getProfileStatus).toHaveBeenCalledWith('team-prod', TEAM);
    expect(api.aws.listRegions).toHaveBeenCalledWith('team-prod', TEAM);
    expect(api.aws.listEc2Instances).toHaveBeenCalledWith('team-prod', 'ap-northeast-2', TEAM);
    // CLI 프로필은 개인으로만 들어온다 — 팀을 고른 동안에는 없다.
    expect(cliImportButton()).toBeNull();
    // 비밀번호를 가져올 일이 없으면 공유 줄도 없다.
    expect(shareSwitch()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'SSH 정보 확인' }));
    await waitFor(() =>
      expect(api.aws.inspectHostSshMetadata).toHaveBeenCalledWith({
        profileName: 'team-prod',
        region: 'ap-northeast-2',
        instanceId: 'i-aws',
        availabilityZone: 'ap-northeast-2a',
        vaultId: TEAM,
      }),
    );
    // 고른 볼트로 찾은 것을 등록하는 동안에는 볼트를 바꾸지 못한다.
    expect(vaultPicker()).toBeDisabled();
    await waitFor(() => expect(screen.getByDisplayValue('ubuntu')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'aws-ec2',
          groupName: 'Servers',
          awsProfileId: 'team-profile',
          awsProfileName: 'team-prod',
        }),
        undefined,
        { vaultId: TEAM, shareSecrets: true },
      ),
    );
  });

  it('adds an ECS cluster found with the team profile to that team', async () => {
    const api = installTeamApi();
    const { onImport } = renderDialog();
    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'ECS' }));
    expect(await screen.findByText('prod')).toBeInTheDocument();
    expect(api.aws.listEcsClusters).toHaveBeenCalledWith('team-prod', 'ap-northeast-2', TEAM);
    fireEvent.click(screen.getByRole('button', { name: '클러스터 추가' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'aws-ecs', awsProfileId: 'team-profile', awsProfileName: 'team-prod' }),
        undefined,
        { vaultId: TEAM, shareSecrets: true },
      ),
    );
  });

  it('goes back to your own profiles and calls without a team when you pick your own vault, leaving the group behind', async () => {
    const api = installTeamApi();
    const { onImport } = renderDialog();
    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    api.aws.getProfileStatus.mockClear();
    api.aws.listRegions.mockClear();
    api.aws.listEc2Instances.mockClear();

    pickVault('Personal');

    await waitFor(() => expect(api.aws.listEc2Instances).toHaveBeenCalledWith('default', 'ap-northeast-2'));
    expect(api.aws.listProfiles).toHaveBeenLastCalledWith();
    expect(screen.getByLabelText('Profile')).toHaveValue('default');
    expect(api.aws.getProfileStatus).toHaveBeenCalledWith('default');
    expect(api.aws.listRegions).toHaveBeenCalledWith('default');
    expect(cliImportButton()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'SSH 정보 확인' }));
    await waitFor(() =>
      expect(api.aws.inspectHostSshMetadata).toHaveBeenCalledWith({
        profileName: 'default',
        region: 'ap-northeast-2',
        instanceId: 'i-aws',
        availabilityZone: 'ap-northeast-2a',
      }),
    );
    await waitFor(() => expect(screen.getByDisplayValue('ubuntu')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    // 처음 볼트가 아니면 보고 있던 그룹은 따라가지 않는다(그 그룹은 처음 볼트의 것이다).
    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'aws-ec2', groupName: '', awsProfileId: 'profile-default' }),
        undefined,
        {},
      ),
    );
  });

  it('shares the Windows password with the team by default, or keeps it as my credential when turned off', async () => {
    const api = installTeamApi();
    api.aws.listEc2Instances.mockResolvedValue([windowsInstance]);
    const { onImport } = renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: 'RDP 로 추가' }));
    // 비밀번호가 생기는 단계 — Vault 칸 아래에 공유 줄이 생긴다(기본 켬). 볼트는 잠기고 공유는 고를 수 있다.
    expect(shareSwitch()).toHaveAccessibleName('비밀번호·SSH 키 1개도 함께 공유');
    expect(shareSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(shareSwitch()).toBeEnabled();
    expect(vaultPicker()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '키 내용 직접 붙여넣기' }));
    fireEvent.change(screen.getByLabelText('프라이빗 키'), {
      target: { value: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----' },
    });
    await waitFor(() =>
      expect(api.aws.getWindowsPassword).toHaveBeenCalledWith(
        expect.objectContaining({ profileName: 'team-prod', instanceId: 'i-win', vaultId: TEAM }),
      ),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Host 등록' })).toBeEnabled());

    fireEvent.click(shareSwitch()!);
    expect(shareSwitch()).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Host 등록' }));

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'rdp',
          awsSsm: expect.objectContaining({ profileId: 'team-profile', profileName: 'team-prod' }),
        }),
        { kind: 'rdp', username: 'Administrator', password: 'Init!alPass' },
        { vaultId: TEAM, shareSecrets: false },
      ),
    );
  });

  it('puts the key in place for a team static profile without one on this device, then finds again', async () => {
    const api = installTeamApi();
    const missingKey = { teamId: TEAM, profileId: 'team-profile', profileName: 'team-prod' };
    api.aws.getProfileStatus
      .mockResolvedValueOnce(
        createStatus({
          profileName: 'team-prod',
          isAuthenticated: false,
          errorMessage: "이 기기에 'team-prod' 키가 없습니다.",
          missingKey,
        }),
      )
      .mockResolvedValue(
        createStatus({ profileName: 'team-prod', isAuthenticated: true, configuredRegion: 'ap-northeast-2' }),
      );
    const updateProfile = vi.fn().mockResolvedValue(undefined);
    Object.assign(api.aws, { updateProfile });
    renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: '키 넣기' }));
    fireEvent.change(screen.getByLabelText('Access Key'), { target: { value: 'AKIAEXAMPLE' } });
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({
        profileName: 'team-prod',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret-value',
        vaultId: TEAM,
      }),
    );
    // 넣었으면 같은 프로필의 상태부터 다시 읽고 찾는다.
    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    expect(api.aws.getProfileStatus).toHaveBeenCalledTimes(2);
    expect(api.aws.getProfileStatus).toHaveBeenLastCalledWith('team-prod', TEAM);
    expect(screen.queryByRole('button', { name: '키 넣기' })).toBeNull();
  });

  it('signs a team SSO profile in with that team, keeping the vault while it signs in', async () => {
    const api = installTeamApi();
    api.aws.getProfileStatus
      .mockResolvedValueOnce(createStatus({ profileName: 'team-prod', isSsoProfile: true, isAuthenticated: false }))
      .mockResolvedValue(
        createStatus({ profileName: 'team-prod', isSsoProfile: true, isAuthenticated: true, configuredRegion: 'ap-northeast-2' }),
      );
    let finishLogin: () => void = () => undefined;
    api.aws.login.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishLogin = resolve;
        }),
    );
    renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: '브라우저에서 로그인' }));
    await waitFor(() => expect(api.aws.login).toHaveBeenCalledWith('team-prod', TEAM));
    // 로그인하는 동안 볼트를 바꾸면 끝난 로그인이 다른 볼트의 상태를 덮는다.
    expect(vaultPicker()).toBeDisabled();
    await act(async () => {
      finishLogin();
    });

    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    expect(api.aws.getProfileStatus).toHaveBeenLastCalledWith('team-prod', TEAM);
    expect(vaultPicker()).toBeEnabled();
  });

  it('makes a new profile in the team it is on and picks it', async () => {
    const api = installTeamApi();
    api.aws.listProfiles
      .mockResolvedValueOnce([{ id: 'team-profile', name: 'team-prod' }])
      .mockResolvedValueOnce([
        { id: 'team-profile', name: 'team-prod' },
        { id: 'team-new', name: 'team-new' },
      ]);
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('team-prod'));

    fireEvent.click(screen.getByRole('button', { name: '프로필 생성' }));
    fireEvent.change(screen.getByLabelText('새 프로필명'), { target: { value: 'team-new' } });
    fireEvent.change(screen.getByLabelText('Access Key'), { target: { value: 'AKIATEST123' } });
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }));

    await waitFor(() =>
      expect(api.aws.createProfile).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'static', profileName: 'team-new', vaultId: TEAM }),
      ),
    );
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('team-new'));
    expect(api.aws.listProfiles).toHaveBeenLastCalledWith(TEAM);
  });

  it('drops the profile list of a vault you have just left', async () => {
    const api = installTeamApi();
    let releaseTeam: (items: unknown[]) => void = () => undefined;
    api.aws.listProfiles.mockImplementation((vaultId?: string) =>
      vaultId === TEAM
        ? new Promise((resolve) => {
            releaseTeam = resolve;
          })
        : Promise.resolve([{ id: 'profile-default', name: 'default' }]),
    );
    renderDialog();

    pickVault('Personal');
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('default'));
    await act(async () => {
      releaseTeam([{ id: 'team-profile', name: 'team-prod' }]);
    });

    expect(screen.getByLabelText('Profile')).toHaveValue('default');
    expect(within(screen.getByLabelText('Profile')).queryByRole('option', { name: 'team-prod' })).toBeNull();
  });

  it('has no Vault field with only your own vault', async () => {
    const api = installTeamApi();
    renderDialog({ vaultChoices: [choices[0]!], defaultVaultId: 'personal' });

    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Vault' })).toBeNull();
    expect(api.aws.listProfiles).toHaveBeenCalledWith();
    expect(cliImportButton()).toBeInTheDocument();
  });
});
