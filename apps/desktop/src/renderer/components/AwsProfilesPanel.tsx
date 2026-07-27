import {
  AWS_PROFILE_REGION_OPTIONS,
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
  SelectField,
  StatusBadge,
} from '../ui'
import { useTranslation } from 'react-i18next';
import { t } from "../i18n";

interface AwsProfilesPanelProps {
  hosts: HostRecord[]
}

const AWS_PROFILE_DETAILS_CONCURRENCY = 3
const AWS_PROFILE_DETAIL_ERROR_KEY = 'awsProfiles.error.detailLoadFailed'

type AwsProfilesPanelCacheState = {
  profiles: AwsProfileSummary[]
  detailsByProfileName: Record<string, AwsProfileDetails>
  detailErrorsByProfileName: Record<string, string>
  selectedProfileName: string
  externalImportSummary: string | null
  hasLoaded: boolean
}

const DEFAULT_AWS_PROFILES_PANEL_CACHE_STATE: AwsProfilesPanelCacheState = {
  profiles: [],
  detailsByProfileName: {},
  detailErrorsByProfileName: {},
  selectedProfileName: '',
  externalImportSummary: null,
  hasLoaded: false,
}

let awsProfilesPanelCache: AwsProfilesPanelCacheState = {
  ...DEFAULT_AWS_PROFILES_PANEL_CACHE_STATE,
}

function isAwsProfilesPanelCacheComplete(cache: AwsProfilesPanelCacheState): boolean {
  if (!cache.hasLoaded) {
    return false
  }
  if (cache.profiles.length === 0) {
    return true
  }
  return cache.profiles.every(
    (profile) =>
      Boolean(cache.detailsByProfileName[profile.name]) ||
      Boolean(cache.detailErrorsByProfileName[profile.name]),
  )
}

export function resetAwsProfilesPanelCacheForTests() {
  awsProfilesPanelCache = {
    ...DEFAULT_AWS_PROFILES_PANEL_CACHE_STATE,
  }
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
  if (!profile.id) {
    return []
  }
  return hosts
    .filter((host) => isAwsEc2HostRecord(host) || isAwsEcsHostRecord(host))
    .filter((host) => host.awsProfileId === profile.id)
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
  hasError = false,
): 'neutral' | 'running' | 'error' {
  if (hasError) {
    return 'error'
  }
  if (!details) {
    return 'neutral'
  }
  return details.isAuthenticated ? 'running' : 'error'
}

function getAwsProfileStatusLabel(
  details?: AwsProfileDetails,
  hasError = false,
): string {
  if (hasError) {
    return t('awsProfiles.status.lookupFailed')
  }
  if (!details) {
    return t('awsProfiles.status.checking')
  }
  return t(details.isAuthenticated ? 'awsProfiles.status.authenticated' : 'awsProfiles.status.authRequired')
}

function formatExternalImportSummary(input: {
  importedProfileNames: string[]
  skippedProfileNames: string[]
}): string {
  const parts: string[] = []
  if (input.importedProfileNames.length > 0) {
    parts.push(t('awsProfiles.import.imported', { count: input.importedProfileNames.length }))
  }
  if (input.skippedProfileNames.length > 0) {
    parts.push(t('awsProfiles.import.skipped', { count: input.skippedProfileNames.length }))
  }
  return parts.length > 0 ? `${parts.join(', ')}.` : t('awsProfiles.import.none')
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
    <div className="grid gap-1 rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] px-4 py-[0.9rem]">
      <dt className="text-[0.82rem] text-[var(--text-soft)]">{label}</dt>
      <dd className="m-0 break-all text-[var(--text)]">{value?.trim() ? value : '—'}</dd>
    </div>
  )
}

function canEditAwsProfileRegion(kind: AwsProfileDetails['kind']): boolean {
  return kind === 'static' || kind === 'sso' || kind === 'role'
}

