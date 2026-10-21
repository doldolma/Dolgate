import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  TeamActivityItem,
  TeamMemberChange,
  TeamReplayStatus,
  ContainerActionLogMetadata,
  ContainerLifecycleLogMetadata,
  PortForwardLifecycleLogMetadata,
  SessionConnectionKind,
  SessionLifecycleLogMetadata,
  SftpLifecycleLogMetadata,
  PortForwardTransport,
} from '@shared';
import {
  Badge,
  Button,
  Card,
  CardMain,
  EmptyState,
  Input,
  PanelSection,
  SelectField,
  Toolbar,
  Tooltip,
} from '../ui';
import { Play, User } from '../ui/icons';
import { useTranslation } from 'react-i18next';
import { getFormatLocale, t } from '../i18n';
import { resolveLogMessage } from '../lib/activity-log-message';
import { getKeyboardLayoutSearchQueries } from '../lib/keyboard-layout-search';
import { useTeamActivity } from '../controllers/useTeamActivity';

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface LogsPanelProps {
  logs: ActivityLogRecord[];
  onClear: () => Promise<void>;
  /** teamId 를 주면 그 팀의 녹화(서버)를 연다. */
  onOpenReplay: (recordingId: string, teamId?: string | null) => Promise<void>;
  /** 이 기기의 팀. 있으면 Vault 를 골라 팀 기록(서버)을 본다. */
  teams?: ReadonlyArray<{ id: string; name: string }>;
}

const PERSONAL_VAULT = 'personal';

/** 팀 기록 한 줄을 화면의 기록 카드로 — 앱 활동은 로컬 기록과 같은 모양이고, 그 밖의 것은 문구 카드다. */
interface TeamLogRow {
  log: ActivityLogRecord;
  /** 그 줄을 남긴 멤버. 멤버 변화(서버가 남김)는 없다. */
  author: string | null;
  seq: number;
}

function describeMemberChange(change: TeamMemberChange, translate: Translate): string {
  const email = change.email ?? change.userId;
  const by = change.byEmail ?? change.byUserId ?? '';
  if (change.type === 'member_joined') {
    return translate('teamLogs.memberJoined', { email });
  }
  if (change.type === 'member_left') {
    if (change.reason === 'vault_reset') {
      return translate('teamLogs.memberLeftVaultReset', { email });
    }
    if (change.reason === 'account_deleted') {
      return translate('teamLogs.memberLeftAccountDeleted', { email });
    }
    return translate('teamLogs.memberLeft', { email });
  }
  if (change.type === 'member_removed') {
    return translate('teamLogs.memberRemoved', { email, by });
  }
  if (change.type === 'owner_changed') {
    return change.reason === 'successor'
      ? translate('teamLogs.ownerSucceeded', { email })
      : translate('teamLogs.ownerChanged', { email, by });
  }
  return translate('teamLogs.membersChanged');
}

/**
 * 서버의 팀 기록(최신부터)을 화면 줄로 만든다. 수명 줄(접속·SFTP 등)의 시작과 끝은 같은 기록이라 한 줄로
 * 합친다 — 나중 것이 앞의 것을 대신한다. 줄은 그 기록의 시각(수명 줄은 시작 시각)으로 최신부터 놓는다.
 */
