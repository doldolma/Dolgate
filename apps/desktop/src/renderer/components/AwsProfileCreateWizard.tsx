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
import { useTranslation } from 'react-i18next';
import { t } from "../i18n";

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
    return t('awsWizard.error.roleArnRequired')
  }
  if (normalized.length < 20 || !normalized.startsWith('arn:')) {
    return t('awsWizard.error.roleArnInvalid')
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
  const { t: translate } = useTranslation();
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
      setError(normalizeErrorMessage(submitError, translate('awsWizard.error.createFailed')))
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
        setError(translate('awsWizard.error.ssoSelectionRequired'))
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
      setError(normalizeErrorMessage(submitError, translate('awsWizard.error.ssoCreateFailed')))
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
      setError(normalizeErrorMessage(submitError, translate('awsWizard.error.roleCreateFailed')))
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
            <div className="flex flex-wrap gap-[0.9rem] text-[0.9rem] text-[var(--text-soft)]">
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
          {/* AWS 용어는 sts:AssumeRole 이다. 그냥 "Role" 이면 아래 "SSO Role"(SSO 가
              발급하는 역할 이름)과 같은 것으로 읽힌다. */}
          Assume role
        </TabButton>
      </Tabs>

      {activeKind === 'static' ? (
        <AwsStaticProfileForm
          draft={staticDraft}
          error={error}
          isSubmitting={isSubmitting}
          submitLabel={translate('awsWizard.static.submit')}
          submittingLabel={translate('awsWizard.static.submitting')}
          profileNameLabel={translate('awsWizard.static.profileName')}
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
            <FieldGroup label={translate('awsWizard.field.newProfileName')}>
              <Input
                aria-label={translate('awsWizard.field.ssoProfileName')}
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

            <FieldGroup label={translate('awsWizard.field.defaultRegion')}>
              <SelectField
                aria-label={translate('awsWizard.field.ssoDefaultRegion')}
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
                <option value="">{translate('awsWizard.field.none')}</option>
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
                <option value="">{translate('awsWizard.field.ssoRegionSelect')}</option>
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
                {translate('awsWizard.sso.loggedIn')}
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
                    <option value="">{translate('awsWizard.field.accountSelect')}</option>
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
                    <option value="">{translate('awsWizard.field.roleSelect')}</option>
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
                {translate('awsWizard.sso.reenter')}
              </Button>
            ) : null}
            {onCancel ? (
              <Button variant="secondary" disabled={isSubmitting} onClick={onCancel}>
                {translate('common.cancel')}
              </Button>
            ) : null}
            <Button variant="primary" disabled={isSubmitting} type="submit">
              {isSubmitting
                ? ssoPreparation
                  ? translate('awsWizard.sso.saving')
                  : translate('awsWizard.sso.signingIn')
                : ssoPreparation
                  ? translate('awsWizard.sso.save')
                  : translate('awsWizard.sso.signInAndLoad')}
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
            <FieldGroup label={translate('awsWizard.field.newProfileName')}>
              <Input
                aria-label={translate('awsWizard.field.roleProfileName')}
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

            <FieldGroup label={translate('awsWizard.field.defaultRegion')}>
              <SelectField
                aria-label={translate('awsWizard.field.roleDefaultRegion')}
                value={roleDraft.region ?? ''}
                onChange={(event) =>
                  setRoleDraft({
                    ...roleDraft,
                    region: event.target.value || null,
                  })
                }
                disabled={isSubmitting}
              >
                <option value="">{translate('awsWizard.field.none')}</option>
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
                <option value="">{translate('awsWizard.field.sourceProfileSelect')}</option>
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
              {translate('awsWizard.role.sourceProfileRequired')}
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
                {translate('common.cancel')}
              </Button>
            ) : null}
            <Button variant="primary" disabled={isSubmitting || profiles.length === 0} type="submit">
              {translate(isSubmitting ? 'awsWizard.role.submitting' : 'awsWizard.role.submit')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