export function AwsProfilesPanel({ hosts }: AwsProfilesPanelProps) {
  const { t: translate } = useTranslation();
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
    updateAwsProfileRegion,
    renameAwsProfile,
    deleteAwsProfile,
    loginAwsProfile,
  } = useAwsProfilesController()
  const [profiles, setProfiles] = useState<AwsProfileSummary[]>(awsProfilesPanelCache.profiles)
  const [detailsByProfileName, setDetailsByProfileName] = useState<
    Record<string, AwsProfileDetails>
  >(awsProfilesPanelCache.detailsByProfileName)
  const [detailErrorsByProfileName, setDetailErrorsByProfileName] = useState<
    Record<string, string>
  >(awsProfilesPanelCache.detailErrorsByProfileName)
  const [selectedProfileName, setSelectedProfileName] = useState(() =>
    resolveSelectedProfileName(
      awsProfilesPanelCache.profiles,
      awsProfilesPanelCache.selectedProfileName,
    ),
  )
  const [hasLoadedProfilesOnce, setHasLoadedProfilesOnce] = useState(
    awsProfilesPanelCache.hasLoaded,
  )
  const [isLoadingProfileList, setIsLoadingProfileList] = useState(false)
  const [loadingDetailsByProfileName, setLoadingDetailsByProfileName] = useState<
    Record<string, boolean>
  >({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [profileFormMode, setProfileFormMode] = useState<'create' | 'edit' | null>(null)
  const [profileDraft, setProfileDraft] = useState<AwsProfileUpdateInput>(
    createEmptyAwsProfileDraft(),
  )
  const [profileFormError, setProfileFormError] = useState<string | null>(null)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [isRegionOpen, setIsRegionOpen] = useState(false)
  const [regionDraft, setRegionDraft] = useState('')
  const [regionError, setRegionError] = useState<string | null>(null)
  const [isSavingRegion, setIsSavingRegion] = useState(false)
  const [isRenameOpen, setIsRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [isExternalImportOpen, setIsExternalImportOpen] = useState(false)
  const [externalImportSummary, setExternalImportSummary] = useState<string | null>(
    awsProfilesPanelCache.externalImportSummary,
  )
  const [awsProfilesServerSupport, setAwsProfilesServerSupport] = useState<
    'unknown' | 'supported' | 'unsupported'
  >('unknown')
  const requestIdRef = useRef(0)
  const isRefreshingProfileDetails =
    Object.keys(loadingDetailsByProfileName).length > 0

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

  function removeProfileStateEntry<T>(
    current: Record<string, T>,
    profileName: string,
  ): Record<string, T> {
    if (!(profileName in current)) {
      return current
    }
    const next = { ...current }
    delete next[profileName]
    return next
  }

  async function loadProfileDetailsIncrementally(
    requestId: number,
    items: AwsProfileSummary[],
  ) {
    const queue = [...items]
    const workerCount = Math.min(AWS_PROFILE_DETAILS_CONCURRENCY, queue.length)

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const profile = queue.shift()
          if (!profile) {
            return
          }

          try {
            const details = await getAwsProfileDetails(profile.name)
            if (requestIdRef.current !== requestId) {
              return
            }
            setDetailsByProfileName((current) => ({
              ...current,
              [profile.name]: details,
            }))
            setDetailErrorsByProfileName((current) =>
              removeProfileStateEntry(current, profile.name),
            )
          } catch (error) {
            if (requestIdRef.current !== requestId) {
              return
            }
            setDetailsByProfileName((current) =>
              removeProfileStateEntry(current, profile.name),
            )
            setDetailErrorsByProfileName((current) => ({
              ...current,
              [profile.name]:
                error instanceof Error
                  ? error.message
                  : translate(AWS_PROFILE_DETAIL_ERROR_KEY),
            }))
          } finally {
            if (requestIdRef.current === requestId) {
              setLoadingDetailsByProfileName((current) =>
                removeProfileStateEntry(current, profile.name),
              )
            }
          }
        }
      }),
    )
  }

  async function refreshProfiles(preferredProfileName?: string | null) {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setIsLoadingProfileList(true)
    setLoadingDetailsByProfileName({})
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
      setHasLoadedProfilesOnce(true)

      if (items.length === 0) {
        setDetailsByProfileName({})
        setDetailErrorsByProfileName({})
        setLoadingDetailsByProfileName({})
        return
      }

      setDetailsByProfileName({})
      setDetailErrorsByProfileName({})
      setLoadingDetailsByProfileName(
        Object.fromEntries(items.map((profile) => [profile.name, true])),
      )
      void loadProfileDetailsIncrementally(requestId, items).catch(() => undefined)
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return
      }
      setProfiles([])
      setDetailsByProfileName({})
      setDetailErrorsByProfileName({})
      setLoadingDetailsByProfileName({})
      setSelectedProfileName('')
      setLoadError(
        error instanceof Error
          ? error.message
          : translate('awsProfiles.error.listLoadFailed'),
      )
    } finally {
      if (requestIdRef.current === requestId) {
        setIsLoadingProfileList(false)
      }
    }
  }

  useEffect(() => {
    awsProfilesPanelCache = {
      profiles,
      detailsByProfileName,
      detailErrorsByProfileName,
      selectedProfileName,
      externalImportSummary,
      hasLoaded: hasLoadedProfilesOnce,
    }
  }, [
    detailErrorsByProfileName,
    detailsByProfileName,
    externalImportSummary,
    hasLoadedProfilesOnce,
    profiles,
    selectedProfileName,
  ])

  useEffect(() => {
    void getSyncStatus()
      .then((status) => {
        setAwsProfilesServerSupport(status.awsProfilesServerSupport ?? 'unknown')
      })
      .catch(() => undefined)
  }, [getSyncStatus])

  useEffect(() => {
    if (!isAwsProfilesPanelCacheComplete(awsProfilesPanelCache)) {
      void refreshProfiles(awsProfilesPanelCache.selectedProfileName || undefined)
    }
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
        normalizeErrorMessage(error, translate('awsProfiles.error.saveFailed')),
      )
    } finally {
      setIsSavingProfile(false)
    }
  }

  function openRegionDialog() {
    if (!selectedDetails) {
      return
    }
    setRegionDraft(selectedDetails.configuredRegion ?? '')
    setRegionError(null)
    setIsRegionOpen(true)
  }

  async function handleSaveRegion() {
    if (!selectedDetails) {
      return
    }

    const profileName = selectedDetails.profileName
    setRegionError(null)
    setIsSavingRegion(true)

    try {
      await updateAwsProfileRegion({
        profileName,
        region: regionDraft || null,
      })
      setIsRegionOpen(false)
      await refreshProfiles(profileName)
    } catch (error) {
      setRegionError(
        normalizeErrorMessage(error, translate('awsProfiles.error.regionSaveFailed')),
      )
    } finally {
      setIsSavingRegion(false)
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
        normalizeErrorMessage(error, translate('awsProfiles.error.renameFailed')),
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
        normalizeErrorMessage(error, translate('awsProfiles.error.deleteFailed')),
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
        normalizeErrorMessage(error, translate('awsProfiles.error.ssoLoginFailed')),
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
          <p className="mb-0 mt-2 text-[0.9rem] text-[var(--text-soft)]">
            {translate('awsProfiles.intro')}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            disabled={
              isLoadingProfileList ||
              isRefreshingProfileDetails ||
              isLoggingIn ||
              isSavingProfile ||
              isSavingRegion ||
              isRenaming ||
              isDeleting
            }
            onClick={() => {
              void refreshProfiles(selectedProfileName)
            }}
          >
            {translate('awsProfiles.action.refresh')}
          </Button>
          <Button
            variant="secondary"
            disabled={
              isLoadingProfileList ||
              isLoggingIn ||
              isSavingProfile ||
              isSavingRegion ||
              isRenaming ||
              isDeleting
            }
            onClick={() => setIsExternalImportOpen(true)}
          >
            {translate('awsProfiles.action.importFromCli')}
          </Button>
          <Button
            variant="primary"
            disabled={
              isLoadingProfileList ||
              isLoggingIn ||
              isSavingProfile ||
              isSavingRegion ||
              isRenaming ||
              isDeleting
            }
            onClick={openCreateDialog}
          >
            {translate('awsProfiles.action.newProfile')}
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
          {translate('awsProfiles.syncUnsupported')}
        </NoticeCard>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section className="grid content-start gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.3rem] shadow-[var(--shadow-soft)]">
          <div className="flex items-center justify-between gap-3">
            <strong>AWS Profiles</strong>
            <Badge tone="neutral">{profiles.length}</Badge>
          </div>

          {isLoadingProfileList && profiles.length === 0 ? (
            <NoticeCard tone="info">{translate('awsProfiles.loadingList')}</NoticeCard>
          ) : null}

          {!isLoadingProfileList && profiles.length === 0 ? (
            <EmptyState
              title={translate('awsProfiles.empty.title')}
              description={translate('awsProfiles.empty.description')}
            />
          ) : null}

          <div className="grid content-start gap-3">
            {profiles.map((profile) => {
              const details = detailsByProfileName[profile.name]
              const detailError = detailErrorsByProfileName[profile.name] ?? null
              const isSelected = profile.name === selectedProfileName
              return (
                <button
                  key={profile.name}
                  type="button"
                  className={cn(
                    'grid min-h-[9.25rem] gap-3 rounded-[12px] border px-4 py-4 text-left transition-[border-color,background-color,box-shadow] duration-150',
                    isSelected
                      ? 'border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface))] shadow-[0_14px_28px_rgba(16,26,42,0.08)]'
                      : 'border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_84%,transparent_16%)]',
                  )}
                  onClick={() => setSelectedProfileName(profile.name)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <strong className="min-w-0 break-all pr-2 text-[1rem] leading-[1.35] text-[var(--text)]">
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

                  <div className="flex flex-wrap items-center gap-2.5 text-[0.82rem] text-[var(--text-soft)]">
                    <StatusBadge tone={getAwsProfileStatusTone(details, Boolean(detailError))}>
                      {getAwsProfileStatusLabel(details, Boolean(detailError))}
                    </StatusBadge>

                    <span className="rounded-full border border-[color-mix(in_srgb,var(--border)_78%,white_22%)] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.82rem] font-medium text-[var(--text-soft)]">
                      {detailError ? translate('awsProfiles.status.lookupFailed') : details?.configuredRegion ?? translate('awsProfiles.detail.noRegion')}
                    </span>
                  </div>

                  <div className="grid gap-1 pt-0.5">
                    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[var(--text-soft)]">
                      Account
                    </span>
                    <span className="break-all text-[0.9rem] font-medium text-[var(--text-soft)]">
                      {detailError ? translate('awsProfiles.status.lookupFailed') : details?.accountId ?? translate('awsProfiles.detail.accountAfterAuth')}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="grid content-start gap-4 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.3rem] shadow-[var(--shadow-soft)]">
          {!selectedProfileName ? (
            <EmptyState
              title={translate('awsProfiles.empty.noSelectionTitle')}
              description={translate('awsProfiles.empty.noSelectionDescription')}
            />
          ) : null}

          {selectedProfileName && !selectedDetails && !selectedDetailError ? (
            <NoticeCard tone="info">{translate('awsProfiles.loadingDetails')}</NoticeCard>
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
                  <p className="m-0 text-[0.9rem] text-[var(--text-soft)]">
                    {selectedDetails.isAuthenticated
                      ? translate('awsProfiles.detail.authOk')
                      : selectedDetails.errorMessage ?? translate('awsProfiles.detail.authNeeded')}
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    disabled={
                      isLoadingProfileList ||
                      isRefreshingProfileDetails ||
                      isSavingProfile ||
                      isSavingRegion ||
                      isRenaming ||
                      isDeleting ||
                      isLoggingIn
                    }
                    onClick={() => {
                      setRenameDraft(selectedDetails.profileName)
                      setRenameError(null)
                      setIsRenameOpen(true)
                    }}
                  >
                    {translate('awsProfiles.action.rename')}
                  </Button>

                  {canEditAwsProfileRegion(selectedDetails.kind) ? (
                    <Button
                      variant="secondary"
                      disabled={
                        isLoadingProfileList ||
                        isRefreshingProfileDetails ||
                        isSavingProfile ||
                        isSavingRegion ||
                        isRenaming ||
                        isDeleting ||
                        isLoggingIn
                      }
                      onClick={openRegionDialog}
                    >
                      {translate('awsProfiles.action.changeRegion')}
                    </Button>
                  ) : null}

                  {selectedDetails.kind === 'static' ? (
                    <Button
                      variant="secondary"
                      disabled={
                        isLoadingProfileList ||
                        isRefreshingProfileDetails ||
                        isSavingProfile ||
                        isSavingRegion ||
                        isRenaming ||
                        isDeleting ||
                        isLoggingIn
                      }
                      onClick={openEditDialog}
                    >
                      {translate('awsProfiles.action.edit')}
                    </Button>
                  ) : null}

                  {selectedDetails.kind === 'sso' ? (
                    <Button
                      variant="secondary"
                      disabled={
                        isLoadingProfileList ||
                        isRefreshingProfileDetails ||
                        isSavingProfile ||
                        isSavingRegion ||
                        isRenaming ||
                        isDeleting ||
                        isLoggingIn
                      }
                      onClick={() => {
                        void handleLogin()
                      }}
                    >
                      {translate(isLoggingIn ? 'awsProfiles.action.ssoLoggingIn' : 'awsProfiles.action.ssoLogin')}
                    </Button>
                  ) : null}

                  <Button
                    variant="danger"
                    disabled={
                      isLoadingProfileList ||
                      isRefreshingProfileDetails ||
                      isSavingProfile ||
                      isSavingRegion ||
                      isRenaming ||
                      isDeleting ||
                      isLoggingIn
                    }
                    onClick={() => {
                      setDeleteError(null)
                      setIsDeleteOpen(true)
                    }}
                  >
                    {translate('common.delete')}
                  </Button>
                </div>
              </div>

              {selectedDetails.missingTools && selectedDetails.missingTools.length > 0 ? (
                <NoticeCard tone="warning">
                  {translate('awsProfiles.detail.missingTools', { tools: selectedDetails.missingTools.join(', ') })}
                </NoticeCard>
              ) : null}

              {selectedHostReferences.length > 0 ? (
                <NoticeCard title={translate('awsProfiles.detail.hostReferences')} tone="warning">
                  {renderHostReferenceList(selectedHostReferences)}
                </NoticeCard>
              ) : null}

              {selectedDetails.referencedByProfileNames.length > 0 ? (
                <NoticeCard
                  title={translate('awsProfiles.detail.sourceProfileReferences')}
                  tone="warning"
                >
                  {renderReferenceList(selectedDetails.referencedByProfileNames)}
                </NoticeCard>
              ) : null}

              <dl className="grid gap-3 md:grid-cols-2">
                <ProfileField
                  label={translate('awsProfiles.detail.defaultRegion')}
                  value={selectedDetails.configuredRegion ?? null}
                />
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
                  value={selectedDetails.hasSessionToken ? translate('awsProfiles.detail.sessionTokenSet') : null}
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
                  {translate(profileFormMode === 'create' ? 'awsProfiles.form.createTitle' : 'awsProfiles.form.editTitle')}
                </strong>
                <span className="text-[0.9rem] text-[var(--text-soft)]">
                  {profileFormMode === 'create'
                    ? translate('awsProfiles.form.createDescription')
                    : translate('awsProfiles.form.editDescription')}
                </span>
              </div>
            </ModalHeader>
            <ModalBody>
              {profileFormMode === 'create' ? (
                <AwsProfileCreateWizard
                  testId="aws-profiles-create-form"
                  title={translate('awsProfiles.form.wizardTitle')}
                  showTitle={false}
                  descriptions={[
                    ...(awsProfilesServerSupport === 'unsupported'
                      ? [translate('awsProfiles.form.wizardSyncUnsupported')]
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
                  title={translate('awsProfiles.form.staticEditTitle')}
                  descriptions={[translate('awsProfiles.form.staticEditDescription')]}
                  draft={profileDraft}
                  error={profileFormError}
                  isSubmitting={isSavingProfile}
                  submitLabel={translate('awsProfiles.form.updateSubmit')}
                  submittingLabel={translate('awsProfiles.form.updateSubmitting')}
                  profileNameLabel={translate('awsProfiles.form.profileName')}
                  profileNameEditable={false}
                  accessKeyHelpText={
                    selectedDetails?.maskedAccessKeyId
                      ? translate('awsProfiles.form.currentAccessKey', { key: selectedDetails.maskedAccessKeyId })
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

      {isRegionOpen && selectedDetails ? (
        <DialogBackdrop onDismiss={() => setIsRegionOpen(false)}>
          <ModalShell size="md">
            <ModalHeader>
              <div className="grid gap-1">
                <strong>{translate('awsProfiles.region.title')}</strong>
                <span className="text-[0.9rem] text-[var(--text-soft)]">
                  {translate('awsProfiles.region.description')}
                </span>
              </div>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              <FieldGroup label={translate('awsProfiles.region.label')}>
                <SelectField
                  aria-label={translate('awsProfiles.region.label')}
                  value={regionDraft}
                  onChange={(event) => setRegionDraft(event.target.value)}
                  disabled={isSavingRegion}
                >
                  <option value="">{translate('awsProfiles.region.none')}</option>
                  {AWS_PROFILE_REGION_OPTIONS.map((region) => (
                    <option key={region} value={region}>
                      {region}
                    </option>
                  ))}
                </SelectField>
              </FieldGroup>

              {regionError ? (
                <NoticeCard tone="danger" role="alert">
                  {regionError}
                </NoticeCard>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button
                variant="secondary"
                disabled={isSavingRegion}
                onClick={() => setIsRegionOpen(false)}
              >
                {translate('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={isSavingRegion}
                onClick={() => {
                  void handleSaveRegion()
                }}
              >
                {translate(isSavingRegion ? 'awsProfiles.region.saving' : 'awsProfiles.region.save')}
              </Button>
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      {isRenameOpen && selectedDetails ? (
        <DialogBackdrop onDismiss={() => setIsRenameOpen(false)}>
          <ModalShell size="md">
            <ModalHeader>
              <div className="grid gap-1">
                <strong>{translate('awsProfiles.rename.title')}</strong>
                <span className="text-[0.9rem] text-[var(--text-soft)]">
                  {translate('awsProfiles.rename.description')}
                </span>
              </div>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              <FieldGroup label={translate('awsProfiles.rename.newNameLabel')}>
                <Input
                  aria-label={translate('awsProfiles.rename.newNameLabel')}
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  disabled={isRenaming}
                />
              </FieldGroup>

              {selectedHostReferences.length > 0 ? (
                <NoticeCard title={translate('awsProfiles.rename.warningTitle')} tone="warning">
                  {translate('awsProfiles.rename.warningBody')}
                  {renderHostReferenceList(selectedHostReferences)}
                </NoticeCard>
              ) : null}

              {selectedDetails.referencedByProfileNames.length > 0 ? (
                <NoticeCard title={translate('awsProfiles.rename.noteTitle')} tone="warning">
                  {translate('awsProfiles.rename.noteBody')}
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
                {translate('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={isRenaming}
                onClick={() => {
                  void handleRenameProfile()
                }}
              >
                {translate(isRenaming ? 'awsProfiles.rename.submitting' : 'awsProfiles.rename.submit')}
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
                <strong>{translate('awsProfiles.delete.title')}</strong>
                <span className="text-[0.9rem] text-[var(--text-soft)]">
                  {translate('awsProfiles.delete.description')}
                </span>
              </div>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              <NoticeCard title={selectedDetails.profileName} tone="warning">
                {translate('awsProfiles.delete.warning')}
              </NoticeCard>

              {selectedHostReferences.length > 0 ? (
                <NoticeCard title={translate('awsProfiles.delete.hostReferences')} tone="warning">
                  {renderHostReferenceList(selectedHostReferences)}
                </NoticeCard>
              ) : null}

              {selectedDetails.referencedByProfileNames.length > 0 ? (
                <NoticeCard
                  title={translate('awsProfiles.detail.sourceProfileReferences')}
                  tone="warning"
                >
                  {renderReferenceList(selectedDetails.referencedByProfileNames)}
                </NoticeCard>
              ) : null}

              {selectedDetails.orphanedSsoSessionName ? (
                <NoticeCard title={translate('awsProfiles.delete.ssoSessions')} tone="warning">
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
                {translate('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={isDeleting}
                onClick={() => {
                  void handleDeleteProfile()
                }}
              >
                {translate(isDeleting ? 'awsProfiles.delete.submitting' : 'awsProfiles.delete.submit')}
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
