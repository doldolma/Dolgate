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