function buildTeamRows(items: readonly TeamActivityItem[], translate: Translate): TeamLogRow[] {
  const rows: TeamLogRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.activity) {
      const record = item.activity.record;
      const id = `${item.authorUserId}:${record.id}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      rows.push({ log: { ...record, id }, author: item.authorEmail, seq: item.seq });
      continue;
    }
    const message = item.memberChange
      ? describeMemberChange(item.memberChange, translate)
      : item.unreadable === 'unsupported-version'
        ? translate('teamReplay.unsupported')
        : translate('teamLogs.unreadable');
    rows.push({
      log: {
        id: `team-event:${item.seq}`,
        level: 'info',
        category: 'audit',
        message,
        metadata: null,
        createdAt: item.createdAt,
      } as ActivityLogRecord,
      author: item.memberChange ? null : item.authorEmail,
      seq: item.seq,
    });
  }
  return rows.sort((left, right) => right.log.createdAt.localeCompare(left.log.createdAt) || right.seq - left.seq);
}

type ReplayAction =
  | { kind: 'open'; recordingId: string; teamId: string | null }
  | { kind: 'unavailable'; reason: string };

/** 팀 기록 접속 줄의 Replay — 서버에 그 녹화의 구간이 있으면 연다. 진행 중인 접속도 연다. */
function teamReplayAction(
  metadata: SessionLifecycleLogMetadata,
  teamId: string,
  statuses: ReadonlyMap<string, TeamReplayStatus>,
  checked: ReadonlySet<string>,
  translate: Translate,
): ReplayAction | null {
  const recordingId = typeof metadata.recordingId === 'string' ? metadata.recordingId : null;
  if (!recordingId || metadata.hasReplay === false) {
    return null;
  }
  const status = statuses.get(recordingId);
  if (status?.state === 'deleted') {
    return { kind: 'unavailable', reason: translate('teamLogs.replayDeleted') };
  }
  if (status && status.segmentCount > 0) {
    return { kind: 'open', recordingId, teamId };
  }
  return checked.has(recordingId) ? { kind: 'unavailable', reason: translate('teamLogs.replayPending') } : null;
}

/** 팀 기록 줄을 남긴 멤버. */
function AuthorLine({ email }: { email: string }) {
  return (
    <div className="mt-[0.15rem] flex min-w-0 items-center gap-[0.3rem] text-[0.82rem] text-[var(--text-soft)]">
      <User className="h-[0.8rem] w-[0.8rem] shrink-0" aria-hidden />
      <span className="truncate">{email}</span>
    </div>
  );
}

function isSessionLifecycleMetadata(value: Record<string, unknown> | null): value is SessionLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.sessionId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.title === 'string' &&
      typeof value.connectionKind === 'string' &&
      typeof value.connectedAt === 'string' &&
      typeof value.status === 'string'
  );
}

function isPortForwardLifecycleMetadata(value: Record<string, unknown> | null): value is PortForwardLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.ruleId === 'string' &&
      typeof value.ruleLabel === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.transport === 'string' &&
      typeof value.mode === 'string' &&
      typeof value.bindAddress === 'string' &&
      typeof value.bindPort === 'number' &&
      typeof value.targetSummary === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.status === 'string'
  );
}

function isSftpLifecycleMetadata(value: Record<string, unknown> | null): value is SftpLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.endpointId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.title === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.status === 'string' &&
      typeof value.uploadedCount === 'number' &&
      typeof value.downloadedCount === 'number' &&
      typeof value.mkdirCount === 'number' &&
      typeof value.renameCount === 'number' &&
      typeof value.chmodCount === 'number' &&
      typeof value.chownCount === 'number' &&
      typeof value.deleteCount === 'number' &&
      typeof value.errorCount === 'number'
  );
}

function isContainerLifecycleMetadata(value: Record<string, unknown> | null): value is ContainerLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.lifecycleId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.workspaceKind === 'string' &&
      typeof value.transport === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.status === 'string' &&
      typeof value.refreshCount === 'number' &&
      typeof value.errorCount === 'number'
  );
}

function isContainerActionMetadata(value: Record<string, unknown> | null): value is ContainerActionLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.actionId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.containerId === 'string' &&
      typeof value.action === 'string' &&
      typeof value.status === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.completedAt === 'string' &&
      typeof value.durationMs === 'number'
  );
}

function getConnectionKindLabel(kind: SessionConnectionKind, tmux = false, awsTransport?: string): string {
  const suffix = tmux ? ' (tmux)' : '';
  if (kind === 'local') {
    return 'Local';
  }
  if (kind === 'aws-ssm') {
    return `${awsTransport === 'ssh-over-ssm' ? 'SSH over SSM' : awsTransport === 'ssm-shell' ? 'SSM Shell' : 'AWS SSM'}${suffix}`;
  }
  if (kind === 'aws-ecs-exec') {
    return 'AWS ECS Exec';
  }
  if (kind === 'serial') {
    return 'Serial';
  }
  if (kind === 'warpgate') {
    return 'Warpgate';
  }
  if (kind === 'rdp') {
    return 'RDP';
  }
  // VNC 를 빼면 폴백에 걸려 **원격 화면 세션이 SSH 로 표기된다** — 실제로 그랬다. SSH 터널을
  // 경유하는 VNC 는 그 줄만 보고는 구분할 방법이 없어 더 헷갈린다.
  if (kind === 'vnc') {
    return 'VNC';
  }
  return `SSH${suffix}`;
}

function getConnectionKindTone(kind: SessionConnectionKind): 'running' | 'starting' | 'paused' {
  if (kind === 'local') {
    return 'running';
  }
  if (kind === 'aws-ssm') {
    return 'starting';
  }
  if (kind === 'aws-ecs-exec') {
    return 'starting';
  }
  if (kind === 'serial') {
    return 'running';
  }
  if (kind === 'warpgate') {
    return 'paused';
  }
  return 'running';
}

function getPortForwardTransportLabel(transport: PortForwardTransport): string {
  if (transport === 'aws-ssm') {
    return 'AWS SSM';
  }
  if (transport === 'ecs-task') {
    return 'ECS Task';
  }
  if (transport === 'container') {
    return 'Container';
  }
  return 'SSH';
}

function getPortForwardTransportTone(transport: PortForwardTransport): 'running' | 'starting' | 'paused' {
  if (transport === 'aws-ssm' || transport === 'ecs-task') {
    return 'starting';
  }
  return 'running';
}

function getLifecycleStatusLabel(status: SessionLifecycleLogMetadata['status']): string {
  if (status === 'connected') {
    return 'Connected';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getLifecycleStatusTone(status: SessionLifecycleLogMetadata['status']): 'running' | 'error' | 'stopped' {
  if (status === 'connected') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function getPortForwardStatusLabel(status: PortForwardLifecycleLogMetadata['status']): string {
  if (status === 'running') {
    return 'Running';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getPortForwardStatusTone(status: PortForwardLifecycleLogMetadata['status']): 'running' | 'error' | 'stopped' {
  if (status === 'running') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function getSftpStatusLabel(status: SftpLifecycleLogMetadata['status']): string {
  if (status === 'connecting') {
    return 'Connecting';
  }
  if (status === 'connected') {
    return 'Connected';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getSftpStatusTone(status: SftpLifecycleLogMetadata['status']): 'running' | 'starting' | 'error' | 'stopped' {
  if (status === 'connecting') {
    return 'starting';
  }
  if (status === 'connected') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function getContainerStatusLabel(status: ContainerLifecycleLogMetadata['status']): string {
  if (status === 'connecting') return 'Connecting';
  if (status === 'connected') return 'Connected';
  if (status === 'unsupported') return 'Unsupported';
  if (status === 'error') return 'Error';
  return 'Closed';
}

function getContainerStatusTone(status: ContainerLifecycleLogMetadata['status']): 'running' | 'starting' | 'paused' | 'error' | 'stopped' {
  if (status === 'connecting') return 'starting';
  if (status === 'connected') return 'running';
  if (status === 'unsupported') return 'paused';
  if (status === 'error') return 'error';
  return 'stopped';
}

function getContainerTransportLabel(transport: ContainerLifecycleLogMetadata['transport']): string {
  if (transport === 'aws-ssm') return 'AWS SSM';
  if (transport === 'aws-ecs') return 'AWS ECS';
  if (transport === 'warpgate') return 'Warpgate';
  return 'SSH';
}

function getContainerActionLabel(action: ContainerActionLogMetadata['action']): string {
  if (action === 'start') return 'Start';
  if (action === 'stop') return 'Stop';
  if (action === 'restart') return 'Restart';
  return 'Remove';
}

function formatLogTimestamp(value: string): string {
  return new Date(value).toLocaleString(getFormatLocale());
}

function formatBytes(value?: number | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let nextValue = value;
  let unitIndex = 0;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(nextValue) || nextValue >= 10 || unitIndex === 0
    ? Math.round(nextValue).toString()
    : nextValue.toFixed(1);
  return `${formatted}${units[unitIndex]}`;
}

export function formatSessionLifecycleDuration(durationMs?: number | null): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return t('logs.duration.zero');
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return t('logs.duration.hoursMinutes', { hours, minutes });
  }
  if (minutes > 0) {
    return t('logs.duration.minutesSeconds', { minutes, seconds });
  }
  return t('logs.duration.seconds', { seconds });
}

function getSessionLifecycleSubtitle(metadata: SessionLifecycleLogMetadata): string | null {
  const connectionDetails = metadata.connectionDetails?.trim();
  if (connectionDetails) {
    return connectionDetails;
  }
  const title = metadata.title.trim();
  const hostLabel = metadata.hostLabel.trim();
  if (!title || title === hostLabel) {
    return null;
  }
  return title;
}

function formatSftpCountWithBytes(label: string, count: number, bytes: number): string | null {
  if (count <= 0) {
    return null;
  }
  const formattedBytes = formatBytes(bytes);
  return formattedBytes
    ? t('logs.sftp.countWithBytes', { label, count, bytes: formattedBytes })
    : t('logs.sftp.count', { label, count });
}

function getSftpSummaryItems(metadata: SftpLifecycleLogMetadata): string[] {
  return [
    formatSftpCountWithBytes(t('logs.sftp.download'), metadata.downloadedCount, metadata.downloadedBytes),
    formatSftpCountWithBytes(t('logs.sftp.upload'), metadata.uploadedCount, metadata.uploadedBytes),
    formatSftpCountWithBytes(t('logs.sftp.remoteCopy'), metadata.remoteCopyCount ?? 0, metadata.remoteCopyBytes ?? 0),
    metadata.deleteCount > 0 ? t('logs.sftp.delete', { count: metadata.deleteCount }) : null,
    metadata.mkdirCount > 0 ? t('logs.sftp.mkdir', { count: metadata.mkdirCount }) : null,
    metadata.renameCount > 0 ? t('logs.sftp.rename', { count: metadata.renameCount }) : null,
    metadata.chmodCount > 0 ? t('logs.sftp.chmod', { count: metadata.chmodCount }) : null,
    metadata.chownCount > 0 ? t('logs.sftp.chown', { count: metadata.chownCount }) : null,
    metadata.visitedPathCount > 1 ? t('logs.sftp.visitedPaths', { count: metadata.visitedPathCount }) : null,
    metadata.errorCount > 0 ? t('logs.sftp.errors', { count: metadata.errorCount }) : null,
  ].filter((item): item is string => Boolean(item));
}

/**
 * 검색이 훑을 글자. **화면에 실제로 그려지는 것만** 모은다.
 *
 * 카드 여섯 종류 중 다섯은 번역된 메시지를 쓰지 않고 메타데이터에서 직접 그린다 — 호스트
 * 이름도 컨테이너 이름도 포트도 전부 거기 있다. `log.message` 만 훑으면 화면에 보이는
 * 글자의 대부분을 못 찾는다.
 *
 * 일부러 뺀 것 두 가지:
 * - **시각과 소요 시간.** "2026" 이 거의 모든 줄에 걸려 거르는 데 도움이 안 된다.
 * - **접혀 있는 Metadata JSON.** 맞았는데 왜 맞았는지 화면에 안 보이면 더 헷갈린다.
 */
function getLogSearchText(log: ActivityLogRecord, translate: Translate): string {
  const parts: Array<string | null | undefined> = [];
  const metadata = log.metadata;

  if (log.kind === 'container-lifecycle' && isContainerLifecycleMetadata(metadata)) {
    parts.push(
      metadata.hostLabel,
      metadata.workspaceKind === 'ecs-cluster' ? 'ECS cluster' : 'Host containers',
      getContainerTransportLabel(metadata.transport),
      metadata.runtime,
      getContainerStatusLabel(metadata.status),
      metadata.lastError,
      metadata.endReason,
    );
  } else if (log.kind === 'container-action' && isContainerActionMetadata(metadata)) {
    parts.push(
      metadata.containerName,
      metadata.containerId,
      metadata.hostLabel,
      metadata.runtime,
      getContainerActionLabel(metadata.action),
      metadata.status === 'success' ? 'Success' : 'Error',
      metadata.errorMessage,
    );
  } else if (log.kind === 'session-lifecycle' && isSessionLifecycleMetadata(metadata)) {
    parts.push(
      metadata.hostLabel,
      getSessionLifecycleSubtitle(metadata),
      getConnectionKindLabel(metadata.connectionKind, metadata.tmux, metadata.awsTransport),
      getLifecycleStatusLabel(metadata.status),
      metadata.disconnectReason,
    );
  } else if (log.kind === 'sftp-lifecycle' && isSftpLifecycleMetadata(metadata)) {
    parts.push(
      metadata.hostLabel,
      metadata.title,
      'SFTP',
      getSftpStatusLabel(metadata.status),
      metadata.lastPath,
      metadata.endReason,
    );
  } else if (log.kind === 'port-forward-lifecycle' && isPortForwardLifecycleMetadata(metadata)) {
    parts.push(
      metadata.ruleLabel,
      metadata.hostLabel,
      `${metadata.bindAddress}:${metadata.bindPort} -> ${metadata.targetSummary}`,
      getPortForwardTransportLabel(metadata.transport),
      getPortForwardStatusLabel(metadata.status),
      metadata.endReason,
    );
  } else {
    // 그 밖의 기록은 일반 카드로 그려진다 — 거기 보이는 것은 문구·레벨·카테고리뿐이다.
    parts.push(resolveLogMessage(log, translate), log.level, log.category);
  }

  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLocaleLowerCase();
}

export function LogsPanel({ logs, onClear, onOpenReplay, teams = [] }: LogsPanelProps) {
  const { t: translate } = useTranslation();
  const [category, setCategory] = useState<'all' | ActivityLogCategory>('all');
  const [level, setLevel] = useState<'all' | ActivityLogLevel>('all');
  const [search, setSearch] = useState('');
  const [vault, setVault] = useState<string>(PERSONAL_VAULT);
  // 고른 팀이 이 기기에서 없어지면(나감·지움) 개인 기록으로 돌아간다.
  const teamId = vault !== PERSONAL_VAULT && teams.some((team) => team.id === vault) ? vault : null;
  const teamActivity = useTeamActivity(teamId);
  const teamRows = useMemo(
    () => (teamId ? buildTeamRows(teamActivity.items, translate) : null),
    [teamActivity.items, teamId, translate]
  );
  const shownLogs = useMemo(() => teamRows?.map((row) => row.log) ?? logs, [logs, teamRows]);
  const authorById = useMemo(
    () => new Map((teamRows ?? []).map((row) => [row.log.id, row.author])),
    [teamRows]
  );

  // 한 번만 뽑아 둔다. 최대 1만 건이라 글자마다 다시 만들면 입력이 끊긴다.
  // translate 가 바뀌는 때는 언어가 바뀌는 때이고, 그때는 다시 만드는 것이 맞다.
  const searchTextById = useMemo(
    () =>
      new Map(
        shownLogs.map((log) => {
          const author = authorById.get(log.id);
          const text = getLogSearchText(log, translate);
          return [log.id, author ? `${text} ${author.toLocaleLowerCase()}` : text];
        })
      ),
    [authorById, shownLogs, translate]
  );
  // 호스트 검색과 같은 규칙: `tjqj` 로도 `서버` 가 걸린다. 같은 앱에서 검색이 갈리면 안 된다.
  const searchQueries = useMemo(
    () => getKeyboardLayoutSearchQueries(search).map((query) => query.toLocaleLowerCase()),
    [search]
  );

  const visibleLogs = useMemo(
    () =>
      shownLogs.filter((log) => {
        if (category !== 'all' && log.category !== category) {
          return false;
        }
        if (level !== 'all' && log.level !== level) {
          return false;
        }
        if (searchQueries.length > 0) {
          const haystack = searchTextById.get(log.id) ?? '';
          if (!searchQueries.some((query) => haystack.includes(query))) {
            return false;
          }
        }
        return true;
      }),
    [category, level, searchQueries, searchTextById, shownLogs]
  );

  // 팀 기록은 목록 끝까지 내려오면 더 받는다(더 보기 단추는 두지 않는다).
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = teamActivity;
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!teamId || !hasMore || !sentinel || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, teamId, visibleLogs.length]);

  return (
    <div className="flex flex-col gap-[1.1rem]">
      {/* 상단 브레드크럼(← Hosts · Logs)에 이미 제목이 있어 Diagnostics/Logs 헤더는 생략.
          Clear logs 버튼은 아래 필터 행 오른쪽으로 옮긴다. */}
      <Toolbar>
        {teams.length > 0 ? (
          <label className="flex w-full max-w-[220px] flex-col gap-[0.4rem]">
            <span className="text-[0.9rem] text-[var(--text-soft)]">Vault</span>
            <SelectField value={teamId ?? PERSONAL_VAULT} onChange={(event) => setVault(event.target.value)}>
              <option value={PERSONAL_VAULT}>Personal</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </SelectField>
          </label>
        ) : null}

        <label className="flex w-full max-w-[220px] flex-col gap-[0.4rem]">
          <span className="text-[0.9rem] text-[var(--text-soft)]">Category</span>
          <SelectField
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as 'all' | ActivityLogCategory)
            }
          >
            <option value="all">All</option>
            <option value="session">Session</option>
            <option value="audit">Audit</option>
          </SelectField>
        </label>

        <label className="flex w-full max-w-[220px] flex-col gap-[0.4rem]">
          <span className="text-[0.9rem] text-[var(--text-soft)]">Level</span>
          <SelectField
            value={level}
            onChange={(event) =>
              setLevel(event.target.value as 'all' | ActivityLogLevel)
            }
          >
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </SelectField>
        </label>

        <label className="flex w-full max-w-[320px] flex-col gap-[0.4rem]">
          <span className="text-[0.9rem] text-[var(--text-soft)]">Search</span>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Host, container, port, error"
          />
        </label>

        {/* 팀 기록은 서버의 것이라 이 기기에서 지우지 않는다. */}
        {teamId ? null : (
          <Button variant="secondary" className="ml-auto" onClick={() => void onClear()}>
            Clear logs
          </Button>
        )}
      </Toolbar>

      <PanelSection>
        {teamId && teamActivity.error && visibleLogs.length === 0 ? (
          <EmptyState title={translate('teamLogs.loadFailed')} description={teamActivity.error} />
        ) : teamId && teamActivity.loading && visibleLogs.length === 0 ? (
          <EmptyState title={translate('teamLogs.loading')} />
        ) : visibleLogs.length === 0 ? (
          <EmptyState
            title={translate('logs.empty.title')}
            description={translate(teamId ? 'teamLogs.emptyDescription' : 'logs.empty.description')}
          />
        ) : (
          visibleLogs.map((log) => {
            const sessionLifecycleMetadata =
              log.kind === 'session-lifecycle' && isSessionLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const portForwardLifecycleMetadata =
              log.kind === 'port-forward-lifecycle' && isPortForwardLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const sftpLifecycleMetadata =
              log.kind === 'sftp-lifecycle' && isSftpLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const containerLifecycleMetadata =
              log.kind === 'container-lifecycle' && isContainerLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const containerActionMetadata =
              log.kind === 'container-action' && isContainerActionMetadata(log.metadata)
                ? log.metadata
                : null;
            // 이 기기의 녹화: 진행 중(connected) 세션은 녹화가 아직 finalize되지 않아 재생 불가 →
            // 종료된 세션(closed/error)만 Replay 버튼을 노출한다. 팀 녹화는 서버에 구간이 있으면 진행 중에도 연다.
            const replayAction: ReplayAction | null = !sessionLifecycleMetadata
              ? null
              : teamId
                ? teamReplayAction(
                    sessionLifecycleMetadata,
                    teamId,
                    teamActivity.replayStatuses,
                    teamActivity.checkedRecordingIds,
                    translate,
                  )
                : (sessionLifecycleMetadata.status === 'closed' ||
                      sessionLifecycleMetadata.status === 'error') &&
                    sessionLifecycleMetadata.hasReplay === true &&
                    typeof sessionLifecycleMetadata.recordingId === 'string'
                  ? { kind: 'open', recordingId: sessionLifecycleMetadata.recordingId, teamId: null }
                  : null;
            const author = authorById.get(log.id) ?? null;

            return containerLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-container-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{containerLifecycleMetadata.hostLabel}</strong>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">
                        {containerLifecycleMetadata.workspaceKind === 'ecs-cluster' ? 'ECS cluster' : 'Host containers'}
                      </div>
                      {author ? <AuthorLine email={author} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone={containerLifecycleMetadata.transport === 'aws-ecs' ? 'starting' : 'running'}>
                        {getContainerTransportLabel(containerLifecycleMetadata.transport)}
                      </Badge>
                      {containerLifecycleMetadata.runtime ? (
                        <Badge tone="paused">{containerLifecycleMetadata.runtime.toUpperCase()}</Badge>
                      ) : null}
                      <Badge tone={getContainerStatusTone(containerLifecycleMetadata.status)}>
                        {getContainerStatusLabel(containerLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.browseStarted')}</span>
                      <strong>{formatLogTimestamp(containerLifecycleMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.browseEnded')}</span>
                      <strong>{containerLifecycleMetadata.endedAt ? formatLogTimestamp(containerLifecycleMetadata.endedAt) : translate('logs.field.connecting')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.heldFor')}</span>
                      <strong>{formatSessionLifecycleDuration(containerLifecycleMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  <div className="mt-[0.7rem] flex flex-wrap gap-[0.4rem]">
                    {typeof containerLifecycleMetadata.resourceCount === 'number' ? (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                        {translate('logs.field.resourceCount', {
                          kind: translate(
                            containerLifecycleMetadata.workspaceKind === 'ecs-cluster'
                              ? 'logs.field.service'
                              : 'logs.field.container',
                          ),
                          count: containerLifecycleMetadata.resourceCount,
                        })}
                      </span>
                    ) : null}
                    {containerLifecycleMetadata.refreshCount > 0 ? (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                        {translate('logs.field.refreshCount', { count: containerLifecycleMetadata.refreshCount })}
                      </span>
                    ) : null}
                    {containerLifecycleMetadata.errorCount > 0 ? (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                        {translate('logs.field.errorCount', { count: containerLifecycleMetadata.errorCount })}
                      </span>
                    ) : null}
                  </div>
                  {containerLifecycleMetadata.lastError || containerLifecycleMetadata.endReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">
                      {containerLifecycleMetadata.lastError ?? containerLifecycleMetadata.endReason}
                    </div>
                  ) : null}
                </CardMain>
              </Card>
            ) : containerActionMetadata ? (
              <Card key={log.id} data-testid="logs-container-action-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{containerActionMetadata.containerName || containerActionMetadata.containerId}</strong>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">{containerActionMetadata.hostLabel}</div>
                      {containerActionMetadata.containerName ? (
                        <div className="text-[0.82rem] text-[var(--text-soft)]">{containerActionMetadata.containerId}</div>
                      ) : null}
                      {author ? <AuthorLine email={author} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      {containerActionMetadata.runtime ? (
                        <Badge tone="paused">{containerActionMetadata.runtime.toUpperCase()}</Badge>
                      ) : null}
                      <Badge tone="starting">{getContainerActionLabel(containerActionMetadata.action)}</Badge>
                      <Badge tone={containerActionMetadata.status === 'success' ? 'running' : 'error'}>
                        {containerActionMetadata.status === 'success' ? 'Success' : 'Error'}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-2">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.ranAt')}</span>
                      <strong>{formatLogTimestamp(containerActionMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.runDuration')}</span>
                      <strong>{formatSessionLifecycleDuration(containerActionMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {containerActionMetadata.errorMessage ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">
                      {containerActionMetadata.errorMessage}
                    </div>
                  ) : null}
                </CardMain>
              </Card>
            ) : sessionLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{sessionLifecycleMetadata.hostLabel}</strong>
                      {getSessionLifecycleSubtitle(sessionLifecycleMetadata) ? (
                        <div className="text-[0.9rem] text-[var(--text-soft)]">{getSessionLifecycleSubtitle(sessionLifecycleMetadata)}</div>
                      ) : null}
                      {author ? <AuthorLine email={author} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone={getConnectionKindTone(sessionLifecycleMetadata.connectionKind)}>
                        {getConnectionKindLabel(
                          sessionLifecycleMetadata.connectionKind,
                          sessionLifecycleMetadata.tmux,
                          sessionLifecycleMetadata.awsTransport,
                        )}
                      </Badge>
                      <Badge tone={getLifecycleStatusTone(sessionLifecycleMetadata.status)}>
                        {getLifecycleStatusLabel(sessionLifecycleMetadata.status)}
                      </Badge>
                    </div>
                    {/* 유일하게 누를 수 있는 요소라 배지 사이에 끼워 두지 않는다 — 오른쪽 끝
                        액션 자리로 빼고 아이콘을 붙여야 배지와 구분된다(다크 테마에서 특히). */}
                    {replayAction?.kind === 'open' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto"
                        onClick={() => void onOpenReplay(replayAction.recordingId, replayAction.teamId)}
                      >
                        <Play className="h-[0.8rem] w-[0.8rem]" aria-hidden />
                        Replay
                      </Button>
                    ) : replayAction?.kind === 'unavailable' ? (
                      // 왜 못 여는지 말해 준다. 비활성 버튼만 두면 고장으로 읽는다.
                      <Tooltip className="ml-auto cursor-not-allowed" label={replayAction.reason}>
                        <Button variant="secondary" size="sm" disabled aria-label={`Replay — ${replayAction.reason}`}>
                          <Play className="h-[0.8rem] w-[0.8rem]" aria-hidden />
                          Replay
                        </Button>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectStarted')}</span>
                      <strong>{formatLogTimestamp(sessionLifecycleMetadata.connectedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectEnded')}</span>
                      <strong>{sessionLifecycleMetadata.disconnectedAt ? formatLogTimestamp(sessionLifecycleMetadata.disconnectedAt) : translate('logs.field.connecting')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectDuration')}</span>
                      <strong>{formatSessionLifecycleDuration(sessionLifecycleMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {sessionLifecycleMetadata.disconnectReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">{sessionLifecycleMetadata.disconnectReason}</div>
                  ) : null}
                </CardMain>
              </Card>
            ) : sftpLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-sftp-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{sftpLifecycleMetadata.hostLabel}</strong>
                      {sftpLifecycleMetadata.title.trim() && sftpLifecycleMetadata.title.trim() !== sftpLifecycleMetadata.hostLabel.trim() ? (
                        <div className="text-[0.9rem] text-[var(--text-soft)]">{sftpLifecycleMetadata.title}</div>
                      ) : null}
                      {author ? <AuthorLine email={author} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone="running">SFTP</Badge>
                      <Badge tone={getSftpStatusTone(sftpLifecycleMetadata.status)}>
                        {getSftpStatusLabel(sftpLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectStarted')}</span>
                      <strong>{formatLogTimestamp(sftpLifecycleMetadata.connectedAt ?? sftpLifecycleMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectEnded')}</span>
                      <strong>{sftpLifecycleMetadata.endedAt ? formatLogTimestamp(sftpLifecycleMetadata.endedAt) : translate('logs.field.connecting')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.connectDuration')}</span>
                      <strong>{formatSessionLifecycleDuration(sftpLifecycleMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {getSftpSummaryItems(sftpLifecycleMetadata).length > 0 ? (
                    <div className="mt-[0.7rem] flex flex-wrap gap-[0.4rem]">
                      {getSftpSummaryItems(sftpLifecycleMetadata).map((item) => (
                        <span key={item} className="rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.7rem] py-[0.4rem] text-[0.9rem] text-[var(--text-soft)]">
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {sftpLifecycleMetadata.lastPath ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">
                      {translate('logs.sftp.lastPath', { path: sftpLifecycleMetadata.lastPath })}
                    </div>
                  ) : null}
                  {sftpLifecycleMetadata.endReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">{sftpLifecycleMetadata.endReason}</div>
                  ) : null}
                  <details className="mt-[0.7rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                    <summary>Metadata</summary>
                    <pre className="mt-[0.55rem] overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-3 text-[0.82rem] leading-[1.55]">{JSON.stringify(log.metadata, null, 2)}</pre>
                  </details>
                </CardMain>
              </Card>
            ) : portForwardLifecycleMetadata ? (
              <Card key={log.id} data-testid="logs-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <div>
                      <strong>{portForwardLifecycleMetadata.ruleLabel}</strong>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">{portForwardLifecycleMetadata.hostLabel}</div>
                      <div className="text-[0.9rem] text-[var(--text-soft)]">
                        {`${portForwardLifecycleMetadata.bindAddress}:${portForwardLifecycleMetadata.bindPort} -> ${portForwardLifecycleMetadata.targetSummary}`}
                      </div>
                      {author ? <AuthorLine email={author} /> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-[0.55rem]">
                      <Badge tone={getPortForwardTransportTone(portForwardLifecycleMetadata.transport)}>
                        {getPortForwardTransportLabel(portForwardLifecycleMetadata.transport)}
                      </Badge>
                      <Badge tone={getPortForwardStatusTone(portForwardLifecycleMetadata.status)}>
                        {getPortForwardStatusLabel(portForwardLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-[0.9rem] grid gap-[0.7rem] md:grid-cols-3">
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.forwardStarted')}</span>
                      <strong>{formatLogTimestamp(portForwardLifecycleMetadata.startedAt)}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.forwardEnded')}</span>
                      <strong>{portForwardLifecycleMetadata.stoppedAt ? formatLogTimestamp(portForwardLifecycleMetadata.stoppedAt) : translate('logs.field.forwarding')}</strong>
                    </div>
                    <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <span>{translate('logs.field.heldFor')}</span>
                      <strong>{formatSessionLifecycleDuration(portForwardLifecycleMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {portForwardLifecycleMetadata.endReason ? (
                    <div className="mt-[0.7rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.7rem] text-[0.9rem] text-[var(--text-soft)]">{portForwardLifecycleMetadata.endReason}</div>
                  ) : null}
                </CardMain>
              </Card>
            ) : (
              <Card key={log.id}>
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <strong>{resolveLogMessage(log, translate)}</strong>
                    <Badge tone={log.level === 'error' ? 'error' : log.level === 'warn' ? 'starting' : 'running'}>
                      {log.level.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="mt-[0.4rem] flex flex-wrap gap-[0.9rem] text-[0.9rem] text-[var(--text-soft)]">
                    <span>{log.category}</span>
                    <span>{formatLogTimestamp(log.createdAt)}</span>
                  </div>
                  {author ? <AuthorLine email={author} /> : null}
                  {log.metadata ? (
                    <details className="mt-[0.7rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
                      <summary>Metadata</summary>
                      <pre className="mt-[0.55rem] overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-3 text-[0.82rem] leading-[1.55]">{JSON.stringify(log.metadata, null, 2)}</pre>
                    </details>
                  ) : null}
                </CardMain>
              </Card>
            );
          })
        )}
        {teamId && teamActivity.hasMore && visibleLogs.length > 0 ? (
          <div ref={loadMoreRef} className="py-3 text-center text-[0.85rem] text-[var(--text-soft)]">
            {teamActivity.loading ? translate('teamLogs.loading') : null}
          </div>
        ) : null}
      </PanelSection>
    </div>
  );
}
