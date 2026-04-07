import {
  AWS_PROFILE_REGION_OPTIONS,
  type AwsProfileCreateInput,
  type AwsProfileSummary,
  type AwsRoleProfileCreateInput,
  type AwsSsoProfilePrepareInput,
  type AwsSsoProfilePrepareResult,
  type AwsStaticProfileDraft,
} from '@shared'
import { useEffect, useMemo, useState } from 'react'
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts'
import { AwsStaticProfileForm } from './AwsStaticProfileForm'
import {
  Button,
  FieldGroup,
  Input,
  NoticeCard,
  SelectField,
  TabButton,
  Tabs,
} from '../ui'

type AwsProfileCreateKind = 'static' | 'sso' | 'role'

interface AwsProfileCreateWizardProps {
  profiles: AwsProfileSummary[]
  title: string
  showTitle?: boolean
  descriptions?: string[]
  testId?: string
  onCancel?: () => void
  onSuccess?: (profileName: string) => void | Promise<void>
  createProfile: (input: AwsProfileCreateInput) => Promise<void>
  prepareSsoProfile: (
    input: AwsSsoProfilePrepareInput,
  ) => Promise<AwsSsoProfilePrepareResult>
}

function createEmptyStaticDraft(): AwsStaticProfileDraft {
  return {
    profileName: '',
    accessKeyId: '',
    secretAccessKey: '',
    region: null,
  }
}

function createEmptySsoDraft(): AwsSsoProfilePrepareInput {
  return {
    profileName: '',
    ssoStartUrl: '',
    ssoRegion: '',
    region: null,
  }
}

function createEmptyRoleDraft(): Omit<AwsRoleProfileCreateInput, 'kind'> {
  return {
    profileName: '',
    sourceProfileName: '',
    roleArn: '',
    region: null,
  }
}

function getSsoRoleOptions(
  preparation: AwsSsoProfilePrepareResult | null,
  accountId: string,
) {
  if (!preparation) {
    return []
  }
  return preparation.rolesByAccountId[accountId] ?? []
}

function validateRoleArnInput(roleArn: string): string | null {
  const normalized = roleArn.trim()
  if (!normalized) {
    return 'Role ARN을 입력해 주세요.'
  }
  if (normalized.length < 20 || !normalized.startsWith('arn:')) {
    return '입력한 Role ARN이 올바르지 않습니다. Role ARN 형식을 다시 확인해 주세요.'
  }
  return null
}

