import { AWS_PROFILE_REGION_OPTIONS, type AwsStaticProfileDraft } from '@shared'
import {
  Button,
  FieldGroup,
  Input,
  NoticeCard,
  SelectField,
} from '../ui'

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
  profileNameLabel = '프로필명',
  profileNameEditable = true,
  testId,
  accessKeyHelpText = null,
  onChange,
  onCancel,
  onSubmit,
}: AwsStaticProfileFormProps) {
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
            <div className="flex flex-wrap gap-[0.8rem] text-[0.92rem] text-[var(--text-soft)]">
              {descriptions.map((description) => (
                <span key={description}>{description}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <FieldGroup label={profileNameLabel}>
          <Input
            aria-label={profileNameLabel}
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

        <FieldGroup label="기본 Region">
          <SelectField
            aria-label="기본 Region"
            value={draft.region ?? ''}
            onChange={(event) =>
              onChange({
                ...draft,
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
        <FieldGroup label="Access Key">
          <div className="grid gap-2">
            <Input
              aria-label="Access Key"
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
              <p className="m-0 text-[0.8rem] text-[var(--text-soft)]">
                {accessKeyHelpText}
              </p>
            ) : null}
          </div>
        </FieldGroup>

        <FieldGroup label="Secret">
          <Input
            aria-label="Secret"
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
            취소
          </Button>
        ) : null}
        <Button variant="primary" disabled={isSubmitting} type="submit">
          {isSubmitting ? submittingLabel ?? submitLabel : submitLabel}
        </Button>
      </div>
    </form>
  )
}
