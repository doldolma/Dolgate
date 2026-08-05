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
import { Trans, useTranslation } from 'react-i18next';

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
      // AWS 문서의 표현은 "assume role" 이다. 그냥 "Role" 로 두면 SSO 가 발급하는
      // 역할 이름(ssoRoleName, 아래 "SSO Role" 필드)과 같은 것으로 읽힌다.
      return 'Assume role'
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
  const { t: translate } = useTranslation();
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
          normalizeErrorMessage(loadError, translate('awsExternalImport.listFailed')),
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
              translate('awsExternalImport.detailsFailed'),
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
      return translate('awsExternalImport.noSelection')
    }
    return translate('awsExternalImport.selectedCount', { count: selectedProfileNames.length })
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
        normalizeErrorMessage(importError, translate('awsExternalImport.importFailed')),
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
            <h3 id="aws-external-profile-import-title">{translate('awsExternalImport.title')}</h3>
          </div>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          <div className="grid gap-1.5 text-[0.9rem] text-[var(--text-soft)]">
            <span>
              <Trans
                i18nKey="awsExternalImport.descriptionPath"
                components={{ code: <code /> }}
              />
            </span>
            <span>{translate('awsExternalImport.descriptionSso')}</span>
          </div>

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          <div className="grid min-h-0 gap-3 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between gap-3">
              <strong>{translate('awsExternalImport.externalProfiles')}</strong>
              <Badge tone="neutral">{selectedCountLabel}</Badge>
            </div>

            {isLoadingProfiles ? (
              <NoticeCard tone="info">{translate('awsExternalImport.loading')}</NoticeCard>
            ) : profiles.length === 0 ? (
              <EmptyState title={translate('awsExternalImport.empty')} />
            ) : (
              <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto pr-1">
                {profiles.map((profile) => {
                  const details = detailsByProfileName[profile.name]
                  const isSelected = selectedProfileNames.includes(profile.name)

                  return (
                    <label
                      key={profile.name}
                      className={`block w-full cursor-pointer rounded-[12px] border px-4 py-3 transition ${
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
                            <strong className="break-all text-[1rem] leading-[1.35] text-[var(--text)]">
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
                                {translate(details.isAuthenticated ? 'awsProfiles.status.authenticated' : 'awsProfiles.status.authRequired')}
                              </StatusBadge>
                              {details.configuredRegion ? (
                                <span>{details.configuredRegion}</span>
                              ) : null}
                              {details.accountId ? <span>{details.accountId}</span> : null}
                            </div>
                          ) : isLoadingDetails ? (
                            <span className="text-sm text-[var(--text-soft)]">
                              {translate('awsExternalImport.detailsLoading')}
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
            {translate('common.close')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void handleImport()
            }}
            disabled={isImporting || selectedProfileNames.length === 0}
          >
            {isImporting ? translate('awsExternalImport.importing') : translate('awsExternalImport.import')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  )
}
