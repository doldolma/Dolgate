import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamMember } from '@shared';
import { Button, FieldGroup, NoticeCard, SelectField } from '../../ui';
import { LogOut, Trash2 } from '../../ui/icons';
import { TeamContentCountTiles, type TeamContentCounts } from './TeamContentCounts';
import { TeamDialogError, TeamDialogFrame } from './TeamDialogFrame';
import { useDialogAction } from './useDialogAction';

interface LeaveTeamDialogProps {
  teamName: string;
  isOwner: boolean;
  /** 나 말고 남은 멤버(들어온 순서). 못 읽었으면 null — 그때는 멤버가 나가는 창을 보인다. */
  otherMembers: TeamMember[] | null;
  counts: TeamContentCounts;
  /** 소유자는 넘길 사람을 준다. 마지막 한 명이 나가면 서버가 팀을 지운다. */
  onLeave: (newOwnerId: string | null) => Promise<void>;
  onClose: () => void;
}

/**
 * 팀 나가기. 셋 중 하나다.
 * - 멤버: 확인 한 번
 * - 다른 멤버가 남은 소유자: 막지 않고, 넘길 사람(가장 먼저 들어온 사람이 골라져 있음)을 골라 넘기고 나간다
 * - 마지막 한 명: 나가면 팀이 지워진다 — 지워질 개수를 보인다
 */
export function LeaveTeamDialog({ teamName, isOwner, otherMembers, counts, onLeave, onClose }: LeaveTeamDialogProps) {
  const { t: translate } = useTranslation();
  const { busy, error, run } = useDialogAction();
  const isLast = otherMembers !== null && otherMembers.length === 0;
  const mustHandOver = isOwner && otherMembers !== null && otherMembers.length > 0;
  // 고르지 않았으면 가장 먼저 들어온 사람이다. 멤버 목록이 창을 연 뒤에 와도 그 사람이 골라져 있게 그때그때 정한다.
  const [chosenOwnerId, setChosenOwnerId] = useState<string | null>(null);
  const newOwnerId =
    otherMembers?.find((member) => member.userId === chosenOwnerId)?.userId ?? otherMembers?.[0]?.userId ?? '';

  const leave = () =>
    void run(() => onLeave(mustHandOver ? newOwnerId : null)).then((done) => done && onClose());

  return (
    <TeamDialogFrame
      section="Leave"
      title={translate('teamsPanel.leave.title', { team: teamName })}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button variant="danger" disabled={busy || (mustHandOver && !newOwnerId)} onClick={leave}>
            {isLast ? (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <LogOut className="h-4 w-4" aria-hidden="true" />
            )}
            {translate(
              isLast
                ? 'teamsPanel.leave.deleteAndLeave'
                : mustHandOver
                  ? 'teamsPanel.leave.transferAndLeave'
                  : 'teamsPanel.leave.confirm',
            )}
          </Button>
        </>
      }
    >
      {isLast ? (
        <>
          <NoticeCard tone="danger">{translate('teamsPanel.leave.last')}</NoticeCard>
          <TeamContentCountTiles counts={counts} />
          <p className="m-0 text-[0.82rem] text-[var(--text-soft)]">{translate('teamsPanel.leave.copyFirst')}</p>
        </>
      ) : mustHandOver ? (
        <>
          <p className="m-0 text-sm leading-6 text-[var(--text-soft)]">{translate('teamsPanel.leave.owner')}</p>
          <FieldGroup label="New owner">
            <SelectField
              aria-label="New owner"
              value={newOwnerId}
              disabled={busy}
              onChange={(event) => setChosenOwnerId(event.target.value)}
            >
              {otherMembers!.map((member, index) => (
                <option key={member.userId} value={member.userId}>
                  {index === 0 ? `${member.email} · ${translate('teamsPanel.leave.earliest')}` : member.email}
                </option>
              ))}
            </SelectField>
          </FieldGroup>
        </>
      ) : (
        <p className="m-0 text-sm leading-6 text-[var(--text-soft)]">{translate('teamsPanel.leave.member')}</p>
      )}
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}

interface DeleteTeamDialogProps {
  teamName: string;
  /** 나 말고 남은 멤버 수. 못 읽었으면 null. */
  otherMemberCount: number | null;
  counts: TeamContentCounts;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

/** 팀 삭제(소유자). 멤버가 남아 있어도 지울 수 있다 — 모든 멤버의 화면에서 팀이 통째로 사라진다. */
export function DeleteTeamDialog({ teamName, otherMemberCount, counts, onDelete, onClose }: DeleteTeamDialogProps) {
  const { t: translate } = useTranslation();
  const { busy, error, run } = useDialogAction();
  return (
    <TeamDialogFrame
      section="Delete"
      title={translate('teamsPanel.delete.title', { team: teamName })}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void run(onDelete).then((done) => done && onClose())}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {translate('teamsPanel.danger.delete')}
          </Button>
        </>
      }
    >
      {otherMemberCount !== null ? (
        <p className="m-0 text-sm leading-6 text-[var(--text)]">
          {otherMemberCount > 0
            ? translate('teamsPanel.delete.others', { count: otherMemberCount })
            : translate('teamsPanel.delete.alone')}
        </p>
      ) : null}
      <TeamContentCountTiles counts={counts} />
      <p className="m-0 text-[0.82rem] text-[var(--text-soft)]">{translate('teamsPanel.delete.copyFirst')}</p>
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}
