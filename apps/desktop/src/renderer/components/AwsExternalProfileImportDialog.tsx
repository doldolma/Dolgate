import { useEffect, useMemo, useState } from 'react'
import type {
  AwsExternalProfileImportResult,
  AwsProfileDetails,
  AwsProfileSummary,
} from '@shared'
import { DialogBackdrop } from './DialogBackdrop'
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts'
import {
  Badge,
  Button,
  EmptyState,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  StatusBadge,
} from '../ui'

interface AwsExternalProfileImportDialogProps {
  open: boolean
  onClose: () => void
  onImported?: (result: AwsExternalProfileImportResult) => void | Promise<void>
  listExternalProfiles: () => Promise<AwsProfileSummary[]>
  getExternalProfileDetails: (profileName: string) => Promise<AwsProfileDetails>
  importExternalProfiles: (input: {
    profileNames: string[]
  }) => Promise<AwsExternalProfileImportResult>
}

function formatKindLabel(kind: AwsProfileDetails['kind']): string {
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

export function AwsExternalProfileImportDialog({
  open,
  onClose,
  onImported,
  listExternalProfiles,
  getExternalProfileDetails,
  importExternalProfiles,
}: AwsExternalProfileImportDialogProps) {
  const [profiles, setProfiles] = useState<AwsProfileSummary[]>([])
  const [selectedProfileNames, setSelectedProfileNames] = useState<string[]>([])
  const [detailsByProfileName, setDetailsByProfileName] = useState<
    Record<string, AwsProfileDetails>
  >({})
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false)
  const [isLoadingDetails, setIsLoadingDetails] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setProfiles([])
    setSelectedProfileNames([])
    setDetailsByProfileName({})
    setError(null)
    setIsLoadingProfiles(true)

    void listExternalProfiles()
      .then((items) => {
        setProfiles(items)
        setSelectedProfileNames(items[0]?.name ? [items[0].name] : [])
      })
      .catch((loadError) => {
        setError(
          normalizeErrorMessage(loadError, '로컬 AWS CLI 프로필 목록을 불러오지 못했습니다.'),
        )
      })
      .finally(() => {
        setIsLoadingProfiles(false)
      })
  }, [listExternalProfiles, open])

  useEffect(() => {
    if (!open || profiles.length === 0) {
      return
    }

    let cancelled = false
    setIsLoadingDetails(true)
    const missingProfileNames = profiles
      .map((profile) => profile.name)
      .filter((profileName) => !detailsByProfileName[profileName])

    if (missingProfileNames.length === 0) {
      setIsLoadingDetails(false)
      return
    }

    void Promise.allSettled(
      missingProfileNames.map(async (profileName) => ({
        profileName,
        details: await getExternalProfileDetails(profileName),
      })),
    )
      .then((results) => {
        if (cancelled) {
          return
        }

        const nextDetails: Record<string, AwsProfileDetails> = {}
        let firstErrorMessage: string | null = null

        for (const result of results) {
          if (result.status === 'fulfilled') {
            nextDetails[result.value.profileName] = result.value.details
            continue
          }

          if (!firstErrorMessage) {
            firstErrorMessage = normalizeErrorMessage(
              result.reason,
              '외부 AWS 프로필 정보를 불러오지 못했습니다.',
            )
          }
        }

        if (Object.keys(nextDetails).length > 0) {
          setDetailsByProfileName((current) => ({
            ...current,
            ...nextDetails,
          }))
        }
        if (firstErrorMessage) {
          setError(firstErrorMessage)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingDetails(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [detailsByProfileName, getExternalProfileDetails, open, profiles])

  const selectedCountLabel = useMemo(() => {
    if (selectedProfileNames.length === 0) {
      return '선택한 프로필 없음'
    }
    return `${selectedProfileNames.length}개 선택됨`
  }, [selectedProfileNames.length])

  function toggleProfileSelection(profileName: string) {
    setSelectedProfileNames((current) => {
      if (current.includes(profileName)) {
        return current.filter((item) => item !== profileName)
      }
      return [...current, profileName]
    })
  }

  async function handleImport() {
    setIsImporting(true)
    setError(null)
    try {
      const result = await importExternalProfiles({
        profileNames: selectedProfileNames,
      })
      await onImported?.(result)
      onClose()
    } catch (importError) {
      setError(
        normalizeErrorMessage(importError, '외부 AWS 프로필을 가져오지 못했습니다.'),
      )
    } finally {
      setIsImporting(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <DialogBackdrop onDismiss={onClose} dismissDisabled={isImporting}>
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-labelledby="aws-external-profile-import-title"
        size="lg"
      >
        <ModalHeader>
          <div>
            <SectionLabel>AWS</SectionLabel>
            <h3 id="aws-external-profile-import-title">로컬 AWS CLI에서 가져오기</h3>
          </div>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          <div className="grid gap-1.5 text-[0.95rem] text-[var(--text-soft)]">
            <span>현재 PC의 <code>~/.aws</code> 설정에서 프로필을 읽어 앱 전용 프로필로 복사합니다.</span>
            <span>SSO 프로필은 설정만 가져오며 로그인 상태와 캐시는 가져오지 않습니다.</span>
          </div>

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          <div className="grid min-h-0 gap-3 rounded-[24px] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between gap-3">
              <strong>외부 프로필</strong>
              <Badge tone="neutral">{selectedCountLabel}</Badge>
            </div>

            {isLoadingProfiles ? (
              <NoticeCard tone="info">로컬 AWS CLI 프로필을 읽는 중입니다.</NoticeCard>
            ) : profiles.length === 0 ? (
              <EmptyState title="가져올 수 있는 로컬 AWS CLI 프로필이 없습니다." />
            ) : (
              <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto pr-1">
                {profiles.map((profile) => {
                  const details = detailsByProfileName[profile.name]
                  const isSelected = selectedProfileNames.includes(profile.name)

                  return (
                    <label
                      key={profile.name}
                      className={`block w-full cursor-pointer rounded-[18px] border px-4 py-3 transition ${
                        isSelected
                          ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent-soft)_78%,white_22%)]'
                          : 'border-[var(--border)] bg-[var(--surface-muted)] hover:border-[var(--accent)]'
                      }`}
                    >
                      <div className="flex w-full items-start gap-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleProfileSelection(profile.name)}
                          className="mt-1 h-4 w-4 shrink-0 cursor-pointer border-0 bg-transparent p-0 shadow-none accent-[var(--accent-strong)]"
                        />

                        <div className="grid min-w-0 flex-1 gap-2">
                          <div className="flex items-start justify-between gap-3">
                            <strong className="break-all text-[0.98rem] leading-[1.35] text-[var(--text)]">
                              {profile.name}
                            </strong>
                            {details ? (
                              <Badge
                                tone={
                                  details.kind === 'sso'
                                    ? 'starting'
                                    : details.kind === 'static'
                                      ? 'running'
                                      : 'neutral'
                                }
                              >
                                {formatKindLabel(details.kind)}
                              </Badge>
                            ) : null}
                          </div>

                          {details ? (
                            <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-soft)]">
                              <StatusBadge tone={details.isAuthenticated ? 'running' : 'error'}>
                                {details.isAuthenticated ? '인증됨' : '인증 필요'}
                              </StatusBadge>
                              {details.configuredRegion ? (
                                <span>{details.configuredRegion}</span>
                              ) : null}
                              {details.accountId ? <span>{details.accountId}</span> : null}
                            </div>
                          ) : isLoadingDetails ? (
                            <span className="text-sm text-[var(--text-soft)]">
                              프로필 정보를 불러오는 중입니다.
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isImporting}>
            닫기
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void handleImport()
            }}
            disabled={isImporting || selectedProfileNames.length === 0}
          >
            {isImporting ? '가져오는 중..' : '선택한 프로필 가져오기'}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  )
}
