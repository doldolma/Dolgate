import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AwsProfileDetails, DesktopApi, HostRecord } from '@shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AwsProfilesPanel, resetAwsProfilesPanelCacheForTests } from './AwsProfilesPanel'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return {
    promise,
    resolve,
    reject,
  }
}

function createProfileDetails(
  overrides: Partial<AwsProfileDetails> = {},
): AwsProfileDetails {
  return {
    id: null,
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
    awsProfileId: null,
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
  externalProfiles?: Array<{ name: string }>
  detailsByProfileName?: Record<string, AwsProfileDetails>
  externalDetailsByProfileName?: Record<string, AwsProfileDetails>
  awsProfilesServerSupport?: 'unknown' | 'supported' | 'unsupported'
  listProfilesImpl?: () => Promise<Array<{ name: string }>>
  getProfileDetailsImpl?: (profileName: string) => Promise<AwsProfileDetails>
}) {
  let profiles = input?.profiles ?? [{ id: 'profile-default', name: 'default' }]
  const externalProfiles = input?.externalProfiles ?? [{ id: null, name: 'legacy-profile' }]
  let detailsByProfileName: Record<string, AwsProfileDetails> = {
    default: createProfileDetails(),
    ...(input?.detailsByProfileName ?? {}),
  }
  const externalDetailsByProfileName: Record<string, AwsProfileDetails> = {
    'legacy-profile': createProfileDetails({
      profileName: 'legacy-profile',
      configuredRegion: 'us-east-1',
    }),
    ...(input?.externalDetailsByProfileName ?? {}),
  }

  const api = {
    sync: {
      status: vi.fn().mockResolvedValue({
        status: 'ready',
        lastSuccessfulSyncAt: '2026-04-07T00:00:00.000Z',
        pendingPush: false,
        errorMessage: null,
        awsProfilesServerSupport: input?.awsProfilesServerSupport ?? 'supported',
      }),
    },
    aws: {
      listProfiles: vi
        .fn()
        .mockImplementation(
          input?.listProfilesImpl ?? (async () => profiles),
        ),
      listExternalProfiles: vi.fn().mockImplementation(async () => externalProfiles),
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
      getProfileDetails: vi.fn().mockImplementation(
        input?.getProfileDetailsImpl ??
          (async (profileName: string) => {
            const details = detailsByProfileName[profileName]
            if (!details) {
              throw new Error('missing profile')
            }
            return details
          }),
      ),
      getExternalProfileDetails: vi.fn().mockImplementation(async (profileName: string) => {
        const details = externalDetailsByProfileName[profileName]
        if (!details) {
          throw new Error('missing external profile')
        }
        return details
      }),
      importExternalProfiles: vi.fn().mockImplementation(async ({ profileNames }) => {
        const importedProfileNames = profileNames.filter(
          (profileName: string) => !profiles.some((profile) => profile.name === profileName),
        )
        profiles = [
          ...profiles,
          ...importedProfileNames.map((profileName: string) => ({ name: profileName })),
        ]
        for (const profileName of importedProfileNames) {
          detailsByProfileName = {
            ...detailsByProfileName,
            [profileName]:
              externalDetailsByProfileName[profileName] ??
              createProfileDetails({
                profileName,
              }),
          }
        }
        return {
          importedProfileNames,
          skippedProfileNames: profileNames.filter(
            (profileName: string) => !importedProfileNames.includes(profileName),
          ),
        }
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
    resetAwsProfilesPanelCacheForTests()
  })

  it('shows the general app-managed aws profiles description', async () => {
    installMockApi()

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'default' })

    expect(
      screen.getByText(/앱 전용 AWS CLI 프로필을 확인하고 생성, 수정, 이름 변경, 삭제할 수 있습니다/),
    ).toBeInTheDocument()
  })

  it('shows a server update warning when aws profile sync is unsupported', async () => {
    installMockApi({
      awsProfilesServerSupport: 'unsupported',
    })

    render(<AwsProfilesPanel hosts={[]} />)

    expect(
      await screen.findByText(
        '현재 서버는 AWS 프로필 동기화를 아직 지원하지 않습니다. 서버를 업데이트하기 전까지 이 기기에서만 저장됩니다.',
      ),
    ).toBeInTheDocument()
  })

  it('renders profiles before detail lookups finish and updates each row as results arrive', async () => {
    const defaultDetails = createDeferred<AwsProfileDetails>()
    const prodDetails = createDeferred<AwsProfileDetails>()

    installMockApi({
      profiles: [{ name: 'default' }, { name: 'prod' }],
      getProfileDetailsImpl: vi.fn().mockImplementation((profileName: string) => {
        if (profileName === 'default') {
          return defaultDetails.promise
        }
        if (profileName === 'prod') {
          return prodDetails.promise
        }
        throw new Error('missing profile')
      }),
    })

    render(<AwsProfilesPanel hosts={[]} />)

    const defaultRow = await screen.findByRole('button', { name: /default/ })
    const prodRow = screen.getByRole('button', { name: /prod/ })

    expect(defaultRow).toHaveTextContent('확인 중')
    expect(prodRow).toHaveTextContent('확인 중')
    expect(screen.getByRole('button', { name: '새 프로필' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '로컬 AWS CLI에서 가져오기' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '새로고침' })).toBeDisabled()
    expect(
      screen.getByText('AWS 프로필 상세 정보를 불러오는 중입니다.'),
    ).toBeInTheDocument()

    defaultDetails.resolve(
      createProfileDetails({
        profileName: 'default',
        accountId: '111111111111',
      }),
    )

    await waitFor(() => expect(defaultRow).toHaveTextContent('인증됨'))
    expect(defaultRow).toHaveTextContent('111111111111')

    prodDetails.reject(new Error('offline'))

    await waitFor(() => expect(prodRow).toHaveTextContent('조회 실패'))

    fireEvent.click(prodRow)

    expect(await screen.findByText('offline')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '새로고침' })).toBeEnabled(),
    )
  })

  it('restores cached profiles immediately after the panel remounts', async () => {
    const { api } = installMockApi()

    const firstRender = render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'default' })
    await waitFor(() => expect(api.aws.listProfiles).toHaveBeenCalledTimes(1))

    firstRender.unmount()

    render(<AwsProfilesPanel hosts={[]} />)

    expect(screen.getByRole('heading', { name: 'default' })).toBeInTheDocument()
    expect(api.aws.listProfiles).toHaveBeenCalledTimes(1)
  })

  it('imports external aws cli profiles into the app-managed profile list', async () => {
    const { api } = installMockApi({
      externalProfiles: [{ name: 'legacy-profile' }],
    })

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'default' })

    fireEvent.click(screen.getByRole('button', { name: '로컬 AWS CLI에서 가져오기' }))
    await screen.findByRole('heading', { name: '로컬 AWS CLI에서 가져오기' })

    fireEvent.click(screen.getByRole('button', { name: '선택한 프로필 가져오기' }))

    await waitFor(() =>
      expect(api.aws.importExternalProfiles).toHaveBeenCalledWith({
        profileNames: ['legacy-profile'],
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'legacy-profile' })).toBeInTheDocument(),
    )
  })

  it('creates a new static profile and auto-selects it after refresh', async () => {
    const { api } = installMockApi()

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('heading', { name: 'default' })

    fireEvent.click(screen.getByRole('button', { name: '새 프로필' }))
    expect(screen.getAllByText('AWS 프로필 생성')).toHaveLength(1)
    expect(
      screen.queryByText('유효성 검사를 통과한 경우에만 생성합니다.'),
    ).not.toBeInTheDocument()
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

  it('ignores stale detail responses from an earlier refresh after creating a new profile', async () => {
    const firstDefaultDetails = createDeferred<AwsProfileDetails>()
    const secondDefaultDetails = createDeferred<AwsProfileDetails>()
    const prodDetails = createDeferred<AwsProfileDetails>()
    const defaultRequests = [firstDefaultDetails, secondDefaultDetails]

    const getProfileDetailsImpl = vi.fn().mockImplementation((profileName: string) => {
      if (profileName === 'default') {
        const nextRequest = defaultRequests.shift()
        if (!nextRequest) {
          throw new Error('missing deferred default profile')
        }
        return nextRequest.promise
      }
      if (profileName === 'prod') {
        return prodDetails.promise
      }
      throw new Error('missing profile')
    })

    const { api } = installMockApi({
      getProfileDetailsImpl,
    })

    render(<AwsProfilesPanel hosts={[]} />)

    await screen.findByRole('button', { name: /default/ })

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
    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }))

    await waitFor(() => expect(api.aws.createProfile).toHaveBeenCalledTimes(1))
    await screen.findByRole('button', { name: /prod/ })
    await waitFor(() => expect(getProfileDetailsImpl).toHaveBeenCalledTimes(3))

    secondDefaultDetails.resolve(
      createProfileDetails({
        profileName: 'default',
        accountId: '222222222222',
      }),
    )
    prodDetails.resolve(
      createProfileDetails({
        profileName: 'prod',
        accountId: '333333333333',
      }),
    )

    const defaultRow = screen.getByRole('button', { name: /default/ })
    await waitFor(() => expect(defaultRow).toHaveTextContent('222222222222'))

    firstDefaultDetails.resolve(
      createProfileDetails({
        profileName: 'default',
        accountId: '111111111111',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(defaultRow).toHaveTextContent('222222222222')
    expect(defaultRow).not.toHaveTextContent('111111111111')
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
      profiles: [{ name: 'default' }],
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
      screen.getByText((content) =>
        content.includes('연결된 host의 표시용 프로필명도 함께 갱신됩니다.'),
      ),
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
