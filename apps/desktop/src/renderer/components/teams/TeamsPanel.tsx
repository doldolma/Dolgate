import { Fragment, useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamInvite, TeamMember, TeamRole } from '@shared';
import { useAppStore } from '../../store/appStore';
import { normalizeErrorMessage } from '../../store/utils/errors-and-prompts';
import { cn } from '../../lib/cn';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  InfoHint,
  InfoHintPoints,
  NoticeCard,
  SectionLabel,
  SplitButtonMenu,
  SplitButtonMenuItem,
  Tooltip,
} from '../../ui';
import { Check, Copy, Crown, Link, LogIn, LogOut, MoreVertical, Pencil, Plus, Trash2, UserMinus } from '../../ui/icons';
import { copyText } from './copy-text';
import { InviteLinkDialog } from './InviteLinkDialog';
import { DeleteTeamDialog, LeaveTeamDialog } from './TeamExitDialogs';
import { JoinWithLinkDialog, MakeOwnerDialog, RemoveMemberDialog, TeamNameDialog } from './TeamFormDialogs';
import { formatExactTime, formatRelativeTime, isCurrentMember, shortNameOf } from './team-format';

// AWS Profiles 탭과 같은 두 칸 — 왼쪽 목록 판·오른쪽 상세 판.
const PANEL_CLASS =
  'grid content-start gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.3rem] shadow-[var(--shadow-soft)]';
// 목록 항목은 팀 이름과 호스트 수 두 줄이다. 역할은 오른쪽 팀 이름 옆에만 둔다.
const LIST_ITEM_CLASS =
  'flex min-w-0 items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-[border-color,background-color] duration-150';
const LIST_ITEM_SELECTED_CLASS =
  'border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[var(--selection-tint)]';
const LIST_ITEM_IDLE_CLASS =
  'border-transparent hover:bg-[color-mix(in_srgb,var(--surface-muted)_84%,transparent_16%)]';
// 초대 링크·멤버 목록 — 테두리 하나 안의 줄들. 줄마다 카드를 두면 몇 줄 안 되는데도 덩어리만 보였다.
const ROWS_CLASS =
  'm-0 grid list-none divide-y divide-[var(--border)] rounded-[10px] border border-[var(--border)] p-0';
const ROW_CLASS = 'flex min-w-0 items-center gap-3 px-3.5 py-2.5';
const ROWS_LABEL_CLASS = 'text-[0.8rem] font-medium text-[var(--text-soft)]';
// 이름 옆에 붙는 작은 칩. 기본 Badge(상태 표시용)는 글줄보다 높아 이름 옆에서 튀었다.
const ROLE_BADGE_CLASS = 'min-h-0 px-[0.45rem] py-0 text-[0.7rem] font-medium leading-[1.15rem]';

/** 열린 창. 팀에 대한 창은 연 순간의 팀을 붙잡는다 — 그 사이 팀이 사라져 다른 팀을 건드리지 않게. */
type TeamsDialog =
  | { kind: 'new-team' }
  | { kind: 'join' }
  | { kind: 'rename'; teamId: string; teamName: string }
  | { kind: 'invite'; teamId: string; teamName: string }
  | { kind: 'make-owner'; teamId: string; member: TeamMember }
  | { kind: 'remove-member'; teamId: string; teamName: string; member: TeamMember }
  | { kind: 'leave'; teamId: string; teamName: string }
  | { kind: 'delete'; teamId: string; teamName: string };

/** 서버에서 읽은 멤버·초대 링크. 어느 팀 것인지 함께 둔다(팀을 바꾼 직후 옛 팀 것을 보이지 않게). */
interface TeamRoster {
  teamId: string;
  members: TeamMember[];
  invites: TeamInvite[];
}

/** 바깥을 누르거나 Esc 를 누르면 메뉴를 닫는다. */
function useDismissible(ref: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void) {
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        dismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, ref]);
}

