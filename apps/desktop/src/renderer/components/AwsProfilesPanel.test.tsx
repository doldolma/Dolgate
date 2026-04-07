import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AwsProfileDetails, DesktopApi, HostRecord } from '@shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AwsProfilesPanel } from './AwsProfilesPanel'

function createProfileDetails(
  overrides: Partial<AwsProfileDetails> = {},
): AwsProfileDetails {
  return {
    profileName: 'default',
    available: true,
    isSsoProfile: false,
    isAuthenticated: true,
    configuredRegion: 'ap-northeast-2',
    accountId: '123456789012',
    arn: 'arn:aws:iam::123456789012:user/test',
    errorMessage: null,
    missingTools: [],
    kind: 'static',
    maskedAccessKeyId: 'AKIA****1234',
    hasSecretAccessKey: true,
    hasSessionToken: false,
    roleArn: null,
    sourceProfile: null,
    credentialProcess: null,
    ssoSession: null,
    ssoStartUrl: null,
    ssoRegion: null,
    ssoAccountId: null,
    ssoRoleName: null,
    referencedByProfileNames: [],
    orphanedSsoSessionName: null,
    ...overrides,
  }
}

function createAwsHost(profileName: string): HostRecord {
  return {
    id: `aws-host:${profileName}`,
    kind: 'aws-ec2',
    label: `host-${profileName}`,
    awsProfileName: profileName,
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-1234567890',
    awsAvailabilityZone: 'ap-northeast-2a',
    awsInstanceName: `instance-${profileName}`,
    awsPlatform: 'Linux/UNIX',
    awsPrivateIp: '10.0.0.10',
    awsState: 'running',
    awsSshUsername: 'ubuntu',
    awsSshPort: 22,
    awsSshMetadataStatus: 'ready',
    awsSshMetadataError: null,
    groupName: 'Servers',
    tags: [],
    terminalThemeId: null,
    createdAt: '2026-04-07T00:00:00.000Z',
    updatedAt: '2026-04-07T00:00:00.000Z',
  }
}

function installMockApi(input?: {
  profiles?: Array<{ name: string }>
  detailsByProfileName?: Record<string, AwsProfileDetails>
}) {
  let profiles = input?.profiles ?? [{ name: 'default' }]
  let detailsByProfileName: Record<string, AwsProfileDetails> = {
    default: createProfileDetails(),
    ...(input?.detailsByProfileName ?? {}),
  }

  const api = {
    aws: {
      listProfiles: vi.fn().mockImplementation(async () => profiles),
      createProfile: vi.fn().mockImplementation(async (draft) => {
        profiles = [...profiles, { name: draft.profileName }]
        detailsByProfileName = {
          ...detailsByProfileName,
          [draft.profileName]: createProfileDetails({
            profileName: draft.profileName,
            configuredRegion: draft.region ?? null,
            kind: draft.kind,
            ssoStartUrl: draft.kind === 'sso' ? draft.ssoStartUrl : null,
            ssoRegion: draft.kind === 'sso' ? draft.ssoRegion : null,
            ssoAccountId: draft.kind === 'sso' ? draft.ssoAccountId : null,
            ssoRoleName: draft.kind === 'sso' ? draft.ssoRoleName : null,
            sourceProfile: draft.kind === 'role' ? draft.sourceProfileName : null,
            roleArn: draft.kind === 'role' ? draft.roleArn : null,
          }),
        }
      }),
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
      getProfileDetails: vi.fn().mockImplementation(async (profileName: string) => {
        const details = detailsByProfileName[profileName]
        if (!details) {
          throw new Error('missing profile')
        }
        return details
      }),
      updateProfile: vi.fn().mockResolvedValue(undefined),
      renameProfile: vi.fn().mockImplementation(async (input) => {
        const current = detailsByProfileName[input.profileName]
        profiles = profiles.map((profile) =>
          profile.name === input.profileName
            ? { name: input.nextProfileName }
            : profile,
        )
        detailsByProfileName = {
          ...Object.fromEntries(
            Object.entries(detailsByProfileName).filter(
              ([profileName]) => profileName !== input.profileName,
            ),
          ),
          [input.nextProfileName]: createProfileDetails({
            ...current,
            profileName: input.nextProfileName,
          }),
        }
      }),
      deleteProfile: vi.fn().mockImplementation(async (profileName: string) => {
        profiles = profiles.filter((profile) => profile.name !== profileName)
        detailsByProfileName = Object.fromEntries(
          Object.entries(detailsByProfileName).filter(
            ([name]) => name !== profileName,
          ),
        )
      }),
      getProfileStatus: vi.fn().mockResolvedValue(
        createProfileDetails({
          isSsoProfile: false,
        }),
      ),
      login: vi.fn().mockResolvedValue(undefined),
      listRegions: vi.fn().mockResolvedValue([]),
      listEc2Instances: vi.fn().mockResolvedValue([]),
      listEcsClusters: vi.fn().mockResolvedValue([]),
      inspectHostSshMetadata: vi.fn().mockResolvedValue(undefined),
      loadHostSshMetadata: vi.fn().mockResolvedValue(undefined),
    },
  }

  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    value: api as unknown as DesktopApi,
  })

  return {
    api,
    setProfiles(nextProfiles: Array<{ name: string }>) {
      profiles = nextProfiles
    },
    setDetailsByProfileName(nextDetails: Record<string, AwsProfileDetails>) {
      detailsByProfileName = nextDetails
    },
  }
}

