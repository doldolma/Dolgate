import { AWS_PROFILE_REGION_OPTIONS, type AwsStaticProfileDraft } from '@shared'
import {
  Button,
  FieldGroup,
  Input,
  NoticeCard,
  SelectField,
} from '../ui'
import { useTranslation } from 'react-i18next';
import { MyKeyField } from './teams/MyKeyField'

interface AwsStaticProfileFormProps {
  title?: string
  descriptions?: string[]
  draft: AwsStaticProfileDraft
  error?: string | null
  isSubmitting: boolean
  submitLabel: string
  submittingLabel?: string
  profileNameLabel?: string
  profileNameEditable?: boolean
  testId?: string
  accessKeyHelpText?: string | null
  /** 팀 프로필이면 키는 내 칸에만 간다 — 칸 이름이 그것을 말한다(K1). */
  myKeys?: boolean
  onChange: (draft: AwsStaticProfileDraft) => void
  onCancel?: () => void
  onSubmit: () => void
}

export function AwsStaticProfileForm({
  title,
  descriptions = [],
  draft,
  error = null,
  isSubmitting,
  submitLabel,
  submittingLabel,
  profileNameLabel,
  profileNameEditable = true,
  testId,
  accessKeyHelpText = null,
  myKeys = false,
  onChange,
  onCancel,
  onSubmit,
}: AwsStaticProfileFormProps) {
  const { t: translate } = useTranslation();
  const accessKeyLabel = myKeys ? 'My Access Key' : 'Access Key'
  const secretLabel = myKeys ? 'My Secret' : 'Secret'
  const accessKeyInput = (
    <div className="grid gap-2">
      <Input
        aria-label={accessKeyLabel}
        value={draft.accessKeyId}
        onChange={(event) =>
          onChange({
            ...draft,
            accessKeyId: event.target.value,
          })
        }
        placeholder="AKIA..."
        disabled={isSubmitting}
      />
      {accessKeyHelpText ? (
        <p className="m-0 text-[0.82rem] text-[var(--text-soft)]">
          {accessKeyHelpText}
        </p>
      ) : null}
    </div>
  )
  return (
    <form
      data-testid={testId}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {title || descriptions.length > 0 ? (
        <div className="grid gap-1.5">
          {title ? <strong>{title}</strong> : null}
          {descriptions.length > 0 ? (
            <div className="flex flex-wrap gap-[0.9rem] text-[0.9rem] text-[var(--text-soft)]">
              {descriptions.map((description) => (
                <span key={description}>{description}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <FieldGroup label={profileNameLabel ?? translate('staticProfile.profileNameLabel')}>
          <Input
            aria-label={profileNameLabel ?? translate('staticProfile.profileNameLabel')}
            value={draft.profileName}
            onChange={(event) =>
              onChange({
                ...draft,
                profileName: event.target.value,
              })
            }
            placeholder="dolssh-prod"
            disabled={isSubmitting || !profileNameEditable}
            readOnly={!profileNameEditable}
          />
        </FieldGroup>

        <FieldGroup label={translate('staticProfile.defaultRegion')}>
          <SelectField
            aria-label={translate('staticProfile.defaultRegion')}
            value={draft.region ?? ''}
            onChange={(event) =>
              onChange({
                ...draft,
                region: event.target.value || null,
              })
            }
            disabled={isSubmitting}
          >
            <option value="">{translate('staticProfile.none')}</option>
            {AWS_PROFILE_REGION_OPTIONS.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </SelectField>
        </FieldGroup>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {myKeys ? (
          // 팀 프로필의 키 칸(K1) — ⓘ 가 이름표 밖에 있어야 이름이 입력 칸을 가리킨다.
          <MyKeyField label={accessKeyLabel} hint={translate('teams.myKey.awsHint')}>
            {accessKeyInput}
          </MyKeyField>
        ) : (
          <FieldGroup label={accessKeyLabel}>{accessKeyInput}</FieldGroup>
        )}

        <FieldGroup label={secretLabel}>
          <Input
            aria-label={secretLabel}
            type="password"
            value={draft.secretAccessKey}
            onChange={(event) =>
              onChange({
                ...draft,
                secretAccessKey: event.target.value,
              })
            }
            placeholder="AWS secret access key"
            disabled={isSubmitting}
          />
        </FieldGroup>
      </div>

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
        <Button variant="primary" disabled={isSubmitting} type="submit">
          {isSubmitting ? submittingLabel ?? submitLabel : submitLabel}
        </Button>
      </div>
    </form>
  )
}
