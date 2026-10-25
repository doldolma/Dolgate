import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamMember } from '@shared';
import { Button, FieldGroup, Input } from '../../ui';
import { Check, Link } from '../../ui/icons';
import { TeamDialogError, TeamDialogFrame } from './TeamDialogFrame';
import { useDialogAction } from './useDialogAction';

// 서버가 받는 팀 이름 길이(sync-api teamNameMaxRunes).
const TEAM_NAME_MAX_LENGTH = 100;

interface TeamNameDialogProps {
  mode: 'create' | 'rename';
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/** 새 팀 만들기와 이름 변경. */
export function TeamNameDialog({ mode, initialName = '', onSubmit, onClose }: TeamNameDialogProps) {
  const { t: translate } = useTranslation();
  const formId = useId();
  const [name, setName] = useState(initialName);
  const { busy, error, run } = useDialogAction();
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && (mode === 'create' || trimmed !== initialName.trim()) && !busy;

  return (
    <TeamDialogFrame
      section="Team"
      title={mode === 'create' ? translate('teamsPanel.newTeam') : translate('common.rename')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={!canSubmit}>
            {mode === 'create' ? translate('teamsPanel.nameDialog.create') : translate('common.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            void run(() => onSubmit(trimmed)).then((done) => done && onClose());
          }
        }}
      >
        <FieldGroup label="Name">
          <Input
            aria-label="Team name"
            autoFocus
            maxLength={TEAM_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </FieldGroup>
      </form>
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}

interface JoinWithLinkDialogProps {
  onSubmit: (link: string) => void;
  onClose: () => void;
}

/** 받은 초대 링크를 붙여 넣는다. 다음 단계는 링크 페이지에서 열었을 때와 같은 참여 카드다. */
export function JoinWithLinkDialog({ onSubmit, onClose }: JoinWithLinkDialogProps) {
  const { t: translate } = useTranslation();
  const formId = useId();
  const [link, setLink] = useState('');
  const trimmed = link.trim();

  return (
    <TeamDialogFrame
      section="Team"
      title={translate('teamsPanel.joinWithLink')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={!trimmed}>
            {translate('teamsPanel.joinDialog.next')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) {
            onSubmit(trimmed);
          }
        }}
      >
        <FieldGroup label="Invite link">
          <Input
            aria-label="Invite link"
            autoFocus
            spellCheck={false}
            placeholder="https://…/invite/…"
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
        </FieldGroup>
      </form>
    </TeamDialogFrame>
  );
}

interface MakeOwnerDialogProps {
  member: TeamMember;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function MakeOwnerDialog({ member, onConfirm, onClose }: MakeOwnerDialogProps) {
  const { t: translate } = useTranslation();
  const { busy, error, run } = useDialogAction();
  return (
    <TeamDialogFrame
      section="Member"
      title={translate('teamsPanel.makeOwner.title', { email: member.email })}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void run(onConfirm).then((done) => done && onClose())}
          >
            {translate('teamsPanel.makeOwner.confirm')}
          </Button>
        </>
      }
    >
      <p className="m-0 text-sm leading-6 text-[var(--text-soft)]">{translate('teamsPanel.makeOwner.body')}</p>
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}

interface RemoveMemberDialogProps {
  member: TeamMember;
  onConfirm: () => Promise<void>;
  /** 뺀 뒤 — 링크가 모두 취소됐으니 새 링크를 바로 만들 수 있게 한다. */
  onOpenInvite: () => void;
  onClose: () => void;
}

/**
 * 멤버 제거. 짧게 묻고, 뺀 뒤에는 같은 창에서 링크가 모두 취소됐다고 알린다.
 *
 * 바꿀 비밀번호·키 목록은 보이지 않는다 — 멤버는 원래 팀 것을 모두 볼 수 있었으니 목록이 곧 전부다.
 */
export function RemoveMemberDialog({ member, onConfirm, onOpenInvite, onClose }: RemoveMemberDialogProps) {
  const { t: translate } = useTranslation();
  const { busy, error, run } = useDialogAction();
  const [removed, setRemoved] = useState(false);

  return (
    <TeamDialogFrame
      section="Member"
      title={translate('teamsPanel.remove.title', { email: member.email })}
      busy={busy}
      onClose={onClose}
      footer={
        removed ? (
          <>
            <Button variant="secondary" onClick={onOpenInvite}>
              <Link className="h-4 w-4" aria-hidden="true" />
              {translate('teamsPanel.inviteLink')}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {translate('common.close')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {translate('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void run(onConfirm).then((done) => done && setRemoved(true))}
            >
              {translate('teamsPanel.members.remove')}
            </Button>
          </>
        )
      }
    >
      {removed ? (
        <p className="m-0 flex items-start gap-2 text-sm leading-6 text-[var(--text)]">
          <Check className="mt-[0.3rem] h-4 w-4 shrink-0 text-[var(--success-text)]" aria-hidden="true" />
          <span>{translate('teamsPanel.remove.done')}</span>
        </p>
      ) : (
        <p className="m-0 text-sm leading-6 text-[var(--text-soft)]">{translate('teamsPanel.remove.body')}</p>
      )}
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}