describe('AwsProfilesPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows that aws profiles are stored locally and are not synced to other devices', async () => {
    installMockApi()

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'default' })

    expect(
      screen.getByText(/실제 프로필과 자격 증명은 다른 기기로 동기화되지 않습니다/),
    ).toBeInTheDocument()
  })

  it('creates a new static profile and auto-selects it after refresh', async () => {
    const { api } = installMockApi()

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'default' })

    fireEvent.click(screen.getByRole('button', { name: '새 프로필' }))
    fireEvent.change(screen.getByLabelText('새 프로필명'), {
      target: { value: 'prod' },
    })
    fireEvent.change(screen.getByLabelText('Access Key'), {
      target: { value: 'AKIATEST123' },
    })
    fireEvent.change(screen.getByLabelText('Secret'), {
      target: { value: 'secret-value' },
    })
    fireEvent.change(screen.getByLabelText('기본 Region'), {
      target: { value: 'us-east-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }))

    await waitFor(() =>
      expect(api.aws.createProfile).toHaveBeenCalledWith({
        kind: 'static',
        profileName: 'prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: 'us-east-1',
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'prod' })).toBeInTheDocument(),
    )
  })

  it('normalizes remote invoke prefixes for profile update errors', async () => {
    const { api } = installMockApi()
    api.aws.updateProfile.mockRejectedValue(
      new Error(
        "Error invoking remote method 'aws:update-profile': Error: 입력한 Access Key 또는 Secret이 올바르지 않습니다. AWS 자격 증명을 다시 확인해 주세요.",
      ),
    )

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'default' })

    fireEvent.click(screen.getByRole('button', { name: '수정' }))
    fireEvent.change(screen.getByLabelText('Access Key'), {
      target: { value: 'AKIATEST123' },
    })
    fireEvent.change(screen.getByLabelText('Secret'), {
      target: { value: 'wrong-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '프로필 업데이트' }))

    expect(
      await screen.findByText(
        '입력한 Access Key 또는 Secret이 올바르지 않습니다. AWS 자격 증명을 다시 확인해 주세요.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Error invoking remote method 'aws:update-profile'/),
    ).not.toBeInTheDocument()
  })

  it('shows rename warnings for host references and source_profile references', async () => {
    const { api } = installMockApi({
      detailsByProfileName: {
        default: createProfileDetails({
          referencedByProfileNames: ['assume-admin'],
        }),
      },
    })

    render(<AwsProfilesPanel hosts={[createAwsHost('default')]} />)

    await screen.findByRole('heading', { name: 'default' })

    fireEvent.click(screen.getByRole('button', { name: '이름 변경' }))

    expect(
      screen.getByText(/host 데이터와 서버 동기화 데이터는 자동으로 바뀌지 않습니다/),
    ).toBeInTheDocument()
    expect(screen.getAllByText('host-default (aws-ec2)').length).toBeGreaterThan(0)
    expect(screen.getAllByText('assume-admin').length).toBeGreaterThan(0)

    fireEvent.change(screen.getByLabelText('새 프로필명'), {
      target: { value: 'renamed-default' },
    })
    fireEvent.click(screen.getByRole('button', { name: '프로필명 변경' }))

    await waitFor(() =>
      expect(api.aws.renameProfile).toHaveBeenCalledWith({
        profileName: 'default',
        nextProfileName: 'renamed-default',
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'renamed-default' }),
      ).toBeInTheDocument(),
    )
  })

  it('shows delete warnings including orphaned sso-session information', async () => {
    const { api } = installMockApi({
      profiles: [{ name: 'corp-sso' }],
      detailsByProfileName: {
        'corp-sso': createProfileDetails({
          profileName: 'corp-sso',
          kind: 'sso',
          isSsoProfile: true,
          isAuthenticated: false,
          errorMessage: '브라우저 로그인이 필요합니다.',
          ssoSession: 'corp-session',
          orphanedSsoSessionName: 'corp-session',
          referencedByProfileNames: ['admin-role'],
        }),
      },
    })

    render(<AwsProfilesPanel hosts={[createAwsHost('corp-sso')]} />)

    await screen.findByRole('heading', { name: 'corp-sso' })

    fireEvent.click(screen.getByRole('button', { name: '삭제' }))

    expect(screen.getAllByText('host-corp-sso (aws-ec2)').length).toBeGreaterThan(0)
    expect(screen.getAllByText('admin-role').length).toBeGreaterThan(0)
    expect(screen.getAllByText('corp-session').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '프로필 삭제' }))

    await waitFor(() =>
      expect(api.aws.deleteProfile).toHaveBeenCalledWith('corp-sso'),
    )
  })

  it('shows the SSO login action for sso profiles and refreshes after login', async () => {
    const { api } = installMockApi({
      profiles: [{ name: 'corp-sso' }],
      detailsByProfileName: {
        'corp-sso': createProfileDetails({
          profileName: 'corp-sso',
          kind: 'sso',
          isSsoProfile: true,
          isAuthenticated: false,
          errorMessage: '브라우저 로그인이 필요합니다.',
          ssoSession: 'corp-session',
        }),
      },
    })

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'corp-sso' })

    fireEvent.click(screen.getByRole('button', { name: 'AWS SSO 로그인' }))

    await waitFor(() => expect(api.aws.login).toHaveBeenCalledWith('corp-sso'))
    await waitFor(() => expect(api.aws.listProfiles).toHaveBeenCalledTimes(2))
  })
})
