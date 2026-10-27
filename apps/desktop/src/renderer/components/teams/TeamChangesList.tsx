import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamChangeRef, TeamChangeSet, TeamRestoreOutcome, TeamRestoreOverwrite, TeamRestoreSkipped } from '@shared';
import { Badge, Button, Card, CardMain, EmptyState, NoticeCard, Tooltip } from '../../ui';
import { Check, RotateCcw, TriangleAlert } from '../../ui/icons';
import { getFormatLocale } from '../../i18n';
import { getKeyboardLayoutSearchQueries } from '../../lib/keyboard-layout-search';
import { useTeamChanges } from '../../controllers/useTeamChanges';
import { restoreTeamChange } from '../../services/desktop/team-history';
import { normalizeErrorMessage } from '../../store/utils/errors-and-prompts';
import { AuthorLine } from './AuthorLine';
import {
  TEAM_RECORD_KIND_ICONS,
  formatTeamChangeItemLabel,
  formatTeamChangeSubject,
  formatTeamChangeTitle,
} from './team-change-format';
import { TeamDialogError, TeamDialogFrame } from './TeamDialogFrame';
import { useDialogAction } from './useDialogAction';

type Translate = (key: string, params?: Record<string, unknown>) => string;
type RestoredOutcome = Extract<TeamRestoreOutcome, { status: 'restored' }>;

/** 카드 한 장에 보이는 항목 수 — 나머지는 "외 n개". */
const SHOWN_ITEMS = 8;
/** 결과 줄에 늘어놓는 이름 수. */
const SHOWN_NAMES = 5;
// 칩은 팀 탭의 역할 칩과 같은 크기(기본 Badge 는 글줄보다 높다).
const CHIP_CLASS = 'min-h-0 px-[0.45rem] py-0 text-[0.7rem] font-medium leading-[1.15rem]';

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(getFormatLocale());
}

function joinNames(names: readonly string[], translate: Translate): string {
  const shown = names.slice(0, SHOWN_NAMES).join(', ');
  return names.length > SHOWN_NAMES ? `${shown} ${translate('teamChanges.more', { count: names.length - SHOWN_NAMES })}` : shown;
}

function setKey(set: TeamChangeSet): string {
  return `${set.lastSeq}:${set.firstSeq}`;
}

/** 복원에는 묶음을 가리키는 것만 넘긴다(항목은 메인이 서버에서 다시 받는다). */
function refOf({ firstSeq, lastSeq, changedBy, changedAt }: TeamChangeSet): TeamChangeRef {
  return { firstSeq, lastSeq, changedBy, changedAt };
}

type Notice = { kind: 'restored'; outcome: RestoredOutcome } | { kind: 'error'; message: string };

interface TeamChangesListProps {
  teamId: string;
  search: string;
}

/**
 * 기록 화면의 Changes — 팀 볼트에서 한 번에 올라간 변경(이전 판)을 지금 기록 카드와 같은 모양으로 보이고 복원한다.
 * 묻지 않고 복원해 결과를 한 줄로 알리고, 남이 그 뒤에 바꾼 것을 덮을 때만 묻는다(복원은 되돌릴 수 있다).
 */
