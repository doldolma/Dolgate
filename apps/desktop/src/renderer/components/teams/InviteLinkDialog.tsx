import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamInviteCreated } from '@shared';
import { cn } from '../../lib/cn';
import { Button, Input, Tooltip } from '../../ui';
import { Check, Copy, Info } from '../../ui/icons';
import { copyText } from './copy-text';
import { TeamDialogError, TeamDialogFrame } from './TeamDialogFrame';
import { useDialogAction } from './useDialogAction';

/** 고를 수 있는 기한(시간). 처음은 7일. */
const EXPIRY_CHOICES = [
  { hours: 1, labelKey: 'teamsPanel.invite.duration.hour1' },
  { hours: 24, labelKey: 'teamsPanel.invite.duration.day1' },
  { hours: 7 * 24, labelKey: 'teamsPanel.invite.duration.day7' },
  { hours: 30 * 24, labelKey: 'teamsPanel.invite.duration.day30' },
] as const;
const DEFAULT_EXPIRY_HOURS = 7 * 24;

// 호스트 종류 고르기와 같은 모양의 칸 나눔(네모).
const SEGMENT_TRACK_CLASS =
  'grid auto-cols-fr grid-flow-col gap-[0.15rem] rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] p-[0.2rem]';
const SEGMENT_CLASS =
  'rounded-[7px] border py-[0.5rem] text-[0.85rem] font-semibold transition-[background-color,border-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]';

// FieldGroup 의 칸 이름과 같은 모양.
const FIELD_LABEL_CLASS = 'text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]';

interface InviteLinkDialogProps {
  teamName: string;
  onCreate: (expiresInHours: number) => Promise<TeamInviteCreated>;
  onClose: () => void;
}

/**
 * 초대 링크 만들기 — 기한만 고르고, 만들면서 바로 복사한다.
 *
 * 만든 뒤에도 링크를 창에 두고 `다시 복사` 를 준다(첫 복사가 실패했을 때). 창을 닫은 뒤에는 링크 목록에서
 * 다시 복사한다.
 */
export function InviteLinkDialog({ teamName, onCreate, onClose }: InviteLinkDialogProps) {
  const { t: translate } = useTranslation();
  const { busy, error, run } = useDialogAction();
  const [hours, setHours] = useState<number>(DEFAULT_EXPIRY_HOURS);
  const [created, setCreated] = useState<{ link: string; copied: boolean } | null>(null);
  const durationLabel = translate(
    EXPIRY_CHOICES.find((choice) => choice.hours === hours)?.labelKey ?? 'teamsPanel.invite.duration.day7',
  );

  const create = () =>
    void run(async () => {
      const invite = await onCreate(hours);
      setCreated({ link: invite.link, copied: await copyText(invite.link) });
    });

  return (
    <TeamDialogFrame
      section="Invite"
      title={translate('teamsPanel.invite.title', { team: teamName })}
      busy={busy}
      onClose={onClose}
      footer={
        created ? (
          <Button variant="primary" onClick={onClose}>
            {translate('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {translate('common.cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={create}>
              <Copy className="h-4 w-4" aria-hidden="true" />
              {translate('teamsPanel.invite.createAndCopy')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <>
          {created.copied ? (
            <p className="m-0 flex items-start gap-2 text-sm leading-6 text-[var(--text)]">
              <Check className="mt-[0.3rem] h-4 w-4 shrink-0 text-[var(--success-text)]" aria-hidden="true" />
              <span>{translate('teamsPanel.invite.copied', { duration: durationLabel })}</span>
            </p>
          ) : (
            <p role="alert" className="m-0 text-sm leading-6 text-[var(--warning-text)]">
              {translate('teamsPanel.invite.copyFailed')}
            </p>
          )}
          <div className="grid gap-[0.55rem]">
            <span className={cn(FIELD_LABEL_CLASS, 'flex items-center gap-1.5')}>
              Link
              <Tooltip label={translate('teamsPanel.invite.recopyHint')}>
                <Info className="h-3.5 w-3.5" aria-label={translate('teamsPanel.invite.recopyHint')} />
              </Tooltip>
            </span>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Invite link"
                readOnly
                spellCheck={false}
                value={created.link}
                className="min-w-0 flex-1 font-mono text-[0.82rem]"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                variant="secondary"
                className="shrink-0"
                onClick={() => {
                  void copyText(created.link).then((copied) => setCreated({ ...created, copied }));
                }}
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                {translate('teamsPanel.invite.copyAgain')}
              </Button>
            </div>
          </div>
        </>
      ) : (
        // 단추 여럿을 담으므로 <label>(FieldGroup) 대신 같은 모양의 머리를 쓴다 — label 은 누르면 첫 단추를 누른다.
        <div className="grid gap-[0.55rem]">
          <span className={FIELD_LABEL_CLASS}>Expires</span>
          <div role="radiogroup" aria-label="Expires" className={SEGMENT_TRACK_CLASS}>
            {EXPIRY_CHOICES.map((choice) => {
              const selected = choice.hours === hours;
              return (
                <button
                  key={choice.hours}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  className={cn(
                    SEGMENT_CLASS,
                    selected
                      ? 'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]'
                      : 'border-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_70%,transparent_30%)] hover:text-[var(--text)]',
                  )}
                  onClick={() => setHours(choice.hours)}
                >
                  {translate(choice.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}
