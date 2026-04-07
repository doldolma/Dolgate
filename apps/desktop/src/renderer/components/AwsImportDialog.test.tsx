import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    profileName: 'default',
    available: true,
    isSsoProfile: false,
    isAuthenticated: false,
    configuredRegion: null,
    accountId: null,
    arn: null,
    errorMessage: null,
    missingTools: [],
    ...overrides,
  };
}

function installMockApi(overrides?: {
  inspectHostSshMetadata?: ReturnType<typeof vi.fn>;
}) {
  const api = {
    aws: {
      listProfiles: vi.fn().mockResolvedValue([{ name: 'default' }]),
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
    fireEvent.click(screen.getByRole('button', { name: 'Role' }));

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
      ),
    );
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

    await waitFor(() => expect(api.aws.listEc2Instances).toHaveBeenCalledWith('default', 'ap-northeast-2'));
    expect(screen.getByText('web-1')).toBeInTheDocument();
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

    await waitFor(() => expect(api.aws.listEcsClusters).toHaveBeenCalledWith('default', 'ap-northeast-2'));
    expect(screen.getByText('prod')).toBeInTheDocument();

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
      ),
    );
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
