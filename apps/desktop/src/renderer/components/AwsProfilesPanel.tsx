import {
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  type AwsProfileDetails,
  type AwsProfileSummary,
  type AwsProfileUpdateInput,
  type HostRecord,
} from '@shared'
import { useEffect, useRef, useState } from 'react'
import { useAwsProfilesController } from '../controllers/useImportControllers'
import { cn } from '../lib/cn'
import { DialogBackdrop } from './DialogBackdrop'
import { AwsExternalProfileImportDialog } from './AwsExternalProfileImportDialog'
import { AwsProfileCreateWizard } from './AwsProfileCreateWizard'
import { AwsStaticProfileForm } from './AwsStaticProfileForm'
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts'
import {
  Badge,
  Button,
  EmptyState,
  FieldGroup,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  StatusBadge,
} from '../ui'

interface AwsProfilesPanelProps {
  hosts: HostRecord[]
}

function createEmptyAwsProfileDraft(): AwsProfileUpdateInput {
  return {
    profileName: '',
    accessKeyId: '',
    secretAccessKey: '',
    region: null,
  }
}

function resolveSelectedProfileName(
  profiles: AwsProfileSummary[],
  preferredProfileName?: string | null,
): string {
  const preferred = preferredProfileName?.trim() ?? ''
  if (preferred && profiles.some((profile) => profile.name === preferred)) {
    return preferred
  }
  return profiles[0]?.name ?? ''
}

function getNextProfileSelectionAfterDelete(
  profiles: AwsProfileSummary[],
  profileName: string,
): string | null {
  const currentIndex = profiles.findIndex((profile) => profile.name === profileName)
  if (currentIndex < 0) {
    return profiles[0]?.name ?? null
  }
  return (
    profiles[currentIndex + 1]?.name ??
    profiles[currentIndex - 1]?.name ??
    null
  )
}

function getAwsProfileHostReferences(
  hosts: HostRecord[],
  profile: Pick<AwsProfileSummary, 'id' | 'name'>,
): Array<{ id: string; label: string; kind: 'aws-ec2' | 'aws-ecs' }> {
  return hosts
    .filter((host) => isAwsEc2HostRecord(host) || isAwsEcsHostRecord(host))
    .filter((host) =>
      profile.id ? host.awsProfileId === profile.id : host.awsProfileName === profile.name,
    )
    .map((host) => ({
      id: host.id,
      label: host.label,
      kind: host.kind,
    }))
}

function formatAwsProfileKind(kind: AwsProfileDetails['kind']): string {
  switch (kind) {
    case 'static':
      return 'Static'
    case 'sso':
      return 'SSO'
    case 'role':
      return 'Role'
    case 'credential-process':
      return 'Credential Process'
    default:
      return 'Unknown'
  }
}

function getAwsProfileKindTone(kind: AwsProfileDetails['kind']) {
  switch (kind) {
    case 'static':
      return 'running' as const
    case 'sso':
      return 'starting' as const
    case 'role':
      return 'paused' as const
    case 'credential-process':
      return 'neutral' as const
    default:
      return 'neutral' as const
  }
}

function getAwsProfileStatusTone(
  details?: AwsProfileDetails,
): 'neutral' | 'running' | 'error' {
  if (!details) {
    return 'neutral'
  }
  return details.isAuthenticated ? 'running' : 'error'
}

function getAwsProfileStatusLabel(details?: AwsProfileDetails): string {
  if (!details) {
    return '확인 중'
  }
  return details.isAuthenticated ? '인증됨' : '인증 필요'
}

function formatExternalImportSummary(input: {
  importedProfileNames: string[]
  skippedProfileNames: string[]
}): string {
  const parts: string[] = []
  if (input.importedProfileNames.length > 0) {
    parts.push(`가져온 프로필 ${input.importedProfileNames.length}개`)
  }
  if (input.skippedProfileNames.length > 0) {
    parts.push(`건너뜀 ${input.skippedProfileNames.length}개`)
  }
  return parts.length > 0 ? `${parts.join(', ')}.` : '가져온 프로필이 없습니다.'
}

