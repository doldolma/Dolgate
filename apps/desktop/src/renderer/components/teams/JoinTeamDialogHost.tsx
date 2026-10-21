import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamAvailability, TeamInvitePreview } from '@shared';
import { useAppStore } from '../../store/appStore';
import { normalizeErrorMessage } from '../../store/utils/errors-and-prompts';
import { DialogBackdrop } from '../DialogBackdrop';
import { Button, ModalBody, ModalFooter, ModalShell } from '../../ui';
import { Link, Lock } from '../../ui/icons';
import { TeamDialogError } from './TeamDialogFrame';
import { MarkSquare, TeamMark } from './TeamMark';

type UnavailableReason = Extract<TeamAvailability, { available: false }>['reason'];

type JoinCardView =
  | { kind: 'checking' }
  | { kind: 'unavailable'; reason: UnavailableReason }
  | { kind: 'preview'; preview: TeamInvitePreview }
  | { kind: 'failed'; message: string };

interface JoinCardProps {
  mark: ReactNode;
  title: string;
  children?: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  onClose: () => void;
}

/** 참여 카드의 틀 — 가운데 정렬한 작은 창. 링크로 앱이 열리면 보던 화면 위에 뜬다. */
function JoinCard({ mark, title, children, footer, busy = false, onClose }: JoinCardProps) {
  const titleId = useId();
  return (
    <DialogBackdrop dismissDisabled={busy} onDismiss={onClose}>
      <ModalShell size="sm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <ModalBody className="grid justify-items-center gap-3 px-6 pb-5 pt-6 text-center">
          {mark}
          <h3 id={titleId} className="m-0 break-words text-[1.15rem] font-semibold">
            {title}
          </h3>
          {children}
        </ModalBody>
        <ModalFooter className="justify-center">{footer}</ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

function SoftLine({ children }: { children: ReactNode }) {
  return <p className="-mt-1.5 m-0 text-sm leading-6 text-[var(--text-soft)]">{children}</p>;
}

interface JoinTeamDialogHostProps {
  /** 계정 없이 쓰는 사람이 링크를 열었을 때 로그인 창을 연다. */
  onRequestLogin: () => void;
}

/**
 * 초대 링크의 참여 카드. 링크는 브라우저의 링크 페이지가 앱으로 넘겼거나(딥 링크) Teams 탭에 붙여 넣은 것이다.
 *
 * 참여 전에는 팀 키를 받지 않는다 — 카드는 팀 이름·초대한 사람·인원만 서버에 묻고, `참여` 를 눌러야 멤버가 된다.
 * 팀을 쓸 수 없는 상태(계정 없음·옛 볼트·옛 서버)면 그 까닭을 말한다. 링크는 그동안 기억해 두었다가, 로그인을
 * 마쳐 팀을 쓸 수 있게 되면 다시 카드를 띄운다.
 */
export function JoinTeamDialogHost({ onRequestLogin }: JoinTeamDialogHostProps) {
  const { t: translate } = useTranslation();
  const link = useAppStore((state) => state.pendingInviteLink);
  const available = useAppStore((state) => state.teamAvailability.available);
  const dismissInviteLink = useAppStore((state) => state.dismissInviteLink);
  const checkTeamAvailability = useAppStore((state) => state.checkTeamAvailability);
  const previewTeamInvite = useAppStore((state) => state.previewTeamInvite);
  const joinTeam = useAppStore((state) => state.joinTeam);
  const showTeamInPanel = useAppStore((state) => state.showTeamInPanel);
  const [view, setView] = useState<JoinCardView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loginRequested, setLoginRequested] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // 링크가 오거나, 팀을 쓸 수 있게 되었거나(로그인을 마침), 다시 시도할 때 새로 확인한다.
  useEffect(() => {
    if (!link) {
      setView(null);
      return;
    }
    let cancelled = false;
    setView({ kind: 'checking' });
    setLoginRequested(false);
    setJoinError(null);
    void (async () => {
      const availability = await checkTeamAvailability();
      if (cancelled) {
        return;
      }
      if (!availability.available) {
        setView({ kind: 'unavailable', reason: availability.reason });
        return;
      }
      try {
        const preview = await previewTeamInvite(link);
        if (!cancelled) {
          setView({ kind: 'preview', preview });
        }
      } catch (error) {
        if (!cancelled) {
          setView({ kind: 'failed', message: normalizeErrorMessage(error, translate('teamsPanel.actionFailed')) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link, available, attempt, checkTeamAvailability, previewTeamInvite, translate]);

  // 확인하는 잠깐은 아무것도 띄우지 않는다(번쩍이지 않게). 로그인 창을 연 동안도 비켜 준다.
  if (!link || !view || view.kind === 'checking' || loginRequested) {
    return null;
  }

  const close = () => dismissInviteLink();
  const closeButton = (variant: 'primary' | 'secondary') => (
    <Button variant={variant} onClick={close} disabled={joining}>
      {translate('common.close')}
    </Button>
  );
  const warningMark = (
    <MarkSquare size="xl" tone="warning">
      !
    </MarkSquare>
  );
  const linkMark = (
    <MarkSquare size="xl" tone="muted">
      <Link />
    </MarkSquare>
  );

  if (view.kind === 'failed') {
    return (
      <JoinCard
        mark={warningMark}
        title={translate('teamsPanel.joinCard.failedTitle')}
        onClose={close}
        footer={
          <>
            {closeButton('secondary')}
            <Button variant="primary" onClick={() => setAttempt((count) => count + 1)}>
              {translate('teamsPanel.joinCard.retry')}
            </Button>
          </>
        }
      >
        <SoftLine>{view.message}</SoftLine>
      </JoinCard>
    );
  }

  if (view.kind === 'unavailable') {
    if (view.reason === 'signed-out') {
      return (
        <JoinCard
          mark={
            <MarkSquare size="xl" tone="muted">
              <Lock />
            </MarkSquare>
          }
          title={translate('teamsPanel.joinCard.signedOutTitle')}
          onClose={close}
          footer={
            <>
              {closeButton('secondary')}
              <Button
                variant="primary"
                onClick={() => {
                  // 링크는 그대로 둔다 — 로그인을 마치면 이 카드가 참여 카드로 다시 뜬다.
                  setLoginRequested(true);
                  onRequestLogin();
                }}
              >
                {translate('teamsPanel.joinCard.login')}
              </Button>
            </>
          }
        >
          <SoftLine>{translate('teamsPanel.joinCard.signedOutBody')}</SoftLine>
        </JoinCard>
      );
    }
    const [titleKey, bodyKey] =
      view.reason === 'unsupported-vault'
        ? ['teamsPanel.joinCard.unsupportedVaultTitle', 'teamsPanel.joinCard.unsupportedVaultBody']
        : view.reason === 'server-unsupported'
          ? ['teamsPanel.joinCard.serverUnsupportedTitle', 'teamsPanel.joinCard.serverUnsupportedBody']
          : ['teamsPanel.joinCard.failedTitle', 'teams.needsUnlockedVault'];
    return (
      <JoinCard mark={warningMark} title={translate(titleKey)} onClose={close} footer={closeButton('primary')}>
        <SoftLine>{translate(bodyKey)}</SoftLine>
      </JoinCard>
    );
  }

  const preview = view.preview;
  if (preview.status === 'ok' && preview.alreadyJoined) {
    return (
      <JoinCard
        mark={<TeamMark name={preview.teamName} size="xl" />}
        title={preview.teamName}
        onClose={close}
        footer={
          <>
            {closeButton('secondary')}
            <Button
              variant="primary"
              onClick={() => {
                close();
                showTeamInPanel(preview.teamId);
              }}
            >
              {translate('teamsPanel.joinCard.goToTeam')}
            </Button>
          </>
        }
      >
        <SoftLine>{translate('teamsPanel.joinCard.alreadyJoined')}</SoftLine>
      </JoinCard>
    );
  }

  if (preview.status === 'ok') {
    const join = async () => {
      setJoining(true);
      setJoinError(null);
      try {
        const team = await joinTeam(link);
        showTeamInPanel(team.id);
      } catch (error) {
        setJoinError(normalizeErrorMessage(error, translate('teamsPanel.actionFailed')));
      } finally {
        setJoining(false);
      }
    };
    return (
      <JoinCard
        mark={<TeamMark name={preview.teamName} size="xl" />}
        title={preview.teamName}
        busy={joining}
        onClose={close}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={joining}>
              {translate('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void join()} disabled={joining}>
              {translate('teamsPanel.joinCard.join')}
            </Button>
          </>
        }
      >
        <SoftLine>
          {translate('teamsPanel.joinCard.invitedBy', { email: preview.inviterEmail, count: preview.memberCount })}
        </SoftLine>
        <p className="m-0 flex items-start gap-2 rounded-[10px] border border-[var(--selection-border)] bg-[var(--selection-tint)] px-3 py-2.5 text-left text-[0.84rem] leading-[1.55] text-[var(--text-soft)]">
          <Lock className="mt-[0.2rem] h-4 w-4 shrink-0 text-[var(--accent-strong)]" aria-hidden="true" />
          <span>{translate('teamsPanel.joinCard.what')}</span>
        </p>
        <TeamDialogError message={joinError} />
      </JoinCard>
    );
  }

  if (preview.status === 'other-server') {
    return (
      <JoinCard
        mark={warningMark}
        title={translate('teamsPanel.joinCard.otherServerTitle')}
        onClose={close}
        footer={closeButton('primary')}
      >
        <SoftLine>{translate('teamsPanel.joinCard.otherServerBody', { host: preview.serverHost })}</SoftLine>
      </JoinCard>
    );
  }

  const [titleKey, bodyKey, mark] =
    preview.status === 'expired'
      ? (['teamsPanel.joinCard.expiredTitle', 'teamsPanel.joinCard.expiredBody', linkMark] as const)
      : preview.status === 'update-required'
        ? (['teamsPanel.joinCard.updateTitle', 'teamsPanel.joinCard.updateBody', warningMark] as const)
        : (['teamsPanel.joinCard.invalidTitle', 'teamsPanel.joinCard.invalidBody', linkMark] as const);
  return (
    <JoinCard mark={mark} title={translate(titleKey)} onClose={close} footer={closeButton('primary')}>
      <SoftLine>{translate(bodyKey)}</SoftLine>
    </JoinCard>
  );
}