export function AwsProfileCreateWizard({
  profiles,
  title,
  showTitle = true,
  descriptions = [],
  testId,
  onCancel,
  onSuccess,
  createProfile,
  prepareSsoProfile,
}: AwsProfileCreateWizardProps) {
  const [activeKind, setActiveKind] = useState<AwsProfileCreateKind>('static')
  const [staticDraft, setStaticDraft] = useState<AwsStaticProfileDraft>(
    createEmptyStaticDraft(),
  )
  const [ssoDraft, setSsoDraft] = useState<AwsSsoProfilePrepareInput>(
    createEmptySsoDraft(),
  )
  const [roleDraft, setRoleDraft] = useState<Omit<AwsRoleProfileCreateInput, 'kind'>>(
    createEmptyRoleDraft(),
  )
  const [ssoPreparation, setSsoPreparation] =
    useState<AwsSsoProfilePrepareResult | null>(null)
  const [selectedSsoAccountId, setSelectedSsoAccountId] = useState('')
  const [selectedSsoRoleName, setSelectedSsoRoleName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const ssoRoleOptions = useMemo(
    () => getSsoRoleOptions(ssoPreparation, selectedSsoAccountId),
    [selectedSsoAccountId, ssoPreparation],
  )

  useEffect(() => {
    if (!ssoPreparation) {
      setSelectedSsoAccountId('')
      setSelectedSsoRoleName('')
      return
    }

    const nextAccountId =
      selectedSsoAccountId && ssoPreparation.accounts.some(
        (account) => account.accountId === selectedSsoAccountId,
      )
        ? selectedSsoAccountId
        : ssoPreparation.defaultAccountId ?? ssoPreparation.accounts[0]?.accountId ?? ''
    const nextRoleName =
      getSsoRoleOptions(ssoPreparation, nextAccountId).find(
        (role) => role.roleName === selectedSsoRoleName,
      )?.roleName ??
      ssoPreparation.defaultRoleName ??
      getSsoRoleOptions(ssoPreparation, nextAccountId)[0]?.roleName ??
      ''

    if (nextAccountId !== selectedSsoAccountId) {
      setSelectedSsoAccountId(nextAccountId)
    }
    if (nextRoleName !== selectedSsoRoleName) {
      setSelectedSsoRoleName(nextRoleName)
    }
  }, [selectedSsoAccountId, selectedSsoRoleName, ssoPreparation])

  function resetSsoPreparation() {
    setSsoPreparation(null)
    setSelectedSsoAccountId('')
    setSelectedSsoRoleName('')
  }

  function handleKindChange(nextKind: AwsProfileCreateKind) {
    setActiveKind(nextKind)
    setError(null)
    if (nextKind !== 'sso') {
      resetSsoPreparation()
    }
  }

  async function handleStaticSubmit() {
    setIsSubmitting(true)
    setError(null)
    try {
      await createProfile({
        kind: 'static',
        profileName: staticDraft.profileName,
        accessKeyId: staticDraft.accessKeyId,
        secretAccessKey: staticDraft.secretAccessKey,
        region: staticDraft.region ?? null,
      })
      await onSuccess?.(staticDraft.profileName)
    } catch (submitError) {
      setError(normalizeErrorMessage(submitError, 'AWS 프로필을 생성하지 못했습니다.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleSsoSubmit() {
    setIsSubmitting(true)
    setError(null)
    try {
      if (!ssoPreparation) {
        const preparation = await prepareSsoProfile(ssoDraft)
        setSsoPreparation(preparation)
        return
      }

      if (!selectedSsoAccountId || !selectedSsoRoleName) {
        setError('SSO 계정과 Role을 모두 선택해 주세요.')
        return
      }

      await createProfile({
        kind: 'sso',
        profileName: ssoPreparation.profileName,
        ssoStartUrl: ssoPreparation.ssoStartUrl,
        ssoRegion: ssoPreparation.ssoRegion,
        region: ssoPreparation.region ?? null,
        preparationToken: ssoPreparation.preparationToken,
        ssoSessionName: ssoPreparation.ssoSessionName,
        ssoAccountId: selectedSsoAccountId,
        ssoRoleName: selectedSsoRoleName,
      })
      await onSuccess?.(ssoPreparation.profileName)
    } catch (submitError) {
      setError(normalizeErrorMessage(submitError, 'AWS SSO 프로필을 생성하지 못했습니다.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRoleSubmit() {
    setIsSubmitting(true)
    setError(null)
    try {
      const roleArnError = validateRoleArnInput(roleDraft.roleArn)
      if (roleArnError) {
        setError(roleArnError)
        return
      }

      await createProfile({
        kind: 'role',
        profileName: roleDraft.profileName,
        sourceProfileName: roleDraft.sourceProfileName,
        roleArn: roleDraft.roleArn,
        region: roleDraft.region ?? null,
      })
      await onSuccess?.(roleDraft.profileName)
    } catch (submitError) {
      setError(normalizeErrorMessage(submitError, 'Role profile을 생성하지 못했습니다.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div data-testid={testId} className="grid gap-4">
      {showTitle || descriptions.length > 0 ? (
        <div className="grid gap-1.5">
          {showTitle ? <strong>{title}</strong> : null}
          {descriptions.length > 0 ? (
            <div className="flex flex-wrap gap-[0.8rem] text-[0.92rem] text-[var(--text-soft)]">
              {descriptions.map((description) => (
                <span key={description}>{description}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Tabs aria-label="AWS profile type">
        <TabButton
          active={activeKind === 'static'}
          disabled={isSubmitting}
          onClick={() => handleKindChange('static')}
        >
          Static
        </TabButton>
        <TabButton
          active={activeKind === 'sso'}
          disabled={isSubmitting}
          onClick={() => handleKindChange('sso')}
        >
          SSO
        </TabButton>
        <TabButton
          active={activeKind === 'role'}
          disabled={isSubmitting}
          onClick={() => handleKindChange('role')}
        >
          Role
        </TabButton>
      </Tabs>

      {activeKind === 'static' ? (
        <AwsStaticProfileForm
          draft={staticDraft}
          error={error}
          isSubmitting={isSubmitting}
          submitLabel="프로필 저장"
          submittingLabel="생성 중..."
          profileNameLabel="새 프로필명"
          onChange={setStaticDraft}
          onCancel={onCancel}
          onSubmit={() => {
            void handleStaticSubmit()
          }}
        />
      ) : null}

      {activeKind === 'sso' ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSsoSubmit()
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <FieldGroup label="새 프로필명">
              <Input
                aria-label="SSO 프로필명"
                value={ssoDraft.profileName}
                onChange={(event) => {
                  resetSsoPreparation()
                  setSsoDraft({
                    ...ssoDraft,
                    profileName: event.target.value,
                  })
                }}
                disabled={isSubmitting || Boolean(ssoPreparation)}
                placeholder="corp-sso"
              />
            </FieldGroup>

            <FieldGroup label="기본 Region">
              <SelectField
                aria-label="SSO 기본 Region"
                value={ssoDraft.region ?? ''}
                onChange={(event) => {
                  resetSsoPreparation()
                  setSsoDraft({
                    ...ssoDraft,
                    region: event.target.value || null,
                  })
                }}
                disabled={isSubmitting || Boolean(ssoPreparation)}
              >
                <option value="">선택 안 함</option>
                {AWS_PROFILE_REGION_OPTIONS.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </SelectField>
            </FieldGroup>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FieldGroup label="SSO Start URL">
              <Input
                aria-label="SSO Start URL"
                value={ssoDraft.ssoStartUrl}
                onChange={(event) => {
                  resetSsoPreparation()
                  setSsoDraft({
                    ...ssoDraft,
                    ssoStartUrl: event.target.value,
                  })
                }}
                disabled={isSubmitting || Boolean(ssoPreparation)}
                placeholder="https://example.awsapps.com/start"
              />
            </FieldGroup>

            <FieldGroup label="SSO Region">
              <SelectField
                aria-label="SSO Region"
                value={ssoDraft.ssoRegion}
                onChange={(event) => {
                  resetSsoPreparation()
                  setSsoDraft({
                    ...ssoDraft,
                    ssoRegion: event.target.value,
                  })
                }}
                disabled={isSubmitting || Boolean(ssoPreparation)}
              >
                <option value="">SSO Region 선택</option>
                {AWS_PROFILE_REGION_OPTIONS.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </SelectField>
            </FieldGroup>
          </div>

          {ssoPreparation ? (
            <>
              <NoticeCard tone="info">
                SSO 로그인에 성공했습니다. 사용할 account와 role을 선택한 뒤 저장하세요.
              </NoticeCard>

              <div className="grid gap-4 md:grid-cols-2">
                <FieldGroup label="SSO Account">
                  <SelectField
                    aria-label="SSO Account"
                    value={selectedSsoAccountId}
                    onChange={(event) => {
                      const nextAccountId = event.target.value
                      setSelectedSsoAccountId(nextAccountId)
                      setSelectedSsoRoleName(
                        getSsoRoleOptions(ssoPreparation, nextAccountId)[0]?.roleName ?? '',
                      )
                    }}
                    disabled={isSubmitting}
                  >
                    <option value="">계정 선택</option>
                    {ssoPreparation.accounts.map((account) => (
                      <option key={account.accountId} value={account.accountId}>
                        {account.accountName} ({account.accountId})
                      </option>
                    ))}
                  </SelectField>
                </FieldGroup>

                <FieldGroup label="SSO Role">
                  <SelectField
                    aria-label="SSO Role"
                    value={selectedSsoRoleName}
                    onChange={(event) => setSelectedSsoRoleName(event.target.value)}
                    disabled={isSubmitting || !selectedSsoAccountId}
                  >
                    <option value="">Role 선택</option>
                    {ssoRoleOptions.map((role) => (
                      <option key={role.roleName} value={role.roleName}>
                        {role.roleName}
                      </option>
                    ))}
                  </SelectField>
                </FieldGroup>
              </div>
            </>
          ) : null}

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {ssoPreparation ? (
              <Button
                variant="secondary"
                disabled={isSubmitting}
                onClick={() => {
                  resetSsoPreparation()
                }}
              >
                다시 입력
              </Button>
            ) : null}
            {onCancel ? (
              <Button variant="secondary" disabled={isSubmitting} onClick={onCancel}>
                취소
              </Button>
            ) : null}
            <Button variant="primary" disabled={isSubmitting} type="submit">
              {isSubmitting
                ? ssoPreparation
                  ? '저장 중...'
                  : '로그인 중...'
                : ssoPreparation
                  ? '프로필 저장'
                  : '로그인 후 계정 불러오기'}
            </Button>
          </div>
        </form>
      ) : null}

      {activeKind === 'role' ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleRoleSubmit()
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <FieldGroup label="새 프로필명">
              <Input
                aria-label="Role 프로필명"
                value={roleDraft.profileName}
                onChange={(event) =>
                  setRoleDraft({
                    ...roleDraft,
                    profileName: event.target.value,
                  })
                }
                disabled={isSubmitting}
                placeholder="prod-admin"
              />
            </FieldGroup>

            <FieldGroup label="기본 Region">
              <SelectField
                aria-label="Role 기본 Region"
                value={roleDraft.region ?? ''}
                onChange={(event) =>
                  setRoleDraft({
                    ...roleDraft,
                    region: event.target.value || null,
                  })
                }
                disabled={isSubmitting}
              >
                <option value="">선택 안 함</option>
                {AWS_PROFILE_REGION_OPTIONS.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </SelectField>
            </FieldGroup>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FieldGroup label="source profile">
              <SelectField
                aria-label="source profile"
                value={roleDraft.sourceProfileName}
                onChange={(event) =>
                  setRoleDraft({
                    ...roleDraft,
                    sourceProfileName: event.target.value,
                  })
                }
                disabled={isSubmitting}
              >
                <option value="">source profile 선택</option>
                {profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.name}
                  </option>
                ))}
              </SelectField>
            </FieldGroup>

            <FieldGroup label="Role ARN">
              <Input
                aria-label="Role ARN"
                value={roleDraft.roleArn}
                onChange={(event) =>
                  setRoleDraft({
                    ...roleDraft,
                    roleArn: event.target.value,
                  })
                }
                disabled={isSubmitting}
                placeholder="arn:aws:iam::123456789012:role/Admin"
              />
            </FieldGroup>
          </div>

          {profiles.length === 0 ? (
            <NoticeCard tone="warning">
              Role profile 생성에는 먼저 사용할 source profile이 필요합니다.
            </NoticeCard>
          ) : null}

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {onCancel ? (
              <Button variant="secondary" disabled={isSubmitting} onClick={onCancel}>
                취소
              </Button>
            ) : null}
            <Button variant="primary" disabled={isSubmitting || profiles.length === 0} type="submit">
              {isSubmitting ? '생성 중...' : '프로필 저장'}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