function renderReferenceList(items: string[]) {
  return (
    <ul className="m-0 grid gap-1.5 pl-5 text-sm text-[var(--text-soft)]">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

function renderHostReferenceList(
  items: Array<{ id: string; label: string; kind: 'aws-ec2' | 'aws-ecs' }>,
) {
  return (
    <ul className="m-0 grid gap-1.5 pl-5 text-sm text-[var(--text-soft)]">
      {items.map((item) => (
        <li key={item.id}>
          {item.label} ({item.kind})
        </li>
      ))}
    </ul>
  )
}

function ProfileField({
  label,
  value,
}: {
  label: string
  value?: string | null
}) {
  return (
    <div className="grid gap-1 rounded-[18px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-4 py-[0.9rem]">
      <dt className="text-[0.82rem] text-[var(--text-soft)]">{label}</dt>
      <dd className="m-0 break-all text-[var(--text)]">{value?.trim() ? value : '—'}</dd>
    </div>
  )
}

export function AwsProfilesPanel({ hosts }: AwsProfilesPanelProps) {
  const {
    getSyncStatus,
    listAwsProfiles,
    listExternalAwsProfiles,
    createAwsProfile,
    prepareAwsSsoProfile,
    getAwsProfileDetails,
    getExternalAwsProfileDetails,
    importExternalAwsProfiles,
    updateAwsProfile,
    renameAwsProfile,
    deleteAwsProfile,
    loginAwsProfile,
  } = useAwsProfilesController()
  const [profiles, setProfiles] = useState<AwsProfileSummary[]>([])
  const [detailsByProfileName, setDetailsByProfileName] = useState<
    Record<string, AwsProfileDetails>
  >({})
  const [detailErrorsByProfileName, setDetailErrorsByProfileName] = useState<
    Record<string, string>
  >({})
  const [selectedProfileName, setSelectedProfileName] = useState('')
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [profileFormMode, setProfileFormMode] = useState<'create' | 'edit' | null>(null)
  const [profileDraft, setProfileDraft] = useState<AwsProfileUpdateInput>(
    createEmptyAwsProfileDraft(),
  )
  const [profileFormError, setProfileFormError] = useState<string | null>(null)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [isRenameOpen, setIsRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [isExternalImportOpen, setIsExternalImportOpen] = useState(false)
  const [externalImportSummary, setExternalImportSummary] = useState<string | null>(null)
  const [awsProfilesServerSupport, setAwsProfilesServerSupport] = useState<
    'unknown' | 'supported' | 'unsupported'
  >('unknown')
  const requestIdRef = useRef(0)

  const selectedDetails = selectedProfileName
    ? detailsByProfileName[selectedProfileName] ?? null
    : null
  const selectedProfileSummary = selectedProfileName
    ? profiles.find((profile) => profile.name === selectedProfileName) ?? null
    : null
  const selectedDetailError = selectedProfileName
    ? detailErrorsByProfileName[selectedProfileName] ?? null
    : null
  const selectedHostReferences = selectedProfileSummary
    ? getAwsProfileHostReferences(hosts, selectedProfileSummary)
    : []

  async function refreshProfiles(preferredProfileName?: string | null) {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsLoadingProfiles(true)
    setLoadError(null)

    try {
      const items = await listAwsProfiles()
      if (requestIdRef.current !== requestId) {
        return
      }

      const nextSelectedProfileName = resolveSelectedProfileName(
        items,
        preferredProfileName ?? selectedProfileName,
      )

      setProfiles(items)
      setSelectedProfileName(nextSelectedProfileName)

      if (items.length === 0) {
        setDetailsByProfileName({})
        setDetailErrorsByProfileName({})
        return
      }

      const detailResults = await Promise.allSettled(
        items.map(async (profile) => [
          profile.name,
          await getAwsProfileDetails(profile.name),
        ] as const),
      )

      if (requestIdRef.current !== requestId) {
        return
      }

      const nextDetailsByProfileName: Record<string, AwsProfileDetails> = {}
      const nextDetailErrorsByProfileName: Record<string, string> = {}

      for (let index = 0; index < detailResults.length; index += 1) {
        const result = detailResults[index]
        const profileName = items[index]?.name
        if (!profileName) {
          continue
        }
        if (result?.status === 'fulfilled') {
          const [name, details] = result.value
          nextDetailsByProfileName[name] = details
          continue
        }
        nextDetailErrorsByProfileName[profileName] =
          result?.reason instanceof Error
            ? result.reason.message
            : 'AWS 프로필 상세 정보를 불러오지 못했습니다.'
      }

      setDetailsByProfileName(nextDetailsByProfileName)
      setDetailErrorsByProfileName(nextDetailErrorsByProfileName)
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return
      }
      setProfiles([])
      setDetailsByProfileName({})
      setDetailErrorsByProfileName({})
      setSelectedProfileName('')
      setLoadError(
        error instanceof Error
          ? error.message
          : 'AWS 프로필 목록을 불러오지 못했습니다.',
      )
    } finally {
      if (requestIdRef.current === requestId) {
        setIsLoadingProfiles(false)
      }
    }
  }

  useEffect(() => {
    void getSyncStatus()
      .then((status) => {
        setAwsProfilesServerSupport(status.awsProfilesServerSupport ?? 'unknown')
      })
      .catch(() => undefined)
  }, [getSyncStatus])

  useEffect(() => {
    void refreshProfiles()
    return () => {
      requestIdRef.current += 1
    }
  }, [])

  function openCreateDialog() {
    setProfileFormMode('create')
    setProfileFormError(null)
  }

  function openEditDialog() {
    if (!selectedDetails || selectedDetails.kind !== 'static') {
      return
    }
    setProfileFormMode('edit')
    setProfileDraft({
      profileName: selectedDetails.profileName,
      accessKeyId: '',
      secretAccessKey: '',
      region: selectedDetails.configuredRegion ?? null,
    })
    setProfileFormError(null)
  }

  async function handleSaveProfile() {
    if (profileFormMode !== 'edit') {
      return
    }

    setProfileFormError(null)
    setIsSavingProfile(true)

    try {
      await updateAwsProfile(profileDraft)
      setProfileFormMode(null)
      await refreshProfiles(profileDraft.profileName)
    } catch (error) {
      setProfileFormError(
        normalizeErrorMessage(error, 'AWS 프로필을 저장하지 못했습니다.'),
      )
    } finally {
      setIsSavingProfile(false)
    }
  }

  async function handleCreateProfileSuccess(profileName: string) {
    setProfileFormMode(null)
    await refreshProfiles(profileName)
  }

  async function handleExternalImport(result: {
    importedProfileNames: string[]
    skippedProfileNames: string[]
  }) {
    setExternalImportSummary(formatExternalImportSummary(result))
    const preferredProfileName = result.importedProfileNames[0] ?? selectedProfileName
    await refreshProfiles(preferredProfileName)
  }

  async function handleRenameProfile() {
    if (!selectedProfileName) {
      return
    }

    setRenameError(null)
    setIsRenaming(true)

    try {
      await renameAwsProfile({
        profileName: selectedProfileName,
        nextProfileName: renameDraft,
      })
      setIsRenameOpen(false)
      await refreshProfiles(renameDraft)
    } catch (error) {
      setRenameError(
        normalizeErrorMessage(error, 'AWS 프로필명을 변경하지 못했습니다.'),
      )
    } finally {
      setIsRenaming(false)
    }
  }

  async function handleDeleteProfile() {
    if (!selectedProfileName) {
      return
    }

    const nextSelection = getNextProfileSelectionAfterDelete(
      profiles,
      selectedProfileName,
    )

    setDeleteError(null)
    setIsDeleting(true)

    try {
      await deleteAwsProfile(selectedProfileName)
      setIsDeleteOpen(false)
      await refreshProfiles(nextSelection)
    } catch (error) {
      setDeleteError(
        normalizeErrorMessage(error, 'AWS 프로필을 삭제하지 못했습니다.'),
      )
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleLogin() {
    if (!selectedProfileName) {
      return
    }

    setIsLoggingIn(true)
    setLoadError(null)

    try {
      await loginAwsProfile(selectedProfileName)
      await refreshProfiles(selectedProfileName)
    } catch (error) {
      setLoadError(
        normalizeErrorMessage(error, 'AWS SSO 로그인을 시작하지 못했습니다.'),
      )
    } finally {
      setIsLoggingIn(false)
    }
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>AWS</SectionLabel>
          <h3 className="m-0">Profiles</h3>
          <p className="mb-0 mt-2 text-[0.92rem] text-[var(--text-soft)]">
            앱 전용 AWS CLI 프로필을 확인하고 생성, 수정, 이름 변경, 삭제할 수 있습니다. 기존 로컬 AWS CLI 프로필은 가져오기 후 사용할 수 있습니다.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            disabled={isLoadingProfiles || isLoggingIn || isSavingProfile || isRenaming || isDeleting}
            onClick={() => {
              void refreshProfiles(selectedProfileName)
            }}
          >
            새로고침
          </Button>
          <Button
            variant="secondary"
            disabled={isLoadingProfiles || isLoggingIn || isSavingProfile || isRenaming || isDeleting}
            onClick={() => setIsExternalImportOpen(true)}
          >
            로컬 AWS CLI에서 가져오기
          </Button>
          <Button
            variant="primary"
            disabled={isLoadingProfiles || isLoggingIn || isSavingProfile || isRenaming || isDeleting}
            onClick={openCreateDialog}
          >
            새 프로필
          </Button>
        </div>
      </div>

      {loadError ? (
        <NoticeCard tone="danger" role="alert">
          {loadError}
        </NoticeCard>
      ) : null}

      {externalImportSummary ? (
        <NoticeCard tone="info">{externalImportSummary}</NoticeCard>
      ) : null}

      {awsProfilesServerSupport === 'unsupported' ? (
        <NoticeCard tone="warning">
          현재 서버는 AWS 프로필 동기화를 아직 지원하지 않습니다. 서버를 업데이트하기 전까지 이 기기에서만 저장됩니다.
        </NoticeCard>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section className="grid content-start gap-3 rounded-[28px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.25rem] shadow-[var(--shadow-soft)]">
          <div className="flex items-center justify-between gap-3">
            <strong>AWS Profiles</strong>
            <Badge tone="neutral">{profiles.length}</Badge>
          </div>

          {isLoadingProfiles && profiles.length === 0 ? (
            <NoticeCard tone="info">AWS 프로필 목록을 불러오는 중입니다.</NoticeCard>
          ) : null}

          {!isLoadingProfiles && profiles.length === 0 ? (
            <EmptyState
              title="등록된 AWS 프로필이 없습니다."
              description="새 프로필을 생성하면 기존 AWS import와 SSM 연결 흐름에서 바로 사용할 수 있습니다."
            />
          ) : null}

          <div className="grid content-start gap-3">
            {profiles.map((profile) => {
              const details = detailsByProfileName[profile.name]
              const isSelected = profile.name === selectedProfileName
              return (
                <button
                  key={profile.name}
                  type="button"
                  className={cn(
                    'grid min-h-[9.25rem] gap-3 rounded-[24px] border px-4 py-4 text-left transition-[border-color,background-color,box-shadow] duration-150',
                    isSelected
                      ? 'border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface))] shadow-[0_14px_28px_rgba(16,26,42,0.08)]'
                      : 'border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_84%,transparent_16%)]',
                  )}
                  onClick={() => setSelectedProfileName(profile.name)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <strong className="min-w-0 break-all pr-2 text-[1.02rem] leading-[1.35] text-[var(--text)]">
                      {profile.name}
                    </strong>
                    {details ? (
                      <Badge
                        tone={getAwsProfileKindTone(details.kind)}
                        className="shrink-0"
                      >
                        {formatAwsProfileKind(details.kind)}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 text-[0.85rem] text-[var(--text-soft)]">
                    <StatusBadge tone={getAwsProfileStatusTone(details)}>
                      {getAwsProfileStatusLabel(details)}
                    </StatusBadge>

                    <span className="rounded-full border border-[color-mix(in_srgb,var(--border)_78%,white_22%)] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-[0.78rem] py-[0.34rem] text-[0.8rem] font-medium text-[var(--text-soft)]">
                      {details?.configuredRegion ?? 'Region 없음'}
                    </span>
                  </div>

                  <div className="grid gap-1 pt-0.5">
                    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[var(--text-soft)]">
                      Account
                    </span>
                    <span className="break-all text-[0.92rem] font-medium text-[var(--text-soft)]">
                      {details?.accountId ?? '인증 후 확인 가능'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="grid content-start gap-4 rounded-[28px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.35rem] shadow-[var(--shadow-soft)]">
          {!selectedProfileName ? (
            <EmptyState
              title="선택된 프로필이 없습니다."
              description="왼쪽 목록에서 AWS 프로필을 선택하면 상세 정보와 관리 액션이 표시됩니다."
            />
          ) : null}

          {selectedProfileName && !selectedDetails && !selectedDetailError ? (
            <NoticeCard tone="info">AWS 프로필 상세 정보를 불러오는 중입니다.</NoticeCard>
          ) : null}

          {selectedDetailError ? (
            <NoticeCard tone="danger" role="alert">
              {selectedDetailError}
            </NoticeCard>
          ) : null}

          {selectedDetails ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="m-0 break-all text-[1.15rem]">{selectedDetails.profileName}</h4>
                    <Badge tone={getAwsProfileKindTone(selectedDetails.kind)}>
                      {formatAwsProfileKind(selectedDetails.kind)}
                    </Badge>
                    <StatusBadge tone={getAwsProfileStatusTone(selectedDetails)}>
                      {getAwsProfileStatusLabel(selectedDetails)}
                    </StatusBadge>
                  </div>
                  <p className="m-0 text-[0.92rem] text-[var(--text-soft)]">
                    {selectedDetails.isAuthenticated
                      ? '현재 AWS CLI 기준으로 인증 가능한 상태입니다.'
                      : selectedDetails.errorMessage ?? '추가 로그인이 필요하거나 자격 증명을 다시 확인해야 합니다.'}
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    disabled={isLoadingProfiles || isSavingProfile || isRenaming || isDeleting || isLoggingIn}
                    onClick={() => {
                      setRenameDraft(selectedDetails.profileName)
                      setRenameError(null)
                      setIsRenameOpen(true)
                    }}
                  >
                    이름 변경
                  </Button>

                  {selectedDetails.kind === 'static' ? (
                    <Button
                      variant="secondary"
                      disabled={isLoadingProfiles || isSavingProfile || isRenaming || isDeleting || isLoggingIn}
                      onClick={openEditDialog}
                    >
                      수정
                    </Button>
                  ) : null}

                  {selectedDetails.kind === 'sso' ? (
                    <Button
                      variant="secondary"
                      disabled={isLoadingProfiles || isSavingProfile || isRenaming || isDeleting || isLoggingIn}
                      onClick={() => {
                        void handleLogin()
                      }}
                    >
                      {isLoggingIn ? '로그인 시작 중...' : 'AWS SSO 로그인'}
                    </Button>
                  ) : null}

                  <Button
                    variant="danger"
                    disabled={isLoadingProfiles || isSavingProfile || isRenaming || isDeleting || isLoggingIn}
                    onClick={() => {
                      setDeleteError(null)
                      setIsDeleteOpen(true)
                    }}
                  >
                    삭제
                  </Button>
                </div>
              </div>

              {selectedDetails.missingTools && selectedDetails.missingTools.length > 0 ? (
                <NoticeCard tone="warning">
                  누락된 도구: {selectedDetails.missingTools.join(', ')}
                </NoticeCard>
              ) : null}

              {selectedHostReferences.length > 0 ? (
                <NoticeCard title="이 프로필을 참조하는 host" tone="warning">
                  {renderHostReferenceList(selectedHostReferences)}
                </NoticeCard>
              ) : null}

              {selectedDetails.referencedByProfileNames.length > 0 ? (
                <NoticeCard title="이 프로필을 source_profile로 참조하는 로컬 프로필" tone="warning">
                  {renderReferenceList(selectedDetails.referencedByProfileNames)}
                </NoticeCard>
              ) : null}

              <dl className="grid gap-3 md:grid-cols-2">
                <ProfileField label="기본 Region" value={selectedDetails.configuredRegion ?? null} />
                <ProfileField label="Account" value={selectedDetails.accountId ?? null} />
                <ProfileField label="ARN" value={selectedDetails.arn ?? null} />
                <ProfileField label="Access Key" value={selectedDetails.maskedAccessKeyId ?? null} />
                <ProfileField label="source_profile" value={selectedDetails.sourceProfile ?? null} />
                <ProfileField label="role_arn" value={selectedDetails.roleArn ?? null} />
                <ProfileField label="sso-session" value={selectedDetails.ssoSession ?? null} />
                <ProfileField label="SSO Start URL" value={selectedDetails.ssoStartUrl ?? null} />
                <ProfileField label="SSO Region" value={selectedDetails.ssoRegion ?? null} />
                <ProfileField label="SSO Account" value={selectedDetails.ssoAccountId ?? null} />
                <ProfileField label="SSO Role" value={selectedDetails.ssoRoleName ?? null} />
                <ProfileField label="credential_process" value={selectedDetails.credentialProcess ?? null} />
                <ProfileField
                  label="Session Token"
                  value={selectedDetails.hasSessionToken ? '설정됨' : null}
                />
              </dl>
            </>
          ) : null}
        </section>
      </div>

      {profileFormMode ? (
        <DialogBackdrop onDismiss={() => setProfileFormMode(null)}>
          <ModalShell size="lg">
            <ModalHeader>
              <div className="grid gap-1">
                <strong>
                  {profileFormMode === 'create' ? 'AWS 프로필 생성' : 'AWS 프로필 수정'}
                </strong>
                <span className="text-[0.9rem] text-[var(--text-soft)]">
                  {profileFormMode === 'create'
                    ? '앱 전용 AWS CLI 프로필로 저장합니다.'
                    : 'Static access key 기반 프로필만 수정할 수 있습니다.'}
                </span>
              </div>
            </ModalHeader>
            <ModalBody>
              {profileFormMode === 'create' ? (
                <AwsProfileCreateWizard
                  testId="aws-profiles-create-form"
                  title="새 AWS 프로필 생성"
                  descriptions={[
                    '유효성 검사를 통과한 경우에만 생성합니다.',
                    ...(awsProfilesServerSupport === 'unsupported'
                      ? ['현재 서버는 AWS 프로필 동기화를 지원하지 않아 이 기기에서만 저장됩니다.']
                      : []),
                  ]}
                  profiles={profiles}
                  createProfile={createAwsProfile}
                  prepareSsoProfile={prepareAwsSsoProfile}
                  onCancel={() => setProfileFormMode(null)}
                  onSuccess={(profileName) => handleCreateProfileSuccess(profileName)}
                />
              ) : (
                <AwsStaticProfileForm
                  testId="aws-profiles-edit-form"
                  title="Static AWS 프로필 수정"
                  descriptions={['수정 전 STS 호출로 자격 증명을 다시 검증합니다.']}
                  draft={profileDraft}
                  error={profileFormError}
                  isSubmitting={isSavingProfile}
                  submitLabel="프로필 업데이트"
                  submittingLabel="업데이트 중..."
                  profileNameLabel="프로필명"
                  profileNameEditable={false}
                  accessKeyHelpText={
                    selectedDetails?.maskedAccessKeyId
                      ? `현재 저장된 access key: ${selectedDetails.maskedAccessKeyId}`
                      : null
                  }
                  onChange={setProfileDraft}
                  onCancel={() => setProfileFormMode(null)}
                  onSubmit={() => {
                    void handleSaveProfile()
                  }}
                />
              )}
            </ModalBody>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      {isRenameOpen && selectedDetails ? (
        <DialogBackdrop onDismiss={() => setIsRenameOpen(false)}>
          <ModalShell size="md">
            <ModalHeader>
              <div className="grid gap-1">
                <strong>프로필명 변경</strong>
                <span className="text-[0.9rem] text-[var(--text-soft)]">
                  로컬 AWS CLI 설정 파일의 프로필명만 변경합니다.
                </span>
              </div>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              <FieldGroup label="새 프로필명">
                <Input
                  aria-label="새 프로필명"
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  disabled={isRenaming}
                />
              </FieldGroup>

              {selectedHostReferences.length > 0 ? (
                <NoticeCard title="주의" tone="warning">
                  현재 앱의 host가 이 프로필을 참조하고 있습니다. 이름을 바꾸면 연결된 host의 표시용 프로필명도 함께 갱신됩니다.
                  {renderHostReferenceList(selectedHostReferences)}
                </NoticeCard>
              ) : null}

              {selectedDetails.referencedByProfileNames.length > 0 ? (
                <NoticeCard title="참고" tone="warning">
                  다음 로컬 프로필의 `source_profile` 참조는 새 이름으로 자동 갱신됩니다.
                  {renderReferenceList(selectedDetails.referencedByProfileNames)}
                </NoticeCard>
              ) : null}

              {renameError ? (
                <NoticeCard tone="danger" role="alert">
                  {renameError}
                </NoticeCard>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button variant="secondary" disabled={isRenaming} onClick={() => setIsRenameOpen(false)}>
                취소
              </Button>
              <Button
                variant="primary"
                disabled={isRenaming}
                onClick={() => {
                  void handleRenameProfile()
                }}
              >
                {isRenaming ? '변경 중...' : '프로필명 변경'}
              </Button>
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      {isDeleteOpen && selectedDetails ? (
        <DialogBackdrop onDismiss={() => setIsDeleteOpen(false)}>
          <ModalShell size="md">
            <ModalHeader>
              <div className="grid gap-1">
                <strong>프로필 삭제</strong>
                <span className="text-[0.9rem] text-[var(--text-soft)]">
                  로컬 AWS CLI 설정 파일에서 이 프로필을 제거합니다.
                </span>
              </div>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              <NoticeCard title={selectedDetails.profileName} tone="warning">
                삭제 후에는 이 프로필을 참조하던 host가 프로필 없음 상태가 될 수 있습니다.
              </NoticeCard>

              {selectedHostReferences.length > 0 ? (
                <NoticeCard title="이 프로필을 쓰는 host" tone="warning">
                  {renderHostReferenceList(selectedHostReferences)}
                </NoticeCard>
              ) : null}

              {selectedDetails.referencedByProfileNames.length > 0 ? (
                <NoticeCard title="이 프로필을 source_profile로 참조하는 로컬 프로필" tone="warning">
                  {renderReferenceList(selectedDetails.referencedByProfileNames)}
                </NoticeCard>
              ) : null}

              {selectedDetails.orphanedSsoSessionName ? (
                <NoticeCard title="함께 삭제될 sso-session" tone="warning">
                  <span>{selectedDetails.orphanedSsoSessionName}</span>
                </NoticeCard>
              ) : null}

              {deleteError ? (
                <NoticeCard tone="danger" role="alert">
                  {deleteError}
                </NoticeCard>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button variant="secondary" disabled={isDeleting} onClick={() => setIsDeleteOpen(false)}>
                취소
              </Button>
              <Button
                variant="danger"
                disabled={isDeleting}
                onClick={() => {
                  void handleDeleteProfile()
                }}
              >
                {isDeleting ? '삭제 중...' : '프로필 삭제'}
              </Button>
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      <AwsExternalProfileImportDialog
        open={isExternalImportOpen}
        onClose={() => setIsExternalImportOpen(false)}
        onImported={(result) => handleExternalImport(result)}
        listExternalProfiles={listExternalAwsProfiles}
        getExternalProfileDetails={getExternalAwsProfileDetails}
        importExternalProfiles={importExternalAwsProfiles}
      />
    </div>
  )
}