interface MenuAction {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** 앞 항목들과 줄로 나눈다(지우기처럼 되돌릴 수 없는 것). */
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** ⋯ 단추와 그 메뉴. 팀 메뉴(이름 변경·나가기·삭제)와 멤버 줄 메뉴(소유자로 지정·제거)가 같이 쓴다. */
function ActionsMenu({ label, size, actions }: { label: string; size: 'sm' | 'md'; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissible(containerRef, open, () => setOpen(false));
  return (
    <div ref={containerRef} className="relative inline-flex">
      <IconButton
        tone={size === 'md' ? 'default' : 'ghost'}
        size={size}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVertical className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      {open ? (
        <SplitButtonMenu role="menu" aria-label={label} className="min-w-[11rem]">
          {actions.map((action) => (
            <Fragment key={action.key}>
              {action.separatorBefore ? <div role="separator" className="my-1 h-px bg-[var(--border)]" /> : null}
              <SplitButtonMenuItem
                role="menuitem"
                className={action.danger ? 'text-[var(--danger-text)]' : undefined}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
              >
                {action.icon}
                {action.label}
              </SplitButtonMenuItem>
            </Fragment>
          ))}
        </SplitButtonMenu>
      ) : null}
    </div>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  return (
    <Tooltip label={formatExactTime(iso)}>
      <span>{formatRelativeTime(iso)}</span>
    </Tooltip>
  );
}

/** 링크 줄의 `링크 복사`. 복사하면 잠깐 `복사됨` 으로 바뀐다. */
function CopyLinkButton({ link, onResult }: { link: string; onResult: (copied: boolean) => void }) {
  const { t: translate } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 사라진 뒤에 타이머가 상태를 바꾸지 않게.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );
  return (
    <Button
      variant="secondary"
      size="sm"
      className="shrink-0"
      onClick={() =>
        void copyText(link).then((done) => {
          onResult(done);
          if (!done) {
            return;
          }
          setCopied(true);
          if (timerRef.current) {
            clearTimeout(timerRef.current);
          }
          timerRef.current = setTimeout(() => setCopied(false), 1200);
        })
      }
    >
      {/* 두 모양을 겹쳐 두고 하나만 보인다 — 단추 너비가 바뀌어 옆 단추가 흔들리지 않게. */}
      <span className="grid justify-items-center">
        <span
          aria-hidden={copied}
          className={cn('col-start-1 row-start-1 inline-flex items-center gap-2', copied && 'invisible')}
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          {translate('teamsPanel.invites.copy')}
        </span>
        <span
          aria-hidden={!copied}
          className={cn('col-start-1 row-start-1 inline-flex items-center gap-2', !copied && 'invisible')}
        >
          <Check className="h-4 w-4 text-[var(--success-text)]" aria-hidden="true" />
          {translate('teamsPanel.invites.copied')}
        </span>
      </span>
    </Button>
  );
}

function RoleBadge({ role, className }: { role: TeamRole; className?: string }) {
  return role === 'owner' ? (
    <Badge tone="starting" className={cn(ROLE_BADGE_CLASS, className)}>
      Owner
    </Badge>
  ) : (
    <Badge className={cn(ROLE_BADGE_CLASS, className)}>Member</Badge>
  );
}

/** 설정 탭 머리 — AWS Profiles·Tailscale 과 같은 자리에 제목·설명·주 단추. 팀이 없을 때도 단추 자리가 같다. */
function TeamsHeader({ onJoin, onNewTeam }: { onJoin: () => void; onNewTeam: () => void }) {
  const { t: translate } = useTranslation();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <SectionLabel>Teams</SectionLabel>
        <h3 className="m-0 flex items-center gap-2">
          Team Vaults
          {/* 설명 줄은 무엇인지, 빈 상태는 쓰는 순서, 이 말풍선은 "팀에 넣으면 누가 무엇을 보나" 에 답한다. */}
          <InfoHint label={translate('teamsPanel.about.label')}>
            <InfoHintPoints
              items={[
                translate('teamsPanel.about.edit'),
                translate('teamsPanel.about.members'),
                translate('teamsPanel.about.ownKeys'),
              ]}
            />
          </InfoHint>
        </h3>
        <p className="mb-0 mt-2 max-w-[46rem] text-[0.9rem] text-[var(--text-soft)]">{translate('teamsPanel.intro')}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={onJoin}>
          <LogIn className="h-4 w-4" aria-hidden="true" />
          {translate('teamsPanel.joinWithLink')}
        </Button>
        <Button variant="primary" onClick={onNewTeam}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {translate('teamsPanel.newTeam')}
        </Button>
      </div>
    </div>
  );
}

/** 팀이 없을 때 — 무엇부터 하면 되는지(Tailscale 탭의 빈 상태와 같은 모양). */
function TeamUsageSteps() {
  const { t: translate } = useTranslation();
  const steps = ['teamsPanel.empty.stepCreate', 'teamsPanel.empty.stepInvite', 'teamsPanel.empty.stepShare'];
  return (
    <ol className="m-0 grid list-none gap-2 p-0 text-left text-[0.85rem] text-[var(--text-soft)]">
      {steps.map((key, index) => (
        <li key={key} className="flex items-start gap-2.5">
          <span
            className="mt-[0.1rem] inline-flex h-[1.15rem] w-[1.15rem] shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[0.7rem] font-medium text-[var(--text)]"
            aria-hidden
          >
            {index + 1}
          </span>
          <span>{translate(key)}</span>
        </li>
      ))}
    </ol>
  );
}

interface TeamsPanelProps {
  currentUserId: string | null;
  currentUserEmail: string | null;
}

/**
 * 설정의 Teams 탭. AWS Profiles 탭처럼 왼쪽에 팀 목록, 오른쪽에 고른 팀 — 초대 링크·멤버·나가기.
 *
 * 멤버 줄이 중심이다: 알림을 두지 않으므로, 누가 누구 링크로 언제 들어왔는지를 여기서 훑어 링크가 샌 것을
 * 알아챈다.
 */
export function TeamsPanel({ currentUserId, currentUserEmail }: TeamsPanelProps) {
  const { t: translate } = useTranslation();
  const teams = useAppStore((state) => state.vaultIndex.teams);
  const teamIdByHostId = useAppStore((state) => state.vaultIndex.teamIdByHostId);
  const selectedTeamId = useAppStore((state) => state.teamsPanelTeamId);
  const selectTeamInPanel = useAppStore((state) => state.selectTeamInPanel);
  const openInviteLink = useAppStore((state) => state.openInviteLink);
  const createTeam = useAppStore((state) => state.createTeam);
  const renameTeam = useAppStore((state) => state.renameTeam);
  const deleteTeam = useAppStore((state) => state.deleteTeam);
  const leaveTeam = useAppStore((state) => state.leaveTeam);
  const transferTeamOwnership = useAppStore((state) => state.transferTeamOwnership);
  const removeTeamMember = useAppStore((state) => state.removeTeamMember);
  const listTeamMembers = useAppStore((state) => state.listTeamMembers);
  const listTeamInvites = useAppStore((state) => state.listTeamInvites);
  const createTeamInvite = useAppStore((state) => state.createTeamInvite);
  const revokeTeamInvite = useAppStore((state) => state.revokeTeamInvite);
  const countTeamSecrets = useAppStore((state) => state.countTeamSecrets);

  const team = teams.find((candidate) => candidate.id === selectedTeamId) ?? teams[0] ?? null;
  const [dialog, setDialog] = useState<TeamsDialog | null>(null);
  const [roster, setRoster] = useState<TeamRoster | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [secretCount, setSecretCount] = useState<{ teamId: string; count: number } | null>(null);
  const reloadRoster = () => setReloadToken((token) => token + 1);

  // 멤버·링크는 서버에서 읽는다. 팀을 바꾸거나, 이름·내 역할이 바뀌었거나(다른 기기·다른 멤버), 이 화면에서
  // 무엇을 바꿨을 때 다시 읽는다.
  const teamId = team?.id ?? null;
  const teamRole = team?.role ?? null;
  const teamName = team?.name ?? null;
  useEffect(() => {
    if (!teamId) {
      return;
    }
    let cancelled = false;
    setRosterError(null);
    Promise.all([listTeamMembers(teamId), listTeamInvites(teamId)]).then(
      ([members, invites]) => {
        if (!cancelled) {
          setRoster({ teamId, members, invites });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setRosterError(normalizeErrorMessage(error, translate('teamsPanel.members.loadFailed')));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [teamId, teamRole, teamName, reloadToken, listTeamMembers, listTeamInvites, translate]);

  // 다른 앱(채팅 등)에 링크를 보내고 돌아오면 그 사이 들어온 사람·새 링크가 보이게, 창이 앞으로 올 때 다시 읽는다.
  useEffect(() => {
    const onFocus = () => setReloadToken((token) => token + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // 나가기·삭제 창은 사라질 비밀번호·키 수를 보인다.
  const countingTeamId = dialog?.kind === 'leave' || dialog?.kind === 'delete' ? dialog.teamId : null;
  useEffect(() => {
    // 창을 다시 열 때 지난번 수를 잠깐이라도 보이지 않게 비우고 새로 센다.
    setSecretCount(null);
    if (!countingTeamId) {
      return;
    }
    let cancelled = false;
    countTeamSecrets(countingTeamId).then(
      (count) => {
        if (!cancelled) {
          setSecretCount({ teamId: countingTeamId, count });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [countingTeamId, countTeamSecrets]);

  // 다른 팀으로 바꾸면 앞 팀에서 실패한 줄은 치운다.
  useEffect(() => {
    setActionError(null);
  }, [teamId]);

  // 연 창의 팀이 사라지면(다른 멤버가 지웠거나 나를 뺐다) 창을 닫는다.
  const dialogTeamId = dialog && 'teamId' in dialog ? dialog.teamId : null;
  const dialogTeamGone = dialogTeamId !== null && !teams.some((candidate) => candidate.id === dialogTeamId);
  useEffect(() => {
    if (dialogTeamGone) {
      setDialog(null);
    }
  }, [dialogTeamGone]);

  const closeDialog = () => setDialog(null);
  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(normalizeErrorMessage(error, translate('teamsPanel.actionFailed')));
    }
  };

  const isMe = (member: TeamMember) => isCurrentMember(member, currentUserId, currentUserEmail);
  const rosterFor = (id: string) => (roster?.teamId === id ? roster : null);
  const hostCountOf = (id: string) => Object.values(teamIdByHostId).filter((hostTeamId) => hostTeamId === id).length;
  const countsFor = (id: string) => ({
    groups: teams.find((candidate) => candidate.id === id)?.groups.length ?? 0,
    hosts: hostCountOf(id),
    secrets: secretCount?.teamId === id ? secretCount.count : null,
  });

  let dialogView: ReactNode = null;
  if (dialog?.kind === 'new-team') {
    dialogView = (
      <TeamNameDialog
        mode="create"
        onSubmit={async (name) => {
          await createTeam(name);
        }}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'join') {
    dialogView = (
      <JoinWithLinkDialog
        onSubmit={(link) => {
          closeDialog();
          openInviteLink(link);
        }}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'rename') {
    dialogView = (
      <TeamNameDialog
        mode="rename"
        initialName={dialog.teamName}
        onSubmit={(name) => renameTeam(dialog.teamId, name)}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'invite') {
    dialogView = (
      <InviteLinkDialog
        teamName={dialog.teamName}
        onCreate={async (hours) => {
          const created = await createTeamInvite(dialog.teamId, hours);
          reloadRoster();
          return created;
        }}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'make-owner') {
    dialogView = (
      <MakeOwnerDialog
        member={dialog.member}
        onConfirm={async () => {
          await transferTeamOwnership(dialog.teamId, dialog.member.userId);
          reloadRoster();
        }}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'remove-member') {
    dialogView = (
      <RemoveMemberDialog
        member={dialog.member}
        onConfirm={async () => {
          await removeTeamMember(dialog.teamId, dialog.member.userId);
          reloadRoster();
        }}
        onOpenInvite={() => setDialog({ kind: 'invite', teamId: dialog.teamId, teamName: dialog.teamName })}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'leave') {
    const dialogRoster = rosterFor(dialog.teamId);
    dialogView = (
      <LeaveTeamDialog
        teamName={dialog.teamName}
        isOwner={teams.find((candidate) => candidate.id === dialog.teamId)?.role === 'owner'}
        otherMembers={dialogRoster ? dialogRoster.members.filter((member) => !isMe(member)) : null}
        counts={countsFor(dialog.teamId)}
        onLeave={(newOwnerId) => leaveTeam(dialog.teamId, newOwnerId)}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'delete') {
    const dialogRoster = rosterFor(dialog.teamId);
    dialogView = (
      <DeleteTeamDialog
        teamName={dialog.teamName}
        otherMemberCount={dialogRoster ? dialogRoster.members.filter((member) => !isMe(member)).length : null}
        counts={countsFor(dialog.teamId)}
        onDelete={() => deleteTeam(dialog.teamId)}
        onClose={closeDialog}
      />
    );
  }

  const header = (
    <TeamsHeader onJoin={() => setDialog({ kind: 'join' })} onNewTeam={() => setDialog({ kind: 'new-team' })} />
  );

  if (!team) {
    return (
      <div className="grid gap-5">
        {header}
        <div className="border-t border-[var(--border)]" />
        {/* 처음 보는 사람의 물음은 여기서 한 번 생긴다 — 팀이 하나라도 생기면 이 자리는 팀 목록이 된다. */}
        <EmptyState title={translate('teamsPanel.empty.title')}>
          <TeamUsageSteps />
        </EmptyState>
        {dialogView}
      </div>
    );
  }

  const isOwner = team.role === 'owner';
  const shownRoster = rosterFor(team.id);
  const activeInvites = shownRoster?.invites.filter((invite) => invite.active) ?? [];
  const summary = [
    shownRoster ? translate('teamsPanel.memberCount', { count: shownRoster.members.length }) : null,
    translate('teamsPanel.hostCount', { count: hostCountOf(team.id) }),
  ]
    .filter(Boolean)
    .join(' · ');
  // 나가기·지우기는 늘 보이는 단추 대신 팀 메뉴에 둔다. 무엇이 사라지는지는 그 확인 창이 수와 함께 알린다.
  const teamActions: MenuAction[] = [
    ...(isOwner
      ? [
          {
            key: 'rename',
            label: translate('common.rename'),
            icon: <Pencil className="h-4 w-4 text-[var(--text-soft)]" aria-hidden="true" />,
            onSelect: () => setDialog({ kind: 'rename', teamId: team.id, teamName: team.name }),
          },
        ]
      : []),
    {
      key: 'leave',
      label: translate('teamsPanel.danger.leave'),
      icon: <LogOut className="h-4 w-4 text-[var(--text-soft)]" aria-hidden="true" />,
      onSelect: () => setDialog({ kind: 'leave', teamId: team.id, teamName: team.name }),
    },
    ...(isOwner
      ? [
          {
            key: 'delete',
            label: translate('teamsPanel.danger.delete'),
            icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
            danger: true,
            separatorBefore: true,
            onSelect: () => setDialog({ kind: 'delete', teamId: team.id, teamName: team.name }),
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-5">
      {header}
      {/* 목록 판은 제 내용만큼만 — 오른쪽 높이에 맞춰 늘면 빈 판이 크게 남는다. */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section className={cn(PANEL_CLASS, 'gap-2 p-2.5')}>
          <div className="flex items-center justify-between gap-3 px-1.5 pt-1 text-[0.8rem] text-[var(--text-soft)]">
            <span>{translate('teamsPanel.listTitle')}</span>
            <span>{teams.length}</span>
          </div>
          <div className="grid content-start gap-1">
            {teams.map((candidate) => {
              const selected = candidate.id === team.id;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={selected}
                  className={cn(LIST_ITEM_CLASS, selected ? LIST_ITEM_SELECTED_CLASS : LIST_ITEM_IDLE_CLASS)}
                  onClick={() => selectTeamInPanel(candidate.id)}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="min-w-0 break-all text-[0.95rem] leading-[1.3] text-[var(--text)]">
                      {candidate.name}
                    </strong>
                    <span className="text-[0.8rem] text-[var(--text-soft)]">
                      {translate('teamsPanel.hostCount', { count: hostCountOf(candidate.id) })}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className={cn(PANEL_CLASS, 'gap-[1.1rem]')}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="grid min-w-0 gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="m-0 break-all text-[1.15rem]">{team.name}</h4>
                  <RoleBadge role={team.role} />
                </div>
                <p className="m-0 text-[0.85rem] text-[var(--text-soft)]">{summary}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="primary"
                onClick={() => setDialog({ kind: 'invite', teamId: team.id, teamName: team.name })}
              >
                <Link className="h-4 w-4" aria-hidden="true" />
                {translate('teamsPanel.inviteLink')}
              </Button>
              <ActionsMenu label={translate('teamsPanel.teamActions')} size="md" actions={teamActions} />
            </div>
          </div>

          {team.syncState === 'needs-rejoin' || team.syncState === 'outdated' ? (
            <NoticeCard tone="warning">
              {team.syncState === 'needs-rejoin'
                ? translate('teams.needsRejoin')
                : translate('teamsPanel.sync.outdated')}
            </NoticeCard>
          ) : null}

          {actionError ? (
            <NoticeCard tone="danger" role="alert">
              {actionError}
            </NoticeCard>
          ) : null}

          {activeInvites.length > 0 ? (
            <div className="grid gap-2">
              <span className={ROWS_LABEL_CLASS}>{translate('teamsPanel.invites.label')}</span>
              <ul aria-label={translate('teamsPanel.invites.label')} className={ROWS_CLASS}>
                {activeInvites.map((invite) => (
                  <li key={invite.code} className={ROW_CLASS}>
                    <Link className="h-4 w-4 shrink-0 text-[var(--text-soft)]" aria-hidden="true" />
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="text-[0.9rem] text-[var(--text)]">
                        {translate('teamsPanel.invites.title', {
                          name: invite.createdByEmail ? shortNameOf(invite.createdByEmail) : '—',
                        })}
                      </span>
                      <span className="flex flex-wrap gap-x-1.5 text-[0.8rem] text-[var(--text-soft)]">
                        <Tooltip label={formatExactTime(invite.expiresAt)}>
                          <span>
                            {translate('teamsPanel.invites.expires', { when: formatRelativeTime(invite.expiresAt) })}
                          </span>
                        </Tooltip>
                        <span aria-hidden="true">·</span>
                        <span>{translate('teamsPanel.invites.joined', { count: invite.useCount })}</span>
                      </span>
                    </div>
                    {/* 이 기능 전에 만든 링크는 비밀값이 서버에 없어 다시 복사할 수 없다 — 단추를 두지 않는다. */}
                    {invite.link ? (
                      <CopyLinkButton
                        link={invite.link}
                        onResult={(copied) => setActionError(copied ? null : translate('teamsPanel.invites.copyFailed'))}
                      />
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      onClick={() =>
                        void runAction(async () => {
                          await revokeTeamInvite(team.id, invite.code);
                          reloadRoster();
                        })
                      }
                    >
                      {translate('teamsPanel.invites.revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {rosterError && !shownRoster ? (
            <NoticeCard tone="danger" role="alert">
              {rosterError}
            </NoticeCard>
          ) : null}

          {shownRoster ? (
            <div className="grid gap-2">
              <span className={ROWS_LABEL_CLASS}>{translate('teamsPanel.members.label')}</span>
              <ul aria-label={translate('teamsPanel.members.label')} className={ROWS_CLASS}>
                {shownRoster.members.map((member) => {
                  const me = isMe(member);
                  return (
                    <li key={member.userId} className={ROW_CLASS}>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="min-w-0 break-all text-[0.9rem] text-[var(--text)]">{member.email}</span>
                          {me ? (
                            <span className="shrink-0 text-[0.78rem] text-[var(--text-soft)]">
                              {translate('teamsPanel.members.you')}
                            </span>
                          ) : null}
                        </span>
                        {/* 누구의 링크로 언제 들어왔는지 — 알림이 없어서 링크가 샌 것을 여기서 알아챈다. 만든 사람은
                            들어온 길이 없으니 비운다. */}
                        {member.addedBy === member.userId ? null : (
                          <span className="flex flex-wrap gap-x-1.5 text-[0.8rem] text-[var(--text-soft)]">
                            {member.addedByEmail ? (
                              <>
                                <Tooltip label={member.addedByEmail}>
                                  <span>
                                    {translate('teamsPanel.members.joinedVia', {
                                      name: shortNameOf(member.addedByEmail),
                                    })}
                                  </span>
                                </Tooltip>
                                <span aria-hidden="true">·</span>
                              </>
                            ) : null}
                            <RelativeTime iso={member.addedAt} />
                          </span>
                        )}
                      </div>
                      <RoleBadge role={member.role} className="shrink-0" />
                      {isOwner ? (
                        me ? (
                          // 다른 줄의 ⋯ 자리를 비워 역할 칩이 한 줄로 선다.
                          <span className="w-8 shrink-0" aria-hidden="true" />
                        ) : (
                          <ActionsMenu
                            label={translate('teamsPanel.members.actions')}
                            size="sm"
                            actions={[
                              {
                                key: 'make-owner',
                                label: translate('teamsPanel.members.makeOwner'),
                                icon: <Crown className="h-4 w-4 text-[var(--text-soft)]" aria-hidden="true" />,
                                onSelect: () => setDialog({ kind: 'make-owner', teamId: team.id, member }),
                              },
                              {
                                key: 'remove',
                                label: translate('teamsPanel.members.remove'),
                                icon: <UserMinus className="h-4 w-4" aria-hidden="true" />,
                                danger: true,
                                onSelect: () =>
                                  setDialog({ kind: 'remove-member', teamId: team.id, teamName: team.name, member }),
                              },
                            ]}
                          />
                        )
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
      {dialogView}
    </div>
  );
}