export function TeamChangesList({ teamId, search }: TeamChangesListProps) {
  const { t: translate, i18n } = useTranslation();
  const changes = useTeamChanges(teamId);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirm, setConfirm] = useState<{ set: TeamChangeSet; overwrites: TeamRestoreOverwrite[] } | null>(null);

  // 팀을 바꾸면 앞 팀의 결과 줄과 창은 지운다.
  useEffect(() => {
    setNotice(null);
    setConfirm(null);
  }, [teamId]);

  const titles = useMemo(
    () => new Map(changes.sets.map((set) => [setKey(set), formatTeamChangeTitle(set.items, translate, i18n.language)])),
    [changes.sets, i18n.language, translate],
  );
  const searchQueries = useMemo(
    () => getKeyboardLayoutSearchQueries(search).map((query) => query.toLocaleLowerCase()),
    [search],
  );
  const visibleSets = useMemo(() => {
    if (searchQueries.length === 0) {
      return changes.sets;
    }
    return changes.sets.filter((set) => {
      const haystack = [
        titles.get(setKey(set)),
        set.changedByEmail,
        ...set.items.flatMap((item) => [item.label, item.currentLabel]),
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ')
        .toLocaleLowerCase();
      return searchQueries.some((query) => haystack.includes(query));
    });
  }, [changes.sets, searchQueries, titles]);

  const finish = (outcome: RestoredOutcome) => {
    setConfirm(null);
    setNotice({ kind: 'restored', outcome });
    changes.reload();
  };

  const restore = async (set: TeamChangeSet) => {
    setBusyKey(setKey(set));
    setNotice(null);
    try {
      const outcome = await restoreTeamChange(teamId, refOf(set));
      if (outcome.status === 'needs-confirm') {
        setConfirm({ set, overwrites: outcome.overwrites });
        return;
      }
      finish(outcome);
    } catch (failure) {
      setNotice({ kind: 'error', message: normalizeErrorMessage(failure, translate('teamChanges.result.failed')) });
    } finally {
      setBusyKey(null);
    }
  };

  // 목록 끝까지 내려오면 더 받는다 — Activity 와 같다.
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = changes;
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!hasMore || !sentinel || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, visibleSets.length]);

  // 기록 화면의 목록 틀(PanelSection) 안에 그대로 놓인다 — 카드 사이 간격도 그 틀의 것이다.
  return (
    <>
      {notice?.kind === 'restored' ? <RestoreResult outcome={notice.outcome} translate={translate} /> : null}
      {notice?.kind === 'error' ? (
        <NoticeCard tone="danger" role="alert">
          {notice.message}
        </NoticeCard>
      ) : null}
      {changes.error && changes.sets.length === 0 ? (
        <EmptyState title={translate('teamChanges.loadFailed')} description={changes.error} />
      ) : changes.loading && changes.sets.length === 0 ? (
        <EmptyState title={translate('teamChanges.loading')} />
      ) : visibleSets.length === 0 ? (
        <EmptyState
          title={translate(changes.sets.length === 0 ? 'teamChanges.emptyTitle' : 'logs.empty.title')}
          description={changes.sets.length === 0 ? translate('teamChanges.emptyDescription') : undefined}
        />
      ) : (
        visibleSets.map((set) => (
          <TeamChangeCard
            key={setKey(set)}
            set={set}
            title={titles.get(setKey(set)) ?? ''}
            busy={busyKey !== null}
            onRestore={() => void restore(set)}
            translate={translate}
          />
        ))
      )}
      {hasMore && visibleSets.length > 0 ? (
        <div ref={loadMoreRef} className="py-3 text-center text-[0.85rem] text-[var(--text-soft)]">
          {changes.loading ? translate('teamChanges.loading') : null}
        </div>
      ) : null}
      {confirm ? (
        <RestoreConfirmDialog
          subject={formatTeamChangeSubject(confirm.set.items, translate, i18n.language)}
          overwrites={confirm.overwrites}
          translate={translate}
          onConfirm={async () => {
            const outcome = await restoreTeamChange(teamId, refOf(confirm.set), { overwrite: true });
            if (outcome.status === 'restored') {
              finish(outcome);
            }
          }}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}

interface TeamChangeCardProps {
  set: TeamChangeSet;
  title: string;
  busy: boolean;
  onRestore: () => void;
  translate: Translate;
}

/** 묶음 하나 — 기록 카드와 같은 틀(제목·칩 / 시각 / 누가 / 무엇) · 오른쪽에 복원. */
function TeamChangeCard({ set, title, busy, onRestore, translate }: TeamChangeCardProps) {
  const hasDeleted = set.items.some((item) => item.deleted);
  const hasEdited = set.items.some((item) => !item.deleted);
  const shown = set.items.slice(0, SHOWN_ITEMS);
  const rest = set.items.length - shown.length;
  return (
    <Card data-testid="team-change-card">
      <CardMain>
        <div className="flex flex-wrap items-center gap-[0.7rem]">
          <strong>{title}</strong>
          {hasDeleted ? <Badge tone="starting">{translate('teamChanges.badge.deleted')}</Badge> : null}
          {hasEdited ? <Badge tone="neutral">{translate('teamChanges.badge.edited')}</Badge> : null}
          {set.changedLater && !set.restored ? (
            <Tooltip label={translate('teamChanges.changedLaterHint')}>
              <Badge tone="neutral" className={CHIP_CLASS}>
                {translate('teamChanges.changedLater')}
              </Badge>
            </Tooltip>
          ) : null}
        </div>
        <div className="mt-[0.4rem] flex flex-wrap gap-[0.9rem] text-[0.9rem] text-[var(--text-soft)]">
          <span>{formatTimestamp(set.changedAt)}</span>
        </div>
        <AuthorLine email={set.changedByEmail || set.changedBy} />
        <div className="mt-[0.55rem] flex flex-wrap items-center gap-x-[0.55rem] gap-y-[0.3rem] text-[0.88rem] text-[var(--text)]">
          {shown.map((item, index) => {
            const Icon = TEAM_RECORD_KIND_ICONS[item.kind];
            return (
              <span key={`${item.kind}:${item.recordId}`} className="inline-flex items-center gap-[0.55rem]">
                {index > 0 ? (
                  <span aria-hidden="true" className="text-[var(--text-soft)]">
                    ·
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-[0.3rem]">
                  <Icon className="h-[0.9rem] w-[0.9rem] shrink-0 text-[var(--text-soft)]" aria-hidden />
                  {formatTeamChangeItemLabel(item, translate)}
                  {item.currentLabel ? (
                    <span className="text-[0.8rem] text-[var(--text-soft)]">
                      ({translate('teamChanges.nowLabel', { name: item.currentLabel })})
                    </span>
                  ) : null}
                </span>
              </span>
            );
          })}
          {rest > 0 ? (
            <span className="text-[var(--text-soft)]">{translate('teamChanges.more', { count: rest })}</span>
          ) : null}
        </div>
      </CardMain>
      {set.restored ? (
        <Tooltip label={translate('teamChanges.restoredHint')}>
          <span className="flex shrink-0 items-center gap-1.5 text-[0.85rem] text-[var(--text-soft)]">
            <Check className="h-4 w-4 text-[var(--success-text)]" aria-hidden />
            {translate('teamChanges.restored')}
          </span>
        </Tooltip>
      ) : (
        <Button variant="secondary" size="sm" className="shrink-0" disabled={busy} onClick={onRestore}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          {translate('teamChanges.restore')}
        </Button>
      )}
    </Card>
  );
}

/** 복원 결과 한 줄 — 무엇이 돌아왔고 함께 돌아온 것, 건너뛴 것과 그 까닭. */
function RestoreResult({ outcome, translate }: { outcome: RestoredOutcome; translate: Translate }) {
  const names = (records: ReadonlyArray<{ kind: TeamChangeSet['items'][number]['kind']; label: string | null }>) =>
    joinNames(
      records.map((record) => formatTeamChangeItemLabel(record, translate)),
      translate,
    );
  const skippedFor = (reason: TeamRestoreSkipped['reason']) => outcome.skipped.filter((record) => record.reason === reason);
  const otherVault = skippedFor('other-vault');
  const unreadable = skippedFor('unreadable');
  // 첫 줄은 고른 묶음에서 돌아온 것, 다음 줄은 그것 때문에 함께 돌아온 것이다.
  const count = outcome.restored.length;
  return (
    <>
      {count > 0 || outcome.skipped.length === 0 ? (
        <NoticeCard tone="info" role="status">
          <span className="flex items-start gap-2">
            <Check className="mt-[0.3rem] h-4 w-4 shrink-0 text-[var(--success-text)]" aria-hidden />
            <span className="grid gap-0.5">
              <span>
                {count > 0
                  ? translate('teamChanges.result.restored', { count, names: names(outcome.restored) })
                  : translate('teamChanges.result.nothing')}
              </span>
              {outcome.dependencies.length > 0 ? (
                <span>{translate('teamChanges.result.dependencies', { names: names(outcome.dependencies) })}</span>
              ) : null}
            </span>
          </span>
        </NoticeCard>
      ) : null}
      {outcome.skipped.length > 0 ? (
        <NoticeCard tone="warning" role="status">
          <span className="flex items-start gap-2">
            <TriangleAlert className="mt-[0.3rem] h-4 w-4 shrink-0 text-[var(--warning-text)]" aria-hidden />
            <span className="grid gap-0.5">
              {otherVault.length > 0 ? (
                <span>{translate('teamChanges.result.skippedOtherVault', { names: names(otherVault) })}</span>
              ) : null}
              {unreadable.length > 0 ? (
                <span>{translate('teamChanges.result.skippedUnreadable', { names: names(unreadable) })}</span>
              ) : null}
            </span>
          </span>
        </NoticeCard>
      ) : null}
    </>
  );
}

interface RestoreConfirmDialogProps {
  subject: string;
  overwrites: TeamRestoreOverwrite[];
  translate: Translate;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** 남이 그 뒤에 바꾼 것을 덮을 때만 뜬다 — 누가 언제 바꿨는지 보이고 덮을지 묻는다. */
function RestoreConfirmDialog({ subject, overwrites, translate, onConfirm, onClose }: RestoreConfirmDialogProps) {
  const { busy, error, run } = useDialogAction('teamChanges.result.failed');
  return (
    <TeamDialogFrame
      section="Restore"
      title={translate('teamChanges.confirm.title', { what: subject })}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void run(onConfirm)}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            {translate('teamChanges.confirm.overwrite')}
          </Button>
        </>
      }
    >
      <NoticeCard tone="warning">
        <span className="flex items-start gap-2">
          <TriangleAlert className="mt-[0.3rem] h-4 w-4 shrink-0 text-[var(--warning-text)]" aria-hidden />
          <span className="grid gap-1">
            <span>{translate('teamChanges.confirm.lead')}</span>
            {overwrites.map((overwrite) => {
              const name = formatTeamChangeItemLabel(overwrite, translate);
              return (
                <span key={`${overwrite.kind}:${overwrite.recordId}`} className="text-[var(--text-soft)]">
                  {overwrite.byEmail && overwrite.at
                    ? translate('teamChanges.confirm.changedBy', {
                        name,
                        by: overwrite.byEmail,
                        when: formatTimestamp(overwrite.at),
                      })
                    : translate('teamChanges.confirm.recreated', { name })}
                </span>
              );
            })}
          </span>
        </span>
      </NoticeCard>
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}
